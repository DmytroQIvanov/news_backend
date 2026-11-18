/**
 * Scripted (no-LLM) news search used by the corroboration service. It costs no AI quota:
 *   - Bing News RSS (free, any language, real publisher URL inside the redirect link);
 *   - GDELT DOC API (free, throttled to one request per 6 s, optional);
 * Candidates are scored against the event with plain token/entity overlap, filtered by date window, domain
 * blocklist and listing-page patterns. Only the survivors are fetched by the collector and judged by a model.
 */

export interface SearchHit {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  provider: 'bing' | 'bing-web' | 'gdelt';
  snippet?: string;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has', 'was', 'were', 'will', 'after', 'about', 'into',
  'over', 'says', 'said', 'new', 'що', 'як', 'для', 'при', 'про', 'але', 'його', 'вона', 'вони', 'після', 'через',
  'это', 'как', 'что', 'для', 'при', 'после',
]);

export function tokens(text: string): string[] {
  return (text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOP.has(t));
}

/** Share of the smaller token set that also occurs in the other (0..1). */
export function titleOverlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.min(ta.size, tb.size);
}

/** Number of distinct tokens two titles share (a 1-word match is never enough). */
export function sharedTokens(a: string, b: string): number {
  const tb = new Set(tokens(b));
  let n = 0;
  for (const t of new Set(tokens(a))) if (tb.has(t)) n += 1;
  return n;
}

/** Fraction of the entity names that appear (case-insensitive) in the text. */
export function entityHitRatio(entities: string[], text: string): number {
  const names = entities.map((e) => e.trim().toLowerCase()).filter((e) => e.length >= 3);
  if (!names.length) return 1;
  const hay = text.toLowerCase();
  return names.filter((n) => hay.includes(n)).length / names.length;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .trim();
}

function tag(item: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>(.*?)</${name}>`, 's').exec(item);
  return m ? decodeXml(m[1]) : '';
}

/** Bing wraps the publisher link: apiclick.aspx?...&url=<encoded publisher url>&... */
export function bingTargetUrl(link: string): string | null {
  try {
    const u = new URL(decodeXml(link));
    const real = u.searchParams.get('url');
    if (real && /^https?:\/\//i.test(real)) return real;
    return u.hostname.endsWith('bing.com') ? null : u.toString();
  } catch {
    return null;
  }
}

export function parseBingRss(xml: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const m of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
    const item = m[1];
    const url = bingTargetUrl(tag(item, 'link'));
    const title = tag(item, 'title');
    if (!url || !title) continue;
    const date = tag(item, 'pubDate');
    const ts = date ? Date.parse(date) : NaN;
    out.push({
      title, url, source: tag(item, 'News:Source'), publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
      provider: 'bing', snippet: tag(item, 'description').slice(0, 300),
    });
  }
  return out;
}

export async function bingNewsSearch(query: string, lang = 'en'): Promise<SearchHit[]> {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=${encodeURIComponent(lang)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsRadarBot/1.0)' }, signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`Bing News HTTP ${resp.status}`);
  return parseBingRss(await resp.text());
}

/**
 * Ordinary web search (Bing RSS). It finds primary material (press releases, official statements, documents) that news
 * search misses, but it is noisy, so filterHits applies a stricter overlap and drops home/section pages for it.
 */
export async function bingWebSearch(query: string, lang = 'en'): Promise<SearchHit[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=${encodeURIComponent(lang)}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsRadarBot/1.0)' }, signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`Bing web HTTP ${resp.status}`);
  return parseBingRss(await resp.text()).map((h) => ({ ...h, provider: 'bing-web' as const }));
}

const WEB_BLOCKED = /(^|\.)(wikipedia|wikimedia|britannica|wikihow|quora|stackexchange|stackoverflow|investopedia)\./i;

let gdeltQueue: Promise<unknown> = Promise.resolve();
export function gdeltSearch(query: string): Promise<SearchHit[]> {
  // one request at a time, at least 6 s apart (+ jitter), shared by every caller in this process
  const run = gdeltQueue.then(async () => {
    await new Promise((r) => setTimeout(r, 6_000 + Math.random() * 1_500));
    return gdeltSearchNow(query);
  });
  gdeltQueue = run.catch(() => undefined);
  return run;
}

async function gdeltSearchNow(query: string): Promise<SearchHit[]> {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=15&timespan=2d&sort=hybridrel`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  const text = await resp.text();
  if (!resp.ok || !text.startsWith('{')) return []; // rate-limit notice or outage: just no results
  const data = JSON.parse(text) as { articles?: Array<{ url: string; title: string; domain: string; seendate: string }> };
  return (data.articles ?? []).map((a): SearchHit => {
    const d = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate ?? '');
    return {
      title: a.title, url: a.url, source: a.domain, provider: 'gdelt',
      publishedAt: d ? `${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}Z` : null,
    };
  });
}

/** Queries for an event: its title, and a keyword query from the strongest entities (different wording finds other outlets). */
export function buildQueries(title: string, entities: string[]): string[] {
  const clean = title.replace(/["“”«»]/g, '').replace(/(^|\s)'|'(\s|$)/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  const ent = entities.map((e) => e.trim()).filter((e) => e.length >= 3).slice(0, 3);
  const keyTokens = tokens(clean).filter((t) => t.length >= 5).slice(0, 3);
  const queries = [clean];
  if (ent.length >= 2) queries.push(`${ent.join(' ')} ${keyTokens.slice(0, 2).join(' ')}`.trim());
  return [...new Set(queries.filter((q) => q.length >= 8))];
}

export interface FilterContext {
  eventTitle: string;
  /** Titles of the event's own documents: natural headlines match other outlets better than the synthetic event title. */
  altTitles?: string[];
  entities: string[];
  startedAt: string | null;
  knownRoots: Set<string>;
  blockedRoots: Set<string>;
  rootOf: (url: string) => string;
  minOverlap?: number;
}

const LISTING = /\/(tag|tags|category|topic|topics|search|feed|author|archive|live|video|videos|podcasts?)\b|[?&](s|q|query)=/i;

/** Script-level gate: date window, domain, listing pages and title/entity overlap. Returns scored survivors, best first. */
export function filterHits(hits: SearchHit[], ctx: FilterContext): Array<SearchHit & { score: number }> {
  const minOverlap = ctx.minOverlap ?? 0.34;
  const start = ctx.startedAt ? Date.parse(ctx.startedAt) : NaN;
  const scored: Array<SearchHit & { score: number; root: string }> = [];
  for (const h of hits) {
    if (!/^https:\/\//i.test(h.url) || LISTING.test(h.url)) continue;
    const root = ctx.rootOf(h.url);
    if (!root || ctx.blockedRoots.has(root) || ctx.knownRoots.has(root)) continue;
    const web = h.provider === 'bing-web';
    if (web) {
      let depth = 0;
      try { depth = new URL(h.url).pathname.split('/').filter(Boolean).length; } catch { continue; }
      if (depth < 2 || WEB_BLOCKED.test(new URL(h.url).hostname)) continue; // home/section pages are not reports
    }
    if (h.publishedAt && Number.isFinite(start)) {
      const t = Date.parse(h.publishedAt);
      if (t < start - 36 * 3_600_000 || t > Date.now() + 3_600_000) continue;
    }
    const titles = [ctx.eventTitle, ...(ctx.altTitles ?? [])];
    const overlap = Math.max(...titles.map((t) => titleOverlap(t, h.title)));
    const shared = Math.max(...titles.map((t) => sharedTokens(t, h.title)));
    const entHit = entityHitRatio(ctx.entities.slice(0, 4), `${h.title} ${h.snippet ?? ''}`);
    if (overlap < (web ? Math.max(minOverlap, 0.5) : minOverlap) || shared < 2) continue;
    // dated hits are preferred over undated ones
    scored.push({ ...h, root, score: overlap * 0.7 + entHit * 0.3 + (h.publishedAt ? 0.05 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  // best hit first, then keep only one page per outlet and per URL
  const seenUrls = new Set<string>();
  const seenRoots = new Set<string>();
  const out: Array<SearchHit & { score: number }> = [];
  for (const h of scored) {
    const key = h.url.split('#')[0].replace(/\/+$/, '');
    if (seenUrls.has(key) || seenRoots.has(h.root)) continue;
    seenUrls.add(key);
    seenRoots.add(h.root);
    out.push(h);
  }
  return out;
}
