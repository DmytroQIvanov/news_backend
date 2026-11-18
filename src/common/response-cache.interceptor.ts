/**
 * Short-lived in-memory cache for the heavy public GET endpoints (feed, news lists, brief, topics, catalog, discovery).
 * The 1 GB server answers a cold /feed in 5-13 s; with this cache every client inside the TTL gets the same answer in
 * milliseconds, identical concurrent requests share one computation, and a failing handler falls back to the last good
 * answer (up to STALE_MS) so the app is never empty because of a transient database or quota problem.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, of } from 'rxjs';

interface Entry {
  at: number;
  body: unknown;
}

const RULES: Array<{ re: RegExp; ttlMs: number }> = [
  { re: /^\/api\/v1\/feed(\/|\?|$)/, ttlMs: 45_000 },
  { re: /^\/api\/v1\/news(\?|$)/, ttlMs: 45_000 },
  { re: /^\/api\/v1\/news\/[^/]+\/related/, ttlMs: 120_000 },
  { re: /^\/api\/v1\/news\/briefings/, ttlMs: 60_000 },
  { re: /^\/api\/v1\/brief\//, ttlMs: 120_000 },
  { re: /^\/api\/v1\/topics/, ttlMs: 120_000 },
  { re: /^\/api\/v1\/catalog/, ttlMs: 180_000 },
  { re: /^\/api\/v1\/(discovery|encyclopedia)(\/|\?|$)/, ttlMs: 180_000 },
  { re: /^\/api\/v1\/youtube\/(insights|news)/, ttlMs: 120_000 },
  { re: /^\/api\/v1\/kb\/(events|news)/, ttlMs: 90_000 },
];
const STALE_MS = 10 * 60_000;
const MAX_ENTRIES = 400;

export function cacheTtlFor(method: string, url: string, hasAuth: boolean): number {
  if (method !== 'GET' || hasAuth) return 0;
  for (const r of RULES) if (r.re.test(url)) return r.ttlMs;
  return 0;
}

@Injectable()
export class ResponseCacheInterceptor implements NestInterceptor {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || process.env.RESPONSE_CACHE === 'false') return next.handle();
    const req = context.switchToHttp().getRequest<{ method: string; originalUrl?: string; url: string; headers: Record<string, string | undefined> }>();
    const url = req.originalUrl ?? req.url;
    const hasAuth = Boolean(req.headers['x-ingest-key'] || req.headers['authorization'] || req.headers['cookie']);
    const ttl = url.length > 400 ? 0 : cacheTtlFor(req.method, url, hasAuth);
    if (!ttl) return next.handle();
    const key = `${url}|${req.headers['accept-language'] ?? ''}`;
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttl) return of(hit.body);
    const pending = this.inflight.get(key);
    if (pending) return from(pending);
    const work = new Promise<unknown>((resolve, reject) => {
      next.handle().subscribe({
        next: (body) => {
          this.store(key, body);
          resolve(body);
        },
        error: (err) => {
          const status = typeof err?.getStatus === 'function' ? err.getStatus() : 500;
          // only transient failures fall back to the last good answer; a 404/403/400 must never resurrect removed data
          if (hit && status >= 500 && Date.now() - hit.at < STALE_MS) resolve(hit.body);
          else reject(err);
        },
      });
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return from(work);
  }

  private store(key: string, body: unknown) {
    let size = 0;
    try {
      size = JSON.stringify(body)?.length ?? 0;
    } catch {
      return;
    }
    if (size > 600_000) return; // bounded memory on the small server
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    this.cache.set(key, { at: Date.now(), body });
  }
}
