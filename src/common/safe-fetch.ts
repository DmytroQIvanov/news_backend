/**
 * Guarded fetching of untrusted URLs: every hop (including redirects) must be a public https address, redirects are followed
 * manually (at most 4), and the body is streamed with a hard byte limit so a huge page cannot exhaust memory.
 */
import { resolveAndValidatePublicUrl } from './source-compliance';

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  url: string;
  text: string;
  truncated: boolean;
}

export async function safeFetchText(
  url: string,
  opts: { maxBytes?: number; maxRedirects?: number; timeoutMs?: number; headers?: Record<string, string>; lookupFn?: (host: string) => Promise<Array<{ address: string }>>; fetchFn?: typeof fetch } = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 400_000;
  const fetchImpl = opts.fetchFn ?? fetch;
  let current = url;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 4); hop += 1) {
    const check = await resolveAndValidatePublicUrl(current, { lookupFn: opts.lookupFn });
    if (!check.safe) return { ok: false, status: 0, url: current, text: '', truncated: false };
    const resp = await fetchImpl(current, { redirect: 'manual', headers: opts.headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      await resp.body?.cancel().catch(() => undefined);
      if (!loc) return { ok: false, status: resp.status, url: current, text: '', truncated: false };
      current = new URL(loc, current).toString();
      continue;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    const reader = resp.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
      }
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
    return { ok: resp.ok, status: resp.status, url: current, text, truncated };
  }
  return { ok: false, status: 0, url: current, text: '', truncated: false };
}

/** Final public URL after redirects (every hop validated), or null. */
export async function safeResolveUrl(url: string, maxRedirects = 5): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!(await resolveAndValidatePublicUrl(current)).safe) return null;
    let resp: Response;
    try {
      resp = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(12_000) });
    } catch {
      return null;
    }
    await resp.body?.cancel().catch(() => undefined);
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return null;
      current = new URL(loc, current).toString();
      continue;
    }
    return /^https:\/\//.test(current) && !/vertexaisearch|google\.com\/url/.test(current) ? current : null;
  }
  return null;
}
