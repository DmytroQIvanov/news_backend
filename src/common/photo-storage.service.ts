import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { fetchPublicUrl, getHonestUserAgent } from './source-compliance';
import { R2Storage } from './r2-storage';

export interface StoredPhotoMetadata {
  objectKey?: string;
  originalUrl?: string;
  storedAt?: string;
  expiresAt?: string;
  license?: string;
  licenseUrl?: string;
}
interface LicensedPhoto extends StoredPhotoMetadata {
  url: string;
  credit: string;
  sourceUrl?: string;
  photoPageUrl?: string;
  link?: string;
}
interface StoredRow { object_key: string; original_url: string; created_at: Date | string; expires_at: Date | string }
const MAX_BYTES = 8 * 1024 * 1024;

/** Check actual file signatures: never serve an HTML/SVG payload under an image content type. */
export function photoFileType(body: Buffer): { contentType: string; extension: string } | null {
  if (body.length < 16) return null;
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { contentType: 'image/png', extension: 'png' };
  if (body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return { contentType: 'image/webp', extension: 'webp' };
  if (body.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(body.toString('ascii', 8, 32))) return { contentType: 'image/avif', extension: 'avif' };
  return null;
}

export async function downloadPhoto(url: string, options: { fetchFn?: typeof fetch; lookupFn?: (hostname: string) => Promise<Array<{ address: string }>> } = {}) {
  const response = await fetchPublicUrl(url, {
    ...options, headers: { Accept: 'image/jpeg,image/png,image/webp,image/avif', 'User-Agent': getHonestUserAgent() }, timeoutMs: 12_000,
  });
  if (!response?.ok || !response.body || !/^image\/(jpeg|png|webp|avif)(;|$)/i.test(response.headers.get('content-type') || '') ||
    Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response?.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) return null;
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const body = Buffer.concat(chunks);
  const type = photoFileType(body);
  return type && body.length >= 1000 ? { body, ...type } : null;
}

@Injectable()
export class PhotoStorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PhotoStorageService.name);
  private readonly storage = new R2Storage();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly pending = new Map<string, Promise<StoredRow | null>>();

  constructor(@Optional() private readonly db?: DatabaseService) {}

  get configured(): boolean { return Boolean(this.db && this.storage.configured); }

  onModuleInit(): void {
    if (!this.db || process.env.NODE_ENV === 'test') return;
    const loop = (delay: number) => {
      this.timer = setTimeout(async () => {
        try { await this.prune(); }
        catch (error) { this.logger.warn(`Photo cleanup failed: ${error instanceof Error ? error.message : error}`); }
        finally { if (!this.stopped) loop(60 * 60_000); }
      }, delay);
      this.timer.unref();
    };
    loop(30_000);
  }

  onModuleDestroy(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  async persist<T extends LicensedPhoto>(photo: T): Promise<(T & StoredPhotoMetadata) | null> {
    if (photo.objectKey) return photo.expiresAt && new Date(photo.expiresAt).getTime() > Date.now() ? photo : null;
    if (!this.configured || !photo.license) return null;
    const identity = createHash('sha256').update(photo.photoPageUrl || photo.sourceUrl || photo.link || photo.url).digest('hex');
    let work = this.pending.get(identity);
    if (!work) {
      work = this.store(identity, photo);
      this.pending.set(identity, work);
    }
    let row: StoredRow | null;
    try { row = await work; } finally { this.pending.delete(identity); }
    if (!row) return null;
    return { ...photo, url: this.storage.publicUrl(row.object_key), originalUrl: row.original_url,
      objectKey: row.object_key, storedAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
  }

  private async store(identity: string, photo: LicensedPhoto): Promise<StoredRow | null> {
    const { rows } = await this.db!.query<StoredRow>(
      `SELECT object_key, original_url, created_at, expires_at FROM stored_photos
       WHERE source_identity = $1 AND ready AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`, [identity],
    );
    if (rows[0]) return rows[0];
    const image = await downloadPhoto(photo.url).catch(() => null);
    if (!image) return null;
    const key = `photos/${identity.slice(0, 24)}-${randomUUID()}.${image.extension}`;
    // Register BEFORE uploading: even a crash or failed PUT leaves a tracked object for cleanup.
    const inserted = await this.db!.query<StoredRow>(
      `INSERT INTO stored_photos (object_key, source_identity, original_url, credit, license, license_url, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING object_key, original_url, created_at, expires_at`,
      [key, identity, photo.url, photo.credit, photo.license, photo.licenseUrl || null, image.contentType, image.body.length],
    );
    try {
      await this.storage.putObject(key, image.body, image.contentType, 'public, max-age=86400');
      await this.db!.query(`UPDATE stored_photos SET ready = true WHERE object_key = $1`, [key]);
      return inserted.rows[0];
    } catch {
      this.logger.warn('Licensed photo could not be saved to R2; trying another candidate');
      return null;
    }
  }

  async readMedia(key: string) {
    if (!this.configured || !/^photos\/[a-f0-9]{24}-[a-f0-9-]{36}\.(jpg|png|webp|avif)$/.test(key)) return null;
    const { rows } = await this.db!.query<{ expires_at: Date }>(
      `SELECT expires_at FROM stored_photos WHERE object_key = $1 AND ready AND expires_at > now()`, [key],
    );
    if (!rows[0]) return null;
    const object = await this.storage.getObject(key);
    return object ? { ...object, maxAge: Math.max(0, Math.min(86400, Math.floor((new Date(rows[0].expires_at).getTime() - Date.now()) / 1000))) } : null;
  }

  async prune(): Promise<number> {
    if (!this.db) return 0;
    await this.db.query(`DELETE FROM photo_search_cache WHERE created_at < now() - interval '24 hours'`);
    if (!this.storage.configured) return 0;
    const { rows } = await this.db.query<{ object_key: string }>(
      `SELECT object_key FROM stored_photos WHERE expires_at <= now() OR (NOT ready AND created_at < now() - interval '1 day')
       ORDER BY expires_at LIMIT 500`,
    );
    let deleted = 0;
    for (const { object_key: key } of rows) {
      if (!key.startsWith('photos/')) continue;
      try {
        await this.storage.deleteObject(key);
        await this.db.query(`DELETE FROM stored_photos WHERE object_key = $1`, [key]);
        deleted += 1;
      } catch { this.logger.warn('R2 photo deletion failed; will retry on the next cleanup'); }
    }
    return deleted;
  }
}
