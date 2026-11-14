import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { postGeminiGenerateContent } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';
import { CompanyFeedsService } from './company-feeds.service';

export const PREFERRED_TTS_MODELS = [
  'gemini-3.1-flash-tts',
  'gemini-3.8-flash-lite-tts',
  'gemini-2.5-flash-preview-tts',
] as const;

export interface NewsTtsArticleInput {
  title?: string | null;
  titleUk?: string | null;
  originalTitle?: string | null;
  summary?: string | null;
  summaryUk?: string | null;
  originalSummary?: string | null;
  whyItMatters?: string | null;
  sourceName?: string | null;
}

export interface NewsTtsResult {
  id: string;
  status: 'gemini_audio' | 'script_only';
  important: boolean;
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

function ensureSentenceEnding(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return '';
  return /[.!?…]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

export function buildBroadcastScriptUk(article: NewsTtsArticleInput): string {
  const title = cleanBroadcastText(article.titleUk || article.title || article.originalTitle);
  const summary = cleanBroadcastText(article.summaryUk || article.summary || article.originalSummary);
  const why = cleanBroadcastText(article.whyItMatters);
  const source = cleanBroadcastText(article.sourceName);

  const parts: string[] = [];
  if (title) {
    const intro = source ? `Важлива новина від ${source}. ${title}` : `Важлива новина дня. ${title}`;
    parts.push(ensureSentenceEnding(intro));
  }
  if (summary && summary !== title) {
    parts.push(ensureSentenceEnding(summary));
  }
  if (why) {
    const hasLead = /^(чому це важливо|практичне значення)/i.test(why);
    parts.push(ensureSentenceEnding(hasLead ? why : `Чому це важливо: ${why}`));
  }

  let combined = parts.join(' ').replace(/\s+/g, ' ').trim();
  const words = combined ? combined.split(' ') : [];

  if (words.length > 0 && words.length < 60) {
    const outro =
      'Цей реліз уже зафіксовано в аналітичному моніторингу AI Radar як подію високого пріоритету для інженерів та технологічних команд.';
    const next = `${combined} ${outro}`.trim();
    combined = next.split(' ').slice(0, 110).join(' ');
  } else if (words.length > 110) {
    const sliced = words.slice(0, 108).join(' ').replace(/[,:;—–-]+$/, '');
    combined = ensureSentenceEnding(sliced);
  }

  return combined || 'Важливе технологічне оновлення в огляді AI Radar.';
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

  async generateImportantNewsBriefing(id: string, source?: string): Promise<NewsTtsResult> {
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
    }>(
      `SELECT n.id::text, n.external_id, n.title_uk, n.original_title, n.summary_uk,
              n.original_summary, n.why_it_matters, n.importance,
              COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important_flag,
              s.name AS source_name
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
    const cached = this.audioCache.get(canonicalId);
    if (cached) {
      this.audioCache.delete(canonicalId);
      this.audioCache.set(canonicalId, cached);
      return { ...cached, cached: true };
    }

    const scriptUk = buildBroadcastScriptUk({
      titleUk: row.title_uk,
      originalTitle: row.original_title,
      summaryUk: row.summary_uk,
      originalSummary: row.original_summary,
      whyItMatters: row.why_it_matters,
      sourceName: row.source_name,
    });

    if (!this.activeKey) {
      return {
        id: canonicalId,
        status: 'script_only',
        important: true,
        modelUsed: null,
        mimeType: null,
        audioBase64: null,
        scriptUk,
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
                  text: `Озвуч українською мовою як професійний ведучий техно-радіо (чітко, ритмічно, природна інтонація, без сторонніх коментарів):\n\n${scriptUk}`,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: 'Kore',
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
          modelUsed: ttsRes.modelUsed,
          mimeType,
          audioBase64,
          scriptUk,
          preferredModels: [...PREFERRED_TTS_MODELS],
        };
        this.rememberAudio(canonicalId, successPayload);
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
      modelUsed: null,
      mimeType: null,
      audioBase64: null,
      scriptUk,
      preferredModels: [...PREFERRED_TTS_MODELS],
      cached: false,
    };
  }
}
