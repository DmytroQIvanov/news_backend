import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { postGeminiGenerateContent } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';
import { CompanyFeedsService } from './company-feeds.service';

export const PREFERRED_TTS_MODELS = [
  'gemini-3.1-flash-tts',
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
  modelUsed: string | null;
  mimeType: string | null;
  audioBase64: string | null;
  scriptUk: string;
  preferredModels: readonly string[];
  cached: boolean;
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

function cleanBroadcastText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\[\d+\]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
    working = working ? `${ensureSentenceEnding(working)} ${filler}` : filler;
    words = countWords(working);
  }

  if (words.length <= maxWords) {
    return ensureSentenceEnding(working);
  }

  const sliced = words.slice(0, maxWords);
  // Prefer ending on a sentence boundary within [minWords, maxWords]
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

export function buildBroadcastScriptUk(article: NewsTtsArticleInput, options?: NewsTtsOptions): string {
  const rawTitle = cleanBroadcastText(article.titleUk || article.title || article.originalTitle);
  const rawSummary = cleanBroadcastText(article.summaryUk || article.summary || article.originalSummary);
  const rawWhy = cleanBroadcastText(article.whyItMatters);
  const rawSource = cleanBroadcastText(article.sourceName);
  const { depth, style } = resolveNewsBriefMode(options);

  if (style === 'headline_flash' || depth === 'global_brief') {
    const title = simplifyForGlobalBrief(rawTitle);
    const summary = simplifyForGlobalBrief(rawSummary);
    const why = simplifyForGlobalBrief(rawWhy);
    const parts: string[] = [];

    if (title) {
      parts.push(ensureSentenceEnding(rawSource ? `Головне зі світу технологій від ${rawSource}. ${title}` : `Головне зі світу технологій. ${title}`));
    } else {
      parts.push('Головне зі світу технологій.');
    }
    if (summary && summary !== title) {
      parts.push(ensureSentenceEnding(summary));
    }
    if (why) {
      parts.push(ensureSentenceEnding(`Для людей і суспільства це важливо тим, що ${why.charAt(0).toLowerCase()}${why.slice(1)}`));
    }

    const globalFillers = [
      'Подія впливає на щоденні цифрові сервіси, доступність нових можливостей і безпеку користувачів у світі.',
      'Такі зміни формують практичні стандарти для суспільства, освіти й сучасних команд.',
    ];
    return fitBroadcastWordRange(parts.join(' '), globalFillers, 30, 45);
  }

  if (style === 'analyst_brief' || depth === 'deep_technical') {
    const parts: string[] = [];
    if (rawTitle) {
      parts.push(ensureSentenceEnding(rawSource ? `Аналітичний брифінг за матеріалами ${rawSource}. ${rawTitle}` : `Аналітичний брифінг. ${rawTitle}`));
    }
    if (rawSummary && rawSummary !== rawTitle) {
      parts.push(ensureSentenceEnding(rawSummary));
    }
    if (rawWhy) {
      const hasLead = /^(чому це важливо|практичне значення)/i.test(rawWhy);
      parts.push(ensureSentenceEnding(hasLead ? rawWhy : `Практичне значення: ${rawWhy}`));
    }
    const insight = cleanBroadcastText(article.hydrogenInsight);
    if (insight) {
      parts.push(ensureSentenceEnding(`Аналітичний висновок: ${insight}`));
    }
    const factTexts = (article.facts ?? [])
      .map((entry) => cleanBroadcastText(typeof entry === 'string' ? entry : entry?.claim))
      .filter(Boolean)
      .slice(0, 2);
    if (factTexts.length > 0) {
      parts.push(ensureSentenceEnding(`Підтверджені факти: ${factTexts.join('; ')}`));
    }
    const comparisonTexts = (article.comparisons ?? []).map((entry) => cleanBroadcastText(entry)).filter(Boolean).slice(0, 2);
    if (comparisonTexts.length > 0) {
      parts.push(ensureSentenceEnding(`Контекст порівняння: ${comparisonTexts.join('; ')}`));
    }

    const analystFillers = [
      'Для інженерних і продуктових команд критично перевірити реальні метрики затримки, вартість масштабування та технічні обмеження.',
      'Перед впровадженням у продакшн варто звірити незалежні тести, сумісність з поточною інфраструктурою та умови безпеки даних.',
      'Повний перелік підтверджених джерел, порівнянь і практичних кроків уже зібрано у картці події на платформі.',
      'Рекомендуємо зафіксувати власні базові показники продуктивності до початку пілотної інтеграції рішення.',
    ];
    return fitBroadcastWordRange(parts.join(' '), analystFillers, 90, 115);
  }

  // Default balanced / podcast_story (65-80 words)
  const parts: string[] = [];
  if (rawTitle) {
    parts.push(ensureSentenceEnding(rawSource ? `Важлива новина від ${rawSource}. ${rawTitle}` : `Важлива новина дня. ${rawTitle}`));
  } else {
    parts.push('Важливе технологічне оновлення в огляді AI Radar.');
  }
  if (rawSummary && rawSummary !== rawTitle) {
    parts.push(ensureSentenceEnding(rawSummary));
  }
  if (rawWhy) {
    const hasLead = /^(чому це важливо|практичне значення)/i.test(rawWhy);
    parts.push(ensureSentenceEnding(hasLead ? rawWhy : `Чому це важливо: ${rawWhy}`));
  }

  const podcastFillers = [
    'У цьому аудіоогляді коротко розбираємо суть події та те, як вона змінить щоденні робочі процеси вже найближчим часом.',
    'Для розробників і технологічних команд це сигнал звернути увагу на нові сценарії використання та реальні обмеження.',
    'Стежте за наступними оновленнями й незалежними перевірками цієї теми в нашому дайджесті.',
  ];
  return fitBroadcastWordRange(parts.join(' '), podcastFillers, 65, 80);
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

@Injectable()
export class NewsTtsService {
  private static readonly MAX_CACHE_ENTRIES = 20;
  private readonly logger = new Logger(NewsTtsService.name);
  private readonly audioCache = new Map<string, Omit<NewsTtsResult, 'cached'>>();
  private readonly key = process.env.GEMINI_API_KEY?.trim();

  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly companyFeeds?: CompanyFeedsService,
  ) {}

  private get activeKey(): string | undefined {
    return this.key || process.env.GEMINI_API_KEY?.trim();
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

  async generateImportantNewsBriefing(
    id: string,
    source?: string,
    options?: NewsTtsOptions,
  ): Promise<NewsTtsResult> {
    const trimmedId = (id || '').trim();
    if (!trimmedId) {
      throw new NotFoundException('Article not found');
    }

    const { rows } = await this.db.query<{
      id: string;
      external_id: string;
      title_uk: string | null;
      original_title: string;
      summary_uk: string | null;
      original_summary: string | null;
      why_it_matters: string | null;
      importance: string | null;
      important_flag: boolean;
      source_name: string | null;
      hydrogen_insight?: string | null;
      comparisons?: string[] | null;
      facts?: Array<{ claim?: string | null }> | null;
    }>(
      `SELECT n.id::text, n.external_id, n.title_uk, n.original_title, n.summary_uk,
              n.original_summary, n.why_it_matters, n.importance,
              COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important_flag,
              s.name AS source_name,
              n.ai_metadata->>'hydrogen_insight' AS hydrogen_insight,
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
    const cacheKey = `${canonicalId}:${voice}:${depth}:${style}`;

    const cached = this.audioCache.get(cacheKey);
    if (cached) {
      this.audioCache.delete(cacheKey);
      this.audioCache.set(cacheKey, cached);
      return { ...cached, cached: true };
    }

    const scriptUk = buildBroadcastScriptUk(
      {
        titleUk: row.title_uk,
        originalTitle: row.original_title,
        summaryUk: row.summary_uk,
        originalSummary: row.original_summary,
        whyItMatters: row.why_it_matters,
        sourceName: row.source_name,
        hydrogenInsight: row.hydrogen_insight,
        comparisons: Array.isArray(row.comparisons) ? row.comparisons : undefined,
        facts: Array.isArray(row.facts) ? row.facts : undefined,
      },
      { depth, style, voiceName: voice },
    );

    if (!this.activeKey) {
      return {
        id: canonicalId,
        status: 'script_only',
        important: true,
        depth,
        style,
        modelUsed: null,
        mimeType: null,
        audioBase64: null,
        scriptUk,
        preferredModels: [...PREFERRED_TTS_MODELS],
        cached: false,
      };
    }

    const styleDirective =
      style === 'headline_flash'
        ? 'Озвуч українською чітко, лаконічно та доступно, як диктор світових новин (без технічного жаргону, живий темп):'
        : style === 'analyst_brief'
          ? 'Озвуч українською впевнено та аналітично, з акцентом на факти, цифри й висновки для інженерів:'
          : 'Озвуч українською як професійний ведучий техно-радіо (природна, захоплива розповідь):';

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
                  text: `${styleDirective}\n\n${scriptUk}`,
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
          modelUsed: ttsRes.modelUsed,
          mimeType,
          audioBase64,
          scriptUk,
          preferredModels: [...PREFERRED_TTS_MODELS],
        };
        this.rememberAudio(cacheKey, successPayload);
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
      modelUsed: null,
      mimeType: null,
      audioBase64: null,
      scriptUk,
      preferredModels: [...PREFERRED_TTS_MODELS],
      cached: false,
    };
  }
}
