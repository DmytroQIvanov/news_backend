import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { getHonestUserAgent, LicenseMode } from '../common/source-compliance';
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
  licenseMode?: LicenseMode;
}

export const COMPANY_FEED_CATALOG: FeedDefinition[] = [
  // Ukraine, World Politics, Law & Society
  { slug: 'pravda-ua', name: 'Українська правда', domain: 'pravda.com.ua', allowedDomains: ['pravda.com.ua', 'epravda.com.ua', 'eurointegration.com.ua', 'life.pravda.com.ua'], url: 'https://www.pravda.com.ua/rss/', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'suspilne-news', name: 'Суспільне Новини', domain: 'suspilne.media', allowedDomains: ['suspilne.media'], url: 'https://suspilne.media/rss/all.rss', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'eurointegration-ua', name: 'Європейська правда', domain: 'eurointegration.com.ua', allowedDomains: ['eurointegration.com.ua', 'pravda.com.ua'], url: 'https://www.eurointegration.com.ua/rss/', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'bbc-world', name: 'BBC News World', domain: 'bbc.com', allowedDomains: ['bbc.com', 'bbc.co.uk'], url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'guardian-world', name: 'The Guardian World', domain: 'theguardian.com', allowedDomains: ['theguardian.com'], url: 'https://www.theguardian.com/world/rss', category: 'politics', licenseMode: 'headline_link' },

  // Economy, Personal Finance & Career
  { slug: 'epravda-ua', name: 'Економічна правда', domain: 'epravda.com.ua', allowedDomains: ['epravda.com.ua', 'pravda.com.ua'], url: 'https://www.epravda.com.ua/rss/', category: 'economy', licenseMode: 'headline_link' },
  { slug: 'bbc-business', name: 'BBC Business', domain: 'bbc.com', allowedDomains: ['bbc.com', 'bbc.co.uk'], url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'finance', licenseMode: 'headline_link' },
  { slug: 'cnbc-finance', name: 'CNBC Finance', domain: 'cnbc.com', allowedDomains: ['cnbc.com'], url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', category: 'finance', licenseMode: 'headline_link' },

  // Science, Space & Climate
  { slug: 'nasa-breaking-news', name: 'NASA Breaking News', domain: 'nasa.gov', allowedDomains: ['nasa.gov', 'science.nasa.gov', 'blogs.nasa.gov'], url: 'https://www.nasa.gov/news-release/feed/', category: 'science_space', licenseMode: 'full_text_licensed' },
  { slug: 'space-com', name: 'Space.com', domain: 'space.com', allowedDomains: ['space.com'], url: 'https://www.space.com/feeds/all', category: 'science_space', licenseMode: 'headline_link' },
  { slug: 'sciencedaily-science', name: 'ScienceDaily', domain: 'sciencedaily.com', allowedDomains: ['sciencedaily.com'], url: 'https://www.sciencedaily.com/rss/top/science.xml', category: 'science_space', licenseMode: 'headline_link' },
  { slug: 'ars-technica-science', name: 'Ars Technica Science', domain: 'arstechnica.com', allowedDomains: ['arstechnica.com', 'feeds.arstechnica.com'], url: 'https://feeds.arstechnica.com/arstechnica/science', category: 'science_space', licenseMode: 'headline_link' },
  { slug: 'nature-news', name: 'Nature News', domain: 'nature.com', allowedDomains: ['nature.com', 'feeds.nature.com'], url: 'https://www.nature.com/nature.rss', category: 'science_space', licenseMode: 'headline_link' },

  // Health, Longevity & Psychology
  { slug: 'bbc-health', name: 'BBC Health', domain: 'bbc.com', allowedDomains: ['bbc.com', 'bbc.co.uk'], url: 'https://feeds.bbci.co.uk/news/health/rss.xml', category: 'health', licenseMode: 'headline_link' },
  { slug: 'sciencedaily-health', name: 'ScienceDaily Health', domain: 'sciencedaily.com', allowedDomains: ['sciencedaily.com'], url: 'https://www.sciencedaily.com/rss/top/health.xml', category: 'health', licenseMode: 'headline_link' },
  { slug: 'psypost-psychology', name: 'PsyPost Psychology', domain: 'psypost.org', allowedDomains: ['psypost.org'], url: 'https://www.psypost.org/feed/', category: 'psychology', licenseMode: 'headline_link' },

  // Culture, Cinema, Music & Gaming
  { slug: 'bbc-culture', name: 'BBC Culture & Arts', domain: 'bbc.com', allowedDomains: ['bbc.com', 'bbc.co.uk'], url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', category: 'culture', licenseMode: 'headline_link' },
  { slug: 'guardian-culture', name: 'The Guardian Culture', domain: 'theguardian.com', allowedDomains: ['theguardian.com'], url: 'https://www.theguardian.com/uk/culture/rss', category: 'culture', licenseMode: 'headline_link' },
  { slug: 'eurogamer', name: 'Eurogamer', domain: 'eurogamer.net', allowedDomains: ['eurogamer.net'], url: 'https://www.eurogamer.net/feed', category: 'hardware_gaming', licenseMode: 'headline_link' },

  // Ukraine Tech, Startups & Education
  { slug: 'itc-ua', name: 'ITC.ua', domain: 'itc.ua', allowedDomains: ['itc.ua'], url: 'https://itc.ua/ua/feed/', category: 'global_tech', licenseMode: 'headline_link' },
  { slug: 'dou-ua', name: 'DOU.ua', domain: 'dou.ua', allowedDomains: ['dou.ua', 'gamedev.dou.ua', 'jobs.dou.ua'], url: 'https://dou.ua/feed/', category: 'career', licenseMode: 'headline_link' },
  { slug: 'dev-ua', name: 'Dev.ua', domain: 'dev.ua', allowedDomains: ['dev.ua'], url: 'https://dev.ua/rss', category: 'global_tech', licenseMode: 'headline_link' },
  { slug: 'techcrunch-startups', name: 'TechCrunch Startups', domain: 'techcrunch.com', allowedDomains: ['techcrunch.com'], url: 'https://techcrunch.com/category/startups/feed/', category: 'startups_fintech', licenseMode: 'headline_link' },
  { slug: 'yc-blog', name: 'Y Combinator Blog', domain: 'ycombinator.com', allowedDomains: ['ycombinator.com', 'blog.ycombinator.com'], url: 'https://www.ycombinator.com/blog/rss', category: 'startups_fintech', licenseMode: 'headline_link' },

  // Cybersecurity, Cloud, Hardware & Dev
  { slug: 'the-hacker-news', name: 'The Hacker News', domain: 'thehackernews.com', allowedDomains: ['thehackernews.com', 'feeds.feedburner.com'], url: 'https://feeds.feedburner.com/TheHackersNews', category: 'cybersecurity', licenseMode: 'headline_link' },
  { slug: 'cloudflare-blog', name: 'Cloudflare Blog', domain: 'blog.cloudflare.com', allowedDomains: ['blog.cloudflare.com', 'cloudflare.com'], url: 'https://blog.cloudflare.com/rss/', category: 'cybersecurity', licenseMode: 'summary' },
  { slug: 'github-blog', name: 'GitHub Blog', domain: 'github.blog', allowedDomains: ['github.blog', 'github.com'], url: 'https://github.blog/feed/', category: 'coding', licenseMode: 'summary' },
  { slug: 'toms-hardware', name: "Tom's Hardware", domain: 'tomshardware.com', allowedDomains: ['tomshardware.com'], url: 'https://www.tomshardware.com/feeds/all', category: 'hardware_gaming', licenseMode: 'headline_link' },

  // AI Frontier & Developer Ecosystems
  { slug: 'anthropic-news-community-feed', alias: 'anthropic-news', name: 'Anthropic', domain: 'anthropic.com', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml', category: 'model', providerId: 'claude', unofficial: true, licenseMode: 'headline_link' },
  { slug: 'openai-news', name: 'OpenAI', domain: 'openai.com', url: 'https://openai.com/news/rss.xml', category: 'model', providerId: 'openai', licenseMode: 'summary' },
  { slug: 'google-deepmind', name: 'Google DeepMind', domain: 'deepmind.google', allowedDomains: ['deepmind.google', 'blog.google', 'ai.google.dev'], url: 'https://deepmind.google/blog/rss.xml', category: 'model', providerId: 'gemini', licenseMode: 'summary' },
  { slug: 'google-ai-blog', name: 'Google AI Blog', domain: 'blog.google', allowedDomains: ['blog.google', 'deepmind.google', 'ai.google.dev'], url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', category: 'model', providerId: 'gemini', licenseMode: 'summary' },
  { slug: 'google-research', name: 'Google Research', domain: 'research.google', allowedDomains: ['research.google', 'blog.google'], url: 'https://research.google/blog/rss/', category: 'research', providerId: 'gemini', licenseMode: 'summary' },
  { slug: 'mistral-ai-community-feed', alias: 'mistral-ai', name: 'Mistral AI', domain: 'mistral.ai', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_mistral.xml', category: 'model', providerId: 'mistral', unofficial: true, licenseMode: 'headline_link' },
  { slug: 'hugging-face', name: 'Hugging Face', domain: 'huggingface.co', url: 'https://huggingface.co/blog/feed.xml', category: 'open_source', providerId: 'huggingface', licenseMode: 'full_text_licensed' },
  { slug: 'aws-ml', name: 'AWS Machine Learning', domain: 'aws.amazon.com', url: 'https://aws.amazon.com/blogs/machine-learning/feed/', category: 'api', licenseMode: 'summary' },
  { slug: 'claude-code-releases', name: 'Claude Code Releases', domain: 'github.com', url: 'https://github.com/anthropics/claude-code/releases.atom', category: 'coding', providerId: 'claude', licenseMode: 'full_text_licensed' },
  { slug: 'openai-python-sdk', name: 'OpenAI Python SDK', domain: 'github.com', url: 'https://github.com/openai/openai-python/releases.atom', category: 'api', providerId: 'openai', licenseMode: 'full_text_licensed' },
  { slug: 'ollama-releases', name: 'Ollama Releases', domain: 'github.com', url: 'https://github.com/ollama/ollama/releases.atom', category: 'open_source', licenseMode: 'full_text_licensed' },
  { slug: 'vllm-releases', name: 'vLLM Releases', domain: 'github.com', url: 'https://github.com/vllm-project/vllm/releases.atom', category: 'open_source', licenseMode: 'full_text_licensed' },
];

export const DEFAULT_FEEDS = COMPANY_FEED_CATALOG;

const refreshInterval = 10 * 60_000;
const retryInterval = 60_000;
const maxStaleAge = 24 * 60 * 60_000;
const maxFeedBytes = 4 * 1024 * 1024;
const articlesPerFeed = 20;
export const companyFeeds = COMPANY_FEED_CATALOG;
export const maxFeedArticles = 350;

export function isPublishedWithinHours(
  publishedAt: string | Date | null | undefined,
  hours = 24,
): boolean {
  if (!publishedAt) return false;
  const ts = publishedAt instanceof Date ? publishedAt.getTime() : Date.parse(publishedAt);
  if (!Number.isFinite(ts)) return false;
  const ageMs = Date.now() - ts;
  return ageMs >= -15 * 60 * 1000 && ageMs <= hours * 60 * 60 * 1000;
}

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
  source_is_unofficial?: boolean;
  license_mode?: LicenseMode;
};

type FeedState = {
  items: FeedArticle[];
  fetchedAt: number;
  refreshAt: number;
  etag?: string;
  lastModified?: string;
  ttlMs?: number;
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

    const intervalMs = Math.max(3 * 60_000, Number(process.env.FEED_POLL_INTERVAL_MS) || refreshInterval);
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
      // Disable legacy dead xAI community feed if present in DB
      await this.db.query(
        `UPDATE sources SET enabled = false, last_error = 'Feed discontinued (HTTP 404)' WHERE slug = 'xai-news-community-feed' AND enabled = true`,
      ).catch(() => undefined);

      for (const feed of DEFAULT_FEEDS) {
        await this.db.query(`
          INSERT INTO sources (slug, name, homepage_url, feed_url, unofficial, enabled, category, provider_id, auto_discovered, allowed_domains, license_mode, review_status)
          VALUES ($1, $2, $3, $4, $5, true, $6, $7, false, $8::jsonb, $9, 'approved')
          ON CONFLICT (slug) DO UPDATE SET
            feed_url = COALESCE(sources.feed_url, EXCLUDED.feed_url),
            category = CASE WHEN sources.category = 'other' THEN EXCLUDED.category ELSE sources.category END,
            provider_id = COALESCE(sources.provider_id, EXCLUDED.provider_id),
            allowed_domains = CASE WHEN sources.allowed_domains = '[]'::jsonb THEN EXCLUDED.allowed_domains ELSE sources.allowed_domains END,
            license_mode = COALESCE(sources.license_mode, EXCLUDED.license_mode)
        `, [
          feed.slug,
          feed.name,
          `https://${feed.domain}`,
          feed.url,
          feed.unofficial ?? false,
          feed.category || 'other',
          feed.providerId || null,
          JSON.stringify(feed.allowedDomains || [feed.domain]),
          feed.licenseMode || 'headline_link',
        ]).catch(async () => {
          // Fallback before migration 013 adds license_mode / review_status
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
        });
      }
    } catch (error) {
      this.logger.warn(`Could not seed default sources: ${error instanceof Error ? error.message : error}`);
    }
  }

  async reloadFeedsFromDatabase(): Promise<void> {
    try {
      let rows: Array<{
        slug: string;
        name: string;
        homepage_url: string;
        feed_url: string | null;
        unofficial: boolean;
        category: string | null;
        provider_id: string | null;
        auto_discovered: boolean;
        allowed_domains: string[] | null;
        license_mode?: LicenseMode | null;
        feed_etag?: string | null;
        feed_last_modified?: string | null;
        retry_after?: string | null;
      }> = [];

      try {
        const res = await this.db.query<typeof rows[number]>(`
          SELECT slug, name, homepage_url, feed_url, unofficial, category, provider_id, auto_discovered, allowed_domains,
                 license_mode, feed_etag, feed_last_modified, retry_after::text AS retry_after
          FROM sources
          WHERE enabled = true
            AND COALESCE(review_status, 'approved') = 'approved'
            AND feed_url IS NOT NULL
            AND feed_url LIKE 'https://%'
          ORDER BY auto_discovered ASC, name ASC
        `);
        rows = res.rows;
      } catch {
        const res = await this.db.query<typeof rows[number]>(`
          SELECT slug, name, homepage_url, feed_url, unofficial, category, provider_id, auto_discovered, allowed_domains
          FROM sources
          WHERE enabled = true AND feed_url IS NOT NULL AND feed_url LIKE 'https://%'
          ORDER BY auto_discovered ASC, name ASC
        `);
        rows = res.rows;
      }

      if (rows.length > 0) {
        const catalogMap = new Map(DEFAULT_FEEDS.map(f => [f.slug, f]));
        this.activeFeeds = rows.map(row => {
          const parsedHome = URL.parse(row.homepage_url);
          const domain = parsedHome?.hostname.replace(/^www\./, '') || '';
          const allowed = Array.isArray(row.allowed_domains) && row.allowed_domains.length
            ? row.allowed_domains
            : domain ? [domain] : [];
          const catalogMatch = catalogMap.get(row.slug);
          const existingState = this.cache.get(row.slug);
          if (existingState) {
            if (!existingState.etag && row.feed_etag) existingState.etag = row.feed_etag;
            if (!existingState.lastModified && row.feed_last_modified) existingState.lastModified = row.feed_last_modified;
            const retryTs = row.retry_after ? Date.parse(row.retry_after) : NaN;
            if (Number.isFinite(retryTs) && retryTs > existingState.refreshAt) {
              existingState.refreshAt = retryTs;
            }
          }
          return {
            slug: row.slug,
            alias: catalogMatch?.alias,
            name: row.name,
            domain,
            allowedDomains: allowed,
            url: row.feed_url!,
            category: row.category || 'other',
            providerId: row.provider_id || undefined,
            unofficial: row.unofficial,
            autoDiscovered: row.auto_discovered,
            licenseMode: row.license_mode || catalogMatch?.licenseMode || 'headline_link',
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
    const batches: Array<FeedArticle[] | undefined> = [];
    const concurrency = 8;
    for (let i = 0; i < this.activeFeeds.length; i += concurrency) {
      const slice = this.activeFeeds.slice(i, i + concurrency);
      const res = await Promise.all(slice.map(feed => this.read(feed)));
      batches.push(...res);
    }
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
        unofficial: Boolean(feed.unofficial),
        licenseMode: feed.licenseMode || 'headline_link',
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
            if (status === 429) return false; // Never immediately retry 429; honor Retry-After
            if (typeof status === 'number') return isTransientHttpStatus(status);
            return err instanceof Error && /Timeout|Abort|fetch failed|ECONNRESET/i.test(err.message);
          },
        },
      );
      state.fetchedAt = Date.now();
      const baseRefresh = Math.max(
        3 * 60_000,
        Number(process.env.FEED_POLL_INTERVAL_MS) || refreshInterval,
        state.ttlMs || 0,
      );
      state.refreshAt = state.fetchedAt + baseRefresh;
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      void this.db.query(
        `UPDATE sources
         SET last_fetched_at = now(), last_error = NULL, consecutive_failures = 0,
             feed_etag = COALESCE($2, feed_etag),
             feed_last_modified = COALESCE($3, feed_last_modified),
             retry_after = NULL
         WHERE slug = $1`,
        [feed.slug, state.etag ?? null, state.lastModified ?? null],
      ).catch(() =>
        this.db.query(
          `UPDATE sources SET last_fetched_at = now(), last_error = NULL, consecutive_failures = 0 WHERE slug = $1`,
          [feed.slug],
        ).catch(() => undefined),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'request failed';
      const retryAfterMs = (error as { retryAfterMs?: number })?.retryAfterMs;
      state.lastError = msg;
      state.consecutiveFailures += 1;
      const backoff = retryAfterMs && retryAfterMs > 0
        ? retryAfterMs
        : Math.min(30 * 60_000, retryInterval * Math.min(12, state.consecutiveFailures));
      state.refreshAt = Date.now() + backoff;
      this.logger.warn(`${feed.name} feed (attempt #${state.consecutiveFailures}): ${msg}`);
      void this.db.query(
        `UPDATE sources SET last_fetched_at = now(), last_error = $2, consecutive_failures = $3, retry_after = $4 WHERE slug = $1`,
        [feed.slug, msg.slice(0, 300), state.consecutiveFailures, new Date(state.refreshAt).toISOString()],
      ).catch(() =>
        this.db.query(
          `UPDATE sources SET last_fetched_at = now(), last_error = $2, consecutive_failures = $3 WHERE slug = $1`,
          [feed.slug, msg.slice(0, 300), state.consecutiveFailures],
        ).catch(() => undefined),
      );
    } finally {
      state.pending = undefined;
    }
  }
}

export async function fetchAndParseFeedUrl(feed: FeedDefinition, state: Partial<FeedState> = {}): Promise<FeedArticle[]> {
  return loadFeed(feed, state as FeedState);
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) && secs >= 0 ? Math.min(60 * 60_000, secs * 1000) : undefined;
  }
  const targetTs = Date.parse(trimmed);
  if (Number.isFinite(targetTs)) {
    const delta = targetTs - Date.now();
    return delta > 0 ? Math.min(60 * 60_000, delta) : undefined;
  }
  return undefined;
}

function parseCacheControlMaxAgeMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const match = /\bmax-age=(\d+)\b/i.exec(headerValue);
  if (!match) return undefined;
  const secs = Number(match[1]);
  return Number.isFinite(secs) && secs > 0 ? Math.min(24 * 60 * 60_000, secs * 1000) : undefined;
}

function detectXmlCharset(bytes: Uint8Array, contentTypeHeader: string | null): string {
  const ctMatch = contentTypeHeader && /charset=([^;\s"']+)/i.exec(contentTypeHeader);
  if (ctMatch?.[1]) return ctMatch[1].trim().toLowerCase();
  const headAscii = Buffer.from(bytes.subarray(0, Math.min(512, bytes.length))).toString('latin1');
  const xmlEncMatch = /<\?xml[^>]*\bencoding=["']([^"']+)["']/i.exec(headAscii);
  if (xmlEncMatch?.[1]) return xmlEncMatch[1].trim().toLowerCase();
  return 'utf-8';
}

function decodeXmlBytes(bytes: Uint8Array, contentTypeHeader: string | null): string {
  const charset = detectXmlCharset(bytes, contentTypeHeader);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function decodeHtmlEntities(input: string): string {
  if (!input) return '';
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    pound: '£',
    euro: '€',
    yen: '¥',
    copy: '©',
    reg: '®',
    trade: '™',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    laquo: '«',
    raquo: '»',
    bull: '•',
    middot: '·',
  };
  let text = input;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = text
      .replace(/&#(\d+);/g, (_m, dec) => {
        const code = Number(dec);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : _m;
      })
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
        const code = Number.parseInt(hex, 16);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : _m;
      })
      .replace(/&([a-zA-Z]+);/g, (m, name) => named[name.toLowerCase()] ?? m);
    if (next === text) break;
    text = next;
  }
  return text;
}

async function loadFeed(feed: FeedDefinition, state: FeedState): Promise<FeedArticle[]> {
  const headers: Record<string, string> = {
    'User-Agent': getHonestUserAgent(),
    'Accept': 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml, */*',
  };
  if (state.etag) headers['If-None-Match'] = state.etag;
  if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;

  const response = await fetch(feed.url, { headers, signal: AbortSignal.timeout(10_000) });

  if (response.status === 304 && state.items && state.items.length > 0) {
    const cacheMaxAge = parseCacheControlMaxAgeMs(response.headers.get('cache-control'));
    if (cacheMaxAge) state.ttlMs = cacheMaxAge;
    return state.items;
  }

  if (!response.ok || !response.body) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    await response.body?.cancel();
    const err = new Error(`HTTP ${response.status}`) as Error & { status?: number; retryAfterMs?: number };
    err.status = response.status;
    if (retryAfterMs) err.retryAfterMs = retryAfterMs;
    throw err;
  }

  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  const cacheMaxAge = parseCacheControlMaxAgeMs(response.headers.get('cache-control'));
  if (etag) state.etag = etag;
  if (lastModified) state.lastModified = lastModified;
  if (cacheMaxAge) state.ttlMs = cacheMaxAge;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maxFeedBytes) throw new Error('Feed exceeds the size limit');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  const xml = decodeXmlBytes(combined, response.headers.get('content-type'));
  const parsedMeta = parseFeedXmlWithMeta(xml, feed);
  if (parsedMeta.ttlMs && (!state.ttlMs || parsedMeta.ttlMs > state.ttlMs)) {
    state.ttlMs = parsedMeta.ttlMs;
  }
  return parsedMeta.items;
}

/**
 * Parses RSS 2.0 (<rss><channel><item>), RSS 1.0 (<rdf:RDF><item>), and Atom (<feed><entry>) XML streams.
 */
export function parseFeedXml(xml: string, feed: FeedDefinition): FeedArticle[] {
  return parseFeedXmlWithMeta(xml, feed).items;
}

function parseFeedXmlWithMeta(
  xml: string,
  feed: FeedDefinition,
): { items: FeedArticle[]; ttlMs?: number } {
  const parser = new SaxesParser();
  const stack: string[] = [];
  const items = new Map<string, FeedArticle>();
  let fields: Record<string, string> = {};
  let mode: 'rss' | 'rdf' | 'atom' | null = null;
  let atomLink = '';
  let rdfItemAbout = '';
  let guidIsPermaLink: string | undefined;
  let channelTtlText = '';

  parser.on('doctype', () => { throw new Error('Unexpected XML doctype'); });
  parser.on('opentag', tag => {
    const name = tag.name.includes(':') ? tag.name.split(':').pop()! : tag.name;
    stack.push(name);
    if (stack.length === 1) {
      if (name === 'rss') mode = 'rss';
      else if (name === 'RDF') mode = 'rdf';
      else if (name === 'feed') mode = 'atom';
    }
    if (mode === 'rss' && stack.length === 3 && name === 'item') {
      fields = {};
      guidIsPermaLink = undefined;
    } else if (mode === 'rss' && stack.length === 4 && stack[2] === 'item' && name === 'guid') {
      guidIsPermaLink = tag.attributes.isPermaLink !== undefined ? String(tag.attributes.isPermaLink).toLowerCase() : undefined;
    } else if (mode === 'rdf' && stack.length === 2 && name === 'item') {
      fields = {};
      rdfItemAbout = String(tag.attributes['rdf:about'] || tag.attributes.about || '');
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
    if (mode === 'rss' && stack.length === 3 && stack[1] === 'channel' && stack[2] === 'ttl') {
      channelTtlText += part;
    } else if (mode === 'rss' && stack[1] === 'channel' && stack[2] === 'item') {
      const field = stack[3];
      if (
        field === 'title' ||
        field === 'link' ||
        field === 'guid' ||
        field === 'pubDate' ||
        field === 'date' ||
        field === 'description' ||
        field === 'encoded'
      ) {
        fields[field] = (fields[field] || '') + part;
      }
    } else if (mode === 'rdf' && stack[1] === 'item') {
      const field = stack[2];
      if (
        field === 'title' ||
        field === 'link' ||
        field === 'date' ||
        field === 'pubDate' ||
        field === 'description' ||
        field === 'encoded'
      ) {
        fields[field] = (fields[field] || '') + part;
      }
    } else if (mode === 'atom' && stack[1] === 'entry') {
      const field = stack[2];
      if (field === 'title' || field === 'published' || field === 'updated' || field === 'summary' || field === 'content' || field === 'id') {
        fields[field] = (fields[field] || '') + part;
      }
    }
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    const name = stack[stack.length - 1];
    if (mode === 'rss' && stack.length === 3 && stack[1] === 'channel' && name === 'item') {
      const guidLink =
        guidIsPermaLink !== 'false' && /^https:\/\//i.test((fields.guid || '').trim())
          ? fields.guid.trim()
          : '';
      const item = normalizeArticle(feed, {
        title: fields.title,
        link: fields.link || guidLink,
        pubDate: fields.pubDate || fields.date,
        description: fields.description || fields.encoded,
      });
      if (item && !items.has(item.canonical_url)) items.set(item.canonical_url, item);
    } else if (mode === 'rdf' && stack.length === 2 && name === 'item') {
      const item = normalizeArticle(feed, {
        title: fields.title,
        link: fields.link || rdfItemAbout,
        pubDate: fields.date || fields.pubDate,
        description: fields.description || fields.encoded,
      });
      if (item && !items.has(item.canonical_url)) items.set(item.canonical_url, item);
    } else if (mode === 'atom' && stack.length === 2 && name === 'entry') {
      const fallbackAtomId = /^https:\/\//i.test((fields.id || '').trim()) ? fields.id.trim() : '';
      const item = normalizeArticle(feed, {
        title: fields.title,
        link: atomLink || fallbackAtomId,
        pubDate: fields.published || fields.updated,
        description: fields.summary || fields.content,
      });
      if (item && !items.has(item.canonical_url)) items.set(item.canonical_url, item);
    }
    stack.pop();
  });

  parser.write(xml).close();
  if (!mode || items.size === 0) throw new Error('Feed contains no valid articles');

  const ttlMinutes = Number(channelTtlText.trim());
  const ttlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0
    ? Math.min(24 * 60 * 60_000, ttlMinutes * 60_000)
    : undefined;

  return {
    items: [...items.values()]
      .sort((a, b) => b.published_at.localeCompare(a.published_at))
      .slice(0, articlesPerFeed),
    ttlMs,
  };
}

function normalizeArticle(
  feed: FeedDefinition,
  raw: { title?: string; link?: string; pubDate?: string; description?: string },
): FeedArticle | undefined {
  const originalTitle = decodeHtmlEntities(raw.title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 350);
  const publishedAt = Date.parse((raw.pubDate || '').trim());
  const link = URL.parse((raw.link || '').trim());
  const allowed = (
    feed.allowedDomains && feed.allowedDomains.length > 0 ? feed.allowedDomains : [feed.domain]
  )
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);

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
  const hostOk = allowed.some(d => host === d || host.endsWith(`.${d}`));
  if (!hostOk) return;

  link.hash = '';
  const url = link.href;
  const canonical = canonicalizeUrl(url);
  const decodedSummary = decodeHtmlEntities(raw.description || '');
  const originalSummary = decodeHtmlEntities(decodedSummary.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2500);
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
    source_is_unofficial: Boolean(feed.unofficial),
    license_mode: feed.licenseMode || 'headline_link',
  };
}

function matchesBoundaryPattern(haystack: string, pattern: RegExp): boolean {
  return pattern.test(haystack);
}

export function classifyFeedArticleCategory(
  title: string,
  summary: string,
  fallbackCategory?: string,
): NewsCategory {
  const titleText = title || '';
  const haystack = `${titleText} ${summary || ''}`;

  // Documentary / cinema / books / arts take priority over accidental military/law word overlap in titles
  if (
    matchesBoundaryPattern(
      titleText,
      /(?<![\p{L}\p{N}])(documentary|movie|film|cinema|tv series|netflix|hbo|music album|festival|oscars|grammy|concert|book release|podcast|box office|документальн\p{L}*\s+фільм\p{L}*|кінофільм\p{L}*|фільм\p{L}*|серіал\p{L}*|музичн\p{L}*\s+альбом\p{L}*|фестивал\p{L}*|книжк\p{L}*|подкаст\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'culture';
  }

  // Developer tool / SDK / IDE / CLI release changelogs take priority before generic words
  if (
    matchesBoundaryPattern(
      titleText,
      /(?<![\p{L}\p{N}])(claude code|cursor|copilot|release notes|changelog|sdk|cli|v\d+\.\d+\.\d+)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'coding';
  }

  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(defen[cs]e|military|drone|uav|fpv|electronic warfare|brave1|missile|combat|battlefield|pentagon|radar|munitions|fighter jet|f-35|дрон\p{L}*|бпла|реб|оборон\p{L}*|військов\p{L}*|зсу|фронт(?:у|ом|і|овий|ова|ових)?|армі(?:я|ї|ю|єю|йськ\p{L}*)|міноборони)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'defense';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(cve-\d+|zero-day|0-day|ransomware|malware|phishing|breach|exploit|vulnerability|ddos|infosec|cybersecurity|threat actor|botnet|backdoor|authentication bypass|кібер\p{L}*|вразлив\p{L}*|злам\p{L}*|фішинг\p{L}*|шифрувальник\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'cybersecurity';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(tax|legislation|parliament|bill passed|border crossing|passport|visa|pension|social benefits|court ruling|decree|закон\p{L}*|податк\p{L}*|верховн\p{L}*\s+рад\p{L}*|документ(?:|а|у|ом|і|и|ів|ам|ами|ах)|кордон\p{L}*|соцвиплат\p{L}*|соціальн(?:і|их)\s+виплат\p{L}*|пільг\p{L}*|правосудд\p{L}*|правозахист\p{L}*|дія\.ситі)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'law';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(election|president|prime minister|treaty|sanctions|diplomacy|summit|geopolitics|foreign policy|ceasefire|eu accession|політик\p{L}*|вибор\p{L}*|дипломаті\p{L}*|санкці\p{L}*|саміт\p{L}*|міжнародн(?:і|их)\s+відносин\p{L}*|кабінет\p{L}*\s+міністр\p{L}*|євросоюз\p{L}*|нато|білий\s+дім|переговор\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'politics';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(nasa|spacex|spacecraft|rocket|orbit|mars|moon|telescope|jwst|astronomy|exoplanet|eclipse|comet|solar storm|geomagnetic|quantum|physics|biotech|crispr|genome|fusion|cern|climate|energy transition|космос\p{L}*|космонавтик\p{L}*|супутник\p{L}*|орбіт\p{L}*|телескоп\p{L}*|затемнен\p{L}*|комет\p{L}*|магнітн(?:і|а)\s+бур\p{L}*|квантов\p{L}*|клімат\p{L}*|енергетик\p{L}*|біотех\p{L}*|науков\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'science_space';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(sleep|longevity|nutrition|diet|fitness|cardiovascular|clinical trial|vaccine|symptom|diagnosis|diabetes|mental health|wellness|nhs|hospitals|patients|gp surgeries|медицин\p{L}*|довголітт\p{L}*|здоров\p{L}*|сон(?:у|ом|і)?|безсонн\p{L}*|харчуван\p{L}*|фізичн(?:а|ої)\s+активн\p{L}*|профілактик\p{L}*|серцев\p{L}*|дієт\p{L}*|лікар\p{L}*|клінічн\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'health';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(stress|burnout|anxiety|psychology|therapy|cognitive|habits|mindfulness|focus|productivity|sleep hygiene|психолог\p{L}*|стрес\p{L}*|вигоран\p{L}*|тривожн\p{L}*|звичк\p{L}*|ментальн\p{L}*|саморозвит\p{L}*|продуктивн\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'psychology';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(movie|film|cinema|tv series|streaming series|netflix|hbo|music album|festival|oscars|grammy|concert|book release|podcast|pop culture|viral trend|box office|кіно\p{L}*|фільм\p{L}*|серіал\p{L}*|музик\p{L}*|прем'єр\p{L}*|фестивал\p{L}*|книг\p{L}*|подкаст\p{L}*|поп-культур\p{L}*|шоу-біз\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'culture';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(nvidia rtx|geforce|radeon|gpu|cpu|ryzen|intel core|snapdragon|apple silicon|chipset|motherboard|ssd|playstation|ps5|xbox|nintendo|steam deck|gaming|game engine|unreal engine|fps|vr headset|video game|відеокарт\p{L}*|процесор\p{L}*|геймінг\p{L}*|консол\p{L}*|ігров\p{L}*|відеоіг\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'hardware_gaming';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(grant|fellowship|scholarship|hackathon|accelerator|funding call|horizon europe|erasmus|university|curriculum|bootcamp|student|mentorship|грант\p{L}*|стипенді\p{L}*|хакатон\p{L}*|акселератор\p{L}*|освіт\p{L}*|навчання|університет\p{L}*|студент\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'education_grants';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(seed round|series [a-d]|venture|vc fund|funding round|valuation|ipo|fintech|neobank|crypto|blockchain|stablecoin|payments|stripe|startup|y combinator|founder|стартап\p{L}*|раунд\p{L}*|венчур\p{L}*|фінтех\p{L}*|платіж\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'startups_fintech';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(exchange rate|currency|inflation|interest rate|mortgage|deposit|bond|treasury|real estate|housing market|personal finance|central bank|курс валют|долар\p{L}*|євро(?![\p{L}])|нбу|інфляц\p{L}*|депозит\p{L}*|кредит\p{L}*|іпотек\p{L}*|нерухоміст\p{L}*|облігаці\p{L}*|особист(?:і|их)\s+фінанс\p{L}*|заощаджен\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'finance';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(job market|salary|remote work|hiring|layoffs|career|small business|freelance|unemployment|in-demand skills|ринок праці|зарплат\p{L}*|вакансі\p{L}*|віддален(?:а|ої)\s+робот\p{L}*|професі\p{L}*|кар'єр\p{L}*|малий бізнес|фоп|працевлаштуван\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'career';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(gdp|economy|macroeconomy|trade balance|budget deficit|tariff|energy grid|industrial output|економік\p{L}*|ввп|бюджет\p{L}*|тариф\p{L}*|експорт\p{L}*|імпорт\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'economy';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(ide|copilot|code editor|compiler|typescript|python|rust|javascript|refactor|cli|pull request|github actions|sdk|debugging|devtools|claude code|cursor|програмуван\p{L}*|розробник\p{L}*|кодинг\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'coding';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(open[- ]source|open[- ]weight|apache 2\.0|mit license|hugging ?face|ollama|vllm|llama|weights released|github repo|відкрит(?:ий|ого)\s+код)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'open_source';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(api|endpoint|rate limit|latency|throughput|tokens per second|webhook|inference|cloud|serverless|workers|інференс\p{L}*|хмарн\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'api';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(llm|gpt-[\w.-]+|claude|gemini|grok|mistral|multimodal|foundation model|reasoning model|benchmark|evals|context window|fine-tun\p{L}*|нейромереж\p{L}*|мовн(?:а|ої)\s+модел\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'model';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(paper|arxiv|preprint|study|ablation|dataset|empirical|theorem|clinical|biotech|crispr|genome|досліджен\p{L}*|препринт\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'research';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(enterprise|revenue|profit|acquisition|merger|antitrust|regulation|eu ai act|partnership|market share|бізнес\p{L}*|виручк\p{L}*|регуляц\p{L}*|угода)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'business';
  }
  if (
    matchesBoundaryPattern(
      haystack,
      /(?<![\p{L}\p{N}])(tech industry|big tech|smartphone|telecom|5g|6g|ev|autonomous|robotics|infrastructure|data center|semiconductor|технологі\p{L}*|робототехн\p{L}*|дата-центр\p{L}*)(?![\p{L}\p{N}])/iu,
    )
  ) {
    return 'global_tech';
  }

  if (fallbackCategory && (CATEGORIES as readonly string[]).includes(fallbackCategory)) {
    return fallbackCategory as NewsCategory;
  }
  return 'other';
}
