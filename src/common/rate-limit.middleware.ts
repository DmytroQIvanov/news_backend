import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Lightweight in-memory sliding-window rate limiter for Express/NestJS.
 * Protects public and admin endpoints from accidental or abusive request bursts
 * without requiring external Redis infrastructure on free-tier hosting.
 */
export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  paths?: RegExp[];
}) {
  const buckets = new Map<string, Bucket>();
  const { windowMs, maxRequests, paths } = options;

  // Periodic cleanup to prevent unbounded memory growth
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }, Math.max(60_000, windowMs));
  cleanupTimer.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (paths && !paths.some(pattern => pattern.test(req.path))) {
      next();
      return;
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${ip}:${req.method}:${req.baseUrl || req.path.split('/').slice(0, 4).join('/')}`;
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || now >= existing.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (existing.count >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        statusCode: 429,
        message: 'Too many requests, please try again later.',
      });
      return;
    }

    existing.count += 1;
    next();
  };
}
