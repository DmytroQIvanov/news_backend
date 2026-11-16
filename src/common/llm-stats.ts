import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

/**
 * AI usage / failure statistics.
 *
 * `recordLlmEvent` is a cheap in-memory counter called from the Gemini client and the LLM router for
 * every real HTTP attempt (ok / 429 / error / timeout) and every locally skipped call (budget, cooldown).
 * `LlmStatsService` flushes the counters to `llm_usage_daily` and builds the report behind GET /ai/stats.
 */

export type LlmOutcome =
  | 'ok'
  | 'rate_limited'
  | 'http_error'
  | 'timeout'
  | 'no_content'
  | 'exhausted'
  | 'skipped_daily'
  | 'skipped_rpm'
  | 'skipped_tpm'
  | 'skipped_size'
  | 'skipped_cooldown'
  | 'skipped_local';

export interface LlmEvent {
  provider: string;
  model: string;
  task: string;
  outcome: LlmOutcome;
  tokens?: number;
  latencyMs?: number;
  detail?: string;
}

interface Bucket {
  day: string;
  provider: string;
  model: string;
  task: string;
  outcome: string;
  count: number;
  tokens: number;
  latencyMs: number;
  detail: string | null;
}

let pending = new Map<string, Bucket>();

const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function recordLlmEvent(ev: LlmEvent): void {
  try {
    const day = utcDay();
    const key = [day, ev.provider, ev.model, ev.task, ev.outcome].join('|');
    const b = pending.get(key) ?? {
      day, provider: ev.provider, model: ev.model.slice(0, 120), task: ev.task.slice(0, 48), outcome: ev.outcome,
      count: 0, tokens: 0, latencyMs: 0, detail: null,
    };
    b.count += 1;
    b.tokens += Math.max(0, Math.round(ev.tokens ?? 0));
    b.latencyMs += Math.max(0, Math.round(ev.latencyMs ?? 0));
    if (ev.detail) b.detail = ev.detail.replace(/\s+/g, ' ').slice(0, 200);
    pending.set(key, b);
  } catch {
    // statistics must never break an AI call
  }
}

function drain(): Bucket[] {
  const rows = [...pending.values()];
  pending = new Map();
  return rows;
}

function restore(rows: Bucket[]) {
  for (const r of rows) {
    const key = [r.day, r.provider, r.model, r.task, r.outcome].join('|');
    const cur = pending.get(key);
    if (cur) {
      cur.count += r.count;
      cur.tokens += r.tokens;
      cur.latencyMs += r.latencyMs;
      cur.detail = cur.detail ?? r.detail;
    } else {
      pending.set(key, r);
    }
  }
}

export function resetLlmStatsForTests() {
  pending = new Map();
}

export function pendingLlmStats(): Bucket[] {
  return [...pending.values()];
}

// ---------------------------------------------------------------- report

export interface StatRow {
  day: string;
  provider: string;
  model: string;
  task: string;
  outcome: string;
  count: number;
  tokens: number;
  latencyMs: number;
  detail?: string | null;
}

export interface ModelLimit {
  provider: string;
  model: string;
  rpd: number;
  rpm: number;
}

const REQUEST_OUTCOMES = new Set(['ok', 'rate_limited', 'http_error', 'timeout', 'no_content']);

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

/** Pure report builder (unit-testable): rows -> per-model summary, per-task summary, daily series, hints. */
export function buildLlmReport(rows: StatRow[], limits: ModelLimit[], days: number) {
  const limitFor = (provider: string, model: string) => limits.find((l) => l.provider === provider && l.model === model);

  interface Agg {
    provider: string; model: string;
    requests: number; ok: number; rateLimited: number; httpErrors: number; timeouts: number; noContent: number;
    skipped: Record<string, number>; tokens: number; latencyMs: number; okLatencyCount: number;
    perDay: Map<string, number>; tasks: Map<string, { requests: number; ok: number; failed: number; skipped: number; tokens: number }>;
    lastDetail: Record<string, string>;
  }
  const models = new Map<string, Agg>();
  const exhausted: Record<string, number> = {};
  const daily = new Map<string, { requests: number; failed: number; skipped: number; tokens: number }>();

  for (const r of rows) {
    if (r.outcome === 'exhausted') {
      exhausted[r.task] = (exhausted[r.task] ?? 0) + r.count;
      continue;
    }
    const key = `${r.provider}|${r.model}`;
    const a: Agg = models.get(key) ?? {
      provider: r.provider, model: r.model, requests: 0, ok: 0, rateLimited: 0, httpErrors: 0, timeouts: 0, noContent: 0,
      skipped: {}, tokens: 0, latencyMs: 0, okLatencyCount: 0, perDay: new Map(), tasks: new Map(), lastDetail: {},
    };
    models.set(key, a);
    const t = a.tasks.get(r.task) ?? { requests: 0, ok: 0, failed: 0, skipped: 0, tokens: 0 };
    a.tasks.set(r.task, t);
    const d = daily.get(r.day) ?? { requests: 0, failed: 0, skipped: 0, tokens: 0 };
    daily.set(r.day, d);

    if (r.outcome.startsWith('skipped_')) {
      a.skipped[r.outcome] = (a.skipped[r.outcome] ?? 0) + r.count;
      t.skipped += r.count;
      d.skipped += r.count;
      continue;
    }
    if (!REQUEST_OUTCOMES.has(r.outcome)) continue;
    a.requests += r.count;
    a.tokens += r.tokens;
    t.requests += r.count;
    t.tokens += r.tokens;
    d.requests += r.count;
    d.tokens += r.tokens;
    a.perDay.set(r.day, (a.perDay.get(r.day) ?? 0) + r.count);
    if (r.outcome === 'ok') {
      a.ok += r.count;
      t.ok += r.count;
      a.latencyMs += r.latencyMs;
      a.okLatencyCount += r.count;
    } else {
      t.failed += r.count;
      d.failed += r.count;
      if (r.outcome === 'rate_limited') a.rateLimited += r.count;
      else if (r.outcome === 'timeout') a.timeouts += r.count;
      else if (r.outcome === 'no_content') a.noContent += r.count;
      else a.httpErrors += r.count;
      if (r.detail) a.lastDetail[r.outcome] = r.detail;
    }
  }

  const modelReport = [...models.values()]
    .map((a) => {
      const limit = limitFor(a.provider, a.model);
      const peakDay = Math.max(0, ...a.perDay.values());
      const skippedTotal = Object.values(a.skipped).reduce((s, n) => s + n, 0);
      const failed = a.requests - a.ok;
      const hints: string[] = [];
      if (limit) {
        const use = pct(peakDay, limit.rpd);
        if (use >= 90) hints.push(`Пік за добу ${peakDay}/${limit.rpd} (${use}%): ліміт майже вичерпується — зменшити навантаження або додати резервного провайдера.`);
        else if (a.requests >= 20 && use < 30 && a.rateLimited === 0 && !a.skipped.skipped_daily) hints.push(`Пік ${peakDay}/${limit.rpd} (${use}%): запас великий, можна збільшити *_MAX/кількість задач.`);
      }
      if (a.requests >= 10 && pct(a.rateLimited, a.requests) >= 5) {
        hints.push(`${a.rateLimited} відповідей 429 (${pct(a.rateLimited, a.requests)}%) попри локальні ліміти: реальний ліміт провайдера нижчий — зменшити rpm/добовий ліміт.`);
      }
      if ((a.skipped.skipped_daily ?? 0) > 0 && a.rateLimited === 0) {
        hints.push(`Локальний добовий ліміт спрацював ${a.skipped.skipped_daily} раз(ів), але 429 від провайдера не було: ліміт, можливо, занадто суворий.`);
      }
      if ((a.skipped.skipped_cooldown ?? 0) > 0 && a.rateLimited + a.httpErrors + a.timeouts > 0) {
        hints.push(`${a.skipped.skipped_cooldown} викликів пропущено через cooldown після збоїв — перевірте причину збоїв (${Object.entries(a.lastDetail).map(([k, v]) => `${k}: ${v}`).join('; ') || 'невідомо'}).`);
      }
      if ((a.skipped.skipped_size ?? 0) > 0) hints.push(`${a.skipped.skipped_size} запитів не влізли в maxRequestTokens — скоротити промпти або направити їх на інший провайдер.`);
      if ((a.skipped.skipped_tpm ?? 0) > 0) hints.push(`${a.skipped.skipped_tpm} пропусків через токени/хв (TPM).`);
      if (a.timeouts > 0 && pct(a.timeouts, a.requests) >= 5) hints.push(`Таймаути ${pct(a.timeouts, a.requests)}%: збільшити timeoutMs або зменшити max_tokens.`);
      return {
        provider: a.provider,
        model: a.model,
        requests: a.requests,
        ok: a.ok,
        failed,
        successRatePct: pct(a.ok, a.requests),
        rateLimited: a.rateLimited,
        httpErrors: a.httpErrors,
        timeouts: a.timeouts,
        noContent: a.noContent,
        skipped: a.skipped,
        skippedTotal,
        tokens: a.tokens,
        avgLatencyMs: a.okLatencyCount ? Math.round(a.latencyMs / a.okLatencyCount) : null,
        peakDayRequests: peakDay,
        dailyLimit: limit?.rpd ?? null,
        peakDayUsagePct: limit ? pct(peakDay, limit.rpd) : null,
        lastErrors: a.lastDetail,
        byTask: Object.fromEntries([...a.tasks.entries()].sort((x, y) => y[1].requests - x[1].requests)),
        hints,
      };
    })
    .sort((a, b) => b.requests - a.requests);

  return {
    days,
    generatedAt: new Date().toISOString(),
    models: modelReport,
    allProvidersExhausted: exhausted,
    daily: [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, ...v })),
    hints: [
      ...modelReport.flatMap((m) => m.hints.map((h) => `[${m.provider}/${m.model}] ${h}`)),
      ...Object.entries(exhausted).map(([task, n]) => `Задача "${task}": ${n} раз(ів) жоден провайдер не мав бюджету — додайте ліміт/провайдера для неї.`),
    ],
  };
}

export type LlmReport = ReturnType<typeof buildLlmReport>;

export function formatLlmReportText(report: LlmReport): string {
  const lines: string[] = [`Статистика AI за ${report.days} дн. (UTC), сформовано ${report.generatedAt}`, ''];
  for (const m of report.models) {
    const lim = m.dailyLimit ? ` | пік ${m.peakDayRequests}/${m.dailyLimit} (${m.peakDayUsagePct}%)` : ` | пік ${m.peakDayRequests}`;
    lines.push(`${m.provider}/${m.model}: запитів ${m.requests}, ok ${m.ok} (${m.successRatePct}%), 429=${m.rateLimited}, помилки=${m.httpErrors}, таймаути=${m.timeouts}, пропущено локально=${m.skippedTotal}${lim}, токенів≈${m.tokens}, ~${m.avgLatencyMs ?? '-'}мс`);
    for (const [task, t] of Object.entries(m.byTask)) {
      lines.push(`    ${task}: запитів ${t.requests}, ok ${t.ok}, збоїв ${t.failed}, пропущено ${t.skipped}`);
    }
    if (Object.keys(m.skipped).length) lines.push(`    пропуски: ${Object.entries(m.skipped).map(([k, v]) => `${k.replace('skipped_', '')}=${v}`).join(', ')}`);
  }
  lines.push('', 'По днях:');
  for (const d of report.daily) lines.push(`  ${d.day}: запитів ${d.requests}, збоїв ${d.failed}, пропущено ${d.skipped}, токенів≈${d.tokens}`);
  lines.push('', report.hints.length ? 'Рекомендації:' : 'Рекомендацій немає — даних замало або все в нормі.');
  for (const h of report.hints) lines.push(`  - ${h}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- persistence

@Injectable()
export class LlmStatsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LlmStatsService.name);
  private timer?: NodeJS.Timeout;

  constructor(@Optional() private readonly db?: DatabaseService) {}

  onModuleInit() {
    if (!this.db || process.env.LLM_STATS === 'false') return;
    const intervalMs = Math.max(10_000, Number(process.env.LLM_STATS_FLUSH_MS) || 30_000);
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  /** Writes the in-memory counters to Postgres. On failure the counters are kept for the next attempt. */
  async flush(): Promise<number> {
    if (!this.db) return 0;
    const rows = drain();
    if (!rows.length) return 0;
    try {
      await this.db.query(
        `INSERT INTO llm_usage_daily AS t (day, provider, model, task, outcome, count, tokens, latency_ms, last_detail)
         SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::bigint[], $8::bigint[], $9::text[])
         ON CONFLICT (day, provider, model, task, outcome) DO UPDATE SET
           count = t.count + EXCLUDED.count,
           tokens = t.tokens + EXCLUDED.tokens,
           latency_ms = t.latency_ms + EXCLUDED.latency_ms,
           last_detail = COALESCE(EXCLUDED.last_detail, t.last_detail),
           updated_at = now()`,
        [
          rows.map((r) => r.day), rows.map((r) => r.provider), rows.map((r) => r.model), rows.map((r) => r.task),
          rows.map((r) => r.outcome), rows.map((r) => r.count), rows.map((r) => r.tokens), rows.map((r) => r.latencyMs),
          rows.map((r) => r.detail),
        ],
      );
      return rows.length;
    } catch (err) {
      restore(rows);
      this.logger.warn(`LLM stats flush failed (will retry): ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  async report(days = 7, limits: ModelLimit[] = []): Promise<LlmReport> {
    const span = Math.min(90, Math.max(1, Math.floor(days) || 7));
    await this.flush();
    let rows: StatRow[] = [];
    if (this.db) {
      const res = await this.db.query<{ day: string; provider: string; model: string; task: string; outcome: string; count: number; tokens: string; latency_ms: string; last_detail: string | null }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, provider, model, task, outcome, count, tokens, latency_ms, last_detail
           FROM llm_usage_daily WHERE day > (now() AT TIME ZONE 'UTC')::date - $1::int`,
        [span],
      );
      rows = res.rows.map((r) => ({ day: r.day, provider: r.provider, model: r.model, task: r.task, outcome: r.outcome, count: Number(r.count), tokens: Number(r.tokens), latencyMs: Number(r.latency_ms), detail: r.last_detail }));
    }
    return buildLlmReport(rows, limits, span);
  }
}
