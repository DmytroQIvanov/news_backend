import { isTransientHttpStatus, retryWithBackoff } from './url-utils';

const FALLBACK_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
];

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
      const data = await retryWithBackoff(
        async () => {
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
          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            const snippet = errText.replace(/\s+/g, ' ').slice(0, 180);
            const err = new Error(`Gemini HTTP ${resp.status} (${model})${snippet ? `: ${snippet}` : ''}`);
            (err as Error & { status?: number }).status = resp.status;
            throw err;
          }
          return resp.json();
        },
        {
          maxAttempts: 2,
          baseDelayMs: 1000,
          shouldRetry: (err) => isTransientHttpStatus((err as { status?: number })?.status ?? 0),
        },
      );
      return { data, modelUsed: model };
    } catch (error) {
      const status = (error as { status?: number })?.status;
      lastError = error instanceof Error ? error : new Error(String(error));
      // Only try next fallback model when Google says 404 (model not found/unsupported for this key)
      if (status !== 404) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('Gemini request failed');
}
