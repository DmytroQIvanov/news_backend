import { Controller, Get, Header, Query } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/** Read-only view of what the AI discovered: labelled outlets, authors, experts and country coverage. */
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly db: DatabaseService) {}

  @Get('sources')
  @Header('Cache-Control', 'public, max-age=120')
  async sources(
    @Query('country') country?: string,
    @Query('type') type?: string,
    @Query('state') state?: string,
    @Query('rejected') rejected?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = (
      await this.db.query(
        `SELECT slug, name, homepage_url, feed_url, country, language, outlet_type, state_affiliated, reliability, category, enabled,
                review_status, labels->>'characterization' AS characterization, labels->>'decision' AS decision, verified_at
         FROM sources
         WHERE discovered_via = 'world'
           AND ($1::text IS NULL OR country = upper($1))
           AND ($2::text IS NULL OR outlet_type = $2)
           AND ($3::text IS NULL OR state_affiliated = ($3 = 'true'))
           AND ($4::boolean OR enabled = true)
         ORDER BY country, name LIMIT $5`,
        [country || null, type || null, state === 'true' || state === 'false' ? state : null, rejected === 'true', n],
      )
    ).rows;
    return { items: rows };
  }

  @Get('people')
  @Header('Cache-Control', 'public, max-age=300')
  async people(@Query('kind') kind?: string, @Query('country') country?: string, @Query('limit') limit?: string) {
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = (
      await this.db.query(
        `SELECT id, kind, name, name_uk, affiliation, source_slug, country, topics, description, wikidata_id, mentions, events, confidence, status, evidence, last_seen
         FROM discovered_people
         WHERE status <> 'hidden' AND ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR country = upper($2))
         ORDER BY mentions DESC, confidence DESC LIMIT $3`,
        [kind === 'author' || kind === 'expert' || kind === 'editor' ? kind : null, country || null, n],
      )
    ).rows;
    return { items: rows };
  }

  @Get('coverage')
  @Header('Cache-Control', 'public, max-age=300')
  async coverage() {
    const byCountry = (
      await this.db.query(
        `SELECT s.country, count(*) FILTER (WHERE s.enabled) AS outlets, count(*) FILTER (WHERE NOT s.enabled) AS rejected,
                max(c.last_run) AS last_run
         FROM sources s LEFT JOIN discovery_coverage c ON c.country = s.country AND c.kind = 'outlets'
         WHERE s.discovered_via = 'world' GROUP BY s.country ORDER BY outlets DESC`,
      )
    ).rows;
    const searched = Number((await this.db.query(`SELECT count(*) AS n FROM discovery_coverage WHERE kind = 'outlets'`)).rows[0]?.n ?? 0);
    return { countriesSearched: searched, countries: byCountry };
  }
}
