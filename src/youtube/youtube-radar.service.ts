import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  canUseHydrogenQuota,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_HYDROGEN_MODEL,
  isHydrogenModel,
  postGeminiGenerateContent,
} from '../common/gemini-client';
import { canonicalizeUrl } from '../common/url-utils';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES, NewsCategory } from '../ingest/ingest.dto';
import { FeedArticle, fetchAndParseFeedUrl, isPublishedWithinHours } from '../news/company-feeds.service';
import { buildStableClusterId, ClusterSource } from '../news/news-clustering.service';
import { videoMatchesStory } from '../news/story-briefing.service';
import {
  buildYoutubeRssUrl,
  extractYoutubeVideoId,
  YOUTUBE_RSS_CHANNELS,
  YoutubeChannelDefinition,
} from './youtube-channels';
import { YoutubeChannelDiscoveryService } from './youtube-channel-discovery.service';

export const DEFAULT_MAX_DAILY_TRANSCRIPTIONS = 30;
export const DEFAULT_MAX_DAILY_APIFY_VIDEOS = 5;
export const DEFAULT_WORTHINESS_THRESHOLD = 62;
export const DEFAULT_APIFY_YOUTUBE_ACTOR = 'novi~youtube-transcript-api';
const DEFAULT_POLL_INTERVAL_MS = 45 * 60_000;
const VIDEO_LOOKBACK_HOURS = 72;
const MAX_VIDEO_SLICE_SEC = 1_800; // 30 min max window for ultra-compressed audio-first Gemini pass
const MIN_AUDIO_FPS = 0.01; // 1 frame per 100s -> ~0.66 tok/s visual vs 32 tok/s audio (~98% audio)
const MAX_APIFY_TRANSCRIPT_CHARS = 14_000;

export interface YoutubeChapter {
  timestampSec: number;
  timestampLabel: string;
  title: string;
}

export interface YoutubeTimestampedQuote {
  timestampSec: number;
  timestampLabel: string;
  speaker: string;
  insightUk: string;
}

export interface YoutubeWorthinessAssessment {
  worthy: boolean;
  worthScore: number;
  reason: string;
  isShort: boolean;
  chapters: YoutubeChapter[];
  estimatedDurationSec: number | null;
  preferApifyFallback: boolean;
}

export interface YoutubeVideoInsight {
  videoId: string;
  channelSlug: string;
  channelId: string;
  channelName: string;
  url: string;
  title: string;
  thumbnailUrl: string | null;
  publishedAt: string;
  viewsCount: number;
  likesCount: number;
  estimatedDurationSec: number | null;
  chapters: YoutubeChapter[];
  worthScore: number;
  worthinessReason: string | null;
  status: 'pending' | 'transcribed' | 'skipped_low_value' | 'skipped_short' | 'failed';
  transcriptionProvider: 'gemini_audio_compressed' | 'apify_transcript' | null;
  titleUk: string | null;
  summaryUk: string | null;
  whyItMattersUk: string | null;
  keyTakeawaysUk: string[];
  timestampedQuotes: YoutubeTimestampedQuote[];
  category: string;
  importance: 'high' | 'medium' | 'low';
  newsItemId: string | null;
  transcribedAt: string | null;
}

export interface YoutubeQuotaStatus {
  dayKey: string;
  usedToday: number;
  limitPerDay: number;
  remainingToday: number;
  apifyUsedToday: number;
  apifyLimitPerDay: number;
  apifyRemainingToday: number;
  apifyConfigured: boolean;
  geminiConfigured: boolean;
}

interface ParsedAiVideoInsight {
  worthKeeping: boolean;
  titleUk: string;
  summaryUk: string;
  whyItMattersUk: string;
  keyTakeawaysUk: string[];
  timestampedQuotes: YoutubeTimestampedQuote[];
  category: NewsCategory;
  importance: 'high' | 'medium';
}

const YOUTUBE_INSIGHT_SCHEMA = {
  type: 'object',
  properties: {
    worthKeeping: { type: 'boolean' },
    titleUk: { type: 'string' },
    summaryUk: { type: 'string' },
    whyItMattersUk: { type: 'string' },
    keyTakeawaysUk: { type: 'array', items: { type: 'string' } },
    timestampedQuotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          timestampSec: { type: 'integer' },
          timestampLabel: { type: 'string' },
          speaker: { type: 'string' },
          insightUk: { type: 'string' },
        },
        required: ['timestampSec', 'timestampLabel', 'speaker', 'insightUk'],
      },
    },
    category: { type: 'string', enum: [...CATEGORIES] },
    importance: { type: 'string', enum: ['high', 'medium'] },
  },
  required: [
    'worthKeeping',
    'titleUk',
    'summaryUk',
    'whyItMattersUk',
    'keyTakeawaysUk',
    'timestampedQuotes',
    'category',
    'importance',
  ],
};

function getUtcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function clampPositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw?.trim());
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function getConfiguredApifyToken(): string {
  return process.env.apify_token?.trim() || process.env.APIFY_TOKEN?.trim() || '';
}

export function formatSecondsLabel(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function extractChaptersFromDescription(description: string): YoutubeChapter[] {
  if (!description) return [];
  const chapters: YoutubeChapter[] = [];
  const seenSec = new Set<number>();
  const lines = description.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(?:[-*•]\s*)?\[?(\d{1,2}:)?(\d{1,2}):(\d{2})\]?\s*[-–—:|]?\s*(.+)$/.exec(line);
    if (!match) continue;
    const hours = match[1] ? Number.parseInt(match[1].replace(':', ''), 10) : 0;
    const mins = Number.parseInt(match[2], 10);
    const secs = Number.parseInt(match[3], 10);
    if (!Number.isFinite(hours) || !Number.isFinite(mins) || !Number.isFinite(secs) || mins >= 60 || secs >= 60) {
      continue;
    }
    const timestampSec = hours * 3600 + mins * 60 + secs;
    const title = match[4].replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!title || seenSec.has(timestampSec)) continue;
    seenSec.add(timestampSec);
    chapters.push({
      timestampSec,
      timestampLabel: formatSecondsLabel(timestampSec),
      title,
    });
  }

  return chapters.sort((a, b) => a.timestampSec - b.timestampSec).slice(0, 40);
}

/**
 * Selects a compact continuous audio/video window (<= maxWindowSec) when chapters exist,
 * skipping intro/sponsor blocks to stay well within free-tier Gemini TPM limits.
 */
export function selectSmartVideoSlice(
  chapters: YoutubeChapter[],
  estimatedDurationSec: number | null,
  maxWindowSec = MAX_VIDEO_SLICE_SEC,
): { startSec: number; endSec: number } | null {
  if (chapters.length >= 2) {
    const firstNonFluff = chapters.find(
      (ch) => !/^(intro|introduction|sponsor|ad\b|преамбула|реклама|вступ)/i.test(ch.title),
    );
    const startSec = firstNonFluff ? firstNonFluff.timestampSec : chapters[0].timestampSec;
    const lastTs = chapters[chapters.length - 1].timestampSec;
    const totalEst = Math.max(estimatedDurationSec ?? 0, lastTs + 240);
    if (totalEst <= startSec + maxWindowSec) {
      return startSec > 15 ? { startSec, endSec: totalEst } : null;
    }
    return { startSec, endSec: startSec + maxWindowSec };
  }
  if (estimatedDurationSec && estimatedDurationSec > maxWindowSec) {
    return { startSec: 0, endSec: maxWindowSec };
  }
  return null;
}

/**
 * Evaluates whether a YouTube RSS item deserves spending transcription quota (max 30/day).
 * Pure deterministic scoring (0 API tokens).
 */
export function evaluateYoutubeVideoWorthiness(
  article: Pick<
    FeedArticle,
    'url' | 'original_title' | 'original_summary' | 'raw_description' | 'published_at' | 'views_count' | 'likes_count' | 'is_youtube_short'
  >,
  channel: Pick<YoutubeChannelDefinition, 'credibilityWeight' | 'priorityTier' | 'category'>,
  nowMs = Date.now(),
): YoutubeWorthinessAssessment {
  const title = (article.original_title || '').trim();
  const rawDesc = (article.raw_description || article.original_summary || '').trim();
  const combined = `${title} ${rawDesc}`;

  const isShort =
    Boolean(article.is_youtube_short) ||
    /\/shorts\//i.test(article.url) ||
    /#shorts\b/i.test(combined);
  if (isShort) {
    return {
      worthy: false,
      worthScore: 0,
      reason: 'Відфільтровано YouTube Shorts',
      isShort: true,
      chapters: [],
      estimatedDurationSec: null,
      preferApifyFallback: false,
    };
  }

  const chapters = extractChaptersFromDescription(rawDesc);
  const estimatedDurationSec =
    chapters.length > 0 ? chapters[chapters.length - 1].timestampSec + 180 : null;

  const lowSignalPattern =
    /\b(giveaway|unboxing|merch\s+drop|stream\s+starting\s+soon|channel\s+update|channel\s+trailer|q\s*&\s*a\s+livestream|live\s+hangout|teaser\s+trailer|official\s+teaser)\b|розіграш|розпаковка|стрім\s+починається/i;
  if (lowSignalPattern.test(title) && chapters.length < 3) {
    return {
      worthy: false,
      worthScore: 22,
      reason: 'Низькосигнальний формат (тизер/розіграш/анонс стріму)',
      isShort: false,
      chapters,
      estimatedDurationSec,
      preferApifyFallback: false,
    };
  }

  let score = Math.round(channel.credibilityWeight * 0.45);
  if (channel.priorityTier === 'high') score += 8;

  if (chapters.length >= 5) score += 14;
  else if (chapters.length >= 2) score += 8;

  if (rawDesc.length >= 300) score += 6;
  else if (rawDesc.length < 60 && chapters.length === 0) score -= 12;

  const linkCount = (rawDesc.match(/https?:\/\/\S+/g) || []).length;
  if (linkCount >= 2) score += 4;

  const views = Math.max(0, Number(article.views_count || 0));
  const likes = Math.max(0, Number(article.likes_count || 0));
  const publishedTs = Date.parse(article.published_at || '');
  const ageHours = Number.isFinite(publishedTs) ? Math.max(1, (nowMs - publishedTs) / 3_600_000) : 24;
  const viewsPerHour = views / ageHours;

  if (views >= 100_000 || viewsPerHour >= 3_500) score += 14;
  else if (views >= 25_000 || viewsPerHour >= 1_000) score += 9;
  else if (views >= 5_000 || viewsPerHour >= 250) score += 5;

  if (views >= 500 && likes / views >= 0.035) score += 5;

  const highSignalTopics =
    /\b(llm|gpt|claude|gemini|deepseek|qwen|llama|agent|reasoning|benchmark|eval|architecture|training|open[- ]weight|cve-\d+|zero-day|exploit|vulnerability|malware|drone|uav|defen[cs]e|ew|unreal|unity|godot|gpu|cpu|rtx|radeon|dlss|fsr|frame[- ]time|performance|review|analysis|deep\s+dive|postmortem|interview|spacex|starship|rocket|startup|funding|дрон|бпла|реб|оборон|аналіз|розбір|тест|інтерв'ю)\b/i;
  if (highSignalTopics.test(combined)) {
    score += 12;
  }

  const clampedScore = Math.max(0, Math.min(100, score));
  const worthy = clampedScore >= DEFAULT_WORTHINESS_THRESHOLD;
  const preferApifyFallback =
    worthy &&
    clampedScore >= 82 &&
    estimatedDurationSec !== null &&
    estimatedDurationSec >= 2_700;

  const reasonParts = [
    `tier=${channel.priorityTier}`,
    `chapters=${chapters.length}`,
    views > 0 ? `views=${views}` : null,
    estimatedDurationSec ? `estMin=${Math.round(estimatedDurationSec / 60)}` : null,
  ].filter(Boolean);

  return {
    worthy,
    worthScore: clampedScore,
    reason: `${worthy ? 'Відібрано' : 'Пропущено'} (score ${clampedScore}/100: ${reasonParts.join(', ')})`,
    isShort: false,
    chapters,
    estimatedDurationSec,
    preferApifyFallback,
  };
}

/**
 * Builds an ultra-compressed audio-first Gemini generateContent payload for a public YouTube URL.
 * Uses MEDIA_RESOLUTION_LOW + fps=0.01 (1 frame / 100s) + smart chapter slicing + compact JSON output.
 */
export function buildCompressedGeminiYoutubeBody(
  videoUrl: string,
  meta: {
    title: string;
    channelName: string;
    description: string;
    chapters: YoutubeChapter[];
    estimatedDurationSec: number | null;
    defaultCategory: NewsCategory;
  },
): Record<string, unknown> {
  const slice = selectSmartVideoSlice(meta.chapters, meta.estimatedDurationSec, MAX_VIDEO_SLICE_SEC);
  const videoMetadata: Record<string, unknown> = {
    fps: MIN_AUDIO_FPS,
  };
  if (slice) {
    videoMetadata.startOffset = { seconds: slice.startSec, nanos: 0 };
    videoMetadata.endOffset = { seconds: slice.endSec, nanos: 0 };
  }

  const chaptersHint = meta.chapters
    .slice(0, 15)
    .map((c) => `${c.timestampLabel} ${c.title}`)
    .join('\n');

  return {
    systemInstruction: {
      parts: [
        {
          text: [
            'Ти аналітик AI News Radar. Прослухай передусім АУДІО-доріжку відео максимально економно.',
            'НЕ переписуй дослівний транскрипт — це марнує вихідні токени.',
            'Витягни українською лише найважливіші факти, цифри, аргументи експертів, назви ігор/моделей/технологій і точні таймкоди.',
            'Якщо відео — чистий клікбейт або порожня вода без нових фактів/думок, постав worthKeeping: false.',
            'Поверни суворий JSON за схемою.',
          ].join('\n'),
        },
      ],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            fileData: {
              mimeType: 'video/mp4',
              fileUri: videoUrl,
            },
            videoMetadata,
          },
          {
            text: [
              `Канал: ${meta.channelName}`,
              `Назва: ${meta.title}`,
              `Категорія за замовчуванням: ${meta.defaultCategory}`,
              chaptersHint ? `Глави з опису:\n${chaptersHint}` : '',
              meta.description ? `Короткий опис:\n${meta.description.slice(0, 900)}` : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
      },
    ],
    generationConfig: {
      mediaResolution: 'MEDIA_RESOLUTION_LOW',
      temperature: 0.2,
      maxOutputTokens: 1400,
      responseMimeType: 'application/json',
      responseJsonSchema: YOUTUBE_INSIGHT_SCHEMA,
    },
  };
}

export function extractApifyTranscriptText(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const first = items[0];
  if (!first || typeof first !== 'object') return '';
  const obj = first as Record<string, unknown>;

  if (typeof obj.transcript === 'string' && obj.transcript.trim()) {
    return obj.transcript.trim();
  }
  if (typeof obj.text === 'string' && obj.text.trim()) {
    return obj.text.trim();
  }
  if (Array.isArray(obj.transcript)) {
    return formatTranscriptSegments(obj.transcript);
  }
  if (Array.isArray(obj.captions)) {
    return formatTranscriptSegments(obj.captions);
  }
  if (Array.isArray(obj.subtitles)) {
    return formatTranscriptSegments(obj.subtitles);
  }
  if (Array.isArray(obj.segments)) {
    return formatTranscriptSegments(obj.segments);
  }
  return '';
}

function formatTranscriptSegments(segments: unknown[]): string {
  const lines: string[] = [];
  let lastBucket = -30;
  for (const seg of segments) {
    if (typeof seg === 'string') {
      const cleaned = seg.replace(/\s+/g, ' ').trim();
      if (cleaned) lines.push(cleaned);
      continue;
    }
    if (!seg || typeof seg !== 'object') continue;
    const rec = seg as Record<string, unknown>;
    const text = String(rec.text ?? rec.utf8 ?? rec.content ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const rawStart = Number(rec.start ?? rec.offset ?? rec.startSec ?? rec.tStartMs);
    if (Number.isFinite(rawStart)) {
      const sec = rec.tStartMs !== undefined ? Math.floor(rawStart / 1000) : Math.floor(rawStart);
      if (sec - lastBucket >= 30) {
        lastBucket = sec;
        lines.push(`[${formatSecondsLabel(sec)}] ${text}`);
      } else {
        lines.push(text);
      }
    } else {
      lines.push(text);
    }
    if (lines.join(' ').length >= MAX_APIFY_TRANSCRIPT_CHARS) break;
  }
  return lines.join(' ').slice(0, MAX_APIFY_TRANSCRIPT_CHARS).trim();
}

function extractGeminiCandidateText(data: unknown): string {
  const candidate = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> })
    ?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  return parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}

function parseAiVideoInsightJson(
  rawText: string,
  fallbackCategory: NewsCategory,
): ParsedAiVideoInsight | null {
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }

  const titleUk = String(parsed.titleUk || '').replace(/\s+/g, ' ').trim().slice(0, 350);
  const summaryUk = String(parsed.summaryUk || '').trim().slice(0, 2500);
  const whyItMattersUk = String(parsed.whyItMattersUk || '').trim().slice(0, 1500);
  if (!titleUk || !summaryUk) return null;

  const keyTakeawaysUk = Array.isArray(parsed.keyTakeawaysUk)
    ? parsed.keyTakeawaysUk
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 4)
        .map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 350))
        .slice(0, 6)
    : [];

  const timestampedQuotes: YoutubeTimestampedQuote[] = Array.isArray(parsed.timestampedQuotes)
    ? parsed.timestampedQuotes
        .filter((q): q is Record<string, unknown> => Boolean(q && typeof q === 'object'))
        .map((q) => {
          const timestampSec = Math.max(0, Math.floor(Number(q.timestampSec) || 0));
          return {
            timestampSec,
            timestampLabel:
              typeof q.timestampLabel === 'string' && q.timestampLabel.trim()
                ? q.timestampLabel.trim().slice(0, 16)
                : formatSecondsLabel(timestampSec),
            speaker: String(q.speaker || 'Експерт').trim().slice(0, 80),
            insightUk: String(q.insightUk || '').replace(/\s+/g, ' ').trim().slice(0, 400),
          };
        })
        .filter((q) => q.insightUk.length > 5)
        .slice(0, 6)
    : [];

  const rawCategory = String(parsed.category || '').trim();
  const category = (CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as NewsCategory)
    : fallbackCategory;

  return {
    worthKeeping: parsed.worthKeeping !== false,
    titleUk,
    summaryUk,
    whyItMattersUk,
    keyTakeawaysUk,
    timestampedQuotes,
    category,
    importance: parsed.importance === 'high' ? 'high' : 'medium',
  };
}

@Injectable()
export class YoutubeRadarService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YoutubeRadarService.name);
  private timer?: NodeJS.Timeout;
  private isDestroyed = false;
  private activeSync?: Promise<{
    channelsPolled: number;
    videosDiscovered: number;
    transcribed: number;
    apifyUsed: number;
    skippedLowValue: number;
    quotaReached: boolean;
  }>;

  private memoryQuota = {
    dayKey: getUtcDayKey(),
    total: 0,
    apify: 0,
  };
  private readonly memoryVideos = new Map<string, YoutubeVideoInsight>();

  constructor(
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly channelDirectory?: YoutubeChannelDiscoveryService,
  ) {}

  onModuleInit(): void {
    if (process.env.YOUTUBE_RADAR_ENABLED === 'false' || process.env.NODE_ENV === 'test') {
      return;
    }

    const intervalMs = Math.max(
      10 * 60_000,
      Number(process.env.YOUTUBE_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
    );

    const scheduleNext = () => {
      this.timer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.syncOnce();
        } catch (err) {
          this.logger.warn(`Scheduled YouTube RSS sync failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.isDestroyed) scheduleNext();
        }
      }, intervalMs);
    };

    // Initial sync 35 seconds after startup to avoid competing with Games/Editorial startup slots
    this.timer = setTimeout(async () => {
      if (this.isDestroyed) return;
      try {
        await this.syncOnce();
      } catch (err) {
        this.logger.warn(`Initial YouTube RSS sync failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        if (!this.isDestroyed) scheduleNext();
      }
    }, 35_000);
  }

  onModuleDestroy(): void {
    this.isDestroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  getChannels(): YoutubeChannelDefinition[] {
    return YOUTUBE_RSS_CHANNELS;
  }

  /** Seed list + channels discovered and verified by YoutubeChannelDiscoveryService. */
  async getActiveChannels(): Promise<YoutubeChannelDefinition[]> {
    return (await this.channelDirectory?.getActiveChannels().catch(() => null)) ?? YOUTUBE_RSS_CHANNELS;
  }

  /** Channels with how many analysed videos each has (for the app's channel directory). */
  async listChannelsWithStats() {
    const channels = await this.getActiveChannels();
    const stats = new Map<string, { analysed: number; lastAt: string | null }>();
    if (this.db) {
      const { rows } = await this.db
        .query<{ channel_id: string; analysed: number; last_at: Date | null }>(
          `SELECT channel_id, COUNT(*) FILTER (WHERE status = 'transcribed')::int AS analysed, MAX(published_at) AS last_at
           FROM youtube_videos GROUP BY channel_id`,
        )
        .catch(() => ({ rows: [] as Array<{ channel_id: string; analysed: number; last_at: Date | null }> }));
      for (const r of rows) stats.set(r.channel_id, { analysed: r.analysed, lastAt: r.last_at ? new Date(r.last_at).toISOString() : null });
    }
    return channels.map((c) => ({
      ...c,
      url: `https://www.youtube.com/channel/${c.channelId}`,
      seed: YOUTUBE_RSS_CHANNELS.some((s) => s.channelId === c.channelId),
      analysedVideos: stats.get(c.channelId)?.analysed ?? 0,
      lastVideoAt: stats.get(c.channelId)?.lastAt ?? null,
    }));
  }

  getMaxDailyTranscriptions(): number {
    return clampPositiveInt(
      process.env.YOUTUBE_MAX_DAILY_TRANSCRIPTIONS,
      DEFAULT_MAX_DAILY_TRANSCRIPTIONS,
      1,
      30,
    );
  }

  getMaxDailyApifyVideos(): number {
    const maxTotal = this.getMaxDailyTranscriptions();
    return Math.min(
      maxTotal,
      clampPositiveInt(process.env.YOUTUBE_MAX_DAILY_APIFY, DEFAULT_MAX_DAILY_APIFY_VIDEOS, 0, 10),
    );
  }

  private syncMemoryQuotaDay(now = Date.now()): void {
    const today = getUtcDayKey(now);
    if (this.memoryQuota.dayKey !== today) {
      this.memoryQuota = { dayKey: today, total: 0, apify: 0 };
    }
  }

  async getQuotaStatus(): Promise<YoutubeQuotaStatus> {
    this.syncMemoryQuotaDay();
    const limitPerDay = this.getMaxDailyTranscriptions();
    const apifyLimitPerDay = this.getMaxDailyApifyVideos();
    const apifyConfigured = Boolean(getConfiguredApifyToken());
    const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());

    let usedToday = this.memoryQuota.total;
    let apifyUsedToday = this.memoryQuota.apify;

    if (this.db) {
      try {
        const res = await this.db.query<{ total: number; apify_count: number }>(`
          SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE transcription_provider = 'apify_transcript')::int AS apify_count
          FROM youtube_videos
          WHERE transcribed_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
        `);
        if (res.rows[0]) {
          usedToday = Math.max(usedToday, Number(res.rows[0].total) || 0);
          apifyUsedToday = Math.max(apifyUsedToday, Number(res.rows[0].apify_count) || 0);
        }
      } catch {
        // Fallback to in-memory counter if migration 015 hasn't run yet
      }
    }

    return {
      dayKey: this.memoryQuota.dayKey,
      usedToday,
      limitPerDay,
      remainingToday: Math.max(0, limitPerDay - usedToday),
      apifyUsedToday,
      apifyLimitPerDay,
      apifyRemainingToday: Math.max(0, apifyLimitPerDay - apifyUsedToday),
      apifyConfigured,
      geminiConfigured,
    };
  }

  async listInsights(options?: {
    limit?: number;
    category?: string;
    status?: string;
    channelId?: string;
    sort?: 'top' | 'latest';
    maxAgeHours?: number;
    importantOnly?: boolean;
    offset?: number;
  }): Promise<{ items: YoutubeVideoInsight[]; quota: YoutubeQuotaStatus }> {
    const limit = Math.max(1, Math.min(50, options?.limit ?? 20));
    const quota = await this.getQuotaStatus();

    if (this.db) {
      try {
        const statusFilter = options?.status?.trim() || 'transcribed';
        const categoryFilter = options?.category?.trim() || null;
        const res = await this.db.query<{
          video_id: string;
          channel_slug: string;
          channel_id: string;
          channel_name: string;
          url: string;
          title: string;
          thumbnail_url: string | null;
          published_at: Date | string;
          views_count: string | number;
          likes_count: string | number;
          estimated_duration_sec: number | null;
          chapters: YoutubeChapter[] | null;
          worth_score: number;
          worthiness_reason: string | null;
          status: YoutubeVideoInsight['status'];
          transcription_provider: YoutubeVideoInsight['transcriptionProvider'];
          title_uk: string | null;
          summary_uk: string | null;
          why_it_matters_uk: string | null;
          key_takeaways_uk: string[] | null;
          timestamped_quotes: YoutubeTimestampedQuote[] | null;
          category: string | null;
          importance: 'high' | 'medium' | 'low';
          news_item_id: string | number | null;
          transcribed_at: Date | string | null;
        }>(
          `SELECT video_id, channel_slug, channel_id, channel_name, url, title, thumbnail_url,
                  published_at, views_count, likes_count, estimated_duration_sec, chapters,
                  worth_score, worthiness_reason, status, transcription_provider,
                  title_uk, summary_uk, why_it_matters_uk, key_takeaways_uk, timestamped_quotes,
                  category, importance, news_item_id::text, transcribed_at
           FROM youtube_videos
           WHERE ($1::text = 'all' OR status = $1)
             AND ($2::text IS NULL OR category = $2)
             AND ($4::text IS NULL OR channel_id = $4)
             AND ($5::int IS NULL OR published_at >= now() - ($5::int * interval '1 hour'))
             AND (NOT $6::boolean OR importance = 'high')
           ORDER BY
             CASE WHEN $7::text = 'latest' THEN published_at END DESC NULLS LAST,
             worth_score DESC, published_at DESC
           LIMIT $3 OFFSET $8`,
          [statusFilter, categoryFilter, limit, options?.channelId || null, options?.maxAgeHours ?? null,
            Boolean(options?.importantOnly), options?.sort === 'latest' ? 'latest' : 'top', options?.offset ?? 0],
        );

        const items: YoutubeVideoInsight[] = res.rows.map((r) => ({
          videoId: r.video_id,
          channelSlug: r.channel_slug,
          channelId: r.channel_id,
          channelName: r.channel_name,
          url: r.url,
          title: r.title,
          thumbnailUrl: r.thumbnail_url,
          publishedAt: new Date(r.published_at).toISOString(),
          viewsCount: Number(r.views_count) || 0,
          likesCount: Number(r.likes_count) || 0,
          estimatedDurationSec: r.estimated_duration_sec,
          chapters: Array.isArray(r.chapters) ? r.chapters : [],
          worthScore: r.worth_score,
          worthinessReason: r.worthiness_reason,
          status: r.status,
          transcriptionProvider: r.transcription_provider,
          titleUk: r.title_uk,
          summaryUk: r.summary_uk,
          whyItMattersUk: r.why_it_matters_uk,
          keyTakeawaysUk: Array.isArray(r.key_takeaways_uk) ? r.key_takeaways_uk : [],
          timestampedQuotes: Array.isArray(r.timestamped_quotes) ? r.timestamped_quotes : [],
          category: r.category || 'other',
          importance: r.importance || 'medium',
          newsItemId: r.news_item_id ? String(r.news_item_id) : null,
          transcribedAt: r.transcribed_at ? new Date(r.transcribed_at).toISOString() : null,
        }));
        return { items, quota };
      } catch {
        // Fallback to in-memory cache if DB table is not migrated yet
      }
    }

    const memItems = [...this.memoryVideos.values()]
      .filter((v) => (!options?.status || options.status === 'all' || v.status === options.status))
      .filter((v) => !options?.category || v.category === options.category)
      .sort((a, b) => b.worthScore - a.worthScore || b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, limit);

    return { items: memItems, quota };
  }

  async syncOnce(options?: {
    maxTranscribe?: number;
    channels?: YoutubeChannelDefinition[];
  }): Promise<{
    channelsPolled: number;
    videosDiscovered: number;
    transcribed: number;
    apifyUsed: number;
    skippedLowValue: number;
    quotaReached: boolean;
  }> {
    if (this.activeSync) return this.activeSync;
    this.activeSync = this.executeSync(options).finally(() => {
      this.activeSync = undefined;
    });
    return this.activeSync;
  }

  private async executeSync(options?: {
    maxTranscribe?: number;
    channels?: YoutubeChannelDefinition[];
  }) {
    const channels = options?.channels ?? (await this.getActiveChannels());
    const maxPerCycle = clampPositiveInt(
      options?.maxTranscribe !== undefined ? String(options.maxTranscribe) : process.env.YOUTUBE_MAX_PER_CYCLE,
      4,
      1,
      10,
    );

    let channelsPolled = 0;
    let videosDiscovered = 0;
    let transcribed = 0;
    let apifyUsed = 0;
    let skippedLowValue = 0;

    const candidates: Array<{
      channel: YoutubeChannelDefinition;
      article: FeedArticle;
      videoId: string;
      assessment: YoutubeWorthinessAssessment;
    }> = [];

    for (const channel of channels) {
      if (this.isDestroyed) break;
      try {
        const feedItems = await fetchAndParseFeedUrl({
          slug: channel.slug,
          name: channel.name,
          domain: 'youtube.com',
          allowedDomains: ['youtube.com', 'm.youtube.com', 'youtu.be'],
          url: buildYoutubeRssUrl(channel.channelId),
          category: channel.category,
          licenseMode: 'summary',
        });
        channelsPolled += 1;
        const latest = feedItems.map((a) => a.published_at).sort().pop() ?? null;
        void this.channelDirectory?.recordPollResult(channel.channelId, true, latest);

        for (const article of feedItems) {
          if (!isPublishedWithinHours(article.published_at, VIDEO_LOOKBACK_HOURS)) continue;
          const videoId = article.video_id || extractYoutubeVideoId(article.url);
          if (!videoId) continue;

          videosDiscovered += 1;
          if (await this.isVideoAlreadyHandled(videoId)) continue;

          const assessment = evaluateYoutubeVideoWorthiness(article, channel);
          if (!assessment.worthy) {
            skippedLowValue += 1;
            await this.persistVideoRecord({
              videoId,
              channelSlug: channel.slug,
              channelId: channel.channelId,
              channelName: channel.name,
              url: article.url,
              title: article.original_title,
              thumbnailUrl: article.thumbnail_url ?? null,
              publishedAt: article.published_at,
              viewsCount: article.views_count ?? 0,
              likesCount: article.likes_count ?? 0,
              estimatedDurationSec: assessment.estimatedDurationSec,
              chapters: assessment.chapters,
              worthScore: assessment.worthScore,
              worthinessReason: assessment.reason,
              status: assessment.isShort ? 'skipped_short' : 'skipped_low_value',
              transcriptionProvider: null,
              titleUk: null,
              summaryUk: null,
              whyItMattersUk: null,
              keyTakeawaysUk: [],
              timestampedQuotes: [],
              category: channel.category,
              importance: 'low',
              newsItemId: null,
              transcribedAt: null,
              description: article.raw_description || article.original_summary,
            });
            continue;
          }

          candidates.push({ channel, article, videoId, assessment });
        }
      } catch (error) {
        this.logger.warn(
          `YouTube RSS poll failed for ${channel.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        void this.channelDirectory?.recordPollResult(channel.channelId, false);
      }
    }

    // Highest worthiness + freshest videos first so the 30/day quota only goes to the strongest content
    candidates.sort((a, b) => {
      if (b.assessment.worthScore !== a.assessment.worthScore) {
        return b.assessment.worthScore - a.assessment.worthScore;
      }
      return Date.parse(b.article.published_at) - Date.parse(a.article.published_at);
    });

    let quota = await this.getQuotaStatus();
    if (quota.remainingToday <= 0) {
      return {
        channelsPolled,
        videosDiscovered,
        transcribed,
        apifyUsed,
        skippedLowValue,
        quotaReached: true,
      };
    }

    for (const candidate of candidates) {
      if (this.isDestroyed) break;
      if (transcribed >= maxPerCycle || quota.remainingToday <= 0) break;

      const outcome = await this.processWorthyVideo(
        candidate.channel,
        candidate.article,
        candidate.videoId,
        candidate.assessment,
        quota,
      );

      if (outcome.countedTowardQuota) {
        transcribed += 1;
        this.syncMemoryQuotaDay();
        this.memoryQuota.total += 1;
        if (outcome.usedApify) {
          apifyUsed += 1;
          this.memoryQuota.apify += 1;
        }
        quota = await this.getQuotaStatus();
      } else if (outcome.skippedByAi) {
        skippedLowValue += 1;
      }
    }

    return {
      channelsPolled,
      videosDiscovered,
      transcribed,
      apifyUsed,
      skippedLowValue,
      quotaReached: quota.remainingToday <= 0,
    };
  }

  private async isVideoAlreadyHandled(videoId: string): Promise<boolean> {
    if (this.memoryVideos.has(videoId)) return true;
    if (!this.db) return false;
    try {
      const res = await this.db.query<{ status: string }>(
        `SELECT status FROM youtube_videos WHERE video_id = $1 LIMIT 1`,
        [videoId],
      );
      return Boolean(res.rows[0] && res.rows[0].status !== 'pending');
    } catch {
      return false;
    }
  }

  private async processWorthyVideo(
    channel: YoutubeChannelDefinition,
    article: FeedArticle,
    videoId: string,
    assessment: YoutubeWorthinessAssessment,
    quota: YoutubeQuotaStatus,
  ): Promise<{ countedTowardQuota: boolean; usedApify: boolean; skippedByAi: boolean }> {
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    const apifyToken = getConfiguredApifyToken();

    let insight: ParsedAiVideoInsight | null = null;
    let provider: 'gemini_audio_compressed' | 'apify_transcript' | null = null;
    let usedApify = false;

    const shouldTryApifyFirst =
      assessment.preferApifyFallback && Boolean(apifyToken) && quota.apifyRemainingToday > 0;

    if (!shouldTryApifyFirst && geminiKey) {
      insight = await this.transcribeAndAnalyzeWithGeminiAudio(geminiKey, channel, article, assessment);
      if (insight) provider = 'gemini_audio_compressed';
    }

    if (!insight && apifyToken && quota.apifyRemainingToday > 0) {
      const transcript = await this.fetchTranscriptWithApify(article.url, channel.language, apifyToken);
      if (transcript) {
        usedApify = true;
        insight = await this.summarizeTranscriptTextWithGemini(
          geminiKey,
          channel,
          article,
          assessment,
          transcript,
        );
        if (insight) provider = 'apify_transcript';
      }
    }

    // If Apify was tried first for a long talk and failed/empty, try compressed Gemini slice as backup
    if (!insight && shouldTryApifyFirst && geminiKey) {
      insight = await this.transcribeAndAnalyzeWithGeminiAudio(geminiKey, channel, article, assessment);
      if (insight) provider = 'gemini_audio_compressed';
    }

    if (!insight || !provider) {
      await this.persistVideoRecord({
        videoId,
        channelSlug: channel.slug,
        channelId: channel.channelId,
        channelName: channel.name,
        url: article.url,
        title: article.original_title,
        thumbnailUrl: article.thumbnail_url ?? null,
        publishedAt: article.published_at,
        viewsCount: article.views_count ?? 0,
        likesCount: article.likes_count ?? 0,
        estimatedDurationSec: assessment.estimatedDurationSec,
        chapters: assessment.chapters,
        worthScore: assessment.worthScore,
        worthinessReason: `${assessment.reason} [transcription unavailable]`,
        status: 'failed',
        transcriptionProvider: usedApify ? 'apify_transcript' : null,
        titleUk: null,
        summaryUk: null,
        whyItMattersUk: null,
        keyTakeawaysUk: [],
        timestampedQuotes: [],
        category: channel.category,
        importance: 'low',
        newsItemId: null,
        transcribedAt: null,
        description: article.raw_description || article.original_summary,
      });
      return { countedTowardQuota: false, usedApify, skippedByAi: false };
    }

    const nowIso = new Date().toISOString();
    if (!insight.worthKeeping) {
      await this.persistVideoRecord({
        videoId,
        channelSlug: channel.slug,
        channelId: channel.channelId,
        channelName: channel.name,
        url: article.url,
        title: article.original_title,
        thumbnailUrl: article.thumbnail_url ?? null,
        publishedAt: article.published_at,
        viewsCount: article.views_count ?? 0,
        likesCount: article.likes_count ?? 0,
        estimatedDurationSec: assessment.estimatedDurationSec,
        chapters: assessment.chapters,
        worthScore: assessment.worthScore,
        worthinessReason: `${assessment.reason} -> Gemini vetoed as low-value`,
        status: 'skipped_low_value',
        transcriptionProvider: provider,
        titleUk: insight.titleUk,
        summaryUk: insight.summaryUk,
        whyItMattersUk: insight.whyItMattersUk,
        keyTakeawaysUk: insight.keyTakeawaysUk,
        timestampedQuotes: insight.timestampedQuotes,
        category: insight.category,
        importance: 'low',
        newsItemId: null,
        transcribedAt: nowIso,
        description: article.raw_description || article.original_summary,
      });
      return { countedTowardQuota: true, usedApify, skippedByAi: true };
    }

    const newsItemId = await this.publishInsightToNews(
      channel,
      article,
      videoId,
      assessment,
      insight,
      provider,
    );

    await this.persistVideoRecord({
      videoId,
      channelSlug: channel.slug,
      channelId: channel.channelId,
      channelName: channel.name,
      url: article.url,
      title: article.original_title,
      thumbnailUrl: article.thumbnail_url ?? null,
      publishedAt: article.published_at,
      viewsCount: article.views_count ?? 0,
      likesCount: article.likes_count ?? 0,
      estimatedDurationSec: assessment.estimatedDurationSec,
      chapters: assessment.chapters,
      worthScore: assessment.worthScore,
      worthinessReason: assessment.reason,
      status: 'transcribed',
      transcriptionProvider: provider,
      titleUk: insight.titleUk,
      summaryUk: insight.summaryUk,
      whyItMattersUk: insight.whyItMattersUk,
      keyTakeawaysUk: insight.keyTakeawaysUk,
      timestampedQuotes: insight.timestampedQuotes,
      category: insight.category,
      importance: insight.importance,
      newsItemId,
      transcribedAt: nowIso,
      description: article.raw_description || article.original_summary,
    });

    return { countedTowardQuota: true, usedApify, skippedByAi: false };
  }

  private async transcribeAndAnalyzeWithGeminiAudio(
    apiKey: string,
    channel: YoutubeChannelDefinition,
    article: FeedArticle,
    assessment: YoutubeWorthinessAssessment,
  ): Promise<ParsedAiVideoInsight | null> {
    const envModel = process.env.GEMINI_MODEL?.trim();
    const candidates = Array.from(
      new Set(
        [
          envModel && !isHydrogenModel(envModel) ? envModel : null,
          'gemini-2.5-flash',
          'gemini-2.0-flash',
          !isHydrogenModel(DEFAULT_GEMINI_MODEL) ? DEFAULT_GEMINI_MODEL : null,
          'gemini-3.8-flash',
          'gemini-3.6-flash',
          'gemini-3-flash',
        ].filter((m): m is string => Boolean(m)),
      ),
    );

    const body = buildCompressedGeminiYoutubeBody(article.url, {
      title: article.original_title,
      channelName: channel.name,
      description: article.raw_description || article.original_summary,
      chapters: assessment.chapters,
      estimatedDurationSec: assessment.estimatedDurationSec,
      defaultCategory: channel.category,
    });

    try {
      const { data } = await postGeminiGenerateContent({
        apiKey,
        preferredModel: candidates[0],
        candidateModels: candidates,
        timeoutMs: 60_000,
        body,
      });
      return parseAiVideoInsightJson(extractGeminiCandidateText(data), channel.category);
    } catch (error) {
      this.logger.warn(
        `Gemini compressed audio transcription failed for ${article.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async fetchTranscriptWithApify(
    videoUrl: string,
    language: string,
    token: string,
  ): Promise<string | null> {
    const actor = process.env.APIFY_YOUTUBE_ACTOR?.trim() || DEFAULT_APIFY_YOUTUBE_ACTOR;
    const endpoint = `https://api.apify.com/v2/actors/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=45&memory=256`;

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(50_000),
        body: JSON.stringify({
          video_urls: [videoUrl],
          language: language === 'uk' ? 'uk' : 'en',
        }),
      });
      if (!resp.ok) {
        this.logger.warn(`Apify transcript actor HTTP ${resp.status} for ${videoUrl}`);
        return null;
      }
      const payload = (await resp.json()) as unknown;
      const text = extractApifyTranscriptText(payload);
      return text.length >= 60 ? text : null;
    } catch (error) {
      this.logger.warn(
        `Apify transcript request failed for ${videoUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async summarizeTranscriptTextWithGemini(
    apiKey: string | undefined,
    channel: YoutubeChannelDefinition,
    article: FeedArticle,
    assessment: YoutubeWorthinessAssessment,
    transcriptText: string,
  ): Promise<ParsedAiVideoInsight | null> {
    if (!apiKey) return null;
    const preferredModel = canUseHydrogenQuota() ? DEFAULT_HYDROGEN_MODEL : DEFAULT_GEMINI_MODEL;

    try {
      const { data } = await postGeminiGenerateContent({
        apiKey,
        preferredModel,
        jsonSchemaWhenNoTools: YOUTUBE_INSIGHT_SCHEMA,
        timeoutMs: 40_000,
        body: {
          systemInstruction: {
            parts: [
              {
                text: [
                  'Ти аналітик AI News Radar. Проаналізуй очищений транскрипт YouTube-відео.',
                  'Стисло витягни українською найважливіші факти, цифри, позиції експертів і таймкоди.',
                  'Якщо в тексті лише клікбейт або реклама без цінної суті — постав worthKeeping: false.',
                  'Поверни суворий JSON.',
                ].join('\n'),
              },
            ],
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: JSON.stringify({
                    channel: channel.name,
                    title: article.original_title,
                    url: article.url,
                    defaultCategory: channel.category,
                    chapters: assessment.chapters.slice(0, 12),
                    transcriptExcerpt: transcriptText.slice(0, MAX_APIFY_TRANSCRIPT_CHARS),
                  }),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1400,
            responseMimeType: 'application/json',
            responseJsonSchema: YOUTUBE_INSIGHT_SCHEMA,
          },
        },
      });
      return parseAiVideoInsightJson(extractGeminiCandidateText(data), channel.category);
    } catch (error) {
      this.logger.warn(
        `Gemini text summary for Apify transcript failed (${article.url}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Attaches an analysed video to the written story it is about (same cluster), so the app and the story
   * briefing can show "what was said on video" as a sub-item instead of a separate, disconnected card.
   */
  private async linkVideoToStory(
    newsItemId: string,
    videoId: string,
    video: {
      text: string; url: string; canonical: string; channelName: string; channelSlug: string;
      title: string; titleUk: string; summary: string; publishedAt: string;
    },
  ): Promise<string | null> {
    if (!this.db) return null;
    const { rows } = await this.db.query<{
      id: string; url: string; cluster_id: string | null; original_title: string; title_uk: string | null;
      cluster_sources: ClusterSource[] | null;
    }>(
      `SELECT id::text, url, cluster_id, original_title, title_uk, cluster_sources
       FROM news_items
       WHERE status = 'published' AND id <> $1::bigint
         AND published_at >= now() - interval '72 hours'
         AND COALESCE(ai_metadata->>'source_type', '') <> 'youtube_video'
       ORDER BY jsonb_array_length(COALESCE(cluster_sources, '[]'::jsonb)) DESC, published_at DESC
       LIMIT 300`,
      [newsItemId],
    );
    const match = rows.find((r) => videoMatchesStory(`${r.original_title} ${r.title_uk || ''}`, video.text));
    if (!match) return null;

    const clusterId = match.cluster_id || buildStableClusterId([match.url, video.url]);
    const videoSource: ClusterSource = {
      id: `yt-${videoId}`,
      title: video.title,
      titleUk: video.titleUk,
      url: video.url,
      canonicalUrl: video.canonical,
      sourceName: `${video.channelName} (YouTube)`,
      sourceSlug: video.channelSlug,
      publishedAt: video.publishedAt,
      licenseMode: 'summary',
      summary: video.summary.slice(0, 500),
    };
    const existing = (match.cluster_sources || []).filter((s) => s.url !== video.url);
    const merged = [...existing, videoSource].slice(0, 16);

    await this.db.query(
      `UPDATE news_items SET cluster_id = $1, cluster_sources = $2::jsonb, updated_at = now() WHERE id = $3::bigint`,
      [clusterId, JSON.stringify(merged), match.id],
    );
    await this.db.query(
      `UPDATE news_items SET cluster_id = $1, cluster_sources = $2::jsonb WHERE id = $3::bigint`,
      [clusterId, JSON.stringify(merged), newsItemId],
    );
    await this.db.query(`UPDATE youtube_videos SET cluster_id = $1 WHERE video_id = $2`, [clusterId, videoId]).catch(() => undefined);
    return clusterId;
  }

  private async publishInsightToNews(
    channel: YoutubeChannelDefinition,
    article: FeedArticle,
    videoId: string,
    assessment: YoutubeWorthinessAssessment,
    insight: ParsedAiVideoInsight,
    provider: 'gemini_audio_compressed' | 'apify_transcript',
  ): Promise<string | null> {
    if (!this.db) return null;

    const takeawaysBlock =
      insight.keyTakeawaysUk.length > 0
        ? `\n\nКлючові тези відео:\n${insight.keyTakeawaysUk.map((t) => `• ${t}`).join('\n')}`
        : '';
    const quotesBlock =
      insight.timestampedQuotes.length > 0
        ? `\n\nТаймкоди головних думок:\n${insight.timestampedQuotes
            .map((q) => `• [${q.timestampLabel}] ${q.speaker}: ${q.insightUk}`)
            .join('\n')}`
        : '';
    const bodyText = `${insight.summaryUk}${takeawaysBlock}${quotesBlock}`.trim();

    const canonical = canonicalizeUrl(article.url);
    const externalId = `yt-${videoId}`;
    const aiMetadata = {
      source_type: 'youtube_video',
      video_id: videoId,
      channel_id: channel.channelId,
      thumbnail_url: article.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      views_count: article.views_count ?? 0,
      likes_count: article.likes_count ?? 0,
      worth_score: assessment.worthScore,
      transcription_provider: provider,
      key_takeaways_uk: insight.keyTakeawaysUk,
      timestamped_quotes: insight.timestampedQuotes,
      article: {
        title: insight.titleUk,
        summary: insight.summaryUk,
        body: bodyText,
        important: insight.importance === 'high',
        importance_reason: assessment.reason,
        sources: [{ title: `${channel.name}: ${article.original_title}`, url: article.url }],
        facts: insight.keyTakeawaysUk.map((claim) => ({
          claim,
          status: 'confirmed',
          url: article.url,
        })),
        confidence: 'medium',
        category: insight.category,
      },
    };
    const contentHash = createHash('sha256')
      .update(JSON.stringify([article.url, insight.titleUk, insight.summaryUk, provider]))
      .digest('hex');

    try {
      const srcRes = await this.db.query<{ id: string }>(
        `INSERT INTO sources(slug, name, homepage_url, feed_url, unofficial)
         VALUES ($1, $2, $3, $4, false)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, feed_url = EXCLUDED.feed_url, updated_at = now()
         RETURNING id::text`,
        [
          channel.slug,
          channel.name,
          `https://www.youtube.com/channel/${channel.channelId}`,
          buildYoutubeRssUrl(channel.channelId),
        ],
      );
      const sourceId = srcRes.rows[0]?.id;
      if (!sourceId) return null;

      const newsRes = await this.db.query<{ id: string }>(
        `INSERT INTO news_items(
           source_id, external_id, url, canonical_url, original_title, original_summary,
           title_uk, summary_uk, why_it_matters, category, importance, free_access,
           published_at, ai_metadata, content_hash, status, ai_generated
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'yes',$12,$13::jsonb,$14,'published',true)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           title_uk = EXCLUDED.title_uk,
           summary_uk = EXCLUDED.summary_uk,
           why_it_matters = EXCLUDED.why_it_matters,
           category = EXCLUDED.category,
           importance = EXCLUDED.importance,
           ai_metadata = EXCLUDED.ai_metadata,
           content_hash = EXCLUDED.content_hash,
           status = 'published',
           ai_generated = true,
           updated_at = now()
         RETURNING id::text`,
        [
          sourceId,
          externalId,
          article.url,
          canonical,
          article.original_title,
          article.original_summary || null,
          insight.titleUk,
          insight.summaryUk,
          insight.whyItMattersUk,
          insight.category,
          insight.importance,
          article.published_at,
          JSON.stringify(aiMetadata),
          contentHash,
        ],
      );
      const newsItemId = newsRes.rows[0]?.id ? String(newsRes.rows[0].id) : null;
      if (newsItemId) {
        await this.linkVideoToStory(newsItemId, videoId, {
          text: `${article.original_title} ${insight.titleUk} ${insight.keyTakeawaysUk.join(' ')}`,
          url: article.url,
          canonical,
          channelName: channel.name,
          channelSlug: channel.slug,
          title: article.original_title,
          titleUk: insight.titleUk,
          summary: insight.summaryUk,
          publishedAt: article.published_at,
        }).catch((err) =>
          this.logger.debug(`Video ${videoId} not linked to a story: ${err instanceof Error ? err.message : err}`),
        );
      }
      return newsItemId;
    } catch (error) {
      this.logger.warn(
        `Failed publishing YouTube insight ${videoId} to news_items: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async persistVideoRecord(
    record: YoutubeVideoInsight & { description?: string },
  ): Promise<void> {
    const { description, ...insight } = record;
    this.memoryVideos.set(insight.videoId, insight);
    if (this.memoryVideos.size > 300) {
      const oldest = this.memoryVideos.keys().next().value;
      if (oldest) this.memoryVideos.delete(oldest);
    }

    if (!this.db) return;
    try {
      await this.db.query(
        `INSERT INTO youtube_videos(
           video_id, channel_slug, channel_id, channel_name, url, title, description,
           thumbnail_url, published_at, views_count, likes_count, estimated_duration_sec,
           chapters, worth_score, worthiness_reason, status, transcription_provider,
           title_uk, summary_uk, why_it_matters_uk, key_takeaways_uk, timestamped_quotes,
           category, importance, news_item_id, transcribed_at, updated_at
         )
         VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,
           $18,$19,$20,$21::jsonb,$22::jsonb,$23,$24,$25,$26,now()
         )
         ON CONFLICT (video_id) DO UPDATE SET
           views_count = GREATEST(youtube_videos.views_count, EXCLUDED.views_count),
           likes_count = GREATEST(youtube_videos.likes_count, EXCLUDED.likes_count),
           worth_score = EXCLUDED.worth_score,
           worthiness_reason = EXCLUDED.worthiness_reason,
           status = EXCLUDED.status,
           transcription_provider = COALESCE(EXCLUDED.transcription_provider, youtube_videos.transcription_provider),
           title_uk = COALESCE(EXCLUDED.title_uk, youtube_videos.title_uk),
           summary_uk = COALESCE(EXCLUDED.summary_uk, youtube_videos.summary_uk),
           why_it_matters_uk = COALESCE(EXCLUDED.why_it_matters_uk, youtube_videos.why_it_matters_uk),
           key_takeaways_uk = CASE WHEN jsonb_array_length(EXCLUDED.key_takeaways_uk) > 0 THEN EXCLUDED.key_takeaways_uk ELSE youtube_videos.key_takeaways_uk END,
           timestamped_quotes = CASE WHEN jsonb_array_length(EXCLUDED.timestamped_quotes) > 0 THEN EXCLUDED.timestamped_quotes ELSE youtube_videos.timestamped_quotes END,
           category = COALESCE(EXCLUDED.category, youtube_videos.category),
           importance = EXCLUDED.importance,
           news_item_id = COALESCE(EXCLUDED.news_item_id, youtube_videos.news_item_id),
           transcribed_at = COALESCE(EXCLUDED.transcribed_at, youtube_videos.transcribed_at),
           updated_at = now()`,
        [
          insight.videoId,
          insight.channelSlug,
          insight.channelId,
          insight.channelName,
          insight.url,
          insight.title,
          (description || '').slice(0, 6000) || null,
          insight.thumbnailUrl,
          insight.publishedAt,
          insight.viewsCount,
          insight.likesCount,
          insight.estimatedDurationSec,
          JSON.stringify(insight.chapters),
          insight.worthScore,
          insight.worthinessReason,
          insight.status,
          insight.transcriptionProvider,
          insight.titleUk,
          insight.summaryUk,
          insight.whyItMattersUk,
          JSON.stringify(insight.keyTakeawaysUk),
          JSON.stringify(insight.timestampedQuotes),
          insight.category,
          insight.importance,
          insight.newsItemId,
          insight.transcribedAt,
        ],
      );
    } catch {
      // Graceful fallback if migration 015 has not been applied yet
    }
  }
}
