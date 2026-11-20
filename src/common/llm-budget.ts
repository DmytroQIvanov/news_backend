/**
 * Shared, atomic daily LLM budget (table llm_budget_days, migration 028).
 *
 * Every Gemini HTTP attempt to a budgeted model reserves one request BEFORE it is sent (retries count too).
 * The limit holds across all NestJS instances and the Python workers because the check-and-increment runs in one
 * transaction under an advisory lock per (day, model).
 *
 * Defaults and reserved purpose groups: knowledge/kb/quotas.v1.json (env overrides supported).
 * A reservation keeps that many requests of the model for one purpose; everything else shares the remainder, so
 * memes or captions can never eat the requests the long articles need.
 * Models that are not listed are not limited here (their own free-tier limits still apply in llm-router.ts).
 */
import { Pool } from 'pg';

// Packaged for both runtimes; never silently substitute a different quota version.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const quotaConfig = JSON.parse(readFileSync(join(__dirname, '../../knowledge/kb/quotas.v1.json'), 'utf8'));
export const QUOTA_VERSION = quotaConfig.version as number;
const DEFAULT_LIMITS: string = quotaConfig.limits;
const DEFAULT_RESERVED: string = quotaConfig.reserved;

let pool: Pool | null = null;
const deferrals = { accountingUnavailable: 0, exhausted: 0 };
export function quotaDeferrals() { return { ...deferrals }; }

// Google resets free-tier daily quotas at midnight Pacific time, not UTC: the ledger day must follow it,
// otherwise the local counter stays "full" for ~8 hours after Google has already given the quota back.
const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
function dayKey(now = Date.now()): string {
  return PACIFIC_DAY.format(now);
}

/** Models for which Google itself answered "daily quota exhausted" (ground truth beats the local ledger). */
const exhaustedByGoogle = new Map<string, string>();
export function markModelExhaustedByGoogle(model: string, now = Date.now()): void {
  exhaustedByGoogle.set(budgetKey(model) ?? model, dayKey(now));
}
export function isModelExhaustedByGoogle(model: string, now = Date.now()): boolean {
  return exhaustedByGoogle.get(budgetKey(model) ?? model) === dayKey(now);
}

function parseLimits(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (raw?.trim() || DEFAULT_LIMITS).split(',')) {
    const [model, n] = part.split('=').map((x) => x?.trim());
    const value = Number(n);
    if (model && Number.isInteger(value) && value >= 0) out.set(model, value);
  }
  return out;
}

function parseReserved(raw: string | undefined): Map<string, { purpose: string; count: number }> {
  const out = new Map<string, { purpose: string; count: number }>();
  for (const part of (raw?.trim() || DEFAULT_RESERVED).split(',')) {
    const [model, rest] = part.split('=').map((x) => x?.trim());
    const [purpose, n] = (rest ?? '').split(':');
    const count = Number(n);
    if (model && purpose && Number.isInteger(count) && count >= 0) out.set(model, { purpose, count });
  }
  return out;
}

/** Family of a model name: "gemini-3.8-flash-preview-09" counts against "gemini-3.8-flash"; any hydrogen variant against hydrogen. */
export function budgetKey(model: string): string | null {
  const m = model.trim().toLowerCase().replace(/^models\//, '');
  const limits = parseLimits(process.env.LLM_DAILY_LIMITS);
  if (m === 'openrouter:account') return m;
  if (limits.has(m)) return m;
  if (/hydrogen/.test(m)) {
    for (const key of limits.keys()) if (/hydrogen/.test(key)) return key;
  }
  for (const key of [...limits.keys()].sort((a, b) => b.length - a.length)) {
    if (m.startsWith(`${key}-`) && !m.startsWith(`${key}-lite`)) return key;
  }
  return null;
}

export function dailyLlmLimit(model: string): number | null {
  const key = budgetKey(model);
  if (!key) return null;
  if (key === 'openrouter:account') return Math.max(0, Math.floor(Number(process.env.OPENROUTER_DAILY_LIMIT) || 50));
  return parseLimits(process.env.LLM_DAILY_LIMITS).get(key) ?? 0;
}

function db(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 8_000, idleTimeoutMillis: 20_000 });
    pool.on('error', () => undefined);
  }
  return pool;
}

/**
 * Gemma makes thousands of calls a day: the ledger is touched once per block of calls instead of once per call, so the
 * database is not woken up for every request. A restart can waste at most one unused block per purpose.
 */
const LEASE_SIZE = 25;
const leases = new Map<string, { day: string; left: number }>();
const tokenBuffer = new Map<string, { day: string; model: string; purpose: string; input: number; output: number; calls: number }>();
const isLeased = (key: string) => key.startsWith('gemma-') || key === 'gemini-decision-1';

/**
 * Reserve one request of `model` for `purpose`. Returns false when the daily budget (or the purpose's share)
 * is exhausted; the caller must then skip this model.
 */
export async function reserveLlmCall(model: string, purpose: string, now = Date.now()): Promise<boolean> {
  const key = budgetKey(model);
  if (!key) return true;
  if (isModelExhaustedByGoogle(model, now)) { deferrals.exhausted += 1; return false; }
  const day = dayKey(now);
  if (isLeased(key)) {
    const leaseKey = `${key}|${purpose}`;
    const lease = leases.get(leaseKey);
    if (lease?.day === day && lease.left > 0) { lease.left -= 1; return true; }
    if (await reserveInLedger(key, purpose, day, LEASE_SIZE, now)) {
      const current = leases.get(leaseKey);
      leases.set(leaseKey, { day, left: (current?.day === day ? current.left : 0) + LEASE_SIZE - 1 });
      return true;
    }
  }
  const allowed = await reserveInLedger(key, purpose, day, 1, now);
  if (allowed === null) { deferrals.accountingUnavailable += 1; return false; }
  if (!allowed) deferrals.exhausted += 1;
  return allowed;
}

/** true/false = the ledger's answer, null = the ledger could not be reached. */
async function reserveInLedger(key: string, purpose: string, day: string, count: number, now: number): Promise<boolean | null> {
  const limit = parseLimits(process.env.LLM_DAILY_LIMITS).get(key) ?? (key === 'openrouter:account' ? dailyLlmLimit(key) ?? 0 : 0);
  const reserved = parseReserved(process.env.LLM_BUDGET_RESERVED).get(key);
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
        const ownersUse = reserved ? rows.filter((r) => reserved.purpose.split('|').includes(r.purpose)).reduce((s, r) => s + Number(r.used), 0) : 0;
        let allowed = total + count <= limit;
        if (allowed && reserved && !reserved.purpose.split('|').includes(purpose)) {
          // others may use what is not reserved, plus whatever the owner provably will not need after 20:00 UTC
          const lateDay = new Date(now).getUTCHours() >= 20;
          const othersCap = lateDay ? limit - ownersUse : limit - reserved.count;
          allowed = total - ownersUse + count <= Math.max(0, othersCap);
        }
        if (allowed) {
          await client.query(
            `INSERT INTO llm_budget_days (day, model, purpose, used) VALUES ($1, $2, $3, $4)
             ON CONFLICT (day, model, purpose) DO UPDATE SET used = llm_budget_days.used + EXCLUDED.used, updated_at = now()`,
            [day, key, purpose.slice(0, 40), count],
          );
        }
        await client.query('COMMIT');
        return allowed;
      } catch {
        await client.query('ROLLBACK').catch(() => undefined);
      } finally {
        client.release();
      }
    }
  }
  return null;
}

/**
 * Give a reservation back when the request provably did not use Google's quota (local queue busy, 429/5xx answer,
 * connection failure). Without this, retries and rejected calls drained the local counter to 500 while Google had used 136.
 */
export async function refundLlmCall(model: string, purpose: string, now = Date.now()): Promise<void> {
  const key = budgetKey(model);
  if (!key) return;
  if (isLeased(key)) {
    const lease = leases.get(`${key}|${purpose}`);
    if (lease?.day === dayKey(now)) lease.left += 1;
    return;
  }
  await db()
    ?.query(
      `UPDATE llm_budget_days SET used = GREATEST(0, used - 1), updated_at = now() WHERE day = $1 AND model = $2 AND purpose = $3`,
      [dayKey(now), key, purpose.slice(0, 40)],
    )
    .catch(() => undefined);
}

/** Token accounting for cost analysis (best effort, never blocks a request). */
export async function recordLlmTokens(model: string, purpose: string, input = 0, output = 0, now = Date.now()): Promise<void> {
  const key = budgetKey(model) ?? model.slice(0, 80);
  const day = dayKey(now);
  if (isLeased(key)) {
    const bufferKey = `${day}|${key}|${purpose}`;
    const b = tokenBuffer.get(bufferKey) ?? { day, model: key, purpose, input: 0, output: 0, calls: 0 };
    b.input += input;
    b.output += output;
    b.calls += 1;
    tokenBuffer.set(bufferKey, b);
    if (b.calls < LEASE_SIZE) return;
    tokenBuffer.delete(bufferKey);
    return writeLlmTokens(b.day, b.model, b.purpose, b.input, b.output);
  }
  return writeLlmTokens(day, key, purpose, input, output);
}

async function writeLlmTokens(day: string, key: string, purpose: string, input: number, output: number): Promise<void> {
  const p = db();
  if (!p) return;
  await p
    .query(
      `INSERT INTO llm_budget_days (day, model, purpose, used, input_tokens, output_tokens) VALUES ($1, $2, $3, 0, $4, $5)
       ON CONFLICT (day, model, purpose) DO UPDATE SET input_tokens = llm_budget_days.input_tokens + $4,
              output_tokens = llm_budget_days.output_tokens + $5, updated_at = now()`,
      [day, key, purpose.slice(0, 40), input, output],
    )
    .catch(() => undefined);
}

export async function llmBudgetStatus(now = Date.now()) {
  const limits = parseLimits(process.env.LLM_DAILY_LIMITS);
  limits.set('openrouter:account', dailyLlmLimit('openrouter:account') ?? 50);
  const reserved = parseReserved(process.env.LLM_BUDGET_RESERVED);
  const day = dayKey(now);
  const rows: Array<{ model: string; purpose: string; used: number; input_tokens: string; output_tokens: string }> = [];
  let available = false;
  const p = db();
  if (p) {
    const res = await p
      .query('SELECT model, purpose, used, input_tokens, output_tokens FROM llm_budget_days WHERE day = $1 ORDER BY model, purpose', [day])
      .catch(() => null);
    if (res) { rows.push(...res.rows); available = true; }
  }
  return {
    day, available, quotaVersion: QUOTA_VERSION, deferrals: quotaDeferrals(),
    models: [...limits.entries()].map(([model, limit]) => {
      const mine = rows.filter((r) => r.model === model);
      const used = mine.reduce((s, r) => s + Number(r.used), 0);
      return {
        model,
        limit,
        used,
        remaining: available ? Math.max(0, limit - used) : 0,
        reserved: reserved.get(model) ?? null,
        byPurpose: Object.fromEntries(mine.map((r) => [r.purpose, Number(r.used)])),
        tokens: { input: mine.reduce((s, r) => s + Number(r.input_tokens), 0), output: mine.reduce((s, r) => s + Number(r.output_tokens), 0) },
      };
    }),
  };
}

/** Requests already charged to `purpose` today across these models; null when the ledger cannot be read. */
export async function llmPurposeUse(modelNames: string[], purpose: string, now = Date.now()): Promise<number | null> {
  const status = await llmBudgetStatus(now);
  if (!status.available) return null;
  const keys = new Set(modelNames.map((m) => budgetKey(m)).filter(Boolean));
  return status.models.filter((m) => keys.has(m.model)).reduce((sum, m) => sum + (m.byPurpose[purpose] ?? 0), 0);
}

export async function remainingLlmCalls(model: string, purpose: string, now = Date.now()): Promise<number> {
  const key = budgetKey(model);
  if (!key) return Number.POSITIVE_INFINITY;
  const status = await llmBudgetStatus(now);
  if (!status.available) return 0;
  const m = status.models.find((x) => x.model === key);
  if (!m) return 0;
  const reserved = m.reserved;
  if (!reserved || reserved.purpose.split('|').includes(purpose)) return m.remaining;
  const ownersUse = Object.entries(m.byPurpose).filter(([p]) => reserved.purpose.split('|').includes(p)).reduce((s, [, used]) => s + used, 0);
  return Math.max(0, Math.min(m.remaining, m.limit - reserved.count - (m.used - ownersUse)));
}

export function resetLlmBudgetForTests(): void {
  deferrals.accountingUnavailable = 0;
  deferrals.exhausted = 0;
  leases.clear();
  tokenBuffer.clear();
}
