import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';

const feeds = [
  { slug: 'anthropic-news-community-feed', alias: 'anthropic-news', name: 'Anthropic', domain: 'anthropic.com', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml' },
  { slug: 'openai-news', name: 'OpenAI', domain: 'openai.com', url: 'https://openai.com/news/rss.xml' },
  { slug: 'google-deepmind', name: 'Google DeepMind', domain: 'deepmind.google', url: 'https://deepmind.google/blog/rss.xml' },
  { slug: 'mistral-ai-community-feed', alias: 'mistral-ai', name: 'Mistral AI', domain: 'mistral.ai', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_mistral.xml' },
  { slug: 'hugging-face', name: 'Hugging Face', domain: 'huggingface.co', url: 'https://huggingface.co/blog/feed.xml' },
];

const refreshInterval = 60_000; // 1 minute active polling cadence
const retryInterval = 30_000;  // 30s retry on failure
const maxStaleAge = 24 * 60 * 60_000;
const maxFeedBytes = 4 * 1024 * 1024;
const articlesPerFeed = 20;
export const maxFeedArticles = feeds.length * articlesPerFeed;
export const companyFeeds = feeds;

type Feed = typeof feeds[number];
type Article = { id: string; url: string; original_title: string; original_summary: string; published_at: string; source_name: string; source_slug: string };
type FeedState = { items: Article[]; fetchedAt: number; refreshAt: number; etag?: string; lastModified?: string; pending?: Promise<void> };

@Injectable()
export class CompanyFeedsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CompanyFeedsService.name);
  private readonly cache = new Map<string, FeedState>();
  private pollTimer?: NodeJS.Timeout;
  private isDestroyed = false;

  onModuleInit() {
    // Automated background polling of all news feeds every 60 seconds (1 minute)
    const intervalMs = Math.max(30_000, Number(process.env.FEED_POLL_INTERVAL_MS) || refreshInterval);
    const scheduleNext = () => {
      this.pollTimer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.pollAll();
        } catch (error) {
          this.logger.warn(`1-minute news feeds polling cycle warning: ${error instanceof Error ? error.message : error}`);
        } finally {
          if (!this.isDestroyed) scheduleNext();
        }
      }, intervalMs);
    };

    // Initial poll 2 seconds after server boot
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

  async pollAll() {
    const batches = await Promise.all(feeds.map(feed => this.read(feed)));
    const total = batches.reduce((acc, items) => acc + (items?.length || 0), 0);
    this.logger.log(`Automatic 1-minute news poll completed: ${total} articles active across ${feeds.length} feeds.`);
  }

  async list(sources: string[]) {
    const selected = feeds.filter(feed => !sources.length || sources.includes(feed.slug) ||
      (feed.alias !== undefined && sources.includes(feed.alias)));
    const batches = await Promise.all(selected.map(feed => this.read(feed)));
    return { items: batches.flatMap(items => items ?? []), unavailable: batches.length > 0 && batches.every(items => !items) };
  }

  private async read(feed: Feed): Promise<Article[] | undefined> {
    let state = this.cache.get(feed.slug);
    if (!state) {
      state = { items: [], fetchedAt: 0, refreshAt: 0 };
      this.cache.set(feed.slug, state);
    }
    if (!state.pending && Date.now() >= state.refreshAt) state.pending = this.refresh(feed, state);
    await state.pending;
    return Date.now() - state.fetchedAt <= maxStaleAge ? state.items : undefined;
  }

  private async refresh(feed: Feed, state: FeedState): Promise<void> {
    try {
      state.items = await loadRss(feed, state);
      state.fetchedAt = Date.now();
      state.refreshAt = state.fetchedAt + refreshInterval;
    } catch (error) {
      this.logger.warn(`${feed.name} feed: ${error instanceof Error ? error.message : 'request failed'}`);
      state.refreshAt = Date.now() + retryInterval;
    } finally {
      state.pending = undefined;
    }
  }
}

async function loadRss(feed: Feed, state: FeedState): Promise<Article[]> {
  const headers: Record<string, string> = {
    'User-Agent': 'OpportunityRadar/1.0 (RSS Reader; 60s cadence)',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  };
  if (state.etag) headers['If-None-Match'] = state.etag;
  if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;

  const response = await fetch(feed.url, { headers, signal: AbortSignal.timeout(8_000) });

  if (response.status === 304 && state.items.length > 0) {
    // 304 Not Modified: return existing cached articles without reparsing
    return state.items;
  }

  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }

  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  if (etag) state.etag = etag;
  if (lastModified) state.lastModified = lastModified;

  const parser = new SaxesParser();
  const stack: string[] = [];
  const items = new Map<string, Article>();
  let fields: Record<string, string> = {};
  let rss = false;
  parser.on('doctype', () => { throw new Error('Unexpected XML doctype'); });
  parser.on('opentag', tag => {
    stack.push(tag.name);
    if (stack.length === 1) rss = tag.name === 'rss';
    if (stack.length === 3 && tag.name === 'item') fields = {};
  });
  const append = (part: string) => {
    const field = stack[3];
    if (rss && stack[1] === 'channel' && stack[2] === 'item' &&
        (field === 'title' || field === 'link' || field === 'pubDate' || field === 'description')) {
      fields[field] = (fields[field] || '') + part;
    }
  };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => {
    if (rss && stack.length === 3 && stack[1] === 'channel' && stack[2] === 'item') {
      const item = articleFromRss(feed, fields);
      if (item) items.set(item.url, item);
    }
    stack.pop();
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maxFeedBytes) throw new Error('RSS exceeds the size limit');
      parser.write(decoder.decode(chunk.value, { stream: true }));
    }
    parser.write(decoder.decode()).close();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!rss || items.size === 0) throw new Error('RSS contains no valid articles');

  return [...items.values()].sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, articlesPerFeed);
}

function articleFromRss(feed: Feed, fields: Record<string, string>): Article | undefined {
  const originalTitle = fields.title?.trim().slice(0, 350);
  const publishedAt = Date.parse(fields.pubDate);
  const link = URL.parse(fields.link?.trim() ?? '');
  if (!originalTitle || !Number.isFinite(publishedAt) || !link || link.protocol !== 'https:' ||
      link.username || link.password || link.port ||
      (link.hostname !== feed.domain && link.hostname !== `www.${feed.domain}`)) return;
  link.hash = '';
  const url = link.href;
  return {
    id: `rss-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`,
    url,
    original_title: originalTitle,
    original_summary: (fields.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2500),
    published_at: new Date(publishedAt).toISOString(),
    source_name: feed.name,
    source_slug: feed.slug,
  };
}
