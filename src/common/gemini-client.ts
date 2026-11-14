import { isTransientHttpStatus } from './url-utils';

const FALLBACK_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
];

const STRICT_MAX_RPM = 4;
const RPM_WINDOW_MS = 61_000;
const MIN_GEMINI_INTERVAL_MS = 15_500; // Strict <= 4 RPM with >= 15.5s spacing
let geminiQueue: Promise<unknown> = Promise.resolve();
let lastGeminiCallAt = 0;
let cooldownUntil = 0;
const recentAttemptTimestamps: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneAttemptTimestamps(now: number): void {
  const cutoff = now - RPM_WINDOW_MS;
  while (recentAttemptTimestamps.length > 0 && recentAttemptTimestamps[0] <= cutoff) {
    recentAttemptTimestamps.shift();
  }
}

function enqueueGeminiHttpAttempt<T>(task: () => Promise<T>): Promise<T> {
  const run = geminiQueue.then(async () => {
    while (true) {
      const now = Date.now();
      pruneAttemptTimestamps(now);

      const waitCooldown = Math.max(0, cooldownUntil - now);
      const waitSpacing = lastGeminiCallAt > 0 ? Math.max(0, MIN_GEMINI_INTERVAL_MS - (now - lastGeminiCallAt)) : 0;
      const waitWindow =
        recentAttemptTimestamps.length >= STRICT_MAX_RPM
          ? Math.max(0, recentAttemptTimestamps[0] + RPM_WINDOW_MS - now)
          : 0;

      const waitMs = Math.max(waitCooldown, waitSpacing, waitWindow);
      if (waitMs > 0) {
        await sleep(waitMs);
        continue;
      }

      const firedAt = Date.now();
      recentAttemptTimestamps.push(firedAt);
      lastGeminiCallAt = firedAt;
      return task();
    }
  });
  geminiQueue = run.catch(() => undefined);
  return run;
}

export function normalizeGeminiModel(model?: string): string {
  const cleaned = (model || '').replace(/^models\//i, '').trim();
  return cleaned || 'gemini-2.5-flash';
}

export async function postGeminiGenerateContent(params: {
  apiKey: string;
  preferredModel?: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ data: unknown; modelUsed: string }> {
  const primary = normalizeGeminiModel(params.preferredModel);
  const candidates = Array.from(new Set([primary, ...FALLBACK_GEMINI_MODELS]));
  let lastError: Error | null = null;

  for (const model of candidates) {
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const result = await enqueueGeminiHttpAttempt(async () => {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': params.apiKey,
            },
            signal: AbortSignal.timeout(params.timeoutMs ?? 45_000),
            body: JSON.stringify(params.body),
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
        if (result.status === 429 && attempt === 1) {
          cooldownUntil = Math.max(cooldownUntil, Date.now() + 61_000);
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
      if (status !== 404) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('Gemini request failed');
}
