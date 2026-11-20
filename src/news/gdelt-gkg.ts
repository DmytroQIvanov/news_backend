/**
 * GDELT 2.0 raw files instead of the DOC API.
 *
 * The DOC API (api.gdeltproject.org) answers 429 for most callers most of the time. The raw 15-minute GKG files on
 * data.gdeltproject.org are plain static files: no rate limit, complete, ~4 MB zipped each. Every row has the article URL,
 * the outlet, the locations it mentions (country code "UP" = Ukraine) and the page title (V2EXTRAS <PAGE_TITLE>).
 * Both the English GKG and the translated GKG ("translingual": Ukrainian and other languages) are read.
 */
import { inflateRawSync } from 'node:zlib';

const BASE = 'https://data.gdeltproject.org/gdeltv2';
const MAX_ZIP_BYTES = 16 * 1024 * 1024;
const MAX_CSV_BYTES = 120 * 1024 * 1024;

export interface GkgArticle { url: string; title: string; domain: string; seendate: string; ukraineMentions: number; translated: boolean }

/** Reads the first entry of a ZIP archive (GDELT ships one CSV per zip). Uses the central directory, so data descriptors are fine. */
export function readFirstZipEntry(zip: Buffer): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const cd = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(cd) !== 0x02014b50) throw new Error('corrupt zip directory');
  const method = zip.readUInt16LE(cd + 10);
  const compressed = zip.readUInt32LE(cd + 20);
  const local = zip.readUInt32LE(cd + 42);
  if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip entry');
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + compressed);
  if (method === 0) return Buffer.from(data);
  if (method !== 8) throw new Error(`unsupported zip method ${method}`);
  return inflateRawSync(data, { maxOutputLength: MAX_CSV_BYTES });
}

/** "2026-11-19 11:30:00" style GKG DATE (YYYYMMDDHHMMSS) -> DOC-API style seendate (YYYYMMDDTHHMMSSZ). */
const toSeen = (d: string) => (/^\d{14}$/.test(d) ? `${d.slice(0, 8)}T${d.slice(8)}Z` : '');

/** GKG 2.1 columns: 1 DATE, 3 SourceCommonName, 4 DocumentIdentifier, 9 Locations, 25 TranslationInfo, 26 Extras. */
export function parseGkg(csv: string, translated = false): GkgArticle[] {
  const out: GkgArticle[] = [];
  for (const line of csv.split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    if (c.length < 27) continue;
    const locations = c[9] ?? '';
    const mentions = (locations.match(/(?:^|;)\d#[^#;]*#UP#/g) ?? []).length;
    const domain = (c[3] ?? '').toLowerCase().replace(/^www\./, '');
    if (mentions === 0 && !domain.endsWith('.ua')) continue;
    const title = /<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/.exec(c[26] ?? '')?.[1]?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
    const url = (c[4] ?? '').trim();
    if (!title || title.length < 15 || !/^https?:\/\//.test(url)) continue;
    out.push({ url: url.replace(/^http:\/\//, 'https://'), title: title.slice(0, 300), domain, seendate: toSeen(c[1] ?? ''), ukraineMentions: mentions + (domain.endsWith('.ua') ? 2 : 0), translated });
  }
  return out;
}

async function download(url: string, fetchImpl: typeof fetch, userAgent: string): Promise<Buffer | null> {
  const resp = await fetchImpl(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(45_000) });
  if (resp.status === 404) { await resp.body?.cancel().catch(() => undefined); return null; }
  if (!resp.ok) { await resp.body?.cancel().catch(() => undefined); throw new Error(`GDELT files HTTP ${resp.status}`); }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw new Error('GDELT file exceeds the size limit');
  return buf;
}

const seenSlots = new Set<string>();
let cached: { at: number; items: GkgArticle[] } | null = null;

/** Slot timestamps (YYYYMMDDHHMMSS) from the newest published file back `count` 15-minute steps. */
export function slotsBack(newest: string, count: number): string[] {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(newest);
  if (!m) return [];
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return Array.from({ length: count }, (_, i) => new Date(t - i * 15 * 60_000).toISOString().replace(/\D/g, '').slice(0, 14));
}

/**
 * New Ukraine-related articles from the latest GKG files (English + translated). Each 15-minute slot is read once;
 * results of earlier calls inside the last 3 hours are kept so a 30-minute poll never loses a slot.
 */
export async function loadGdeltGkg(opts: { fetchFn?: typeof fetch; userAgent: string; now?: number; slots?: number }): Promise<GkgArticle[]> {
  const fetchImpl = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now();
  const fresh: GkgArticle[] = [];
  for (const [list, suffix, translated] of [['lastupdate.txt', 'gkg.csv.zip', false], ['lastupdate-translation.txt', 'translation.gkg.csv.zip', true]] as const) {
    const resp = await fetchImpl(`${BASE}/${list}`, { headers: { 'User-Agent': opts.userAgent }, signal: AbortSignal.timeout(20_000) });
    if (!resp.ok) { await resp.body?.cancel().catch(() => undefined); throw new Error(`GDELT ${list} HTTP ${resp.status}`); }
    const newest = /\/(\d{14})\.(?:translation\.)?gkg\.csv\.zip/.exec(await resp.text())?.[1];
    if (!newest) continue;
    for (const slot of slotsBack(newest, opts.slots ?? 4)) {
      const key = `${translated ? 't' : 'e'}${slot}`;
      if (seenSlots.has(key)) continue;
      const zip = await download(`${BASE}/${slot}.${suffix}`, fetchImpl, opts.userAgent);
      if (!zip) continue;
      fresh.push(...parseGkg(readFirstZipEntry(zip).toString('utf8'), translated));
      seenSlots.add(key);
    }
  }
  if (seenSlots.size > 200) [...seenSlots].slice(0, 100).forEach((k) => seenSlots.delete(k));
  const keep = (cached?.items ?? []).filter((a) => now - Date.parse(a.seendate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) < 3 * 3600_000);
  const byUrl = new Map<string, GkgArticle>();
  for (const a of [...keep, ...fresh]) byUrl.set(a.url, a);
  cached = { at: now, items: [...byUrl.values()] };
  return cached.items;
}

export function resetGdeltGkgForTests() { seenSlots.clear(); cached = null; }

/** DOC-API shaped rows for parseGdeltArticles, best first: Ukraine-heavy, Ukrainian outlets, newest. */
export function toDocRows(items: GkgArticle[]): Array<Record<string, string>> {
  return [...items]
    .sort((a, b) => b.ukraineMentions - a.ukraineMentions || b.seendate.localeCompare(a.seendate))
    .slice(0, 400)
    .map((a) => ({ url: a.url, title: a.title, domain: a.domain, seendate: a.seendate, language: a.translated ? 'translated' : 'english', sourcecountry: '' }));
}
