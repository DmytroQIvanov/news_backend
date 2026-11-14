import { isTransientHttpStatus } from './url-utils';

const FALLBACK_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
];

const MIN_GEMINI_INTERVAL_MS = 14_000; // ~4.2 RPM to stay safely below 5 RPM free tier limit
let geminiQueue: Promise<unknown> = Promise.resolve();
let lastGeminiCallAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueGeminiSlot<T>(task: () => Promise<T>): Promise<T> {
  const run = geminiQueue.then(async () => {
    const elapsed = Date.now() - lastGeminiCallAt;
    if (elapsed < MIN_GEMINI_INTERVAL_MS) {
      await sleep(MIN_GEMINI_INTERVAL_MS - elapsed);
    }
    lastGeminiCallAt = Date.now();
    return task();
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
      const data = await enqueueGeminiSlot(async () => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
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
            return resp.json();
          }
          const errText = await resp.text().catch(() => '');
          const snippet = errText.replace(/\s+/g, ' ').slice(0, 180);
          if (resp.status === 429 && attempt === 1) {
            // Respect 5 RPM window reset before retrying once
            await sleep(61_000);
            lastGeminiCallAt = Date.now();
            continue;
          }
          if (isTransientHttpStatus(resp.status) && resp.status !== 429 && attempt === 1) {
            await sleep(2_000);
            lastGeminiCallAt = Date.now();
            continue;
          }
          const err = new Error(`Gemini HTTP ${resp.status} (${model})${snippet ? `: ${snippet}` : ''}`);
          (err as Error & { status?: number }).status = resp.status;
          throw err;
        }
        throw new Error(`Gemini exhausted retries (${model})`);
      });
      return { data, modelUsed: model };
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
