import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DEFAULT_GEMINI_MODEL, postGeminiGenerateContent } from '../common/gemini-client';
import { getHonestUserAgent } from '../common/source-compliance';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES, NewsCategory } from '../ingest/ingest.dto';
import { fetchAndParseFeedUrl } from '../news/company-feeds.service';
import { buildYoutubeRssUrl, YOUTUBE_RSS_CHANNELS, YoutubeChannelDefinition } from './youtube-channels';

/**
 * Grows the YouTube radar beyond the hand-picked seed list.
 *
 * Gemini (with Google Search grounding when available) proposes official channels of experts,
 * companies, institutions and quality media for under-covered topics and for experts we already
 * track. Nothing Gemini says is trusted directly: every handle is resolved to a real channel ID by
 * us, the channel title must match the proposed name, the RSS feed must have recent videos and,
 * when a YouTube API key is set, the subscriber count must pass a threshold. Channels that fail
 * their RSS feed repeatedly are disabled automatically.
 */

export type ChannelKind = 'expert' | 'company' | 'media' | 'educator' | 'institution';

export interface ChannelCandidate {
  name: string;
  handle?: string;
  channelId?: string;
  kind: ChannelKind;
  category: NewsCategory;
  language: 'en' | 'uk';
  topics: string[];
  rationaleUk?: string;
  discoveredBy: 'gemini' | 'youtube_search';
}

export interface ResolvedChannel {
  channelId: string;
  title: string;
  subscriberCount: number | null;
}

const KINDS: ChannelKind[] = ['expert', 'company', 'media', 'educator', 'institution'];
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const MAX_ADDED_PER_RUN = 12;
const MAX_TOTAL_DISCOVERED = 400;
const FAILURES_BEFORE_DISABLE = 5;

const candidateSchema = {
  type: 'object',
  properties: {
    channels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          handle: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          category: { type: 'string', enum: [...CATEGORIES] },
          language: { type: 'string', enum: ['en', 'uk'] },
          topics: { type: 'array', items: { type: 'string' } },
          rationaleUk: { type: 'string' },
        },
        required: ['name', 'handle', 'kind', 'category', 'language', 'topics', 'rationaleUk'],
      },
    },
  },
  required: ['channels'],
};

function normalizeName(value: string): Set<string> {
  return new Set(
    value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\(youtube\)|official|channel|офіційний|канал/g, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );
}

/** The resolved channel title must share a meaningful word with the proposed name (or the handle). */
export function channelTitleMatches(proposedName: string, handle: string | undefined, actualTitle: string): boolean {
  const a = normalizeName(proposedName);
  const b = normalizeName(actualTitle);
  for (const w of a) if (b.has(w)) return true;
  const h = (handle || '').replace(/^@/, '').toLowerCase();
  const compactTitle = actualTitle.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return h.length >= 4 && (compactTitle.includes(h) || h.includes(compactTitle.slice(0, Math.max(4, compactTitle.length))));
}

export function normalizeHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const fromUrl = /youtube\.com\/(@[\w.-]{3,40})/i.exec(raw)?.[1];
  const h = (fromUrl || raw).trim();
  const withAt = h.startsWith('@') ? h : `@${h}`;
  return /^@[\w.-]{3,40}$/.test(withAt) ? withAt : null;
}

/** Extracts the real channel ID from a YouTube channel page (no API key needed). */
export function extractChannelIdFromHtml(html: string): { channelId: string; title: string | null } | null {
  const id =
    /"externalId":"(UC[\w-]{22})"/.exec(html)?.[1] ||
    /<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/.exec(html)?.[1] ||
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1];
  if (!id) return null;
  const title = /<meta property="og:title" content="([^"]{1,200})"/.exec(html)?.[1] ?? null;
  return { channelId: id, title: title ? title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') : null };
}

export function parseCandidatesJson(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { channels?: unknown[] };
    return Array.isArray(parsed.channels) ? parsed.channels : [];
  } catch {
    return [];
  }
}

export function toCandidate(raw: unknown, discoveredBy: ChannelCandidate['discoveredBy'] = 'gemini'): ChannelCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 150) : '';
  const handle = normalizeHandle(r.handle);
  if (!name || !handle) return null;
  const category = (CATEGORIES as readonly string[]).includes(String(r.category)) ? (r.category as NewsCategory) : 'other';
  const kind = KINDS.includes(r.kind as ChannelKind) ? (r.kind as ChannelKind) : 'media';
  return {
    name,
    handle,
    kind,
    category,
    language: r.language === 'uk' ? 'uk' : 'en',
    topics: Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 40)).slice(0, 8) : [],
    rationaleUk: typeof r.rationaleUk === 'string' ? r.rationaleUk.slice(0, 500) : undefined,
    discoveredBy,
  };
}

export function credibilityFor(kind: ChannelKind, subscribers: number | null): { weight: number; tier: 'high' | 'standard' } {
  const base = kind === 'institution' || kind === 'company' ? 86 : kind === 'expert' ? 85 : kind === 'educator' ? 82 : 78;
  const bonus = subscribers === null ? 0 : subscribers >= 1_000_000 ? 6 : subscribers >= 250_000 ? 3 : 0;
  const weight = Math.min(95, base + bonus);
  return { weight, tier: weight >= 88 ? 'high' : 'standard' };
}

function slugFor(name: string, channelId: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const suffix = createHash('sha256').update(channelId).digest('hex').slice(0, 6);
  return `yt-${base || 'channel'}-${suffix}`;
}

@Injectable()
export class YoutubeChannelDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YoutubeChannelDiscoveryService.name);
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private running = false;
  private cache: { at: number; channels: YoutubeChannelDefinition[] } | null = null;

  constructor(@Optional() private readonly db?: DatabaseService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.db || process.env.YOUTUBE_CHANNEL_DISCOVERY === 'false') return;
    const intervalMs = Math.max(6 * 3_600_000, Number(process.env.YOUTUBE_CHANNEL_DISCOVERY_INTERVAL_MS) || 24 * 3_600_000);
    const loop = (delay: number) => {
      this.timer = setTimeout(async () => {
        if (this.destroyed) return;
        try {
          await this.discover();
        } catch (err) {
          this.logger.warn(`YouTube channel discovery failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.destroyed) loop(intervalMs);
        }
      }, delay);
    };
    loop(10 * 60_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Seed channels + verified discovered channels (cached for 15 minutes). */
  async getActiveChannels(): Promise<YoutubeChannelDefinition[]> {
    if (this.cache && Date.now() - this.cache.at < 15 * 60_000) return this.cache.channels;
    const seen = new Set(YOUTUBE_RSS_CHANNELS.map((c) => c.channelId));
    const merged: YoutubeChannelDefinition[] = [...YOUTUBE_RSS_CHANNELS];
    if (this.db) {
      try {
        const { rows } = await this.db.query<{
          channel_id: string; slug: string; name: string; category: string; credibility_weight: number;
          priority_tier: string; language: string; topics: string[];
        }>(
          `SELECT channel_id, slug, name, category, credibility_weight, priority_tier, language, topics
           FROM youtube_channels WHERE enabled AND review_status = 'approved'
           ORDER BY credibility_weight DESC LIMIT 600`,
        );
        for (const r of rows) {
          if (seen.has(r.channel_id)) continue;
          seen.add(r.channel_id);
          merged.push({
            slug: r.slug,
            channelId: r.channel_id,
            name: r.name,
            category: ((CATEGORIES as readonly string[]).includes(r.category) ? r.category : 'other') as NewsCategory,
            credibilityWeight: r.credibility_weight,
            priorityTier: r.priority_tier === 'high' ? 'high' : 'standard',
            language: r.language === 'uk' ? 'uk' : 'en',
            topics: Array.isArray(r.topics) ? r.topics : [],
          });
        }
      } catch {
        // migration 017 not applied yet: seed list only
      }
    }
    this.cache = { at: Date.now(), channels: merged };
    return merged;
  }

  async recordPollResult(channelId: string, ok: boolean, latestVideoAt?: string | null): Promise<void> {
    if (!this.db) return;
    await this.db
      .query(
        ok
          ? `UPDATE youtube_channels SET consecutive_failures = 0, last_video_at = COALESCE($2::timestamptz, last_video_at), updated_at = now() WHERE channel_id = $1`
          : `UPDATE youtube_channels SET consecutive_failures = consecutive_failures + 1,
               enabled = CASE WHEN consecutive_failures + 1 >= ${FAILURES_BEFORE_DISABLE} THEN false ELSE enabled END,
               updated_at = now() WHERE channel_id = $1`,
        ok ? [channelId, latestVideoAt ?? null] : [channelId],
      )
      .catch(() => undefined);
  }

  /** Channels seen in YouTube search results for big stories become candidates (verified on the next run). */
  async rememberSearchChannel(channelId: string, title: string, category: string | null): Promise<void> {
    if (!this.db || !CHANNEL_ID_RE.test(channelId)) return;
    await this.db
      .query(
        `INSERT INTO youtube_channels (channel_id, slug, name, category, discovered_by, enabled, review_status, rationale_uk)
         VALUES ($1, $2, $3, $4, 'youtube_search', false, 'pending_review', 'Знайдено у пошуку відео до великої історії')
         ON CONFLICT (channel_id) DO NOTHING`,
        [channelId, slugFor(title, channelId), title.slice(0, 150), category && (CATEGORIES as readonly string[]).includes(category) ? category : 'other'],
      )
      .catch(() => undefined);
  }

  private async proposeWithGemini(existing: YoutubeChannelDefinition[]): Promise<ChannelCandidate[]> {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) return [];

    const counts = new Map<string, number>();
    for (const c of CATEGORIES) if (c !== 'other') counts.set(c, 0);
    for (const ch of existing) counts.set(ch.category, (counts.get(ch.category) || 0) + 1);
    const gaps = [...counts.entries()].sort((a, b) => a[1] - b[1]).slice(0, 8).map(([c, n]) => `${c} (${n})`);

    let experts: string[] = [];
    if (this.db) {
      const { rows } = await this.db
        .query<{ full_name: string; organization: string | null }>(
          `SELECT full_name, organization FROM expert_profiles ORDER BY credibility_weight DESC LIMIT 40`,
        )
        .catch(() => ({ rows: [] as Array<{ full_name: string; organization: string | null }> }));
      experts = rows.map((r) => (r.organization ? `${r.full_name} (${r.organization})` : r.full_name));
    }

    const prompt = `You curate YouTube channels for a Ukrainian/English tech & world news app. We already monitor ${existing.length} channels:
${existing.slice(0, 160).map((c) => `- ${c.name} [${c.category}]`).join('\n')}

Topic gaps (category, channels we have): ${gaps.join(', ')}
Experts and organisations we already follow elsewhere (find their OFFICIAL YouTube channels if they exist): ${experts.slice(0, 40).join('; ') || 'none'}

Propose up to 15 NEW, real, currently active YouTube channels that are authoritative:
- official channels of companies, labs and institutions (e.g. AI labs, chip makers, space agencies, universities, regulators),
- recognised experts and researchers who publish substantive talks/analysis,
- reputable media and educators (no clickbait, no reaction/compilation channels, no conspiracy, no channels that only post Shorts),
- include several authoritative Ukrainian-language channels (tech, science, economy, defense-tech analysis).
For each give the exact @handle as it appears in the channel URL (youtube.com/@handle). Only include channels you are confident exist; we verify every handle and reject mismatches. Do not repeat channels from our list.
Return JSON: {"channels":[{"name","handle","kind" (expert|company|media|educator|institution),"category" (one of: ${CATEGORIES.join(', ')}),"language" (en|uk),"topics":[...],"rationaleUk"}]}`;

    const parse = (data: unknown) => {
      const parts = (data as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] })
        .candidates?.[0]?.content?.parts ?? [];
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      return parseCandidatesJson(text).map((c) => toCandidate(c)).filter((c): c is ChannelCandidate => c !== null);
    };

    // 1) Grounded with Google Search (real, current channels); JSON parsed from text.
    try {
      const { data } = await postGeminiGenerateContent({
        apiKey: key,
        preferredModel: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
        priority: 'low',
        timeoutMs: 60_000,
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
        },
      });
      const out = parse(data);
      if (out.length) return out;
    } catch (err) {
      this.logger.debug(`Grounded channel discovery unavailable: ${err instanceof Error ? err.message : err}`);
    }
    // 2) Fallback: structured output without tools.
    try {
      const { data } = await postGeminiGenerateContent({
        apiKey: key,
        preferredModel: process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
        priority: 'low',
        timeoutMs: 60_000,
        jsonSchemaWhenNoTools: candidateSchema,
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: candidateSchema, maxOutputTokens: 4000 },
        },
      });
      return parse(data);
    } catch (err) {
      this.logger.warn(`Gemini channel discovery failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /** Handle or channel ID → verified channel ID, title and subscribers. */
  async resolveChannel(candidate: { handle?: string; channelId?: string }, fetchFn: typeof fetch = fetch): Promise<ResolvedChannel | null> {
    const apiKey = process.env.YOUTUBE_API_KEY?.trim();
    if (apiKey) {
      const params = new URLSearchParams({ part: 'snippet,statistics', key: apiKey });
      if (candidate.channelId) params.set('id', candidate.channelId);
      else if (candidate.handle) params.set('forHandle', candidate.handle);
      else return null;
      try {
        const resp = await fetchFn(`https://www.googleapis.com/youtube/v3/channels?${params}`, { signal: AbortSignal.timeout(8_000) });
        if (resp.ok) {
          const json = (await resp.json()) as {
            items?: Array<{ id?: string; snippet?: { title?: string }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }>;
          };
          const item = json.items?.[0];
          if (item?.id && CHANNEL_ID_RE.test(item.id)) {
            const subs = item.statistics?.hiddenSubscriberCount ? null : Number(item.statistics?.subscriberCount ?? NaN);
            return { channelId: item.id, title: item.snippet?.title || '', subscriberCount: Number.isFinite(subs) ? (subs as number) : null };
          }
          return null;
        }
        await resp.body?.cancel().catch(() => undefined);
      } catch {
        // fall through to page scraping
      }
    }
    if (candidate.channelId && CHANNEL_ID_RE.test(candidate.channelId)) {
      return { channelId: candidate.channelId, title: '', subscriberCount: null };
    }
    if (!candidate.handle) return null;
    try {
      const resp = await fetchFn(`https://www.youtube.com/${encodeURIComponent(candidate.handle)}`, {
        headers: { 'User-Agent': getHonestUserAgent(), 'Accept-Language': 'en-US,en;q=0.8' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return null;
      }
      const html = (await resp.text()).slice(0, 1_500_000);
      const found = extractChannelIdFromHtml(html);
      return found ? { channelId: found.channelId, title: found.title || '', subscriberCount: null } : null;
    } catch {
      return null;
    }
  }

  /** RSS must work and have a reasonably recent long-form video. */
  async verifyFeed(channelId: string, name: string): Promise<{ ok: boolean; latestVideoAt: string | null; title: string | null }> {
    try {
      const items = await fetchAndParseFeedUrl({
        slug: 'yt-verify',
        name,
        domain: 'youtube.com',
        allowedDomains: ['youtube.com', 'm.youtube.com', 'youtu.be'],
        url: buildYoutubeRssUrl(channelId),
        licenseMode: 'summary',
      });
      const longForm = items.filter((i) => !i.is_youtube_short && !/\/shorts\//.test(i.url));
      const latest = longForm.map((i) => Date.parse(i.published_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
      const recentEnough = latest !== undefined && Date.now() - latest <= 90 * 86_400_000;
      return { ok: longForm.length >= 3 && recentEnough, latestVideoAt: latest ? new Date(latest).toISOString() : null, title: null };
    } catch {
      return { ok: false, latestVideoAt: null, title: null };
    }
  }

  async discover(): Promise<{ proposed: number; added: string[]; rejected: number; promoted: number }> {
    if (!this.db || this.running) return { proposed: 0, added: [], rejected: 0, promoted: 0 };
    this.running = true;
    const added: string[] = [];
    let rejected = 0;
    let promoted = 0;
    let proposed = 0;
    try {
      const existing = await this.getActiveChannels();
      const { rows: known } = await this.db.query<{ channel_id: string; review_status: string }>(
        `SELECT channel_id, review_status FROM youtube_channels`,
      );
      const knownIds = new Set([...existing.map((c) => c.channelId), ...known.map((k) => k.channel_id)]);
      const { rows: totalRow } = await this.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM youtube_channels WHERE review_status = 'approved'`,
      );
      let room = Math.max(0, MAX_TOTAL_DISCOVERED - (totalRow[0]?.n ?? 0));
      const minSubs = Number(process.env.YOUTUBE_CHANNEL_MIN_SUBSCRIBERS) || 20_000;

      // A) Gemini proposals
      const candidates = room > 0 ? await this.proposeWithGemini(existing) : [];
      proposed = candidates.length;
      for (const c of candidates) {
        if (this.destroyed || added.length >= MAX_ADDED_PER_RUN || room <= 0) break;
        const resolved = await this.resolveChannel(c);
        if (!resolved || knownIds.has(resolved.channelId)) {
          rejected += 1;
          continue;
        }
        if (resolved.title && !channelTitleMatches(c.name, c.handle, resolved.title)) {
          rejected += 1;
          continue;
        }
        if (resolved.subscriberCount !== null && resolved.subscriberCount < minSubs) {
          rejected += 1;
          continue;
        }
        const feed = await this.verifyFeed(resolved.channelId, c.name);
        if (!feed.ok) {
          rejected += 1;
          continue;
        }
        const { weight, tier } = credibilityFor(c.kind, resolved.subscriberCount);
        const name = (resolved.title || c.name).slice(0, 150);
        await this.db.query(
          `INSERT INTO youtube_channels (channel_id, slug, name, handle, kind, category, language, topics, credibility_weight,
             priority_tier, subscriber_count, discovered_by, rationale_uk, enabled, review_status, last_video_at, last_verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'gemini',$12,true,'approved',$13,now())
           ON CONFLICT (channel_id) DO NOTHING`,
          [resolved.channelId, slugFor(name, resolved.channelId), name, c.handle ?? null, c.kind, c.category, c.language,
            JSON.stringify(c.topics), weight, tier, resolved.subscriberCount, c.rationaleUk ?? null, feed.latestVideoAt],
        );
        knownIds.add(resolved.channelId);
        added.push(name);
        room -= 1;
      }

      // B) Channels that showed up in YouTube search for big stories
      const { rows: pending } = await this.db.query<{ channel_id: string; name: string }>(
        `SELECT channel_id, name FROM youtube_channels WHERE review_status = 'pending_review' AND discovered_by = 'youtube_search'
         ORDER BY created_at LIMIT 10`,
      );
      for (const p of pending) {
        if (this.destroyed || room <= 0) break;
        const resolved = await this.resolveChannel({ channelId: p.channel_id });
        const feed = resolved ? await this.verifyFeed(p.channel_id, p.name) : { ok: false, latestVideoAt: null };
        // Without an API key we cannot see subscribers, so search-found channels stay pending.
        const subsOk = resolved?.subscriberCount !== null && resolved !== null && resolved.subscriberCount >= Math.max(minSubs, 50_000);
        const approve = Boolean(resolved && feed.ok && subsOk);
        const { weight, tier } = credibilityFor('media', resolved?.subscriberCount ?? null);
        await this.db.query(
          `UPDATE youtube_channels SET review_status = $2, enabled = $3, subscriber_count = $4, credibility_weight = $5,
             priority_tier = $6, last_video_at = $7, last_verified_at = now(), updated_at = now()
           WHERE channel_id = $1`,
          [p.channel_id, approve ? 'approved' : resolved && feed.ok ? 'pending_review' : 'rejected', approve,
            resolved?.subscriberCount ?? null, weight, tier, feed.latestVideoAt],
        );
        if (approve) {
          promoted += 1;
          room -= 1;
        }
      }
    } finally {
      this.running = false;
      this.cache = null;
    }
    if (added.length || promoted) {
      this.logger.log(`YouTube channel discovery: +${added.length} from Gemini (${added.join(', ')}), +${promoted} from story search`);
    }
    return { proposed, added, rejected, promoted };
  }

  async listDiscovered(limit = 100) {
    if (!this.db) return [];
    const { rows } = await this.db
      .query(
        `SELECT channel_id, name, handle, kind, category, language, credibility_weight, subscriber_count, discovered_by,
                enabled, review_status, consecutive_failures, last_video_at, rationale_uk, created_at
         FROM youtube_channels ORDER BY created_at DESC LIMIT $1`,
        [limit],
      )
      .catch(() => ({ rows: [] }));
    return rows;
  }
}
