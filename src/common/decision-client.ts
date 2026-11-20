import { markModelExhaustedByGoogle, recordLlmTokens, refundLlmCall, reserveLlmCall } from './llm-budget';
import { recordLlmEvent } from './llm-stats';

/**
 * Gemini Decisions API client (`gemini-decision-1` on `POST /v1beta/decisions`).
 *
 * Evaluates closed-set typed questions (`noul`, `choice`, `score`) against a shared context in a single prefill pass
 * with 0 output tokens. Pacing protects the 50K TPM bottleneck (`DECISION_TPM=45000`), 200 RPS cap (`DECISION_RPS=150`),
 * and 10K RPD shared ledger budget (block-leased via llm-budget.ts).
 */
export const DEFAULT_DECISION_MODEL = 'gemini-decision-1';
export const DECISIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';

export type DecisionPriority = 'high' | 'normal' | 'low';

export type DecisionQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface DecisionAnswer {
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number> | number[];
  confidence: number;
}

export interface DecisionLease {
  /** Replaces the estimated input tokens with actual usage (0 when the provider rejected the call). */
  release(actualTokens: number): void;
}

const RANK: Record<DecisionPriority, number> = { high: 0, normal: 1, low: 2 };

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function decisionLimits() {
  return {
    rps: envInt('DECISION_RPS', 150),
    rpm: envInt('DECISION_RPM', 1500),
    tpm: envInt('DECISION_TPM', 45_000),
    concurrency: envInt('DECISION_CONCURRENCY', 12),
    maxInputTokens: envInt('DECISION_MAX_INPUT_TOKENS', 40_000),
    maxQueue: envInt('DECISION_MAX_QUEUE', 120),
  };
}

/** Three characters per token: deliberately pessimistic for Cyrillic safety; zero output tokens reserved. */
export function estimateDecisionTokens(input: unknown, questions: Record<string, DecisionQuestion>): number {
  const inText = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  const qText = JSON.stringify(questions ?? {});
  return Math.ceil((inText.length + qText.length) / 3);
}

interface WindowEvent { at: number; tokens: number }
interface Waiter { tokens: number; rank: number; seq: number; resolve: (lease: DecisionLease) => void }

export class DecisionLimiter {
  private events: WindowEvent[] = [];
  private waiters: Waiter[] = [];
  private active = 0;
  private cooldownUntil = 0;
  private seq = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly windowMs = 60_000, private readonly rpsWindowMs = 1_000) {}

  private waitMs(tokens: number, now: number): number {
    const { rps, rpm, tpm } = decisionLimits();
    while (this.events.length && this.events[0].at + this.windowMs <= now) this.events.shift();
    let wait = Math.max(0, this.cooldownUntil - now);
    if (this.events.length >= rpm) {
      wait = Math.max(wait, this.events[this.events.length - rpm].at + this.windowMs - now);
    }
    const rpsCutoff = now - this.rpsWindowMs;
    const recentSecond = this.events.filter((e) => e.at > rpsCutoff);
    if (recentSecond.length >= rps) {
      wait = Math.max(wait, recentSecond[recentSecond.length - rps].at + this.rpsWindowMs - now);
    }
    let used = this.events.reduce((sum, e) => sum + e.tokens, 0);
    const capped = Math.min(tokens, tpm);
    for (const e of this.events) {
      if (used + capped <= tpm) break;
      used -= e.tokens;
      wait = Math.max(wait, e.at + this.windowMs - now);
    }
    return Math.ceil(wait);
  }

  private pump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.waiters.length && this.active < decisionLimits().concurrency) {
      const now = Date.now();
      const next = this.waiters[0];
      const wait = this.waitMs(next.tokens, now);
      if (wait > 0) {
        this.timer = setTimeout(() => this.pump(), wait);
        if (wait > 5_000) this.timer.unref?.();
        return;
      }
      this.waiters.shift();
      this.active += 1;
      const event: WindowEvent = { at: now, tokens: Math.min(next.tokens, decisionLimits().tpm) };
      this.events.push(event);
      let released = false;
      next.resolve({
        release: (actualTokens) => {
          if (released) return;
          released = true;
          event.tokens = Math.max(0, actualTokens);
          this.active = Math.max(0, this.active - 1);
          this.pump();
        },
      });
    }
  }

  acquire(tokens: number, priority: DecisionPriority = 'normal'): Promise<DecisionLease | null> {
    if (this.waiters.length >= decisionLimits().maxQueue) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = { tokens, rank: RANK[priority], seq: (this.seq += 1), resolve };
      const at = this.waiters.findIndex((w) => w.rank > waiter.rank);
      if (at < 0) this.waiters.push(waiter);
      else this.waiters.splice(at, 0, waiter);
      this.pump();
    });
  }

  cooldown(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
    this.pump();
  }

  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.events = [];
    this.waiters = [];
    this.active = 0;
    this.cooldownUntil = 0;
  }
}

export const decisionLimiter = new DecisionLimiter();

export function resetDecisionClientForTests(): void {
  decisionLimiter.reset();
}

function unitNum(v: unknown): number | null {
  const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export function validateDecisionAnswers(
  questions: Record<string, DecisionQuestion>,
  raw: unknown,
): Record<string, DecisionAnswer> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const map = (obj.answers && typeof obj.answers === 'object' && !Array.isArray(obj.answers) ? obj.answers : obj) as Record<string, unknown>;
  const out: Record<string, DecisionAnswer> = {};
  for (const [key, q] of Object.entries(questions)) {
    const item = map[key];
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    const confidence = unitNum(rec.confidence);
    if (confidence === null) return null;
    if (q.type === 'noul') {
      const noul = unitNum(rec.noul);
      if (noul === null) return null;
      out[key] = { noul, confidence };
    } else if (q.type === 'choice') {
      const choice = typeof rec.choice === 'string' ? rec.choice : '';
      if (!Object.prototype.hasOwnProperty.call(q.criteria, choice)) return null;
      const probs = rec.probabilities && typeof rec.probabilities === 'object' && !Array.isArray(rec.probabilities)
        ? (rec.probabilities as Record<string, number>)
        : undefined;
      out[key] = { choice, confidence, ...(probs ? { probabilities: probs } : {}) };
    } else if (q.type === 'score') {
      const score = Number(rec.score);
      if (!Number.isFinite(score) || score < 0 || score > Math.max(0, q.criteria.length - 1)) return null;
      const probs = Array.isArray(rec.probabilities) ? (rec.probabilities as number[]) : undefined;
      out[key] = { score, confidence, ...(probs ? { probabilities: probs } : {}) };
    } else {
      return null;
    }
  }
  return out;
}

function statusError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function extractInputTokens(data: unknown, fallback: number): number {
  const meta = (data as { usageMetadata?: { promptTokenCount?: number; totalTokenCount?: number; inputTokens?: number } } | null)?.usageMetadata;
  const n = Number(meta?.promptTokenCount ?? meta?.inputTokens ?? meta?.totalTokenCount);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

export async function postGeminiDecisions(params: {
  apiKey?: string;
  model?: string;
  input: unknown;
  questions: Record<string, DecisionQuestion>;
  purpose: string;
  priority?: DecisionPriority;
  timeoutMs?: number;
}): Promise<{ answers: Record<string, DecisionAnswer>; modelUsed: string; tokens: number }> {
  const apiKey = (params.apiKey ?? process.env.GEMINI_API_KEY)?.trim();
  if (!apiKey) throw statusError('GEMINI_API_KEY is not configured', 401);
  const model = params.model?.trim() || DEFAULT_DECISION_MODEL;
  const estimated = estimateDecisionTokens(params.input, params.questions);
  if (estimated > decisionLimits().maxInputTokens) {
    recordLlmEvent({ provider: 'gemini', model, task: params.purpose, outcome: 'skipped_size', detail: `about ${estimated} input tokens` });
    throw statusError(`Decision prompt too large (${estimated} tokens)`, 400);
  }
  if (!(await reserveLlmCall(model, params.purpose))) {
    recordLlmEvent({ provider: 'gemini', model, task: params.purpose, outcome: 'skipped_daily', detail: 'shared daily budget' });
    throw statusError(`LLM daily budget exhausted (${model})`, 429);
  }
  const lease = await decisionLimiter.acquire(estimated, params.priority ?? 'normal');
  if (!lease) {
    await refundLlmCall(model, params.purpose);
    recordLlmEvent({ provider: 'gemini', model, task: params.purpose, outcome: 'skipped_local', detail: 'local decision queue is busy' });
    throw statusError('local decision queue is busy', 429);
  }

  const startedAt = Date.now();
  let resp: Response;
  try {
    resp = await fetch(DECISIONS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(params.timeoutMs ?? 30_000),
      body: JSON.stringify({ model, input: params.input, questions: params.questions }),
    });
  } catch (err) {
    const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
    recordLlmEvent({
      provider: 'gemini', model, task: params.purpose, outcome: timedOut ? 'timeout' : 'http_error',
      latencyMs: Date.now() - startedAt, detail: err instanceof Error ? err.message : String(err),
    });
    if (!timedOut) await refundLlmCall(model, params.purpose);
    lease.release(0);
    decisionLimiter.cooldown(15_000);
    throw err;
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const snippet = errText.replace(/\s+/g, ' ').slice(0, 180);
    recordLlmEvent({
      provider: 'gemini', model, task: params.purpose, outcome: resp.status === 429 ? 'rate_limited' : 'http_error',
      latencyMs: Date.now() - startedAt, detail: `HTTP ${resp.status} ${snippet}`,
    });
    if (resp.status === 429 || resp.status >= 500) await refundLlmCall(model, params.purpose);
    if (resp.status === 429 && /per ?day|daily/i.test(errText) && !/per ?minute/i.test(errText)) {
      markModelExhaustedByGoogle(model);
    }
    lease.release(0);
    if (resp.status === 429) decisionLimiter.cooldown(61_000);
    else if (resp.status >= 500) decisionLimiter.cooldown(15_000);
    throw statusError(`Gemini Decisions HTTP ${resp.status} (${model})${snippet ? `: ${snippet}` : ''}`, resp.status);
  }

  const data = await resp.json().catch(() => null);
  const actualTokens = extractInputTokens(data, estimated);
  lease.release(actualTokens);

  const answers = validateDecisionAnswers(params.questions, data);
  if (!answers) {
    recordLlmEvent({ provider: 'gemini', model, task: params.purpose, outcome: 'no_content', tokens: actualTokens, latencyMs: Date.now() - startedAt, detail: 'invalid decision answers' });
    throw statusError('Gemini Decisions returned malformed answers', 502);
  }

  recordLlmEvent({ provider: 'gemini', model, task: params.purpose, outcome: 'ok', tokens: actualTokens, latencyMs: Date.now() - startedAt });
  void recordLlmTokens(model, params.purpose, actualTokens, 0);
  return { answers, modelUsed: model, tokens: actualTokens };
}
