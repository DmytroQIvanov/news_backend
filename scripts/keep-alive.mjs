#!/usr/bin/env node
/**
 * Render + Neon PostgreSQL Keep-Alive Script (Node.js 18+, zero dependencies).
 *
 * Usage:
 *   node scripts/keep-alive.mjs --once --api https://news-backend-v0jj.onrender.com
 *   node scripts/keep-alive.mjs --interval 720 --sync-if-key
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_API_URL = 'https://news-backend-v0jj.onrender.com';
export const DEFAULT_INTERVAL_SECONDS = 720; // 12 minutes
export const DEFAULT_MAX_RETRY_MS = 60_000;
export const DEFAULT_RETRY_DELAY_MS = 5_000;
export const DAILY_SYNC_INTERVAL_MS = 24 * 60 * 60_000;

export function buildHealthUrls(baseUrl = DEFAULT_API_URL) {
  const normalized =
    String(baseUrl || DEFAULT_API_URL)
      .trim()
      .replace(/\/+$/, '') || DEFAULT_API_URL;
  return [`${normalized}/api/v1/health`, `${normalized}/health/db`];
}

export function parseKeepAliveArgs(argv = [], env = process.env) {
  const defaultApi = (env.RENDER_API_URL || '').trim() || DEFAULT_API_URL;
  const parsed = {
    apiUrl: defaultApi.replace(/\/+$/, ''),
    once: false,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    syncIfKey: false,
    maxRetryMs: DEFAULT_MAX_RETRY_MS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (arg === '--once') {
      parsed.once = true;
    } else if (arg === '--sync-if-key') {
      parsed.syncIfKey = true;
    } else if (arg === '--api' && argv[i + 1]) {
      parsed.apiUrl = String(argv[i + 1]).trim().replace(/\/+$/, '');
      i += 1;
    } else if (arg.startsWith('--api=')) {
      parsed.apiUrl = arg.slice('--api='.length).trim().replace(/\/+$/, '');
    } else if (arg === '--interval' && argv[i + 1]) {
      const val = Number(argv[i + 1]);
      if (Number.isFinite(val) && val > 0) {
        parsed.intervalSeconds = Math.round(val);
      }
      i += 1;
    } else if (arg.startsWith('--interval=')) {
      const val = Number(arg.slice('--interval='.length));
      if (Number.isFinite(val) && val > 0) {
        parsed.intervalSeconds = Math.round(val);
      }
    }
  }

  if (!parsed.apiUrl) {
    parsed.apiUrl = DEFAULT_API_URL;
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

async function fetchWithColdStartRetry(url, { maxRetryMs, retryDelayMs, method = 'GET', headers = {} }) {
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          'User-Agent': 'OpportunityRadar-KeepAlive/2.0',
          Accept: 'application/json',
          ...headers,
        },
        signal: AbortSignal.timeout(20_000),
      });
      const elapsedMs = Date.now() - t0;

      if (resp.ok) {
        const body = await resp.text().catch(() => '');
        return { ok: true, status: resp.status, elapsedMs, attempt, body };
      }

      await resp.body?.cancel();
      const canRetry = isRetryableStatus(resp.status) && Date.now() - startedAt < maxRetryMs;
      if (!canRetry) {
        return { ok: false, status: resp.status, elapsedMs, attempt, error: `HTTP ${resp.status}` };
      }
      console.log(
        `[keep-alive] ${url} returned HTTP ${resp.status} (cold start, attempt ${attempt}); retrying in ${retryDelayMs / 1000}s...`,
      );
    } catch (error) {
      const elapsedMs = Date.now() - t0;
      const msg = error instanceof Error ? error.message : String(error);
      const canRetry = Date.now() - startedAt < maxRetryMs;
      if (!canRetry) {
        return { ok: false, status: 0, elapsedMs, attempt, error: msg };
      }
      console.log(
        `[keep-alive] ${url} failed (${msg}, attempt ${attempt}); retrying in ${retryDelayMs / 1000}s...`,
      );
    }
    await sleep(retryDelayMs);
  }
}

async function pingTarget(config) {
  const [apiHealthUrl, dbHealthUrl] = buildHealthUrls(config.apiUrl);

  let healthRes = await fetchWithColdStartRetry(apiHealthUrl, config);
  if (!healthRes.ok && healthRes.status === 404) {
    const fallbackUrl = `${config.apiUrl}/health`;
    console.log(`[keep-alive] ${apiHealthUrl} returned 404, falling back to ${fallbackUrl}`);
    healthRes = await fetchWithColdStartRetry(fallbackUrl, config);
  }
  console.log(
    `[keep-alive] [${new Date().toISOString()}] ${apiHealthUrl} -> ${healthRes.ok ? 'OK' : 'FAIL'} (HTTP ${healthRes.status}, ${healthRes.elapsedMs}ms, attempts=${healthRes.attempt})`,
  );

  const dbRes = await fetchWithColdStartRetry(dbHealthUrl, config);
  console.log(
    `[keep-alive] [${new Date().toISOString()}] ${dbHealthUrl} -> ${dbRes.ok ? 'OK' : 'FAIL'} (HTTP ${dbRes.status}, ${dbRes.elapsedMs}ms, attempts=${dbRes.attempt})`,
  );

  return healthRes.ok && dbRes.ok;
}

async function maybeTriggerGrantsRefresh(config, lastGrantsSyncAt) {
  if (!config.syncIfKey) return lastGrantsSyncAt;
  const ingestKey = process.env.INGEST_API_KEY?.trim();
  if (!ingestKey) return lastGrantsSyncAt;
  if (lastGrantsSyncAt > 0 && Date.now() - lastGrantsSyncAt < DAILY_SYNC_INTERVAL_MS) {
    return lastGrantsSyncAt;
  }

  const refreshUrl = `${config.apiUrl}/api/v1/grants/refresh`;
  const res = await fetchWithColdStartRetry(refreshUrl, {
    ...config,
    method: 'POST',
    headers: {
      'x-ingest-key': ingestKey,
      'Content-Type': 'application/json',
    },
  });
  console.log(
    `[keep-alive] [${new Date().toISOString()}] POST ${refreshUrl} -> ${res.ok ? 'OK' : 'FAIL'} (HTTP ${res.status}, ${res.elapsedMs}ms)`,
  );
  return res.ok ? Date.now() : lastGrantsSyncAt;
}

async function main() {
  const config = parseKeepAliveArgs(process.argv.slice(2));
  console.log(
    `[keep-alive] Target=${config.apiUrl} interval=${config.intervalSeconds}s once=${config.once} syncIfKey=${config.syncIfKey}`,
  );

  let lastGrantsSyncAt = 0;
  const ok = await pingTarget(config);
  if (ok) {
    lastGrantsSyncAt = await maybeTriggerGrantsRefresh(config, lastGrantsSyncAt);
  }

  if (config.once) {
    process.exit(ok ? 0 : 1);
  }

  while (true) {
    await sleep(config.intervalSeconds * 1000);
    const cycleOk = await pingTarget(config);
    if (cycleOk) {
      lastGrantsSyncAt = await maybeTriggerGrantsRefresh(config, lastGrantsSyncAt);
    }
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error('[keep-alive] Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
