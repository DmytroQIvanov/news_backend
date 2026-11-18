import { sourceCounts } from '../news/eligibility';
import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonicalizeUrl } from '../common/url-utils';
import { DatabaseService } from '../database/database.service';
import { ClusterableArticle, ClusterSource, NewsClusteringService } from '../news/news-clustering.service';
import { ArticleDto, IngestRequestDto } from './ingest.dto';
import { EditArticleOptions, GeminiEditorService } from './gemini-editor.service';
import { persistEditorialExtras } from '../news/objectivity.store';
@Injectable()
export class IngestService {
  private readonly clustering: NewsClusteringService;

  constructor(
    private readonly db: DatabaseService,
    private readonly editor: GeminiEditorService,
    @Optional() clustering?: NewsClusteringService,
  ) {
    this.clustering = clustering ?? new NewsClusteringService();
  }
  async ingest(payload: IngestRequestDto, fromFeed = false, editOptions?: EditArticleOptions) {
    if (fromFeed && !this.editor.enabled) throw new Error('Gemini is disabled');
    if (this.editor.enabled && payload.items.length > 1) {
      let written = 0;
      let unchanged = 0;
      for (const item of payload.items) {
        const result = await this.ingest({ source: payload.source, items: [item] }, fromFeed, editOptions);
        written += result.written;
        unchanged += result.unchanged;
      }
      return { source: payload.source.slug, submitted: payload.items.length, written, unchanged };
    }
    const client = await this.db.connect();
    let changed = 0;
    let unchanged = 0;
    try {
      await client.query('BEGIN');
      const s = payload.source;
      let incomingClusterId = payload.items[0]?.clusterId || null;
      let incomingClusterSources: ClusterSource[] =
        (editOptions?.clusterSources || payload.items[0]?.clusterSources || []) as ClusterSource[];

      if (payload.items.length === 1) {
        const probeItem = payload.items[0];
        const probeCanonical = canonicalizeUrl(probeItem.url);
        let recentRows: ClusterableArticle[] = [];
        await client.query('SAVEPOINT cluster_lookup_sp');
        try {
          const recentRes = await client.query<ClusterableArticle>(
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
             LIMIT 200`,
          );
          recentRows = Array.isArray(recentRes?.rows) ? recentRes.rows : [];
          await client.query('RELEASE SAVEPOINT cluster_lookup_sp');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT cluster_lookup_sp');
        }

        if (recentRows.length > 0) {
          const dbMatch = this.clustering.matchArticleToClusterCandidates(
            {
              id: probeItem.externalId,
              url: probeItem.url,
              canonicalUrl: probeCanonical,
              original_title: probeItem.originalTitle,
              title_uk: probeItem.titleUk ?? null,
              summary_uk: probeItem.summaryUk ?? probeItem.originalSummary ?? null,
              published_at: probeItem.publishedAt ?? null,
              source_name: s.name,
              source_slug: s.slug,
              source_is_unofficial: Boolean(s.unofficial),
              cluster_id: incomingClusterId,
              cluster_sources: incomingClusterSources,
            },
            recentRows,
          );
          if (dbMatch && (dbMatch.matchedItem.canonicalUrl || '') !== probeCanonical) {
            incomingClusterId = dbMatch.clusterId;
            incomingClusterSources = dbMatch.clusterSources;
            await client.query('SAVEPOINT cluster_update_sp');
            try {
              await client.query(
                `UPDATE news_items
                 SET cluster_id = $2, cluster_sources = $3::jsonb, updated_at = now()
                 WHERE id::text = $1`,
                [dbMatch.matchedItem.id, dbMatch.clusterId, JSON.stringify(dbMatch.clusterSources)],
              );
              await client.query('RELEASE SAVEPOINT cluster_update_sp');
            } catch {
              await client.query('ROLLBACK TO SAVEPOINT cluster_update_sp');
            }
            if (fromFeed) {
              await client.query('COMMIT');
              return { source: s.slug, submitted: 1, written: 0, unchanged: 1 };
            }
          }
        }
      }

      if (this.editor.enabled) {
        const [item] = payload.items;
        const canonical = canonicalizeUrl(item.url);
        // Coalesce duplicate work across processes, and commit each valid result independently.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [s.slug, item.externalId]);
        const fingerprint = this.editor.fingerprint(s, item);
        const cached = await client.query<{ fingerprint: string | null; status: string; content_hash: string }>(`
          SELECT ai_metadata->>'editorial_fingerprint' AS fingerprint, status, content_hash
          FROM news_items n JOIN sources s ON s.id=n.source_id
          WHERE (s.slug=$1 AND n.external_id=$2) OR n.canonical_url=$3
          LIMIT 1`, [s.slug, item.externalId, canonical]);
        const previous = cached.rows[0];
        if (previous?.fingerprint === fingerprint || (fromFeed && previous?.status === 'rejected')) {
          await client.query('COMMIT');
          return { source: s.slug, submitted: 1, written: 0, unchanged: 1 };
        }
        const editedItem = await this.editor.edit(s, item, fingerprint, {
          ...editOptions,
          clusterSources: incomingClusterSources.length > 0 ? incomingClusterSources : editOptions?.clusterSources,
          licenseMode: editOptions?.licenseMode || s.licenseMode,
        });
        editedItem.clusterId = item.clusterId || incomingClusterId || undefined;
        editedItem.clusterSources =
          incomingClusterSources.length > 0
            ? (incomingClusterSources as unknown as Array<Record<string, unknown>>)
            : item.clusterSources;
        payload = { source: s, items: [editedItem] };
      }
      const source = await client.query<{ id: string }>(`
        INSERT INTO sources(slug,name,homepage_url,feed_url,unofficial)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name, homepage_url=EXCLUDED.homepage_url,
           feed_url=EXCLUDED.feed_url, unofficial=EXCLUDED.unofficial, updated_at=now()
        RETURNING id`, [s.slug, s.name, s.homepageUrl, s.feedUrl || null, s.unofficial ?? false]);
      const sourceId = source.rows[0].id;
      for (const item of payload.items) {
        const metadata = { ...item.aiMetadata };
        if (!this.editor.enabled) {
          delete metadata.article;
          delete metadata.editorial_fingerprint;
        }
        const isAiGenerated = Boolean(this.editor.enabled || metadata.article || metadata.editorial_fingerprint);
        const clusterId = item.clusterId || incomingClusterId || null;
        const clusterSourcesJson = JSON.stringify(
          Array.isArray(item.clusterSources) && item.clusterSources.length > 0
            ? item.clusterSources
            : incomingClusterSources,
        );
        const canonical = canonicalizeUrl(item.url);
        const hash = this.contentHash(item);
        // Skip if another external_id already ingested the exact same canonical URL and content hash
        const dupCheck = await client.query<{ id: string }>(`
          SELECT id FROM news_items
          WHERE canonical_url = $1 AND content_hash = $2 AND external_id <> $3
          LIMIT 1`, [canonical, hash, item.externalId]);
        if (dupCheck.rowCount) {
          unchanged += 1;
          continue;
        }
        const requireImportantReview =
          process.env.EDITORIAL_REQUIRE_REVIEW_IMPORTANT === 'true' && item.importance === 'high';
        // Single-source retellings are not published: a feed item goes live only when it is corroborated by enough sources.
        const minSources = 2;
        const corroborated =
          sourceCounts(JSON.parse(clusterSourcesJson)).independentOrigins >= minSources;
        const targetStatus =
          fromFeed && isAiGenerated && !requireImportantReview && corroborated ? 'published' : 'needs_review';
        // Existing published news is sent back for review ONLY when its content changes.
        let result: { rowCount: number | null };
        await client.query('SAVEPOINT news_insert_sp');
        try {
          result = await client.query(`
            INSERT INTO news_items(source_id,external_id,url,canonical_url,original_title,original_summary,
               title_uk,summary_uk,why_it_matters,category,importance,free_access,
               published_at,ai_metadata,content_hash,status,cluster_id,cluster_sources,ai_generated)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::jsonb,$19)
            ON CONFLICT(source_id,external_id) DO UPDATE SET
               url=EXCLUDED.url, canonical_url=EXCLUDED.canonical_url, original_title=EXCLUDED.original_title, original_summary=EXCLUDED.original_summary,
               title_uk=EXCLUDED.title_uk, summary_uk=EXCLUDED.summary_uk,
               why_it_matters=EXCLUDED.why_it_matters, category=EXCLUDED.category,
               importance=EXCLUDED.importance, free_access=EXCLUDED.free_access,
               published_at=EXCLUDED.published_at, ai_metadata=EXCLUDED.ai_metadata,
               content_hash=EXCLUDED.content_hash, status=CASE WHEN news_items.status = 'rejected' THEN news_items.status ELSE EXCLUDED.status END,
               cluster_id=COALESCE(EXCLUDED.cluster_id, news_items.cluster_id),
               cluster_sources=CASE WHEN jsonb_array_length(EXCLUDED.cluster_sources) > 0 THEN EXCLUDED.cluster_sources ELSE news_items.cluster_sources END,
               ai_generated=EXCLUDED.ai_generated,
               updated_at=now()
            WHERE news_items.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               OR (EXCLUDED.ai_metadata ? 'editorial_fingerprint'
                   AND news_items.ai_metadata->>'editorial_fingerprint' IS DISTINCT FROM EXCLUDED.ai_metadata->>'editorial_fingerprint')
            RETURNING id`, [sourceId,item.externalId,item.url,canonical,item.originalTitle,
               item.originalSummary || null,item.titleUk || null,item.summaryUk || null,
               item.whyItMatters || null,item.category,item.importance,item.freeAccess,
               item.publishedAt || null,JSON.stringify(metadata),hash,targetStatus,
               clusterId,clusterSourcesJson,isAiGenerated]);
          await client.query('RELEASE SAVEPOINT news_insert_sp');
        } catch {
          // Graceful fallback before migration 013 adds cluster_id / cluster_sources / ai_generated
          await client.query('ROLLBACK TO SAVEPOINT news_insert_sp');
          result = await client.query(`
            INSERT INTO news_items(source_id,external_id,url,canonical_url,original_title,original_summary,
               title_uk,summary_uk,why_it_matters,category,importance,free_access,
               published_at,ai_metadata,content_hash,status)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)
            ON CONFLICT(source_id,external_id) DO UPDATE SET
               url=EXCLUDED.url, canonical_url=EXCLUDED.canonical_url, original_title=EXCLUDED.original_title, original_summary=EXCLUDED.original_summary,
               title_uk=EXCLUDED.title_uk, summary_uk=EXCLUDED.summary_uk,
               why_it_matters=EXCLUDED.why_it_matters, category=EXCLUDED.category,
               importance=EXCLUDED.importance, free_access=EXCLUDED.free_access,
               published_at=EXCLUDED.published_at, ai_metadata=EXCLUDED.ai_metadata,
               content_hash=EXCLUDED.content_hash, status=CASE WHEN news_items.status = 'rejected' THEN news_items.status ELSE EXCLUDED.status END, updated_at=now()
            WHERE news_items.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               OR (EXCLUDED.ai_metadata ? 'editorial_fingerprint'
                   AND news_items.ai_metadata->>'editorial_fingerprint' IS DISTINCT FROM EXCLUDED.ai_metadata->>'editorial_fingerprint')
            RETURNING id`, [sourceId,item.externalId,item.url,canonical,item.originalTitle,
               item.originalSummary || null,item.titleUk || null,item.summaryUk || null,
               item.whyItMatters || null,item.category,item.importance,item.freeAccess,
               item.publishedAt || null,JSON.stringify(metadata),hash,targetStatus]);
        }
        if (result.rowCount) {
          changed += 1;
          const newsId = (result as { rows?: Array<{ id: string | number }> }).rows?.[0]?.id;
          if (newsId !== undefined && metadata.article) {
            await persistEditorialExtras(client, newsId, metadata.article, item.category, item.publishedAt);
          }
        } else unchanged += 1;
      }
      await client.query('COMMIT');
      return { source: s.slug, submitted: payload.items.length, written: changed, unchanged,
        note: fromFeed ? 'Feed articles were processed with AI disclosure metadata.' : 'New or changed records require moderator approval before publication.' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  private contentHash(a: ArticleDto): string {
    // Hash meaningful source and AI fields, not ingestion time.
    const fields = [a.url,a.originalTitle,a.originalSummary || '',a.titleUk || '',a.summaryUk || '',
       a.whyItMatters || '',a.category,a.importance,a.freeAccess,a.publishedAt || ''];
    return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  }
}
