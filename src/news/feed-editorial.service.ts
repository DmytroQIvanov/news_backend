import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { canUseHydrogenQuota } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';
import { BatchAngleHint, GeminiEditorService, PolishBatchResult } from '../ingest/gemini-editor.service';
import { CATEGORIES } from '../ingest/ingest.dto';
import { IngestService } from '../ingest/ingest.service';
import { CompanyFeedsService } from './company-feeds.service';

@Injectable()
export class FeedEditorialService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeedEditorialService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private runningPromise?: Promise<{ checked: number; processed: number; skipped: number; errors: number }>;

  constructor(
    private readonly feeds: CompanyFeedsService,
    private readonly editor: GeminiEditorService,
    private readonly ingest: IngestService,
    private readonly db: DatabaseService,
    private readonly catalog: CatalogService,
  ) {}

  onModuleInit() {
    if (this.editor.enabled) {
      this.timer = setTimeout(() => void this.scheduleLoop(), 25_000);
    }
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async scheduleLoop() {
    try {
      await this.runOnce();
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.scheduleLoop(), 5 * 60_000);
      }
    }
  }

  async runOnce(): Promise<{ checked: number; processed: number; skipped: number; errors: number }> {
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = this.executeCycle().finally(() => {
      this.runningPromise = undefined;
    });
    return this.runningPromise;
  }

  private async executeCycle(): Promise<{ checked: number; processed: number; skipped: number; errors: number }> {
    let checked = 0;
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    if (!this.editor.enabled) {
      return { checked, processed, skipped, errors };
    }

    try {
      const { items } = await this.feeds.list([]);
      checked = items.length;
      if (!items.length) return { checked, processed, skipped, errors };

      const { rows } = await this.db.query<{ external_id: string; url: string; canonical_url: string | null }>(`
        SELECT external_id, url, canonical_url FROM news_items
        WHERE (external_id = ANY($1::text[]) OR url = ANY($2::text[]) OR canonical_url = ANY($3::text[]))
          AND (ai_metadata ? 'editorial_fingerprint' OR status IN ('needs_review','rejected'))`,
      [items.map(i => i.id), items.map(i => i.url), items.map(i => i.canonical_url)]);
      const known = new Set(rows.flatMap(row => [row.external_id, row.url, row.canonical_url].filter((v): v is string => !!v)));

      const activeFeeds = this.feeds.getActiveFeeds();
      const maxPerCycle = 3;
      const pendingCandidates: Array<{ feed: (typeof activeFeeds)[number]; item: (typeof items)[number] }> = [];
      for (const feed of activeFeeds) {
        const item = items.find(
          entry =>
            entry.source_slug === feed.slug &&
            !known.has(entry.id) &&
            !known.has(entry.url) &&
            !known.has(entry.canonical_url),
        );
        if (!item) {
          skipped += 1;
          continue;
        }
        pendingCandidates.push({ feed, item });
      }

      const plannerBatch = pendingCandidates.slice(0, 10);
      let angleHints: Record<string, BatchAngleHint> = {};
      if (plannerBatch.length > 0 && canUseHydrogenQuota()) {
        angleHints = await this.editor.planBatchAnglesWithHydrogen(
          plannerBatch.map(({ feed, item }) => ({
            externalId: item.id,
            sourceName: feed.name,
            originalTitle: item.original_title,
            originalSummary: item.original_summary,
            url: item.url,
          })),
        );
      }

      const prioritizedCandidates = [...pendingCandidates].sort((a, b) => {
        const aBoost = angleHints[a.item.id]?.boostImportant ? 1 : 0;
        const bBoost = angleHints[b.item.id]?.boostImportant ? 1 : 0;
        return bBoost - aBoost;
      });

      for (const { feed, item } of prioritizedCandidates) {
        if (this.stopped || processed >= maxPerCycle) break;
        const candidateCategory = item.category || feed.category;
        const safeCategory = CATEGORIES.includes(candidateCategory as typeof CATEGORIES[number])
          ? (candidateCategory as typeof CATEGORIES[number])
          : 'other';
        try {
          const result = await this.ingest.ingest(
            {
              source: {
                slug: feed.slug,
                name: feed.name,
                homepageUrl: `https://${feed.domain}`,
                feedUrl: feed.url,
                unofficial: Boolean(feed.unofficial || feed.alias),
              },
              items: [{
                externalId: item.id,
                url: item.url,
                originalTitle: item.original_title,
                originalSummary: item.original_summary,
                publishedAt: item.published_at,
                category: safeCategory,
                importance: 'unknown',
                freeAccess: 'unknown',
              }],
            },
            true,
            { angleHint: angleHints[item.id] },
          );

          if (result.written > 0) {
            processed += 1;
            if (feed.providerId) {
              await this.catalog.notifyArticlePublished(feed.providerId, item.original_title, item.url)
                .catch(err => this.logger.warn(`Catalog notify failed for ${feed.providerId}: ${err instanceof Error ? err.message : err}`));
            }
            if (processed < maxPerCycle) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } else {
            skipped += 1;
          }
        } catch (error) {
          errors += 1;
          this.logger.warn(`${feed.name}: ${error instanceof Error ? error.message : 'Editorial processing failed'}`);
          if (error instanceof Error && /^Gemini HTTP (401|403|429)$/.test(error.message)) break;
        }
      }

      if (!this.stopped && canUseHydrogenQuota()) {
        await this.polishPendingWithHydrogen(12).catch((err) =>
          this.logger.warn(`Hydrogen batch polish failed: ${err instanceof Error ? err.message : err}`),
        );
      }
    } catch (error) {
      errors += 1;
      this.logger.warn(error instanceof Error ? error.message : 'Editorial processing failed');
    }

    return { checked, processed, skipped, errors };
  }

  async polishPendingWithHydrogen(limit = 12): Promise<PolishBatchResult> {
    return this.editor.polishArticlesBatchWithHydrogen(limit);
  }
}
