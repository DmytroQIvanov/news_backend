/**
 * Shared, atomic daily LLM budget (table llm_budget_days, migration 028).
 *
 * Every Gemini HTTP attempt to a budgeted model reserves one request BEFORE it is sent (retries count too).
 * The limit holds across all NestJS instances and the Python workers because the check-and-increment runs in one
 * transaction under an advisory lock per (day, model).
 *
 * Defaults (override with env):
 *   LLM_DAILY_LIMITS="gemini-3.8-flash=20,gemini-3.6-flash=20,gemini-2.5-flash=20,gemini-4-hydrogen=20"
 *   LLM_BUDGET_RESERVED="gemini-3.8-flash=kb_editorial:14,gemini-3.6-flash=kb_editorial:10,gemini-2.5-flash=kb_verify:10,gemini-4-hydrogen=kb_flagship:16"
 * A reservation keeps that many requests of the model for one purpose; everything else shares the remainder, so
 * memes or captions can never eat the requests the long articles need.
 * Models that are not listed are not limited here (their own free-tier limits still apply in llm-router.ts).
 */
import { Pool } from 'pg';

const DEFAULT_LIMITS = 'gemini-3.1-flash-lite=500,gemini-3-flash=20,gemini-2.5-flash-lite=20,gemini-4-hydrogen=20';
// Hydrogen: 10 kept for flagships (1 call each), the rest writes big articles 3 per call.
// 3 Flash: writer of big articles and fixes; 2.5 Flash Lite: fact-checks; 3.1 Flash Lite (500/day): everything else.
const DEFAULT_RESERVED =
  'gemini-4-hydrogen=kb_flagship:10,gemini-3-flash=kb_big:12,gemini-2.5-flash-lite=kb_review:12';

let pool: Pool | null = null;
let tableMissing = false;
const memory = new Map<string, number>(); // fallback when the database is unreachable (per process, fail-safe)

function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function parseLimits(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (raw ?? DEFAULT_LIMITS).split(',')) {
    const [model, n] = part.split('=').map((x) => x?.trim());
    const value = Number(n);
    if (model && Number.isInteger(value) && value >= 0) out.set(model, value);
  }
  return out;
}

function parseReserved(raw: string | undefined): Map<string, { purpose: string; count: number }> {
  const out = new Map<string, { purpose: string; count: number }>();
  for (const part of (raw ?? DEFAULT_RESERVED).split(',')) {
    const [model, rest] = part.split('=').map((x) => x?.trim());
    const [purpose, n] = (rest ?? '').split(':');
    const count = Number(n);
    if (model && purpose && Number.isInteger(count) && count >= 0) out.set(model, { purpose, count });
  }
  return out;
}

/** Family of a model name: "gemini-3.8-flash-preview-09" counts against "gemini-3.8-flash"; any hydrogen variant against hydrogen. */
export function budgetKey(model: string): string | null {
  const m = model.replace(/^models\//, '').trim().toLowerCase();
  const limits = parseLimits(process.env.LLM_DAILY_LIMITS);
  if (limits.has(m)) return m;
  if (/hydrogen/.test(m)) {
    for (const key of limits.keys()) if (/hydrogen/.test(key)) return key;
  }
  for (const key of limits.keys()) {
    if (m.startsWith(`${key}-`) && !m.startsWith(`${key}-lite`)) return key;
  }
  return null;
}

function db(): Pool | null {
  if (tableMissing || !process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 8_000, idleTimeoutMillis: 20_000 });
    pool.on('error', () => undefined);
  }
  return pool;
}

/**
 * Reserve one request of `model` for `purpose`. Returns false when the daily budget (or the purpose's share)
 * is exhausted; the caller must then skip this model.
 */
export async function reserveLlmCall(model: string, purpose: string, now = Date.now()): Promise<boolean> {
  const key = budgetKey(model);
  if (!key) return true;
  const limit = parseLimits(process.env.LLM_DAILY_LIMITS).get(key) ?? 0;
  const reserved = parseReserved(process.env.LLM_BUDGET_RESERVED).get(key);
  const day = dayKey(now);
  const p = db();
  if (p) {
    const client = await p.connect().catch(() => null);
    if (client) {
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm:${day}:${key}`]);
        const { rows } = await client.query<{ purpose: string; used: number }>(
          'SELECT purpose, used FROM llm_budget_days WHERE day = $1 AND model = $2',
          [day, key],
        );
        const total = rows.reduce((sum, r) => sum + Number(r.used), 0);
        const ownersUse = reserved ? rows.filter((r) => r.purpose === reserved.purpose).reduce((s, r) => s + Number(r.used), 0) : 0;
        let allowed = total < limit;
        if (allowed && reserved && purpose !== reserved.purpose) {
          // others may use what is not reserved, plus whatever the owner provably will not need after 20:00 UTC
          const lateDay = new Date(now).getUTCHours() >= 20;
          const othersCap = lateDay ? limit - ownersUse : limit - reserved.count;
          allowed = total - ownersUse < Math.max(0, othersCap);
        }
        if (allowed) {
          await client.query(
            `INSERT INTO llm_budget_days (day, model, purpose, used) VALUES ($1, $2, $3, 1)
             ON CONFLICT (day, model, purpose) DO UPDATE SET used = llm_budget_days.used + 1, updated_at = now()`,
            [day, key, purpose.slice(0, 40)],
          );
        }
        await client.query('COMMIT');
        return allowed;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (/llm_budget_days/.test(String((err as Error)?.message)) && /does not exist/.test(String((err as Error)?.message))) {
          tableMissing = true; // migration 028 not applied yet: fall back to memory
        }
      } finally {
        client.release();
      }
    }
  }
  const memKey = `${day}:${key}`;
  const used = memory.get(memKey) ?? 0;
  if (used >= limit) return false;
  memory.set(memKey, used + 1);
  return true;
}

/** Token accounting for cost analysis (best effort, never blocks a request). */
export async function recordLlmTokens(model: string, purpose: string, input = 0, output = 0, now = Date.now()): Promise<void> {
  const key = budgetKey(model) ?? model.slice(0, 80);
  const p = db();
  if (!p) return;
  await p
    .query(
      `INSERT INTO llm_budget_days (day, model, purpose, used, input_tokens, output_tokens) VALUES ($1, $2, $3, 0, $4, $5)
       ON CONFLICT (day, model, purpose) DO UPDATE SET input_tokens = llm_budget_days.input_tokens + $4,
              output_tokens = llm_budget_days.output_tokens + $5, updated_at = now()`,
      [dayKey(now), key, purpose.slice(0, 40), input, output],
    )
    .catch(() => undefined);
}

export async function llmBudgetStatus(now = Date.now()) {
  const limits = parseLimits(process.env.LLM_DAILY_LIMITS);
  const reserved = parseReserved(process.env.LLM_BUDGET_RESERVED);
  const day = dayKey(now);
  const rows: Array<{ model: string; purpose: string; used: number; input_tokens: string; output_tokens: string }> = [];
  const p = db();
  if (p) {
    const res = await p
      .query('SELECT model, purpose, used, input_tokens, output_tokens FROM llm_budget_days WHERE day = $1 ORDER BY model, purpose', [day])
      .catch(() => null);
    if (res) rows.push(...res.rows);
  }
  return {
    day,
    models: [...limits.entries()].map(([model, limit]) => {
      const mine = rows.filter((r) => r.model === model);
      const used = mine.reduce((s, r) => s + Number(r.used), 0);
      return {
        model,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        reserved: reserved.get(model) ?? null,
        byPurpose: Object.fromEntries(mine.map((r) => [r.purpose, Number(r.used)])),
        tokens: { input: mine.reduce((s, r) => s + Number(r.input_tokens), 0), output: mine.reduce((s, r) => s + Number(r.output_tokens), 0) },
      };
    }),
  };
}

export async function remainingLlmCalls(model: string, purpose: string, now = Date.now()): Promise<number> {
  const key = budgetKey(model);
  if (!key) return Number.POSITIVE_INFINITY;
  const status = await llmBudgetStatus(now);
  const m = status.models.find((x) => x.model === key);
  if (!m) return Number.POSITIVE_INFINITY;
  const reserved = m.reserved;
  if (!reserved || reserved.purpose === purpose) return m.remaining;
  const ownersUse = m.byPurpose[reserved.purpose] ?? 0;
  return Math.max(0, Math.min(m.remaining, m.limit - reserved.count - (m.used - ownersUse)));
}

export function resetLlmBudgetForTests(): void {
  memory.clear();
  tableMissing = false;
}
