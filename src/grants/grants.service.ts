import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { postGeminiGenerateContent } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';
import {
  type GrantAudienceCode,
  type GrantOpportunityItem,
  INITIAL_GRANTS_SEED,
} from './grants-seed';

export const DAILY_AI_VERIFY_INTERVAL_MS = 24 * 60 * 60_000;

export interface GrantsListFilters {
  country?: string;
  sector?: string;
  type?: string;
  stage?: string;
  audience?: string;
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
  byAudience: Record<string, number>;
  lastAiVerificationAt: string;
  dailyCheckIntervalHours: 24;
}

export interface GrantsAiVerifyResult {
  checked: number;
  updated: number;
  expired: number;
  skipped: boolean;
  reason?: string;
  lastAiVerificationAt: string;
}

type GrantDbRow = Omit<
  GrantOpportunityItem,
  'deadlineAt' | 'lastVerifiedAt' | 'requirementsUk' | 'audiences' | 'targetAudienceUk'
> & {
  deadlineAt: Date | string | null;
  lastVerifiedAt: Date | string;
  requirementsUk: unknown;
  audiences?: unknown;
  targetAudienceUk?: string | null;
  totalCount?: number | string;
};

const SEED_BY_EXTERNAL_ID = new Map(INITIAL_GRANTS_SEED.map((g) => [g.externalId, g]));

const PORTAL_VERIFICATION_TARGETS = [
  { externalId: 'brave1-defense-tech', url: 'https://brave1.gov.ua/' },
  { externalId: 'usf-preseed-seed', url: 'https://usf.com.ua/' },
  { externalId: 'seeds-of-bravery-deeptech', url: 'https://seedsofbravery.eu/' },
  {
    externalId: 'eic-accelerator-horizon',
    url: 'https://eic.ec.europa.eu/eic-funding-opportunities/eic-accelerator_en',
  },
  { externalId: 'devpost-mlh-ai-hackathons', url: 'https://devpost.com/hackathons' },
  { externalId: 'ethglobal-ai-hackathons', url: 'https://ethglobal.com/events' },
];

const grantsVerificationSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          externalId: { type: 'string' },
          status: { type: 'string', enum: ['active', 'expired'] },
          deadlineAt: { type: 'string' },
          isRolling: { type: 'boolean' },
          fundingAmount: { type: 'string' },
          noteUk: { type: 'string' },
        },
        required: ['externalId', 'status'],
      },
    },
  },
  required: ['items'],
};

@Injectable()
export class GrantsService implements OnModuleInit, OnModuleDestroy {
  static lastAiVerificationAt: string =
    INITIAL_GRANTS_SEED[0]?.lastVerifiedAt ?? '2026-11-14T18:00:00Z';
  static readonly dailyCheckIntervalHours = 24;

  private readonly logger = new Logger(GrantsService.name);
  private readonly geminiKey = process.env.GEMINI_API_KEY?.trim();
  private readonly geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
  private verifyTimer?: NodeJS.Timeout;
  private isDestroyed = false;
  private activeVerify?: Promise<GrantsAiVerifyResult>;

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedGrants();
      await this.syncLastAiVerificationTimestampFromDb();
    } catch (error) {
      this.logger.warn(`Grants init skipped: ${error instanceof Error ? error.message : error}`);
    }

    const scheduleNext = () => {
      this.verifyTimer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.verifyAndRefreshWithGemini(false);
        } catch (error) {
          this.logger.warn(
            `Daily grants verification failed: ${error instanceof Error ? error.message : error}`,
          );
        } finally {
          if (!this.isDestroyed) scheduleNext();
        }
      }, DAILY_AI_VERIFY_INTERVAL_MS);
    };

    // Initial check 20s after server start (respects 24h cooldown unless overdue)
    this.verifyTimer = setTimeout(async () => {
      if (this.isDestroyed) return;
      try {
        await this.verifyAndRefreshWithGemini(false);
      } catch (error) {
        this.logger.warn(
          `Initial grants verification check failed: ${error instanceof Error ? error.message : error}`,
        );
      } finally {
        if (!this.isDestroyed) scheduleNext();
      }
    }, 20_000);
  }

  onModuleDestroy(): void {
    this.isDestroyed = true;
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
  }

  async seedGrants(): Promise<number> {
    let seeded = 0;
    let useLegacySchema = false;

    for (const item of INITIAL_GRANTS_SEED) {
      try {
        if (!useLegacySchema) {
          const res = await this.upsertGrantFull(item);
          if (res.rowCount) seeded += 1;
          continue;
        }
      } catch (error) {
        if (isPre009SchemaError(error)) {
          useLegacySchema = true;
        } else {
          this.logger.warn(
            `Failed seeding grant ${item.externalId}: ${error instanceof Error ? error.message : error}`,
          );
          return seeded;
        }
      }

      try {
        const res = await this.upsertGrantLegacy(item);
        if (res.rowCount) seeded += 1;
      } catch (legacyErr) {
        this.logger.warn(
          `Legacy grant upsert skipped ${item.externalId}: ${legacyErr instanceof Error ? legacyErr.message : legacyErr}`,
        );
      }
    }

    if (seeded > 0) {
      this.logger.log(`Grants catalog seeded (${seeded} opportunities upserted).`);
    }
    return seeded;
  }

  async list(filters?: GrantsListFilters): Promise<GrantsListResult> {
    const limit = Math.max(1, Math.min(50, filters?.limit ?? 30));
    const offset = Math.max(0, filters?.offset ?? 0);

    const countryFilter = filters?.country && filters.country !== 'all' ? filters.country : null;
    const sectorFilter = filters?.sector && filters.sector !== 'all' ? filters.sector : null;
    const typeFilter = filters?.type && filters.type !== 'all' ? filters.type : null;
    const stageFilter = filters?.stage && filters.stage !== 'all' ? filters.stage : null;
    const audienceFilter =
      filters?.audience && filters.audience !== 'all' ? filters.audience : null;
    const equityFreeFilter =
      typeof filters?.equityFree === 'boolean' ? filters.equityFree : null;
    const qFilter = filters?.q?.trim() ? `%${filters.q.trim()}%` : null;

    let orderBy = 'worth_score DESC, funding_max_usd DESC, id DESC';
    if (filters?.sort === 'funding_desc') {
      orderBy = 'funding_max_usd DESC, worth_score DESC, id DESC';
    } else if (filters?.sort === 'deadline_asc') {
      orderBy = 'is_rolling ASC, deadline_at ASC NULLS LAST, worth_score DESC, id DESC';
    }

    const hasFilter = Boolean(
      countryFilter ||
        sectorFilter ||
        typeFilter ||
        stageFilter ||
        audienceFilter ||
        equityFreeFilter !== null ||
        qFilter,
    );

    try {
      await this.markExpiredInDb();

      let rows: GrantDbRow[] = [];
      let legacyFallbackUsed = false;

      try {
        const res = await this.db.query<GrantDbRow>(
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
                  audiences,
                  target_audience_uk AS "targetAudienceUk",
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
                  country_label_uk ILIKE $6 OR
                  target_audience_uk ILIKE $6)
             AND ($7::text IS NULL OR audiences @> jsonb_build_array($7::text))
           ORDER BY ${orderBy}
           LIMIT $8 OFFSET $9`,
          [
            countryFilter,
            sectorFilter,
            typeFilter,
            stageFilter,
            equityFreeFilter,
            qFilter,
            audienceFilter,
            limit,
            offset,
          ],
        );
        rows = res.rows;
      } catch (err) {
        if (!isPre009SchemaError(err)) throw err;
        legacyFallbackUsed = true;
        const res = await this.db.query<GrantDbRow>(
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
           ORDER BY ${orderBy}`,
          [
            countryFilter,
            sectorFilter,
            typeFilter,
            stageFilter,
            equityFreeFilter,
            qFilter,
          ],
        );
        rows = res.rows;
      }

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

      let mapped = rows.map(mapGrantRow);
      if (legacyFallbackUsed) {
        if (audienceFilter) {
          mapped = mapped.filter((g) => g.audiences.includes(audienceFilter as GrantAudienceCode));
        }
        const page = mapped.slice(offset, offset + limit);
        return {
          items: page,
          total: mapped.length,
          hasMore: offset + page.length < mapped.length,
        };
      }

      const total = Number(rows[0].totalCount ?? rows.length);
      return {
        items: mapped,
        total,
        hasMore: offset + mapped.length < total,
      };
    } catch (error) {
      this.logger.warn(
        `Failed querying grants_opportunities, falling back to seed: ${error instanceof Error ? error.message : error}`,
      );
      return this.listFromSeed(filters);
    }
  }

  async getMeta(): Promise<GrantsMetaResult> {
    try {
      const [summaryRes, countryRes, sectorRes, typeRes, audienceRes, aiVerifyRes] =
        await Promise.all([
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
        ]);

      const totalActive = Number(summaryRes.rows[0]?.total_active ?? 0);
      if (totalActive === 0) {
        return this.computeMetaFromSeed();
      }

      const seedMeta = this.computeMetaFromSeed();
      const byAudience =
        audienceRes && audienceRes.rows.length > 0
          ? rowsToCountMap(audienceRes.rows)
          : seedMeta.byAudience;
      const dbAiAt = toIsoStringOrNull(aiVerifyRes?.rows[0]?.last_ai);

      return {
        totalActive,
        equityFreeCount: Number(summaryRes.rows[0]?.equity_free_count ?? 0),
        totalFundingUsd: Number(summaryRes.rows[0]?.total_funding_usd ?? 0),
        uaCount: Number(summaryRes.rows[0]?.ua_count ?? 0),
        byCountry: rowsToCountMap(countryRes.rows),
        bySector: rowsToCountMap(sectorRes.rows),
        byType: rowsToCountMap(typeRes.rows),
        byAudience,
        lastAiVerificationAt: dbAiAt ?? GrantsService.lastAiVerificationAt,
        dailyCheckIntervalHours: GrantsService.dailyCheckIntervalHours,
      };
    } catch (error) {
      this.logger.warn(
        `Failed computing grants meta from DB, falling back to seed: ${error instanceof Error ? error.message : error}`,
      );
      return this.computeMetaFromSeed();
    }
  }

  async getByExternalId(externalId: string): Promise<GrantOpportunityItem | null> {
    try {
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
                  audiences,
                  target_audience_uk AS "targetAudienceUk",
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
      } catch (err) {
        if (!isPre009SchemaError(err)) throw err;
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
      }
      return SEED_BY_EXTERNAL_ID.get(externalId) ?? null;
    } catch {
      return SEED_BY_EXTERNAL_ID.get(externalId) ?? null;
    }
  }

  async verifyAndRefreshWithGemini(force = false): Promise<GrantsAiVerifyResult> {
    if (this.activeVerify) {
      return this.activeVerify;
    }
    this.activeVerify = this.executeDailyVerification(force).finally(() => {
      this.activeVerify = undefined;
    });
    return this.activeVerify;
  }

  async refresh(force = false): Promise<{
    seeded: number;
    aiVerification: GrantsAiVerifyResult;
  }> {
    const seeded = await this.seedGrants();
    const aiVerification = await this.verifyAndRefreshWithGemini(force);
    return { seeded, aiVerification };
  }

  private async executeDailyVerification(force: boolean): Promise<GrantsAiVerifyResult> {
    const expired = await this.markExpiredInDb();
    await this.syncLastAiVerificationTimestampFromDb();

    const lastMs = Date.parse(GrantsService.lastAiVerificationAt);
    const elapsedMs = Number.isFinite(lastMs) ? Date.now() - lastMs : Number.POSITIVE_INFINITY;

    if (!force && elapsedMs < DAILY_AI_VERIFY_INTERVAL_MS) {
      return {
        checked: 0,
        updated: 0,
        expired,
        skipped: true,
        reason: 'Verified within last 24 hours',
        lastAiVerificationAt: GrantsService.lastAiVerificationAt,
      };
    }

    if (!this.geminiKey || this.geminiKey.startsWith('replace_')) {
      return {
        checked: 0,
        updated: 0,
        expired,
        skipped: true,
        reason: 'GEMINI_API_KEY is not configured',
        lastAiVerificationAt: GrantsService.lastAiVerificationAt,
      };
    }

    const portalSnippets: Array<{ externalId: string; url: string; excerpt: string }> = [];
    for (const target of PORTAL_VERIFICATION_TARGETS) {
      try {
        const resp = await fetch(target.url, {
          signal: AbortSignal.timeout(7_000),
          headers: { 'User-Agent': 'OpportunityRadar/1.0' },
        });
        if (!resp.ok) {
          await resp.body?.cancel();
          continue;
        }
        const html = await resp.text();
        const clean = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1200);
        if (clean) {
          portalSnippets.push({ externalId: target.externalId, url: target.url, excerpt: clean });
        }
      } catch (err) {
        this.logger.warn(
          `Portal fetch failed (${target.url}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (portalSnippets.length === 0) {
      return {
        checked: 0,
        updated: 0,
        expired,
        skipped: true,
        reason: 'No official portals reachable during verification',
        lastAiVerificationAt: GrantsService.lastAiVerificationAt,
      };
    }

    try {
      const currentSnapshots = portalSnippets.map((s) => {
        const existing = SEED_BY_EXTERNAL_ID.get(s.externalId);
        return {
          externalId: s.externalId,
          url: s.url,
          currentStatus: existing?.status ?? 'active',
          currentDeadlineAt: existing?.deadlineAt ?? null,
          currentIsRolling: existing?.isRolling ?? false,
          currentFundingAmount: existing?.fundingAmount ?? '',
          excerpt: s.excerpt,
        };
      });

      const prompt = `Ти аналітик грантових і хакатон-програм. Перевір актуальність дедлайнів, статусів (active/expired) та сум фінансування за витягами з офіційних порталів станом на ${new Date().toISOString()}.
Використовуй ЛИШЕ факти з наведених витягів. Якщо портал не вказує точний новий дедлайн — залишай попередній статус "active" для постійних (rolling) програм.

Дані порталів:
${JSON.stringify(currentSnapshots)}

Поверни JSON за схемою.`;

      const { data } = await postGeminiGenerateContent({
        apiKey: this.geminiKey,
        preferredModel: this.geminiModel,
        timeoutMs: 45_000,
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseJsonSchema: grantsVerificationSchema,
            maxOutputTokens: 2048,
          },
        },
      });

      const raw = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = raw.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Empty Gemini grants verification response');
      }

      const parsed = JSON.parse(text) as {
        items?: Array<{
          externalId: string;
          status: 'active' | 'expired';
          deadlineAt?: string;
          isRolling?: boolean;
          fundingAmount?: string;
        }>;
      };
      const verifiedItems = Array.isArray(parsed.items) ? parsed.items : [];
      let updated = 0;

      for (const item of verifiedItems) {
        if (!item?.externalId || (item.status !== 'active' && item.status !== 'expired')) {
          continue;
        }
        const validDeadline =
          item.deadlineAt && Number.isFinite(Date.parse(item.deadlineAt))
            ? new Date(item.deadlineAt).toISOString()
            : null;
        const validFunding =
          typeof item.fundingAmount === 'string' && item.fundingAmount.trim()
            ? item.fundingAmount.trim().slice(0, 120)
            : null;

        const res = await this.db
          .query(
            `UPDATE grants_opportunities
             SET status = $2,
                 deadline_at = COALESCE($3::timestamptz, deadline_at),
                 is_rolling = COALESCE($4::boolean, is_rolling),
                 funding_amount = COALESCE($5::varchar, funding_amount),
                 last_verified_at = now(),
                 last_ai_verified_at = now(),
                 updated_at = now()
             WHERE external_id = $1`,
            [
              item.externalId,
              item.status,
              validDeadline,
              typeof item.isRolling === 'boolean' ? item.isRolling : null,
              validFunding,
            ],
          )
          .catch(async (err) => {
            if (!isPre009SchemaError(err)) return null;
            return this.db
              .query(
                `UPDATE grants_opportunities
                 SET status = $2,
                     deadline_at = COALESCE($3::timestamptz, deadline_at),
                     is_rolling = COALESCE($4::boolean, is_rolling),
                     funding_amount = COALESCE($5::varchar, funding_amount),
                     last_verified_at = now(),
                     updated_at = now()
                 WHERE external_id = $1`,
                [
                  item.externalId,
                  item.status,
                  validDeadline,
                  typeof item.isRolling === 'boolean' ? item.isRolling : null,
                  validFunding,
                ],
              )
              .catch(() => null);
          });
        if (res?.rowCount) updated += 1;
      }

      const nowIso = new Date().toISOString();
      GrantsService.lastAiVerificationAt = nowIso;
      await this.db
        .query(`UPDATE grants_opportunities SET last_ai_verified_at = now() WHERE status = 'active'`)
        .catch(() => undefined);

      this.logger.log(
        `Daily Gemini grants verification complete: ${portalSnippets.length} checked, ${updated} updated, ${expired} expired.`,
      );
      return {
        checked: portalSnippets.length,
        updated,
        expired,
        skipped: false,
        lastAiVerificationAt: nowIso,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Gemini grants verification failed: ${msg}`);
      return {
        checked: portalSnippets.length,
        updated: 0,
        expired,
        skipped: false,
        reason: msg,
        lastAiVerificationAt: GrantsService.lastAiVerificationAt,
      };
    }
  }

  private async markExpiredInDb(): Promise<number> {
    try {
      const res = await this.db.query(
        `UPDATE grants_opportunities
         SET status = 'expired', updated_at = now()
         WHERE status = 'active' AND is_rolling = false AND deadline_at IS NOT NULL AND deadline_at < now()`,
      );
      return res.rowCount ?? 0;
    } catch {
      return 0;
    }
  }

  private async syncLastAiVerificationTimestampFromDb(): Promise<void> {
    try {
      const res = await this.db.query<{ last_ai: string | null }>(
        `SELECT MAX(last_ai_verified_at)::text AS last_ai FROM grants_opportunities`,
      );
      const iso = toIsoStringOrNull(res.rows[0]?.last_ai);
      if (iso) {
        GrantsService.lastAiVerificationAt = iso;
      }
    } catch {
      // Pre-009 or DB not ready; keep in-memory timestamp
    }
  }

  private async upsertGrantFull(item: GrantOpportunityItem) {
    return this.db.query(
      `INSERT INTO grants_opportunities (
        external_id, title, title_uk, organization,
        country_code, country_label_uk, region_details_uk,
        sector, sector_label_uk, opportunity_type,
        audiences, target_audience_uk,
        funding_amount, funding_max_usd, equity_free, co_financing_pct,
        stage, deadline_at, is_rolling,
        summary_uk, eligibility_uk, requirements_uk, application_tips_uk,
        official_url, worth_score, status, last_verified_at, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        $11::jsonb, $12,
        $13, $14, $15, $16,
        $17, $18, $19,
        $20, $21, $22::jsonb, $23,
        $24, $25, $26, now(), now()
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
        audiences = EXCLUDED.audiences,
        target_audience_uk = EXCLUDED.target_audience_uk,
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
        JSON.stringify(item.audiences),
        item.targetAudienceUk,
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
  }

  private async upsertGrantLegacy(item: GrantOpportunityItem) {
    const legacyType =
      item.opportunityType === 'hackathon' || item.opportunityType === 'contest'
        ? 'competition'
        : item.opportunityType;

    return this.db.query(
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
        legacyType,
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
    if (filters?.audience && filters.audience !== 'all') {
      items = items.filter((g) => g.audiences.includes(filters.audience as GrantAudienceCode));
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
          g.countryLabelUk.toLowerCase().includes(q) ||
          g.targetAudienceUk.toLowerCase().includes(q),
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
    const byAudience: Record<string, number> = {};
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
      for (const audience of item.audiences) {
        byAudience[audience] = (byAudience[audience] ?? 0) + 1;
      }
    }

    return {
      totalActive: active.length,
      equityFreeCount,
      totalFundingUsd,
      uaCount,
      byCountry,
      bySector,
      byType,
      byAudience,
      lastAiVerificationAt: GrantsService.lastAiVerificationAt,
      dailyCheckIntervalHours: GrantsService.dailyCheckIntervalHours,
    };
  }
}

function isPre009SchemaError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /column "(audiences|target_audience_uk|last_ai_verified_at)"/i.test(msg) ||
    /grants_opportunities_opportunity_type_check/i.test(msg)
  );
}

function mapGrantRow(row: GrantDbRow): GrantOpportunityItem {
  const seed = SEED_BY_EXTERNAL_ID.get(row.externalId);
  const parsedAudiences = Array.isArray(row.audiences)
    ? (row.audiences.map((a) => String(a)) as GrantAudienceCode[])
    : [];
  const audiences = parsedAudiences.length > 0 ? parsedAudiences : (seed?.audiences ?? ['startups']);
  const targetAudienceUk =
    row.targetAudienceUk && row.targetAudienceUk.trim().length > 0
      ? row.targetAudienceUk
      : (seed?.targetAudienceUk ?? 'Стартапи та розробники');

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
    audiences,
    targetAudienceUk,
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
