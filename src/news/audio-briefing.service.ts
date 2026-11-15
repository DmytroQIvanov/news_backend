import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { postGeminiGenerateContent } from '../common/gemini-client';
import { R2Storage, readEnv } from '../common/r2-storage';
import { getWorkersAiConfig } from '../common/workers-ai';
import { DatabaseService } from '../database/database.service';
import {
  buildBroadcastScriptUk,
  estimateBriefingDurationSec,
  NewsAudioStyle,
  NewsDepth,
  pcm16ToWavBase64,
  PREFERRED_TTS_MODELS,
  resolveNewsBriefMode,
  stripTtsPromptDirectives,
} from './news-tts.service';

/**
 * Pre-generated audio briefings stored in Cloudflare R2.
 *
 * - A priority queue renders important / top stories ahead of time, in every app language.
 * - Total stored audio is capped (TTS_STORAGE_MAX_BYTES, default 1 GB); least recently played files are evicted.
 * - Voices are tried in order (Gemini TTS → Cloudflare Workers AI → Google Cloud TTS); a provider that
 *   fails or rate-limits is skipped for a few minutes (circuit breaker) so one slow network never blocks.
 * - The API never makes the phone wait: if audio is not ready it returns the script immediately
 *   (the app speaks it with the on-device voice) and moves the item to the front of the queue.
 */

export type AudioLang = 'en' | 'uk' | string;
export type TtsProvider = 'gemini' | 'groq_tts' | 'workers_ai' | 'google_tts';

export interface AudioJob {
  newsId: string;
  lang: AudioLang;
  depth: NewsDepth;
  style: NewsAudioStyle;
  priority: number;
  requestedAt: number;
}

export interface ReadyAudio {
  status: 'ready';
  newsId: string;
  lang: string;
  url: string;
  mimeType: string;
  provider: TtsProvider;
  model: string;
  durationSec: number;
  script: string;
  bytes: number;
}

export interface QueuedAudio {
  status: 'queued';
  newsId: string;
  lang: string;
  position: number;
  etaSec: number;
  script: string;
  durationSec: number;
}

interface ArticleRow {
  id: string;
  title_uk: string | null;
  original_title: string;
  summary_uk: string | null;
  original_summary: string | null;
  why_it_matters: string | null;
  source_name: string | null;
  article: Record<string, unknown> | null;
  briefing_script: string | null;
  importance: string | null;
  important: boolean;
  source_count: number;
  published_at: Date | null;
}

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const PROVIDER_COOLDOWN_MS = 10 * 60_000;
const GEMINI_FOREGROUND_TIMEOUT_MS = 25_000;
const MAX_QUEUE = 300;

export function audioCacheKey(newsId: string, lang: string, depth: string, style: string, voice: string): string {
  return createHash('sha256').update(`v5|${newsId}|${lang}|${depth}|${style}|${voice}`).digest('hex').slice(0, 24);
}

export function getAudioLangs(): string[] {
  const raw = readEnv('AUDIO_LANGS') || 'en,uk';
  return [...new Set(raw.split(',').map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2}$/.test(l)))];
}

/** Priority: important + multi-source + fresh first (higher = sooner). */
export function audioPriority(row: Pick<ArticleRow, 'important' | 'importance' | 'source_count' | 'published_at'>, now = Date.now()): number {
  const ageH = row.published_at ? Math.max(0, (now - new Date(row.published_at).getTime()) / 3_600_000) : 24;
  return (row.important || row.importance === 'high' ? 50 : 0) + Math.min(5, row.source_count || 1) * 6 + Math.max(0, 24 - ageH);
}

/** Simple LRU eviction plan: oldest-played objects until the total fits under 90% of the cap. */
export function planEviction(objects: Array<{ key: string; bytes: number; lastAccess: number }>, maxBytes: number): string[] {
  let total = objects.reduce((sum, o) => sum + o.bytes, 0);
  if (total <= maxBytes) return [];
  const target = maxBytes * 0.9;
  const out: string[] = [];
  for (const o of [...objects].sort((a, b) => a.lastAccess - b.lastAccess)) {
    if (total <= target) break;
    out.push(o.key);
    total -= o.bytes;
  }
  return out;
}

function pickText(article: Record<string, unknown> | null, key: string): string | null {
  const v = article?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Script in the requested language: English is canonical, Ukrainian comes from the editorial translation. */
export function buildScript(row: ArticleRow, lang: string, depth: NewsDepth, style: NewsAudioStyle): string {
  const canonicalEn = pickText(row.article, 'canonical_lang') === 'en';
  if (lang === 'uk') {
    return stripTtsPromptDirectives(
      buildBroadcastScriptUk(
        {
          titleUk: pickText(row.article, 'title_uk') || row.title_uk,
          originalTitle: row.original_title,
          summaryUk: pickText(row.article, 'summary_uk') || row.summary_uk,
          originalSummary: row.original_summary,
          whyItMatters: pickText(row.article, 'why_it_matters_uk') || row.why_it_matters,
          briefingScript: pickText(row.article, 'briefing_script_uk') || (canonicalEn ? null : row.briefing_script),
          sourceName: row.source_name,
        },
        { depth, style },
      ),
    );
  }
  // English (and fallback for other languages until translations exist)
  const title = (canonicalEn ? pickText(row.article, 'title') : pickText(row.article, 'title_en')) || row.original_title;
  const summary = (canonicalEn ? pickText(row.article, 'summary') : pickText(row.article, 'summary_en')) || row.original_summary || '';
  const scripted = canonicalEn ? row.briefing_script : null;
  const why = pickText(row.article, canonicalEn ? 'importance_reason' : 'why_it_matters_en');
  const raw = scripted || [title, summary, style === 'headline_flash' ? '' : why || ''].filter(Boolean).join(' ');
  return stripTtsPromptDirectives(raw.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 2400);
}

@Injectable()
export class AudioBriefingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudioBriefingService.name);
  private readonly storage = new R2Storage();
  private readonly queue: AudioJob[] = [];
  private readonly providerCooldown = new Map<TtsProvider, number>();
  private readonly avgRenderMs = new Map<TtsProvider, number>();
  private working = false;
  private timer?: NodeJS.Timeout;
  private destroyed = false;

  constructor(@Optional() private readonly db?: DatabaseService) {}

  get enabled(): boolean {
    return this.storage.configured && Boolean(this.db) && process.env.AUDIO_PREGENERATE !== 'false';
  }

  private get maxBytes(): number {
    const n = Number(readEnv('TTS_STORAGE_MAX_BYTES'));
    return Number.isFinite(n) && n > 10 * 1024 * 1024 ? n : DEFAULT_MAX_BYTES;
  }

  private get voice(): string {
    return readEnv('TTS_VOICE') || 'Kore';
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.enabled) return;
    const scan = (delay: number) => {
      this.timer = setTimeout(async () => {
        if (this.destroyed) return;
        try {
          await this.scanAndEnqueue();
        } catch (err) {
          this.logger.warn(`Audio scan failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.destroyed) scan(Math.max(60_000, Number(readEnv('AUDIO_SCAN_INTERVAL_MS')) || 4 * 60_000));
        }
      }, delay);
    };
    scan(30_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  // ---------------------------------------------------------------- queue

  private enqueue(job: AudioJob): number {
    const idx = this.queue.findIndex((j) => j.newsId === job.newsId && j.lang === job.lang && j.depth === job.depth && j.style === job.style);
    if (idx >= 0) {
      this.queue[idx].priority = Math.max(this.queue[idx].priority, job.priority);
    } else {
      this.queue.push(job);
    }
    this.queue.sort((a, b) => b.priority - a.priority || a.requestedAt - b.requestedAt);
    if (this.queue.length > MAX_QUEUE) this.queue.length = MAX_QUEUE;
    void this.work();
    return this.queue.findIndex((j) => j.newsId === job.newsId && j.lang === job.lang) + 1;
  }

  private async work(): Promise<void> {
    if (this.working || this.destroyed) return;
    this.working = true;
    try {
      while (this.queue.length && !this.destroyed) {
        const job = this.queue.shift()!;
        await this.render(job).catch((err) =>
          this.logger.warn(`Audio ${job.newsId}/${job.lang} failed: ${err instanceof Error ? err.message : err}`),
        );
      }
    } finally {
      this.working = false;
    }
  }

  /** Important / top stories of the last 36 h, every configured language, in priority order. */
  async scanAndEnqueue(limit = 12): Promise<number> {
    if (!this.db) return 0;
    const { depth, style } = resolveNewsBriefMode(undefined);
    const { rows } = await this.db.query<ArticleRow>(this.articleSql(`
         WHERE n.status = 'published'
           AND (COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) OR n.importance = 'high'
                OR jsonb_array_length(COALESCE(n.cluster_sources, '[]'::jsonb)) >= 3)
           AND COALESCE(n.published_at, n.created_at) >= now() - interval '36 hours'
         ORDER BY n.published_at DESC NULLS LAST
         LIMIT 60`));
    const ranked = rows.sort((a, b) => audioPriority(b) - audioPriority(a)).slice(0, limit);
    let added = 0;
    for (const row of ranked) {
      for (const lang of getAudioLangs()) {
        if (await this.findReady(row.id, lang, depth, style)) continue;
        this.enqueue({ newsId: row.id, lang, depth, style, priority: audioPriority(row) - (lang === 'en' ? 0 : 1), requestedAt: Date.now() });
        added += 1;
      }
    }
    return added;
  }

  private articleSql(where: string): string {
    return `SELECT n.id::text, n.title_uk, n.original_title, n.summary_uk, n.original_summary, n.why_it_matters,
                   s.name AS source_name, n.ai_metadata->'article' AS article,
                   COALESCE(n.ai_metadata->>'briefing_script', n.ai_metadata->'article'->>'briefing_script') AS briefing_script,
                   n.importance,
                   COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
                   GREATEST(1, jsonb_array_length(COALESCE(n.cluster_sources, '[]'::jsonb)))::int AS source_count,
                   n.published_at
            FROM news_items n JOIN sources s ON s.id = n.source_id ${where}`;
  }

  private async loadArticle(newsId: string): Promise<ArticleRow | null> {
    if (!this.db) return null;
    const { rows } = await this.db.query<ArticleRow>(this.articleSql(`WHERE (n.id::text = $1 OR n.external_id = $1) AND n.status = 'published' LIMIT 1`), [newsId]);
    return rows[0] ?? null;
  }

  private async findReady(newsId: string, lang: string, depth: string, style: string) {
    if (!this.db) return null;
    const key = audioCacheKey(newsId, lang, depth, style, this.voice);
    const { rows } = await this.db
      .query<{ object_key: string; mime_type: string; provider: TtsProvider; model: string; duration_sec: number; script: string; bytes: number }>(
        `SELECT object_key, mime_type, provider, model, duration_sec, script, bytes FROM audio_briefings WHERE cache_key = $1`,
        [key],
      )
      .catch(() => ({ rows: [] as Array<{ object_key: string; mime_type: string; provider: TtsProvider; model: string; duration_sec: number; script: string; bytes: number }> }));
    return rows[0] ? { ...rows[0], cacheKey: key } : null;
  }

  // ---------------------------------------------------------------- public API

  /** Never blocks on generation: returns a ready URL or the script + queue position. */
  async getAudio(newsId: string, lang: string, options: { depth?: string; style?: string }, apiBase: string): Promise<ReadyAudio | QueuedAudio | null> {
    const { depth, style } = resolveNewsBriefMode(options);
    const ready = await this.findReady(newsId, lang, depth, style);
    if (ready) {
      void this.db?.query(`UPDATE audio_briefings SET last_access_at = now(), plays = plays + 1 WHERE cache_key = $1`, [ready.cacheKey]).catch(() => undefined);
      return {
        status: 'ready',
        newsId,
        lang,
        url: this.storage.publicUrl(ready.object_key, apiBase),
        mimeType: ready.mime_type,
        provider: ready.provider,
        model: ready.model,
        durationSec: ready.duration_sec,
        script: ready.script,
        bytes: Number(ready.bytes),
      };
    }
    const row = await this.loadArticle(newsId);
    if (!row) return null;
    const script = buildScript(row, lang, depth, style);
    let position = 0;
    if (this.enabled) {
      // User is waiting: jump the queue.
      position = this.enqueue({ newsId: row.id, lang, depth, style, priority: 1000, requestedAt: Date.now() });
    }
    const perItem = Math.round((this.avgRenderMs.get('gemini') ?? 12_000) / 1000);
    return {
      status: 'queued',
      newsId: row.id,
      lang,
      position,
      etaSec: Math.max(5, position * perItem),
      script,
      durationSec: estimateBriefingDurationSec(script, style),
    };
  }

  /** Ready briefings for a playlist ("listen to the top stories"), in priority order. */
  async playlist(lang: string, limit: number, apiBase: string) {
    if (!this.db) return [];
    const { rows } = await this.db
      .query<{ news_id: string; object_key: string; mime_type: string; duration_sec: number; title: string | null; original_title: string }>(
        `SELECT a.news_id::text, a.object_key, a.mime_type, a.duration_sec,
                CASE WHEN $1 = 'uk' THEN n.title_uk ELSE COALESCE(n.ai_metadata->'article'->>'title_en',
                     CASE WHEN n.ai_metadata->'article'->>'canonical_lang' = 'en' THEN n.ai_metadata->'article'->>'title' END) END AS title,
                n.original_title
         FROM audio_briefings a JOIN news_items n ON n.id = a.news_id
         WHERE a.lang = $1 AND a.created_at >= now() - interval '36 hours'
         ORDER BY a.priority DESC, a.created_at DESC LIMIT $2`,
        [lang, limit],
      )
      .catch(() => ({ rows: [] as Array<{ news_id: string; object_key: string; mime_type: string; duration_sec: number; title: string | null; original_title: string }> }));
    return rows.map((r) => ({
      newsId: r.news_id,
      title: r.title || r.original_title,
      url: this.storage.publicUrl(r.object_key, apiBase),
      mimeType: r.mime_type,
      durationSec: r.duration_sec,
    }));
  }

  async stats() {
    const usage = this.db
      ? await this.db
          .query<{ n: number; bytes: string }>(`SELECT COUNT(*)::int AS n, COALESCE(SUM(bytes), 0)::text AS bytes FROM audio_briefings`)
          .catch(() => ({ rows: [{ n: 0, bytes: '0' }] }))
      : { rows: [{ n: 0, bytes: '0' }] };
    const now = Date.now();
    return {
      enabled: this.enabled,
      files: usage.rows[0]?.n ?? 0,
      usedBytes: Number(usage.rows[0]?.bytes ?? 0),
      maxBytes: this.maxBytes,
      queueLength: this.queue.length,
      languages: getAudioLangs(),
      providers: this.providerOrder().map((p) => ({
        provider: p,
        coolingDownSec: Math.max(0, Math.round(((this.providerCooldown.get(p) ?? 0) - now) / 1000)),
        avgRenderMs: this.avgRenderMs.get(p) ?? null,
      })),
    };
  }

  readMedia(objectKey: string) {
    return this.storage.getObject(objectKey);
  }

  // ---------------------------------------------------------------- rendering

  private providerOrder(): TtsProvider[] {
    const raw = readEnv('TTS_PROVIDER_ORDER') || 'gemini,groq_tts,workers_ai,google_tts';
    return raw
      .split(',')
      .map((p) => p.trim())
      .filter((p): p is TtsProvider => p === 'gemini' || p === 'groq_tts' || p === 'workers_ai' || p === 'google_tts');
  }

  private providerAvailable(p: TtsProvider, lang: string): boolean {
    if ((this.providerCooldown.get(p) ?? 0) > Date.now()) return false;
    if (p === 'gemini') return Boolean(process.env.GEMINI_API_KEY?.trim());
    // Groq Orpheus: English only, free tier ~100 requests and ~3.6K characters per day.
    if (p === 'groq_tts') return Boolean(readEnv('groq_api_key')) && lang === 'en' && this.groqTtsToday().count < 90;
    // Workers AI voices (MeloTTS / Aura) do not speak Ukrainian.
    if (p === 'workers_ai') return Boolean(getWorkersAiConfig()) && lang === 'en';
    if (p === 'google_tts') return Boolean(readEnv('GOOGLE_TTS_API_KEY'));
    return false;
  }

  private async render(job: AudioJob): Promise<void> {
    if (!this.db || !this.storage.configured) return;
    if (await this.findReady(job.newsId, job.lang, job.depth, job.style)) return;
    const row = await this.loadArticle(job.newsId);
    if (!row) return;
    const script = buildScript(row, job.lang, job.depth, job.style);
    if (script.length < 20) return;

    for (const provider of this.providerOrder()) {
      if (!this.providerAvailable(provider, job.lang)) continue;
      const started = Date.now();
      try {
        const out =
          provider === 'gemini'
            ? await this.renderGemini(script, job.lang)
            : provider === 'groq_tts'
              ? await this.renderGroqTts(script, job.lang)
              : provider === 'workers_ai'
              ? await this.renderWorkersAi(script, job.lang)
                : await this.renderGoogleTts(script, job.lang);
        if (!out) continue;
        const elapsed = Date.now() - started;
        this.avgRenderMs.set(provider, Math.round(((this.avgRenderMs.get(provider) ?? elapsed) * 2 + elapsed) / 3));
        await this.store(job, row, script, provider, out);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Rate limit / outage / slowness: skip this provider for a while so the next one is used immediately.
        if (/\b(429|5\d\d)\b|timeout|aborted|exhausted|unavailable/i.test(msg)) {
          this.providerCooldown.set(provider, Date.now() + PROVIDER_COOLDOWN_MS);
        }
        this.logger.debug(`TTS provider ${provider} failed for ${job.newsId}/${job.lang}: ${msg}`);
      }
    }
  }

  private async renderGemini(script: string, lang: string): Promise<{ audio: Buffer; mimeType: string; model: string } | null> {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) return null;
    const instruction =
      lang === 'uk'
        ? 'Прочитай як ведучий новин: спокійно, чітко, природною українською.'
        : 'Read as a calm, clear news anchor in natural English.';
    const res = await postGeminiGenerateContent({
      apiKey: key,
      preferredModel: PREFERRED_TTS_MODELS[0],
      // Only the two best models: walking the whole list is what made users wait minutes.
      candidateModels: PREFERRED_TTS_MODELS.slice(0, 2) as unknown as string[],
      priority: 'high',
      timeoutMs: GEMINI_FOREGROUND_TIMEOUT_MS,
      body: {
        contents: [{ role: 'user', parts: [{ text: `${instruction}\n\n${script}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
        },
      },
    });
    const parts =
      (res.data as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] })
        .candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) return null;
    const rawMime = (inline.mimeType || 'audio/L16').toLowerCase();
    if (/audio\/(wav|x-wav|mpeg|mp3|ogg)/.test(rawMime)) {
      return { audio: Buffer.from(inline.data, 'base64'), mimeType: rawMime.split(';')[0], model: res.modelUsed };
    }
    const rate = Number(/rate=(\d+)/.exec(rawMime)?.[1]) || 24000;
    const wav = pcm16ToWavBase64(Buffer.from(inline.data, 'base64'), rate, 1, 16);
    return { audio: Buffer.from(wav, 'base64'), mimeType: 'audio/wav', model: res.modelUsed };
  }

  private groqTtsUsage = { day: '', count: 0, chars: 0 };

  private groqTtsToday() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.groqTtsUsage.day !== day) this.groqTtsUsage = { day, count: 0, chars: 0 };
    return this.groqTtsUsage;
  }

  /** Groq Orpheus English TTS — very fast; daily character budget is small, so only short scripts. */
  private async renderGroqTts(script: string, lang: string): Promise<{ audio: Buffer; mimeType: string; model: string } | null> {
    const key = readEnv('groq_api_key');
    const usage = this.groqTtsToday();
    const maxChars = Number(readEnv('GROQ_TTS_DAILY_CHARS')) || 3400;
    if (!key || lang !== 'en' || script.length > 900 || usage.chars + script.length > maxChars) return null;
    const model = readEnv('GROQ_TTS_MODEL') || 'canopylabs/orpheus-v1-english';
    const resp = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: script, voice: readEnv('GROQ_TTS_VOICE') || 'tara', response_format: 'wav' }),
      signal: AbortSignal.timeout(25_000),
    });
    usage.count += 1;
    if (!resp.ok) throw new Error(`Groq TTS HTTP ${resp.status}`);
    usage.chars += script.length;
    return { audio: Buffer.from(await resp.arrayBuffer()), mimeType: 'audio/wav', model };
  }

  /** Cloudflare Workers AI MeloTTS (English) — fast, free daily allocation, MP3 output. */
  private async renderWorkersAi(script: string, lang: string): Promise<{ audio: Buffer; mimeType: string; model: string } | null> {
    const cfg = getWorkersAiConfig();
    if (!cfg || lang !== 'en') return null;
    const model = readEnv('cloudflare_tts_model') || '@cf/myshell-ai/melotts';
    const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: script, text: script, lang: 'en' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`Workers AI TTS HTTP ${resp.status}`);
    const type = resp.headers.get('content-type') || '';
    if (type.startsWith('audio/')) return { audio: Buffer.from(await resp.arrayBuffer()), mimeType: type.split(';')[0], model };
    const json = (await resp.json()) as { result?: { audio?: string } };
    if (!json.result?.audio) return null;
    return { audio: Buffer.from(json.result.audio, 'base64'), mimeType: 'audio/mpeg', model };
  }

  /** Google Cloud Text-to-Speech (has Ukrainian voices; free monthly allowance) — needs GOOGLE_TTS_API_KEY. */
  private async renderGoogleTts(script: string, lang: string): Promise<{ audio: Buffer; mimeType: string; model: string } | null> {
    const key = readEnv('GOOGLE_TTS_API_KEY');
    if (!key) return null;
    const languageCode = lang === 'uk' ? 'uk-UA' : lang === 'en' ? 'en-US' : lang;
    const resp = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text: script.slice(0, 4800) }, voice: { languageCode }, audioConfig: { audioEncoding: 'MP3', speakingRate: 1.02 } }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) throw new Error(`Google TTS HTTP ${resp.status}`);
    const json = (await resp.json()) as { audioContent?: string };
    return json.audioContent ? { audio: Buffer.from(json.audioContent, 'base64'), mimeType: 'audio/mpeg', model: `google-tts:${languageCode}` } : null;
  }

  private async store(job: AudioJob, row: ArticleRow, script: string, provider: TtsProvider, out: { audio: Buffer; mimeType: string; model: string }) {
    if (!this.db) return;
    const cacheKey = audioCacheKey(row.id, job.lang, job.depth, job.style, this.voice);
    const ext = out.mimeType.includes('mpeg') || out.mimeType.includes('mp3') ? 'mp3' : out.mimeType.includes('ogg') ? 'ogg' : 'wav';
    const objectKey = `tts/${job.lang}/${row.id}-${cacheKey}.${ext}`;
    await this.storage.putObject(objectKey, out.audio, out.mimeType);
    await this.db.query(
      `INSERT INTO audio_briefings (cache_key, news_id, lang, depth, style, voice, object_key, mime_type, bytes, provider, model,
         duration_sec, script, priority)
       VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (cache_key) DO UPDATE SET object_key = EXCLUDED.object_key, bytes = EXCLUDED.bytes, provider = EXCLUDED.provider,
         model = EXCLUDED.model, mime_type = EXCLUDED.mime_type, script = EXCLUDED.script, created_at = now(), last_access_at = now()`,
      [cacheKey, row.id, job.lang, job.depth, job.style, this.voice, objectKey, out.mimeType, out.audio.length, provider, out.model,
        estimateBriefingDurationSec(script, job.style), script, Math.round(job.priority)],
    );
    await this.evictIfNeeded();
  }

  private async evictIfNeeded(): Promise<void> {
    if (!this.db) return;
    const { rows } = await this.db.query<{ cache_key: string; object_key: string; bytes: string; last_access_at: Date }>(
      `SELECT cache_key, object_key, bytes::text, last_access_at FROM audio_briefings`,
    );
    const victims = new Set(
      planEviction(
        rows.map((r) => ({ key: r.cache_key, bytes: Number(r.bytes), lastAccess: new Date(r.last_access_at).getTime() })),
        this.maxBytes,
      ),
    );
    for (const r of rows) {
      if (!victims.has(r.cache_key)) continue;
      await this.storage.deleteObject(r.object_key).catch(() => undefined);
      await this.db.query(`DELETE FROM audio_briefings WHERE cache_key = $1`, [r.cache_key]).catch(() => undefined);
    }
    if (victims.size) this.logger.log(`Evicted ${victims.size} old audio briefing(s) to stay under ${Math.round(this.maxBytes / 1048576)} MB`);
  }
}
