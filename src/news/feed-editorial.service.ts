import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { canUseHydrogenQuota } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';
import { BatchAngleHint, GeminiEditorService, PolishBatchResult } from '../ingest/gemini-editor.service';
import { CATEGORIES } from '../ingest/ingest.dto';
import { IngestService } from '../ingest/ingest.service';
import { isAudioAutoGenerateEnabled } from './audio-briefing.service';
import { isKbEditorialActive } from '../kb/kb-editorial.service';
import { CompanyFeedsService, isPublishedWithinHours } from './company-feeds.service';
import { ClusterableArticle, NewsClusteringService } from './news-clustering.service';
import { NewsTtsService } from './news-tts.service';
import { SourceDiscoveryService } from './source-discovery.service';

@Injectable()
export class FeedEditorialService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeedEditorialService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private runningPromise?: Promise<{ checked: number; processed: number; skipped: number; errors: number }>;
  private readonly clustering: NewsClusteringService;

  constructor(
    private readonly feeds: CompanyFeedsService,
    private readonly editor: GeminiEditorService,
    private readonly ingest: IngestService,
    private readonly db: DatabaseService,
    private readonly catalog: CatalogService,
    @Optional() clustering?: NewsClusteringService,
    @Optional() private readonly discovery?: SourceDiscoveryService,
    @Optional() private readonly newsTts?: NewsTtsService,
  ) {
    this.clustering = clustering ?? new NewsClusteringService();
  }

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
    // Task 1: while the knowledge-base pipeline runs, articles are written per event by KbEditorialService.
    // Writing per RSS item here as well would bring back one-source "garbage" news and spend the same LLM budget.
    if (await isKbEditorialActive(this.db)) {
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
      const feedBySlug = new Map(activeFeeds.map(f => [f.slug, f]));
      const categoryArticleCounts = new Map<string, number>();
      for (const cat of CATEGORIES) {
        if (cat !== 'other') categoryArticleCounts.set(cat, 0);
      }
      for (const entry of items) {
        const cat = entry.category || feedBySlug.get(entry.source_slug)?.category || 'other';
        if (cat !== 'other') {
          categoryArticleCounts.set(cat, (categoryArticleCounts.get(cat) || 0) + 1);
        }
      }
      const sparseCategories = [...categoryArticleCounts.entries()]
        .filter(([, count]) => count < 2)
        .map(([cat]) => cat);
      if (sparseCategories.length > 0) {
        this.discovery?.triggerDiscoveryIfNeeded(sparseCategories);
      }

      // Articles turned into full AI text per 5-minute cycle; raise it when the free AI quota allows.
      const maxEnv = Number(process.env.EDITORIAL_MAX_PER_CYCLE);
      const maxPerCycle = Number.isInteger(maxEnv) && maxEnv >= 1 && maxEnv <= 30 ? maxEnv : 6;
      const freshUnprocessed = items.filter(
        entry =>
          feedBySlug.has(entry.source_slug) &&
          isPublishedWithinHours(entry.published_at, 24) &&
          !known.has(entry.id) &&
          !known.has(entry.url) &&
          !known.has(entry.canonical_url),
      );
      if (freshUnprocessed.length === 0) {
        return { checked, processed, skipped: items.length, errors };
      }

      // Cluster overlapping events across feeds BEFORE spending Gemini quota
      const clustered = this.clustering.clusterItems(freshUnprocessed);
      skipped += Math.max(0, freshUnprocessed.length - clustered.length);

      // Cross-check fresh RSS clusters against already-published 48h DB items so later reports attach cleanly
      const recentDbRes = await this.db
        .query<ClusterableArticle>(
          `SELECT n.id::text AS id, n.url, n.canonical_url AS "canonicalUrl",
                  n.original_title, n.title_uk, n.summary_uk, n.published_at,
                  n.category, n.importance,
                  (n.ai_metadata->'article' IS NOT NULL) AS article,
                  s.name AS source_name, s.slug AS source_slug, s.unofficial AS source_is_unofficial,
                  n.cluster_id, COALESCE(n.cluster_sources, '[]'::jsonb) AS cluster_sources
           FROM news_items n JOIN sources s ON s.id = n.source_id
           WHERE n.status = 'published'
             AND COALESCE(n.published_at, n.created_at) >= now() - interval '48 hours'
           ORDER BY n.published_at DESC NULLS LAST
           LIMIT 250`,
        )
        .catch(() => ({ rows: [] as ClusterableArticle[] }));
      const recentDbItems = Array.isArray(recentDbRes?.rows) ? recentDbRes.rows : [];

      const nonDuplicateClusters: typeof clustered = [];
      for (const story of clustered) {
        const dbMatch =
          recentDbItems.length > 0
            ? this.clustering.matchArticleToClusterCandidates(story, recentDbItems)
            : null;
        if (dbMatch && dbMatch.matchedItem.id !== story.id) {
          dbMatch.matchedItem.cluster_id = dbMatch.clusterId;
          dbMatch.matchedItem.cluster_sources = dbMatch.clusterSources;
          await this.db
            .query(
              `UPDATE news_items
               SET cluster_id = $2, cluster_sources = $3::jsonb, updated_at = now()
               WHERE id::text = $1`,
              [dbMatch.matchedItem.id, dbMatch.clusterId, JSON.stringify(dbMatch.clusterSources)],
            )
            .catch(() => undefined);
          skipped += 1;
          this.logger.debug(
            `Attached ${story.source_slug} coverage to existing cluster ${dbMatch.clusterId} (${dbMatch.clusterSources.length} sources)`,
          );
          continue;
        }
        nonDuplicateClusters.push(story);
      }

      // Keep top-per-feed / multi-source stories prioritized first
      const selectedByPrimary = new Map<string, (typeof nonDuplicateClusters)[number]>();
      for (const story of nonDuplicateClusters) {
        if (!selectedByPrimary.has(story.source_slug) || story.source_count > 1) {
          selectedByPrimary.set(story.id, story);
        }
      }
      const pendingCandidates = [...selectedByPrimary.values()]
        .map(item => ({ feed: feedBySlug.get(item.source_slug)!, item }))
        .filter(c => Boolean(c.feed));

      pendingCandidates.sort((a, b) => {
        if (b.item.source_count !== a.item.source_count) {
          return b.item.source_count - a.item.source_count;
        }
        return Date.parse(b.item.published_at) - Date.parse(a.item.published_at);
      });

      const plannerBatch = pendingCandidates.slice(0, 10);
      let angleHints: Record<string, BatchAngleHint> = {};
      if (plannerBatch.length > 0 && canUseHydrogenQuota()) {
        angleHints = await this.editor.planBatchAnglesWithHydrogen(
          plannerBatch.map(({ feed, item }) => ({
            externalId: item.id,
            sourceName:
              item.source_count > 1
                ? `${feed.name} (+${item.source_count - 1} джерел)`
                : feed.name,
            originalTitle: item.original_title,
            originalSummary: item.original_summary,
            url: item.url,
          })),
        );
      }

      const prioritizedCandidates = [...pendingCandidates].sort((a, b) => {
        const bMulti = b.item.source_count > 1 ? 1 : 0;
        const aMulti = a.item.source_count > 1 ? 1 : 0;
        if (bMulti !== aMulti) return bMulti - aMulti;
        const aBoost = angleHints[a.item.id]?.boostImportant ? 1 : 0;
        const bBoost = angleHints[b.item.id]?.boostImportant ? 1 : 0;
        if (bBoost !== aBoost) return bBoost - aBoost;
        return Date.parse(b.item.published_at) - Date.parse(a.item.published_at);
      });

      for (const { feed, item } of prioritizedCandidates) {
        if (this.stopped || processed >= maxPerCycle) break;
        const candidateCategory = item.category || feed.category;
        const safeCategory = CATEGORIES.includes(candidateCategory as typeof CATEGORIES[number])
          ? (candidateCategory as typeof CATEGORIES[number])
          : 'other';
        try {
          const boostMultiSource = item.source_count >= 2;
          const result = await this.ingest.ingest(
            {
              source: {
                slug: feed.slug,
                name: feed.name,
                homepageUrl: `https://${feed.domain}`,
                feedUrl: feed.url,
                unofficial: Boolean(feed.unofficial || feed.alias),
                licenseMode: feed.licenseMode || 'headline_link',
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
                clusterId: item.cluster_id || undefined,
                clusterSources: item.cluster_sources as unknown as Array<Record<string, unknown>>,
              }],
            },
            true,
            {
              angleHint: boostMultiSource
                ? {
                    externalId: item.id,
                    angleUk: angleHints[item.id]?.angleUk || `Крос-перевірка події за ${item.source_count} джерелами`,
                    skepticQuestionUk: angleHints[item.id]?.skepticQuestionUk || 'У чому сходяться і чим відрізняються деталі різних видань?',
                    compareWithUk: angleHints[item.id]?.compareWithUk || '',
                    boostImportant: true,
                  }
                : angleHints[item.id],
              licenseMode: feed.licenseMode || 'headline_link',
              clusterSources: item.cluster_sources,
            },
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
          if (error instanceof Error && /Gemini HTTP (401|403|429)\b/.test(error.message)) break;
        }
      }

      if (!this.stopped && canUseHydrogenQuota()) {
        await this.polishPendingWithHydrogen(12).catch((err) =>
          this.logger.warn(`Hydrogen batch polish failed: ${err instanceof Error ? err.message : err}`),
        );
      }

      if (!this.stopped && this.newsTts && isAudioAutoGenerateEnabled()) {
        await this.newsTts.prewarmImportantBriefings({ limit: 5 }).catch((err) =>
          this.logger.warn(`TTS briefing prewarm failed: ${err instanceof Error ? err.message : err}`),
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
