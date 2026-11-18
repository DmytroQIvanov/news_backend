import { normalizeImageUrl } from '../news/image-extraction';
import { readEnv } from './r2-storage';
import { cachedPhotoSearch } from './photo-search-cache';
import type { PhotoSearchOptions, StockPhoto } from './stock-photos';

export async function searchPixabayPhotos(rawQuery: string, options: PhotoSearchOptions = {}): Promise<StockPhoto[]> {
  const key = readEnv('pixabay_api_key');
  const query = rawQuery.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!key || query.length < 2) return [];
  return cachedPhotoSearch(`pixabay:landscape:${query.toLowerCase()}`, options.db, async () => {
    const params = new URLSearchParams({ key, q: query, lang: 'en', image_type: 'photo', orientation: 'horizontal',
      safesearch: 'true', min_width: '1000', per_page: '10', order: 'popular' });
    const response = await (options.fetchFn ?? fetch)(`https://pixabay.com/api/?${params}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Pixabay search HTTP ${response.status}`); // Never log URL: contains the key.
    }
    const data = await response.json() as { hits?: Array<{
      id: number; type: string; largeImageURL: string; previewURL: string; pageURL: string;
      imageWidth: number; imageHeight: number; tags: string; user: string; user_id: number;
    }> };
    const photos: StockPhoto[] = [];
    for (const p of Array.isArray(data.hits) ? data.hits : []) {
      const url = normalizeImageUrl(p.largeImageURL);
      const page = normalizeImageUrl(p.pageURL);
      if (!url || !page || p.type !== 'photo' || !Number.isInteger(p.id) || p.id <= 0 ||
        !Number.isFinite(p.imageWidth) || !Number.isFinite(p.imageHeight) || p.imageWidth < 1000 || p.imageHeight <= 0) continue;
      // Only download images/pages from the actual provider, never arbitrary API-supplied hosts.
      if (![new URL(url).hostname, new URL(page).hostname].every((h) => h === 'pixabay.com' || h.endsWith('.pixabay.com'))) continue;
      const author = String(p.user || 'Pixabay').trim().slice(0, 80);
      const scale = Math.min(1, 1280 / Math.max(p.imageWidth, p.imageHeight));
      photos.push({ id: String(p.id), provider: 'pixabay', url, thumbUrl: normalizeImageUrl(p.previewURL) || url,
        photoPageUrl: page, photographer: author, photographerUrl: `https://pixabay.com/users/${encodeURIComponent(author)}-${Number(p.user_id) || 0}/`,
        alt: String(p.tags || '').slice(0, 220), width: Math.round(p.imageWidth * scale), height: Math.round(p.imageHeight * scale), avgColor: null,
        credit: `${author} / Pixabay`, license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/',
      });
    }
    return photos;
  }).catch(() => []);
}
