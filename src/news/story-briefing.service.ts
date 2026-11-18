import { NEWS_ELIGIBILITY_SQL } from './eligibility';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { generateJsonWithRouter, generateWithRouter, parseJsonLoose } from '../common/llm-router';
import { readEnv } from '../common/r2-storage';
import { DatabaseService } from '../database/database.service';
import { ClusterSource, extractClusterSignature } from './news-clustering.service';
import { TRAGEDY_SENSITIVITY_RE } from './news-memes.service';
import { importanceScore } from './personalization.service';
import { analyzeCoverage } from './source-profiles';
import { YoutubeChannelDiscoveryService } from '../youtube/youtube-channel-discovery.service';

/**
 * Multi-source "story" briefings: several related reports (and matching YouTube videos) about one event
 * are merged into one explained story — what happened, why it matters, background, timeline, how outlets
 * differ, what was said on video, what to watch next. Generated once per cluster in Ukrainian and English.
 */

export interface StoryVideo {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  takeaways: string[];
  quotes: Array<{ timestampLabel: string; speaker: string; insightUk: string }>;
  newsItemId: string | null;
  analysed: boolean;
}

export interface StoryLocalized {
  title: string;
  tldr: string;
  whatHappened: string;
  whyItMatters: string;
  background: string;
  timeline: Array<{ when: string; event: string }>;
  perspectives: Array<{ source: string; angle: string }>;
  videoInsights: Array<{ videoIndex: number; insight: string }>;
  whatsNext: string;
  /** Objectivity layer (v2.2): optional for briefings generated before it existed. */
  forYou?: string;
  claims?: Array<{ claim: string; kind: string; confidence: string; confirmedBy: string[]; disputedBy: string[] }>;
  positions?: Array<{ side: string; position: string }>;
  unknowns?: string[];
  consensusNote?: string;
}

export interface StoryBriefingPayload {
  clusterId: string;
  leadNewsId: string | null;
  category: string | null;
  importanceScore: number;
  sourceCount: number;
  sources: Array<{ name: string; url: string; title: string; publishedAt: string | null }>;
  videos: StoryVideo[];
  uk: StoryLocalized;
  en: StoryLocalized;
  sensitive: boolean;
  generatedAt: string;
  /** Independent fact check by a second model: claims in the draft that the sources do not support. */
  verification?: { checked: boolean; supported: boolean; issues: string[]; model: string | null };
  modelUsed?: string;
}

const verifySchema = {
  type: 'object',
  properties: { supported: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
  required: ['supported', 'issues'],
};

const localizedSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    tldr: { type: 'string' },
    whatHappened: { type: 'string' },
    whyItMatters: { type: 'string' },
    background: { type: 'string' },
    timeline: { type: 'array', items: { type: 'object', properties: { when: { type: 'string' }, event: { type: 'string' } }, required: ['when', 'event'] } },
    perspectives: { type: 'array', items: { type: 'object', properties: { source: { type: 'string' }, angle: { type: 'string' } }, required: ['source', 'angle'] } },
    videoInsights: { type: 'array', items: { type: 'object', properties: { videoIndex: { type: 'integer' }, insight: { type: 'string' } }, required: ['videoIndex', 'insight'] } },
    whatsNext: { type: 'string' },
    forYou: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          kind: { type: 'string', enum: ['fact', 'official_claim', 'opinion'] },
          confidence: { type: 'string', enum: ['confirmed', 'single_source', 'unverified', 'disputed'] },
          confirmedBy: { type: 'array', items: { type: 'string' } },
          disputedBy: { type: 'array', items: { type: 'string' } },
        },
        required: ['claim', 'kind', 'confidence', 'confirmedBy', 'disputedBy'],
      },
    },
    positions: { type: 'array', items: { type: 'object', properties: { side: { type: 'string' }, position: { type: 'string' } }, required: ['side', 'position'] } },
    unknowns: { type: 'array', items: { type: 'string' } },
    consensusNote: { type: 'string' },
  },
  required: ['title', 'tldr', 'whatHappened', 'whyItMatters', 'background', 'timeline', 'perspectives', 'videoInsights', 'whatsNext', 'forYou', 'claims', 'positions', 'unknowns', 'consensusNote'],
};

const storySchema = {
  type: 'object',
  properties: { sensitive: { type: 'boolean' }, uk: localizedSchema, en: localizedSchema },
  required: ['sensitive', 'uk', 'en'],
};

type ClusterRow = {
  id: string;
  cluster_id: string;
  category: string | null;
  title_uk: string | null;
  original_title: string;
  summary_uk: string | null;
  original_summary: string | null;
  published_at: Date | null;
  important: boolean;
  credibility_tier: string | null;
  cluster_sources: ClusterSource[] | null;
  source_name: string;
};

type VideoRow = {
  video_id: string;
  url: string;
  title: string;
  title_uk: string | null;
  channel_name: string;
  thumbnail_url: string | null;
  published_at: Date | null;
  summary_uk: string | null;
  key_takeaways_uk: string[] | null;
  timestamped_quotes: Array<{ timestampLabel: string; speaker: string; insightUk: string }> | null;
  news_item_id: string | null;
  cluster_id: string | null;
};

/** Looser than article clustering: a video about the same event shares ≥2 named entities with the story. */
export function videoMatchesStory(storyText: string, videoText: string): boolean {
  const a = extractClusterSignature(storyText);
  const b = extractClusterSignature(videoText);
  let entities = 0;
  for (const e of a.entities) if (b.entities.has(e)) entities += 1;
  let tokens = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) tokens += 1;
  return entities >= 2 || (entities >= 1 && tokens >= 4);
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[ \t]+/g, ' ').trim().slice(0, max) : '';
}

export function normalizeLocalized(raw: unknown, videoCount: number): StoryLocalized | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = cleanText(r.title, 220);
  const tldr = cleanText(r.tldr, 600);
  const whatHappened = cleanText(r.whatHappened, 3500);
  if (!title || !tldr || !whatHappened) return null;
  const list = <T>(v: unknown, max: number, map: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(v) ? v.slice(0, max).map((x) => (x && typeof x === 'object' ? map(x as Record<string, unknown>) : null)).filter((x): x is T => x !== null) : [];
  return {
    title,
    tldr,
    whatHappened,
    whyItMatters: cleanText(r.whyItMatters, 1500),
    background: cleanText(r.background, 1500),
    timeline: list(r.timeline, 8, (x) => {
      const when = cleanText(x.when, 60);
      const event = cleanText(x.event, 300);
      return when && event ? { when, event } : null;
    }),
    perspectives: list(r.perspectives, 6, (x) => {
      const source = cleanText(x.source, 120);
      const angle = cleanText(x.angle, 400);
      return source && angle ? { source, angle } : null;
    }),
    videoInsights: list(r.videoInsights, 4, (x) => {
      const videoIndex = Number(x.videoIndex);
      const insight = cleanText(x.insight, 500);
      return Number.isInteger(videoIndex) && videoIndex >= 1 && videoIndex <= videoCount && insight ? { videoIndex, insight } : null;
    }),
    whatsNext: cleanText(r.whatsNext, 800),
    forYou: cleanText(r.forYou, 1200),
    claims: list(r.claims, 10, (x) => {
      const claim = cleanText(x.claim, 600);
      if (!claim) return null;
      const kinds = ['fact', 'official_claim', 'opinion'];
      const levels = ['confirmed', 'single_source', 'unverified', 'disputed'];
      const names = (v: unknown) => (Array.isArray(v) ? v.map((n) => cleanText(n, 120)).filter(Boolean).slice(0, 8) : []);
      return {
        claim,
        kind: kinds.includes(String(x.kind)) ? String(x.kind) : 'official_claim',
        confidence: levels.includes(String(x.confidence)) ? String(x.confidence) : 'unverified',
        confirmedBy: names(x.confirmedBy),
        disputedBy: names(x.disputedBy),
      };
    }),
    positions: list(r.positions, 6, (x) => {
      const side = cleanText(x.side, 160);
      const position = cleanText(x.position, 700);
      return side && position ? { side, position } : null;
    }),
    unknowns: Array.isArray(r.unknowns) ? r.unknowns.map((u) => cleanText(u, 400)).filter(Boolean).slice(0, 6) : [],
    consensusNote: cleanText(r.consensusNote, 800),
  };
}

@Injectable()
export class StoryBriefingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StoryBriefingService.name);
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private running = false;
  private youtubeSearchesToday = { day: '', count: 0 };

  constructor(
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly channelDiscovery?: YoutubeChannelDiscoveryService,
  ) {}

  onModuleInit(): void {
    const anyLlm = Boolean(process.env.GEMINI_API_KEY?.trim() || readEnv('groq_api_key') || readEnv('openrouter_api_key'));
    if (process.env.NODE_ENV === 'test' || !this.db || !anyLlm || process.env.STORY_BRIEFINGS_ENABLED === 'false') return;
    const intervalMs = Math.max(15 * 60_000, Number(process.env.STORY_BRIEFING_INTERVAL_MS) || 40 * 60_000);
    const loop = (delay: number) => {
      this.timer = setTimeout(async () => {
        if (this.destroyed) return;
        try {
          await this.refreshTopStories();
        } catch (err) {
          this.logger.warn(`Story briefing refresh failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.destroyed) loop(intervalMs);
        }
      }, delay);
    };
    loop(3 * 60_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private dailyMax(): number {
    const n = Number(process.env.STORY_BRIEFING_DAILY_MAX);
    return Number.isInteger(n) && n >= 0 && n <= 200 ? n : 36;
  }

  /** Groups the last 30 hours of published news by cluster and (re)generates briefings for the biggest stories. */
  async refreshTopStories(maxThisRun = 4): Promise<{ generated: number }> {
    if (!this.db || this.running) return { generated: 0 };
    this.running = true;
    let generated = 0;
    try {
      const { rows: usage } = await this.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM story_briefings WHERE updated_at >= date_trunc('day', now())`,
      );
      const remaining = Math.max(0, this.dailyMax() - (usage[0]?.n ?? 0));
      if (!remaining) return { generated };

      const { rows } = await this.db.query<ClusterRow>(
        `SELECT n.id::text, n.cluster_id, n.category, n.title_uk, n.original_title, n.summary_uk, n.original_summary,
                n.published_at, COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
                n.credibility_tier, n.cluster_sources, s.name AS source_name
         FROM news_items n JOIN sources s ON s.id = n.source_id
         WHERE ${NEWS_ELIGIBILITY_SQL} AND n.cluster_id IS NOT NULL
           AND n.published_at >= now() - interval '30 hours'
         ORDER BY n.published_at DESC
         LIMIT 400`,
      );
      const groups = new Map<string, ClusterRow[]>();
      for (const row of rows) {
        const list = groups.get(row.cluster_id) ?? [];
        list.push(row);
        groups.set(row.cluster_id, list);
      }

      const { rows: existing } = await this.db.query<{ cluster_id: string; source_count: number; updated_at: Date }>(
        `SELECT cluster_id, source_count, updated_at FROM story_briefings WHERE cluster_id = ANY($1::text[])`,
        [[...groups.keys()]],
      );
      const existingMap = new Map(existing.map((e) => [e.cluster_id, e]));

      const candidates = [...groups.entries()]
        .map(([clusterId, items]) => {
          const sources = this.mergeSources(items);
          const lead = items.find((i) => i.important) ?? items[0];
          const score = importanceScore({ id: lead.id, important: items.some((i) => i.important), source_count: sources.length, credibility_tier: lead.credibility_tier });
          return { clusterId, items, sources, lead, score };
        })
        .filter((c) => c.sources.length >= 2 || c.lead.important)
        .filter((c) => {
          const prev = existingMap.get(c.clusterId);
          // Regenerate only when the story has grown (new outlets reported it).
          return !prev || c.sources.length >= prev.source_count + 2;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(maxThisRun, remaining));

      for (const c of candidates) {
        if (this.destroyed) break;
        const ok = await this.generate(c.clusterId, c.items, c.sources, c.lead, c.score).catch((err) => {
          this.logger.warn(`Story ${c.clusterId} failed: ${err instanceof Error ? err.message : err}`);
          return false;
        });
        if (ok) generated += 1;
      }
    } finally {
      this.running = false;
    }
    if (generated) this.logger.log(`Generated ${generated} multi-source story briefing(s)`);
    return { generated };
  }

  private mergeSources(items: ClusterRow[]) {
    const seen = new Set<string>();
    const out: Array<{ name: string; url: string; title: string; summary: string; publishedAt: string | null }> = [];
    for (const item of items) {
      for (const src of item.cluster_sources ?? []) {
        const key = src.canonicalUrl || src.url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ name: src.sourceName, url: src.url, title: src.title, summary: src.summary || '', publishedAt: src.publishedAt });
      }
    }
    return out.slice(0, 10);
  }

  private async findVideos(storyText: string, clusterId: string): Promise<StoryVideo[]> {
    if (!this.db) return [];
    const { rows } = await this.db.query<VideoRow>(
      `SELECT video_id, url, title, title_uk, channel_name, thumbnail_url, published_at, summary_uk,
              key_takeaways_uk, timestamped_quotes, news_item_id::text, cluster_id
       FROM youtube_videos
       WHERE status = 'transcribed' AND published_at >= now() - interval '4 days'
       ORDER BY worth_score DESC, published_at DESC
       LIMIT 120`,
    ).catch(() => ({ rows: [] as VideoRow[] }));
    const matched = rows
      .filter((v) => v.cluster_id === clusterId || videoMatchesStory(storyText, `${v.title} ${(v.key_takeaways_uk || []).join(' ')}`))
      .slice(0, 3);

    const videos: StoryVideo[] = matched.map((v) => ({
      videoId: v.video_id,
      url: v.url,
      title: v.title_uk || v.title,
      channel: v.channel_name,
      thumbnailUrl: v.thumbnail_url || `https://i.ytimg.com/vi/${v.video_id}/hqdefault.jpg`,
      publishedAt: v.published_at ? new Date(v.published_at).toISOString() : null,
      takeaways: (v.key_takeaways_uk || []).slice(0, 5),
      quotes: (v.timestamped_quotes || []).slice(0, 4),
      newsItemId: v.news_item_id,
      analysed: true,
    }));
    if (matched.length) {
      await this.db.query(`UPDATE youtube_videos SET cluster_id = $1 WHERE video_id = ANY($2::text[])`, [clusterId, matched.map((v) => v.video_id)]).catch(() => undefined);
    }

    // Optional: when the curated channels have nothing, look for fresh relevant videos with the YouTube Data API.
    if (videos.length === 0) videos.push(...(await this.searchYoutube(storyText)));
    return videos;
  }

  /** YouTube Data API v3 search (100 quota units each; capped at YOUTUBE_SEARCH_DAILY_MAX, default 40/day). */
  private async searchYoutube(query: string): Promise<StoryVideo[]> {
    const key = process.env.YOUTUBE_API_KEY?.trim();
    if (!key) return [];
    const day = new Date().toISOString().slice(0, 10);
    if (this.youtubeSearchesToday.day !== day) this.youtubeSearchesToday = { day, count: 0 };
    const max = Number(process.env.YOUTUBE_SEARCH_DAILY_MAX) || 40;
    if (this.youtubeSearchesToday.count >= max) return [];
    this.youtubeSearchesToday.count += 1;
    const q = query.replace(/[^\p{L}\p{N}\s.-]/gu, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, 8).join(' ');
    const params = new URLSearchParams({
      part: 'snippet', type: 'video', q, maxResults: '3', order: 'relevance', videoDuration: 'medium',
      publishedAfter: new Date(Date.now() - 3 * 86_400_000).toISOString(), relevanceLanguage: 'en', safeSearch: 'strict', key,
    });
    try {
      const resp = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(8_000) });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return [];
      }
      const json = (await resp.json()) as {
        items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelId?: string; channelTitle?: string; publishedAt?: string; thumbnails?: { high?: { url?: string } } } }>;
      };
      // Channels covering big stories become candidates for the radar (verified before use).
      for (const i of json.items ?? []) {
        if (i.snippet?.channelId && i.snippet.channelTitle) {
          void this.channelDiscovery?.rememberSearchChannel(i.snippet.channelId, i.snippet.channelTitle, null);
        }
      }
      return (json.items ?? [])
        .filter((i) => i.id?.videoId && i.snippet?.title)
        .map((i) => ({
          videoId: i.id!.videoId!,
          url: `https://www.youtube.com/watch?v=${i.id!.videoId}`,
          title: i.snippet!.title!,
          channel: i.snippet?.channelTitle || 'YouTube',
          thumbnailUrl: i.snippet?.thumbnails?.high?.url || null,
          publishedAt: i.snippet?.publishedAt || null,
          takeaways: [],
          quotes: [],
          newsItemId: null,
          analysed: false,
        }));
    } catch {
      return [];
    }
  }

  private async generate(
    clusterId: string,
    items: ClusterRow[],
    sources: Array<{ name: string; url: string; title: string; summary: string; publishedAt: string | null }>,
    lead: ClusterRow,
    score: number,
  ): Promise<boolean> {
    if (!this.db) return false;
    const storyText = `${lead.original_title} ${lead.title_uk || ''} ${sources.map((s) => s.title).join(' ')}`;
    const sensitiveByRule = TRAGEDY_SENSITIVITY_RE.test(`${storyText} ${lead.summary_uk || ''}`);
    const videos = await this.findVideos(storyText, clusterId);

    const sourceBlock = sources
      .map((s, i) => `[${i + 1}] ${s.name}${s.publishedAt ? ` (${s.publishedAt})` : ''}: ${s.title}${s.summary ? `\n    ${s.summary.replace(/\s+/g, ' ').slice(0, 500)}` : ''}`)
      .join('\n');
    const editorialBlock = items
      .slice(0, 4)
      .map((i) => `- ${i.source_name}: ${i.title_uk || i.original_title}\n  ${(i.summary_uk || i.original_summary || '').replace(/\s+/g, ' ').slice(0, 700)}`)
      .join('\n');
    const videoBlock = videos
      .map((v, i) => `[V${i + 1}] ${v.channel}: ${v.title}${v.takeaways.length ? `\n    Тези: ${v.takeaways.join(' | ')}` : ' (not analysed, title only)'}`)
      .join('\n');

    const prompt = `You are the lead editor of a news app. Merge these related reports about ONE event into a single explained story.
Use ONLY facts present in the material below. Refer to sources as [1], [2]... and videos as [V1], [V2]. Never invent facts, numbers, quotes or URLs.

SOURCES:
${sourceBlock}

OUR EARLIER SUMMARIES:
${editorialBlock}
${videos.length ? `\nYOUTUBE VIDEOS ABOUT THIS STORY:\n${videoBlock}` : ''}

Write the same story twice: "uk" in natural modern Ukrainian and "en" in natural English. For each:
- title: clear, non-clickbait headline (max 110 chars)
- tldr: 1–2 sentences, the essence
- whatHappened: 2–4 short paragraphs synthesising all sources, noting where they agree or differ
- whyItMatters: concrete consequences for ordinary readers / developers / businesses
- background: context a non-expert needs (what led here, earlier related events)
- timeline: key moments in order (only those supported by the material)
- perspectives: how different outlets framed it — source name + angle (what they emphasised, which words they chose); skip if all say the same
- videoInsights: for analysed videos only, what was said that adds to the story (videoIndex = number after V)
- whatsNext: what to watch next (only what sources say is scheduled or expected)
- forYou: what it concretely means for an ordinary reader in Ukraine (money, work, documents, health, safety); empty if nothing
- claims: 3–8 key statements; kind = fact | official_claim (a party says so) | opinion; confidence = confirmed (2+ independent sources) | single_source | unverified | disputed; confirmedBy / disputedBy = outlet names
- positions: each side's position in its strongest form, worded so its supporters would agree; empty if not controversial
- unknowns: what is still not known
- consensusNote: if science, law or documented facts clearly settle part of the question, say so (no false balance); else empty
Neutral wording, no verdicts of your own. State media of a party to a conflict is labelled as that party's position.
Set sensitive=true if the story involves deaths, war, disasters or tragedy (it must then be written with a sober tone).`;

    const routed = await generateWithRouter({
      task: 'story',
      prompt,
      schema: storySchema,
      schemaName: 'story_briefing',
      maxTokens: 9000,
      temperature: 0.3,
      timeoutMs: 90_000,
    });
    if (!routed) return false;
    const modelUsed = `${routed.provider}:${routed.model}`;
    const parsed = parseJsonLoose(routed.text) as { sensitive?: boolean; uk?: unknown; en?: unknown };
    const uk = normalizeLocalized(parsed.uk, videos.length);
    const en = normalizeLocalized(parsed.en, videos.length);
    if (!uk || !en) return false;

    // Second opinion from a different model: flag claims the sources do not back up.
    let verification: StoryBriefingPayload['verification'] = { checked: false, supported: true, issues: [], model: null };
    const verified = await generateJsonWithRouter<{ supported?: boolean; issues?: string[] }>({
      task: 'classify',
      exclude: [routed.provider],
      prompt: `You are a strict fact-checker. SOURCES:
${sourceBlock}
${videoBlock ? `VIDEOS:
${videoBlock}
` : ''}
DRAFT:
${en.tldr}
${en.whatHappened}
${en.whyItMatters}

List every concrete claim in the DRAFT (numbers, names, dates, causes) that is NOT supported by the SOURCES. Return JSON {"supported": true|false, "issues": ["..."]}. supported=false only if there are unsupported claims.`,
      schema: verifySchema,
      schemaName: 'fact_check',
      maxTokens: 700,
      temperature: 0,
      timeoutMs: 30_000,
    }).catch(() => null);
    if (verified) {
      const issues = Array.isArray(verified.data.issues) ? verified.data.issues.filter((i) => typeof i === 'string').slice(0, 6) : [];
      verification = { checked: true, supported: verified.data.supported !== false && issues.length === 0, issues, model: `${verified.provider}:${verified.model}` };
    }

    const payload: StoryBriefingPayload = {
      verification,
      modelUsed,
      clusterId,
      leadNewsId: lead.id,
      category: lead.category,
      importanceScore: Math.round(score * 1000) / 1000,
      sourceCount: sources.length,
      sources: sources.map(({ name, url, title, publishedAt }) => ({ name, url, title, publishedAt })),
      videos,
      uk,
      en,
      sensitive: Boolean(parsed.sensitive) || sensitiveByRule,
      generatedAt: new Date().toISOString(),
    };
    await this.db.query(
      `INSERT INTO story_briefings (cluster_id, lead_news_id, category, importance_score, source_count, payload, model_used, sensitive, updated_at)
       VALUES ($1, $2::bigint, $3, $4, $5, $6::jsonb, $7, $8, now())
       ON CONFLICT (cluster_id) DO UPDATE SET
         lead_news_id = EXCLUDED.lead_news_id, category = EXCLUDED.category, importance_score = EXCLUDED.importance_score,
         source_count = EXCLUDED.source_count, payload = EXCLUDED.payload, model_used = EXCLUDED.model_used,
         sensitive = EXCLUDED.sensitive, updated_at = now()`,
      [clusterId, lead.id, lead.category, payload.importanceScore, payload.sourceCount, JSON.stringify(payload), modelUsed, payload.sensitive],
    );
    return true;
  }

  async list(limit: number, lang: string, maxAgeHours = 48) {
    if (!this.db) return [];
    try {
      const { rows } = await this.db.query<{ payload: StoryBriefingPayload; updated_at: Date }>(
        `SELECT b.payload, b.updated_at FROM story_briefings b JOIN news_items n ON n.id = b.lead_news_id
         WHERE ${NEWS_ELIGIBILITY_SQL} AND b.updated_at >= now() - ($2::int * interval '1 hour')
         ORDER BY b.importance_score DESC, b.updated_at DESC LIMIT $1`,
        [limit, maxAgeHours],
      );
      return rows.map((r) => this.localize(r.payload, lang));
    } catch {
      return [];
    }
  }

  async get(clusterId: string, lang: string) {
    if (!this.db) return null;
    const { rows } = await this.db
      .query<{ payload: StoryBriefingPayload }>(`SELECT b.payload FROM story_briefings b JOIN news_items n ON n.id = b.lead_news_id WHERE b.cluster_id = $1 AND ${NEWS_ELIGIBILITY_SQL}`, [clusterId])
      .catch(() => ({ rows: [] as Array<{ payload: StoryBriefingPayload }> }));
    return rows[0] ? this.localize(rows[0].payload, lang) : null;
  }

  async getForNews(newsId: string, lang: string) {
    if (!this.db) return null;
    const { rows } = await this.db
      .query<{ payload: StoryBriefingPayload }>(
        `SELECT b.payload FROM story_briefings b JOIN news_items n ON n.cluster_id = b.cluster_id
         WHERE n.id::text = $1 AND ${NEWS_ELIGIBILITY_SQL}
           AND EXISTS (SELECT 1 FROM news_items n WHERE n.id = b.lead_news_id AND ${NEWS_ELIGIBILITY_SQL}) LIMIT 1`,
        [newsId],
      )
      .catch(() => ({ rows: [] as Array<{ payload: StoryBriefingPayload }> }));
    return rows[0] ? this.localize(rows[0].payload, lang) : null;
  }

  localize(payload: StoryBriefingPayload, lang: string) {
    const text = lang === 'en' ? payload.en : payload.uk;
    const { uk: _uk, en: _en, ...rest } = payload;
    const l = lang === 'en' ? 'en' : 'uk';
    const coverage = analyzeCoverage(
      (payload.sources ?? []).map((s) => ({ sourceName: s.name, url: s.url })),
      l,
    );
    return { ...rest, lang: l, coverage, ...text };
  }
}
