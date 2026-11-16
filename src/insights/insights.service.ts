import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { generateJsonWithRouter } from '../common/llm-router';
import { KG_SEED_ENTITIES } from '../kg/kg-seed';
import { readEnv } from '../common/r2-storage';
import {
  adamicAdar,
  betweenness,
  buildEntityMatcher,
  buildGraph,
  computePairStats,
  burstScore,
  cosine,
  dailySeries,
  detectEvents,
  EVENT_LABELS,
  EventType,
  eventSequences,
  extractCandidateTerms,
  jaccard,
  leadLag,
  louvain,
  normalizeAlias,
  pagerank,
  PairStat,
  scorePair,
  shortestPath,
  StoryDoc,
  titleTokens,
} from './insights-analysis';

type Lang = 'uk' | 'en';
type InsightKind = 'novel_pair' | 'surprising_pair' | 'predicted' | 'bridge' | 'burst' | 'lead_lag' | 'topic_link' | 'sequence';

interface InsightDraft {
  kind: InsightKind;
  key: string;
  entityIds: string[];
  topicSlugs?: string[];
  score: number;
  titleUk: string;
  titleEn: string;
  evidence: string[];
  payload: Record<string, unknown>;
}

interface EntityRow {
  id: string;
  slug: string;
  name: string;
  entity_type: string;
  aliases: string[];
}

const DAY = 86_400_000;
const ENTITY_TYPES = new Set(['company', 'model', 'technology', 'product', 'event', 'person', 'organization', 'place', 'other']);

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  return base.length >= 2 ? base : `entity-${Math.abs(hashCode(name)).toString(36)}`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

@Injectable()
export class InsightsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InsightsService.name);
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private running = false;
  private aliasesSeeded = false;

  constructor(@Optional() private readonly db?: DatabaseService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.db || process.env.INSIGHTS_ENABLED === 'false') return;
    const intervalMs = envInt('INSIGHTS_INTERVAL_MS', 60 * 60_000, 15 * 60_000, 24 * 60 * 60_000);
    const loop = (delay: number) => {
      this.timer = setTimeout(async () => {
        if (this.destroyed) return;
        try {
          await this.runAll();
        } catch (err) {
          this.logger.warn(`Insights run failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.destroyed) loop(intervalMs);
        }
      }, delay);
    };
    loop(4 * 60_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private get database(): DatabaseService {
    if (!this.db) throw new Error('Database is not configured');
    return this.db;
  }

  private statusFilter(alias = 'n'): string {
    return process.env.INSIGHTS_INCLUDE_UNREVIEWED === 'true'
      ? `${alias}.status <> 'rejected'`
      : `${alias}.status = 'published'`;
  }

  // -------------------------------------------------------------------------
  // Full pipeline
  // -------------------------------------------------------------------------

  async runAll(): Promise<Record<string, unknown>> {
    if (this.running) return { skipped: 'already running' };
    this.running = true;
    const db = this.database;
    const { rows: runRows } = await db.query<{ id: string }>('INSERT INTO insight_runs DEFAULT VALUES RETURNING id');
    const runId = runRows[0].id;
    const stats: Record<string, unknown> = {};
    try {
      await this.seedAliases();
      stats.scan = await this.scanNews();
      stats.candidates = await this.reviewCandidates(stats);
      if ((stats.candidates as { accepted: number }).accepted > 0) {
        await db.query(
          `UPDATE news_items SET insights_scanned_at = NULL
           WHERE coalesce(published_at, created_at) >= now() - interval '180 days'`,
        );
        stats.rescan = await this.scanNews();
      }
      stats.analysis = await this.analyze();
      stats.explained = await this.explainTopInsights(stats);
      await db.query('UPDATE insight_runs SET finished_at = now(), stats = $2::jsonb WHERE id = $1', [runId, JSON.stringify(stats)]);
      return stats;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.query('UPDATE insight_runs SET finished_at = now(), stats = $2::jsonb, error = $3 WHERE id = $1', [runId, JSON.stringify(stats), message]).catch(() => undefined);
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** Copies the keyword lists of the seed ontology into kg_entities.aliases (union, never removes). */
  private async seedAliases(): Promise<void> {
    if (this.aliasesSeeded) return;
    const db = this.database;
    for (const entity of KG_SEED_ENTITIES) {
      const aliases = [...new Set([...entity.keywords, entity.name].map(normalizeAlias))];
      await db.query(
        `UPDATE kg_entities SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || $2::text[]))
         WHERE slug = $1`,
        [entity.slug, aliases],
      );
    }
    await db.query(
      `UPDATE kg_entities SET aliases = ARRAY[lower(name)] WHERE cardinality(aliases) = 0`,
    );
    this.aliasesSeeded = true;
  }

  private async loadEntities(): Promise<EntityRow[]> {
    const { rows } = await this.database.query<EntityRow>(
      'SELECT id::text, slug, name, entity_type, aliases FROM kg_entities',
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // 1. Scan news: entities, event types, new-name candidates
  // -------------------------------------------------------------------------

  async scanNews(maxItems = envInt('INSIGHTS_SCAN_MAX', 4000, 50, 100_000)): Promise<{ scanned: number; mentions: number; events: number; candidateMentions: number }> {
    const db = this.database;
    const entities = await this.loadEntities();
    const match = buildEntityMatcher(entities);
    const knownAliases = new Set(entities.flatMap((e) => e.aliases.map(normalizeAlias)));
    const result = { scanned: 0, mentions: 0, events: 0, candidateMentions: 0 };

    while (result.scanned < maxItems && !this.destroyed) {
      const { rows } = await db.query<{
        id: string;
        source_id: string;
        original_title: string;
        text: string;
      }>(
        `SELECT n.id::text, n.source_id::text, n.original_title,
                concat_ws(' ', n.original_title, n.original_summary, n.title_uk, n.summary_uk,
                          n.ai_metadata->'article'->>'title', left(n.ai_metadata->'article'->>'body', 4000)) AS text
         FROM news_items n
         WHERE n.insights_scanned_at IS NULL AND n.status <> 'rejected'
         ORDER BY n.id DESC
         LIMIT 300`,
      );
      if (!rows.length) break;

      const mentionNews: string[] = [];
      const mentionEntity: string[] = [];
      const evNews: string[] = [];
      const evType: string[] = [];
      const evAmount: Array<number | null> = [];
      const evMatched: string[] = [];
      const candTerm: string[] = [];
      const candNorm: string[] = [];
      const candNews: string[] = [];
      const candSource: string[] = [];

      for (const row of rows) {
        for (const entityId of match(row.text)) {
          mentionNews.push(row.id);
          mentionEntity.push(entityId);
        }
        for (const tag of detectEvents(row.text)) {
          evNews.push(row.id);
          evType.push(tag.eventType);
          evAmount.push(tag.amountUsd);
          evMatched.push(tag.matched);
        }
        for (const term of extractCandidateTerms(row.original_title)) {
          const norm = normalizeAlias(term);
          if (knownAliases.has(norm)) continue;
          // "NVIDIA Blackwell GPU" is only known names glued together; skip phrases whose words are all known.
          const words = norm.split(' ').filter((w) => !/^\d+(?:\.\d+)*$/.test(w));
          if (words.length > 1 && words.every((w) => knownAliases.has(w))) continue;
          candTerm.push(term);
          candNorm.push(norm);
          candNews.push(row.id);
          candSource.push(row.source_id);
        }
      }

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        if (mentionNews.length) {
          await client.query(
            `INSERT INTO news_entities (news_id, entity_id, role, source)
             SELECT x.n::bigint, x.e::uuid, 'mentioned', 'insights'
             FROM unnest($1::text[], $2::text[]) AS x(n, e)
             ON CONFLICT (news_id, entity_id) DO NOTHING`,
            [mentionNews, mentionEntity],
          );
        }
        if (evNews.length) {
          await client.query(
            `INSERT INTO news_event_tags (news_id, event_type, amount_usd, matched)
             SELECT x.n::bigint, x.t, x.a, x.m
             FROM unnest($1::text[], $2::text[], $3::numeric[], $4::text[]) AS x(n, t, a, m)
             ON CONFLICT (news_id, event_type) DO UPDATE SET amount_usd = EXCLUDED.amount_usd, matched = EXCLUDED.matched`,
            [evNews, evType, evAmount, evMatched],
          );
        }
        if (candNews.length) {
          await client.query(
            `INSERT INTO entity_candidates (term, normalized)
             SELECT DISTINCT ON (x.norm) x.term, x.norm
             FROM unnest($1::text[], $2::text[]) AS x(term, norm)
             ON CONFLICT (normalized) DO NOTHING`,
            [candTerm, candNorm],
          );
          await client.query(
            `INSERT INTO entity_candidate_mentions (candidate_id, news_id, source_id)
             SELECT c.id, x.n::bigint, x.s::uuid
             FROM unnest($1::text[], $2::text[], $3::text[]) AS x(norm, n, s)
             JOIN entity_candidates c ON c.normalized = x.norm
             ON CONFLICT DO NOTHING`,
            [candNorm, candNews, candSource],
          );
        }
        await client.query(
          'UPDATE news_items SET insights_scanned_at = now() WHERE id = ANY($1::bigint[])',
          [rows.map((r) => r.id)],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }

      result.scanned += rows.length;
      result.mentions += mentionNews.length;
      result.events += evNews.length;
      result.candidateMentions += candNews.length;
    }

    await db.query(
      `UPDATE entity_candidates c SET
         mention_count = s.cnt, source_count = s.src, sample_news_ids = s.sample,
         first_seen = s.first_seen, last_seen = s.last_seen, updated_at = now()
       FROM (
         SELECT m.candidate_id, count(*)::int AS cnt, count(DISTINCT m.source_id)::int AS src,
                (array_agg(m.news_id ORDER BY m.news_id DESC))[1:5] AS sample,
                min(coalesce(n.published_at, n.created_at)) AS first_seen,
                max(coalesce(n.published_at, n.created_at)) AS last_seen
         FROM entity_candidate_mentions m JOIN news_items n ON n.id = m.news_id
         GROUP BY m.candidate_id
       ) s
       WHERE s.candidate_id = c.id AND c.status = 'pending'`,
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // 2. New entity candidates: optional AI classification, or a frequency rule
  // -------------------------------------------------------------------------

  private async aiCallsToday(): Promise<number> {
    const { rows } = await this.database.query<{ n: number }>(
      `SELECT coalesce(sum((stats->>'aiCalls')::int), 0)::int AS n
       FROM insight_runs WHERE started_at >= date_trunc('day', now())`,
    );
    return rows[0]?.n ?? 0;
  }

  private async aiBudgetLeft(stats: Record<string, unknown>): Promise<number> {
    const max = envInt('INSIGHTS_AI_DAILY_MAX', 12, 0, 500);
    const used = (await this.aiCallsToday()) + Number(stats.aiCalls ?? 0);
    return Math.max(0, max - used);
  }

  private anyLlm(): boolean {
    return Boolean(
      process.env.GEMINI_API_KEY?.trim() || readEnv('groq_api_key') || readEnv('openrouter_api_key'),
    );
  }

  async reviewCandidates(stats: Record<string, unknown>): Promise<{ accepted: number; rejected: number; aiChecked: number }> {
    const db = this.database;
    const out = { accepted: 0, rejected: 0, aiChecked: 0 };
    const minMentions = envInt('INSIGHTS_CANDIDATE_MIN_MENTIONS', 3, 2, 1000);
    const minSources = envInt('INSIGHTS_CANDIDATE_MIN_SOURCES', 2, 1, 100);

    if (this.anyLlm() && (await this.aiBudgetLeft(stats)) > 0) {
      const { rows } = await db.query<{ id: string; term: string; mention_count: number; titles: string[] }>(
        `SELECT c.id::text, c.term, c.mention_count,
                ARRAY(SELECT n.original_title FROM news_items n WHERE n.id = ANY(c.sample_news_ids) LIMIT 2) AS titles
         FROM entity_candidates c
         WHERE c.status = 'pending' AND c.ai_checked_at IS NULL
           AND c.mention_count >= $1 AND c.source_count >= $2
         ORDER BY c.mention_count DESC
         LIMIT 30`,
        [minMentions, minSources],
      );
      if (rows.length) {
        const entities = await this.loadEntities();
        const slugs = entities.map((e) => `${e.slug} (${e.name})`).join(', ');
        stats.aiCalls = Number(stats.aiCalls ?? 0) + 1;
        const res = await generateJsonWithRouter<{ items?: Array<{ term: string; is_entity: boolean; type?: string; canonical_name?: string; alias_of?: string | null }> }>({
          task: 'classify',
          system:
            'You classify proper names found in AI/tech news headlines. A real entity is a specific company, product, model, ' +
            'person, organization, technology or place. Generic words, headline fragments and phrases are not entities. ' +
            'If the term is another name for an existing entity, put its slug in alias_of. Answer JSON only.',
          prompt:
            `Existing entities: ${slugs}\n\nTerms (with example headlines):\n` +
            rows.map((r) => `- "${r.term}" — ${r.titles.join(' | ').slice(0, 300)}`).join('\n') +
            '\n\nReturn {"items":[{"term":"...","is_entity":true,"type":"company|model|product|technology|person|organization|place|other","canonical_name":"...","alias_of":null}]}',
          maxTokens: 2500,
          temperature: 0,
        }).catch((err) => {
          this.logger.warn(`Candidate classification failed: ${err instanceof Error ? err.message : err}`);
          return null;
        });
        const verdicts = new Map((res?.data?.items ?? []).map((v) => [normalizeAlias(String(v.term || '')), v]));
        const bySlug = new Map(entities.map((e) => [e.slug, e]));
        for (const row of rows) {
          const v = verdicts.get(normalizeAlias(row.term));
          if (!v) continue;
          out.aiChecked += 1;
          await db.query('UPDATE entity_candidates SET ai_checked_at = now(), ai_verdict = $2::jsonb WHERE id = $1', [row.id, JSON.stringify(v)]);
          if (!v.is_entity) {
            await db.query(`UPDATE entity_candidates SET status = 'rejected', updated_at = now() WHERE id = $1`, [row.id]);
            out.rejected += 1;
            continue;
          }
          const target = v.alias_of ? bySlug.get(v.alias_of) : undefined;
          const type = ENTITY_TYPES.has(String(v.type)) ? String(v.type) : 'other';
          await this.acceptCandidate(row.id, { aliasOf: target?.slug, type, name: v.canonical_name || row.term, origin: 'ai' });
          out.accepted += 1;
        }
      }
    }

    // Without AI: accept only names seen often and in many independent sources.
    const autoMin = envInt('INSIGHTS_AUTO_ACCEPT_MIN_MENTIONS', 0, 0, 10_000);
    if (autoMin > 0) {
      const { rows } = await db.query<{ id: string; term: string }>(
        `SELECT id::text, term FROM entity_candidates
         WHERE status = 'pending' AND mention_count >= $1 AND source_count >= 3
         ORDER BY mention_count DESC LIMIT 20`,
        [autoMin],
      );
      for (const row of rows) {
        await this.acceptCandidate(row.id, { type: 'other', name: row.term, origin: 'auto' });
        out.accepted += 1;
      }
    }
    return out;
  }

  /** Turns a candidate into a new entity, or into an alias of an existing one. */
  async acceptCandidate(
    candidateId: string,
    opts: { aliasOf?: string; type?: string; name?: string; origin?: string },
  ): Promise<{ entitySlug: string } | null> {
    const db = this.database;
    const { rows } = await db.query<{ term: string; normalized: string }>(
      'SELECT term, normalized FROM entity_candidates WHERE id = $1',
      [candidateId],
    );
    const cand = rows[0];
    if (!cand) return null;
    let entityId: string | undefined;
    let slug: string;
    if (opts.aliasOf) {
      const res = await db.query<{ id: string; slug: string }>(
        `UPDATE kg_entities SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || ARRAY[$2::text]))
         WHERE slug = $1 RETURNING id::text, slug`,
        [opts.aliasOf, cand.normalized],
      );
      if (!res.rows[0]) return null;
      entityId = res.rows[0].id;
      slug = res.rows[0].slug;
    } else {
      const name = (opts.name || cand.term).slice(0, 160);
      const type = ENTITY_TYPES.has(String(opts.type)) ? String(opts.type) : 'other';
      const aliases = [...new Set([normalizeAlias(name), cand.normalized])];
      let candidateSlug = slugify(name);
      const exists = await db.query<{ id: string; name: string }>('SELECT id::text, name FROM kg_entities WHERE slug = $1', [candidateSlug]);
      if (exists.rows[0] && normalizeAlias(exists.rows[0].name) !== normalizeAlias(name)) {
        candidateSlug = `${candidateSlug.slice(0, 70)}-${Math.abs(hashCode(name)).toString(36).slice(0, 6)}`;
      }
      const res = await db.query<{ id: string; slug: string }>(
        `INSERT INTO kg_entities (slug, name, entity_type, aliases, origin)
         VALUES ($1, $2, $3, $4::text[], $5)
         ON CONFLICT (slug) DO UPDATE SET aliases = ARRAY(SELECT DISTINCT unnest(kg_entities.aliases || EXCLUDED.aliases))
         RETURNING id::text, slug`,
        [candidateSlug, name, type, aliases, opts.origin || 'manual'],
      );
      entityId = res.rows[0].id;
      slug = res.rows[0].slug;
    }
    await db.query(
      `UPDATE entity_candidates SET status = 'accepted', entity_id = $2::uuid, updated_at = now() WHERE id = $1`,
      [candidateId, entityId],
    );
    return { entitySlug: slug };
  }

  async rejectCandidate(candidateId: string): Promise<boolean> {
    const res = await this.database.query(
      `UPDATE entity_candidates SET status = 'rejected', updated_at = now() WHERE id = $1`,
      [candidateId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listCandidates(status = 'pending', limit = 50) {
    const { rows } = await this.database.query(
      `SELECT c.id::text, c.term, c.mention_count, c.source_count, c.status, c.ai_verdict, c.first_seen, c.last_seen,
              ARRAY(SELECT n.original_title FROM news_items n WHERE n.id = ANY(c.sample_news_ids) LIMIT 3) AS sample_titles
       FROM entity_candidates c
       WHERE c.status = $1
       ORDER BY c.mention_count DESC, c.last_seen DESC
       LIMIT $2`,
      [status, limit],
    );
    return rows;
  }

  // -------------------------------------------------------------------------
  // 3. Analysis: pair statistics, graph, trends, sequences, topic links → insights
  // -------------------------------------------------------------------------

  private async loadStories(windowDays: number): Promise<StoryDoc[]> {
    const { rows } = await this.database.query<{
      id: string;
      cluster_id: string | null;
      t: Date;
      source_id: string;
      entity_ids: string[];
    }>(
      `SELECT n.id::text, n.cluster_id, coalesce(n.published_at, n.created_at) AS t, n.source_id::text,
              array_agg(ne.entity_id::text) AS entity_ids
       FROM news_items n
       JOIN news_entities ne ON ne.news_id = n.id
       WHERE ${this.statusFilter('n')} AND coalesce(n.published_at, n.created_at) >= now() - make_interval(days => $1)
       GROUP BY n.id
       ORDER BY n.id`,
      [windowDays],
    );
    const stories = new Map<string, StoryDoc>();
    for (const r of rows) {
      const key = r.cluster_id || `n${r.id}`;
      const time = new Date(r.t).getTime();
      let doc = stories.get(key);
      if (!doc) {
        doc = { key, time, entityIds: [], sourceIds: [], newsIds: [] };
        stories.set(key, doc);
      }
      doc.time = Math.min(doc.time, time);
      doc.entityIds = [...new Set([...doc.entityIds, ...r.entity_ids])];
      if (!doc.sourceIds.includes(r.source_id)) doc.sourceIds.push(r.source_id);
      doc.newsIds.push(r.id);
    }
    return [...stories.values()];
  }

  async analyze(): Promise<Record<string, number>> {
    const db = this.database;
    const now = Date.now();
    const windowDays = envInt('INSIGHTS_WINDOW_DAYS', 180, 14, 3650);
    const recentDays = envInt('INSIGHTS_RECENT_DAYS', 14, 2, 90);
    const docs = await this.loadStories(windowDays);
    const entities = await this.loadEntities();
    const nameById = new Map(entities.map((e) => [e.id, e.name]));
    const name = (id: string) => nameById.get(id) ?? id;

    const pairs = computePairStats(docs, now, recentDays);
    const { rows: relRows } = await db.query<{ a: string; b: string }>(
      'SELECT from_entity_id::text AS a, to_entity_id::text AS b FROM kg_relations',
    );
    const known = new Set(relRows.map((r) => (r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`)));

    // Graph of entities that co-occur in at least minEdge stories.
    const minEdge = docs.length > 400 ? 2 : 1;
    const graph = buildGraph([...pairs.values()].filter((p) => p.coCount >= minEdge).map((p) => ({ a: p.a, b: p.b, weight: p.coCount })));
    const community = louvain(graph);
    const pr = pagerank(graph);
    const btw = betweenness(graph);
    const aa = adamicAdar(graph);
    const communityOf = (id: string) => {
      const i = graph.index.get(id);
      return i === undefined ? null : community[i];
    };

    // Entity mention series (story level) and per-entity metrics.
    const timesByEntity = new Map<string, number[]>();
    const totalByEntity = new Map<string, number>();
    for (const doc of docs) {
      for (const id of doc.entityIds) {
        totalByEntity.set(id, (totalByEntity.get(id) ?? 0) + 1);
        if (doc.time >= now - 90 * DAY) {
          const list = timesByEntity.get(id) ?? [];
          list.push(doc.time);
          timesByEntity.set(id, list);
        }
      }
    }
    const today = Math.floor(now / DAY) * DAY;
    const series90 = new Map<string, number[]>();
    for (const [id, times] of timesByEntity) series90.set(id, dailySeries(times, today, 90));

    // Scored pairs.
    const scored = [...pairs.values()].map((p) => {
      const key = `${p.a}|${p.b}`;
      const knownRelation = known.has(key);
      const ca = communityOf(p.a);
      const cb = communityOf(p.b);
      const sameCommunity = ca !== null && ca === cb;
      return {
        ...p,
        knownRelation,
        sameCommunity,
        adamicAdar: 0,
        score: scorePair({ ...p, knownRelation, sameCommunity }, now, recentDays),
      };
    });
    scored.sort((x, y) => y.score - x.score);
    const keep = scored.filter((p) => p.coCount >= 2 || p.firstSeen >= now - recentDays * DAY).slice(0, 5000);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM entity_pair_stats');
      for (let i = 0; i < keep.length; i += 1000) {
        const chunk = keep.slice(i, i + 1000);
        await client.query(
          `INSERT INTO entity_pair_stats
             (entity_a, entity_b, co_count, recent_count, source_count, pmi, npmi, lift, first_seen, last_seen,
              known_relation, same_community, score, evidence_news_ids, computed_at)
           SELECT x.a::uuid, x.b::uuid, x.co, x.rc, x.sc, x.pmi, x.npmi, x.lift, to_timestamp(x.fs / 1000.0), to_timestamp(x.ls / 1000.0),
                  x.kr, x.sm, x.score, string_to_array(x.ev, ',')::bigint[], now()
           FROM unnest($1::text[], $2::text[], $3::int[], $4::int[], $5::int[], $6::real[], $7::real[], $8::real[],
                       $9::float8[], $10::float8[], $11::bool[], $12::bool[], $13::real[], $14::text[])
             AS x(a, b, co, rc, sc, pmi, npmi, lift, fs, ls, kr, sm, score, ev)`,
          [
            chunk.map((p) => p.a), chunk.map((p) => p.b), chunk.map((p) => p.coCount), chunk.map((p) => p.recentCount),
            chunk.map((p) => p.sourceCount), chunk.map((p) => p.pmi), chunk.map((p) => p.npmi), chunk.map((p) => Math.min(p.lift, 1e6)),
            chunk.map((p) => p.firstSeen), chunk.map((p) => p.lastSeen), chunk.map((p) => p.knownRelation),
            chunk.map((p) => p.sameCommunity), chunk.map((p) => p.score), chunk.map((p) => p.evidence.join(',')),
          ],
        );
      }

      // Metrics: keep the previous PageRank to show who is rising.
      const ids = [...new Set([...totalByEntity.keys(), ...graph.nodes])];
      const rowsM = ids.map((id) => {
        const i = graph.index.get(id);
        const s = series90.get(id) ?? new Array<number>(90).fill(0);
        const b = burstScore(s.slice(-35), 3);
        return {
          id,
          total: totalByEntity.get(id) ?? 0,
          recent: b.recent,
          baseline: b.baselineDaily,
          z: b.z,
          degree: i === undefined ? 0 : graph.adj[i].size,
          pr: i === undefined ? 0 : pr[i],
          btw: i === undefined ? 0 : btw[i],
          comm: i === undefined ? null : community[i],
          series: JSON.stringify(s.slice(-35)),
        };
      });
      for (let i = 0; i < rowsM.length; i += 1000) {
        const chunk = rowsM.slice(i, i + 1000);
        await client.query(
          `INSERT INTO entity_metrics AS m
             (entity_id, mentions_total, mentions_recent, baseline_daily, burst_z, degree, pagerank, betweenness, community, daily_series, computed_at)
           SELECT x.id::uuid, x.t, x.r, x.b, x.z, x.d, x.p, x.bt, x.c, x.s::jsonb, now()
           FROM unnest($1::text[], $2::int[], $3::int[], $4::real[], $5::real[], $6::int[], $7::real[], $8::real[], $9::int[], $10::text[])
             AS x(id, t, r, b, z, d, p, bt, c, s)
           ON CONFLICT (entity_id) DO UPDATE SET
             mentions_total = EXCLUDED.mentions_total, mentions_recent = EXCLUDED.mentions_recent,
             baseline_daily = EXCLUDED.baseline_daily, burst_z = EXCLUDED.burst_z, degree = EXCLUDED.degree,
             pagerank_prev = CASE WHEN m.computed_at < now() - interval '20 hours' THEN m.pagerank ELSE m.pagerank_prev END,
             pagerank = EXCLUDED.pagerank, betweenness = EXCLUDED.betweenness, community = EXCLUDED.community,
             daily_series = EXCLUDED.daily_series, computed_at = CASE WHEN m.computed_at < now() - interval '20 hours' THEN now() ELSE m.computed_at END`,
          [
            chunk.map((r) => r.id), chunk.map((r) => r.total), chunk.map((r) => r.recent), chunk.map((r) => r.baseline),
            chunk.map((r) => r.z), chunk.map((r) => r.degree), chunk.map((r) => r.pr), chunk.map((r) => r.btw),
            chunk.map((r) => r.comm), chunk.map((r) => r.series),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    const drafts: InsightDraft[] = [];
    const pairLabel = (a: string, b: string) => `«${name(a)}» і «${name(b)}»`;
    const pairLabelEn = (a: string, b: string) => `${name(a)} and ${name(b)}`;

    // Novel pairs: established entities (≥3 stories each) meeting for the first time.
    for (const p of scored) {
      if (p.firstSeen < now - 7 * DAY || p.knownRelation || p.npmi < 0.15) continue;
      if ((totalByEntity.get(p.a) ?? 0) < 3 || (totalByEntity.get(p.b) ?? 0) < 3) continue;
      drafts.push({
        kind: 'novel_pair', key: `${p.a}|${p.b}`, entityIds: [p.a, p.b], score: p.score + 1,
        titleUk: `Нова зв'язка: ${pairLabel(p.a, p.b)} вперше разом у новинах`,
        titleEn: `New link: ${pairLabelEn(p.a, p.b)} appear together for the first time`,
        evidence: p.evidence,
        payload: { coCount: p.coCount, npmi: round(p.npmi), sourceCount: p.sourceCount, crossCommunity: !p.sameCommunity },
      });
      if (drafts.filter((d) => d.kind === 'novel_pair').length >= 15) break;
    }

    // Surprising established pairs.
    let surprising = 0;
    for (const p of scored) {
      if (surprising >= 15) break;
      if (p.coCount < 3 || p.knownRelation || p.npmi < 0.3 || p.recentCount === 0) continue;
      surprising += 1;
      drafts.push({
        kind: 'surprising_pair', key: `${p.a}|${p.b}`, entityIds: [p.a, p.b], score: p.score,
        titleUk: `Несподіваний зв'язок: ${pairLabel(p.a, p.b)} згадуються разом частіше, ніж випадково (×${round(p.lift, 1)})`,
        titleEn: `Unexpected link: ${pairLabelEn(p.a, p.b)} co-occur ${round(p.lift, 1)}× more than chance`,
        evidence: p.evidence,
        payload: { coCount: p.coCount, recentCount: p.recentCount, npmi: round(p.npmi), lift: round(p.lift, 2), crossCommunity: !p.sameCommunity },
      });
    }

    // Predicted links: many shared neighbours, never mentioned together, both active recently.
    const predicted = [...aa.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .filter((x) => {
        const [a, b] = x.key.split('|');
        return (timesByEntity.get(a)?.length ?? 0) > 0 && (timesByEntity.get(b)?.length ?? 0) > 0;
      })
      .sort((x, y) => y.score - x.score)
      .slice(0, 12);
    for (const x of predicted) {
      const [a, b] = x.key.split('|');
      const common = x.common
        .sort((u, v) => (totalByEntity.get(u) ?? 0) - (totalByEntity.get(v) ?? 0))
        .slice(0, 4);
      const evidence = common.flatMap((c) => [pairs.get(keyOf(a, c))?.evidence[0], pairs.get(keyOf(b, c))?.evidence[0]]).filter(Boolean) as string[];
      drafts.push({
        kind: 'predicted', key: x.key, entityIds: [a, b, ...common], score: x.score,
        titleUk: `Ймовірний зв'язок: ${pairLabel(a, b)} ще не згадувались разом, але мають спільних «сусідів»: ${common.map(name).join(', ')}`,
        titleEn: `Likely link: ${pairLabelEn(a, b)} were never mentioned together but share ${common.map(name).join(', ')}`,
        evidence: [...new Set(evidence)].slice(0, 6),
        payload: { adamicAdar: round(x.score), commonCount: x.common.length },
      });
    }

    // Bridges: entities that connect different communities.
    const bridges = graph.nodes
      .map((id, i) => ({ id, i, btw: btw[i] }))
      .filter((x) => {
        const comms = new Set([...graph.adj[x.i].keys()].map((j) => community[j]));
        return comms.size >= 3 && x.btw > 0;
      })
      .sort((x, y) => y.btw - x.btw)
      .slice(0, 6);
    for (const x of bridges) {
      const groups = new Map<number, string>();
      for (const [j, w] of [...graph.adj[x.i].entries()].sort((u, v) => v[1] - u[1])) {
        if (community[j] !== community[x.i] && !groups.has(community[j])) groups.set(community[j], graph.nodes[j]);
      }
      const reps = [...groups.values()].slice(0, 4);
      drafts.push({
        kind: 'bridge', key: x.id, entityIds: [x.id, ...reps], score: x.btw * 10,
        titleUk: `«${name(x.id)}» — місток між різними сюжетами: ${reps.map(name).join(', ')}`,
        titleEn: `${name(x.id)} bridges separate clusters: ${reps.map(name).join(', ')}`,
        evidence: reps.map((r) => pairs.get(keyOf(x.id, r))?.evidence[0]).filter(Boolean) as string[],
        payload: { betweenness: round(x.btw, 4), communities: groups.size + 1 },
      });
    }

    // Bursts.
    for (const [id, s] of series90) {
      const b = burstScore(s.slice(-35), 3);
      if (b.z < 3 || b.recent < 3) continue;
      const recentDocs = docs.filter((d) => d.time >= now - 3 * DAY && d.entityIds.includes(id)).slice(0, 6);
      drafts.push({
        kind: 'burst', key: id, entityIds: [id], score: b.z,
        titleUk: `Сплеск згадок: «${name(id)}» — ${b.recent} сюжетів за 3 дні (зазвичай ~${round(b.baselineDaily * 3, 1)})`,
        titleEn: `Spike: ${name(id)} — ${b.recent} stories in 3 days (usually ~${round(b.baselineDaily * 3, 1)})`,
        evidence: recentDocs.map((d) => d.newsIds[0]),
        payload: { z: round(b.z, 2), recent: b.recent, baselineDaily: round(b.baselineDaily, 2) },
      });
    }

    // Lead-lag between the most active entities.
    const active = [...series90.entries()]
      .filter(([, s]) => s.filter((x) => x > 0).length >= 6)
      .sort((x, y) => y[1].reduce((a, b) => a + b, 0) - x[1].reduce((a, b) => a + b, 0))
      .slice(0, 60);
    const lags: InsightDraft[] = [];
    for (const [a, sa] of active) {
      for (const [b, sb] of active) {
        if (a === b) continue;
        const r = leadLag(sa, sb, 7);
        if (!r || r.corr < 0.45) continue;
        lags.push({
          kind: 'lead_lag', key: `${a}>${b}`, entityIds: [a, b], score: r.corr - r.sameDay,
          titleUk: `Сплески навколо «${name(a)}» зазвичай випереджають «${name(b)}» приблизно на ${r.lag} дн.`,
          titleEn: `Activity around ${name(a)} tends to precede ${name(b)} by about ${r.lag} day(s)`,
          evidence: pairs.get(keyOf(a, b))?.evidence ?? [],
          payload: { lag: r.lag, corr: round(r.corr), sameDayCorr: round(r.sameDay) },
        });
      }
    }
    drafts.push(...lags.sort((x, y) => y.score - x.score).slice(0, 8));

    const sequences = await this.computeSequences();
    for (const s of sequences.slice(0, 8)) {
      if (s.lift < 1.5) continue;
      const from = EVENT_LABELS[s.fromType as EventType] ?? { uk: s.fromType, en: s.fromType };
      const to = EVENT_LABELS[s.toType as EventType] ?? { uk: s.toType, en: s.toType };
      drafts.push({
        kind: 'sequence', key: `${s.fromType}>${s.toType}`, entityIds: s.examples, score: s.lift * Math.log1p(s.support),
        titleUk: `Шаблон: після події «${from.uk}» у компанії часто (${Math.round(s.confidence * 100)}%) стається «${to.uk}» — в середньому через ${Math.round(s.avgGapDays)} дн.`,
        titleEn: `Pattern: after "${from.en}" a company often (${Math.round(s.confidence * 100)}%) has "${to.en}" — ~${Math.round(s.avgGapDays)} days later`,
        evidence: [],
        payload: { support: s.support, confidence: round(s.confidence), lift: round(s.lift, 2), avgGapDays: round(s.avgGapDays, 1), examples: s.examples.map(name) },
      });
    }

    const topicLinks = await this.computeTopicLinks(nameById);
    drafts.push(...topicLinks);

    await this.saveInsights(drafts);
    return {
      stories: docs.length,
      pairs: pairs.size,
      storedPairs: keep.length,
      graphNodes: graph.nodes.length,
      communities: new Set(community).size,
      insights: drafts.length,
      sequences: sequences.length,
    };
  }

  private async computeSequences() {
    const db = this.database;
    const { rows } = await db.query<{ entity_id: string; event_type: string; t: Date }>(
      `SELECT DISTINCT ne.entity_id::text, t.event_type, date_trunc('day', coalesce(n.published_at, n.created_at)) AS t
       FROM news_event_tags t
       JOIN news_items n ON n.id = t.news_id
       JOIN news_entities ne ON ne.news_id = n.id
       JOIN kg_entities e ON e.id = ne.entity_id AND e.entity_type IN ('company', 'organization')
       WHERE ${this.statusFilter('n')} AND coalesce(n.published_at, n.created_at) >= now() - interval '365 days'
         AND t.event_type NOT IN ('research', 'benchmark', 'hardware')`,
    );
    const seq = eventSequences(rows.map((r) => ({ entityId: r.entity_id, eventType: r.event_type, time: new Date(r.t).getTime() })), 60, 3);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM event_sequence_stats');
      for (const s of seq.slice(0, 200)) {
        await client.query(
          `INSERT INTO event_sequence_stats (from_type, to_type, support, entity_count, avg_gap_days, confidence, lift, examples)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [s.fromType, s.toType, s.support, s.entityCount, s.avgGapDays, s.confidence, s.lift, JSON.stringify(s.examples)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return seq;
  }

  /** Topics that share rare entities but no articles. */
  private async computeTopicLinks(nameById: Map<string, string>): Promise<InsightDraft[]> {
    const { rows } = await this.database.query<{ slug: string; title_uk: string | null; title_en: string; entity_id: string; cnt: number; news: string[] }>(
      `SELECT t.slug, t.title_uk, t.title_en, ne.entity_id::text, count(*)::int AS cnt,
              (array_agg(tn.news_id::text ORDER BY tn.news_id DESC))[1:2] AS news
       FROM topics t
       JOIN topic_news tn ON tn.topic_slug = t.slug
       JOIN news_entities ne ON ne.news_id = tn.news_id
       WHERE t.last_news_at >= now() - interval '90 days'
       GROUP BY t.slug, t.title_uk, t.title_en, ne.entity_id`,
    );
    const { rows: newsRows } = await this.database.query<{ slug: string; ids: string[] }>(
      `SELECT tn.topic_slug AS slug, array_agg(tn.news_id::text) AS ids
       FROM topic_news tn JOIN topics t ON t.slug = tn.topic_slug
       WHERE t.last_news_at >= now() - interval '90 days'
       GROUP BY tn.topic_slug`,
    );
    return topicLinkDrafts(rows, newsRows, nameById);
  }

  private async saveInsights(drafts: InsightDraft[]): Promise<void> {
    if (!drafts.length) return;
    const db = this.database;
    for (const d of drafts) {
      await db.query(
        `INSERT INTO insight_links (kind, key, day, entity_ids, topic_slugs, score, title_uk, title_en, evidence_news_ids, payload)
         VALUES ($1, $2, current_date, $3::uuid[], $4::text[], $5, $6, $7, $8::bigint[], $9::jsonb)
         ON CONFLICT (kind, key, day) DO UPDATE SET
           entity_ids = EXCLUDED.entity_ids, topic_slugs = EXCLUDED.topic_slugs, score = EXCLUDED.score,
           title_uk = EXCLUDED.title_uk, title_en = EXCLUDED.title_en,
           evidence_news_ids = EXCLUDED.evidence_news_ids, payload = EXCLUDED.payload`,
        [d.kind, d.key, d.entityIds, d.topicSlugs ?? [], d.score, d.titleUk, d.titleEn, d.evidence, JSON.stringify(d.payload)],
      );
    }
    await db.query(`DELETE FROM insight_links WHERE day < current_date - 60`);
  }

  // -------------------------------------------------------------------------
  // 4. Optional AI: a short grounded explanation for a few top insights per day
  // -------------------------------------------------------------------------

  async explainTopInsights(stats: Record<string, unknown>): Promise<number> {
    if (!this.anyLlm()) return 0;
    const db = this.database;
    let explained = 0;
    const perRun = envInt('INSIGHTS_EXPLAIN_PER_RUN', 3, 0, 20);
    const { rows } = await db.query<{ id: string; kind: string; title_en: string; evidence_news_ids: string[] }>(
      `SELECT id::text, kind, title_en, evidence_news_ids::text[]
       FROM insight_links
       WHERE day = current_date AND explanation_uk IS NULL AND cardinality(evidence_news_ids) > 0
         AND kind IN ('novel_pair', 'surprising_pair', 'predicted', 'bridge', 'lead_lag')
       ORDER BY CASE kind WHEN 'novel_pair' THEN 0 WHEN 'predicted' THEN 1 ELSE 2 END, score DESC
       LIMIT $1`,
      [perRun],
    );
    for (const row of rows) {
      if ((await this.aiBudgetLeft(stats)) <= 0) break;
      const { rows: news } = await db.query<{ id: string; title: string; summary: string | null; d: Date | null }>(
        `SELECT id::text, original_title AS title, left(coalesce(original_summary, summary_uk, ''), 300) AS summary, published_at AS d
         FROM news_items WHERE id = ANY($1::bigint[]) ORDER BY published_at DESC NULLS LAST LIMIT 6`,
        [row.evidence_news_ids],
      );
      if (!news.length) continue;
      stats.aiCalls = Number(stats.aiCalls ?? 0) + 1;
      const res = await generateJsonWithRouter<{ uk?: string; en?: string; supported?: boolean }>({
        task: 'summary',
        system:
          'You explain a statistical link found between entities in news. Use ONLY the given articles. ' +
          'If the articles do not show a real connection, set supported=false and say the link may be a coincidence. ' +
          'Two short sentences per language, no speculation beyond the articles. Answer JSON only.',
        prompt:
          `Finding: ${row.title_en}\n\nArticles:\n` +
          news.map((n) => `[${n.id}] ${n.d ? new Date(n.d).toISOString().slice(0, 10) : ''} ${n.title} — ${n.summary || ''}`).join('\n') +
          '\n\nReturn {"supported":true,"uk":"...","en":"..."}',
        maxTokens: 600,
        temperature: 0.2,
      }).catch((err) => {
        this.logger.warn(`Insight explanation failed: ${err instanceof Error ? err.message : err}`);
        return null;
      });
      const data = res?.data;
      if (!data?.uk) continue;
      await db.query(
        `UPDATE insight_links SET explanation_uk = $2, explanation_en = $3, explained_by = $4,
           payload = payload || jsonb_build_object('supported', $5::boolean)
         WHERE id = $1`,
        [row.id, String(data.uk).slice(0, 800), String(data.en || '').slice(0, 800), `${res?.provider}:${res?.model}`, data.supported !== false],
      );
      explained += 1;
    }
    return explained;
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  private async newsCards(ids: string[], lang: Lang) {
    if (!ids.length) return new Map<string, unknown>();
    const { rows } = await this.database.query<{ id: string; url: string; title: string; published_at: Date | null; source_name: string; category: string }>(
      `SELECT n.id::text, n.url,
              ${lang === 'uk' ? "coalesce(n.title_uk, n.original_title)" : 'n.original_title'} AS title,
              n.published_at, s.name AS source_name, n.category
       FROM news_items n JOIN sources s ON s.id = n.source_id
       WHERE n.id = ANY($1::bigint[]) AND n.status = 'published'`,
      [ids],
    );
    return new Map(rows.map((r) => [r.id, { id: r.id, url: r.url, title: r.title, publishedAt: r.published_at, sourceName: r.source_name, category: r.category }]));
  }

  private async entityCards(ids: string[]) {
    if (!ids.length) return new Map<string, { slug: string; name: string; entityType: string }>();
    const { rows } = await this.database.query<{ id: string; slug: string; name: string; entity_type: string }>(
      'SELECT id::text, slug, name, entity_type FROM kg_entities WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return new Map(rows.map((r) => [r.id, { slug: r.slug, name: r.name, entityType: r.entity_type }]));
  }

  async listInsights(opts: { kind?: string; lang: Lang; limit: number; days: number; entity?: string }) {
    const params: unknown[] = [opts.days];
    let where = `i.day >= current_date - $1::int AND coalesce((i.payload->>'supported')::boolean, true)`;
    if (opts.kind) {
      params.push(opts.kind);
      where += ` AND i.kind = $${params.length}`;
    }
    if (opts.entity) {
      params.push(opts.entity);
      where += ` AND i.entity_ids && ARRAY(SELECT id FROM kg_entities WHERE slug = $${params.length})`;
    }
    const { rows } = await this.database.query<{
      id: string; kind: string; day: Date; entity_ids: string[]; topic_slugs: string[]; score: number;
      title_uk: string; title_en: string; evidence_news_ids: string[]; payload: Record<string, unknown>;
      explanation_uk: string | null; explanation_en: string | null;
    }>(
      `SELECT DISTINCT ON (i.kind, i.key) i.id::text, i.kind, i.day, i.entity_ids::text[], i.topic_slugs, i.score,
              i.title_uk, i.title_en, i.evidence_news_ids::text[], i.payload, i.explanation_uk, i.explanation_en
       FROM insight_links i
       WHERE ${where}
       ORDER BY i.kind, i.key, i.day DESC`,
      params,
    );
    const top = rows
      .sort((x, y) => (new Date(y.day).getTime() - new Date(x.day).getTime()) || y.score - x.score)
      .slice(0, opts.limit);
    const entities = await this.entityCards([...new Set(top.flatMap((r) => r.entity_ids))]);
    const news = await this.newsCards([...new Set(top.flatMap((r) => r.evidence_news_ids))], opts.lang);
    return top.map((r) => ({
      id: r.id,
      kind: r.kind,
      day: r.day,
      score: round(r.score),
      title: opts.lang === 'uk' ? r.title_uk : r.title_en,
      explanation: opts.lang === 'uk' ? r.explanation_uk : r.explanation_en,
      entities: r.entity_ids.map((id) => entities.get(id)).filter(Boolean),
      topics: r.topic_slugs,
      evidence: r.evidence_news_ids.map((id) => news.get(id)).filter(Boolean),
      details: r.payload,
    }));
  }

  async trends(lang: Lang, limit = 20) {
    const { rows } = await this.database.query<{
      slug: string; name: string; entity_type: string; mentions_recent: number; baseline_daily: number; burst_z: number;
      pagerank: number; pagerank_prev: number | null; daily_series: number[];
    }>(
      `SELECT e.slug, e.name, e.entity_type, m.mentions_recent, m.baseline_daily, m.burst_z, m.pagerank, m.pagerank_prev, m.daily_series
       FROM entity_metrics m JOIN kg_entities e ON e.id = m.entity_id
       WHERE m.mentions_recent > 0
       ORDER BY m.burst_z DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      entityType: r.entity_type,
      recentStories: r.mentions_recent,
      usualPer3Days: round(r.baseline_daily * 3, 1),
      burstZ: round(r.burst_z, 2),
      rising: r.pagerank_prev ? round(r.pagerank / Math.max(1e-9, r.pagerank_prev), 2) : null,
      series: r.daily_series,
      label: lang === 'uk' ? 'Згадок за останні 3 дні' : 'Stories in the last 3 days',
    }));
  }

  async entityInsights(slug: string, lang: Lang) {
    const db = this.database;
    const { rows } = await db.query<{ id: string; slug: string; name: string; entity_type: string; aliases: string[] }>(
      'SELECT id::text, slug, name, entity_type, aliases FROM kg_entities WHERE slug = $1',
      [slug],
    );
    const entity = rows[0];
    if (!entity) return null;
    const [metrics, partners, peers] = await Promise.all([
      db.query('SELECT * FROM entity_metrics WHERE entity_id = $1', [entity.id]),
      db.query<{ other: string; co_count: number; npmi: number; lift: number; score: number; known_relation: boolean; first_seen: Date; evidence_news_ids: string[] }>(
        `SELECT CASE WHEN entity_a = $1 THEN entity_b ELSE entity_a END::text AS other,
                co_count, npmi, lift, score, known_relation, first_seen, evidence_news_ids::text[]
         FROM entity_pair_stats WHERE entity_a = $1 OR entity_b = $1
         ORDER BY score DESC LIMIT 15`,
        [entity.id],
      ),
      db.query<{ slug: string; name: string }>(
        `SELECT e.slug, e.name FROM entity_metrics m JOIN kg_entities e ON e.id = m.entity_id
         WHERE m.community = (SELECT community FROM entity_metrics WHERE entity_id = $1) AND m.entity_id <> $1
         ORDER BY m.pagerank DESC LIMIT 10`,
        [entity.id],
      ),
    ]);
    const others = await this.entityCards(partners.rows.map((p) => p.other));
    const news = await this.newsCards([...new Set(partners.rows.flatMap((p) => p.evidence_news_ids.slice(0, 2)))], lang);
    return {
      entity: { slug: entity.slug, name: entity.name, entityType: entity.entity_type, aliases: entity.aliases },
      metrics: metrics.rows[0] ?? null,
      unexpectedPartners: partners.rows.map((p) => ({
        entity: others.get(p.other),
        coCount: p.co_count,
        npmi: round(p.npmi),
        lift: round(p.lift, 2),
        score: round(p.score),
        knownRelation: p.known_relation,
        firstSeen: p.first_seen,
        evidence: p.evidence_news_ids.slice(0, 2).map((id) => news.get(id)).filter(Boolean),
      })),
      sameCluster: peers.rows,
      insights: await this.listInsights({ lang, limit: 20, days: 30, entity: slug }),
    };
  }

  /** How are two entities connected? Shortest path in the co-mention graph with an article per step. */
  async path(fromSlug: string, toSlug: string, lang: Lang) {
    const db = this.database;
    const { rows: ents } = await db.query<{ id: string; slug: string }>(
      'SELECT id::text, slug FROM kg_entities WHERE slug = ANY($1::text[])',
      [[fromSlug, toSlug]],
    );
    const from = ents.find((e) => e.slug === fromSlug);
    const to = ents.find((e) => e.slug === toSlug);
    if (!from || !to) return null;
    const { rows } = await db.query<{ a: string; b: string; co_count: number; evidence_news_ids: string[] }>(
      'SELECT entity_a::text AS a, entity_b::text AS b, co_count, evidence_news_ids::text[] FROM entity_pair_stats',
    );
    const graph = buildGraph(rows.map((r) => ({ a: r.a, b: r.b, weight: r.co_count })));
    const path = shortestPath(graph, from.id, to.id, 4);
    if (!path) return { found: false, steps: [] };
    const edgeEvidence = new Map(rows.map((r) => [`${r.a}|${r.b}`, r.evidence_news_ids]));
    const cards = await this.entityCards(path);
    const stepEvidence = path.slice(1).map((id, i) => (edgeEvidence.get(keyOf(path[i], id)) ?? []).slice(0, 2));
    const news = await this.newsCards([...new Set(stepEvidence.flat())], lang);
    return {
      found: true,
      entities: path.map((id) => cards.get(id)),
      steps: path.slice(1).map((id, i) => ({
        from: cards.get(path[i]),
        to: cards.get(id),
        evidence: stepEvidence[i].map((n) => news.get(n)).filter(Boolean),
      })),
    };
  }

  /** Related news from other stories that share rare entities; flags the ones with different wording/category. */
  async relatedNews(newsId: string, lang: Lang, limit = 10) {
    const db = this.database;
    const { rows: base } = await db.query<{ id: string; title: string; category: string; cluster_id: string | null }>(
      `SELECT id::text, original_title AS title, category, cluster_id FROM news_items WHERE id::text = $1 OR external_id = $1 LIMIT 1`,
      [newsId],
    );
    const item = base[0];
    if (!item) return null;
    const { rows } = await db.query<{ id: string; title: string; category: string; score: number; shared: string[] }>(
      `WITH me AS (SELECT entity_id FROM news_entities WHERE news_id = $1::bigint),
            total AS (SELECT greatest(count(*), 1)::float AS n FROM news_items WHERE status = 'published'),
            df AS (SELECT ne.entity_id, count(*)::float AS df FROM news_entities ne JOIN me USING (entity_id) GROUP BY ne.entity_id)
       SELECT n.id::text, n.original_title AS title, n.category,
              sum(ln((SELECT n FROM total) / df.df)) AS score,
              array_agg(e.name ORDER BY df.df) AS shared
       FROM news_entities ne
       JOIN me USING (entity_id)
       JOIN df USING (entity_id)
       JOIN kg_entities e ON e.id = ne.entity_id
       JOIN news_items n ON n.id = ne.news_id
       WHERE n.id <> $1::bigint AND n.status = 'published'
         AND ($2::text IS NULL OR n.cluster_id IS DISTINCT FROM $2::text)
         AND coalesce(n.published_at, n.created_at) >= now() - interval '180 days'
       GROUP BY n.id
       ORDER BY score DESC
       LIMIT 60`,
      [item.id, item.cluster_id],
    );
    const baseTokens = titleTokens(item.title);
    const ranked = rows
      .map((r) => {
        const overlap = jaccard(baseTokens, titleTokens(r.title));
        const nonObvious = overlap < 0.15 && r.category !== item.category;
        return { ...r, overlap, nonObvious, rank: r.score * (nonObvious ? 1.3 : 1) * (overlap > 0.6 ? 0.3 : 1) };
      })
      .sort((x, y) => y.rank - x.rank)
      .slice(0, limit);
    const cards = await this.newsCards(ranked.map((r) => r.id), lang);
    return ranked
      .map((r) => ({
        news: cards.get(r.id),
        sharedEntities: r.shared.slice(0, 5),
        score: round(r.score, 2),
        nonObvious: r.nonObvious,
      }))
      .filter((r) => r.news);
  }

  async relatedTopics(slug: string, lang: Lang) {
    const { rows } = await this.database.query<{ topic_slugs: string[]; title_uk: string; title_en: string; score: number; payload: Record<string, unknown> }>(
      `SELECT DISTINCT ON (key) topic_slugs, title_uk, title_en, score, payload
       FROM insight_links WHERE kind = 'topic_link' AND $1 = ANY(topic_slugs)
       ORDER BY key, day DESC`,
      [slug],
    );
    return rows
      .sort((x, y) => y.score - x.score)
      .map((r) => ({
        topic: r.topic_slugs.find((t) => t !== slug),
        title: lang === 'uk' ? r.title_uk : r.title_en,
        similarity: round(r.score),
        sharedEntities: r.payload.shared,
      }));
  }

  async patterns() {
    const { rows } = await this.database.query(
      `SELECT from_type, to_type, support, entity_count, avg_gap_days, confidence, lift, examples
       FROM event_sequence_stats ORDER BY lift * ln(1 + support) DESC LIMIT 30`,
    );
    return rows.map((r) => ({
      ...r,
      fromLabel: EVENT_LABELS[r.from_type as EventType] ?? null,
      toLabel: EVENT_LABELS[r.to_type as EventType] ?? null,
    }));
  }

  async lastRun() {
    const { rows } = await this.database.query(
      'SELECT id, started_at, finished_at, stats, error FROM insight_runs ORDER BY id DESC LIMIT 1',
    );
    return rows[0] ?? null;
  }
}

function keyOf(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Exported for tests: builds topic_link drafts from topic→entity counts. */
export function topicLinkDrafts(
  rows: Array<{ slug: string; title_uk: string | null; title_en: string; entity_id: string; cnt: number; news: string[] }>,
  newsRows: Array<{ slug: string; ids: string[] }>,
  nameById: Map<string, string>,
  minSimilarity = 0.3,
): InsightDraft[] {
  const vectors = new Map<string, Map<string, number>>();
  const titles = new Map<string, { uk: string; en: string }>();
  const sampleNews = new Map<string, string[]>();
  const df = new Map<string, number>();
  for (const r of rows) {
    const v = vectors.get(r.slug) ?? new Map<string, number>();
    v.set(r.entity_id, r.cnt);
    vectors.set(r.slug, v);
    titles.set(r.slug, { uk: r.title_uk || r.title_en, en: r.title_en });
    sampleNews.set(r.slug, [...(sampleNews.get(r.slug) ?? []), ...r.news].slice(0, 4));
    df.set(r.entity_id, (df.get(r.entity_id) ?? 0) + 1);
  }
  const t = vectors.size;
  if (t < 2) return [];
  for (const v of vectors.values()) {
    for (const [e, c] of v) v.set(e, (1 + Math.log(c)) * Math.log(1 + t / (df.get(e) ?? 1)));
  }
  const newsByTopic = new Map(newsRows.map((r) => [r.slug, new Set(r.ids)]));
  const slugs = [...vectors.keys()].sort();
  const out: InsightDraft[] = [];
  for (let i = 0; i < slugs.length; i += 1) {
    for (let j = i + 1; j < slugs.length; j += 1) {
      const a = slugs[i];
      const b = slugs[j];
      const na = newsByTopic.get(a) ?? new Set<string>();
      const nb = newsByTopic.get(b) ?? new Set<string>();
      if ([...na].some((id) => nb.has(id))) continue;
      const va = vectors.get(a)!;
      const vb = vectors.get(b)!;
      const sim = cosine(va, vb);
      if (sim < minSimilarity) continue;
      const shared = [...va.keys()]
        .filter((e) => vb.has(e))
        .sort((x, y) => va.get(y)! * vb.get(y)! - va.get(x)! * vb.get(x)!)
        .slice(0, 3);
      const sharedNames = shared.map((e) => nameById.get(e) ?? e);
      out.push({
        kind: 'topic_link', key: `${a}|${b}`, entityIds: shared, topicSlugs: [a, b], score: sim,
        titleUk: `Теми «${titles.get(a)!.uk}» і «${titles.get(b)!.uk}» пов'язані через ${sharedNames.map((s) => `«${s}»`).join(', ')}`,
        titleEn: `Topics "${titles.get(a)!.en}" and "${titles.get(b)!.en}" are linked through ${sharedNames.join(', ')}`,
        evidence: [...(sampleNews.get(a) ?? []).slice(0, 2), ...(sampleNews.get(b) ?? []).slice(0, 2)],
        payload: { similarity: round(sim), shared: sharedNames },
      });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 15);
}
