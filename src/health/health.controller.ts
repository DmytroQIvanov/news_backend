import { IngestKeyGuard } from '../common/ingest-key.guard';
import { PipelineDiagnostics } from './pipeline-diagnostics';
import { Controller, Get, Optional, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { DatabaseService } from '../database/database.service';
import { GamesService } from '../games/games.service';
import { INITIAL_GRANTS_SEED } from '../grants/grants-seed';
import { GrantsService } from '../grants/grants.service';
import { GeminiEditorService } from '../ingest/gemini-editor.service';
import { KeepAliveService } from './keep-alive.service';
@Controller('health')
export class HealthController {
  private diagnosticsCache?: PipelineDiagnostics;

  @Get('diagnostics')
  @UseGuards(IngestKeyGuard)
  diagnostics() {
    this.diagnosticsCache ??= new PipelineDiagnostics(this.db);
    return this.diagnosticsCache.get();
  }

  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly keepAlive?: KeepAliveService,
  ) {}
  @Get()
  async health() {
    const database = await this.databaseHealth();
    return {
      ...database,
      timestamp: new Date().toISOString(),
      keepAlive: this.keepAlive?.getKeepAliveStats() ?? null,
    };
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
    const activeSeedGrants = INITIAL_GRANTS_SEED.filter((g) => g.status === 'active');
    const fallbackByAudience: Record<string, number> = {};
    for (const grant of activeSeedGrants) {
      for (const aud of grant.audiences) {
        fallbackByAudience[aud] = (fallbackByAudience[aud] ?? 0) + 1;
      }
    }
    const fallbackGrants = {
      active: activeSeedGrants.length,
      equityFree: activeSeedGrants.filter((g) => g.equityFree).length,
      totalFundingUsd: activeSeedGrants.reduce((sum, g) => sum + g.fundingMaxUsd, 0),
      lastVerifiedAt: activeSeedGrants[0]?.lastVerifiedAt ?? null,
      byAudience: fallbackByAudience,
      lastAiVerificationAt: GrantsService.lastAiVerificationAt,
      dailyCheckIntervalHours: 24 as const,
    };

    try {
      const [newsRes, sourcesRes, catalogRes, gamesRes, grantsSummary] = await Promise.all([
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
        Promise.all([
          this.db.query<{
            active: string;
            equity_free: string;
            total_funding_usd: string;
            last_verified: string | null;
          }>(
            `SELECT COUNT(*) FILTER (WHERE status = 'active')::text AS active,
                    COUNT(*) FILTER (WHERE status = 'active' AND equity_free)::text AS equity_free,
                    COALESCE(SUM(funding_max_usd) FILTER (WHERE status = 'active'), 0)::text AS total_funding_usd,
                    MAX(last_verified_at)::text AS last_verified
             FROM grants_opportunities`,
          ),
          this.db
            .query<{ key: string; cnt: string }>(
              `SELECT aud AS key, COUNT(*)::text AS cnt
               FROM grants_opportunities, jsonb_array_elements_text(audiences) AS aud
               WHERE status = 'active'
               GROUP BY aud`,
            )
            .catch(() => null),
          this.db
            .query<{ last_ai: string | null }>(
              `SELECT MAX(last_ai_verified_at)::text AS last_ai FROM grants_opportunities`,
            )
            .catch(() => null),
        ])
          .then(([res, audRes, aiRes]) => {
            const row = res.rows[0];
            const active = Number(row?.active ?? 0);
            if (active === 0) return fallbackGrants;

            const byAudience: Record<string, number> = {};
            if (audRes && audRes.rows.length > 0) {
              for (const r of audRes.rows) {
                if (r.key) byAudience[r.key] = Number(r.cnt ?? 0);
              }
            } else {
              Object.assign(byAudience, fallbackByAudience);
            }

            const dbAiAt = aiRes?.rows[0]?.last_ai
              ? new Date(aiRes.rows[0].last_ai).toISOString()
              : null;

            return {
              active,
              equityFree: Number(row?.equity_free ?? 0),
              totalFundingUsd: Number(row?.total_funding_usd ?? 0),
              lastVerifiedAt: row?.last_verified ?? null,
              byAudience,
              lastAiVerificationAt: dbAiAt ?? GrantsService.lastAiVerificationAt,
              dailyCheckIntervalHours: 24 as const,
            };
          })
          .catch(() => fallbackGrants),
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
          lastDailyVerificationAt: CatalogService.lastDailyVerificationAt,
          dailyCheckIntervalHours: CatalogService.dailyCheckIntervalHours,
        },
        games: {
          active: Number(gamesRes.rows[0]?.total ?? 0),
          freeGiveaways: Number(gamesRes.rows[0]?.free_giveaways ?? 0),
          lastVerifiedAt: gamesRes.rows[0]?.last_verified ?? null,
        },
        grants: grantsSummary,
        ai: {
          configured: Boolean(
            process.env.GEMINI_API_KEY?.trim() &&
              !process.env.GEMINI_API_KEY.trim().startsWith('replace_'),
          ),
          model: process.env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite',
          lastGamesAiError: GamesService.lastAiError,
          lastNewsAiError: GeminiEditorService.lastAiError,
        },
      };
    } catch {
      throw new ServiceUnavailableException({ status: 'degraded', database: 'unavailable' });
    }
  }
}
