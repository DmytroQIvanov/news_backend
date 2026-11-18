import { recordLlmTokens, reserveLlmCall } from './llm-budget';
import { recordLlmEvent } from './llm-stats';
import { isTransientHttpStatus } from './url-utils';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
export const DEFAULT_HYDROGEN_MODEL = process.env.GEMINI_HYDROGEN_MODEL?.trim() || 'gemini-4-hydrogen';

export const FALLBACK_GEMINI_MODELS = [
  // Models with real free quota (checked against the API model list): 3.1 Flash Lite ~500/day, 2.5 Flash Lite and
  // 3 Flash ~20/day, Hydrogen ~20/day. Gemma 4 31B has no daily cap (small prompts only) and is the last resort.
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-4-hydrogen',
  'gemma-4-31b-it',
];

const STRICT_MAX_RPM = 4;
const RPM_WINDOW_MS = 61_000;
const MIN_GEMINI_INTERVAL_MS = 15_500; // Strict <= 4 RPM with >= 15.5s spacing
const MODEL_NOT_FOUND_TTL_MS = 5 * 60_000;

interface RateBucketState {
  queue: Promise<unknown>;
  lastCallAt: number;
  cooldownUntil: number;
  recentAttemptTimestamps: number[];
}

interface RateBucketStateWithDepth extends RateBucketState {
  pending: number;
}

function createBucket(): RateBucketStateWithDepth {
  return { queue: Promise.resolve(), lastCallAt: 0, cooldownUntil: 0, recentAttemptTimestamps: [], pending: 0 };
}

/**
 * Free-tier Gemini quotas are tracked per model, so each model gets its own RPM bucket.
 * Previously every model shared one 4 RPM queue, which throttled the whole backend to the
 * slowest model and let background jobs (memes, experts) starve editorial processing.
 * GEMINI_SHARED_BUCKET=true restores the old single-queue behaviour.
 */
const standardBucket: RateBucketStateWithDepth = createBucket();
const modelBuckets = new Map<string, RateBucketStateWithDepth>();

function bucketForModel(model: string): RateBucketStateWithDepth {
  if (process.env.GEMINI_SHARED_BUCKET === 'true') return standardBucket;
  let bucket = modelBuckets.get(model);
  if (!bucket) {
    bucket = createBucket();
    modelBuckets.set(model, bucket);
  }
  return bucket;
}

export type GeminiPriority = 'high' | 'normal' | 'low';

/** Low-priority callers give up instead of queueing behind more than this many pending calls on a model. */
const LOW_PRIORITY_MAX_PENDING = 1;
const NORMAL_PRIORITY_MAX_PENDING = 6;

const hydrogenBucket: RateBucketStateWithDepth = createBucket();

function getUtcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

let hydrogenDailyUsage = {
  dayKey: getUtcDayKey(),
  count: 0,
};

const unavailableModelsCache = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getHydrogenLimits() {
  const maxRpm = parsePositiveIntEnv(process.env.GEMINI_HYDROGEN_MAX_RPM, 10);
  const maxRpd = parsePositiveIntEnv(process.env.GEMINI_HYDROGEN_MAX_RPD, 150);
  const minIntervalMs = maxRpm === 10 ? 6_100 : Math.max(1_000, Math.ceil(RPM_WINDOW_MS / maxRpm));
  return { maxRpm, maxRpd, minIntervalMs };
}

function syncHydrogenDay(now = Date.now()): void {
  const today = getUtcDayKey(now);
  if (hydrogenDailyUsage.dayKey !== today) {
    hydrogenDailyUsage = { dayKey: today, count: 0 };
  }
}

export function normalizeGeminiModel(model?: string): string {
  const cleaned = (model || '').replace(/^models\//i, '').trim();
  return cleaned || DEFAULT_GEMINI_MODEL;
}

export function isHydrogenModel(model: string): boolean {
  return /hydrogen/i.test(normalizeGeminiModel(model));
}

export function supportsSearchTools(model: string): boolean {
  return !isHydrogenModel(model);
}

export function supportsGeminiThinkingBudget(model: string): boolean {
  const normalized = normalizeGeminiModel(model);
  if (/tts/i.test(normalized)) {
    return false;
  }
  return /^(gemini-2\.5|gemini-3(?:\.\d+)?|gemini-4(?:\.\d+)?)/i.test(normalized) || isHydrogenModel(normalized);
}

export function getHydrogenQuotaStatus(now = Date.now()) {
  syncHydrogenDay(now);
  const { maxRpm, maxRpd, minIntervalMs } = getHydrogenLimits();
  const usedToday = hydrogenDailyUsage.count;
  const remainingToday = Math.max(0, maxRpd - usedToday);
  const cooldownActive = hydrogenBucket.cooldownUntil > now;
  return {
    model: DEFAULT_HYDROGEN_MODEL,
    dayKey: hydrogenDailyUsage.dayKey,
    maxRpm,
    maxRpd,
    minIntervalMs,
    usedToday,
    remainingToday,
    cooldownActive,
    available: remainingToday > 0 && !cooldownActive,
  };
}

export function canUseHydrogenQuota(reserveCount = 1, now = Date.now()): boolean {
  const status = getHydrogenQuotaStatus(now);
  return !status.cooldownActive && status.usedToday + Math.max(1, reserveCount) <= status.maxRpd;
}

export function recordHydrogenUsage(count = 1, now = Date.now()) {
  syncHydrogenDay(now);
  if (count > 0) {
    hydrogenDailyUsage.count += count;
  }
  return getHydrogenQuotaStatus(now);
}

function isModelTemporarilyUnavailable(model: string, now = Date.now()): boolean {
  const expiresAt = unavailableModelsCache.get(model);
  if (!expiresAt) return false;
  if (expiresAt <= now) {
    unavailableModelsCache.delete(model);
    return false;
  }
  return true;
}

function markModelUnavailable(model: string, now = Date.now()): void {
  unavailableModelsCache.set(model, now + MODEL_NOT_FOUND_TTL_MS);
}

function pruneAttemptTimestamps(bucket: RateBucketState, now: number): void {
  const cutoff = now - RPM_WINDOW_MS;
  while (bucket.recentAttemptTimestamps.length > 0 && bucket.recentAttemptTimestamps[0] <= cutoff) {
    bucket.recentAttemptTimestamps.shift();
  }
}

type AttemptOutcome =
  | { ok: true; data: unknown }
  | { ok: false; status: number; snippet: string };

function enqueueGeminiHttpAttempt(
  isHydrogen: boolean,
  task: () => Promise<AttemptOutcome>,
  model = '',
  priority: GeminiPriority = 'normal',
): Promise<AttemptOutcome> {
  const bucket = isHydrogen ? hydrogenBucket : bucketForModel(model);
  const maxPending =
    priority === 'low' ? LOW_PRIORITY_MAX_PENDING : priority === 'normal' ? NORMAL_PRIORITY_MAX_PENDING : Infinity;
  if (bucket.pending >= maxPending) {
    return Promise.resolve({ ok: false as const, status: 429, snippet: `local ${priority}-priority queue is busy` });
  }
  bucket.pending += 1;
  const hydrogenLimits = isHydrogen ? getHydrogenLimits() : null;
  const maxRpm = hydrogenLimits ? hydrogenLimits.maxRpm : STRICT_MAX_RPM;
  const minIntervalMs = hydrogenLimits ? hydrogenLimits.minIntervalMs : MIN_GEMINI_INTERVAL_MS;

  const run = bucket.queue.then(async () => {
    while (true) {
      const now = Date.now();
      pruneAttemptTimestamps(bucket, now);

      const waitCooldown = Math.max(0, bucket.cooldownUntil - now);
      const waitSpacing = bucket.lastCallAt > 0 ? Math.max(0, minIntervalMs - (now - bucket.lastCallAt)) : 0;
      const waitWindow =
        bucket.recentAttemptTimestamps.length >= maxRpm
          ? Math.max(0, bucket.recentAttemptTimestamps[0] + RPM_WINDOW_MS - now)
          : 0;

      const waitMs = Math.max(waitCooldown, waitSpacing, waitWindow);
      if (waitMs > 0) {
        await sleep(waitMs);
        continue;
      }

      const firedAt = Date.now();
      const outcome = await task();
      // Do not consume RPM spacing or timestamps on instant 404/400 model/config mismatches
      if (outcome.ok || (outcome.status !== 404 && outcome.status !== 400)) {
        bucket.recentAttemptTimestamps.push(firedAt);
        bucket.lastCallAt = firedAt;
        if (isHydrogen) {
          recordHydrogenUsage(1, firedAt);
        }
      }
      return outcome;
    }
  });
  const settled = run.finally(() => {
    bucket.pending = Math.max(0, bucket.pending - 1);
  });
  bucket.queue = settled.catch(() => undefined);
  return settled;
}

export function buildGeminiRequestBody(
  baseBody: Record<string, unknown>,
  model: string,
  envThinkingBudget: string | undefined = process.env.GEMINI_THINKING_BUDGET,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...baseBody };
  const rawGenConfig = baseBody.generationConfig;
  const genConfig =
    rawGenConfig && typeof rawGenConfig === 'object' && !Array.isArray(rawGenConfig)
      ? { ...(rawGenConfig as Record<string, unknown>) }
      : undefined;

  if (!supportsSearchTools(model)) {
    delete payload.tools;
  }

  if (envThinkingBudget !== undefined && envThinkingBudget.trim() !== '') {
    const parsedBudget = Number(envThinkingBudget.trim());
    if (
      Number.isInteger(parsedBudget) &&
      parsedBudget >= 0 &&
      supportsGeminiThinkingBudget(model) &&
      genConfig?.thinkingConfig === undefined
    ) {
      payload.generationConfig = {
        ...(genConfig ?? {}),
        thinkingConfig: { thinkingBudget: parsedBudget },
      };
      return payload;
    }
  }

  if (genConfig) {
    payload.generationConfig = genConfig;
  }
  return payload;
}

export function resetGeminiClientStateForTests(): void {
  modelBuckets.clear();
  standardBucket.pending = 0;
  hydrogenBucket.pending = 0;
  standardBucket.queue = Promise.resolve();
  standardBucket.lastCallAt = 0;
  standardBucket.cooldownUntil = 0;
  standardBucket.recentAttemptTimestamps.length = 0;

  hydrogenBucket.queue = Promise.resolve();
  hydrogenBucket.lastCallAt = 0;
  hydrogenBucket.cooldownUntil = 0;
  hydrogenBucket.recentAttemptTimestamps.length = 0;

  hydrogenDailyUsage = {
    dayKey: getUtcDayKey(),
    count: 0,
  };
  unavailableModelsCache.clear();
}

export async function postGeminiGenerateContent(params: {
  apiKey: string;
  preferredModel?: string;
  candidateModels?: string[];
  jsonSchemaWhenNoTools?: Record<string, unknown>;
  body: Record<string, unknown>;
  timeoutMs?: number;
  /** high = editorial/user-facing, normal = default, low = optional enrichment (memes, caricature prompts). */
  priority?: GeminiPriority;
  /** Label for usage statistics (defaults to "direct:<priority>" for calls outside the LLM router). */
  statsTask?: string;
  /** Purpose charged in the shared daily budget (llm-budget.ts); defaults to statsTask. */
  budgetPurpose?: string;
}): Promise<{ data: unknown; modelUsed: string }> {
  const statsTask = params.statsTask ?? `direct:${params.priority ?? 'normal'}`;
  const primary = normalizeGeminiModel(params.preferredModel);
  const rawCandidates = params.candidateModels?.length
    ? Array.from(new Set(params.candidateModels.map((entry) => normalizeGeminiModel(entry))))
    : Array.from(new Set([primary, ...FALLBACK_GEMINI_MODELS]));

  const candidates = rawCandidates.filter((model) => !isModelTemporarilyUnavailable(model));
  if (candidates.length === 0) {
    throw new Error('All candidate Gemini models are temporarily unavailable (cached 404)');
  }

  let lastError: Error | null = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const model = candidates[i];
    const hasNextModel = i < candidates.length - 1;
    const useHydrogenBucket = isHydrogenModel(model);

    if (useHydrogenBucket && !canUseHydrogenQuota() && hasNextModel) {
      continue;
    }

    const requestPayload = buildGeminiRequestBody(params.body, model);
    if (!supportsSearchTools(model) && params.jsonSchemaWhenNoTools) {
      const existingConfig =
        requestPayload.generationConfig &&
        typeof requestPayload.generationConfig === 'object' &&
        !Array.isArray(requestPayload.generationConfig)
          ? (requestPayload.generationConfig as Record<string, unknown>)
          : {};
      if (!existingConfig.responseJsonSchema) {
        requestPayload.generationConfig = {
          ...existingConfig,
          responseMimeType: 'application/json',
          responseJsonSchema: params.jsonSchemaWhenNoTools,
        };
      }
    }

    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        // Shared daily budget: reserve BEFORE the request; retries are requests too.
        if (!(await reserveLlmCall(model, params.budgetPurpose ?? statsTask))) {
          recordLlmEvent({ provider: 'gemini', model, task: statsTask, outcome: 'skipped_daily', detail: 'shared daily budget' });
          const budgetErr = new Error(`LLM daily budget exhausted (${model})`);
          (budgetErr as Error & { status?: number }).status = 429;
          throw budgetErr;
        }
        const result = await enqueueGeminiHttpAttempt(useHydrogenBucket, async () => {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
          const startedAt = Date.now();
          let resp: Response;
          try {
            resp = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': params.apiKey,
              },
              signal: AbortSignal.timeout(params.timeoutMs ?? 45_000),
              body: JSON.stringify(requestPayload),
            });
          } catch (fetchError) {
            const timedOut = (fetchError as Error)?.name === 'TimeoutError' || (fetchError as Error)?.name === 'AbortError';
            recordLlmEvent({
              provider: 'gemini', model, task: statsTask, outcome: timedOut ? 'timeout' : 'http_error',
              latencyMs: Date.now() - startedAt, detail: fetchError instanceof Error ? fetchError.message : String(fetchError),
            });
            throw fetchError;
          }
          if (resp.ok) {
            const data = await resp.json();
            const meta = (data as { usageMetadata?: { totalTokenCount?: number; promptTokenCount?: number; candidatesTokenCount?: number } })?.usageMetadata;
            recordLlmEvent({ provider: 'gemini', model, task: statsTask, outcome: 'ok', tokens: meta?.totalTokenCount, latencyMs: Date.now() - startedAt });
            void recordLlmTokens(model, params.budgetPurpose ?? statsTask, meta?.promptTokenCount ?? 0, meta?.candidatesTokenCount ?? 0);
            return { ok: true as const, data };
          }
          const errText = await resp.text().catch(() => '');
          const snippet = errText.replace(/\s+/g, ' ').slice(0, 180);
          recordLlmEvent({
            provider: 'gemini', model, task: statsTask, outcome: resp.status === 429 ? 'rate_limited' : 'http_error',
            latencyMs: Date.now() - startedAt, detail: `HTTP ${resp.status} ${snippet}`,
          });
          return { ok: false as const, status: resp.status, snippet };
        }, model, params.priority ?? 'normal');

        if (result.ok) {
          return { data: result.data, modelUsed: model };
        }
        if (result.status === 404) {
          markModelUnavailable(model);
        }
        const localBusy = result.status === 429 && result.snippet.startsWith('local ');
        if (localBusy) recordLlmEvent({ provider: 'gemini', model, task: statsTask, outcome: 'skipped_local', detail: result.snippet });
        if (result.status === 429 && !localBusy && !hasNextModel && attempt === 1 && params.priority !== 'low') {
          const bucket = useHydrogenBucket ? hydrogenBucket : bucketForModel(model);
          bucket.cooldownUntil = Math.max(bucket.cooldownUntil, Date.now() + 61_000);
          continue;
        }
        if (isTransientHttpStatus(result.status) && result.status !== 429 && attempt === 1) {
          continue;
        }
        const err = new Error(
          `Gemini HTTP ${result.status} (${model})${result.snippet ? `: ${result.snippet}` : ''}`,
        );
        (err as Error & { status?: number }).status = result.status;
        throw err;
      }
      throw new Error(`Gemini exhausted retries (${model})`);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (status !== 404 && status !== 429 && status !== 400) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('Gemini request failed');
}
