import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
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
        this.db.query<{ total: string; important_total: string; last_at: string | null }>(
          `SELECT COUNT(*)::text AS total,
                  COUNT(*) FILTER (WHERE important)::text AS important_total,
                  MAX(published_at)::text AS last_at
           FROM news_items
           WHERE status = 'published'`,
        ),
        this.db.query<{ total: string; healthy: string }>(
          `SELECT COUNT(*)::text AS total,
                  COUNT(*) FILTER (WHERE is_active AND consecutive_failures < 3)::text AS healthy
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
      };
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', database: 'unavailable' });
    }
  }
}
