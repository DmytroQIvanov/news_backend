import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { postGeminiGenerateContent } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';
import { CompanyFeedsService } from './company-feeds.service';

export const PREFERRED_TTS_MODELS = [
  'gemini-3.8-flash-tts',
  'gemini-3.1-flash-tts',
  'gemini-2.5-flash-tts',
  'gemini-3.8-flash-lite-tts',
  'gemini-2.5-flash-preview-tts',
] as const;

export const NEWS_DEPTHS = ['global_brief', 'balanced', 'deep_technical'] as const;
export type NewsDepth = (typeof NEWS_DEPTHS)[number];

export const NEWS_AUDIO_STYLES = ['headline_flash', 'podcast_story', 'analyst_brief'] as const;
export type NewsAudioStyle = (typeof NEWS_AUDIO_STYLES)[number];

export interface NewsTtsOptions {
  depth?: NewsDepth | string;
  style?: NewsAudioStyle | string;
  voiceName?: string;
}

export interface NewsTtsArticleInput {
  title?: string | null;
  titleUk?: string | null;
  originalTitle?: string | null;
  summary?: string | null;
  summaryUk?: string | null;
  originalSummary?: string | null;
  whyItMatters?: string | null;
  briefingScript?: string | null;
  sourceName?: string | null;
  hydrogenInsight?: string | null;
  comparisons?: string[] | null;
  facts?: Array<{ claim?: string | null }> | string[] | null;
}

export interface NewsTtsResult {
  id: string;
  status: 'gemini_audio' | 'script_only';
  important: boolean;
  depth: NewsDepth;
  style: NewsAudioStyle;
  voiceName: string;
  modelUsed: string | null;
  mimeType: string | null;
  audioBase64: string | null;
  scriptUk: string;
  durationEstimateSec: number;
  generatedAt: string;
  preferredModels: readonly string[];
  cached: boolean;
}

export interface LatestBriefingSummaryItem {
  id: string;
  externalId: string;
  titleUk: string;
  sourceName: string;
  sourceSlug: string;
  category: string;
  publishedAt: string | null;
  depth: NewsDepth;
  style: NewsAudioStyle;
  scriptUk: string;
  audioReady: boolean;
  status: 'gemini_audio' | 'script_only';
  modelUsed: string | null;
  voiceName: string;
  durationEstimateSec: number;
  mimeType?: string | null;
  audioBase64?: string | null;
}

type GeminiTtsResponse = {
  candidates?: {
    content?: {
      parts?: {
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
      }[];
    };
  }[];
};

const BRIEFING_SECTION_LABEL_PATTERNS = [
  'практичне\\s+значення',
  'чому\\s+це\\s+важливо(?:\\s+для\\s+індустрії(?:\\s+та\\s+розробників)?)?',
  'підтверджені\\s+факти',
  'ключові\\s+факти',
  'факти\\s+та\\s+твердження',
  'факти',
  'контекст\\s+порівняння',
  'порівняння\\s+та\\s+альтернативи',
  'порівняння',
  'короткий\\s+виклад(?:\\s*\\([^)]*\\))?',
  'головна\\s+суть',
  'глобальна\\s+суть(?:\\s*\\([^)]*\\))?',
  'суть\\s+події',
  'суть\\s+дня',
  'деталі\\s+аналітики',
  'глибокий\\s+контекст',
  'ші-?аналіз(?:\\s+на\\s+основі\\s+першоджерел)?(?:\\s*\\([^)]*\\))?',
  'аналітичний\\s+висновок',
  'висновок',
  'підсумок',
  'вплив',
];

const BRIEFING_LABEL_LINE_RE = new RegExp(
  `(^|[.!?\\n]\\s*)(?:${BRIEFING_SECTION_LABEL_PATTERNS.join('|')})\\s*(?::|—|–|-|\\.)\\s*`,
  'giu',
);

export function stripBriefingSectionLabels(text: string): string {
  return String(text || '')
    .replace(BRIEFING_LABEL_LINE_RE, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBroadcastText(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = raw
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\[\d+\]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripBriefingSectionLabels(cleaned);
}

export function stripTtsPromptDirectives(text: string): string {
  const withoutDirectives = String(text || '')
    .replace(/^(?:озвуч|прочитай)\s+українською[^:\n]*:\s*/i, '')
    .replace(/^інструкція\s+для\s+диктора[^:\n]*:\s*/i, '')
    .replace(
      /У цьому аудіоогляді коротко розбираємо суть події та те, як вона змінить щоденні робочі процеси вже найближчим часом\.?/gi,
      '',
    );
  return stripBriefingSectionLabels(withoutDirectives);
}

function simplifyForGlobalBrief(raw: string): string {
  return raw
    .replace(/([A-Za-zА-Яа-яІіЇїЄєҐґ])-?\bv?\d+(?:\.\d+)+\b/gi, '$1')
    .replace(/\bv?\d+(?:\.\d+)+\b/gi, '')
    .replace(/\b\d+(?:[.,]\d+)?\s?(?:B|T|M|K|GB|MB|TB|ms|fps|Hz|GHz|TPS)\b/gi, '')
    .replace(/\b(CVE-\d+-\d+|API|SDK|JSON|CLI|LLM|RAG|TTFT|VRAM|NPU|GPU|CPU|TPU|LoRA|QLoRA|FP8|FP16|INT4|MoE|SWE-bench|MMLU|latency|throughput|benchmark|benchmarks)\b/gi, '')
    .replace(/\b(латентність|латентності|токенів|токени|бенчмарків|бенчмарки|інференсу|квантизації|ендпоїнтів)\b/gi, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[,;:]\s*([.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureSentenceEnding(text: string): string {
  const cleaned = text.trim().replace(/[,;:\-–—]+$/, '').trim();
  if (!cleaned) return '';
  return /[.!?…]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function countWords(text: string): string[] {
  return text.trim() ? text.trim().split(/\s+/) : [];
}

function normalizeComparisonTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function hasHighOverlap(candidate: string, existingText: string, threshold = 0.65): boolean {
  const candClean = candidate.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const existClean = existingText.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!candClean || !existClean) return false;
  if (existClean.includes(candClean) || candClean.includes(existClean)) {
    return candClean.length <= existClean.length;
  }
  const candTokens = normalizeComparisonTokens(candidate);
  const existSet = new Set(normalizeComparisonTokens(existingText));
  if (candTokens.length < 3 || existSet.size === 0) return false;
  let hits = 0;
  for (const tok of candTokens) {
    if (existSet.has(tok)) hits += 1;
  }
  return hits / candTokens.length >= threshold;
}

function stripLeadingTitleFromDescription(title: string, description: string): string {
  if (!title || !description) return description;
  const normTitle = title.replace(/[.!?…:;\-–—]+$/g, '').trim();
  if (!normTitle) return description;

  const escaped = normTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leadingPrefixRe = new RegExp(`^${escaped}[\\s.:;\\-–—]*`, 'iu');
  const stripped = description.replace(leadingPrefixRe, '').trim();
  return stripped || '';
}

function deduplicateTitleAndSummary(
  title: string,
  summary: string,
  sourceName: string,
): string[] {
  const parts: string[] = [];
  const cleanTitle = title.trim();
  let cleanSummary = stripLeadingTitleFromDescription(cleanTitle, summary.trim());

  if (cleanTitle && cleanSummary) {
    const titleRedundantInSummary =
      hasHighOverlap(cleanTitle, cleanSummary, 0.65) ||
      hasHighOverlap(cleanSummary, cleanTitle, 0.8);

    if (titleRedundantInSummary) {
      const chosen =
        countWords(cleanSummary).length >= countWords(cleanTitle).length
          ? cleanSummary
          : cleanTitle;
      parts.push(ensureSentenceEnding(sourceName ? `${sourceName} повідомляє: ${chosen}` : chosen));
      return parts;
    }

    parts.push(ensureSentenceEnding(sourceName ? `${sourceName} повідомляє: ${cleanTitle}` : cleanTitle));
    parts.push(ensureSentenceEnding(cleanSummary));
    return parts;
  }

  if (cleanSummary) {
    parts.push(ensureSentenceEnding(sourceName ? `${sourceName} повідомляє: ${cleanSummary}` : cleanSummary));
    return parts;
  }

  if (cleanTitle) {
    parts.push(ensureSentenceEnding(sourceName ? `${sourceName} повідомляє: ${cleanTitle}` : cleanTitle));
    return parts;
  }

  parts.push(sourceName ? `Головна новина дня від ${sourceName}.` : 'Головна новина дня.');
  return parts;
}

function fitBroadcastWordRange(
  baseText: string,
  fillers: string[],
  minWords: number,
  maxWords: number,
): string {
  let working = baseText.replace(/\s+/g, ' ').trim();
  let words = countWords(working);

  for (const filler of fillers) {
    if (words.length >= minWords) break;
    if (hasHighOverlap(filler, working, 0.65)) continue;
    working = working ? `${ensureSentenceEnding(working)} ${filler}` : filler;
    words = countWords(working);
  }

  if (words.length <= maxWords) {
    return ensureSentenceEnding(working);
  }

  const sliced = words.slice(0, maxWords);
  let bestBoundary = -1;
  for (let i = minWords - 1; i < sliced.length; i += 1) {
    if (/[.!?…]$/.test(sliced[i])) {
      bestBoundary = i;
    }
  }
  if (bestBoundary >= minWords - 1) {
    return sliced.slice(0, bestBoundary + 1).join(' ');
  }

  const trimmed = [...sliced];
  const trailingConjunctions = /^(і|й|та|а|в|у|на|з|із|зі|до|для|про|від|при|за|під|над|що|який|яка|яке|які)$/i;
  while (trimmed.length > minWords && trailingConjunctions.test(trimmed[trimmed.length - 1].replace(/[,;:.!?…]+$/, ''))) {
    trimmed.pop();
  }
  return ensureSentenceEnding(trimmed.join(' '));
}

export function resolveNewsBriefMode(options?: NewsTtsOptions): { depth: NewsDepth; style: NewsAudioStyle } {
  const rawDepth = options?.depth;
  const rawStyle = options?.style;

  if (rawStyle === 'headline_flash' || (!rawStyle && rawDepth === 'global_brief')) {
    return {
      depth: rawDepth === 'balanced' || rawDepth === 'deep_technical' ? rawDepth : 'global_brief',
      style: 'headline_flash',
    };
  }
  if (rawStyle === 'analyst_brief' || (!rawStyle && rawDepth === 'deep_technical')) {
    return {
      depth: rawDepth === 'global_brief' || rawDepth === 'balanced' ? rawDepth : 'deep_technical',
      style: 'analyst_brief',
    };
  }
  return {
    depth: rawDepth === 'global_brief' || rawDepth === 'deep_technical' ? rawDepth : 'balanced',
    style:
      rawStyle === 'headline_flash' || rawStyle === 'analyst_brief' || rawStyle === 'podcast_story'
        ? rawStyle
        : 'podcast_story',
  };
}

export function estimateBriefingDurationSec(scriptUk: string, style: NewsAudioStyle): number {
  const words = countWords(scriptUk).length;
  if (words <= 0) {
    return style === 'headline_flash' ? 25 : style === 'analyst_brief' ? 90 : 60;
  }
  return Math.max(15, Math.round(words / 2.1));
}

export function buildBroadcastScriptUk(article: NewsTtsArticleInput, options?: NewsTtsOptions): string {
  const rawTitle = cleanBroadcastText(article.titleUk || article.title || article.originalTitle);
  const rawSummary = cleanBroadcastText(article.summaryUk || article.summary || article.originalSummary);
  const rawWhy = cleanBroadcastText(article.whyItMatters);
  const rawBriefing = cleanBroadcastText(article.briefingScript);
  const rawSource = cleanBroadcastText(article.sourceName);
  const insight = cleanBroadcastText(article.hydrogenInsight);
  const factTexts = (article.facts ?? [])
    .map((entry) => cleanBroadcastText(typeof entry === 'string' ? entry : entry?.claim))
    .filter(Boolean)
    .slice(0, 2);
  const comparisonTexts = (article.comparisons ?? [])
    .map((entry) => cleanBroadcastText(entry))
    .filter(Boolean)
    .slice(0, 2);
  const { depth, style } = resolveNewsBriefMode(options);

  const appendUnique = (parts: string[], candidate: string) => {
    const cleanCand = cleanBroadcastText(candidate);
    if (!cleanCand) return;
    const current = parts.join(' ');
    if (current && hasHighOverlap(cleanCand, current, 0.7)) return;
    parts.push(ensureSentenceEnding(cleanCand));
  };

  // Dedicated standalone briefing text when provided separately
  if (rawBriefing && countWords(rawBriefing).length >= 8) {
    const cleanedDedicated = stripLeadingTitleFromDescription(rawTitle, rawBriefing) || rawBriefing;

    if (style === 'headline_flash' || depth === 'global_brief') {
      const globalDedicated = simplifyForGlobalBrief(cleanedDedicated);
      const globalContext = [
        'Подія безпосередньо впливає на рішення громадян, економіку та повсякденні справи в Україні й світі.',
        'Оглядачі відстежують подальші наслідки цих змін для суспільства.',
      ];
      return stripTtsPromptDirectives(
        fitBroadcastWordRange(ensureSentenceEnding(globalDedicated), globalContext, 30, 45),
      );
    }

    if (style === 'analyst_brief' || depth === 'deep_technical') {
      const parts: string[] = [ensureSentenceEnding(cleanedDedicated)];
      appendUnique(parts, insight);
      for (const fact of factTexts) appendUnique(parts, fact);
      for (const cmp of comparisonTexts) appendUnique(parts, cmp);
      const analystContext = [
        'Матеріал охоплює ключові факти, офіційні дані першоджерела та безпосередній вплив події на громадян, економіку й суспільство.',
        'Фахівці відзначають важливість подальших рішень, правових наслідків та реалістичних строків впровадження змін.',
        'Детальні обставини, перевірені посилання та порівняння доступні в матеріалі публікації.',
      ];
      return stripTtsPromptDirectives(fitBroadcastWordRange(parts.join(' '), analystContext, 90, 115));
    }

    const parts: string[] = [ensureSentenceEnding(cleanedDedicated)];
    if (factTexts.length > 0) appendUnique(parts, factTexts[0]);
    appendUnique(parts, insight);
    const storyContext = [
      'Подія привернула значну увагу в Україні та світі через безпосередній вплив на рішення людей, фінанси та повсякденне життя.',
      'Оновлення щодо розвитку ситуації та реакції експертів збираються з перевірених першоджерел.',
    ];
    return stripTtsPromptDirectives(fitBroadcastWordRange(parts.join(' '), storyContext, 65, 80));
  }

  if (style === 'headline_flash' || depth === 'global_brief') {
    const title = simplifyForGlobalBrief(rawTitle);
    const summary = simplifyForGlobalBrief(rawSummary);
    const why = simplifyForGlobalBrief(rawWhy);
    const parts = deduplicateTitleAndSummary(title, summary, rawSource);
    appendUnique(parts, why);

    const globalContext = [
      'Подія безпосередньо впливає на рішення громадян, економіку та повсякденні справи в Україні й світі.',
      'Світові та українські оглядачі відстежують наслідки цих змін для суспільства.',
    ];
    return stripTtsPromptDirectives(fitBroadcastWordRange(parts.join(' '), globalContext, 30, 45));
  }

  if (style === 'analyst_brief' || depth === 'deep_technical') {
    const parts = deduplicateTitleAndSummary(rawTitle, rawSummary, rawSource);
    appendUnique(parts, rawWhy);
    appendUnique(parts, insight);
    for (const fact of factTexts) appendUnique(parts, fact);
    for (const cmp of comparisonTexts) appendUnique(parts, cmp);

    const analystContext = [
      'Матеріал охоплює ключові факти, офіційні дані першоджерела та безпосередній вплив події на громадян, економіку й суспільство.',
      'Фахівці відзначають важливість подальших рішень, правових наслідків та реалістичних строків впровадження змін.',
      'Варто врахувати підтверджені цифри першоджерела, реакцію незалежних спостерігачів та можливі ризики на найближчі місяці.',
      'Детальні обставини, перевірені посилання та порівняння доступні в матеріалі публікації.',
    ];
    return stripTtsPromptDirectives(fitBroadcastWordRange(parts.join(' '), analystContext, 90, 115));
  }

  // Default balanced / podcast_story (65-80 words)
  const parts = deduplicateTitleAndSummary(rawTitle, rawSummary, rawSource);
  appendUnique(parts, rawWhy);
  if (factTexts.length > 0) appendUnique(parts, factTexts[0]);
  appendUnique(parts, insight);

  const storyContext = [
    'Подія привернула значну увагу в Україні та світі через безпосередній вплив на рішення людей, фінанси та повсякденне життя.',
    'Фахівці радять звернути увагу на офіційні деталі, можливі наслідки та подальші кроки відповідальних установ.',
    'Оновлення щодо розвитку ситуації та реакції експертів збираються з перевірених першоджерел.',
  ];
  return stripTtsPromptDirectives(fitBroadcastWordRange(parts.join(' '), storyContext, 65, 80));
}

export function pcm16ToWavBase64(
  pcmBytes: Buffer,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16,
): string {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBytes.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBytes.length, 40);

  return Buffer.concat([header, pcmBytes]).toString('base64');
}

interface NewsTtsDbArticleRow {
  id: string;
  external_id: string;
  title_uk: string | null;
  original_title: string;
  summary_uk: string | null;
  original_summary: string | null;
  why_it_matters: string | null;
  briefing_script?: string | null;
  importance: string | null;
  important_flag: boolean;
  source_name: string | null;
  source_slug?: string | null;
  category?: string | null;
  published_at?: Date | string | null;
  hydrogen_insight?: string | null;
  comparisons?: string[] | null;
  facts?: Array<{ claim?: string | null }> | null;
}

interface NewsTtsCacheRow {
  cache_key: string;
  status: string;
  model_used: string | null;
  mime_type: string | null;
  audio_base64: string | null;
  script_uk: string;
  voice_name: string | null;
  duration_estimate_sec: number | null;
  updated_at: Date | string | null;
}

const PREWARM_INITIAL_DELAY_MS = 45_000;
const PREWARM_INTERVAL_MS = 10 * 60_000;

@Injectable()
export class NewsTtsService implements OnModuleInit, OnModuleDestroy {
  private static readonly MAX_CACHE_ENTRIES = 30;
  private readonly logger = new Logger(NewsTtsService.name);
  private readonly audioCache = new Map<string, Omit<NewsTtsResult, 'cached'>>();
  private readonly key = process.env.GEMINI_API_KEY?.trim();
  private prewarmTimer?: NodeJS.Timeout;
  private stopped = false;
  private activePrewarm?: Promise<{ checked: number; generated: number; cached: number; errors: number }>;

  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly companyFeeds?: CompanyFeedsService,
  ) {}

  onModuleInit() {
    if (
      this.activeKey &&
      process.env.NODE_ENV !== 'test' &&
      // Legacy prewarm stored WAV base64 in Postgres; AudioBriefingService (R2) replaces it. Opt-in only.
      process.env.TTS_AUTO_PREWARM === 'true'
    ) {
      this.prewarmTimer = setTimeout(() => void this.schedulePrewarmLoop(), PREWARM_INITIAL_DELAY_MS);
      this.prewarmTimer.unref?.();
    }
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.prewarmTimer);
  }

  private async schedulePrewarmLoop() {
    try {
      await this.prewarmImportantBriefings({ limit: 5 });
    } catch {
      // Best-effort background prewarm
    } finally {
      if (!this.stopped) {
        this.prewarmTimer = setTimeout(() => void this.schedulePrewarmLoop(), PREWARM_INTERVAL_MS);
        this.prewarmTimer.unref?.();
      }
    }
  }

  private get activeKey(): string | undefined {
    return this.key || process.env.GEMINI_API_KEY?.trim();
  }

  private makeCacheKey(canonicalId: string, voice: string, depth: NewsDepth, style: NewsAudioStyle): string {
    return `v4:${canonicalId}:${voice}:${depth}:${style}`;
  }

  private rememberAudio(cacheKey: string, payload: Omit<NewsTtsResult, 'cached'>): void {
    if (this.audioCache.has(cacheKey)) {
      this.audioCache.delete(cacheKey);
    } else if (this.audioCache.size >= NewsTtsService.MAX_CACHE_ENTRIES) {
      const oldestKey = this.audioCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.audioCache.delete(oldestKey);
      }
    }
    this.audioCache.set(cacheKey, payload);
  }

  private async readDbCache(
    cacheKey: string,
    canonicalId: string,
    depth: NewsDepth,
    style: NewsAudioStyle,
    voice: string,
  ): Promise<Omit<NewsTtsResult, 'cached'> | null> {
    try {
      const res = await this.db.query<NewsTtsCacheRow>(
        `SELECT cache_key, status, model_used, mime_type, audio_base64, script_uk, voice_name, duration_estimate_sec, updated_at
         FROM news_tts_cache
         WHERE cache_key = $1
         LIMIT 1`,
        [cacheKey],
      );
      const cachedRow = res?.rows?.[0];
      if (!cachedRow || cachedRow.status !== 'gemini_audio' || !cachedRow.audio_base64) {
        return null;
      }
      const cleanScript = stripTtsPromptDirectives(cachedRow.script_uk || '');
      return {
        id: canonicalId,
        status: 'gemini_audio',
        important: true,
        depth,
        style,
        voiceName: cachedRow.voice_name || voice,
        modelUsed: cachedRow.model_used || null,
        mimeType: cachedRow.mime_type || 'audio/wav',
        audioBase64: cachedRow.audio_base64,
        scriptUk: cleanScript,
        durationEstimateSec:
          cachedRow.duration_estimate_sec || estimateBriefingDurationSec(cleanScript, style),
        generatedAt: cachedRow.updated_at
          ? new Date(cachedRow.updated_at).toISOString()
          : new Date().toISOString(),
        preferredModels: [...PREFERRED_TTS_MODELS],
      };
    } catch {
      return null;
    }
  }

  private async writeDbCache(
    cacheKey: string,
    row: Pick<NewsTtsDbArticleRow, 'id' | 'external_id'>,
    payload: Omit<NewsTtsResult, 'cached'>,
  ): Promise<void> {
    if (payload.status !== 'gemini_audio' || !payload.audioBase64) return;
    try {
      const numericId = /^\d+$/.test(String(row.id)) ? Number(row.id) : null;
      await this.db.query(
        `INSERT INTO news_tts_cache (
           cache_key, news_id, external_id, depth, style, voice_name,
           status, model_used, mime_type, audio_base64, script_uk, duration_estimate_sec, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (cache_key) DO UPDATE SET
           status = EXCLUDED.status,
           model_used = EXCLUDED.model_used,
           mime_type = EXCLUDED.mime_type,
           audio_base64 = EXCLUDED.audio_base64,
           script_uk = EXCLUDED.script_uk,
           duration_estimate_sec = EXCLUDED.duration_estimate_sec,
           updated_at = now()`,
        [
          cacheKey,
          numericId,
          row.external_id || null,
          payload.depth,
          payload.style,
          payload.voiceName,
          payload.status,
          payload.modelUsed,
          payload.mimeType,
          payload.audioBase64,
          payload.scriptUk,
          payload.durationEstimateSec,
        ],
      );
    } catch {
      // Optional DB persistence; ignore if table does not exist in test/pre-014 environments
    }
  }

  private buildScriptForRow(row: NewsTtsDbArticleRow, depth: NewsDepth, style: NewsAudioStyle, voice: string): string {
    return stripTtsPromptDirectives(
      buildBroadcastScriptUk(
        {
          titleUk: row.title_uk,
          originalTitle: row.original_title,
          summaryUk: row.summary_uk,
          originalSummary: row.original_summary,
          whyItMatters: row.why_it_matters,
          briefingScript: row.briefing_script,
          sourceName: row.source_name,
          hydrogenInsight: row.hydrogen_insight,
          comparisons: Array.isArray(row.comparisons) ? row.comparisons : undefined,
          facts: Array.isArray(row.facts) ? row.facts : undefined,
        },
        { depth, style, voiceName: voice },
      ),
    );
  }

  async generateImportantNewsBriefing(
    id: string,
    source?: string,
    options?: NewsTtsOptions,
  ): Promise<NewsTtsResult> {
    const trimmedId = (id || '').trim();
    if (!trimmedId) {
      throw new NotFoundException('Article not found');
    }

    const { rows } = await this.db.query<NewsTtsDbArticleRow>(
      `SELECT n.id::text, n.external_id, n.title_uk, n.original_title, n.summary_uk,
              n.original_summary, n.why_it_matters, n.importance,
              COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important_flag,
              s.name AS source_name,
              n.ai_metadata->>'hydrogen_insight' AS hydrogen_insight,
              COALESCE(n.ai_metadata->>'briefing_script', n.ai_metadata->'article'->>'briefing_script') AS briefing_script,
              n.ai_metadata->'article'->'comparisons' AS comparisons,
              n.ai_metadata->'article'->'facts' AS facts
       FROM news_items n
       JOIN sources s ON s.id = n.source_id
       WHERE (n.external_id = $1 OR n.id::text = $1) AND n.status = 'published'
       LIMIT 1`,
      [trimmedId],
    );

    const row = rows[0];
    if (!row) {
      if (/^rss-[a-f0-9]{24}$/.test(trimmedId) && this.companyFeeds) {
        const feeds = await this.companyFeeds.list(source ? [source] : []);
        const rawRss = feeds.items.find((entry) => entry.id === trimmedId);
        if (rawRss) {
          throw new BadRequestException('Аудіо-брифінг TTS доступний лише для важливих новин');
        }
      }
      throw new NotFoundException('Article not found');
    }

    const isImportant = Boolean(row.important_flag) || row.importance === 'high';
    if (!isImportant) {
      throw new BadRequestException('Аудіо-брифінг TTS доступний лише для важливих новин');
    }

    const canonicalId = String(row.id || trimmedId);
    const { depth, style } = resolveNewsBriefMode(options);
    const voice = (options?.voiceName || 'Kore').trim() || 'Kore';
    const cacheKey = this.makeCacheKey(canonicalId, voice, depth, style);

    const cached = this.audioCache.get(cacheKey);
    if (cached) {
      this.audioCache.delete(cacheKey);
      this.audioCache.set(cacheKey, cached);
      return { ...cached, cached: true };
    }

    const dbCached = await this.readDbCache(cacheKey, canonicalId, depth, style, voice);
    if (dbCached) {
      this.rememberAudio(cacheKey, dbCached);
      return { ...dbCached, cached: true };
    }

    const scriptUk = this.buildScriptForRow(row, depth, style, voice);
    const durationEstimateSec = estimateBriefingDurationSec(scriptUk, style);

    if (!this.activeKey) {
      return {
        id: canonicalId,
        status: 'script_only',
        important: true,
        depth,
        style,
        voiceName: voice,
        modelUsed: null,
        mimeType: null,
        audioBase64: null,
        scriptUk,
        durationEstimateSec,
        generatedAt: new Date().toISOString(),
        preferredModels: [...PREFERRED_TTS_MODELS],
        cached: false,
      };
    }

    try {
      const ttsRes = await postGeminiGenerateContent({
        apiKey: this.activeKey,
        preferredModel: PREFERRED_TTS_MODELS[0],
        candidateModels: [...PREFERRED_TTS_MODELS],
        timeoutMs: 45_000,
        body: {
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: scriptUk,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice,
                },
              },
            },
          },
        },
      });

      const parts = (ttsRes.data as GeminiTtsResponse)?.candidates?.[0]?.content?.parts ?? [];
      const inline = parts.find((part) => part.inlineData?.data)?.inlineData;
      if (inline?.data) {
        const rawMime = (inline.mimeType || 'audio/L16').toLowerCase();
        let mimeType = rawMime.split(';')[0] || 'audio/wav';
        let audioBase64 = inline.data;

        if (!/(audio\/wav|audio\/x-wav|audio\/mp3|audio\/mpeg|audio\/ogg)/i.test(mimeType)) {
          const rateMatch = rawMime.match(/rate=(\d+)/i);
          const sampleRate = rateMatch ? Number(rateMatch[1]) || 24000 : 24000;
          const pcmBuffer = Buffer.from(inline.data, 'base64');
          audioBase64 = pcm16ToWavBase64(pcmBuffer, sampleRate, 1, 16);
          mimeType = 'audio/wav';
        }

        const successPayload: Omit<NewsTtsResult, 'cached'> = {
          id: canonicalId,
          status: 'gemini_audio',
          important: true,
          depth,
          style,
          voiceName: voice,
          modelUsed: ttsRes.modelUsed,
          mimeType,
          audioBase64,
          scriptUk,
          durationEstimateSec,
          generatedAt: new Date().toISOString(),
          preferredModels: [...PREFERRED_TTS_MODELS],
        };
        this.rememberAudio(cacheKey, successPayload);
        await this.writeDbCache(cacheKey, row, successPayload);
        return { ...successPayload, cached: false };
      }
    } catch (error) {
      this.logger.warn(
        `Gemini TTS fallback to script_only for article ${canonicalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      id: canonicalId,
      status: 'script_only',
      important: true,
      depth,
      style,
      voiceName: voice,
      modelUsed: null,
      mimeType: null,
      audioBase64: null,
      scriptUk,
      durationEstimateSec,
      generatedAt: new Date().toISOString(),
      preferredModels: [...PREFERRED_TTS_MODELS],
      cached: false,
    };
  }

  async listLatestBriefings(options?: {
    limit?: number;
    depth?: NewsDepth | string;
    style?: NewsAudioStyle | string;
    voiceName?: string;
    includeAudio?: boolean;
  }): Promise<{
    items: LatestBriefingSummaryItem[];
    depth: NewsDepth;
    style: NewsAudioStyle;
    total: number;
    preloadedCount: number;
  }> {
    const safeLimit = Math.max(1, Math.min(15, Math.floor(options?.limit ?? 6)));
    const { depth, style } = resolveNewsBriefMode(options);
    const voice = (options?.voiceName || 'Kore').trim() || 'Kore';
    const includeAudio = Boolean(options?.includeAudio);

    const { rows } = await this.db.query<NewsTtsDbArticleRow>(
      `SELECT n.id::text, n.external_id, n.title_uk, n.original_title, n.summary_uk,
              n.original_summary, n.why_it_matters, n.importance,
              COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important_flag,
              n.category, n.published_at,
              s.name AS source_name, s.slug AS source_slug,
              n.ai_metadata->>'hydrogen_insight' AS hydrogen_insight,
              COALESCE(n.ai_metadata->>'briefing_script', n.ai_metadata->'article'->>'briefing_script') AS briefing_script,
              n.ai_metadata->'article'->'comparisons' AS comparisons,
              n.ai_metadata->'article'->'facts' AS facts
       FROM news_items n
       JOIN sources s ON s.id = n.source_id
       WHERE n.status = 'published'
         AND (COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) OR n.importance = 'high')
         AND COALESCE(n.published_at, n.created_at) >= now() - interval '48 hours'
       ORDER BY n.published_at DESC NULLS LAST, n.id DESC
       LIMIT $1`,
      [safeLimit],
    );

    const items: LatestBriefingSummaryItem[] = [];
    let preloadedCount = 0;

    for (const row of rows) {
      const canonicalId = String(row.id);
      const cacheKey = this.makeCacheKey(canonicalId, voice, depth, style);
      let cachedEntry = this.audioCache.get(cacheKey);
      if (!cachedEntry) {
        const fromDb = await this.readDbCache(cacheKey, canonicalId, depth, style, voice);
        if (fromDb) {
          this.rememberAudio(cacheKey, fromDb);
          cachedEntry = fromDb;
        }
      }

      const scriptUk = cachedEntry?.scriptUk || this.buildScriptForRow(row, depth, style, voice);
      const audioReady = Boolean(cachedEntry?.status === 'gemini_audio' && cachedEntry.audioBase64);
      if (audioReady) preloadedCount += 1;

      items.push({
        id: canonicalId,
        externalId: row.external_id,
        titleUk: row.title_uk || row.original_title,
        sourceName: row.source_name || '',
        sourceSlug: row.source_slug || '',
        category: row.category || 'other',
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        depth,
        style,
        scriptUk,
        audioReady,
        status: cachedEntry?.status ?? 'script_only',
        modelUsed: cachedEntry?.modelUsed ?? null,
        voiceName: cachedEntry?.voiceName ?? voice,
        durationEstimateSec:
          cachedEntry?.durationEstimateSec ?? estimateBriefingDurationSec(scriptUk, style),
        ...(includeAudio && cachedEntry?.audioBase64
          ? { mimeType: cachedEntry.mimeType, audioBase64: cachedEntry.audioBase64 }
          : {}),
      });
    }

    return {
      items,
      depth,
      style,
      total: items.length,
      preloadedCount,
    };
  }

  async prewarmImportantBriefings(options?: {
    limit?: number;
    depth?: NewsDepth | string;
    style?: NewsAudioStyle | string;
    voiceName?: string;
  }): Promise<{ checked: number; generated: number; cached: number; errors: number }> {
    if (this.activePrewarm) return this.activePrewarm;
    this.activePrewarm = this.executePrewarm(options).finally(() => {
      this.activePrewarm = undefined;
    });
    return this.activePrewarm;
  }

  private async executePrewarm(options?: {
    limit?: number;
    depth?: NewsDepth | string;
    style?: NewsAudioStyle | string;
    voiceName?: string;
  }): Promise<{ checked: number; generated: number; cached: number; errors: number }> {
    let checked = 0;
    let generated = 0;
    let cached = 0;
    let errors = 0;

    if (!this.activeKey || this.stopped) {
      return { checked, generated, cached, errors };
    }

    const safeLimit = Math.max(1, Math.min(10, Math.floor(options?.limit ?? 5)));
    const { depth, style } = resolveNewsBriefMode(options);
    const voice = (options?.voiceName || 'Kore').trim() || 'Kore';

    try {
      const { rows } = await this.db.query<NewsTtsDbArticleRow>(
        `SELECT n.id::text, n.external_id, n.title_uk, n.original_title, n.summary_uk,
                n.original_summary, n.why_it_matters, n.importance,
                COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important_flag,
                s.name AS source_name,
                n.ai_metadata->>'hydrogen_insight' AS hydrogen_insight,
                COALESCE(n.ai_metadata->>'briefing_script', n.ai_metadata->'article'->>'briefing_script') AS briefing_script,
                n.ai_metadata->'article'->'comparisons' AS comparisons,
                n.ai_metadata->'article'->'facts' AS facts
         FROM news_items n
         JOIN sources s ON s.id = n.source_id
         WHERE n.status = 'published'
           AND (COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) OR n.importance = 'high')
           AND COALESCE(n.published_at, n.created_at) >= now() - interval '48 hours'
         ORDER BY n.published_at DESC NULLS LAST, n.id DESC
         LIMIT $1`,
        [safeLimit],
      );

      checked = rows.length;
      for (const row of rows) {
        if (this.stopped) break;
        const canonicalId = String(row.id);
        const cacheKey = this.makeCacheKey(canonicalId, voice, depth, style);
        if (this.audioCache.has(cacheKey)) {
          cached += 1;
          continue;
        }
        const existingDb = await this.readDbCache(cacheKey, canonicalId, depth, style, voice);
        if (existingDb) {
          this.rememberAudio(cacheKey, existingDb);
          cached += 1;
          continue;
        }
        try {
          const res = await this.generateImportantNewsBriefing(canonicalId, undefined, {
            depth,
            style,
            voiceName: voice,
          });
          if (res.cached) {
            cached += 1;
          } else if (res.status === 'gemini_audio') {
            generated += 1;
          }
        } catch (err) {
          errors += 1;
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Briefing prewarm failed for ${canonicalId}: ${msg}`);
          if (/Gemini HTTP (401|403|429)\b/.test(msg)) break;
        }
      }
    } catch (error) {
      errors += 1;
      this.logger.warn(
        `Briefing prewarm cycle skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return { checked, generated, cached, errors };
  }
}
