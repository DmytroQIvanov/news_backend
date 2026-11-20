import { loadGdeltGkg, toDocRows } from './gdelt-gkg';
import { createHash } from 'node:crypto';
import { getHonestUserAgent } from '../common/source-compliance';
import { canonicalizeUrl } from '../common/url-utils';
import type { FeedArticle, FeedDefinition } from './company-feeds.service';

/**
 * Open-data adapters: each turns a free public API into FeedArticle[] so the normal editorial pipeline, clustering,
 * dedup, licensing and health reporting apply unchanged. All endpoints are used as documented by their publishers
 * (no keys, honest User-Agent, size caps, per-adapter minimum polling interval).
 */

export const ADAPTER_MIN_INTERVAL_MS: Record<string, number> = {
  hf_daily_papers: 60 * 60_000,
  ckan_datagov: 30 * 60_000,
  prozorro_tenders: 20 * 60_000,
  openalex_ai: 3 * 60 * 60_000,
  crossref_ai: 6 * 60 * 60_000,
  semantic_scholar_ai: 6 * 60 * 60_000,
  wikipedia_current_events: 60 * 60_000,
  gdelt_ukraine: 30 * 60_000,
  cisa_kev: 2 * 60 * 60_000,
  eurostat_indicators: 12 * 60 * 60_000,
  nbu_rates: 3 * 60 * 60_000,
  worldbank_ukraine: 24 * 60 * 60_000,
};

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const FRESH_WINDOW_MS = 72 * 60 * 60_000;
const firstSeen = new Map<string, number>();

export interface AdapterContext {
  fetchedAt?: number;
  fetchFn?: typeof fetch;
  now?: number;
}

export type AdapterError = Error & { status?: number; retryAfterMs?: number };

function contactParam(): string {
  // Polite-pool identification for OpenAlex/Crossref. Only a project contact set by the operator is ever sent.
  return (process.env.CONTACT_EMAIL || '').trim();
}

export async function fetchJson<T = unknown>(url: string, ctx: AdapterContext = {}, headers: Record<string, string> = {}): Promise<T> {
  const fetchImpl = ctx.fetchFn ?? fetch;
  const resp = await fetchImpl(url, {
    headers: { 'User-Agent': getHonestUserAgent(), Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`) as AdapterError;
    err.status = resp.status;
    const ra = Number(resp.headers.get('retry-after'));
    if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(3_600_000, ra * 1000);
    await resp.body?.cancel().catch(() => undefined);
    throw err;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_JSON_BYTES) throw new Error('API response exceeds the size limit');
  return JSON.parse(buf.toString('utf8')) as T;
}

function allowedDomains(feed: FeedDefinition): string[] {
  return (feed.allowedDomains?.length ? feed.allowedDomains : [feed.domain]).map((d) => d.toLowerCase());
}

function hostAllowed(feed: FeedDefinition, url: string): boolean {
  const allowed = allowedDomains(feed);
  if (allowed.includes('*')) return true;
  const host = URL.parse(url)?.hostname.toLowerCase();
  return Boolean(host && allowed.some((d) => host === d || host.endsWith(`.${d}`)));
}

/**
 * Day-granular sources (papers, datasets, statistics) cannot say *when* something became news. We stamp the moment the
 * adapter first saw it, but only for entries whose own date is recent. Stable across polls within one process.
 */
export function firstSeenIso(key: string, sourceDate: string | number | undefined, now = Date.now()): string | null {
  const src = typeof sourceDate === 'number' ? sourceDate : Date.parse(sourceDate || '');
  if (Number.isFinite(src) && now - src > FRESH_WINDOW_MS) return null;
  const hit = firstSeen.get(key);
  if (hit) return new Date(hit).toISOString();
  if (firstSeen.size > 5000) firstSeen.clear();
  const stamp = Number.isFinite(src) && src > now - 6 * 60 * 60_000 && src <= now ? src : now;
  firstSeen.set(key, stamp);
  return new Date(stamp).toISOString();
}

export function makeAdapterArticle(
  feed: FeedDefinition,
  raw: {
    title: string;
    url: string;
    summary?: string;
    publishedAt: string;
    category?: string;
    imageUrl?: string;
    imageCaption?: string;
    visuals?: unknown[];
  },
): FeedArticle | null {
  const title = raw.title.replace(/\s+/g, ' ').trim().slice(0, 350);
  const parsed = URL.parse(raw.url);
  if (!title || !parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  if (!hostAllowed(feed, parsed.href)) return null;
  parsed.hash = '';
  const url = parsed.href;
  const canonical = canonicalizeUrl(url);
  const summary = (raw.summary || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2500);
  return {
    id: `rss-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`,
    url,
    canonical_url: canonical,
    original_title: title,
    original_summary: summary,
    published_at: new Date(raw.publishedAt).toISOString(),
    source_name: feed.name,
    source_slug: feed.slug,
    category: raw.category || feed.category,
    provider_id: feed.providerId,
    source_is_unofficial: Boolean(feed.unofficial),
    license_mode: feed.licenseMode || 'headline_link',
    ...(raw.imageUrl ? { image_url: raw.imageUrl } : {}),
    ...(raw.imageCaption ? { image_caption: raw.imageCaption } : {}),
    ...(raw.visuals?.length ? { prebuilt_visuals: raw.visuals } : {}),
  };
}

function daysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hugging Face Daily Papers
// ---------------------------------------------------------------------------------------------------------------------
export function parseHfDailyPapers(feed: FeedDefinition, data: unknown, now = Date.now()): FeedArticle[] {
  const rows = Array.isArray(data) ? (data as Array<Record<string, any>>) : [];
  const scored = rows
    .map((r) => ({ paper: r.paper as Record<string, any> | undefined, up: Number(r.paper?.upvotes ?? 0), daily: r.submittedOnDailyAt || r.paper?.submittedOnDailyAt }))
    .filter((r) => r.paper?.id && r.paper?.title)
    .sort((a, b) => b.up - a.up)
    .slice(0, 15);
  const out: FeedArticle[] = [];
  for (const { paper, up, daily } of scored) {
    if (!paper || up < 5) continue;
    const iso = firstSeenIso(`hf:${paper.id}`, daily || paper.publishedAt, now);
    if (!iso) continue;
    const article = makeAdapterArticle(feed, {
      title: String(paper.title),
      url: `https://huggingface.co/papers/${paper.id}`,
      summary: `${clip(String(paper.ai_summary || paper.summary || ''), 900)} (Daily Papers: ${up} upvotes${paper.githubRepo ? `; код: ${paper.githubRepo}` : ''}).`,
      publishedAt: iso,
      category: 'research',
    });
    if (article) out.push(article);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// data.gov.ua (CKAN)
// ---------------------------------------------------------------------------------------------------------------------
export function parseCkanDatasets(feed: FeedDefinition, data: unknown, now = Date.now()): FeedArticle[] {
  const results = ((data as { result?: { results?: Array<Record<string, any>> } })?.result?.results ?? []) as Array<Record<string, any>>;
  const out: FeedArticle[] = [];
  for (const r of results) {
    const created = r.metadata_created as string | undefined;
    if (!r.name || !r.title || !created) continue;
    // Only *new* datasets: CKAN "modified" fires on every daily refresh of the same table.
    const iso = firstSeenIso(`ckan:${r.id || r.name}`, `${created.replace(/\+.*$/, '')}Z`, now);
    if (!iso) continue;
    const title = String(r.title).trim();
    if (title.length < 12) continue;
    const org = r.organization?.title ? `Розпорядник: ${r.organization.title}. ` : '';
    const article = makeAdapterArticle(feed, {
      title: `Відкриті дані: ${title}`,
      url: `https://data.gov.ua/dataset/${encodeURIComponent(String(r.name))}`,
      summary: `${org}${clip(String(r.notes || ''), 700)}`,
      publishedAt: iso,
      category: 'politics',
    });
    if (article) out.push(article);
  }
  return out.slice(0, 12);
}

// ---------------------------------------------------------------------------------------------------------------------
// Prozorro (public procurement)
// ---------------------------------------------------------------------------------------------------------------------
export const PROZORRO_MIN_UAH = 100_000_000;

export function parseProzorroTenders(feed: FeedDefinition, data: unknown, now = Date.now()): FeedArticle[] {
  const rows = ((data as { data?: Array<Record<string, any>> })?.data ?? []) as Array<Record<string, any>>;
  const out: FeedArticle[] = [];
  for (const t of rows) {
    const amount = Number(t.value?.amount);
    if (!t.tenderID || !t.title || !Number.isFinite(amount) || amount < PROZORRO_MIN_UAH || t.value?.currency !== 'UAH') continue;
    const iso = firstSeenIso(`prozorro:${t.tenderID}`, t.dateModified, now);
    if (!iso) continue;
    const mln = amount / 1_000_000;
    const customer = t.procuringEntity?.name ? `Замовник: ${t.procuringEntity.name}. ` : '';
    const article = makeAdapterArticle(feed, {
      title: `Prozorro: тендер на ${mln >= 1000 ? `${(mln / 1000).toFixed(2)} млрд` : `${Math.round(mln)} млн`} грн — ${t.title}`,
      url: `https://prozorro.gov.ua/tender/${encodeURIComponent(String(t.tenderID))}`,
      summary: `${customer}Очікувана вартість: ${Math.round(amount).toLocaleString('uk-UA')} грн${t.value?.valueAddedTaxIncluded ? ' (з ПДВ)' : ''}. Статус: ${t.status || 'невідомо'}.`,
      publishedAt: iso,
      category: 'economy',
    });
    if (article) out.push(article);
  }
  return out.slice(0, 10);
}

async function loadProzorro(feed: FeedDefinition, ctx: AdapterContext): Promise<FeedArticle[]> {
  const fields = 'title,value,procuringEntity,tenderID,status,dateModified';
  let url: string | null = `${feed.url}?descending=1&limit=100&opt_fields=${fields}`;
  const rows: unknown[] = [];
  for (let page = 0; page < 3 && url; page += 1) {
    const json: { data?: unknown[]; next_page?: { uri?: string } } = await fetchJson(url, ctx);
    rows.push(...(json.data ?? []));
    const next: string | undefined = json.next_page?.uri;
    // The API hands back an absolute "next" link; keep opt_fields so the payload stays small.
    url = next && URL.parse(next)?.hostname === 'public-api.prozorro.gov.ua' ? `${next}&opt_fields=${fields}` : null;
  }
  return parseProzorroTenders(feed, { data: rows }, ctx.now);
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAlex / Crossref / Semantic Scholar
// ---------------------------------------------------------------------------------------------------------------------
export function reconstructAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) words[p] = word;
  }
  return words.filter(Boolean).join(' ');
}

export function parseOpenAlexWorks(feed: FeedDefinition, data: unknown, now = Date.now()): FeedArticle[] {
  const results = ((data as { results?: Array<Record<string, any>> })?.results ?? []) as Array<Record<string, any>>;
  const out: FeedArticle[] = [];
  for (const w of results) {
    const doi = typeof w.doi === 'string' ? w.doi : '';
    if (!doi.startsWith('https://doi.org/') || !w.title) continue;
    const iso = firstSeenIso(`openalex:${w.id}`, w.publication_date, now);
    if (!iso) continue;
    const abstract = reconstructAbstract(w.abstract_inverted_index);
    const venue = w.primary_location?.source?.display_name ? ` Видання: ${w.primary_location.source.display_name}.` : '';
    const authors = Array.isArray(w.authorships) ? w.authorships.slice(0, 3).map((a: any) => a.author?.display_name).filter(Boolean).join(', ') : '';
    const article = makeAdapterArticle(feed, {
      title: String(w.title),
      url: doi,
      summary: `${authors ? `Автори: ${authors}.` : ''}${venue} Цитувань: ${w.cited_by_count ?? 0}. ${clip(abstract, 800)}`,
      publishedAt: iso,
      category: 'research',
    });
    if (article) out.push(article);
  }
  return out.slice(0, 10);
}

export function parseCrossrefWorks(feed: FeedDefinition, data: unknown, now = Date.now()): FeedArticle[] {
  const items = ((data as { message?: { items?: Array<Record<string, any>> } })?.message?.items ?? []) as Array<Record<string, any>>;
  const out: FeedArticle[] = [];
  for (const w of items) {
    const title = Array.isArray(w.title) ? w.title[0] : w.title;
    const doi = w.DOI as string | undefined;
    if (!title || !doi) continue;
    const parts = w.issued?.['date-parts']?.[0] as number[] | undefined;
    const dateStr = parts?.length ? `${parts[0]}-${String(parts[1] ?? 1).padStart(2, '0')}-${String(parts[2] ?? 1).padStart(2, '0')}` : undefined;
    const iso = firstSeenIso(`crossref:${doi}`, dateStr, now);
    if (!iso) continue;
    const journal = Array.isArray(w['container-title']) ? w['container-title'][0] : undefined;
    const article = makeAdapterArticle(feed, {
      title: String(title),
      url: `https://doi.org/${doi}`,
      summary: `${journal ? `Журнал: ${journal}. ` : ''}Цитувань: ${w['is-referenced-by-count'] ?? 0}. ${clip(String(w.abstract || ''), 700)}`,
      publishedAt: iso,
      category: 'research',
    });
    if (article) out.push(article);
  }
  return out.slice(0, 8);
}

export function parseSemanticScholar(feed: FeedDefinition, data: unknown, now = Date.now()): FeedArticle[] {
  const rows = ((data as { data?: Array<Record<string, any>> })?.data ?? []) as Array<Record<string, any>>;
  const out: FeedArticle[] = [];
  const recent = rows
    .filter((r) => r.paperId && r.title && r.publicationDate && Date.parse(r.publicationDate) <= now)
    .sort((a, b) => Number(b.citationCount || 0) - Number(a.citationCount || 0));
  for (const r of recent.slice(0, 20)) {
    const iso = firstSeenIso(`s2:${r.paperId}`, r.publicationDate, now);
    if (!iso) continue;
    const article = makeAdapterArticle(feed, {
      title: String(r.title),
      url: `https://www.semanticscholar.org/paper/${r.paperId}`,
      summary: `${clip(String(r.abstract || ''), 800)} Цитувань: ${r.citationCount ?? 0}.`,
      publishedAt: iso,
      category: 'research',
    });
    if (article) out.push(article);
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------------------------------------------------
// Wikipedia: Current events portal (CC BY-SA 4.0)
// ---------------------------------------------------------------------------------------------------------------------
const WIKI_CATEGORY_MAP: Array<[RegExp, string]> = [
  [/armed conflicts|attacks/i, 'defense'],
  [/business|economy/i, 'economy'],
  [/health|environment/i, 'health'],
  [/law|crime/i, 'law'],
  [/politics|elections|international relations/i, 'politics'],
  [/science|technology/i, 'global_tech'],
  [/arts|culture/i, 'culture'],
];

function stripWikiText(html: string): string {
  return html
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .trim();
}

export function parseWikipediaCurrentEvents(feed: FeedDefinition, html: string, pageTitle: string, now = Date.now()): FeedArticle[] {
  const out: FeedArticle[] = [];
  const tagRe = /<(\/?)(ul|li|p)\b[^>]*>/gi;
  let depth = 0;
  let liStart = -1;
  let liHtml = '';
  let category = '';
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = tagRe.exec(html))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'p' && closing && depth === 0) {
      const heading = /<b>([\s\S]*?)<\/b>\s*$/i.exec(html.slice(lastIndex, m.index));
      if (heading) category = stripWikiText(heading[1]);
    }
    if (tag === 'p' && !closing && depth === 0) lastIndex = m.index + m[0].length;
    if (tag === 'ul') {
      if (!closing) {
        if (depth >= 1 && liStart >= 0 && !liHtml) liHtml = html.slice(liStart, m.index); // text before nested bullets
        depth += 1;
      } else {
        depth = Math.max(0, depth - 1);
      }
    } else if (tag === 'li') {
      if (!closing && depth === 1) {
        liStart = m.index + m[0].length;
        liHtml = '';
      } else if (closing && depth === 1 && liStart >= 0) {
        const body = liHtml || html.slice(liStart, m.index);
        liStart = -1;
        const text = stripWikiText(body);
        if (text.length < 40) continue;
        const sentence = /^(.{40,260}?[.!?])(\s|$)/.exec(text)?.[1] || text.slice(0, 220);
        const hash = createHash('sha256').update(`${pageTitle}|${text}`).digest('hex').slice(0, 10);
        const iso = firstSeenIso(`wiki:${hash}`, undefined, now);
        if (!iso) continue;
        const mapped = WIKI_CATEGORY_MAP.find(([re]) => re.test(category))?.[1] || 'politics';
        const article = makeAdapterArticle(feed, {
          title: sentence,
          url: `https://en.wikipedia.org/wiki/${pageTitle}?item=${hash}`,
          summary: `${text} (Wikipedia: Current events, CC BY-SA 4.0.)`,
          publishedAt: iso,
          category: mapped,
        });
        if (article) out.push(article);
      }
    }
  }
  return out;
}

function wikiPageTitle(date: Date): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `Portal:Current_events/${date.getUTCFullYear()}_${months[date.getUTCMonth()]}_${date.getUTCDate()}`;
}

async function loadWikipediaEvents(feed: FeedDefinition, ctx: AdapterContext): Promise<FeedArticle[]> {
  const now = ctx.now ?? Date.now();
  const out: FeedArticle[] = [];
  for (const offset of [0, 1]) {
    const title = wikiPageTitle(new Date(now - offset * 86_400_000));
    const url = `${feed.url}?action=parse&page=${encodeURIComponent(title)}&prop=text&disablelimitreport=1&disableeditsection=1&format=json&formatversion=2`;
    const json = await fetchJson<{ parse?: { text?: string } }>(url, ctx).catch(() => null);
    if (json?.parse?.text) out.push(...parseWikipediaCurrentEvents(feed, json.parse.text, title, now));
  }
  return out.slice(0, 40);
}

// ---------------------------------------------------------------------------------------------------------------------
// GDELT DOC API (Ukraine in global media). Only headline + link, diversified by domain.
// ---------------------------------------------------------------------------------------------------------------------
export function parseGdeltArticles(feed: FeedDefinition, data: unknown, now = Date.now()): FeedArticle[] {
  const rows = ((data as { articles?: Array<Record<string, any>> })?.articles ?? []) as Array<Record<string, any>>;
  const perDomain = new Map<string, number>();
  const out: FeedArticle[] = [];
  for (const r of rows) {
    const url = String(r.url || '');
    if (!url.startsWith('https://') || !r.title) continue;
    const domain = String(r.domain || URL.parse(url)?.hostname || '').replace(/^www\./, '');
    if ((perDomain.get(domain) ?? 0) >= 2) continue;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(r.seendate || ''));
    const seen = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : now;
    if (now - seen > 24 * 60 * 60_000) continue;
    const article = makeAdapterArticle(feed, {
      title: String(r.title),
      url,
      summary: `Джерело: ${domain}${r.sourcecountry ? ` (${r.sourcecountry})` : ''}. Знайдено через GDELT.`,
      publishedAt: new Date(Math.min(seen, now)).toISOString(),
    });
    if (!article) continue;
    perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    out.push(article);
    if (out.length >= 40) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// CISA Known Exploited Vulnerabilities
// ---------------------------------------------------------------------------------------------------------------------
export function parseCisaKev(feed: FeedDefinition, data: unknown, now = Date.now()): FeedArticle[] {
  const vulns = ((data as { vulnerabilities?: Array<Record<string, any>> })?.vulnerabilities ?? []) as Array<Record<string, any>>;
  const out: FeedArticle[] = [];
  const recent = [...vulns].sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded))).slice(0, 15);
  for (const v of recent) {
    if (!v.cveID) continue;
    const iso = firstSeenIso(`kev:${v.cveID}`, `${v.dateAdded}T00:00:00Z`, now);
    if (!iso) continue;
    const ransomware = String(v.knownRansomwareCampaignUse).toLowerCase() === 'known' ? ' Використовується в кампаніях з шифрувальниками.' : '';
    const article = makeAdapterArticle(feed, {
      title: `CISA adds ${v.vendorProject} ${v.product} vulnerability ${v.cveID} to Known Exploited Vulnerabilities catalog`,
      url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(String(v.cveID))}`,
      summary: `${v.vulnerabilityName}. ${clip(String(v.shortDescription || ''), 500)} Дедлайн для федеральних агентств США: ${v.dueDate}.${ransomware}`,
      publishedAt: iso,
      category: 'cybersecurity',
    });
    if (article) out.push(article);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Statistics adapters with built-in charts (no LLM required): Eurostat, NBU, World Bank
// ---------------------------------------------------------------------------------------------------------------------
export interface BuiltVisual {
  type: 'line' | 'stat';
  title: string;
  caption?: string;
  unit?: string;
  labels?: string[];
  series?: Array<{ name: string; values: Array<number | null> }>;
  items?: Array<{ label: string; value: number; unit?: string; delta?: number; note?: string }>;
  source: { name: string; url: string };
}

export interface EurostatSpec {
  dataset: string;
  query: string;
  titleUk: string;
  titleEn: string;
  unit: string;
  category: 'economy' | 'finance';
  sinceMonthsBack: number;
}

export const EUROSTAT_SPECS: EurostatSpec[] = [
  { dataset: 'prc_hicp_manr', query: 'geo=EU27_2020&coicop=CP00', titleEn: 'EU annual inflation (HICP)', titleUk: 'річна інфляція в ЄС (HICP)', unit: '%', category: 'economy', sinceMonthsBack: 14 },
  { dataset: 'une_rt_m', query: 'geo=EU27_2020&sex=T&age=TOTAL&unit=PC_ACT&s_adj=SA', titleEn: 'EU unemployment rate', titleUk: 'безробіття в ЄС', unit: '%', category: 'economy', sinceMonthsBack: 14 },
];

export function parseEurostatSeries(json: any): { labels: string[]; values: Array<number | null> } | null {
  const index = json?.dimension?.time?.category?.index as Record<string, number> | undefined;
  const values = json?.value as Record<string, number> | undefined;
  if (!index || !values) return null;
  const entries = Object.entries(index).sort((a, b) => a[1] - b[1]);
  return { labels: entries.map(([label]) => label), values: entries.map(([, i]) => (typeof values[String(i)] === 'number' ? values[String(i)] : null)) };
}

export function buildEurostatArticle(feed: FeedDefinition, spec: EurostatSpec, json: unknown, now = Date.now()): FeedArticle | null {
  const series = parseEurostatSeries(json);
  if (!series) return null;
  let last = series.values.length - 1;
  while (last >= 0 && series.values[last] === null) last -= 1;
  if (last < 1) return null;
  const latest = series.values[last] as number;
  const prev = series.values[last - 1];
  const period = series.labels[last];
  const iso = firstSeenIso(`eurostat:${spec.dataset}:${period}`, undefined, now);
  if (!iso) return null;
  const delta = typeof prev === 'number' ? Math.round((latest - prev) * 100) / 100 : undefined;
  const url = `https://ec.europa.eu/eurostat/databrowser/view/${spec.dataset}/default/table?lang=en&period=${encodeURIComponent(period)}`;
  const visuals: BuiltVisual[] = [
    {
      type: 'stat',
      title: spec.titleEn,
      unit: spec.unit,
      items: [{ label: period, value: latest, unit: spec.unit, ...(delta !== undefined ? { delta } : {}), note: typeof prev === 'number' ? `попередній період: ${prev}${spec.unit}` : undefined }],
      source: { name: 'Eurostat', url },
    },
    {
      type: 'line',
      title: spec.titleEn,
      unit: spec.unit,
      labels: series.labels,
      series: [{ name: spec.titleEn, values: series.values }],
      source: { name: 'Eurostat', url },
    },
  ];
  return makeAdapterArticle(feed, {
    title: `Eurostat: ${spec.titleUk} — ${latest}${spec.unit} за ${period}`,
    url,
    summary: `Показник "${spec.titleEn}" за ${period} становить ${latest}${spec.unit}${delta !== undefined ? ` (${delta >= 0 ? '+' : ''}${delta} п.п. до попереднього періоду)` : ''}. Дані Eurostat.`,
    publishedAt: iso,
    category: spec.category,
    visuals,
  });
}

async function loadEurostat(feed: FeedDefinition, ctx: AdapterContext): Promise<FeedArticle[]> {
  const now = ctx.now ?? Date.now();
  const since = new Date(now);
  const out: FeedArticle[] = [];
  for (const spec of EUROSTAT_SPECS) {
    const d = new Date(since);
    d.setUTCMonth(d.getUTCMonth() - spec.sinceMonthsBack);
    const sinceKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const url = `${feed.url}/${spec.dataset}?format=JSON&lang=EN&${spec.query}&sinceTimePeriod=${sinceKey}`;
    const json = await fetchJson(url, ctx).catch(() => null);
    const article = json ? buildEurostatArticle(feed, spec, json, now) : null;
    if (article) out.push(article);
  }
  return out;
}

export function buildNbuArticle(
  feed: FeedDefinition,
  rows: Record<string, Array<{ rate: number; exchangedate: string }>>,
  now = Date.now(),
): FeedArticle | null {
  const currencies = Object.keys(rows).filter((c) => rows[c]?.length >= 2);
  if (currencies.length === 0) return null;
  const toDate = (s: string) => {
    const [d, m, y] = s.split('.').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  const sorted = (c: string) => [...rows[c]].sort((a, b) => toDate(a.exchangedate).localeCompare(toDate(b.exchangedate)));
  const lead = sorted(currencies[0]);
  const effective = toDate(lead[lead.length - 1].exchangedate);
  const iso = firstSeenIso(`nbu:${effective}`, `${effective}T00:00:00Z`, now);
  if (!iso) return null;
  const fmt = (n: number) => n.toFixed(2).replace('.', ',');
  const parts: string[] = [];
  const stats: NonNullable<BuiltVisual['items']> = [];
  const lines: Array<{ name: string; values: number[] }> = [];
  for (const cur of currencies) {
    const s = sorted(cur);
    const last = s[s.length - 1].rate;
    const prev = s[s.length - 2].rate;
    const delta = Math.round((last - prev) * 10_000) / 10_000;
    parts.push(`${cur.toUpperCase()} ${fmt(last)} (${delta >= 0 ? '+' : ''}${fmt(delta)})`);
    stats.push({ label: cur.toUpperCase(), value: Math.round(last * 100) / 100, unit: '₴', delta: Math.round(delta * 100) / 100 });
    lines.push({ name: cur.toUpperCase(), values: s.map((r) => r.rate) });
  }
  const url = `https://bank.gov.ua/ua/markets/exchangerates?date=${effective.split('-').reverse().join('.')}&period=daily`;
  const visuals: BuiltVisual[] = [
    { type: 'stat', title: 'Офіційний курс НБУ, грн', unit: '₴', items: stats, source: { name: 'НБУ', url } },
    { type: 'line', title: 'Динаміка курсу НБУ, грн', unit: '₴', labels: lead.map((r) => toDate(r.exchangedate).slice(5)), series: lines, source: { name: 'НБУ', url } },
  ];
  return makeAdapterArticle(feed, {
    title: `НБУ встановив офіційний курс на ${effective.split('-').reverse().join('.')}: ${parts.join(', ')}`,
    url,
    summary: `Офіційні курси гривні до іноземних валют від Національного банку України на ${effective.split('-').reverse().join('.')}: ${parts.join('; ')}.`,
    publishedAt: iso,
    category: 'finance',
    visuals,
  });
}

async function loadNbu(feed: FeedDefinition, ctx: AdapterContext): Promise<FeedArticle[]> {
  const now = ctx.now ?? Date.now();
  const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
  const rows: Record<string, Array<{ rate: number; exchangedate: string }>> = {};
  for (const cur of ['usd', 'eur', 'pln']) {
    const url = `https://bank.gov.ua/NBU_Exchange/exchange_site?start=${ymd(now - 10 * 86_400_000)}&end=${ymd(now + 86_400_000)}&valcode=${cur}&sort=exchangedate&order=desc&json`;
    const json = await fetchJson<Array<{ rate: number; exchangedate: string }>>(url, ctx).catch(() => null);
    if (Array.isArray(json) && json.length >= 2) rows[cur] = json.slice(0, 8);
  }
  const article = buildNbuArticle(feed, rows, now);
  return article ? [article] : [];
}

export function buildWorldBankArticle(feed: FeedDefinition, series: Array<{ name: string; unit: string; points: Array<{ year: string; value: number }> }>, now = Date.now()): FeedArticle | null {
  const usable = series.filter((s) => s.points.length >= 3);
  if (usable.length === 0) return null;
  const year = usable.map((s) => s.points[s.points.length - 1].year).sort().pop() as string;
  const iso = firstSeenIso(`worldbank:${year}:${usable.map((s) => s.points[s.points.length - 1].value.toFixed(2)).join(',')}`, undefined, now);
  if (!iso) return null;
  const url = 'https://data.worldbank.org/country/ukraine';
  const stats = usable.map((s) => {
    const last = s.points[s.points.length - 1];
    const prev = s.points[s.points.length - 2];
    return { label: `${s.name} (${last.year})`, value: Math.round(last.value * 10) / 10, unit: s.unit, delta: Math.round((last.value - prev.value) * 10) / 10 };
  });
  const labels = usable[0].points.map((p) => p.year);
  const visuals: BuiltVisual[] = [
    { type: 'stat', title: 'Україна: макропоказники', items: stats, source: { name: 'World Bank', url } },
    { type: 'line', title: 'Україна: динаміка показників, %', unit: '%', labels, series: usable.map((s) => ({ name: s.name, values: labels.map((y) => s.points.find((p) => p.year === y)?.value ?? null) })), source: { name: 'World Bank', url } },
  ];
  return makeAdapterArticle(feed, {
    title: `World Bank: оновлено макропоказники України за ${year} рік`,
    url: `${url}?year=${year}`,
    summary: stats.map((s) => `${s.label}: ${s.value}${s.unit}`).join('; '),
    publishedAt: iso,
    category: 'economy',
    visuals,
  });
}

async function loadWorldBank(feed: FeedDefinition, ctx: AdapterContext): Promise<FeedArticle[]> {
  const indicators: Array<{ code: string; name: string; unit: string }> = [
    { code: 'NY.GDP.MKTP.KD.ZG', name: 'Зростання ВВП', unit: '%' },
    { code: 'FP.CPI.TOTL.ZG', name: 'Інфляція', unit: '%' },
    { code: 'SL.UEM.TOTL.ZS', name: 'Безробіття', unit: '%' },
  ];
  const series: Array<{ name: string; unit: string; points: Array<{ year: string; value: number }> }> = [];
  for (const ind of indicators) {
    const json = await fetchJson<[unknown, Array<{ date: string; value: number | null }>]>(
      `https://api.worldbank.org/v2/country/UKR/indicator/${ind.code}?format=json&per_page=8`,
      ctx,
    ).catch(() => null);
    const rows = Array.isArray(json?.[1]) ? json![1] : [];
    const points = rows
      .filter((r) => typeof r.value === 'number')
      .map((r) => ({ year: r.date, value: r.value as number }))
      .sort((a, b) => a.year.localeCompare(b.year))
      .slice(-6);
    series.push({ name: ind.name, unit: ind.unit, points });
  }
  const article = buildWorldBankArticle(feed, series, ctx.now);
  return article ? [article] : [];
}

// ---------------------------------------------------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------------------------------------------------
export async function runApiAdapter(feed: FeedDefinition, ctx: AdapterContext = {}): Promise<FeedArticle[]> {
  const now = ctx.now ?? Date.now();
  let items: FeedArticle[] = [];
  const mailto = contactParam();
  switch (feed.adapter) {
    case 'hf_daily_papers':
      items = parseHfDailyPapers(feed, await fetchJson(`${feed.url}?limit=50`, ctx), now);
      break;
    case 'ckan_datagov':
      items = parseCkanDatasets(feed, await fetchJson(`${feed.url}?rows=60&sort=metadata_created%20desc`, ctx), now);
      break;
    case 'prozorro_tenders':
      items = await loadProzorro(feed, ctx);
      break;
    case 'openalex_ai': {
      const filter = `from_publication_date:${daysAgo(10, now)},type:article,primary_topic.subfield.id:1702`;
      const url = `${feed.url}?filter=${filter}&sort=cited_by_count:desc&per-page=15${mailto ? `&mailto=${encodeURIComponent(mailto)}` : ''}`;
      items = parseOpenAlexWorks(feed, await fetchJson(url, ctx), now);
      break;
    }
    case 'crossref_ai': {
      const url = `${feed.url}?query.bibliographic=${encodeURIComponent('artificial intelligence large language model')}&filter=from-pub-date:${daysAgo(14, now)},type:journal-article&sort=is-referenced-by-count&order=desc&rows=15&select=DOI,title,container-title,issued,abstract,is-referenced-by-count${mailto ? `&mailto=${encodeURIComponent(mailto)}` : ''}`;
      items = parseCrossrefWorks(feed, await fetchJson(url, ctx), now);
      break;
    }
    case 'semantic_scholar_ai': {
      const key = (process.env.SEMANTIC_SCHOLAR_API_KEY || '').trim();
      const url = `${feed.url}?query=${encodeURIComponent('"large language model" | "language agents" | "reasoning model"')}&fields=title,abstract,citationCount,publicationDate&publicationDateOrYear=${daysAgo(7, now)}:&sort=citationCount:desc`;
      items = parseSemanticScholar(feed, await fetchJson(url, ctx, key ? { 'x-api-key': key } : {}), now);
      break;
    }
    case 'wikipedia_current_events':
      items = await loadWikipediaEvents(feed, ctx);
      break;
    case 'gdelt_ukraine': {
      // Primary: the raw 15-minute GKG files (static, no rate limit). The DOC API throttles with 429 almost always, so it is only a fallback.
      try {
        const gkg = await loadGdeltGkg({ fetchFn: ctx.fetchFn, userAgent: getHonestUserAgent(), now });
        items = parseGdeltArticles(feed, { articles: toDocRows(gkg) }, now);
        if (items.length) break;
      } catch (err) {
        console.warn(`GDELT raw files failed (${err instanceof Error ? err.message : err}); trying the DOC API`);
      }
      const query = encodeURIComponent('(Ukraine OR Україна) sourcelang:ukrainian');
      items = parseGdeltArticles(feed, await fetchJson(`${feed.url}?query=${query}&mode=artlist&format=json&maxrecords=60&sort=datedesc&timespan=12h`, ctx), now);
      break;
    }
    case 'cisa_kev':
      items = parseCisaKev(feed, await fetchJson(feed.url, ctx), now);
      break;
    case 'eurostat_indicators':
      items = await loadEurostat(feed, ctx);
      break;
    case 'nbu_rates':
      items = await loadNbu(feed, ctx);
      break;
    case 'worldbank_ukraine':
      items = await loadWorldBank(feed, ctx);
      break;
    default:
      throw new Error(`Unknown adapter: ${String(feed.adapter)}`);
  }
  return items.sort((a, b) => b.published_at.localeCompare(a.published_at));
}
