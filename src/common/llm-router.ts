import { DEFAULT_GEMINI_MODEL, postGeminiGenerateContent } from './gemini-client';
import { recordLlmEvent, LlmOutcome } from './llm-stats';
import { readEnv } from './r2-storage';

/**
 * Multi-provider LLM router (Gemini · Groq · OpenRouter), free tiers only.
 *
 * Roles (why each provider gets the tasks it gets):
 *  - Gemini: primary editor — long context, Google Search grounding, native TTS. Highest quality for news.
 *  - Groq (openai/gpt-oss-120b, qwen/qwen3.8-27b): extremely fast, strict JSON-schema output, ~1K requests/day
 *    but only ~8K tokens/minute — ideal for short jobs: translations, captions, classification, and as a quick
 *    editorial fallback when the article fits in its token window.
 *  - OpenRouter (`openrouter/free` router or a chosen `:free` model): large-context models, but only 50 requests/day
 *    without purchased credits — reserved for deep multi-source stories and as the last-resort fallback.
 *
 * Every provider/model has a local budget (RPM, RPD, TPM) mirroring the published free limits. A call that would
 * exceed a budget, or a provider that just returned 429/5xx/timeout, is skipped and the next one in the task's chain
 * is used immediately, so one exhausted network never blocks the pipeline.
 */

export type LlmProvider = 'gemini' | 'groq' | 'openrouter';
export type LlmTask = 'editorial' | 'story' | 'translate' | 'creative' | 'classify' | 'summary';

export interface LlmTarget {
  provider: LlmProvider;
  model: string;
  /** Free-tier budget (requests per minute / day, tokens per minute). */
  rpm: number;
  rpd: number;
  tpm: number;
  /** Largest single request (input + output tokens) this target accepts on the free tier. */
  maxRequestTokens: number;
}

export interface LlmJsonRequest {
  task: LlmTask;
  system?: string;
  prompt: string;
  schema?: Record<string, unknown>;
  schemaName?: string;
  maxTokens?: number;
  temperature?: number;
  exclude?: LlmProvider[];
  timeoutMs?: number;
}

export interface LlmResult {
  text: string;
  provider: LlmProvider;
  model: string;
}

interface Usage {
  minuteStart: number;
  minuteRequests: number;
  minuteTokens: number;
  day: string;
  dayRequests: number;
  cooldownUntil: number;
  failures: number;
  successes: number;
}

const usage = new Map<string, Usage>();

function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function envInt(name: string, fallback: number): number {
  const n = Number(readEnv(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function getTargets(): Record<LlmProvider, LlmTarget[]> {
  const groqSmart = readEnv('GROQ_MODEL_SMART') || 'openai/gpt-oss-120b';
  const groqFast = readEnv('GROQ_MODEL_FAST') || 'qwen/qwen3.8-27b';
  const openrouterModel = readEnv('OPENROUTER_MODEL') || 'openrouter/free';
  const openrouterDaily = envInt('OPENROUTER_DAILY_LIMIT', 50);
  return {
    gemini: [
      { provider: 'gemini', model: readEnv('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL, rpm: 4, rpd: envInt('GEMINI_DAILY_LIMIT', 1000), tpm: 250_000, maxRequestTokens: 900_000 },
    ],
    groq: [
      { provider: 'groq', model: groqSmart, rpm: 30, rpd: envInt('GROQ_DAILY_LIMIT', 1000), tpm: envInt('GROQ_TPM', 8000), maxRequestTokens: envInt('GROQ_TPM', 8000) },
      { provider: 'groq', model: groqFast, rpm: 30, rpd: envInt('GROQ_DAILY_LIMIT', 1000), tpm: envInt('GROQ_TPM', 8000), maxRequestTokens: envInt('GROQ_TPM', 8000) },
    ],
    openrouter: [
      { provider: 'openrouter', model: openrouterModel, rpm: 20, rpd: openrouterDaily, tpm: 1_000_000, maxRequestTokens: 120_000 },
    ],
  };
}

/** Which providers each task tries, in order. Overridable with LLM_CHAIN_<TASK>=groq,gemini,... */
export function chainFor(task: LlmTask): LlmProvider[] {
  const override = readEnv(`LLM_CHAIN_${task.toUpperCase()}`);
  if (override) {
    return override.split(',').map((p) => p.trim()).filter((p): p is LlmProvider => p === 'gemini' || p === 'groq' || p === 'openrouter');
  }
  switch (task) {
    case 'editorial':
      return ['gemini', 'groq', 'openrouter'];
    case 'story':
      return ['gemini', 'openrouter', 'groq'];
    case 'translate':
    case 'classify':
    case 'creative':
    case 'summary':
      return ['groq', 'gemini', 'openrouter'];
  }
}

function hasKey(provider: LlmProvider): boolean {
  if (provider === 'gemini') return Boolean(process.env.GEMINI_API_KEY?.trim());
  if (provider === 'groq') return Boolean(readEnv('groq_api_key'));
  return Boolean(readEnv('openrouter_api_key'));
}

function usageFor(target: LlmTarget, now = Date.now()): Usage {
  const key = `${target.provider}:${target.model}`;
  let u = usage.get(key);
  if (!u) {
    u = { minuteStart: now, minuteRequests: 0, minuteTokens: 0, day: utcDay(now), dayRequests: 0, cooldownUntil: 0, failures: 0, successes: 0 };
    usage.set(key, u);
  }
  if (now - u.minuteStart >= 60_000) {
    u.minuteStart = now;
    u.minuteRequests = 0;
    u.minuteTokens = 0;
  }
  if (u.day !== utcDay(now)) {
    u.day = utcDay(now);
    u.dayRequests = 0;
  }
  return u;
}

/** Why the call does not fit the target's free budget right now (null = it fits). */
export function blockReason(target: LlmTarget, tokens: number, now = Date.now()): LlmOutcome | null {
  const u = usageFor(target, now);
  if (u.cooldownUntil > now) return 'skipped_cooldown';
  if (tokens > target.maxRequestTokens) return 'skipped_size';
  if (u.dayRequests >= target.rpd) return 'skipped_daily';
  if (u.minuteRequests >= target.rpm) return 'skipped_rpm';
  if (u.minuteTokens + tokens > target.tpm) return 'skipped_tpm';
  return null;
}

/** True when the call fits the target's free budget right now. */
export function canUse(target: LlmTarget, tokens: number, now = Date.now()): boolean {
  return blockReason(target, tokens, now) === null;
}

function record(target: LlmTarget, tokens: number, ok: boolean, retryAfterSec?: number) {
  const u = usageFor(target);
  u.minuteRequests += 1;
  u.minuteTokens += tokens;
  u.dayRequests += 1;
  if (ok) {
    u.successes += 1;
    u.failures = 0;
  } else {
    u.failures += 1;
    const backoff = retryAfterSec ? retryAfterSec * 1000 : Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, u.failures - 1));
    u.cooldownUntil = Date.now() + backoff;
  }
}

export function resetLlmRouterForTests() {
  usage.clear();
}

/** Flat list of every configured target with its local free-tier limits (used by the stats report). */
export function llmLimits() {
  return Object.values(getTargets()).flat().map((t) => ({ provider: t.provider, model: t.model, rpd: t.rpd, rpm: t.rpm }));
}

export function llmRouterStatus() {
  const targets = getTargets();
  const now = Date.now();
  return (Object.keys(targets) as LlmProvider[]).map((provider) => ({
    provider,
    configured: hasKey(provider),
    models: targets[provider].map((t) => {
      const u = usageFor(t, now);
      return {
        model: t.model,
        usedToday: u.dayRequests,
        dailyLimit: t.rpd,
        usedThisMinute: u.minuteRequests,
        tokensThisMinute: u.minuteTokens,
        coolingDownSec: Math.max(0, Math.round((u.cooldownUntil - now) / 1000)),
        successes: u.successes,
      };
    }),
  }));
}

class LlmHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSec?: number) {
    super(message);
  }
}

async function callOpenAiCompatible(
  target: LlmTarget,
  req: LlmJsonRequest,
): Promise<{ text: string; tokens?: number }> {
  const isGroq = target.provider === 'groq';
  const url = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
  const key = isGroq ? readEnv('groq_api_key') : readEnv('openrouter_api_key');
  const messages = [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    { role: 'user', content: req.prompt },
  ];
  const body: Record<string, unknown> = {
    model: target.model,
    messages,
    temperature: req.temperature ?? 0.3,
    max_tokens: req.maxTokens ?? 2000,
  };
  if (req.schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: req.schemaName || 'result', strict: false, schema: req.schema },
    };
    // OpenRouter: only route to providers that honour structured outputs.
    if (!isGroq) body.provider = { require_parameters: true };
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (!isGroq) {
    headers['X-OpenRouter-Title'] = 'AI News Radar';
    headers['X-Title'] = 'AI News Radar';
  }
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(req.timeoutMs ?? 45_000) });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    const retryAfter = Number(resp.headers.get('retry-after'));
    throw new LlmHttpError(`${target.provider} HTTP ${resp.status}: ${text}`, resp.status, Number.isFinite(retryAfter) ? retryAfter : undefined);
  }
  const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string; usage?: { total_tokens?: number } };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new LlmHttpError(`${target.provider} returned no content`, 502);
  return { text: content, tokens: json.usage?.total_tokens };
}

async function callGemini(target: LlmTarget, req: LlmJsonRequest): Promise<{ text: string; model: string }> {
  const { data, modelUsed } = await postGeminiGenerateContent({
    apiKey: process.env.GEMINI_API_KEY!.trim(),
    preferredModel: target.model,
    priority: req.task === 'editorial' ? 'high' : 'normal',
    statsTask: req.task,
    timeoutMs: req.timeoutMs ?? 60_000,
    jsonSchemaWhenNoTools: req.schema,
    body: {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig: {
        temperature: req.temperature ?? 0.3,
        maxOutputTokens: req.maxTokens ?? 2000,
        ...(req.schema ? { responseMimeType: 'application/json', responseJsonSchema: req.schema } : {}),
      },
    },
  });
  const parts = (data as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] }).candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw new LlmHttpError('gemini returned no text', 502);
  return { text, model: modelUsed };
}

/** Runs the task on the first provider that has budget; on failure moves to the next one. */
export async function generateWithRouter(req: LlmJsonRequest): Promise<LlmResult | null> {
  const targets = getTargets();
  const tokens = estimateTokens(`${req.system || ''}${req.prompt}`) + (req.maxTokens ?? 2000);
  let lastError: unknown = null;
  for (const provider of chainFor(req.task)) {
    if (req.exclude?.includes(provider) || !hasKey(provider)) continue;
    for (const target of targets[provider]) {
      const blocked = blockReason(target, tokens);
      if (blocked) {
        recordLlmEvent({ provider, model: target.model, task: req.task, outcome: blocked });
        continue;
      }
      const startedAt = Date.now();
      try {
        if (provider === 'gemini') {
          const out = await callGemini(target, req);
          record(target, tokens, true);
          return { text: out.text, provider, model: out.model };
        }
        const out = await callOpenAiCompatible(target, req);
        record(target, tokens, true);
        recordLlmEvent({ provider, model: target.model, task: req.task, outcome: 'ok', tokens: out.tokens ?? tokens, latencyMs: Date.now() - startedAt });
        return { text: out.text, provider, model: target.model };
      } catch (err) {
        lastError = err;
        const status = err instanceof LlmHttpError ? err.status : (err as { status?: number })?.status;
        // Gemini attempts are already counted per HTTP request inside postGeminiGenerateContent.
        if (provider !== 'gemini') {
          const name = (err as Error)?.name;
          const outcome: LlmOutcome = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : status === 429 ? 'rate_limited' : status === 502 && err instanceof LlmHttpError && /no content/.test(err.message) ? 'no_content' : 'http_error';
          recordLlmEvent({ provider, model: target.model, task: req.task, outcome, latencyMs: Date.now() - startedAt, detail: err instanceof Error ? err.message : String(err) });
        }
        // 400 = this model rejected the request shape (e.g. schema); try the next target without a long cooldown.
        record(target, tokens, false, status === 400 ? 5 : err instanceof LlmHttpError ? err.retryAfterSec : undefined);
      }
    }
  }
  recordLlmEvent({ provider: 'router', model: '-', task: req.task, outcome: 'exhausted', detail: lastError instanceof Error ? lastError.message : undefined });
  if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  return null;
}

/** Same as generateWithRouter but parses the JSON answer (tolerates ```json fences). */
export async function generateJsonWithRouter<T = unknown>(req: LlmJsonRequest): Promise<{ data: T; provider: LlmProvider; model: string } | null> {
  const res = await generateWithRouter(req);
  if (!res) return null;
  return { data: parseJsonLoose(res.text) as T, provider: res.provider, model: res.model };
}

export function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Model did not return JSON');
  }
}
