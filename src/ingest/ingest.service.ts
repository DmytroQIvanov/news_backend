import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ArticleDto, IngestRequestDto } from './ingest.dto';
import { GeminiEditorService } from './gemini-editor.service';
@Injectable()
export class IngestService {
  constructor(private readonly db: DatabaseService, private readonly editor: GeminiEditorService) {}
  async ingest(payload: IngestRequestDto, fromFeed = false) {
    if (fromFeed && !this.editor.enabled) throw new Error('Gemini is disabled');
    if (this.editor.enabled && payload.items.length > 1) {
      let written = 0;
      let unchanged = 0;
      for (const item of payload.items) {
        const result = await this.ingest({ source: payload.source, items: [item] }, fromFeed);
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
      if (this.editor.enabled) {
        const [item] = payload.items;
        // Coalesce duplicate work across processes, and commit each valid result independently.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [s.slug, item.externalId]);
        const fingerprint = this.editor.fingerprint(s, item);
        const cached = await client.query<{ fingerprint: string | null; status: string }>(`
          SELECT ai_metadata->>'editorial_fingerprint' AS fingerprint, status
          FROM news_items n JOIN sources s ON s.id=n.source_id
          WHERE s.slug=$1 AND n.external_id=$2`, [s.slug, item.externalId]);
        const previous = cached.rows[0];
        if (previous?.fingerprint === fingerprint || (fromFeed && previous?.status === 'rejected')) {
          await client.query('COMMIT');
          return { source: s.slug, submitted: 1, written: 0, unchanged: 1 };
        }
        payload = { source: s, items: [await this.editor.edit(s, item, fingerprint)] };
      }
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
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
          ON CONFLICT(source_id,external_id) DO UPDATE SET
             url=EXCLUDED.url, original_title=EXCLUDED.original_title, original_summary=EXCLUDED.original_summary,
             title_uk=EXCLUDED.title_uk, summary_uk=EXCLUDED.summary_uk,
             why_it_matters=EXCLUDED.why_it_matters, category=EXCLUDED.category,
             importance=EXCLUDED.importance, free_access=EXCLUDED.free_access,
             published_at=EXCLUDED.published_at, ai_metadata=EXCLUDED.ai_metadata,
             content_hash=EXCLUDED.content_hash, status=EXCLUDED.status, updated_at=now()
          WHERE news_items.content_hash IS DISTINCT FROM EXCLUDED.content_hash
             OR news_items.ai_metadata->>'editorial_fingerprint' IS DISTINCT FROM EXCLUDED.ai_metadata->>'editorial_fingerprint'
          RETURNING id`, [sourceId,item.externalId,item.url,item.originalTitle,
             item.originalSummary || null,item.titleUk || null,item.summaryUk || null,
             item.whyItMatters || null,item.category,item.importance,item.freeAccess,
             item.publishedAt || null,JSON.stringify(item.aiMetadata || {}),hash,fromFeed ? 'published' : 'needs_review']);
        if (result.rowCount) changed += 1; else unchanged += 1;
      }
      await client.query('COMMIT');
      return { source: s.slug, submitted: payload.items.length, written: changed, unchanged,
        note: fromFeed ? 'Feed articles were published after editorial processing.' : 'New or changed records require moderator approval before publication.' };
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
