import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { DatabaseService } from '../database/database.service';
import { quotaDeferrals } from '../common/llm-budget';
import { independentOriginsSql } from '../news/eligibility';

const STALL_MS = 30 * 60_000;
export function workerState(row: { active_since: string | null; last_success: string | null }, now = Date.now()) {
  const active = row.active_since ? Date.parse(row.active_since) : null;
  const success = row.last_success ? Date.parse(row.last_success) : null;
  if (active !== null && now - active > STALL_MS) return 'stalled';
  if (success !== null && now - success < STALL_MS) return 'progressing';
  return active !== null ? 'running' : 'idle';
}

export function memoryPressure() {
  const read = (path: string) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
  const limit = Number(read('/sys/fs/cgroup/memory.max') ?? read('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  const current = Number(read('/sys/fs/cgroup/memory.current') ?? read('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  const bounded = limit > 0 && limit < 2 ** 60 && current > 0;
  const used = bounded ? current : totalmem() - freemem();
  const capacity = bounded ? limit : totalmem();
  return { scope: bounded ? 'container' : 'host', usedBytes: used, limitBytes: capacity,
    ratio: used / capacity, pressure: used / capacity >= 0.85, processRssBytes: process.memoryUsage().rss };
}

/** One in-flight refresh and a 30s TTL, including unavailable results, protect small servers. */
export class PipelineDiagnostics {
  private cached?: { at: number; value: unknown };
  private pending?: Promise<unknown>;
  constructor(private readonly db: DatabaseService, private readonly now = Date.now) {}

  get(): Promise<unknown> {
    if (this.cached && this.now() - this.cached.at < 30_000) return Promise.resolve(this.cached.value);
    if (this.pending) return this.pending;
    this.pending = this.collect().then((value) => {
      this.cached = { at: this.now(), value };
      return value;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async collect() {
    const unavailable: string[] = [];
    const query = async (name: string, sql: string) => this.db.query(sql).then((r) => r.rows).catch(() => {
      unavailable.push(name); return [];
    });
    const [stages, workers, blocks, quotas] = await Promise.all([
      query('stages', `SELECT 'document:' || stage AS stage, count(*)::int AS backlog,
        EXTRACT(epoch FROM now() - min(created_at))::int AS oldest_age_seconds
        FROM kb.documents WHERE stage IN ('new','extracted','analyzed','error') GROUP BY stage
        UNION ALL SELECT 'editorial:' || editorial_state, count(*)::int,
        EXTRACT(epoch FROM now() - min(created_at))::int FROM kb.events
        WHERE editorial_state IN ('ready','deep') AND article_news_id IS NULL GROUP BY editorial_state
        UNION ALL SELECT 'verification:' || status, count(*)::int,
        EXTRACT(epoch FROM now() - min(created_at))::int FROM kb.llm_tasks
        WHERE status IN ('queued','running','failed') GROUP BY status
        UNION ALL SELECT 'translation', count(*)::int, EXTRACT(epoch FROM now() - min(updated_at))::int
        FROM news_items WHERE ai_metadata->'kb'->>'awaiting_translation' = 'true'
        UNION ALL SELECT 'review', count(*)::int, EXTRACT(epoch FROM now() - min(updated_at))::int
        FROM news_items WHERE status = 'needs_review'`),
      query('workers', `WITH runs AS (
        SELECT worker, started_at, finished_at, error FROM kb.pipeline_runs
        UNION ALL SELECT 'editorial', started_at, finished_at, error FROM kb.editorial_runs WHERE NOT dry_run)
        SELECT worker, min(started_at) FILTER (WHERE finished_at IS NULL)::text AS active_since,
          max(finished_at) FILTER (WHERE error IS NULL)::text AS last_success,
          max(finished_at) FILTER (WHERE error IS NOT NULL)::text AS last_failure
        FROM runs GROUP BY worker`),
      query('publication', `SELECT
        (SELECT count(*) FROM kb.events WHERE independent_source_count < 2 AND article_news_id IS NULL AND status <> 'merged')::int AS insufficient_event_origins,
        count(*) FILTER (WHERE NOT COALESCE(n.ai_generated, false))::int AS not_ai_authored,
        count(*) FILTER (WHERE ${independentOriginsSql()} < 2)::int AS insufficient_origins,
        count(*) FILTER (WHERE n.kb_event_id IS NOT NULL AND COALESCE(n.ai_metadata->'kb'->'review'->>'state', '') <> 'approved')::int AS review_hold,
        count(*) FILTER (WHERE n.ai_metadata->'kb'->'review'->>'state' = 'approved' AND n.ai_metadata->'kb'->>'checks_passed' <> 'true')::int AS validation_hold,
        count(*) FILTER (WHERE n.ai_metadata->'kb'->>'awaiting_translation' = 'true')::int AS awaiting_translation,
        count(*) FILTER (WHERE COALESCE(n.ai_metadata->'kb'->>'translation_attempts', '0') ~ '^[1-9][0-9]*$')::int AS translation_failures,
        count(*) FILTER (WHERE n.ai_metadata ? 'kb_candidate')::int AS held_updates
        FROM news_items n WHERE n.status = 'needs_review' OR n.ai_metadata ? 'kb_candidate'`),
      query('quotas', `SELECT outcome, sum(count)::int AS count FROM llm_usage_daily
        WHERE day = (now() AT TIME ZONE 'UTC')::date
          AND outcome IN ('skipped_daily','skipped_local','rate_limited','exhausted') GROUP BY outcome`),
    ]);
    return { status: unavailable.length ? 'degraded' : 'ok', unavailable, cachedForSeconds: 30,
      generatedAt: new Date(this.now()).toISOString(), stages,
      workers: workers.map((r) => ({ ...r, state: workerState(r as any, this.now()) })),
      publicationBlocks: blocks[0] ?? null, quotaDeferrals: { local: quotaDeferrals(), persisted: quotas }, memory: memoryPressure() };
  }
}
