import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { canonicalizeUrl, isTransientHttpStatus, retryWithBackoff } from '../common/url-utils';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES, NewsCategory } from '../ingest/ingest.dto';

export interface FeedDefinition {
  slug: string;
  alias?: string;
  name: string;
  domain: string;
  allowedDomains?: string[];
  url: string;
  category?: string;
  providerId?: string;
  unofficial?: boolean;
  autoDiscovered?: boolean;
}

export const COMPANY_FEED_CATALOG: FeedDefinition[] = [
  // AI Frontier & Developer Ecosystems
  { slug: 'anthropic-news-community-feed', alias: 'anthropic-news', name: 'Anthropic', domain: 'anthropic.com', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml', category: 'model', providerId: 'claude', unofficial: true },
  { slug: 'openai-news', name: 'OpenAI', domain: 'openai.com', url: 'https://openai.com/news/rss.xml', category: 'model', providerId: 'openai' },
  { slug: 'google-deepmind', name: 'Google DeepMind', domain: 'deepmind.google', allowedDomains: ['deepmind.google', 'blog.google', 'ai.google.dev'], url: 'https://deepmind.google/blog/rss.xml', category: 'model', providerId: 'gemini' },
  { slug: 'google-ai-blog', name: 'Google AI Blog', domain: 'blog.google', allowedDomains: ['blog.google', 'deepmind.google', 'ai.google.dev'], url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', category: 'model', providerId: 'gemini' },
  { slug: 'google-research', name: 'Google Research', domain: 'research.google', allowedDomains: ['research.google', 'blog.google'], url: 'https://research.google/blog/rss/', category: 'research', providerId: 'gemini' },
  { slug: 'mistral-ai-community-feed', alias: 'mistral-ai', name: 'Mistral AI', domain: 'mistral.ai', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_mistral.xml', category: 'model', providerId: 'mistral', unofficial: true },
  { slug: 'hugging-face', name: 'Hugging Face', domain: 'huggingface.co', url: 'https://huggingface.co/blog/feed.xml', category: 'open_source', providerId: 'huggingface' },
  { slug: 'xai-news-community-feed', alias: 'xai-news', name: 'xAI', domain: 'x.ai', allowedDomains: ['x.ai', 'grok.com'], url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_xai.xml', category: 'model', providerId: 'grok', unofficial: true },
  { slug: 'aws-ml', name: 'AWS Machine Learning', domain: 'aws.amazon.com', url: 'https://aws.amazon.com/blogs/machine-learning/feed/', category: 'api' },
  { slug: 'claude-code-releases', name: 'Claude Code Releases', domain: 'github.com', url: 'https://github.com/anthropics/claude-code/releases.atom', category: 'coding', providerId: 'claude' },
  { slug: 'openai-python-sdk', name: 'OpenAI Python SDK', domain: 'github.com', url: 'https://github.com/openai/openai-python/releases.atom', category: 'api', providerId: 'openai' },
  { slug: 'ollama-releases', name: 'Ollama Releases', domain: 'github.com', url: 'https://github.com/ollama/ollama/releases.atom', category: 'open_source' },
  { slug: 'vllm-releases', name: 'vLLM Releases', domain: 'github.com', url: 'https://github.com/vllm-project/vllm/releases.atom', category: 'open_source' },

  // DefenseTech & Ukraine Tech
  { slug: 'itc-ua', name: 'ITC.ua', domain: 'itc.ua', allowedDomains: ['itc.ua'], url: 'https://itc.ua/ua/feed/', category: 'global_tech' },
  { slug: 'dou-ua', name: 'DOU.ua', domain: 'dou.ua', allowedDomains: ['dou.ua', 'gamedev.dou.ua', 'jobs.dou.ua'], url: 'https://dou.ua/feed/', category: 'global_tech' },
  { slug: 'dev-ua', name: 'Dev.ua', domain: 'dev.ua', allowedDomains: ['dev.ua'], url: 'https://dev.ua/rss', category: 'global_tech' },

  // Science, Space & Biotech
  { slug: 'nasa-breaking-news', name: 'NASA Breaking News', domain: 'nasa.gov', allowedDomains: ['nasa.gov', 'science.nasa.gov', 'blogs.nasa.gov'], url: 'https://www.nasa.gov/news-release/feed/', category: 'science_space' },
  { slug: 'ars-technica-science', name: 'Ars Technica Science', domain: 'arstechnica.com', allowedDomains: ['arstechnica.com', 'feeds.arstechnica.com'], url: 'https://feeds.arstechnica.com/arstechnica/science', category: 'science_space' },
  { slug: 'nature-news', name: 'Nature News', domain: 'nature.com', allowedDomains: ['nature.com', 'feeds.nature.com'], url: 'https://www.nature.com/nature.rss', category: 'science_space' },

  // Cybersecurity, Cloud & Dev
  { slug: 'the-hacker-news', name: 'The Hacker News', domain: 'thehackernews.com', allowedDomains: ['thehackernews.com', 'feeds.feedburner.com'], url: 'https://feeds.feedburner.com/TheHackersNews', category: 'cybersecurity' },
  { slug: 'cloudflare-blog', name: 'Cloudflare Blog', domain: 'blog.cloudflare.com', allowedDomains: ['blog.cloudflare.com', 'cloudflare.com'], url: 'https://blog.cloudflare.com/rss/', category: 'cybersecurity' },
  { slug: 'github-blog', name: 'GitHub Blog', domain: 'github.blog', allowedDomains: ['github.blog', 'github.com'], url: 'https://github.blog/feed/', category: 'coding' },

  // Startups, Business & Fintech
  { slug: 'techcrunch-startups', name: 'TechCrunch Startups', domain: 'techcrunch.com', allowedDomains: ['techcrunch.com'], url: 'https://techcrunch.com/category/startups/feed/', category: 'startups_fintech' },
  { slug: 'yc-blog', name: 'Y Combinator Blog', domain: 'ycombinator.com', allowedDomains: ['ycombinator.com', 'blog.ycombinator.com'], url: 'https://www.ycombinator.com/blog/rss', category: 'startups_fintech' },

  // Hardware, Gadgets & Gaming
  { slug: 'toms-hardware', name: "Tom's Hardware", domain: 'tomshardware.com', allowedDomains: ['tomshardware.com'], url: 'https://www.tomshardware.com/feeds/all', category: 'hardware_gaming' },
  { slug: 'eurogamer', name: 'Eurogamer', domain: 'eurogamer.net', allowedDomains: ['eurogamer.net'], url: 'https://www.eurogamer.net/feed', category: 'hardware_gaming' },
];

export const DEFAULT_FEEDS = COMPANY_FEED_CATALOG;

const refreshInterval = 60_000;
const retryInterval = 30_000;
const maxStaleAge = 24 * 60 * 60_000;
const maxFeedBytes = 4 * 1024 * 1024;
const articlesPerFeed = 20;
export const companyFeeds = COMPANY_FEED_CATALOG;
export const maxFeedArticles = 250;

export type FeedArticle = {
  id: string;
  url: string;
  canonical_url: string;
  original_title: string;
  original_summary: string;
  published_at: string;
  source_name: string;
  source_slug: string;
  category?: string;
  provider_id?: string;
};

type FeedState = {
  items: FeedArticle[];
  fetchedAt: number;
  refreshAt: number;
  etag?: string;
  lastModified?: string;
  lastError?: string;
  consecutiveFailures: number;
  pending?: Promise<void>;
};

@Injectable()
export class CompanyFeedsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CompanyFeedsService.name);
  private readonly cache = new Map<string, FeedState>();
  private activeFeeds: FeedDefinition[] = [...DEFAULT_FEEDS];
  private pollTimer?: NodeJS.Timeout;
  private isDestroyed = false;

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit() {
    await this.seedDefaultSources();
    await this.reloadFeedsFromDatabase();

    const intervalMs = Math.max(30_000, Number(process.env.FEED_POLL_INTERVAL_MS) || refreshInterval);
    const scheduleNext = () => {
      this.pollTimer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.pollAll();
        } catch (error) {
          this.logger.warn(`News feeds polling cycle warning: ${error instanceof Error ? error.message : error}`);
        } finally {
          if (!this.isDestroyed) scheduleNext();
        }
      }, intervalMs);
    };

    this.pollTimer = setTimeout(async () => {
      if (this.isDestroyed) return;
      try {
        await this.pollAll();
      } catch (error) {
        this.logger.warn(`Initial news poll error: ${error instanceof Error ? error.message : error}`);
      } finally {
        if (!this.isDestroyed) scheduleNext();
      }
    }, 2_000);
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  getActiveFeeds(): FeedDefinition[] {
    return this.activeFeeds;
  }

  async seedDefaultSources(): Promise<void> {
    try {
      for (const feed of DEFAULT_FEEDS) {
        await this.db.query(`
          INSERT INTO sources (slug, name, homepage_url, feed_url, unofficial, enabled, category, provider_id, auto_discovered, allowed_domains)
          VALUES ($1, $2, $3, $4, $5, true, $6, $7, false, $8::jsonb)
          ON CONFLICT (slug) DO UPDATE SET
            feed_url = COALESCE(sources.feed_url, EXCLUDED.feed_url),
            category = CASE WHEN sources.category = 'other' THEN EXCLUDED.category ELSE sources.category END,
            provider_id = COALESCE(sources.provider_id, EXCLUDED.provider_id),
            allowed_domains = CASE WHEN sources.allowed_domains = '[]'::jsonb THEN EXCLUDED.allowed_domains ELSE sources.allowed_domains END
        `, [
          feed.slug,
          feed.name,
          `https://${feed.domain}`,
          feed.url,
          feed.unofficial ?? false,
          feed.category || 'other',
          feed.providerId || null,
          JSON.stringify(feed.allowedDomains || [feed.domain]),
        ]);
      }
    } catch (error) {
      this.logger.warn(`Could not seed default sources: ${error instanceof Error ? error.message : error}`);
    }
  }

  async reloadFeedsFromDatabase(): Promise<void> {
    try {
      const { rows } = await this.db.query<{
        slug: string;
        name: string;
        homepage_url: string;
        feed_url: string | null;
        unofficial: boolean;
        category: string | null;
        provider_id: string | null;
        auto_discovered: boolean;
        allowed_domains: string[] | null;
      }>(`
        SELECT slug, name, homepage_url, feed_url, unofficial, category, provider_id, auto_discovered, allowed_domains
        FROM sources
        WHERE enabled = true AND feed_url IS NOT NULL AND feed_url LIKE 'https://%'
        ORDER BY auto_discovered ASC, name ASC
      `);

      if (rows.length > 0) {
        const aliasMap = new Map(DEFAULT_FEEDS.filter(f => f.alias).map(f => [f.slug, f.alias]));
        this.activeFeeds = rows.map(row => {
          const parsedHome = URL.parse(row.homepage_url);
          const domain = parsedHome?.hostname.replace(/^www\./, '') || '';
          const allowed = Array.isArray(row.allowed_domains) && row.allowed_domains.length
            ? row.allowed_domains
            : domain ? [domain] : [];
          return {
            slug: row.slug,
            alias: aliasMap.get(row.slug),
            name: row.name,
            domain,
            allowedDomains: allowed,
            url: row.feed_url!,
            category: row.category || 'other',
            providerId: row.provider_id || undefined,
            unofficial: row.unofficial,
            autoDiscovered: row.auto_discovered,
          };
        });
      }
    } catch {
      // Keep DEFAULT_FEEDS if migration 005 has not been applied yet
    }
  }

  async pollAll(force = false) {
    await this.reloadFeedsFromDatabase();
    if (force) {
      for (const state of this.cache.values()) {
        state.refreshAt = 0;
      }
    }
    const batches = await Promise.all(this.activeFeeds.map(feed => this.read(feed)));
    const total = batches.reduce((acc, items) => acc + (items?.length || 0), 0);
    this.logger.log(`News poll completed: ${total} articles active across ${this.activeFeeds.length} feeds.`);
    return { feeds: this.activeFeeds.length, articles: total };
  }

  getHealthSnapshot() {
    return this.activeFeeds.map(feed => {
      const state = this.cache.get(feed.slug);
      return {
        slug: feed.slug,
        name: feed.name,
        url: feed.url,
        category: feed.category || 'other',
        providerId: feed.providerId || null,
        autoDiscovered: Boolean(feed.autoDiscovered),
        articleCount: state?.items.length ?? 0,
        fetchedAt: state?.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
        lastError: state?.lastError ?? null,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
      };
    });
  }

  async list(sources: string[]) {
    const selected = this.activeFeeds.filter(
      feed =>
        !sources.length ||
        sources.includes(feed.slug) ||
        (feed.alias !== undefined && sources.includes(feed.alias)),
    );
    const batches = await Promise.all(selected.map(feed => this.read(feed)));
    return {
      items: batches.flatMap(items => items ?? []),
      unavailable: batches.length > 0 && batches.every(items => !items),
    };
  }

  private async read(feed: FeedDefinition): Promise<FeedArticle[] | undefined> {
    let state = this.cache.get(feed.slug);
    if (!state) {
      state = { items: [], fetchedAt: 0, refreshAt: 0, consecutiveFailures: 0 };
      this.cache.set(feed.slug, state);
    }
    if (!state.pending && Date.now() >= state.refreshAt) {
      state.pending = this.refresh(feed, state);
    }
    await state.pending;
    return Date.now() - state.fetchedAt <= maxStaleAge ? state.items : undefined;
  }

  private async refresh(feed: FeedDefinition, state: FeedState): Promise<void> {
    try {
      state.items = await retryWithBackoff(
        () => loadFeed(feed, state),
        {
          maxAttempts: 2,
          baseDelayMs: 800,
          shouldRetry: (err) => {
            const status = (err as { status?: number })?.status;
            if (typeof status === 'number') return isTransientHttpStatus(status);
            return err instanceof Error && /Timeout|Abort|fetch failed|ECONNRESET/i.test(err.message);
          },
        },
      );
      state.fetchedAt = Date.now();
      state.refreshAt = state.fetchedAt + refreshInterval;
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      void this.db.query(
        `UPDATE sources SET last_fetched_at = now(), last_error = NULL, consecutive_failures = 0 WHERE slug = $1`,
        [feed.slug],
      ).catch(() => undefined);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'request failed';
      state.lastError = msg;
      state.consecutiveFailures += 1;
      const backoff = Math.min(10 * 60_000, retryInterval * Math.min(8, state.consecutiveFailures));
      state.refreshAt = Date.now() + backoff;
      this.logger.warn(`${feed.name} feed (attempt #${state.consecutiveFailures}): ${msg}`);
      void this.db.query(
        `UPDATE sources SET last_fetched_at = now(), last_error = $2, consecutive_failures = $3 WHERE slug = $1`,
        [feed.slug, msg.slice(0, 300), state.consecutiveFailures],
      ).catch(() => undefined);
    } finally {
      state.pending = undefined;
    }
  }
}

export async function fetchAndParseFeedUrl(feed: FeedDefinition, state: Partial<FeedState> = {}): Promise<FeedArticle[]> {
  return loadFeed(feed, state as FeedState);
}

async function loadFeed(feed: FeedDefinition, state: FeedState): Promise<FeedArticle[]> {
  const headers: Record<string, string> = {
    'User-Agent': 'OpportunityRadar/1.0 (RSS/Atom Reader; 60s cadence)',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  };
  if (state.etag) headers['If-None-Match'] = state.etag;
  if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;

  const response = await fetch(feed.url, { headers, signal: AbortSignal.timeout(10_000) });

  if (response.status === 304 && state.items && state.items.length > 0) {
    return state.items;
  }

  if (!response.ok || !response.body) {
    await response.body?.cancel();
    const err = new Error(`HTTP ${response.status}`);
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }

  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  if (etag) state.etag = etag;
  if (lastModified) state.lastModified = lastModified;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let xml = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maxFeedBytes) throw new Error('Feed exceeds the size limit');
      xml += decoder.decode(chunk.value, { stream: true });
    }
    xml += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return parseFeedXml(xml, feed);
}

/**
 * Parses both RSS 2.0 (<rss><channel><item>) and Atom (<feed><entry>) XML streams.
 */
export function parseFeedXml(xml: string, feed: FeedDefinition): FeedArticle[] {
  const parser = new SaxesParser();
  const stack: string[] = [];
  const items = new Map<string, FeedArticle>();
  let fields: Record<string, string> = {};
  let mode: 'rss' | 'atom' | null = null;
  let atomLink = '';

  parser.on('doctype', () => { throw new Error('Unexpected XML doctype'); });
  parser.on('opentag', tag => {
    const name = tag.name.includes(':') ? tag.name.split(':').pop()! : tag.name;
    stack.push(name);
    if (stack.length === 1) {
      if (name === 'rss') mode = 'rss';
      else if (name === 'feed') mode = 'atom';
    }
    if (mode === 'rss' && stack.length === 3 && name === 'item') {
      fields = {};
    } else if (mode === 'atom' && stack.length === 2 && name === 'entry') {
      fields = {};
      atomLink = '';
    } else if (mode === 'atom' && stack.length === 3 && stack[1] === 'entry' && name === 'link') {
      const rel = String(tag.attributes.rel || 'alternate');
      const href = String(tag.attributes.href || '');
      if (rel === 'alternate' && href) atomLink = href;
      else if (!atomLink && href) atomLink = href;
    }
  });

  const append = (part: string) => {
    if (mode === 'rss' && stack[1] === 'channel' && stack[2] === 'item') {
      const field = stack[3];
      if (field === 'title' || field === 'link' || field === 'pubDate' || field === 'description') {
        fields[field] = (fields[field] || '') + part;
      }
    } else if (mode === 'atom' && stack[1] === 'entry') {
      const field = stack[2];
      if (field === 'title' || field === 'published' || field === 'updated' || field === 'summary' || field === 'content') {
        fields[field] = (fields[field] || '') + part;
      }
    }
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    const name = stack[stack.length - 1];
    if (mode === 'rss' && stack.length === 3 && stack[1] === 'channel' && name === 'item') {
      const item = normalizeArticle(feed, {
        title: fields.title,
        link: fields.link,
        pubDate: fields.pubDate,
        description: fields.description,
      });
      if (item && !items.has(item.canonical_url)) items.set(item.canonical_url, item);
    } else if (mode === 'atom' && stack.length === 2 && name === 'entry') {
      const item = normalizeArticle(feed, {
        title: fields.title,
        link: atomLink,
        pubDate: fields.published || fields.updated,
        description: fields.summary || fields.content,
      });
      if (item && !items.has(item.canonical_url)) items.set(item.canonical_url, item);
    }
    stack.pop();
  });

  parser.write(xml).close();
  if (!mode || items.size === 0) throw new Error('Feed contains no valid articles');
  return [...items.values()]
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
    .slice(0, articlesPerFeed);
}

function normalizeArticle(
  feed: FeedDefinition,
  raw: { title?: string; link?: string; pubDate?: string; description?: string },
): FeedArticle | undefined {
  const originalTitle = raw.title?.trim().slice(0, 350);
  const publishedAt = Date.parse(raw.pubDate || '');
  const link = URL.parse(raw.link?.trim() ?? '');
  const allowed = feed.allowedDomains && feed.allowedDomains.length > 0 ? feed.allowedDomains : [feed.domain];
  if (
    !originalTitle ||
    !Number.isFinite(publishedAt) ||
    !link ||
    link.protocol !== 'https:' ||
    link.username ||
    link.password ||
    link.port
  ) {
    return;
  }
  const host = link.hostname.toLowerCase();
  const hostOk = allowed.some(d => !d || host === d || host === `www.${d}`);
  if (!hostOk) return;

  link.hash = '';
  const url = link.href;
  const canonical = canonicalizeUrl(url);
  const originalSummary = (raw.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2500);
  const classifiedCategory = classifyFeedArticleCategory(originalTitle, originalSummary, feed.category);
  return {
    id: `rss-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`,
    url,
    canonical_url: canonical,
    original_title: originalTitle,
    original_summary: originalSummary,
    published_at: new Date(publishedAt).toISOString(),
    source_name: feed.name,
    source_slug: feed.slug,
    category: classifiedCategory,
    provider_id: feed.providerId,
  };
}

export function classifyFeedArticleCategory(
  title: string,
  summary: string,
  fallbackCategory?: string,
): NewsCategory {
  const haystack = `${title || ''} ${summary || ''}`;

  if (/\b(defen[cs]e|military|drone|uav|fpv|electronic warfare|brave1|missile|combat|battlefield|nato|pentagon|radar|munitions)\b|дрон|бпла|реб|оборон|військов|зсу|фронт|армі|міноборони/i.test(haystack)) {
    return 'defense';
  }
  if (/\b(cve-\d+|zero-day|0-day|ransomware|malware|phishing|breach|exploit|vulnerability|ddos|infosec|cybersecurity|threat actor|botnet|backdoor|authentication bypass)\b|кібер|вразлив|злам|фішинг|шифрувальник/i.test(haystack)) {
    return 'cybersecurity';
  }
  if (/\b(nasa|spacex|spacecraft|rocket|orbit|mars|moon|telescope|jwst|astronomy|exoplanet|quantum|physics|biotech|crispr|genome|fusion|cern)\b|космос|супутник|орбіт|телескоп|квантов|біотех|науков/i.test(haystack)) {
    return 'science_space';
  }
  if (/\b(nvidia rtx|geforce|radeon|gpu|cpu|ryzen|intel core|snapdragon|apple silicon|chipset|motherboard|ssd|playstation|ps5|xbox|nintendo|steam deck|gaming|game engine|unreal engine|fps|vr headset)\b|відеокарт|процесор|геймінг|консол|ігров/i.test(haystack)) {
    return 'hardware_gaming';
  }
  if (/\b(grant|fellowship|scholarship|hackathon|accelerator|funding call|horizon europe|erasmus|university|curriculum|bootcamp|student|mentorship)\b|грант|стипенді|хакатон|акселератор|освіт|навчання|університет|студент/i.test(haystack)) {
    return 'education_grants';
  }
  if (/\b(seed round|series [a-d]|venture|vc fund|funding round|valuation|ipo|fintech|neobank|crypto|blockchain|stablecoin|payments|stripe|startup|y combinator|founder)\b|стартап|інвестиц|раунд|венчур|фінтех|платіж/i.test(haystack)) {
    return 'startups_fintech';
  }
  if (/\b(ide|copilot|code editor|compiler|typescript|python|rust|javascript|refactor|cli|pull request|github actions|sdk|debugging|devtools|claude code|cursor)\b|програмуван|розробник|кодинг/i.test(haystack)) {
    return 'coding';
  }
  if (/\b(open[- ]source|open[- ]weight|apache 2\.0|mit license|hugging ?face|ollama|vllm|llama|weights released|github repo)\b|відкрит(ий|ого) код/i.test(haystack)) {
    return 'open_source';
  }
  if (/\b(api|endpoint|rate limit|latency|throughput|tokens per second|webhook|inference|cloud|serverless|workers)\b|інференс|хмарн/i.test(haystack)) {
    return 'api';
  }
  if (/\b(llm|gpt-|claude|gemini|grok|mistral|multimodal|foundation model|reasoning model|benchmark|evals|context window|fine-tun)\b|нейромереж|мовн(а|ої) модел/i.test(haystack)) {
    return 'model';
  }
  if (/\b(paper|arxiv|preprint|study|ablation|dataset|empirical|theorem)\b|досліджен|препринт/i.test(haystack)) {
    return 'research';
  }
  if (/\b(enterprise|revenue|profit|acquisition|merger|layoffs|antitrust|regulation|eu ai act|partnership|market share)\b|бізнес|виручк|регуляц|угода/i.test(haystack)) {
    return 'business';
  }
  if (/\b(tech industry|big tech|smartphone|telecom|5g|6g|ev|autonomous|robotics|infrastructure|data center|semiconductor)\b|технологі|робототехн|дата-центр/i.test(haystack)) {
    return 'global_tech';
  }

  if (fallbackCategory && (CATEGORIES as readonly string[]).includes(fallbackCategory)) {
    return fallbackCategory as NewsCategory;
  }
  return 'other';
}
