import type { DatabaseService } from '../database/database.service';
import type { StockPhoto } from './stock-photos';

const TTL = 24 * 60 * 60_000;
const memory = new Map<string, { at: number; photos: StockPhoto[] }>();
const pending = new Map<string, Promise<StockPhoto[]>>();

/** Pixabay requires 24-hour result caching; Postgres also survives restarts and deploys. */
export async function cachedPhotoSearch(key: string, db: DatabaseService | undefined, search: () => Promise<StockPhoto[]>): Promise<StockPhoto[]> {
  const cached = memory.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.photos;
  const active = pending.get(key);
  if (active) return active;
  const work = (async () => {
    if (db) {
      const { rows } = await db.query<{ photos: StockPhoto[]; created_at: Date }>(
        `SELECT photos, created_at FROM photo_search_cache WHERE cache_key = $1 AND created_at > now() - interval '24 hours'`, [key],
      );
      if (rows[0]) {
        memory.set(key, { at: new Date(rows[0].created_at).getTime(), photos: rows[0].photos });
        return rows[0].photos;
      }
    }
    const photos = await search();
    if (db) await db.query(
      `INSERT INTO photo_search_cache (cache_key, photos) VALUES ($1, $2::jsonb)
       ON CONFLICT (cache_key) DO UPDATE SET photos = EXCLUDED.photos, created_at = now()`, [key, JSON.stringify(photos)],
    );
    if (memory.size >= 250) memory.delete(memory.keys().next().value!);
    memory.set(key, { at: Date.now(), photos });
    return photos;
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}
