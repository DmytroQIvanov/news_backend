import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isTransientHttpStatus, retryWithBackoff } from '../common/url-utils';
import { DatabaseService } from '../database/database.service';
import {
  type AiCatalogItem,
  type CatalogChangeItem,
  INITIAL_CATALOG,
  type ModelDetail,
  type Promotion,
  type ProviderConfig,
  PROVIDERS_CONFIG,
} from './catalog-seed';

export type {
  AiCatalogItem,
  CatalogChangeItem,
  FreeTierInfo,
  ModelDetail,
  Promotion,
} from './catalog-seed';

const catalogItemSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    tagline: { type: 'string' },
    models: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          contextWindow: { type: 'string' },
          contextTokens: { type: 'integer' },
          inputPrice: { type: 'string' },
          outputPrice: { type: 'string' },
          capabilities: { type: 'array', items: { type: 'string' } },
          bestFor: { type: 'string' },
          strengths: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'contextWindow', 'bestFor', 'strengths'],
      },
    },
    freeTier: {
      type: 'object',
      properties: {
        hasFree: { type: 'boolean' },
        limits: { type: 'string' },
        description: { type: 'string' },
        renewPeriod: { type: 'string' },
      },
      required: ['hasFree', 'limits', 'description', 'renewPeriod'],
    },
    currentPromotions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          badge: { type: 'string' },
          description: { type: 'string' },
          expires: { type: 'string' },
          eligible: { type: 'string' },
        },
        required: ['title', 'badge', 'description', 'eligible'],
      },
    },
    advantages: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
    pricingSummary: { type: 'string' },
  },
  required: [
    'title',
    'tagline',
    'models',
    'freeTier',
    'currentPromotions',
    'advantages',
    'limitations',
    'pricingSummary',
  ],
};

export function isPromotionExpired(promo: Promotion, now = new Date()): boolean {
  if (!promo.expires) return false;
  const parsed = Date.parse(promo.expires);
  if (!Number.isFinite(parsed)) return false;
  return parsed < now.getTime();
}

export function diffCatalogItems(
  prev: AiCatalogItem | undefined,
  next: AiCatalogItem,
  sourceUrl: string,
): Array<{ changeType: string; fieldName: string; summary: string; sourceUrl: string; confidence: 'confirmed' | 'company_claim' | 'unverified' }> {
  if (!prev) return [];
  const changes: Array<{ changeType: string; fieldName: string; summary: string; sourceUrl: string; confidence: 'confirmed' | 'company_claim' | 'unverified' }> = [];

  const prevModels = new Set(prev.models.map(m => m.name.toLowerCase()));
  const addedModels = next.models.filter(m => !prevModels.has(m.name.toLowerCase()));
  if (addedModels.length > 0) {
    changes.push({
      changeType: 'model_added',
      fieldName: 'models',
      summary: `Додано моделі: ${addedModels.map(m => m.name).join(', ')}`,
      sourceUrl,
      confidence: 'confirmed',
    });
  }

  if (prev.freeTier.limits !== next.freeTier.limits || prev.freeTier.hasFree !== next.freeTier.hasFree) {
    changes.push({
      changeType: 'free_tier_updated',
      fieldName: 'freeTier',
      summary: `Оновлено умови Free Tier: ${next.freeTier.limits.slice(0, 180)}`,
      sourceUrl,
      confidence: 'confirmed',
    });
  }

  if (prev.pricingSummary !== next.pricingSummary) {
    changes.push({
      changeType: 'pricing_updated',
      fieldName: 'pricingSummary',
      summary: `Оновлено тарифи: ${next.pricingSummary.slice(0, 180)}`,
      sourceUrl,
      confidence: 'confirmed',
    });
  }

  const prevPromos = new Set(prev.currentPromotions.map(p => p.title.toLowerCase()));
  const addedPromos = next.currentPromotions.filter(p => !prevPromos.has(p.title.toLowerCase()));
  if (addedPromos.length > 0) {
    changes.push({
      changeType: 'promotion_added',
      fieldName: 'currentPromotions',
      summary: `Нові пропозиції: ${addedPromos.map(p => p.title).join(', ')}`,
      sourceUrl,
      confidence: 'company_claim',
    });
  }

  return changes;
}

@Injectable()
export class CatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogService.name);
  private checkTimer?: NodeJS.Timeout;
  private isDestroyed = false;
  private activeSync?: Promise<{ success: boolean; updated: string[]; skipped: string[] }>;
  private readonly geminiKey = process.env.GEMINI_API_KEY?.trim();
  private readonly geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-2.0-flash-lite';

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit() {
    await this.ensureInitialSeed();

    const intervalMs = 60 * 60_000;
    const scheduleCheck = () => {
      this.checkTimer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.syncAndVerifyAll(false);
        } catch (error) {
          this.logger.warn(`Catalog auto-verify cycle failed: ${error instanceof Error ? error.message : error}`);
        } finally {
          if (!this.isDestroyed) scheduleCheck();
        }
      }, intervalMs);
    };

    // First background check 15 seconds after server starts
    this.checkTimer = setTimeout(async () => {
      if (this.isDestroyed) return;
      try {
        await this.syncAndVerifyAll(false);
      } catch (error) {
        this.logger.warn(`Initial catalog sync failed: ${error instanceof Error ? error.message : error}`);
      } finally {
        if (!this.isDestroyed) scheduleCheck();
      }
    }, 15_000);
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.checkTimer) clearTimeout(this.checkTimer);
  }

  async getAll(filters?: { q?: string; category?: string; hasFree?: boolean }): Promise<AiCatalogItem[]> {
    let items: AiCatalogItem[] = [];
    try {
      const { rows } = await this.db.query<AiCatalogItem & { pricingDocUrl?: string }>(`
        SELECT id, provider_id AS "providerId", provider_name AS "providerName",
               category, title, tagline, models, free_tier AS "freeTier",
               current_promotions AS "currentPromotions", advantages, limitations,
               pricing_summary AS "pricingSummary", official_url AS "officialUrl",
               pricing_doc_url AS "pricingDocUrl", last_verified_at AS "lastVerifiedAt"
        FROM ai_catalogs
        ORDER BY CASE
          WHEN provider_id = 'gemini' THEN 1
          WHEN provider_id = 'claude' THEN 2
          WHEN provider_id = 'openai' THEN 3
          WHEN provider_id = 'mistral' THEN 4
          WHEN provider_id = 'huggingface' THEN 5
          WHEN provider_id = 'grok' THEN 6
          WHEN provider_id = 'perplexity' THEN 7
          ELSE 8 END, id
      `);
      if (rows && rows.length > 0) {
        items = rows;
      }
    } catch {
      // Fallback to seed if DB table is not ready
    }
    if (!items.length) items = INITIAL_CATALOG;

    const now = new Date();
    const staleThresholdMs = 7 * 24 * 60 * 60_000;
    let normalized = items.map(item => {
      const verifiedMs = Date.parse(item.lastVerifiedAt);
      const isOutdated = !Number.isFinite(verifiedMs) || (now.getTime() - verifiedMs > staleThresholdMs);
      const activePromos = (item.currentPromotions || [])
        .map(p => ({ ...p, isExpired: isPromotionExpired(p, now) }))
        .filter(p => !p.isExpired);

      return {
        ...item,
        currentPromotions: activePromos,
        verificationStatus: (isOutdated ? 'outdated' : 'confirmed') as 'confirmed' | 'outdated',
      };
    });

    if (filters?.category) {
      const cat = filters.category.toLowerCase();
      normalized = normalized.filter(i => i.category.toLowerCase().includes(cat));
    }
    if (filters?.hasFree) {
      normalized = normalized.filter(i => i.freeTier?.hasFree);
    }
    if (filters?.q) {
      const q = filters.q.toLowerCase();
      normalized = normalized.filter(i =>
        i.providerName.toLowerCase().includes(q) ||
        i.title.toLowerCase().includes(q) ||
        i.tagline.toLowerCase().includes(q) ||
        i.models.some(m => m.name.toLowerCase().includes(q) || m.bestFor.toLowerCase().includes(q)) ||
        i.currentPromotions.some(p => p.title.toLowerCase().includes(q)),
      );
    }
    return normalized;
  }

  async getByProvider(providerId: string): Promise<AiCatalogItem | null> {
    const all = await this.getAll();
    const item = all.find(c => c.providerId.toLowerCase() === providerId.toLowerCase());
    if (!item) return null;
    const recentChanges = await this.getRecentChanges(item.providerId, 15);
    return { ...item, recentChanges };
  }

  async getModels(filters?: { q?: string; providerId?: string; capability?: string; minContext?: number }) {
    const all = await this.getAll();
    let models = all.flatMap(provider =>
      (provider.models || []).map((model: ModelDetail) => ({
        id: `${provider.providerId}:${model.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        providerId: provider.providerId,
        providerName: provider.providerName,
        officialUrl: provider.officialUrl,
        pricingDocUrl: provider.pricingDocUrl,
        lastVerifiedAt: provider.lastVerifiedAt,
        hasFreeTier: provider.freeTier?.hasFree ?? false,
        ...model,
      })),
    );

    if (filters?.providerId) {
      const pid = filters.providerId.toLowerCase();
      models = models.filter(m => m.providerId.toLowerCase() === pid);
    }
    if (filters?.capability) {
      const cap = filters.capability.toLowerCase();
      models = models.filter(m => (m.capabilities || []).some(c => c.toLowerCase() === cap));
    }
    if (filters?.minContext) {
      models = models.filter(m => (m.contextTokens || 0) >= filters.minContext!);
    }
    if (filters?.q) {
      const q = filters.q.toLowerCase();
      models = models.filter(m =>
        m.name.toLowerCase().includes(q) ||
        m.providerName.toLowerCase().includes(q) ||
        m.bestFor.toLowerCase().includes(q) ||
        m.strengths.some(s => s.toLowerCase().includes(q)),
      );
    }
    return models;
  }

  async getPromotions(filters?: { q?: string; providerId?: string }) {
    const all = await this.getAll();
    let promos = all.flatMap(provider =>
      (provider.currentPromotions || []).map((promo, idx) => ({
        id: `${provider.providerId}:promo-${idx}`,
        providerId: provider.providerId,
        providerName: provider.providerName,
        officialUrl: provider.officialUrl,
        lastVerifiedAt: provider.lastVerifiedAt,
        ...promo,
      })),
    );
    if (filters?.providerId) {
      const pid = filters.providerId.toLowerCase();
      promos = promos.filter(p => p.providerId.toLowerCase() === pid);
    }
    if (filters?.q) {
      const q = filters.q.toLowerCase();
      promos = promos.filter(p =>
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.providerName.toLowerCase().includes(q),
      );
    }
    return promos;
  }

  async getRecentChanges(providerId?: string, limit = 30): Promise<CatalogChangeItem[]> {
    const safeLimit = Math.max(1, Math.min(100, limit));
    try {
      const { rows } = await this.db.query<CatalogChangeItem>(
        `SELECT id::text, provider_id AS "providerId", change_type AS "changeType",
                field_name AS "fieldName", summary, source_url AS "sourceUrl",
                confidence, detected_at AS "detectedAt"
         FROM ai_catalog_changes
         WHERE ($1::text IS NULL OR provider_id = $1)
         ORDER BY detected_at DESC
         LIMIT $2`,
        [providerId || null, safeLimit],
      );
      return rows;
    } catch {
      return [];
    }
  }

  async triggerRefresh(providerId?: string, force = false): Promise<{ success: boolean; updated: string[]; skipped: string[] }> {
    if (this.activeSync && !providerId) {
      return this.activeSync;
    }
    const run = async () => {
      const updated: string[] = [];
      const skipped: string[] = [];
      const targets = providerId
        ? PROVIDERS_CONFIG.filter(p => p.providerId.toLowerCase() === providerId.toLowerCase())
        : PROVIDERS_CONFIG;

      for (const cfg of targets) {
        const result = await this.parseAndRefineProviderWithGemini(cfg, force);
        if (result === 'updated') updated.push(cfg.providerId);
        else skipped.push(cfg.providerId);
      }
      return { success: true, updated, skipped };
    };

    if (!providerId) {
      this.activeSync = run().finally(() => { this.activeSync = undefined; });
      return this.activeSync;
    }
    return run();
  }

  /**
   * Called by the news pipeline when a new important article is published for a provider.
   * Performs an incremental evidence check without regenerating unchanged providers.
   */
  async notifyArticlePublished(providerId: string, articleTitle: string, articleUrl: string): Promise<void> {
    const cfg = PROVIDERS_CONFIG.find(p => p.providerId === providerId);
    if (!cfg) return;
    this.logger.log(`News-triggered encyclopedia check for [${providerId}] due to: "${articleTitle.slice(0, 70)}"`);
    await this.parseAndRefineProviderWithGemini(cfg, false, `[RECENT NEWS ${articleUrl}]: ${articleTitle}`);
  }

  private async ensureInitialSeed() {
    try {
      for (const item of INITIAL_CATALOG) {
        await this.db.query(`
          INSERT INTO ai_catalogs (
            id, provider_id, provider_name, category, title, tagline,
            models, free_tier, current_promotions, advantages, limitations,
            pricing_summary, official_url, pricing_doc_url, last_verified_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, now(), now())
          ON CONFLICT (id) DO NOTHING
        `, [
          item.id,
          item.providerId,
          item.providerName,
          item.category,
          item.title,
          item.tagline,
          JSON.stringify(item.models),
          JSON.stringify(item.freeTier),
          JSON.stringify(item.currentPromotions),
          JSON.stringify(item.advantages),
          JSON.stringify(item.limitations),
          item.pricingSummary,
          item.officialUrl,
          item.pricingDocUrl || item.officialUrl,
        ]);
      }
      this.logger.log(`AI Encyclopedia ready (${INITIAL_CATALOG.length} providers seeded).`);
    } catch (error) {
      this.logger.warn(`Could not seed ai_catalogs table: ${error instanceof Error ? error.message : error}`);
    }
  }

  async syncAndVerifyAll(force = false) {
    if (this.activeSync) return this.activeSync;
    this.activeSync = (async () => {
      this.logger.log('Starting incremental AI Encyclopedia verification cycle.');
      const updated: string[] = [];
      const skipped: string[] = [];

      let freshSet = new Set<string>();
      if (!force) {
        try {
          const { rows } = await this.db.query<{ id: string }>(
            `SELECT id FROM ai_catalogs WHERE last_verified_at > now() - interval '6 hours' AND evidence_hash IS NOT NULL`,
          );
          freshSet = new Set(rows.map(r => r.id));
        } catch { /* ignore if column not migrated yet */ }
      }

      for (const cfg of PROVIDERS_CONFIG) {
        if (this.isDestroyed) break;
        if (!force && freshSet.has(cfg.id)) {
          skipped.push(cfg.providerId);
          continue;
        }
        try {
          const res = await this.parseAndRefineProviderWithGemini(cfg, force);
          if (res === 'updated') updated.push(cfg.providerId);
          else skipped.push(cfg.providerId);
        } catch (err) {
          this.logger.warn(`Failed verifying provider ${cfg.providerId}: ${err instanceof Error ? err.message : err}`);
          skipped.push(cfg.providerId);
        }
      }
      this.logger.log(`Completed Encyclopedia verification: ${updated.length} updated, ${skipped.length} unchanged/skipped.`);
      return { success: true, updated, skipped };
    })().finally(() => { this.activeSync = undefined; });

    return this.activeSync;
  }

  private async parseAndRefineProviderWithGemini(
    cfg: ProviderConfig,
    force = false,
    extraContext?: string,
  ): Promise<'updated' | 'unchanged' | 'skipped'> {
    const evidence = await this.collectProviderEvidence(cfg, extraContext);
    const evidenceHash = createHash('sha256').update(evidence).digest('hex');

    // Check existing record and evidence_hash to avoid unnecessary Gemini calls
    let existingItem: AiCatalogItem | undefined;
    let existingHash: string | null = null;
    try {
      const { rows } = await this.db.query<AiCatalogItem & { evidence_hash: string | null }>(`
        SELECT id, provider_id AS "providerId", provider_name AS "providerName",
               category, title, tagline, models, free_tier AS "freeTier",
               current_promotions AS "currentPromotions", advantages, limitations,
               pricing_summary AS "pricingSummary", official_url AS "officialUrl",
               last_verified_at AS "lastVerifiedAt", evidence_hash
        FROM ai_catalogs WHERE id = $1 LIMIT 1
      `, [cfg.id]);
      if (rows[0]) {
        existingItem = rows[0];
        existingHash = rows[0].evidence_hash;
      }
    } catch { /* ignore */ }

    if (!force && existingHash === evidenceHash) {
      await this.db.query(`UPDATE ai_catalogs SET last_verified_at = now() WHERE id = $1`, [cfg.id]).catch(() => undefined);
      return 'unchanged';
    }

    if (!this.geminiKey) {
      await this.db.query(`UPDATE ai_catalogs SET last_verified_at = now() WHERE id = $1`, [cfg.id]).catch(() => undefined);
      return 'skipped';
    }

    try {
      const prompt = `Ти експерт-аналітик ринку штучного інтелекту. Твоє завдання — оновити структурований запис енциклопедії для провайдера "${cfg.providerName}" (${cfg.officialUrl}).

Використовуй ЛИШЕ факти з наведених нижче офіційних джерел. НЕ вигадуй ціни, ліміти чи акції, яких немає у джерелах. Якщо якась деталь не вказана, залиш попереднє підтверджене значення або вкажи, що умови уточнюються.

Зібрані матеріали з офіційних джерел:
---
${evidence.slice(0, 7500)}
---

Поточний запис у базі (для збереження підтверджених характеристик):
${JSON.stringify({
  title: existingItem?.title,
  models: existingItem?.models?.slice(0, 3),
  freeTier: existingItem?.freeTier,
  pricingSummary: existingItem?.pricingSummary,
}).slice(0, 2500)}

Поверни валідний JSON українською мовою за схемою. Для тимчасових акцій вказуй expires у форматі YYYY-MM-DD якщо дата відома.`;

      const parsed = await retryWithBackoff(
        async () => {
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.geminiModel)}:generateContent`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': this.geminiKey!,
              },
              signal: AbortSignal.timeout(65_000),
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                  responseMimeType: 'application/json',
                  responseJsonSchema: catalogItemSchema,
                  maxOutputTokens: 6000,
                },
              }),
            },
          );

          if (!response.ok) {
            await response.body?.cancel();
            const err = new Error(`Gemini HTTP ${response.status}`);
            (err as Error & { status?: number }).status = response.status;
            throw err;
          }

          const raw = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
          const textPart = raw.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!textPart) throw new Error('Empty Gemini response');
          return JSON.parse(textPart);
        },
        {
          maxAttempts: 2,
          baseDelayMs: 1500,
          shouldRetry: (err) => {
            const status = (err as { status?: number })?.status;
            return typeof status === 'number' ? isTransientHttpStatus(status) : false;
          },
        },
      );

      if (!parsed || typeof parsed.title !== 'string' || !Array.isArray(parsed.models)) {
        throw new Error('Invalid Gemini catalog structure');
      }

      const updatedItem: AiCatalogItem = {
        id: cfg.id,
        providerId: cfg.providerId,
        providerName: cfg.providerName,
        category: cfg.category,
        title: parsed.title || cfg.providerName,
        tagline: parsed.tagline || existingItem?.tagline || '',
        models: (parsed.models as ModelDetail[]).map(m => ({
          ...m,
          sourceUrl: cfg.pricingDocUrl,
          verificationStatus: 'confirmed',
        })),
        freeTier: {
          ...(parsed.freeTier || existingItem?.freeTier || { hasFree: false, limits: '', description: '', renewPeriod: '' }),
          sourceUrl: cfg.pricingDocUrl,
          verificationStatus: 'confirmed',
        },
        currentPromotions: ((parsed.currentPromotions || []) as Promotion[]).map(p => ({
          ...p,
          sourceUrl: cfg.officialUrl,
          verificationStatus: 'company_claim',
        })),
        advantages: Array.isArray(parsed.advantages) ? parsed.advantages : (existingItem?.advantages || []),
        limitations: Array.isArray(parsed.limitations) ? parsed.limitations : (existingItem?.limitations || []),
        pricingSummary: parsed.pricingSummary || existingItem?.pricingSummary || '',
        officialUrl: cfg.officialUrl,
        pricingDocUrl: cfg.pricingDocUrl,
        lastVerifiedAt: new Date().toISOString(),
      };

      const changes = diffCatalogItems(existingItem, updatedItem, cfg.pricingDocUrl);
      await this.saveToDatabase(updatedItem, evidenceHash);
      for (const change of changes) {
        await this.db.query(
          `INSERT INTO ai_catalog_changes(provider_id, change_type, field_name, summary, source_url, confidence)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [cfg.providerId, change.changeType, change.fieldName, change.summary, change.sourceUrl, change.confidence],
        ).catch(() => undefined);
      }

      this.logger.log(`Updated catalog provider [${cfg.providerId}] (${changes.length} changes recorded).`);
      return 'updated';
    } catch (error) {
      this.logger.warn(`Gemini catalog verification failed for [${cfg.providerId}]: ${error instanceof Error ? error.message : error}`);
      await this.db.query(`UPDATE ai_catalogs SET last_verified_at = now() WHERE id = $1`, [cfg.id]).catch(() => undefined);
      return 'skipped';
    }
  }

  private async collectProviderEvidence(cfg: ProviderConfig, extraContext?: string): Promise<string> {
    const snippets: string[] = [];
    if (extraContext) snippets.push(extraContext);

    for (const feedUrl of cfg.feedUrls.filter(u => !u.endsWith('.atom'))) {
      try {
        const resp = await fetch(feedUrl, {
          signal: AbortSignal.timeout(7_000),
          headers: { 'User-Agent': 'OpportunityRadar/1.0' },
        });
        if (resp.ok) {
          const text = await resp.text();
          const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          snippets.push(`[FEED ${feedUrl}]: ${clean.slice(0, 2000)}`);
        }
      } catch { /* ignore individual feed errors */ }
    }

    try {
      const resp = await fetch(cfg.pricingDocUrl, {
        signal: AbortSignal.timeout(8_000),
        headers: { 'User-Agent': 'OpportunityRadar/1.0' },
      });
      if (resp.ok) {
        const text = await resp.text();
        const clean = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        snippets.push(`[PRICING/DOCS ${cfg.pricingDocUrl}]: ${clean.slice(0, 3000)}`);
      }
    } catch { /* ignore */ }

    return snippets.join('\n\n') || `Provider official portal: ${cfg.officialUrl}`;
  }

  private async saveToDatabase(item: AiCatalogItem, evidenceHash: string) {
    await this.db.query(`
      INSERT INTO ai_catalogs (
        id, provider_id, provider_name, category, title, tagline,
        models, free_tier, current_promotions, advantages, limitations,
        pricing_summary, official_url, pricing_doc_url, evidence_hash, last_verified_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        provider_name = EXCLUDED.provider_name,
        category = EXCLUDED.category,
        title = EXCLUDED.title,
        tagline = EXCLUDED.tagline,
        models = EXCLUDED.models,
        free_tier = EXCLUDED.free_tier,
        current_promotions = EXCLUDED.current_promotions,
        advantages = EXCLUDED.advantages,
        limitations = EXCLUDED.limitations,
        pricing_summary = EXCLUDED.pricing_summary,
        official_url = EXCLUDED.official_url,
        pricing_doc_url = EXCLUDED.pricing_doc_url,
        evidence_hash = EXCLUDED.evidence_hash,
        last_verified_at = now(),
        updated_at = now()
    `, [
      item.id,
      item.providerId,
      item.providerName,
      item.category,
      item.title,
      item.tagline,
      JSON.stringify(item.models),
      JSON.stringify(item.freeTier),
      JSON.stringify(item.currentPromotions),
      JSON.stringify(item.advantages),
      JSON.stringify(item.limitations),
      item.pricingSummary,
      item.officialUrl,
      item.pricingDocUrl || item.officialUrl,
      evidenceHash,
    ]);
  }
}
