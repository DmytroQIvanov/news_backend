import type { DatabaseService } from '../database/database.service';
import { pickBestPexelsPhoto, searchPexelsPhotos, type PexelsPhotoCandidate } from './pexels';
import { searchPixabayPhotos } from './pixabay';
import { searchOpenversePhotos } from './openverse';
import type { StoredPhotoMetadata } from './photo-storage.service';

export type PhotoProvider = 'pixabay' | 'openverse' | 'pexels';
export interface StockPhoto extends Omit<PexelsPhotoCandidate, 'id'>, StoredPhotoMetadata {
  id: string;
  provider: PhotoProvider;
  credit: string;
  license: string;
  licenseUrl: string;
}
export interface PhotoSearchOptions {
  fetchFn?: typeof fetch;
  db?: DatabaseService;
}

/** Same aesthetic scoring across providers; provider-specific attribution is preserved. */
export function rankStockPhotos(photos: StockPhoto[], options: {
  query: string; usedUrls?: Set<string>; preferDark?: boolean; allowClutterFallback?: boolean;
  mustMatchTerms?: string[];
}): StockPhoto[] {
  const terms = [...new Set((options.mustMatchTerms ?? []).map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3))];
  const ranked: Array<{ photo: StockPhoto; score: number }> = [];
  for (const photo of photos) {
    const words = photo.alt.toLowerCase().split(/[^\p{L}\p{N}-]+/u).join(' ');
    if (terms.length && terms.filter((t) => ` ${words} `.includes(` ${t} `)).length < Math.min(2, terms.length)) continue;
    const selected = pickBestPexelsPhoto([{ ...photo, id: 1 }], options);
    if (selected) ranked.push({ photo, score: selected.score });
  }
  return ranked.sort((a, b) => b.score - a.score).map((r) => r.photo);
}

/** Persist each selection before publishing it. A failed download/upload tries another provider. */
export async function pickStockPhoto(query: string, options: Parameters<typeof rankStockPhotos>[1] & PhotoSearchOptions & {
  providers?: PhotoProvider[];
  accept: (photo: StockPhoto) => Promise<StockPhoto | null>;
}): Promise<StockPhoto | null> {
  for (const provider of options.providers ?? ['pixabay', 'openverse', 'pexels']) {
    let photos: StockPhoto[] = [];
    try {
      if (provider === 'pixabay') photos = await searchPixabayPhotos(query, options);
      else if (provider === 'openverse') photos = await searchOpenversePhotos(query, options);
      else photos = (await searchPexelsPhotos(query, { fetchFn: options.fetchFn })).map((p) => ({
        ...p, id: String(p.id), provider, credit: `${p.photographer} / Pexels`,
        license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/',
      }));
      for (const photo of rankStockPhotos(photos, options).slice(0, 2)) {
        const accepted = await options.accept(photo).catch(() => null);
        if (accepted) return accepted;
      }
    } catch { /* Provider outages must not stop article enrichment. */ }
  }
  return null;
}
