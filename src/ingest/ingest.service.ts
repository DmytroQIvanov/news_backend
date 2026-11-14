import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ArticleDto, IngestRequestDto } from './ingest.dto';
@Injectable()
export class IngestService {
  constructor(private readonly db: DatabaseService) {}
  async ingest(payload: IngestRequestDto) {
    const client = await this.db.connect();
    let changed = 0;
    let unchanged = 0;
    try {
      await client.query('BEGIN');
      const s = payload.source;
      const source = await client.query<{ id: string }>(`
        INSERT INTO sources(slug,name,homepage_url,feed_url,unofficial)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name, homepage_url=EXCLUDED.homepage_url,
           feed_url=EXCLUDED.feed_url, unofficial=EXCLUDED.unofficial, updated_at=now()
        RETURNING id`, [s.slug, s.name, s.homepageUrl, s.feedUrl || null, s.unofficial ?? false]);
      const sourceId = source.rows[0].id;
      for (const item of payload.items) {
        const hash = this.contentHash(item);
        // Existing published news is sent back for review ONLY when its content changes.
        const result = await client.query(`
          INSERT INTO news_items(source_id,external_id,url,original_title,original_summary,
             title_uk,summary_uk,why_it_matters,category,importance,free_access,
             published_at,ai_metadata,content_hash,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,'needs_review')
          ON CONFLICT(source_id,external_id) DO UPDATE SET
             url=EXCLUDED.url, original_title=EXCLUDED.original_title, original_summary=EXCLUDED.original_summary,
             title_uk=EXCLUDED.title_uk, summary_uk=EXCLUDED.summary_uk,
             why_it_matters=EXCLUDED.why_it_matters, category=EXCLUDED.category,
             importance=EXCLUDED.importance, free_access=EXCLUDED.free_access,
             published_at=EXCLUDED.published_at, ai_metadata=EXCLUDED.ai_metadata,
             content_hash=EXCLUDED.content_hash, status='needs_review', updated_at=now()
          WHERE news_items.content_hash IS DISTINCT FROM EXCLUDED.content_hash
          RETURNING id`, [sourceId,item.externalId,item.url,item.originalTitle,
             item.originalSummary || null,item.titleUk || null,item.summaryUk || null,
             item.whyItMatters || null,item.category,item.importance,item.freeAccess,
             item.publishedAt || null,JSON.stringify(item.aiMetadata || {}),hash]);
        if (result.rowCount) changed += 1; else unchanged += 1;
      }
      await client.query('COMMIT');
      return { source: s.slug, submitted: payload.items.length, written: changed, unchanged,
        note: 'New or changed records require moderator approval before publication.' };
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
