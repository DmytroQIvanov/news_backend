import { isTransientHttpStatus } from './url-utils';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_HYDROGEN_MODEL = process.env.GEMINI_HYDROGEN_MODEL?.trim() || 'gemini-4-hydrogen';

export const FALLBACK_GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3-flash',
  'gemini-4-hydrogen',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
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

const standardBucket: RateBucketState = {
  queue: Promise.resolve(),
  lastCallAt: 0,
  cooldownUntil: 0,
  recentAttemptTimestamps: [],
};

const hydrogenBucket: RateBucketState = {
  queue: Promise.resolve(),
  lastCallAt: 0,
  cooldownUntil: 0,
  recentAttemptTimestamps: [],
};

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
): Promise<AttemptOutcome> {
  const bucket = isHydrogen ? hydrogenBucket : standardBucket;
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
  bucket.queue = run.catch(() => undefined);
  return run;
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
}): Promise<{ data: unknown; modelUsed: string }> {
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
        const result = await enqueueGeminiHttpAttempt(useHydrogenBucket, async () => {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': params.apiKey,
            },
            signal: AbortSignal.timeout(params.timeoutMs ?? 45_000),
            body: JSON.stringify(requestPayload),
          });
          if (resp.ok) {
            return { ok: true as const, data: await resp.json() };
          }
          const errText = await resp.text().catch(() => '');
          const snippet = errText.replace(/\s+/g, ' ').slice(0, 180);
          return { ok: false as const, status: resp.status, snippet };
        });

        if (result.ok) {
          return { data: result.data, modelUsed: model };
        }
        if (result.status === 404) {
          markModelUnavailable(model);
        }
        if (result.status === 429 && !hasNextModel && attempt === 1) {
          const bucket = useHydrogenBucket ? hydrogenBucket : standardBucket;
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
