/**
 * Per-model limiter for Gemma on the Gemini API (free tier: 30 requests/min, 16K tokens/min, about 14K requests/day each).
 * With these numbers tokens run out long before requests, so a call waits until both its request slot and its tokens fit
 * in the sliding minute. The defaults stay below Google's limits because the token count of a prompt is only estimated
 * until the answer reports the real one. Each model (31B, 26B) has its own window.
 */
export type GemmaPriority = 'high' | 'normal' | 'low';

const RANK: Record<GemmaPriority, number> = { high: 0, normal: 1, low: 2 };
const OUTPUT_RESERVE_TOKENS = 1_000;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function isGemmaModel(model: string): boolean {
  return /^(models\/)?gemma-/i.test(model.trim());
}

export function gemmaLimits() {
  return {
    rpm: envInt('GEMMA_RPM', 25),
    tpm: envInt('GEMMA_TPM', 14_000),
    concurrency: envInt('GEMMA_CONCURRENCY', 3),
    maxInputTokens: envInt('GEMMA_MAX_INPUT_TOKENS', 11_000),
    maxQueue: envInt('GEMMA_MAX_QUEUE', 60),
  };
}

/** Three characters per token: deliberately pessimistic, Cyrillic text takes more tokens than English. */
export function estimateTextTokens(chars: number): number {
  return Math.ceil(chars / 3);
}

export function estimateInputTokens(body: Record<string, unknown>): number {
  const texts = (value: unknown): number => {
    const parts = (value as { parts?: Array<{ text?: unknown }> } | undefined)?.parts;
    return Array.isArray(parts) ? parts.reduce((sum, p) => sum + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0;
  };
  const contents = Array.isArray(body.contents) ? body.contents : [];
  return estimateTextTokens(contents.reduce((sum: number, c) => sum + texts(c), texts(body.systemInstruction)));
}

export function reservedTokens(inputTokens: number, maxOutputTokens: unknown): number {
  const output = Number(maxOutputTokens);
  return inputTokens + Math.min(Number.isFinite(output) && output > 0 ? output : OUTPUT_RESERVE_TOKENS, OUTPUT_RESERVE_TOKENS);
}

export interface GemmaLease {
  /** Replaces the estimate with the real token count (0 when Google rejected the call and charged nothing). */
  release(actualTokens: number): void;
}

interface WindowEvent { at: number; tokens: number }
interface Waiter { tokens: number; rank: number; seq: number; resolve: (lease: GemmaLease) => void }
interface ModelState {
  events: WindowEvent[];
  waiters: Waiter[];
  active: number;
  lastAt: number;
  cooldownUntil: number;
  timer?: NodeJS.Timeout;
}

export class GemmaLimiter {
  private readonly models = new Map<string, ModelState>();
  private seq = 0;
  private lastOkAt = 0;

  constructor(private readonly windowMs = 60_000) {}

  private state(model: string): ModelState {
    let s = this.models.get(model);
    if (!s) {
      s = { events: [], waiters: [], active: 0, lastAt: 0, cooldownUntil: 0 };
      this.models.set(model, s);
    }
    return s;
  }

  private waitMs(s: ModelState, tokens: number, now: number): number {
    const { rpm, tpm } = gemmaLimits();
    while (s.events.length && s.events[0].at + this.windowMs <= now) s.events.shift();
    let wait = Math.max(0, s.cooldownUntil - now, s.lastAt ? s.lastAt + this.windowMs / rpm - now : 0);
    if (s.events.length >= rpm) wait = Math.max(wait, s.events[s.events.length - rpm].at + this.windowMs - now);
    let used = s.events.reduce((sum, e) => sum + e.tokens, 0);
    for (const e of s.events) {
      if (used + Math.min(tokens, tpm) <= tpm) break;
      used -= e.tokens;
      wait = Math.max(wait, e.at + this.windowMs - now);
    }
    return Math.ceil(wait);
  }

  private pump(model: string): void {
    const s = this.state(model);
    clearTimeout(s.timer);
    s.timer = undefined;
    while (s.waiters.length && s.active < gemmaLimits().concurrency) {
      const now = Date.now();
      const next = s.waiters[0];
      const wait = this.waitMs(s, next.tokens, now);
      if (wait > 0) {
        s.timer = setTimeout(() => this.pump(model), wait);
        if (wait > 5_000) s.timer.unref?.(); // a long wait must not hold a stopping process
        return;
      }
      s.waiters.shift();
      s.active += 1;
      s.lastAt = now;
      const event: WindowEvent = { at: now, tokens: Math.min(next.tokens, gemmaLimits().tpm) };
      s.events.push(event);
      let released = false;
      next.resolve({
        release: (actualTokens) => {
          if (released) return;
          released = true;
          event.tokens = Math.max(0, actualTokens);
          if (actualTokens > 0) this.lastOkAt = Date.now();
          s.active -= 1;
          this.pump(model);
        },
      });
    }
  }

  /** Waits for capacity; null when the queue of this model is already full. */
  acquire(model: string, tokens: number, priority: GemmaPriority = 'normal'): Promise<GemmaLease | null> {
    const s = this.state(model);
    if (s.waiters.length >= gemmaLimits().maxQueue) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = { tokens, rank: RANK[priority], seq: (this.seq += 1), resolve };
      const at = s.waiters.findIndex((w) => w.rank > waiter.rank);
      if (at < 0) s.waiters.push(waiter);
      else s.waiters.splice(at, 0, waiter);
      this.pump(model);
    });
  }

  cooldown(model: string, ms: number): void {
    const s = this.state(model);
    s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + ms);
    this.pump(model);
  }

  hasRoom(model: string, tokens: number): boolean {
    const s = this.state(model);
    return !s.waiters.length && s.active < gemmaLimits().concurrency && this.waitMs(s, tokens, Date.now()) === 0;
  }

  /** The preferred order is kept, but a model that can answer right now goes before one that would make the call wait. */
  order(models: string[], tokens: number): string[] {
    return [...models.filter((m) => this.hasRoom(m, tokens)), ...models.filter((m) => !this.hasRoom(m, tokens))];
  }

  /** True when Gemma answered recently, so a temporary failure is worth waiting out instead of spending paid-for quota. */
  recentlyHealthy(maxAgeMs = 30 * 60_000): boolean {
    return this.lastOkAt > 0 && Date.now() - this.lastOkAt < maxAgeMs;
  }

  reset(): void {
    for (const s of this.models.values()) clearTimeout(s.timer);
    this.models.clear();
    this.lastOkAt = 0;
  }
}

export const gemmaLimiter = new GemmaLimiter();
