import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal S3-compatible client for Cloudflare R2 (AWS Signature V4, path-style).
 * No SDK dependency: R2 only needs PUT/GET/HEAD/DELETE on single objects here.
 *
 * Environment (lowercase names as configured in Render; uppercase variants also accepted):
 *   cloudflare_s3_api_endpoint   https://<account_id>.r2.cloudflarestorage.com[/<bucket>]
 *   cloudflare_access_key_id
 *   cloudflare_secret_access_key
 *   cloudflare_r2_bucket         optional, defaults to the bucket in the endpoint path or "news-radar"
 *   cloudflare_r2_public_base_url optional public (r2.dev / custom domain) URL; otherwise media is proxied by the API
 */
export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string | null;
}

export function readEnv(name: string): string {
  return (process.env[name] ?? process.env[name.toUpperCase()] ?? '').trim();
}

export function getR2Config(): R2Config | null {
  const rawEndpoint = readEnv('cloudflare_s3_api_endpoint');
  const accessKeyId = readEnv('cloudflare_access_key_id');
  const secretAccessKey = readEnv('cloudflare_secret_access_key');
  if (!rawEndpoint || !accessKeyId || !secretAccessKey) return null;

  const parsed = URL.parse(rawEndpoint.startsWith('http') ? rawEndpoint : `https://${rawEndpoint}`);
  if (!parsed || parsed.protocol !== 'https:') return null;
  const pathBucket = parsed.pathname.split('/').filter(Boolean)[0] || '';
  const bucket = readEnv('cloudflare_r2_bucket') || pathBucket || 'news-radar';
  const publicBase = readEnv('cloudflare_r2_public_base_url').replace(/\/+$/, '');

  return {
    endpoint: `${parsed.protocol}//${parsed.host}`,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: publicBase && publicBase.startsWith('https://') ? publicBase : null,
  };
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function isSafeObjectKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9/_.-]{0,200}$/i.test(key) && !key.includes('..') && !key.includes('//');
}

export function signR2Request(params: {
  config: R2Config;
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  key: string;
  payloadHash: string;
  extraHeaders?: Record<string, string>;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  const { config, method, key, payloadHash } = params;
  const now = params.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto';
  const service = 's3';
  const host = new URL(config.endpoint).host;
  const canonicalUri = `/${encodeRfc3986(config.bucket)}/${key.split('/').map(encodeRfc3986).join('/')}`;

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  for (const [k, v] of Object.entries(params.extraHeaders ?? {})) {
    headers[k.toLowerCase()] = v.trim();
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const { host: _host, ...sendHeaders } = headers;
  return {
    url: `${config.endpoint}${canonicalUri}`,
    headers: {
      ...sendHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export class R2Storage {
  constructor(private readonly config: R2Config | null = getR2Config()) {}

  get configured(): boolean {
    return Boolean(this.config);
  }

  /** Public URL for a stored object: custom/r2.dev domain when configured, otherwise the API media proxy path. */
  publicUrl(key: string, apiBase = ''): string {
    if (this.config?.publicBaseUrl) return `${this.config.publicBaseUrl}/${key}`;
    return `${apiBase}/api/v1/media/${key}`;
  }

  async putObject(key: string, body: Buffer, contentType: string, cacheControl = 'public, max-age=31536000, immutable'): Promise<void> {
    if (!this.config) throw new Error('R2 storage is not configured');
    if (!isSafeObjectKey(key)) throw new Error('Unsafe object key');
    const signed = signR2Request({
      config: this.config,
      method: 'PUT',
      key,
      payloadHash: sha256Hex(body),
      extraHeaders: { 'content-type': contentType, 'cache-control': cacheControl },
    });
    const resp = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`R2 PUT ${resp.status}: ${text}`);
    }
    await resp.body?.cancel().catch(() => undefined);
  }

  async getObject(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    if (!this.config || !isSafeObjectKey(key)) return null;
    const signed = signR2Request({ config: this.config, method: 'GET', key, payloadHash: sha256Hex('') });
    const resp = await fetch(signed.url, { headers: signed.headers, signal: AbortSignal.timeout(20_000) });
    if (resp.status === 404) {
      await resp.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      throw new Error(`R2 GET ${resp.status}`);
    }
    return {
      body: Buffer.from(await resp.arrayBuffer()),
      contentType: resp.headers.get('content-type') || 'application/octet-stream',
    };
  }

  async deleteObject(key: string): Promise<void> {
    if (!this.config || !isSafeObjectKey(key)) return;
    const signed = signR2Request({ config: this.config, method: 'DELETE', key, payloadHash: sha256Hex('') });
    const resp = await fetch(signed.url, { method: 'DELETE', headers: signed.headers, signal: AbortSignal.timeout(15_000) });
    await resp.body?.cancel().catch(() => undefined);
  }
}
