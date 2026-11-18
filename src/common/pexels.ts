import { readEnv } from './r2-storage';

/**
 * Pexels stock photo search with 24-hour query caching, format filtering,
 * anti-clutter alt filtering, and luminance scoring for article hero & ambient backgrounds.
 * Commercial use is allowed; Pexels API terms require crediting photographer + Pexels.
 */

export interface PexelsPhotoCandidate {
  id: number;
  url: string;
  thumbUrl: string;
  photoPageUrl: string;
  photographer: string;
  photographerUrl: string;
  alt: string;
  width: number;
  height: number;
  avgColor: string | null;
}

export interface SelectedPexelsPhoto extends PexelsPhotoCandidate {
  credit: string;
  score: number;
}

interface PexelsApiPhoto {
  id?: number;
  width?: number;
  height?: number;
  url?: string;
  photographer?: string;
  photographer_url?: string;
  avg_color?: string;
  alt?: string;
  src?: {
    original?: string;
    large2x?: string;
    large?: string;
    landscape?: string;
    medium?: string;
  };
}

const CACHE_TTL_MS = 24 * 60 * 60_000;
const queryCache = new Map<string, { at: number; photos: PexelsPhotoCandidate[] }>();

const CLUTTER_ALT_RE =
  /\b(mockup|template|banner|quote|whiteboard|sticky note|newspaper|collage|meme|screenshot|flat lay|smiling woman|smiling man|selfie)\b/i;

export function getPexelsApiKey(): string | null {
  const key = readEnv('pexels_api_key');
  return key || null;
}

export function hexLuminance(hex: string | null | undefined): number | null {
  if (!hex) return null;
  const m = /^#?([a-f0-9]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export async function searchPexelsPhotos(
  rawQuery: string,
  options?: { orientation?: 'landscape' | 'portrait' | 'square'; perPage?: number; fetchFn?: typeof fetch },
): Promise<PexelsPhotoCandidate[]> {
  const key = getPexelsApiKey();
  const query = rawQuery.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!key || query.length < 2) return [];

  const orientation = options?.orientation ?? 'landscape';
  const perPage = Math.min(15, Math.max(3, options?.perPage ?? 10));
  const cacheKey = `${orientation}:${perPage}:${query.toLowerCase()}`;
  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.photos;

  const fetchImpl = options?.fetchFn ?? fetch;
  const params = new URLSearchParams({
    query,
    orientation,
    size: 'large',
    per_page: String(perPage),
  });

  try {
    const resp = await fetchImpl(`https://api.pexels.com/v1/search?${params}`, {
      headers: { Authorization: key, Accept: 'application/json' },
      signal: AbortSignal.timeout(7_000),
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return [];
    }
    const json = (await resp.json()) as { photos?: PexelsApiPhoto[] };
    const photos: PexelsPhotoCandidate[] = [];
    for (const p of json.photos ?? []) {
      const url = p.src?.large2x || p.src?.landscape || p.src?.large;
      const thumbUrl = p.src?.medium || p.src?.large || url;
      const photoPageUrl = p.url;
      if (!p.id || !url || !thumbUrl || !photoPageUrl || !p.width || !p.height) continue;
      if (!url.startsWith('https://') || !photoPageUrl.startsWith('https://')) continue;
      photos.push({
        id: p.id,
        url,
        thumbUrl,
        photoPageUrl,
        photographer: (p.photographer || 'Pexels').trim().slice(0, 80),
        photographerUrl: p.photographer_url || 'https://www.pexels.com',
        alt: (p.alt || '').trim().slice(0, 220),
        width: p.width,
        height: p.height,
        avgColor: p.avg_color || null,
      });
    }
    if (queryCache.size > 250) {
      const oldest = queryCache.keys().next().value;
      if (oldest) queryCache.delete(oldest);
    }
    queryCache.set(cacheKey, { at: Date.now(), photos });
    return photos;
  } catch {
    return [];
  }
}

export function pickBestPexelsPhoto(
  candidates: PexelsPhotoCandidate[],
  options: { query: string; usedUrls?: Set<string>; preferDark?: boolean; allowClutterFallback?: boolean },
): SelectedPexelsPhoto | null {
  const queryTerms = options.query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

  const ranked: SelectedPexelsPhoto[] = [];
  for (const c of candidates) {
    if (options.usedUrls?.has(c.url)) continue;
    if (c.width < 1000) continue;
    const ratio = c.width / c.height;
    if (ratio < 1.2 || ratio > 2.35) continue;
    const isCluttered = CLUTTER_ALT_RE.test(c.alt);
    if (isCluttered && !options.allowClutterFallback) continue;

    let score = 10;
    if (isCluttered) score -= 8;
    const altLower = c.alt.toLowerCase();
    for (const term of queryTerms) {
      if (altLower.includes(term)) score += 3;
    }
    const lum = hexLuminance(c.avgColor);
    if (lum !== null && options.preferDark !== false) {
      if (lum < 95) score += 5;
      else if (lum < 140) score += 2;
      else if (lum > 195) score -= 3;
    }
    if (ratio >= 1.45 && ratio <= 1.85) score += 2;

    ranked.push({
      ...c,
      credit: `${c.photographer} / Pexels`,
      score,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked[0] ?? null;
}
