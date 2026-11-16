import { slugifyToolName } from './taxonomy';

export interface ArenaEntry {
  slug: string;
  name: string;
  vendor: string | null;
  license: string | null;
  isOpen: boolean;
  rating: number | null;
  votes: number | null;
  rank: number;
  publishDate: string | null;
}

/** Maps a datasets-server /filter response (LMArena leaderboard rows) to ranked entries, de-duplicated by slug. */
export function mapArenaRows(json: unknown): ArenaEntry[] {
  const rows = (json as { rows?: { row?: Record<string, unknown> }[] })?.rows;
  if (!Array.isArray(rows)) return [];
  const out: ArenaEntry[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const row = r?.row;
    const name = typeof row?.model_name === 'string' ? row.model_name.trim().slice(0, 200) : '';
    const slug = slugifyToolName(name);
    if (!name || !slug || seen.has(slug)) continue;
    seen.add(slug);
    const license = typeof row?.license === 'string' ? row.license.slice(0, 120) : null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    out.push({
      slug,
      name,
      vendor: typeof row?.organization === 'string' && row.organization ? row.organization.slice(0, 160) : null,
      license,
      isOpen: Boolean(license && !/proprietary/i.test(license)),
      rating: num(row?.rating),
      votes: num(row?.vote_count) === null ? null : Math.round(num(row?.vote_count)!),
      rank: out.length + 1,
      publishDate: typeof row?.leaderboard_publish_date === 'string' ? row.leaderboard_publish_date.slice(0, 10) : null,
    });
  }
  return out;
}

export interface DiscoveredTool {
  newsId: string;
  slug: string;
  name: string;
  vendor: string | null;
  subcategory: string;
  url: string | null;
  hasFree: boolean | null;
  isOpen: boolean;
  descriptionUk: string | null;
  descriptionEn: string | null;
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** Validates the LLM's list of AI tools found in news; drops anything outside the allowed subcategories/news ids. */
export function validateDiscoveredTools(raw: unknown, allowedSubcategories: Set<string>, newsIds: Set<string>): DiscoveredTool[] {
  const list = (raw as { tools?: unknown[] })?.tools;
  if (!Array.isArray(list)) return [];
  const out: DiscoveredTool[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, 60)) {
    const t = item as Record<string, unknown>;
    const name = clean(t?.name, 120);
    const subcategory = clean(t?.subcategory, 64);
    const newsId = t?.newsId === undefined || t?.newsId === null ? null : String(t.newsId);
    if (!name || name.length < 2 || !subcategory || !allowedSubcategories.has(subcategory) || !newsId || !newsIds.has(newsId)) continue;
    const slug = slugifyToolName(name);
    if (!slug || seen.has(`${slug}|${subcategory}`)) continue;
    seen.add(`${slug}|${subcategory}`);
    const url = clean(t?.url, 300);
    out.push({
      newsId,
      slug,
      name,
      vendor: clean(t?.vendor, 160),
      subcategory,
      url: url && /^https:\/\/[^\s/]+\.[^\s]+/i.test(url) ? url : null,
      hasFree: typeof t?.hasFree === 'boolean' ? t.hasFree : null,
      isOpen: t?.isOpenSource === true,
      descriptionUk: clean(t?.descriptionUk, 300),
      descriptionEn: clean(t?.descriptionEn, 300),
    });
  }
  return out;
}

/** Positive = moved up the ranking since the previous snapshot. */
export function rankMovement(rank: number, previousRank: number | null | undefined): number | null {
  return typeof previousRank === 'number' ? previousRank - rank : null;
}
