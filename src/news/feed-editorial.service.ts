import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { GeminiEditorService } from '../ingest/gemini-editor.service';
import { IngestService } from '../ingest/ingest.service';
import { companyFeeds, CompanyFeedsService } from './company-feeds.service';

@Injectable()
export class FeedEditorialService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeedEditorialService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly feeds: CompanyFeedsService, private readonly editor: GeminiEditorService,
    private readonly ingest: IngestService, private readonly db: DatabaseService) {}

  onModuleInit() {
    if (this.editor.enabled) this.timer = setTimeout(() => void this.run(), 2_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async run() {
    try {
      const { items } = await this.feeds.list([]);
      const { rows } = await this.db.query<{ external_id: string; url: string }>(`
        SELECT external_id, url FROM news_items
        WHERE (external_id = ANY($1::text[]) OR url = ANY($2::text[]))
          AND (ai_metadata ? 'editorial_fingerprint' OR status IN ('needs_review','rejected'))`,
      [items.map(item => item.id), items.map(item => item.url)]);
      const known = new Set(rows.flatMap(row => [row.external_id, row.url]));

      // Process at most one missed headline per company per cycle. The public feed stays responsive.
      for (const feed of companyFeeds) {
        if (this.stopped) return;
        const item = items.find(entry => entry.source_slug === feed.slug && !known.has(entry.id) && !known.has(entry.url));
        if (!item) continue;
        try {
          await this.ingest.ingest({
            source: { slug: feed.slug, name: feed.name, homepageUrl: `https://${feed.domain}`,
              feedUrl: feed.url, unofficial: !!feed.alias },
            items: [{ externalId: item.id, url: item.url, originalTitle: item.original_title,
              originalSummary: item.original_summary, publishedAt: item.published_at,
              category: 'other', importance: 'unknown', freeAccess: 'unknown' }],
          }, true);
        } catch (error) {
          this.logger.warn(`${feed.name}: ${error instanceof Error ? error.message : 'Editorial processing failed'}`);
          if (error instanceof Error && /^Gemini HTTP (401|403|429)$/.test(error.message)) break;
        }
      }
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : 'Editorial processing failed');
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.run(), 10 * 60_000);
    }
  }
}
