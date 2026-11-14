const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source',
]);

/**
 * Normalizes an HTTPS URL for reliable deduplication across feeds and API ingest.
 * Strips fragments, tracking query parameters, `www.` prefix, and trailing slashes.
 */
export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  const parsed = URL.parse(trimmed);
  if (!parsed) return trimmed;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const kept = [...parsed.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));

  const query = new URLSearchParams(kept).toString();
  return `${parsed.protocol}//${host}${pathname}${query ? `?${query}` : ''}`;
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/**
 * Executes an async operation with bounded exponential backoff and jitter.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = Math.max(50, options.baseDelayMs ?? 1000);
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }
      const jitter = Math.floor(Math.random() * 250);
      const delayMs = baseDelayMs * 2 ** (attempt - 1) + jitter;
      options.onRetry?.(attempt, error, delayMs);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
