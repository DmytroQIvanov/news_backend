import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { generateJsonWithRouter } from '../common/llm-router';
import { DatabaseService } from '../database/database.service';
import { mapArenaRows, rankMovement, validateDiscoveredTools, type ArenaEntry } from './ai-rankings.util';
import { AI_GROUPS, AI_SUBCATEGORIES, SEED_TOOLS, getSubcategory, type ArenaSource } from './taxonomy';

const ARENA_DATASET = 'lmarena-ai/leaderboard-dataset';
const ARENA_LIMIT = 25;
const CYCLE_MS = 6 * 60 * 60_000;
const ARENA_REFRESH_MS = 20 * 60 * 60_000;
const NEW_BADGE_DAYS = 14;
const NEWS_BATCH = 20;

const PRODUCT_SUBCATEGORIES = AI_SUBCATEGORIES.filter((s) => !s.arena);

export interface RankedToolDto {
  rank: number;
  slug: string;
  name: string;
  vendor: string | null;
  kind: 'product' | 'model';
  url: string | null;
  hasFree: boolean | null;
  isOpen: boolean;
  license: string | null;
  descriptionUk: string | null;
  descriptionEn: string | null;
  score: number | null;
  votes: number | null;
  basis: 'arena' | 'seed' | 'news';
  movement: number | null;
  isNew: boolean;
  mentions30d: number;
}

type ToolRow = {
  rank: number; slug: string; name: string; vendor: string | null; kind: 'product' | 'model'; url: string | null;
  has_free: boolean | null; is_open: boolean; license: string | null; description_uk: string | null; description_en: string | null;
  score: number | null; votes: number | null; basis: 'arena' | 'seed' | 'news'; prev_rank: number | null; is_new: boolean; mentions30d: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toDto(r: ToolRow): RankedToolDto {
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    vendor: r.vendor,
    kind: r.kind,
    url: r.url,
    hasFree: r.has_free,
    isOpen: r.is_open,
    license: r.license,
    descriptionUk: r.description_uk,
    descriptionEn: r.description_en,
    score: r.score === null ? null : Math.round(Number(r.score)),
    votes: r.votes,
    basis: r.basis,
    movement: rankMovement(r.rank, r.prev_rank),
    isNew: Boolean(r.is_new),
    mentions30d: Number(r.mentions30d) || 0,
  };
}

@Injectable()
export class AiRankingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiRankingsService.name);
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private running?: Promise<Record<string, unknown>>;

  constructor(@Optional() private readonly db?: DatabaseService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.db || process.env.AI_RANKINGS_ENABLED === 'false') return;
    const loop = (delay: number) => {
      this.timer = setTimeout(async () => {
        if (this.destroyed) return;
        try {
          await this.runCycle(false);
        } catch (err) {
          this.logger.warn(`AI rankings cycle failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.destroyed) loop(CYCLE_MS);
        }
      }, delay);
      this.timer.unref?.();
    };
    loop(90_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Seed -> LMArena (at most once per ~day) -> news discovery -> editorial re-rank -> daily history snapshot. */
  runCycle(force: boolean): Promise<Record<string, unknown>> {
    if (this.running) return this.running;
    this.running = (async () => {
      const result: Record<string, unknown> = {};
      result.seeded = await this.ensureSeed();
      const last = Date.parse((await this.getMeta('arena_refreshed_at')) || '');
      if (force || !Number.isFinite(last) || Date.now() - last > ARENA_REFRESH_MS) {
        result.arena = await this.refreshArena();
      } else {
        // Leaderboards that failed last time (e.g. dataset index still loading) are retried every cycle.
        const failed = ((await this.getMeta('arena_failed')) || '').split(',').filter(Boolean);
        if (failed.length) result.arenaRetry = await this.refreshArena(new Set(failed));
      }
      if (process.env.AI_TOOL_DISCOVERY !== 'false') result.discovered = await this.discoverFromNews();
      await this.recomputeEditorialRanks();
      await this.snapshotHistory();
      this.logger.log(`AI rankings cycle done: ${JSON.stringify(result)}`);
      return result;
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  // ------------------------------------------------------------------ meta

  private async getMeta(key: string): Promise<string | null> {
    const { rows } = await this.db!.query<{ value: string }>(`SELECT value FROM ai_rankings_meta WHERE key = $1`, [key]);
    return rows[0]?.value ?? null;
  }

  private async setMeta(key: string, value: string): Promise<void> {
    await this.db!.query(
      `INSERT INTO ai_rankings_meta (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }

  // ------------------------------------------------------------------ seed

  async ensureSeed(): Promise<boolean> {
    const seedPairs: Array<{ sub: string; slug: string; pos: number }> = [];
    for (const sub of PRODUCT_SUBCATEGORIES) {
      (sub.seed || []).forEach((slug, pos) => {
        if (SEED_TOOLS[slug]) seedPairs.push({ sub: sub.slug, slug, pos });
      });
    }
    const version = createHash('sha256')
      .update(JSON.stringify([SEED_TOOLS, seedPairs, AI_SUBCATEGORIES.map((s) => s.slug)]))
      .digest('hex')
      .slice(0, 16);
    if ((await this.getMeta('seed_version')) === version) return false;

    const slugs = Object.keys(SEED_TOOLS);
    const tools = slugs.map((s) => SEED_TOOLS[s]);
    await this.db!.query(
      `INSERT INTO ai_tools (slug, name, vendor, kind, url, has_free, is_open, source)
       SELECT s, n, v, 'product', u, f, o, 'seed'
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bool[], $6::bool[]) AS x(s, n, v, u, f, o)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, vendor = EXCLUDED.vendor, url = EXCLUDED.url,
         has_free = EXCLUDED.has_free, is_open = EXCLUDED.is_open, source = 'seed', updated_at = now()
       WHERE ai_tools.source IN ('seed', 'news')`,
      [slugs, tools.map((t) => t.name), tools.map((t) => t.vendor), tools.map((t) => t.url), tools.map((t) => t.free), tools.map((t) => Boolean(t.open))],
    );
    await this.db!.query(
      `INSERT INTO ai_tool_ranks (subcategory, tool_slug, rank, basis, seed_pos)
       SELECT sub, slug, pos + 1, 'seed', pos FROM unnest($1::text[], $2::text[], $3::int[]) AS x(sub, slug, pos)
       ON CONFLICT (subcategory, tool_slug) DO UPDATE SET seed_pos = EXCLUDED.seed_pos,
         basis = CASE WHEN ai_tool_ranks.basis = 'arena' THEN 'arena' ELSE 'seed' END, updated_at = now()`,
      [seedPairs.map((p) => p.sub), seedPairs.map((p) => p.slug), seedPairs.map((p) => p.pos)],
    );
    // Drop seed entries / subcategories that were removed from the taxonomy (news-found tools stay).
    await this.db!.query(
      `UPDATE ai_tool_ranks SET basis = 'news', seed_pos = NULL
       WHERE basis = 'seed' AND NOT ((subcategory || '|' || tool_slug) = ANY($1::text[]))`,
      [seedPairs.map((p) => `${p.sub}|${p.slug}`)],
    );
    await this.db!.query(`DELETE FROM ai_tool_ranks WHERE NOT (subcategory = ANY($1::text[]))`, [AI_SUBCATEGORIES.map((s) => s.slug)]);
    await this.setMeta('seed_version', version);
    return true;
  }

  // ------------------------------------------------------------------ LMArena

  private async fetchArena(src: ArenaSource): Promise<ArenaEntry[]> {
    const where = `"category"='${src.category.replace(/'/g, '')}'${src.openOnly ? ` AND "license"<>'Proprietary'` : ''}`;
    const params = new URLSearchParams({
      dataset: ARENA_DATASET,
      config: src.config,
      split: 'latest',
      where,
      orderby: '"rank" ASC',
      offset: '0',
      length: String(ARENA_LIMIT),
    });
    // The Hugging Face datasets-server builds its index lazily ("index is loading"): wait and retry once.
    for (let attempt = 1; ; attempt += 1) {
      const resp = await fetch(`https://datasets-server.huggingface.co/filter?${params}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'OpportunityRadar-AiRankings/1.0' },
        signal: AbortSignal.timeout(60_000),
      }).catch((err: unknown) => {
        if (attempt < 2) return null;
        throw err;
      });
      if (resp?.ok) return mapArenaRows(await resp.json());
      const body = resp ? (await resp.text().catch(() => '')).slice(0, 160) : 'timeout';
      if (attempt >= 2 || !/loading|timeout/i.test(body)) throw new Error(`LMArena dataset HTTP ${resp?.status ?? 0}: ${body}`);
      await sleep(30_000);
    }
  }

  async refreshArena(only?: Set<string>): Promise<{ updated: number; failed: string[] }> {
    let updated = 0;
    const failed: string[] = [];
    for (const sub of AI_SUBCATEGORIES) {
      if (this.destroyed) break;
      if (!sub.arena || (only && !only.has(sub.slug))) continue;
      try {
        const entries = await this.fetchArena(sub.arena);
        if (!entries.length) {
          failed.push(sub.slug);
          continue;
        }
        await this.storeArena(sub.slug, entries);
        updated += 1;
      } catch (err) {
        failed.push(sub.slug);
        this.logger.warn(`LMArena ${sub.slug} failed: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(300);
    }
    if (updated > 0 && !only) await this.setMeta('arena_refreshed_at', new Date().toISOString());
    await this.setMeta('arena_failed', failed.join(','));
    return { updated, failed };
  }

  private async storeArena(subcategory: string, entries: ArenaEntry[]): Promise<void> {
    const client = await this.db!.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ai_tool_ranks WHERE subcategory = $1 AND basis = 'arena'`,
        [subcategory],
      );
      const firstImport = (rows[0]?.n ?? 0) === 0;
      await client.query(
        `INSERT INTO ai_tools (slug, name, vendor, kind, is_open, license, source, new_since)
         SELECT s, n, v, 'model', o, l, 'arena', CASE WHEN $7::bool THEN NULL ELSE now() END
         FROM unnest($1::text[], $2::text[], $3::text[], $4::bool[], $5::text[], $6::int[]) AS x(s, n, v, o, l, _r)
         ON CONFLICT (slug) DO UPDATE SET vendor = COALESCE(EXCLUDED.vendor, ai_tools.vendor), license = EXCLUDED.license,
           is_open = EXCLUDED.is_open, updated_at = now()
         WHERE ai_tools.source = 'arena'`,
        [
          entries.map((e) => e.slug),
          entries.map((e) => e.name),
          entries.map((e) => e.vendor),
          entries.map((e) => e.isOpen),
          entries.map((e) => e.license),
          entries.map((e) => e.rank),
          firstImport,
        ],
      );
      await client.query(`DELETE FROM ai_tool_ranks WHERE subcategory = $1 AND basis = 'arena'`, [subcategory]);
      await client.query(
        `INSERT INTO ai_tool_ranks (subcategory, tool_slug, rank, score, votes, basis)
         SELECT $1, s, r, sc, v, 'arena' FROM unnest($2::text[], $3::int[], $4::float8[], $5::int[]) AS x(s, r, sc, v)
         ON CONFLICT (subcategory, tool_slug) DO UPDATE SET rank = EXCLUDED.rank, score = EXCLUDED.score,
           votes = EXCLUDED.votes, basis = 'arena', updated_at = now()`,
        [subcategory, entries.map((e) => e.slug), entries.map((e) => e.rank), entries.map((e) => e.rating), entries.map((e) => e.votes)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const date = entries.find((e) => e.publishDate)?.publishDate;
    if (date) await this.setMeta(`arena_date:${subcategory}`, date);
  }

  // ------------------------------------------------------------------ news discovery

  async discoverFromNews(): Promise<number> {
    const { rows } = await this.db!.query<{ id: string; title: string; summary: string }>(
      `SELECT n.id::text, COALESCE(n.original_title, n.title_uk) AS title,
              LEFT(COALESCE(n.original_summary, n.summary_uk, ''), 500) AS summary
       FROM news_items n
       LEFT JOIN ai_tool_news_scans s ON s.news_id = n.id
       WHERE n.status = 'published' AND s.news_id IS NULL
         AND COALESCE(n.published_at, n.created_at) > now() - interval '4 days'
       ORDER BY COALESCE(n.published_at, n.created_at) DESC
       LIMIT 40`,
    );
    let found = 0;
    for (let i = 0; i < rows.length && !this.destroyed; i += NEWS_BATCH) {
      const batch = rows.slice(i, i + NEWS_BATCH);
      const tools = await this.extractTools(batch);
      if (tools === null) break; // LLM unavailable: retry these news next cycle
      for (const t of tools) {
        try {
          await this.saveDiscovered(t);
          found += 1;
        } catch (err) {
          this.logger.debug(`Discovered tool ${t.name} not saved: ${err instanceof Error ? err.message : err}`);
        }
      }
      await this.db!.query(
        `INSERT INTO ai_tool_news_scans (news_id) SELECT unnest($1::bigint[]) ON CONFLICT DO NOTHING`,
        [batch.map((b) => b.id)],
      );
    }
    await this.db!.query(`DELETE FROM ai_tool_news_scans WHERE scanned_at < now() - interval '30 days'`).catch(() => undefined);
    return found;
  }

  private async extractTools(batch: Array<{ id: string; title: string; summary: string }>) {
    const allowed = PRODUCT_SUBCATEGORIES.map((s) => `${s.slug}: ${s.nameEn}`).join('\n');
    const news = batch.map((n) => `[${n.id}] ${n.title}\n${n.summary}`).join('\n\n');
    const prompt = `From these news items, list AI products, apps, models or developer tools that are launched, released, or substantially updated (not merely mentioned in passing). Skip companies without a concrete product, and skip general LLM releases unless they are a usable app or tool.
For each, choose the single best subcategory slug from this list (exact slug only):
${allowed}

Return JSON {"tools":[{"newsId":"<id in brackets>","name":"product name","vendor":"company","subcategory":"slug","url":"official https URL if stated in the text, else empty","hasFree":true|false|null,"isOpenSource":true|false,"descriptionUk":"one short sentence in Ukrainian: what it does","descriptionEn":"one short sentence in English"}]}. Return {"tools":[]} if none.

NEWS:
${news}`;
    const res = await generateJsonWithRouter<unknown>({
      task: 'classify',
      prompt,
      maxTokens: 2500,
      temperature: 0.1,
      timeoutMs: 45_000,
    }).catch(() => null);
    if (!res) return null;
    return validateDiscoveredTools(res.data, new Set(PRODUCT_SUBCATEGORIES.map((s) => s.slug)), new Set(batch.map((b) => b.id)));
  }

  private async saveDiscovered(t: ReturnType<typeof validateDiscoveredTools>[number]): Promise<void> {
    const { rows } = await this.db!.query<{ slug: string }>(
      `SELECT slug FROM ai_tools WHERE slug = $1 OR lower(name) = lower($2) ORDER BY (slug = $1) DESC LIMIT 1`,
      [t.slug, t.name],
    );
    let slug = rows[0]?.slug;
    if (!slug) {
      slug = t.slug;
      await this.db!.query(
        `INSERT INTO ai_tools (slug, name, vendor, kind, url, has_free, is_open, description_uk, description_en, source, new_since)
         VALUES ($1, $2, $3, 'product', $4, $5, $6, $7, $8, 'news', now())
         ON CONFLICT (slug) DO NOTHING`,
        [slug, t.name, t.vendor, t.url, t.hasFree, t.isOpen, t.descriptionUk, t.descriptionEn],
      );
    } else {
      await this.db!.query(
        `UPDATE ai_tools SET description_uk = COALESCE(description_uk, $2), description_en = COALESCE(description_en, $3),
           url = COALESCE(url, $4), updated_at = now() WHERE slug = $1`,
        [slug, t.descriptionUk, t.descriptionEn, t.url],
      );
    }
    await this.db!.query(
      `INSERT INTO ai_tool_ranks (subcategory, tool_slug, rank, basis) VALUES ($1, $2, 999, 'news')
       ON CONFLICT (subcategory, tool_slug) DO NOTHING`,
      [t.subcategory, slug],
    );
    await this.db!.query(
      `INSERT INTO ai_tool_mentions (tool_slug, news_id) VALUES ($1, $2::bigint) ON CONFLICT DO NOTHING`,
      [slug, t.newsId],
    );
  }

  // ------------------------------------------------------------------ ranking

  /** Non-arena subcategories: starting position + news mentions in the last 30 days + a small boost for new tools. */
  async recomputeEditorialRanks(): Promise<void> {
    await this.db!.query(
      `WITH m AS (
         SELECT tool_slug, count(*)::int AS c FROM ai_tool_mentions
         WHERE mentioned_at > now() - interval '30 days' GROUP BY tool_slug
       ), s AS (
         SELECT r.subcategory, r.tool_slug,
                (CASE WHEN r.seed_pos IS NOT NULL THEN 100 - 5 * r.seed_pos ELSE 55 END)
                + 10 * LEAST(COALESCE(m.c, 0), 6)
                + CASE WHEN t.new_since > now() - interval '${NEW_BADGE_DAYS} days' THEN 8 ELSE 0 END AS score
         FROM ai_tool_ranks r
         JOIN ai_tools t ON t.slug = r.tool_slug
         LEFT JOIN m ON m.tool_slug = r.tool_slug
         WHERE r.basis <> 'arena'
       ), x AS (
         SELECT subcategory, tool_slug, score,
                row_number() OVER (PARTITION BY subcategory ORDER BY score DESC, tool_slug) AS rn
         FROM s
       )
       UPDATE ai_tool_ranks r SET score = x.score, rank = x.rn, updated_at = now()
       FROM x WHERE r.subcategory = x.subcategory AND r.tool_slug = x.tool_slug
         AND (r.rank IS DISTINCT FROM x.rn OR r.score IS DISTINCT FROM x.score)`,
    );
  }

  async snapshotHistory(): Promise<void> {
    await this.db!.query(
      `INSERT INTO ai_tool_rank_history (day, subcategory, tool_slug, rank)
       SELECT current_date, subcategory, tool_slug, rank FROM ai_tool_ranks WHERE rank <= 30
       ON CONFLICT (day, subcategory, tool_slug) DO UPDATE SET rank = EXCLUDED.rank`,
    );
    await this.db!.query(`DELETE FROM ai_tool_rank_history WHERE day < current_date - 400`).catch(() => undefined);
  }

  // ------------------------------------------------------------------ read API

  async overview() {
    const empty = { groups: [] as unknown[], newCount: 0, arenaRefreshedAt: null as string | null };
    if (!this.db) return empty;
    const [counts, newCount, meta] = await Promise.all([
      this.db.query<{ subcategory: string; n: number; top: string[] }>(
        `SELECT r.subcategory, count(*)::int AS n, (array_agg(t.name ORDER BY r.rank))[1:3] AS top
         FROM ai_tool_ranks r JOIN ai_tools t ON t.slug = r.tool_slug GROUP BY r.subcategory`,
      ),
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_tools WHERE new_since > now() - interval '7 days'`),
      this.db.query<{ key: string; value: string }>(`SELECT key, value FROM ai_rankings_meta WHERE key LIKE 'arena_%'`),
    ]);
    const byCat = new Map(counts.rows.map((r) => [r.subcategory, r]));
    const metaMap = new Map(meta.rows.map((r) => [r.key, r.value]));
    return {
      groups: AI_GROUPS.map((g) => ({
        ...g,
        subcategories: AI_SUBCATEGORIES.filter((s) => s.group === g.slug).map((s) => ({
          slug: s.slug,
          nameUk: s.nameUk,
          nameEn: s.nameEn,
          descriptionUk: s.descriptionUk,
          descriptionEn: s.descriptionEn,
          basis: s.arena ? 'arena' : 'editorial',
          count: byCat.get(s.slug)?.n ?? 0,
          top: byCat.get(s.slug)?.top ?? [],
          leaderboardDate: metaMap.get(`arena_date:${s.slug}`) ?? null,
        })),
      })),
      newCount: newCount.rows[0]?.n ?? 0,
      arenaRefreshedAt: metaMap.get('arena_refreshed_at') ?? null,
    };
  }

  private toolSelect(where: string): string {
    return `SELECT r.rank, r.score, r.votes, r.basis, t.slug, t.name, t.vendor, t.kind, t.url, t.has_free, t.is_open, t.license,
                   t.description_uk, t.description_en,
                   (t.new_since > now() - interval '${NEW_BADGE_DAYS} days') AS is_new,
                   prev.rank AS prev_rank,
                   (SELECT count(*)::int FROM ai_tool_mentions m
                     WHERE m.tool_slug = t.slug AND m.mentioned_at > now() - interval '30 days') AS mentions30d
            FROM ai_tool_ranks r
            JOIN ai_tools t ON t.slug = r.tool_slug
            LEFT JOIN LATERAL (
              SELECT h.rank FROM ai_tool_rank_history h
              WHERE h.subcategory = r.subcategory AND h.tool_slug = r.tool_slug AND h.day <= current_date - 7
              ORDER BY h.day DESC LIMIT 1
            ) prev ON true
            ${where}`;
  }

  async category(slug: string, limit = 50) {
    const sub = getSubcategory(slug);
    if (!sub || !this.db) return null;
    const [{ rows }, date] = await Promise.all([
      this.db.query<ToolRow>(`${this.toolSelect('WHERE r.subcategory = $1')} ORDER BY r.rank LIMIT $2`, [slug, limit]),
      this.getMeta(`arena_date:${slug}`),
    ]);
    return {
      subcategory: {
        slug: sub.slug,
        group: sub.group,
        nameUk: sub.nameUk,
        nameEn: sub.nameEn,
        descriptionUk: sub.descriptionUk,
        descriptionEn: sub.descriptionEn,
        basis: sub.arena ? 'arena' : 'editorial',
        leaderboardDate: date,
        sourceUk: sub.arena
          ? 'LMArena: сліпе голосування людей між моделями (lmarena.ai, CC-BY-4.0)'
          : 'Стартовий список редакції + згадки в новинах за 30 днів',
        sourceEn: sub.arena
          ? 'LMArena: blind human-preference votes (lmarena.ai, CC-BY-4.0)'
          : 'Editorial starting list + news mentions in the last 30 days',
      },
      items: rows.map(toDto),
    };
  }

  async newTools(days = 14, limit = 40) {
    if (!this.db) return [];
    const { rows } = await this.db.query<{
      slug: string; name: string; vendor: string | null; kind: string; url: string | null; has_free: boolean | null; is_open: boolean;
      description_uk: string | null; description_en: string | null; source: string; new_since: Date; ranks: Array<{ subcategory: string; rank: number }> | null;
    }>(
      `SELECT t.slug, t.name, t.vendor, t.kind, t.url, t.has_free, t.is_open, t.description_uk, t.description_en, t.source, t.new_since,
              (SELECT json_agg(json_build_object('subcategory', r.subcategory, 'rank', r.rank) ORDER BY r.rank)
                 FROM ai_tool_ranks r WHERE r.tool_slug = t.slug) AS ranks
       FROM ai_tools t
       WHERE t.new_since > now() - make_interval(days => $1)
       ORDER BY t.new_since DESC
       LIMIT $2`,
      [days, limit],
    );
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      vendor: r.vendor,
      kind: r.kind,
      url: r.url,
      hasFree: r.has_free,
      isOpen: r.is_open,
      descriptionUk: r.description_uk,
      descriptionEn: r.description_en,
      source: r.source,
      newSince: r.new_since,
      ranks: (r.ranks || []).map((x) => ({ ...x, nameUk: getSubcategory(x.subcategory)?.nameUk ?? x.subcategory, nameEn: getSubcategory(x.subcategory)?.nameEn ?? x.subcategory })),
    }));
  }

  async tool(slug: string) {
    if (!this.db) return null;
    const { rows } = await this.db.query<ToolRow & { subcategory: string; source: string; first_seen_at: Date }>(
      `${this.toolSelect('WHERE r.tool_slug = $1').replace('SELECT r.rank,', 'SELECT r.subcategory, t.source, t.first_seen_at, r.rank,')} ORDER BY r.rank`,
      [slug],
    );
    let base = rows[0];
    if (!base) {
      const t = await this.db.query<ToolRow & { source: string; first_seen_at: Date }>(
        `SELECT 0 AS rank, NULL::float8 AS score, NULL::int AS votes, 'news' AS basis, slug, name, vendor, kind, url, has_free, is_open, license,
                description_uk, description_en, (new_since > now() - interval '${NEW_BADGE_DAYS} days') AS is_new, NULL::int AS prev_rank,
                0 AS mentions30d, source, first_seen_at
         FROM ai_tools WHERE slug = $1`,
        [slug],
      );
      if (!t.rows[0]) return null;
      base = { ...t.rows[0], subcategory: '' };
    }
    const [history, mentions] = await Promise.all([
      this.db.query<{ day: string; subcategory: string; rank: number }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, subcategory, rank FROM ai_tool_rank_history
         WHERE tool_slug = $1 AND day > current_date - 120 ORDER BY day`,
        [slug],
      ),
      this.db.query<{ id: string; title: string; published_at: Date | null }>(
        `SELECT n.id::text, COALESCE(n.title_uk, n.original_title) AS title, n.published_at
         FROM ai_tool_mentions m JOIN news_items n ON n.id = m.news_id
         WHERE m.tool_slug = $1 ORDER BY m.mentioned_at DESC LIMIT 10`,
        [slug],
      ),
    ]);
    const dto = toDto(base);
    return {
      ...dto,
      source: base.source,
      firstSeenAt: base.first_seen_at,
      ranks: rows.map((r) => ({
        subcategory: r.subcategory,
        nameUk: getSubcategory(r.subcategory)?.nameUk ?? r.subcategory,
        nameEn: getSubcategory(r.subcategory)?.nameEn ?? r.subcategory,
        rank: r.rank,
        movement: rankMovement(r.rank, r.prev_rank),
        basis: r.basis,
      })),
      history: history.rows,
      mentions: mentions.rows,
    };
  }

  async search(q: string, limit = 30) {
    const term = q.trim().slice(0, 80);
    if (!this.db || term.length < 2) return [];
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { rows } = await this.db.query<{ slug: string; name: string; vendor: string | null; kind: string; best_rank: number | null; best_sub: string | null }>(
      `SELECT t.slug, t.name, t.vendor, t.kind, b.rank AS best_rank, b.subcategory AS best_sub
       FROM ai_tools t
       LEFT JOIN LATERAL (SELECT r.rank, r.subcategory FROM ai_tool_ranks r WHERE r.tool_slug = t.slug ORDER BY r.rank LIMIT 1) b ON true
       WHERE t.name ILIKE $1 OR t.vendor ILIKE $1
       ORDER BY b.rank NULLS LAST, t.name
       LIMIT $2`,
      [like, limit],
    );
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      vendor: r.vendor,
      kind: r.kind,
      bestRank: r.best_rank,
      bestSubcategory: r.best_sub,
      bestSubcategoryUk: r.best_sub ? getSubcategory(r.best_sub)?.nameUk ?? r.best_sub : null,
      bestSubcategoryEn: r.best_sub ? getSubcategory(r.best_sub)?.nameEn ?? r.best_sub : null,
    }));
  }
}
