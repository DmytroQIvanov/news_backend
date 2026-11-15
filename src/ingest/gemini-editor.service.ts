import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canUseHydrogenQuota,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_HYDROGEN_MODEL,
  postGeminiGenerateContent,
  supportsSearchTools,
} from '../common/gemini-client';
import {
  checkHtmlRobotsAndTdmMeta,
  checkHttpRobotsAndTdmHeaders,
  checkRobotsTxtPermission,
  getHonestUserAgent,
  LicenseMode,
} from '../common/source-compliance';
import { DatabaseService } from '../database/database.service';
import { ClusterSource } from '../news/news-clustering.service';
import { ArticleDto, CATEGORIES, SourceDto } from './ingest.dto';

const textSchema = { type: 'string' };
const enumSchema = (values: readonly string[]) => ({ type: 'string', enum: values });
const objectSchema = (properties: Record<string, unknown>, optionalKeys: string[] = []) => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optionalKeys.includes(key)),
});
const arraySchema = (items: unknown) => ({ type: 'array', items });
const confidence = ['high', 'medium', 'low'] as const;
const evidence = ['confirmed', 'company_claim', 'unverified'] as const;

// Chain-of-Verification ordering: evidence & verification fields precede narrative prose fields.
export const EDITORIAL_ARTICLE_SCHEMA = objectSchema(
  {
    sources: arraySchema(objectSchema({ title: textSchema, url: textSchema })),
    facts: arraySchema(objectSchema({ claim: textSchema, status: enumSchema(evidence), url: textSchema })),
    confidence: enumSchema(confidence),
    important: { type: 'boolean' },
    importance_reason: textSchema,
    category: enumSchema(CATEGORIES),
    comparisons: arraySchema(textSchema),
    title: textSchema,
    summary: textSchema,
    body: textSchema,
    editorial: objectSchema({ angles: arraySchema(textSchema), style: textSchema, limitations: textSchema }),
    hydrogen_insight: textSchema,
    briefing_script: textSchema,
  },
  ['hydrogen_insight', 'briefing_script'],
);

const DAILY_DIRECTIVE_TTL_MS = 24 * 60 * 60 * 1000;

export interface BatchAngleHint {
  externalId: string;
  angleUk: string;
  skepticQuestionUk: string;
  compareWithUk: string;
  boostImportant?: boolean;
}

export interface EditArticleOptions {
  angleHint?: BatchAngleHint;
  contextSnippet?: string;
  licenseMode?: LicenseMode;
  clusterSources?: ClusterSource[];
}

export interface PolishBatchItemResult {
  id: string;
  titleUk: string;
  summaryUk: string;
  whyItMatters: string;
  hydrogenInsightUk: string;
  briefingScriptUk?: string;
}

export interface PolishBatchResult {
  polishedCount: number;
  skippedCount: number;
  modelUsed: string | null;
  items: PolishBatchItemResult[];
}

type GeminiResponse = {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; thought?: boolean }[] };
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  }[];
};

const batchAngleSchema = objectSchema({
  items: arraySchema(
    objectSchema({
      externalId: textSchema,
      angleUk: textSchema,
      skepticQuestionUk: textSchema,
      compareWithUk: textSchema,
      boostImportant: { type: 'boolean' },
    }),
  ),
});

const batchPolishSchema = objectSchema({
  items: arraySchema(
    objectSchema(
      {
        id: textSchema,
        titleUk: textSchema,
        summaryUk: textSchema,
        whyItMatters: textSchema,
        hydrogenInsightUk: textSchema,
        briefingScriptUk: textSchema,
      },
      ['briefingScriptUk'],
    ),
  ),
});

const deepAnalysisSchema = objectSchema(
  {
    hydrogen_insight: textSchema,
    refined_why_it_matters: textSchema,
    skepticism_note: textSchema,
  },
  ['refined_why_it_matters', 'skepticism_note'],
);

@Injectable()
export class GeminiEditorService {
  static lastAiError: string | null = null;
  private static dailyDirectiveCache: {
    text: string;
    updatedAt: number;
    modelUsed: string | null;
  } | null = null;

  private readonly logger = new Logger(GeminiEditorService.name);
  private readonly prompt = readFileSync(join(__dirname, 'editorial-prompt.md'), 'utf8');
  private readonly model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  private readonly key = process.env.GEMINI_API_KEY?.trim();
  private readonly research = process.env.GEMINI_RESEARCH === 'strict';
  private activeDirectiveRefresh?: Promise<{
    directive: string | null;
    cached: boolean;
    updatedAt: string | null;
    modelUsed: string | null;
  }>;

  constructor(@Optional() private readonly db?: DatabaseService) {}

  static resetHydrogenDirectiveCacheForTests(): void {
    GeminiEditorService.dailyDirectiveCache = null;
  }

  private get activeKey(): string | undefined {
    return this.key || process.env.GEMINI_API_KEY?.trim();
  }

  get enabled() {
    return !!this.activeKey;
  }

  private input(source: SourceDto, item: ArticleDto) {
    return {
      company: source.name,
      homepage: source.homepageUrl,
      feed: source.feedUrl,
      unofficial_feed: source.unofficial ?? false,
      title: item.originalTitle,
      url: item.url,
      published_at: item.publishedAt,
      available_excerpt: item.originalSummary,
    };
  }

  fingerprint(source: SourceDto, item: ArticleDto) {
    return createHash('sha256')
      .update(JSON.stringify([this.prompt, this.model, this.research, EDITORIAL_ARTICLE_SCHEMA, this.input(source, item)]))
      .digest('hex');
  }

  async collectArticleEvidencePack(
    source: SourceDto,
    item: ArticleDto,
    contextSnippet?: string,
    options?: { licenseMode?: LicenseMode; clusterSources?: ClusterSource[] },
  ): Promise<string> {
    const sections: string[] = [];
    const safePageUrl = publicHttpsUrl(item.url);
    const effectiveLicenseMode: LicenseMode =
      options?.licenseMode || source.licenseMode || 'headline_link';

    if (options?.clusterSources && options.clusterSources.length > 1) {
      const peerLines = options.clusterSources.map((src, idx) => {
        const excerpt = (src.summary || '').replace(/\s+/g, ' ').trim().slice(0, 450);
        return `[${idx + 1}] ${src.sourceName} (${src.url})${src.publishedAt ? ` [${src.publishedAt}]` : ''}:\n    Заголовок: ${src.titleUk || src.title}${excerpt ? `\n    Опис RSS: ${excerpt}` : ''}`;
      });
      sections.push(`MULTI_SOURCE_CLUSTER (${options.clusterSources.length} sources):\n${peerLines.join('\n')}`);
    }

    if (effectiveLicenseMode === 'headline_link') {
      sections.push(
        'SOURCE_LICENSE_POLICY: headline_link (full-page scraping disabled; use RSS title/excerpt, multi-source cluster context, and primary URL attribution only).',
      );
    } else if (safePageUrl) {
      try {
        const robotsResult = await checkRobotsTxtPermission(safePageUrl, {
          userAgent: getHonestUserAgent(),
        });
        if (!robotsResult.allowed) {
          sections.push(`SOURCE_PAGE_SKIPPED: ${robotsResult.reason || 'robots.txt disallow'}`);
        } else {
          const resp = await fetch(safePageUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(6_000),
            headers: {
              'User-Agent': getHonestUserAgent(),
              Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
            },
          });
          if (resp.ok) {
            const headerCheck = checkHttpRobotsAndTdmHeaders(resp.headers);
            if (!headerCheck.allowed) {
              await resp.body?.cancel();
              sections.push(`SOURCE_PAGE_SKIPPED: ${headerCheck.reason}`);
            } else {
              const contentType = resp.headers.get('content-type') || '';
              if (!contentType || /(html|text|xml|json)/i.test(contentType)) {
                const rawHtml = (await resp.text()).slice(0, 180_000);
                const metaCheck = checkHtmlRobotsAndTdmMeta(rawHtml);
                if (!metaCheck.allowed) {
                  sections.push(`SOURCE_PAGE_SKIPPED: ${metaCheck.reason}`);
                } else {
                  const maxChars = effectiveLicenseMode === 'full_text_licensed' ? 5_500 : 1_800;
                  const cleanText = stripHtmlToCleanText(rawHtml).slice(0, maxChars);
                  if (cleanText) {
                    sections.push(`SOURCE_PAGE_TEXT (max ${maxChars} chars):\n${cleanText}`);
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        this.logger.debug(
          `Pre-fetch page skipped for ${safePageUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (this.db) {
      try {
        const recentRes = await this.db.query<{
          title_uk: string | null;
          original_title: string;
          published_at: Date | string | null;
        }>(
          `SELECT n.title_uk, n.original_title, n.published_at
           FROM news_items n
           JOIN sources s ON s.id = n.source_id
           WHERE s.slug = $1
             AND n.status = 'published'
             AND n.external_id <> $2
           ORDER BY n.published_at DESC NULLS LAST, n.id DESC
           LIMIT 3`,
          [source.slug, item.externalId],
        );
        if (recentRes.rows.length > 0) {
          const lines = recentRes.rows.map((row) => {
            const dateStr = row.published_at ? new Date(row.published_at).toISOString().slice(0, 10) : 'n/a';
            return `- [${dateStr}] ${row.title_uk || row.original_title}`;
          });
          sections.push(`RECENT_COMPANY_HEADLINES (${source.name}):\n${lines.join('\n')}`);
        }
      } catch {
        // Optional DB context; skip silently on error or minimal mocks
      }

      try {
        const catalogRes = await this.db.query<{
          name: string;
          provider_id: string;
          pricing_summary_uk: string | null;
          price_in: string | null;
          price_out: string | null;
        }>(
          `SELECT name, provider_id, pricing_summary_uk,
                  specs->>'price_input_1m' AS price_in,
                  specs->>'price_output_1m' AS price_out
           FROM ai_catalogs
           WHERE entity_type = 'model'
           ORDER BY worth_score DESC, updated_at DESC
           LIMIT 5`,
        );
        if (catalogRes.rows.length > 0) {
          const lines = catalogRes.rows.map((row) => {
            const prices =
              row.price_in || row.price_out
                ? `in=${row.price_in || '?'}, out=${row.price_out || '?'}`
                : row.pricing_summary_uk || 'n/a';
            return `- ${row.name} (${row.provider_id}): ${prices}`;
          });
          sections.push(`CATALOG_MODEL_BENCHMARK_PRICING:\n${lines.join('\n')}`);
        }
      } catch {
        // Optional DB context
      }
    }

    if (contextSnippet?.trim()) {
      sections.push(`EXTRA_CONTEXT:\n${contextSnippet.trim().slice(0, 2_000)}`);
    }

    return sections.join('\n\n');
  }

  async refreshDailyHydrogenDirective(force = false): Promise<{
    directive: string | null;
    cached: boolean;
    updatedAt: string | null;
    modelUsed: string | null;
  }> {
    const now = Date.now();
    const cached = GeminiEditorService.dailyDirectiveCache;
    if (!force && cached && now - cached.updatedAt < DAILY_DIRECTIVE_TTL_MS) {
      return {
        directive: cached.text,
        cached: true,
        updatedAt: new Date(cached.updatedAt).toISOString(),
        modelUsed: cached.modelUsed,
      };
    }

    if (!this.activeKey || !canUseHydrogenQuota()) {
      return {
        directive: cached?.text ?? null,
        cached: Boolean(cached),
        updatedAt: cached ? new Date(cached.updatedAt).toISOString() : null,
        modelUsed: cached?.modelUsed ?? null,
      };
    }

    if (this.activeDirectiveRefresh) {
      return this.activeDirectiveRefresh;
    }

    this.activeDirectiveRefresh = (async () => {
      try {
        let recentNewsSummary = 'Свіжих новин у базі ще мало.';
        let topModelsSummary = 'Орієнтуйся на актуальні ціни OpenAI, Anthropic, Google Gemini та відкриті моделі.';

        if (this.db) {
          try {
            const newsRes = await this.db.query<{
              title_uk: string | null;
              original_title: string;
              summary_uk: string | null;
              category: string;
            }>(
              `SELECT title_uk, original_title, summary_uk, category
               FROM news_items
               WHERE status = 'published'
               ORDER BY published_at DESC NULLS LAST, id DESC
               LIMIT 5`,
            );
            if (newsRes.rows.length > 0) {
              recentNewsSummary = newsRes.rows
                .map((row) => `- [${row.category}] ${row.title_uk || row.original_title}: ${(row.summary_uk || '').slice(0, 180)}`)
                .join('\n');
            }
          } catch {
            // Keep default summary on DB error
          }

          try {
            const catalogRes = await this.db.query<{
              name: string;
              provider_id: string;
              pricing_summary_uk: string | null;
            }>(
              `SELECT name, provider_id, pricing_summary_uk
               FROM ai_catalogs
               WHERE entity_type = 'model'
               ORDER BY worth_score DESC, updated_at DESC
               LIMIT 5`,
            );
            if (catalogRes.rows.length > 0) {
              topModelsSummary = catalogRes.rows
                .map((row) => `- ${row.name} (${row.provider_id}): ${row.pricing_summary_uk || 'ціни уточнюються'}`)
                .join('\n');
            }
          } catch {
            // Keep default summary on DB error
          }
        }

        const response = await postGeminiGenerateContent({
          apiKey: this.activeKey!,
          preferredModel: DEFAULT_HYDROGEN_MODEL,
          candidateModels: [DEFAULT_HYDROGEN_MODEL],
          timeoutMs: 35_000,
          body: {
            systemInstruction: {
              parts: [
                {
                  text: 'Ти головний редактор універсального новинного медіа (політика, закони, економіка й особисті фінанси, кар’єра, наука й космос, здоров’я й психологія, культура та технології). Склади стислу щоденну редакційну директиву українською (180-320 слів) у plain text без води.',
                },
              ],
            },
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: [
                      'Проаналізуй останні новини та сформуй компактну редакційну директиву на сьогодні:',
                      '1) Головний фокус дня — політичні, правові, економічні, наукові, медичні й культурні наслідки для людей, не зациклюючись лише на ШІ;',
                      '2) Типові кліше, маніпулятивні заголовки та маркетинговий шум, які треба жорстко вирізати;',
                      '3) Які конкретні цифри (ставки, курси, дати набрання чинності законів, умови досліджень) варто перевіряти.',
                      '',
                      `Останні новини:\n${recentNewsSummary}`,
                      '',
                      `Довідковий технологічний контекст:\n${topModelsSummary}`,
                    ].join('\n'),
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.25,
              maxOutputTokens: 1000,
            },
          },
        });

        const directiveText = extractCandidateText(response.data).trim();
        if (!directiveText) {
          throw new Error('Empty Hydrogen directive');
        }

        const updatedAtMs = Date.now();
        GeminiEditorService.dailyDirectiveCache = {
          text: directiveText.slice(0, 3_000),
          updatedAt: updatedAtMs,
          modelUsed: response.modelUsed,
        };
        return {
          directive: GeminiEditorService.dailyDirectiveCache.text,
          cached: false,
          updatedAt: new Date(updatedAtMs).toISOString(),
          modelUsed: response.modelUsed,
        };
      } catch (error) {
        this.logger.warn(
          `Hydrogen daily directive refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          directive: GeminiEditorService.dailyDirectiveCache?.text ?? null,
          cached: Boolean(GeminiEditorService.dailyDirectiveCache),
          updatedAt: GeminiEditorService.dailyDirectiveCache
            ? new Date(GeminiEditorService.dailyDirectiveCache.updatedAt).toISOString()
            : null,
          modelUsed: GeminiEditorService.dailyDirectiveCache?.modelUsed ?? null,
        };
      } finally {
        this.activeDirectiveRefresh = undefined;
      }
    })();

    return this.activeDirectiveRefresh;
  }

  async planBatchAnglesWithHydrogen(
    items: Array<{
      externalId: string;
      sourceName: string;
      originalTitle: string;
      originalSummary?: string;
      url: string;
    }>,
  ): Promise<Record<string, BatchAngleHint>> {
    const batch = items.slice(0, 10);
    if (batch.length === 0 || !this.activeKey || !canUseHydrogenQuota()) {
      return {};
    }

    try {
      const response = await postGeminiGenerateContent({
        apiKey: this.activeKey,
        preferredModel: DEFAULT_HYDROGEN_MODEL,
        candidateModels: [DEFAULT_HYDROGEN_MODEL],
        timeoutMs: 40_000,
        body: {
          systemInstruction: {
            parts: [
              {
                text: 'Ти шеф-редактор багатогалузевого новинного медіа (Україна та світ, закони, фінанси, наука, здоров’я, психологія, культура, технології). Для кожного RSS-анонсу задай чіткий редакторський кут, скептичне питання, з чим порівняти та чи варто підсилити пріоритет (boostImportant). Відповідай українською суворо у JSON.',
              },
            ],
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: JSON.stringify({
                    items: batch.map((entry) => ({
                      externalId: entry.externalId,
                      source: entry.sourceName,
                      title: entry.originalTitle,
                      summary: (entry.originalSummary || '').slice(0, 400),
                      url: entry.url,
                    })),
                  }),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: 'application/json',
            responseJsonSchema: batchAngleSchema,
            maxOutputTokens: 3000,
          },
        },
      });

      const parsed = extractJsonPayload(extractCandidateText(response.data)) as {
        items?: Array<Record<string, unknown>>;
      };
      const out: Record<string, BatchAngleHint> = {};
      for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
        const externalId = typeof entry.externalId === 'string' ? entry.externalId.trim() : '';
        if (!externalId || !batch.some((candidate) => candidate.externalId === externalId)) continue;
        out[externalId] = {
          externalId,
          angleUk: sanitizeShortText(entry.angleUk, 400) || 'Практичний інженерний вплив та обмеження релізу',
          skepticQuestionUk: sanitizeShortText(entry.skepticQuestionUk, 400) || 'Які незалежні тести підтверджують заявлені цифри?',
          compareWithUk: sanitizeShortText(entry.compareWithUk, 300) || 'Найближчі комерційні та open-weight аналоги',
          boostImportant: Boolean(entry.boostImportant),
        };
      }
      return out;
    } catch (error) {
      this.logger.warn(
        `Hydrogen batch angle planner skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }

  async polishArticlesBatchWithHydrogen(limit = 12): Promise<PolishBatchResult> {
    const safeLimit = Math.max(1, Math.min(12, Math.floor(limit)));
    if (!this.db || !this.activeKey || !canUseHydrogenQuota()) {
      return { polishedCount: 0, skippedCount: 0, modelUsed: null, items: [] };
    }

    const { rows } = await this.db.query<{
      id: string;
      external_id: string;
      url: string;
      original_title: string;
      title_uk: string | null;
      summary_uk: string | null;
      why_it_matters: string | null;
      category: string;
      importance: string;
      source_name: string;
    }>(
      `SELECT n.id::text, n.external_id, n.url, n.original_title, n.title_uk, n.summary_uk,
              n.why_it_matters, n.category, n.importance, s.name AS source_name
       FROM news_items n
       JOIN sources s ON s.id = n.source_id
       WHERE n.status IN ('published', 'needs_review')
         AND COALESCE(n.ai_metadata->>'hydrogen_polished', 'false') <> 'true'
       ORDER BY n.published_at DESC NULLS LAST, n.id DESC
       LIMIT $1`,
      [safeLimit],
    );

    if (rows.length === 0) {
      return { polishedCount: 0, skippedCount: 0, modelUsed: null, items: [] };
    }

    const response = await postGeminiGenerateContent({
      apiKey: this.activeKey,
      preferredModel: DEFAULT_HYDROGEN_MODEL,
      candidateModels: [DEFAULT_HYDROGEN_MODEL],
      timeoutMs: 50_000,
      body: {
        systemInstruction: {
          parts: [
            {
              text: [
                'Ти шеф-редактор універсального новинного медіа (Gemini 4 Hydrogen). Вичитай і вдоскональ пакетом до 12 новинних матеріалів українською.',
                'Зроби заголовки (titleUk) конкретними без клікбейту, summaryUk стислим і чітким без повторення заголовку, whyItMatters практичним для громадян, фінансів, здоров’я чи роботи, а в hydrogenInsightUk додай 1-2 тверезих інсайта без води.',
                'Також у полі briefingScriptUk напиши окремий цілісний дикторський текст для аудіо-брифінгу (55-85 слів) так, щоб він не повторював заголовок в описі та не містив заголовків рубрик на кшталт «Практичне значення:», «Чому це важливо:», «Факти:».',
                'Не вигадуй нових цифр чи фактів, яких немає у вхідних даних. Поверни суворий JSON.',
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
                  items: rows.map((row) => ({
                    id: String(row.id),
                    source: row.source_name,
                    category: row.category,
                    importance: row.importance,
                    originalTitle: row.original_title,
                    titleUk: row.title_uk || row.original_title,
                    summaryUk: row.summary_uk || '',
                    whyItMatters: row.why_it_matters || '',
                    url: row.url,
                  })),
                }),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.25,
          responseMimeType: 'application/json',
          responseJsonSchema: batchPolishSchema,
          maxOutputTokens: 6000,
        },
      },
    });

    const parsed = extractJsonPayload(extractCandidateText(response.data)) as {
      items?: Array<Record<string, unknown>>;
    };
    const candidates = Array.isArray(parsed?.items) ? parsed.items : [];
    const allowedIds = new Set(rows.map((row) => String(row.id)));
    const polishedItems: PolishBatchItemResult[] = [];
    let skippedCount = 0;

    for (const entry of candidates) {
      const id = typeof entry.id === 'string' ? entry.id.trim() : String(entry.id ?? '').trim();
      const titleUk = sanitizeShortText(entry.titleUk, 350);
      const summaryUk = sanitizeShortText(entry.summaryUk, 2500);
      const whyItMatters = sanitizeShortText(entry.whyItMatters, 1500);
      const hydrogenInsightUk = sanitizeShortText(entry.hydrogenInsightUk, 1200);
      const briefingScriptUk = sanitizeShortText(entry.briefingScriptUk, 2500);

      if (!id || !allowedIds.has(id) || !titleUk || !summaryUk || !whyItMatters || !hydrogenInsightUk) {
        skippedCount += 1;
        continue;
      }

      await this.db.query(
        `UPDATE news_items
         SET title_uk = $2,
             summary_uk = $3,
             why_it_matters = $4,
             ai_metadata = COALESCE(ai_metadata, '{}'::jsonb) || jsonb_build_object(
               'hydrogen_polished', true,
               'hydrogen_polished_at', to_jsonb(now()::text),
               'hydrogen_polish_model', $5::text,
               'hydrogen_insight', $6::text
             ) || CASE WHEN $7::text IS NOT NULL THEN jsonb_build_object('briefing_script', $7::text) ELSE '{}'::jsonb END,
             updated_at = now()
         WHERE id::text = $1`,
        [id, titleUk, summaryUk, whyItMatters, response.modelUsed, hydrogenInsightUk, briefingScriptUk ?? null],
      );

      polishedItems.push({
        id,
        titleUk,
        summaryUk,
        whyItMatters,
        hydrogenInsightUk,
        ...(briefingScriptUk ? { briefingScriptUk } : {}),
      });
    }

    if (candidates.length < rows.length) {
      skippedCount += rows.length - candidates.length;
    }

    return {
      polishedCount: polishedItems.length,
      skippedCount,
      modelUsed: response.modelUsed,
      items: polishedItems,
    };
  }

  async edit(
    source: SourceDto,
    item: ArticleDto,
    fingerprint: string,
    options?: EditArticleOptions,
  ): Promise<ArticleDto> {
    try {
      const [evidencePack, directiveResult] = await Promise.all([
        this.collectArticleEvidencePack(source, item, options?.contextSnippet, {
          licenseMode: options?.licenseMode || source.licenseMode,
          clusterSources: options?.clusterSources,
        }),
        this.refreshDailyHydrogenDirective(false).catch(() => ({
          directive: null,
          cached: false,
          updatedAt: null,
          modelUsed: null,
        })),
      ]);

      const systemText = directiveResult.directive
        ? `${this.prompt}\n\nЩоденна редакційна директива:\n${directiveResult.directive}`
        : this.prompt;

      const userPayload: Record<string, unknown> = {
        ...this.input(source, item),
        license_mode: options?.licenseMode || source.licenseMode || 'headline_link',
        ...(options?.clusterSources && options.clusterSources.length > 1
          ? {
              cluster_sources: options.clusterSources.map(cs => ({
                source_name: cs.sourceName,
                title: cs.titleUk || cs.title,
                url: cs.url,
                published_at: cs.publishedAt,
                excerpt: cs.summary || null,
              })),
            }
          : {}),
        ...(evidencePack ? { evidence_pack: evidencePack } : {}),
        ...(options?.angleHint ? { editorial_angle_hint: options.angleHint } : {}),
      };

      const requestBody = (useTools: boolean) => ({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(userPayload) }] }],
        tools: useTools ? [{ googleSearch: {} }, { urlContext: {} }] : undefined,
        generationConfig: useTools
          ? { maxOutputTokens: 12000 }
          : { responseMimeType: 'application/json', responseJsonSchema: EDITORIAL_ARTICLE_SCHEMA, maxOutputTokens: 12000 },
      });

      const useToolsInitially = this.research && supportsSearchTools(this.model);

      let result = await postGeminiGenerateContent({
        apiKey: this.activeKey!,
        preferredModel: this.model,
        timeoutMs: 65_000,
        jsonSchemaWhenNoTools: EDITORIAL_ARTICLE_SCHEMA,
        body: requestBody(useToolsInitially),
      });
      let candidate = (result.data as GeminiResponse).candidates?.[0];
      if (candidate?.finishReason !== 'STOP') {
        throw new Error(`Gemini did not finish the article (${candidate?.finishReason || 'unknown'})`);
      }

      let rawOutput = extractCandidateText(result.data);
      let article: ReturnType<typeof validateArticle>;
      const extraClusterUrls = options?.clusterSources?.map(cs => ({
        title: `${cs.sourceName}: ${cs.title}`,
        url: cs.url,
      }));
      try {
        article = validateArticle(extractJsonPayload(rawOutput), item.url, extraClusterUrls);
      } catch {
        if (!useToolsInitially) throw new Error('Invalid editorial payload');
        // Fallback to strict JSON schema without tools if tool-assisted response failed JSON/schema validation
        result = await postGeminiGenerateContent({
          apiKey: this.activeKey!,
          preferredModel: this.model,
          timeoutMs: 65_000,
          jsonSchemaWhenNoTools: EDITORIAL_ARTICLE_SCHEMA,
          body: requestBody(false),
        });
        candidate = (result.data as GeminiResponse).candidates?.[0];
        if (candidate?.finishReason !== 'STOP') {
          throw new Error(`Gemini did not finish the article (${candidate?.finishReason || 'unknown'})`);
        }
        rawOutput = extractCandidateText(result.data);
        article = validateArticle(extractJsonPayload(rawOutput), item.url, extraClusterUrls);
      }

      let modelUsed = result.modelUsed;
      let hydrogenInsight = article.hydrogen_insight;
      let hydrogenDeepAnalysis = false;
      let finalWhyItMatters = article.importance_reason;

      const needsDeepHydrogenPass = Boolean(article.important || options?.angleHint?.boostImportant);
      if (needsDeepHydrogenPass && !/hydrogen/i.test(modelUsed) && this.activeKey && canUseHydrogenQuota()) {
        try {
          const deepRes = await postGeminiGenerateContent({
            apiKey: this.activeKey,
            preferredModel: DEFAULT_HYDROGEN_MODEL,
            candidateModels: [DEFAULT_HYDROGEN_MODEL],
            timeoutMs: 35_000,
            body: {
              systemInstruction: {
                parts: [
                  {
                    text: 'Ти аналітик Gemini 4 Hydrogen. Дай глибокий, скептичний та практичний інсайт українською до важливої новини дня (політика, економіка, право, наука, здоров’я, культура чи технології), не вигадуючи неіснуючих фактів.',
                  },
                ],
              },
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      text: JSON.stringify({
                        title: article.title,
                        summary: article.summary,
                        importance_reason: article.importance_reason,
                        facts: article.facts,
                        comparisons: article.comparisons,
                        angle_hint: options?.angleHint,
                      }),
                    },
                  ],
                },
              ],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
                responseJsonSchema: deepAnalysisSchema,
                maxOutputTokens: 1500,
              },
            },
          });
          const deepParsed = extractJsonPayload(extractCandidateText(deepRes.data)) as Record<string, unknown>;
          const deepInsight = sanitizeShortText(deepParsed?.hydrogen_insight, 1500);
          const refinedWhy = sanitizeShortText(deepParsed?.refined_why_it_matters, 1500);
          if (deepInsight) {
            hydrogenInsight = deepInsight;
            hydrogenDeepAnalysis = true;
            if (refinedWhy) {
              finalWhyItMatters = refinedWhy;
            }
          }
        } catch (deepErr) {
          this.logger.warn(
            `Hydrogen deep analysis pass skipped for ${item.externalId}: ${deepErr instanceof Error ? deepErr.message : String(deepErr)}`,
          );
        }
      } else if (needsDeepHydrogenPass && /hydrogen/i.test(modelUsed)) {
        hydrogenDeepAnalysis = true;
      }

      const grounding = (candidate.groundingMetadata?.groundingChunks ?? [])
        .flatMap((chunk) => {
          const url = httpsUrl(chunk.web?.uri);
          return url ? [{ url, title: (chunk.web?.title || '').slice(0, 200) }] : [];
        })
        .slice(0, 20);
      GeminiEditorService.lastAiError = null;
      return {
        ...item,
        titleUk: article.title,
        summaryUk: article.summary,
        whyItMatters: finalWhyItMatters,
        category: article.category,
        importance: article.important ? 'high' : 'low',
        freeAccess: 'unknown',
        aiMetadata: {
          editorial_fingerprint: fingerprint,
          model: modelUsed,
          researched: grounding.length > 0,
          grounding,
          article,
          ...(hydrogenInsight ? { hydrogen_insight: hydrogenInsight } : {}),
          ...(article.briefing_script ? { briefing_script: article.briefing_script } : {}),
          ...(hydrogenDeepAnalysis ? { hydrogen_deep_analysis: true } : {}),
          ...(options?.angleHint ? { angle_hint: options.angleHint } : {}),
        },
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      GeminiEditorService.lastAiError = rawMessage;
      this.logger.warn(`Gemini editorial failed for ${source.slug}/${item.externalId}: ${rawMessage}`);
      const message = /^Gemini HTTP \d+/.test(rawMessage)
        ? rawMessage
        : 'Gemini editorial response unavailable or invalid';
      throw new ServiceUnavailableException(message);
    }
  }
}

function extractCandidateText(data: unknown): string {
  const candidate = (data as GeminiResponse)?.candidates?.[0];
  return (
    candidate?.content?.parts
      ?.filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('') || ''
  );
}

function extractJsonPayload(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const target = fenced ? fenced[1].trim() : raw;
  const firstBrace = target.indexOf('{');
  const lastBrace = target.lastIndexOf('}');
  const slice = firstBrace >= 0 && lastBrace > firstBrace ? target.slice(firstBrace, lastBrace + 1) : target;
  return JSON.parse(slice);
}

function stripHtmlToCleanText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeShortText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function httpsUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return;
  const url = URL.parse(value);
  if (url?.protocol === 'https:' && !url.username && !url.password) return url.href;
}

function publicHttpsUrl(value: unknown): string | undefined {
  const href = httpsUrl(value);
  if (!href) return undefined;
  const parsed = URL.parse(href);
  if (!parsed) return undefined;
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return undefined;
  }
  return href;
}

export function validateArticle(
  raw: unknown,
  originalUrl: string,
  extraClusterSources?: Array<{ title: string; url: string }>,
) {
  function object(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
    return value as Record<string, unknown>;
  }
  function text(value: unknown, max: number, empty = false) {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error('Invalid editorial text');
    return value.trim();
  }
  function choice<T extends string>(value: unknown, options: readonly T[]) {
    const selected = options.find((option) => option === value);
    if (!selected) throw new Error('Invalid editorial value');
    return selected;
  }
  function list<T>(value: unknown, max: number, parse: (entry: unknown) => T) {
    if (!Array.isArray(value) || value.length > max) throw new Error('Invalid editorial list');
    return value.map(parse);
  }
  const a = object(raw);
  if (typeof a.important !== 'boolean') throw new Error('Invalid importance');
  const sources = list(a.sources, 12, (entry) => {
    const s = object(entry);
    const url = httpsUrl(s.url);
    if (!url) throw new Error('Invalid source URL');
    return { title: text(s.title, 240), url };
  });
  const original = httpsUrl(originalUrl);
  if (!original) throw new Error('Invalid original URL');
  if (!sources.some((source) => source.url === original)) sources.unshift({ title: 'Першоджерело', url: original });
  if (Array.isArray(extraClusterSources)) {
    for (const extra of extraClusterSources) {
      const safeExtraUrl = httpsUrl(extra.url);
      if (safeExtraUrl && sources.length < 12 && !sources.some(s => s.url === safeExtraUrl)) {
        sources.push({ title: sanitizeShortText(extra.title, 240) || 'Додаткове джерело', url: safeExtraUrl });
      }
    }
  }
  const facts = list(a.facts, 16, (entry) => {
    const fact = object(entry);
    const url = httpsUrl(fact.url);
    if (!url || !sources.some((source) => source.url === url)) throw new Error('Fact source is missing');
    return { claim: text(fact.claim, 750), status: choice(fact.status, evidence), url };
  });
  const editorial = object(a.editorial);
  const hydrogenInsight = sanitizeShortText(a.hydrogen_insight, 1500);
  const briefingScript = sanitizeShortText(a.briefing_script, 2500);
  return {
    title: text(a.title, 350),
    summary: text(a.summary, 2500),
    body: text(a.body, 16000),
    important: a.important,
    importance_reason: text(a.importance_reason, 1500),
    category: choice(a.category, CATEGORIES),
    sources,
    facts,
    comparisons: list(a.comparisons, 10, (entry) => text(entry, 1200)),
    confidence: choice(a.confidence, confidence),
    editorial: {
      angles: list(editorial.angles, 10, (entry) => text(entry, 100)),
      style: text(editorial.style, 200),
      limitations: text(editorial.limitations, 2000, true),
    },
    ...(hydrogenInsight ? { hydrogen_insight: hydrogenInsight } : {}),
    ...(briefingScript ? { briefing_script: briefingScript } : {}),
  };
}
