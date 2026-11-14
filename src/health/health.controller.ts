import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { GamesService } from '../games/games.service';
import { GeminiEditorService } from '../ingest/gemini-editor.service';
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}
  @Get()
  async health() {
    const database = await this.databaseHealth();
    return { ...database, timestamp: new Date().toISOString() };
  }

  @Get('db')
  async databaseHealth() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', database: 'unavailable' });
    }
  }

  @Get('summary')
  async summary() {
    try {
      const [newsRes, sourcesRes, catalogRes, gamesRes] = await Promise.all([
        this.db.query<{
          total: string;
          important_total: string;
          needs_review: string;
          rejected: string;
          last_at: string | null;
        }>(
          `SELECT COUNT(*) FILTER (WHERE status = 'published')::text AS total,
                  COUNT(*) FILTER (WHERE status = 'published' AND importance IN ('high', 'critical'))::text AS important_total,
                  COUNT(*) FILTER (WHERE status = 'needs_review')::text AS needs_review,
                  COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected,
                  MAX(published_at) FILTER (WHERE status = 'published')::text AS last_at
           FROM news_items`,
        ),
        this.db.query<{ total: string; healthy: string }>(
          `SELECT COUNT(*)::text AS total,
                  COUNT(*) FILTER (WHERE enabled AND last_error IS NULL)::text AS healthy
           FROM sources`,
        ),
        this.db.query<{ total: string; last_verified: string | null }>(
          `SELECT COUNT(*)::text AS total,
                  MAX(last_verified_at)::text AS last_verified
           FROM ai_catalogs`,
        ),
        this.db.query<{ total: string; free_giveaways: string; last_verified: string | null }>(
          `SELECT COUNT(*)::text AS total,
                  COUNT(*) FILTER (WHERE offer_type = 'giveaway' AND is_free)::text AS free_giveaways,
                  MAX(last_verified_at)::text AS last_verified
           FROM game_offers
           WHERE status = 'active'`,
        ),
      ]);

      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        news: {
          published: Number(newsRes.rows[0]?.total ?? 0),
          important: Number(newsRes.rows[0]?.important_total ?? 0),
          needsReview: Number(newsRes.rows[0]?.needs_review ?? 0),
          rejected: Number(newsRes.rows[0]?.rejected ?? 0),
          lastPublishedAt: newsRes.rows[0]?.last_at ?? null,
        },
        sources: {
          total: Number(sourcesRes.rows[0]?.total ?? 0),
          healthy: Number(sourcesRes.rows[0]?.healthy ?? 0),
        },
        catalog: {
          providers: Number(catalogRes.rows[0]?.total ?? 0),
          lastVerifiedAt: catalogRes.rows[0]?.last_verified ?? null,
        },
        games: {
          active: Number(gamesRes.rows[0]?.total ?? 0),
          freeGiveaways: Number(gamesRes.rows[0]?.free_giveaways ?? 0),
          lastVerifiedAt: gamesRes.rows[0]?.last_verified ?? null,
        },
        ai: {
          configured: Boolean(
            process.env.GEMINI_API_KEY?.trim() &&
              !process.env.GEMINI_API_KEY.trim().startsWith('replace_'),
          ),
          model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
          lastGamesAiError: GamesService.lastAiError,
          lastNewsAiError: GeminiEditorService.lastAiError,
        },
      };
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', database: 'unavailable' });
    }
  }
}
