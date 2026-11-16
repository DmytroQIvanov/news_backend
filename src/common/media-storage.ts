import type { DatabaseService } from '../database/database.service';
import { isSafeObjectKey, R2Storage } from './r2-storage';

/**
 * Object storage with a Postgres fallback.
 *  - Cloudflare R2 when configured (cheapest egress, best for audio and images).
 *  - Otherwise, or when R2 rejects an upload (missing bucket, bad token…), the bytes go into `media_blobs`
 *    under a `db-` prefixed file name, so the feature keeps working on the free tier with zero extra setup.
 * `putObject` returns the key that was actually used; store *that* key.
 */
export class MediaStorage {
  private readonly r2: R2Storage;

  constructor(private readonly db?: DatabaseService, r2: R2Storage = new R2Storage()) {
    this.r2 = r2;
  }

  get r2Configured(): boolean {
    return this.r2.configured;
  }

  get configured(): boolean {
    return this.r2.configured || Boolean(this.db);
  }

  get backend(): 'r2' | 'postgres' | 'none' {
    return this.r2.configured ? 'r2' : this.db ? 'postgres' : 'none';
  }

  static dbKey(key: string): string {
    const slash = key.lastIndexOf('/');
    const dir = slash >= 0 ? key.slice(0, slash + 1) : '';
    const file = slash >= 0 ? key.slice(slash + 1) : key;
    return file.startsWith('db-') ? key : `${dir}db-${file}`;
  }

  publicUrl(key: string, apiBase = ''): string {
    if (/(^|\/)db-[^/]+$/.test(key)) return `${apiBase}/api/v1/media/${key}`;
    return this.r2.publicUrl(key, apiBase);
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<string> {
    if (this.r2.configured) {
      try {
        await this.r2.putObject(key, body, contentType);
        return key;
      } catch (err) {
        if (!this.db) throw err;
      }
    }
    if (!this.db) throw new Error('No media storage configured');
    const dbKey = MediaStorage.dbKey(key);
    if (!isSafeObjectKey(dbKey)) throw new Error('Unsafe object key');
    await this.db.query(
      `INSERT INTO media_blobs (object_key, content_type, data, size_bytes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (object_key) DO NOTHING`,
      [dbKey, contentType, body, body.length],
    );
    return dbKey;
  }

  async getObject(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    if (!isSafeObjectKey(key)) return null;
    const isDbKey = /(^|\/)db-[^/]+$/.test(key);
    if (this.r2.configured && !isDbKey) {
      const obj = await this.r2.getObject(key).catch(() => null);
      if (obj) return obj;
    }
    if (!this.db) return null;
    const { rows } = await this.db.query<{ data: Buffer; content_type: string }>(
      `SELECT data, content_type FROM media_blobs WHERE object_key = $1`,
      [key],
    );
    return rows[0] ? { body: rows[0].data, contentType: rows[0].content_type } : null;
  }

  /** Keeps the Postgres fallback small: oldest blobs go first once the cap is exceeded. */
  async prune(maxBytes = 120 * 1024 * 1024): Promise<void> {
    if (!this.db) return;
    await this.db
      .query(
        `DELETE FROM media_blobs WHERE object_key IN (
           SELECT object_key FROM (
             SELECT object_key, SUM(size_bytes) OVER (ORDER BY created_at DESC) AS running FROM media_blobs
           ) t WHERE running > $1
         )`,
        [maxBytes],
      )
      .catch(() => undefined);
  }
}
