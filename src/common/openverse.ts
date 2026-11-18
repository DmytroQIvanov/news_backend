import { normalizeImageUrl, stripTags } from '../news/image-extraction';
import { readEnv } from './r2-storage';
import { cachedPhotoSearch } from './photo-search-cache';
import type { PhotoSearchOptions, StockPhoto } from './stock-photos';

export async function searchOpenversePhotos(rawQuery: string, options: PhotoSearchOptions = {}): Promise<StockPhoto[]> {
  const query = rawQuery.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (readEnv('openverse_enabled') === 'false' || query.length < 2) return [];
  return cachedPhotoSearch(`openverse:landscape:${query.toLowerCase()}`, options.db, async () => {
    // Explicit allowlist excludes noncommercial, no-derivatives and share-alike restrictions.
    const params = new URLSearchParams({ q: query, page_size: '10', license: 'by,cc0,pdm',
      category: 'photograph', aspect_ratio: 'wide', size: 'large', mature: 'false', filter_dead: 'true' });
    const token = readEnv('openverse_access_token');
    const response = await (options.fetchFn ?? fetch)(`https://api.openverse.org/v1/images/?${params}`, {
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Openverse search HTTP ${response.status}`);
    }
    const data = await response.json() as { results?: Array<{
      id: string; url: string; thumbnail: string; foreign_landing_url: string; creator: string;
      creator_url: string; title: string; width: number; height: number; license: string;
      license_version: string; license_url: string; mature: boolean; category: string; tags?: Array<{ name: string }>;
    }> };
    const photos: StockPhoto[] = [];
    for (const p of Array.isArray(data.results) ? data.results : []) {
      const url = normalizeImageUrl(p.url);
      const page = normalizeImageUrl(p.foreign_landing_url);
      const licenseUrl = normalizeImageUrl(p.license_url);
      const license = String(p.license || '').toLowerCase();
      const cc = licenseUrl ? new URL(licenseUrl) : null;
      const expectedPath = license === 'by' ? `/licenses/by/${p.license_version}/` :
        license === 'cc0' ? '/publicdomain/zero/1.0/' : '/publicdomain/mark/1.0/';
      if (!url || !page || !p.id || p.mature || (p.category && p.category !== 'photograph') ||
        !['by', 'cc0', 'pdm'].includes(license) || cc?.hostname !== 'creativecommons.org' || cc.pathname !== expectedPath ||
        !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width < 1000 || p.height <= 0) continue;
      const author = stripTags(String(p.creator || 'Unknown creator')).slice(0, 80);
      const title = stripTags(String(p.title || '')).slice(0, 140);
      const label = license === 'by' ? `CC BY ${p.license_version}` : license === 'cc0' ? 'CC0 1.0' : 'Public Domain';
      photos.push({ id: String(p.id), provider: 'openverse', url, thumbUrl: normalizeImageUrl(p.thumbnail) || url,
        photoPageUrl: page, photographer: author, photographerUrl: normalizeImageUrl(p.creator_url) || page,
        alt: `${title} ${(p.tags ?? []).map((t) => t.name).join(' ')}`.slice(0, 500),
        width: p.width, height: p.height, avgColor: null, credit: `${title ? `${title} — ` : ''}${author} / Openverse, ${label}`,
        license: label, licenseUrl: licenseUrl!,
      });
    }
    return photos;
  }).catch(() => []);
}
