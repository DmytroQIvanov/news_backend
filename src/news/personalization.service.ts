import { Injectable, Logger, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES } from '../ingest/ingest.dto';

/**
 * Server-side interest model for the personal feed.
 *
 * Each anonymous device (random UUID, no personal data) has decayed weights per category and per source.
 * Reading behaviour updates the weights; the feed is then ranked as
 *   score = 0.40·importance + 0.40·interest + 0.20·freshness
 * followed by a diversity pass (no long runs of one topic/source) and ~12% exploration slots,
 * so the reader sees mostly what they like but never misses the day's main stories.
 */

export const READER_EVENT_TYPES = ['impression', 'open', 'read', 'save', 'share', 'like', 'dislike', 'hide', 'listen'] as const;
export type ReaderEventType = (typeof READER_EVENT_TYPES)[number];

export interface ReaderEvent {
  itemId: string;
  type: ReaderEventType;
  category?: string | null;
  sourceSlug?: string | null;
  clusterId?: string | null;
  dwellMs?: number | null;
  at?: string | null;
}

export interface ReaderProfile {
  deviceId: string;
  lang: string;
  topicWeights: Record<string, number>;
  sourceWeights: Record<string, number>;
  declaredTopics: string[];
  eventsCount: number;
  updatedAt: number;
  hiddenItemIds?: Set<string>;
}

export interface RankableItem {
  id: string;
  category?: string | null;
  source_slug?: string | null;
  published_at?: Date | string | null;
  important?: boolean;
  source_count?: number;
  cluster_sources?: unknown[] | null;
  credibility_tier?: string | null;
  hydrogen_deep_analysis?: boolean;
  [key: string]: unknown;
}

const HALF_LIFE_DAYS = 21;
const WEIGHT_MIN = -10;
const WEIGHT_MAX = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function eventDelta(event: Pick<ReaderEvent, 'type' | 'dwellMs'>): number {
  switch (event.type) {
    case 'impression':
      return -0.05;
    case 'open':
      return 1;
    case 'read': {
      const seconds = Math.max(0, Number(event.dwellMs || 0) / 1000);
      return 1 + Math.min(2, seconds / 30);
    }
    case 'listen':
      return 2;
    case 'save':
    case 'share':
      return 3;
    case 'like':
      return 2;
    case 'dislike':
      return -3;
    case 'hide':
      return -4;
    default:
      return 0;
  }
}

function clamp(n: number): number {
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, n));
}

export function decayWeights(weights: Record<string, number>, elapsedMs: number): Record<string, number> {
  if (elapsedMs <= 0) return { ...weights };
  const factor = Math.pow(0.5, elapsedMs / (HALF_LIFE_DAYS * 86_400_000));
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) {
    const next = v * factor;
    if (Math.abs(next) >= 0.01) out[k] = Math.round(next * 1000) / 1000;
  }
  return out;
}

export function applyEvents(profile: ReaderProfile, events: ReaderEvent[], now = Date.now()): ReaderProfile {
  const topicWeights = decayWeights(profile.topicWeights, now - profile.updatedAt);
  const sourceWeights = decayWeights(profile.sourceWeights, now - profile.updatedAt);
  for (const ev of events) {
    const delta = eventDelta(ev);
    if (!delta) continue;
    if (ev.category) topicWeights[ev.category] = clamp((topicWeights[ev.category] || 0) + delta);
    if (ev.sourceSlug) sourceWeights[ev.sourceSlug] = clamp((sourceWeights[ev.sourceSlug] || 0) + delta * 0.6);
  }
  return { ...profile, topicWeights, sourceWeights, eventsCount: profile.eventsCount + events.length, updatedAt: now };
}

function publishedMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/** 0..1: how big is the story, independent of the reader. */
export function importanceScore(item: RankableItem): number {
  const sources = Math.max(1, Number(item.source_count || (Array.isArray(item.cluster_sources) ? item.cluster_sources.length : 1)) || 1);
  let score = Math.min(1, Math.log2(1 + sources) / Math.log2(7)) * 0.45;
  if (item.important) score += 0.35;
  if (item.credibility_tier === 'official' || item.credibility_tier === 'verified') score += 0.1;
  if (item.hydrogen_deep_analysis) score += 0.1;
  return Math.min(1, score);
}

/** 0..1: how much this reader is likely to care. 0.5 = neutral / unknown. */
export function interestScore(item: RankableItem, profile: ReaderProfile | null, declaredCategories: Set<string>): number {
  const category = String(item.category || 'other');
  let raw = 0;
  if (declaredCategories.has(category)) raw += 3;
  if (profile) {
    raw += profile.topicWeights[category] || 0;
    raw += 0.5 * (profile.sourceWeights[String(item.source_slug || '')] || 0);
  }
  // Smooth squashing to 0..1 around neutral 0.5
  return 0.5 + 0.5 * Math.tanh(raw / 6);
}

export function freshnessScore(item: RankableItem, now = Date.now()): number {
  const ts = publishedMs(item.published_at);
  if (!ts) return 0.2;
  const ageHours = Math.max(0, (now - ts) / 3_600_000);
  return Math.exp(-ageHours / 18);
}

export function rankForReader<T extends RankableItem>(
  items: T[],
  profile: ReaderProfile | null,
  declaredCategories: Set<string>,
  options?: { now?: number; explorationEvery?: number },
): Array<T & { personal_score: number; feed_reason: 'top' | 'interest' | 'explore' | 'fresh' }> {
  const now = options?.now ?? Date.now();
  const hidden = profile?.hiddenItemIds ?? new Set<string>();
  const scored = items
    .filter((item) => !hidden.has(String(item.id)))
    .map((item) => {
      const imp = importanceScore(item);
      const int = interestScore(item, profile, declaredCategories);
      const fresh = freshnessScore(item, now);
      const score = 0.4 * imp + 0.4 * int + 0.2 * fresh;
      const reason: 'top' | 'interest' | 'explore' | 'fresh' = imp >= 0.6 ? 'top' : int >= 0.62 ? 'interest' : fresh >= 0.7 ? 'fresh' : 'explore';
      return { item, score, int };
    })
    .sort((a, b) => b.score - a.score);

  // Exploration pool: decent stories from topics the reader has not shown interest in yet.
  const explorationEvery = options?.explorationEvery ?? 8;
  const out: Array<T & { personal_score: number; feed_reason: 'top' | 'interest' | 'explore' | 'fresh' }> = [];
  const used = new Set<number>();
  const recentCategories: string[] = [];
  let lastSource = '';

  while (used.size < scored.length) {
    const slot = out.length + 1;
    const wantExplore = explorationEvery > 0 && slot % explorationEvery === 0;
    let bestIdx = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < scored.length; i += 1) {
      if (used.has(i)) continue;
      const entry = scored[i];
      const cat = String(entry.item.category || 'other');
      let value = entry.score;
      const sameCatRun = recentCategories.slice(-2).filter((c) => c === cat).length;
      if (sameCatRun >= 2) value *= 0.7;
      else if (sameCatRun === 1) value *= 0.92;
      if (String(entry.item.source_slug || '') === lastSource) value *= 0.85;
      if (wantExplore) value = entry.int <= 0.52 ? value + 0.25 : value - 0.25;
      if (value > bestValue) {
        bestValue = value;
        bestIdx = i;
      }
      // Items are pre-sorted; once far below the best, stop scanning to keep this O(n·k).
      if (i - bestIdx > 40 && bestIdx >= 0) break;
    }
    if (bestIdx < 0) break;
    used.add(bestIdx);
    const chosen = scored[bestIdx];
    const cat = String(chosen.item.category || 'other');
    recentCategories.push(cat);
    lastSource = String(chosen.item.source_slug || '');
    const baseReason: 'top' | 'interest' | 'explore' | 'fresh' =
      importanceScore(chosen.item) >= 0.6 ? 'top' : chosen.int >= 0.62 ? 'interest' : wantExplore ? 'explore' : 'fresh';
    out.push({ ...chosen.item, personal_score: Math.round(chosen.score * 1000) / 1000, feed_reason: baseReason });
  }
  return out;
}

/** The day's main stories: the same for every reader so nobody misses them. */
export function pickTopStories<T extends RankableItem>(items: T[], limit = 7, now = Date.now()): T[] {
  const seenClusters = new Set<string>();
  return items
    .filter((item) => now - publishedMs(item.published_at) <= 30 * 3_600_000)
    .map((item) => ({ item, score: importanceScore(item) * 0.8 + freshnessScore(item, now) * 0.2 }))
    .filter(({ item, score }) => score >= 0.35 || item.important)
    .sort((a, b) => b.score - a.score)
    .filter(({ item }) => {
      const key = String(item.cluster_id || item.id);
      if (seenClusters.has(key)) return false;
      seenClusters.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ item }) => item);
}

@Injectable()
export class PersonalizationService {
  private readonly logger = new Logger(PersonalizationService.name);
  private readonly cache = new Map<string, { at: number; profile: ReaderProfile }>();

  constructor(@Optional() private readonly db?: DatabaseService) {}

  private emptyProfile(deviceId: string, lang = 'uk'): ReaderProfile {
    return { deviceId, lang, topicWeights: {}, sourceWeights: {}, declaredTopics: [], eventsCount: 0, updatedAt: Date.now() };
  }

  async getProfile(deviceId: string): Promise<ReaderProfile | null> {
    if (!isValidDeviceId(deviceId) || !this.db) return null;
    const hit = this.cache.get(deviceId);
    if (hit && Date.now() - hit.at < 60_000) return hit.profile;
    try {
      const { rows } = await this.db.query<{
        lang: string; topic_weights: Record<string, number>; source_weights: Record<string, number>;
        declared_topics: string[]; events_count: number; updated_at: Date;
      }>(`SELECT lang, topic_weights, source_weights, declared_topics, events_count, updated_at FROM reader_profiles WHERE device_id = $1::uuid`, [deviceId]);
      const row = rows[0];
      if (!row) return null;
      const hiddenRes = await this.db.query<{ item_id: string }>(
        `SELECT DISTINCT item_id FROM reader_events
         WHERE device_id = $1::uuid AND event_type IN ('hide','dislike') AND created_at >= now() - interval '30 days'
         LIMIT 500`,
        [deviceId],
      );
      const profile: ReaderProfile = {
        deviceId,
        lang: row.lang,
        topicWeights: row.topic_weights || {},
        sourceWeights: row.source_weights || {},
        declaredTopics: Array.isArray(row.declared_topics) ? row.declared_topics : [],
        eventsCount: row.events_count,
        updatedAt: new Date(row.updated_at).getTime(),
        hiddenItemIds: new Set(hiddenRes.rows.map((r) => r.item_id)),
      };
      this.cache.set(deviceId, { at: Date.now(), profile });
      return profile;
    } catch (err) {
      this.logger.debug(`Reader profile unavailable: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  async saveDeclared(deviceId: string, lang: string, topics: string[]): Promise<void> {
    if (!isValidDeviceId(deviceId) || !this.db) return;
    await this.db.query(
      `INSERT INTO reader_profiles (device_id, lang, declared_topics) VALUES ($1::uuid, $2, $3::jsonb)
       ON CONFLICT (device_id) DO UPDATE SET lang = EXCLUDED.lang, declared_topics = EXCLUDED.declared_topics, updated_at = reader_profiles.updated_at`,
      [deviceId, lang, JSON.stringify(topics.slice(0, 40))],
    );
    this.cache.delete(deviceId);
  }

  async recordEvents(deviceId: string, lang: string, events: ReaderEvent[]): Promise<ReaderProfile | null> {
    if (!isValidDeviceId(deviceId) || !this.db || events.length === 0) return null;
    const current = (await this.getProfile(deviceId)) ?? this.emptyProfile(deviceId, lang);
    const next = applyEvents(current, events);
    const categories = new Set<string>(CATEGORIES);

    await this.db.query(
      `INSERT INTO reader_profiles (device_id, lang, topic_weights, source_weights, events_count, updated_at)
       VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5, now())
       ON CONFLICT (device_id) DO UPDATE SET
         lang = EXCLUDED.lang, topic_weights = EXCLUDED.topic_weights, source_weights = EXCLUDED.source_weights,
         events_count = EXCLUDED.events_count, updated_at = now()`,
      [deviceId, lang, JSON.stringify(next.topicWeights), JSON.stringify(next.sourceWeights), next.eventsCount],
    );

    // Store only signal events (impressions are aggregated into weights and not kept as rows).
    const kept = events.filter((e) => e.type !== 'impression').slice(0, 100);
    if (kept.length) {
      const values: unknown[] = [];
      const placeholders = kept.map((e, i) => {
        const b = i * 7;
        values.push(
          deviceId,
          String(e.itemId).slice(0, 120),
          e.clusterId ? String(e.clusterId).slice(0, 120) : null,
          e.type,
          e.category && categories.has(e.category) ? e.category : null,
          e.sourceSlug ? String(e.sourceSlug).slice(0, 80) : null,
          e.dwellMs != null ? Math.max(0, Math.min(3_600_000, Math.round(Number(e.dwellMs) || 0))) : null,
        );
        return `($${b + 1}::uuid,$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
      });
      await this.db.query(
        `INSERT INTO reader_events (device_id, item_id, cluster_id, event_type, category, source_slug, dwell_ms) VALUES ${placeholders.join(',')}`,
        values,
      );
    }
    this.cache.delete(deviceId);
    return next;
  }

  /** Short, human readable explanation of the reader model (shown in the app's "Why am I seeing this" sheet). */
  describe(profile: ReaderProfile | null): { topCategories: Array<{ category: string; weight: number }>; eventsCount: number } {
    if (!profile) return { topCategories: [], eventsCount: 0 };
    const decayed = decayWeights(profile.topicWeights, Date.now() - profile.updatedAt);
    return {
      topCategories: Object.entries(decayed)
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([category, weight]) => ({ category, weight: Math.round(weight * 10) / 10 })),
      eventsCount: profile.eventsCount,
    };
  }
}
