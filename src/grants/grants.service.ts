import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  type GrantOpportunityItem,
  INITIAL_GRANTS_SEED,
} from './grants-seed';

export interface GrantsListFilters {
  country?: string;
  sector?: string;
  type?: string;
  stage?: string;
  equityFree?: boolean;
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface GrantsListResult {
  items: GrantOpportunityItem[];
  total: number;
  hasMore: boolean;
}

export interface GrantsMetaResult {
  totalActive: number;
  equityFreeCount: number;
  totalFundingUsd: number;
  uaCount: number;
  byCountry: Record<string, number>;
  bySector: Record<string, number>;
  byType: Record<string, number>;
}

type GrantDbRow = Omit<GrantOpportunityItem, 'deadlineAt' | 'lastVerifiedAt' | 'requirementsUk'> & {
  deadlineAt: Date | string | null;
  lastVerifiedAt: Date | string;
  requirementsUk: unknown;
  totalCount?: number | string;
};

@Injectable()
export class GrantsService implements OnModuleInit {
  private readonly logger = new Logger(GrantsService.name);

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedGrants();
    } catch (error) {
      this.logger.warn(`Grants init skipped: ${error instanceof Error ? error.message : error}`);
    }
  }

  async seedGrants(): Promise<number> {
    let seeded = 0;
    try {
      for (const item of INITIAL_GRANTS_SEED) {
        const res = await this.db.query(
          `INSERT INTO grants_opportunities (
            external_id, title, title_uk, organization,
            country_code, country_label_uk, region_details_uk,
            sector, sector_label_uk, opportunity_type,
            funding_amount, funding_max_usd, equity_free, co_financing_pct,
            stage, deadline_at, is_rolling,
            summary_uk, eligibility_uk, requirements_uk, application_tips_uk,
            official_url, worth_score, status, last_verified_at, updated_at
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17,
            $18, $19, $20::jsonb, $21,
            $22, $23, $24, now(), now()
          )
          ON CONFLICT (external_id) DO UPDATE SET
            title = EXCLUDED.title,
            title_uk = EXCLUDED.title_uk,
            organization = EXCLUDED.organization,
            country_code = EXCLUDED.country_code,
            country_label_uk = EXCLUDED.country_label_uk,
            region_details_uk = EXCLUDED.region_details_uk,
            sector = EXCLUDED.sector,
            sector_label_uk = EXCLUDED.sector_label_uk,
            opportunity_type = EXCLUDED.opportunity_type,
            funding_amount = EXCLUDED.funding_amount,
            funding_max_usd = EXCLUDED.funding_max_usd,
            equity_free = EXCLUDED.equity_free,
            co_financing_pct = EXCLUDED.co_financing_pct,
            stage = EXCLUDED.stage,
            deadline_at = EXCLUDED.deadline_at,
            is_rolling = EXCLUDED.is_rolling,
            summary_uk = EXCLUDED.summary_uk,
            eligibility_uk = EXCLUDED.eligibility_uk,
            requirements_uk = EXCLUDED.requirements_uk,
            application_tips_uk = EXCLUDED.application_tips_uk,
            official_url = EXCLUDED.official_url,
            worth_score = EXCLUDED.worth_score,
            status = EXCLUDED.status,
            last_verified_at = now(),
            updated_at = now()`,
          [
            item.externalId,
            item.title,
            item.titleUk,
            item.organization,
            item.countryCode,
            item.countryLabelUk,
            item.regionDetailsUk,
            item.sector,
            item.sectorLabelUk,
            item.opportunityType,
            item.fundingAmount,
            item.fundingMaxUsd,
            item.equityFree,
            item.coFinancingPct,
            item.stage,
            item.deadlineAt,
            item.isRolling,
            item.summaryUk,
            item.eligibilityUk,
            JSON.stringify(item.requirementsUk),
            item.applicationTipsUk,
            item.officialUrl,
            item.worthScore,
            item.status,
          ],
        );
        if (res.rowCount) seeded += 1;
      }
      this.logger.log(`Grants catalog seeded (${seeded} opportunities upserted).`);
      return seeded;
    } catch (error) {
      this.logger.warn(`Failed seeding grants_opportunities: ${error instanceof Error ? error.message : error}`);
      return seeded;
    }
  }

  async list(filters?: GrantsListFilters): Promise<GrantsListResult> {
    const limit = Math.max(1, Math.min(50, filters?.limit ?? 30));
    const offset = Math.max(0, filters?.offset ?? 0);

    const countryFilter = filters?.country && filters.country !== 'all' ? filters.country : null;
    const sectorFilter = filters?.sector && filters.sector !== 'all' ? filters.sector : null;
    const typeFilter = filters?.type && filters.type !== 'all' ? filters.type : null;
    const stageFilter = filters?.stage && filters.stage !== 'all' ? filters.stage : null;
    const equityFreeFilter = typeof filters?.equityFree === 'boolean' ? filters.equityFree : null;
    const qFilter = filters?.q?.trim() ? `%${filters.q.trim()}%` : null;

    let orderBy = 'worth_score DESC, funding_max_usd DESC, id DESC';
    if (filters?.sort === 'funding_desc') {
      orderBy = 'funding_max_usd DESC, worth_score DESC, id DESC';
    } else if (filters?.sort === 'deadline_asc') {
      orderBy = 'is_rolling ASC, deadline_at ASC NULLS LAST, worth_score DESC, id DESC';
    }

    const hasFilter = Boolean(
      countryFilter || sectorFilter || typeFilter || stageFilter || equityFreeFilter !== null || qFilter,
    );

    try {
      await this.db
        .query(
          `UPDATE grants_opportunities
           SET status = 'expired'
           WHERE status = 'active' AND is_rolling = false AND deadline_at IS NOT NULL AND deadline_at < now()`,
        )
        .catch(() => undefined);

      const { rows } = await this.db.query<GrantDbRow>(
        `SELECT id::text,
                external_id AS "externalId",
                title,
                title_uk AS "titleUk",
                organization,
                country_code AS "countryCode",
                country_label_uk AS "countryLabelUk",
                region_details_uk AS "regionDetailsUk",
                sector,
                sector_label_uk AS "sectorLabelUk",
                opportunity_type AS "opportunityType",
                funding_amount AS "fundingAmount",
                funding_max_usd::float AS "fundingMaxUsd",
                equity_free AS "equityFree",
                co_financing_pct AS "coFinancingPct",
                stage,
                deadline_at AS "deadlineAt",
                is_rolling AS "isRolling",
                summary_uk AS "summaryUk",
                eligibility_uk AS "eligibilityUk",
                requirements_uk AS "requirementsUk",
                application_tips_uk AS "applicationTipsUk",
                official_url AS "officialUrl",
                worth_score AS "worthScore",
                status,
                last_verified_at AS "lastVerifiedAt",
                COUNT(*) OVER()::int AS "totalCount"
         FROM grants_opportunities
         WHERE status = 'active'
           AND ($1::text IS NULL OR country_code = $1)
           AND ($2::text IS NULL OR sector = $2)
           AND ($3::text IS NULL OR opportunity_type = $3)
           AND ($4::text IS NULL OR stage = $4)
           AND ($5::boolean IS NULL OR equity_free = $5)
           AND ($6::text IS NULL OR
                title ILIKE $6 OR
                title_uk ILIKE $6 OR
                organization ILIKE $6 OR
                summary_uk ILIKE $6 OR
                eligibility_uk ILIKE $6 OR
                sector_label_uk ILIKE $6 OR
                country_label_uk ILIKE $6)
         ORDER BY ${orderBy}
         LIMIT $7 OFFSET $8`,
        [
          countryFilter,
          sectorFilter,
          typeFilter,
          stageFilter,
          equityFreeFilter,
          qFilter,
          limit,
          offset,
        ],
      );

      if (rows.length === 0) {
        if (!hasFilter && offset === 0) {
          return this.listFromSeed(filters);
        }
        const anyRowRes = await this.db
          .query('SELECT 1 FROM grants_opportunities LIMIT 1')
          .catch(() => ({ rows: [] }));
        if (anyRowRes.rows.length === 0) {
          return this.listFromSeed(filters);
        }
        return { items: [], total: 0, hasMore: false };
      }

      const total = Number(rows[0].totalCount ?? rows.length);
      const items = rows.map(mapGrantRow);
      return {
        items,
        total,
        hasMore: offset + items.length < total,
      };
    } catch (error) {
      this.logger.warn(`Failed querying grants_opportunities, falling back to seed: ${error instanceof Error ? error.message : error}`);
      return this.listFromSeed(filters);
    }
  }

  async getMeta(): Promise<GrantsMetaResult> {
    try {
      const [summaryRes, countryRes, sectorRes, typeRes] = await Promise.all([
        this.db.query<{
          total_active: string;
          equity_free_count: string;
          total_funding_usd: string;
          ua_count: string;
        }>(
          `SELECT COUNT(*) FILTER (WHERE status = 'active')::text AS total_active,
                  COUNT(*) FILTER (WHERE status = 'active' AND equity_free)::text AS equity_free_count,
                  COALESCE(SUM(funding_max_usd) FILTER (WHERE status = 'active'), 0)::text AS total_funding_usd,
                  COUNT(*) FILTER (WHERE status = 'active' AND country_code = 'ua')::text AS ua_count
           FROM grants_opportunities`,
        ),
        this.db.query<{ key: string; cnt: string }>(
          `SELECT country_code AS key, COUNT(*)::text AS cnt
           FROM grants_opportunities
           WHERE status = 'active'
           GROUP BY country_code`,
        ),
        this.db.query<{ key: string; cnt: string }>(
          `SELECT sector AS key, COUNT(*)::text AS cnt
           FROM grants_opportunities
           WHERE status = 'active'
           GROUP BY sector`,
        ),
        this.db.query<{ key: string; cnt: string }>(
          `SELECT opportunity_type AS key, COUNT(*)::text AS cnt
           FROM grants_opportunities
           WHERE status = 'active'
           GROUP BY opportunity_type`,
        ),
      ]);

      const totalActive = Number(summaryRes.rows[0]?.total_active ?? 0);
      if (totalActive === 0) {
        return this.computeMetaFromSeed();
      }

      return {
        totalActive,
        equityFreeCount: Number(summaryRes.rows[0]?.equity_free_count ?? 0),
        totalFundingUsd: Number(summaryRes.rows[0]?.total_funding_usd ?? 0),
        uaCount: Number(summaryRes.rows[0]?.ua_count ?? 0),
        byCountry: rowsToCountMap(countryRes.rows),
        bySector: rowsToCountMap(sectorRes.rows),
        byType: rowsToCountMap(typeRes.rows),
      };
    } catch (error) {
      this.logger.warn(`Failed computing grants meta from DB, falling back to seed: ${error instanceof Error ? error.message : error}`);
      return this.computeMetaFromSeed();
    }
  }

  async getByExternalId(externalId: string): Promise<GrantOpportunityItem | null> {
    try {
      const { rows } = await this.db.query<GrantDbRow>(
        `SELECT id::text,
                external_id AS "externalId",
                title,
                title_uk AS "titleUk",
                organization,
                country_code AS "countryCode",
                country_label_uk AS "countryLabelUk",
                region_details_uk AS "regionDetailsUk",
                sector,
                sector_label_uk AS "sectorLabelUk",
                opportunity_type AS "opportunityType",
                funding_amount AS "fundingAmount",
                funding_max_usd::float AS "fundingMaxUsd",
                equity_free AS "equityFree",
                co_financing_pct AS "coFinancingPct",
                stage,
                deadline_at AS "deadlineAt",
                is_rolling AS "isRolling",
                summary_uk AS "summaryUk",
                eligibility_uk AS "eligibilityUk",
                requirements_uk AS "requirementsUk",
                application_tips_uk AS "applicationTipsUk",
                official_url AS "officialUrl",
                worth_score AS "worthScore",
                status,
                last_verified_at AS "lastVerifiedAt"
         FROM grants_opportunities
         WHERE external_id = $1
         LIMIT 1`,
        [externalId],
      );
      if (rows[0]) {
        return mapGrantRow(rows[0]);
      }
      return INITIAL_GRANTS_SEED.find((g) => g.externalId === externalId) ?? null;
    } catch {
      return INITIAL_GRANTS_SEED.find((g) => g.externalId === externalId) ?? null;
    }
  }

  async refresh(): Promise<{ seeded: number }> {
    const seeded = await this.seedGrants();
    return { seeded };
  }

  private listFromSeed(filters?: GrantsListFilters): GrantsListResult {
    const limit = Math.max(1, Math.min(50, filters?.limit ?? 30));
    const offset = Math.max(0, filters?.offset ?? 0);

    let items = INITIAL_GRANTS_SEED.filter((g) => g.status === 'active');

    if (filters?.country && filters.country !== 'all') {
      items = items.filter((g) => g.countryCode === filters.country);
    }
    if (filters?.sector && filters.sector !== 'all') {
      items = items.filter((g) => g.sector === filters.sector);
    }
    if (filters?.type && filters.type !== 'all') {
      items = items.filter((g) => g.opportunityType === filters.type);
    }
    if (filters?.stage && filters.stage !== 'all') {
      items = items.filter((g) => g.stage === filters.stage);
    }
    if (typeof filters?.equityFree === 'boolean') {
      items = items.filter((g) => g.equityFree === filters.equityFree);
    }
    if (filters?.q?.trim()) {
      const q = filters.q.trim().toLowerCase();
      items = items.filter(
        (g) =>
          g.title.toLowerCase().includes(q) ||
          g.titleUk.toLowerCase().includes(q) ||
          g.organization.toLowerCase().includes(q) ||
          g.summaryUk.toLowerCase().includes(q) ||
          g.eligibilityUk.toLowerCase().includes(q) ||
          g.sectorLabelUk.toLowerCase().includes(q) ||
          g.countryLabelUk.toLowerCase().includes(q),
      );
    }

    const sorted = [...items];
    if (filters?.sort === 'funding_desc') {
      sorted.sort((a, b) => b.fundingMaxUsd - a.fundingMaxUsd || b.worthScore - a.worthScore);
    } else if (filters?.sort === 'deadline_asc') {
      sorted.sort((a, b) => {
        if (a.isRolling !== b.isRolling) return a.isRolling ? 1 : -1;
        const aTime = a.deadlineAt ? Date.parse(a.deadlineAt) : Number.POSITIVE_INFINITY;
        const bTime = b.deadlineAt ? Date.parse(b.deadlineAt) : Number.POSITIVE_INFINITY;
        if (aTime !== bTime) return aTime - bTime;
        return b.worthScore - a.worthScore;
      });
    } else {
      sorted.sort((a, b) => b.worthScore - a.worthScore || b.fundingMaxUsd - a.fundingMaxUsd);
    }

    const page = sorted.slice(offset, offset + limit);
    return {
      items: page,
      total: sorted.length,
      hasMore: offset + page.length < sorted.length,
    };
  }

  private computeMetaFromSeed(): GrantsMetaResult {
    const active = INITIAL_GRANTS_SEED.filter((g) => g.status === 'active');
    const byCountry: Record<string, number> = {};
    const bySector: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let equityFreeCount = 0;
    let totalFundingUsd = 0;
    let uaCount = 0;

    for (const item of active) {
      if (item.equityFree) equityFreeCount += 1;
      totalFundingUsd += item.fundingMaxUsd;
      if (item.countryCode === 'ua') uaCount += 1;
      byCountry[item.countryCode] = (byCountry[item.countryCode] ?? 0) + 1;
      bySector[item.sector] = (bySector[item.sector] ?? 0) + 1;
      byType[item.opportunityType] = (byType[item.opportunityType] ?? 0) + 1;
    }

    return {
      totalActive: active.length,
      equityFreeCount,
      totalFundingUsd,
      uaCount,
      byCountry,
      bySector,
      byType,
    };
  }
}

function mapGrantRow(row: GrantDbRow): GrantOpportunityItem {
  return {
    id: String(row.id),
    externalId: row.externalId,
    title: row.title,
    titleUk: row.titleUk,
    organization: row.organization,
    countryCode: row.countryCode,
    countryLabelUk: row.countryLabelUk,
    regionDetailsUk: row.regionDetailsUk ?? null,
    sector: row.sector,
    sectorLabelUk: row.sectorLabelUk,
    opportunityType: row.opportunityType,
    fundingAmount: row.fundingAmount,
    fundingMaxUsd: Number(row.fundingMaxUsd ?? 0),
    equityFree: Boolean(row.equityFree),
    coFinancingPct: Number(row.coFinancingPct ?? 0),
    stage: row.stage,
    deadlineAt: toIsoStringOrNull(row.deadlineAt),
    isRolling: Boolean(row.isRolling),
    summaryUk: row.summaryUk,
    eligibilityUk: row.eligibilityUk,
    requirementsUk: Array.isArray(row.requirementsUk)
      ? row.requirementsUk.map((item) => String(item))
      : [],
    applicationTipsUk: row.applicationTipsUk ?? null,
    officialUrl: row.officialUrl,
    worthScore: Number(row.worthScore ?? 0),
    status: row.status,
    lastVerifiedAt: toIsoStringOrNull(row.lastVerifiedAt) ?? new Date().toISOString(),
  };
}

function toIsoStringOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function rowsToCountMap(rows: Array<{ key: string; cnt: string }>): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rows) {
    if (row.key) {
      map[row.key] = Number(row.cnt ?? 0);
    }
  }
  return map;
}
