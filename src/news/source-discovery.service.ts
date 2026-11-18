import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  canUseHydrogenQuota,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_HYDROGEN_MODEL,
  FALLBACK_GEMINI_MODELS,
  postGeminiGenerateContent,
} from '../common/gemini-client';
import {
  checkRobotsTxtPermission,
  getHonestUserAgent,
  isSafePublicHttpUrl,
  LicenseMode,
  resolveAndValidatePublicUrl,
} from '../common/source-compliance';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES, NewsCategory } from '../ingest/ingest.dto';
import {
  CompanyFeedsService,
  type FeedArticle,
  type FeedDefinition,
  fetchAndParseFeedUrl,
  isPublishedWithinHours,
} from './company-feeds.service';

interface CandidateFeed {
  name: string;
  homepageUrl: string;
  feedUrl?: string;
  category: NewsCategory;
  providerId?: string;
  unofficial?: boolean;
  rationaleUk?: string;
  language?: string;
}

export interface DiscoveryResult {
  proposed: number;
  verified: number;
  added: string[];
  autoApproved: string[];
  pendingReview: string[];
  rejected: string[];
  modelUsed?: string | null;
  pendingModeration?: number;
}

const discoverySchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          homepageUrl: { type: 'string' },
          feedUrl: { type: 'string' },
          category: { type: 'string', enum: [...CATEGORIES] },
          providerId: { type: 'string' },
          unofficial: { type: 'boolean' },
          language: { type: 'string' },
          rationaleUk: { type: 'string' },
        },
        required: ['name', 'homepageUrl', 'category', 'rationaleUk'],
      },
    },
  },
  required: ['candidates'],
};

const MAX_CANDIDATES_PER_RUN = 8;
const MAX_AUTO_ADDED_PER_RUN = 3;
const MAX_TOTAL_AUTO_SOURCES = 45;
const DISCOVERY_FRESHNESS_DAYS = 90;
const DISCOVERY_MOST_RECENT_DAYS = 30;
const DISCOVERY_ON_DEMAND_COOLDOWN_MS = 2 * 60 * 60_000;

export const DISALLOWED_DISCOVERY_ROOTS = new Set([
  'reddit.com',
  't.me',
  'telegram.me',
  'x.com',
  'twitter.com',
  'facebook.com',
  'fb.com',
  'instagram.com',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'linkedin.com',
  'pinterest.com',
  'news.google.com',
  'google.com',
  'msn.com',
  'yahoo.com',
  'bing.com',
  'medium.com',
  'substack.com',
  'github.com',
]);

export function assessDiscoveredFeedQuality(
  articles: FeedArticle[],
  homeHost: string,
  feedHost: string,
): { ok: boolean; reason?: string; recentArticles: FeedArticle[] } {
  const recentArticles = articles.filter(a =>
    isPublishedWithinHours(a.published_at, DISCOVERY_FRESHNESS_DAYS * 24),
  );
  if (recentArticles.length < 2) {
    return {
      ok: false,
      reason: `Insufficient recent articles within ${DISCOVERY_FRESHNESS_DAYS}d (${recentArticles.length})`,
      recentArticles,
    };
  }

  const hasVeryFresh = recentArticles.some(a =>
    isPublishedWithinHours(a.published_at, DISCOVERY_MOST_RECENT_DAYS * 24),
  );
  if (!hasVeryFresh) {
    return {
      ok: false,
      reason: `No article published within last ${DISCOVERY_MOST_RECENT_DAYS}d`,
      recentArticles,
    };
  }

  const normalizedTitles = new Set(
    recentArticles
      .map(a => (a.original_title || '').replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(t => t.length >= 15),
  );
  if (normalizedTitles.size < 2) {
    return {
      ok: false,
      reason: 'Fewer than 2 distinct meaningful titles (>= 15 chars)',
      recentArticles,
    };
  }

  const avgTitleLen =
    recentArticles.reduce((sum, a) => sum + (a.original_title || '').trim().length, 0) /
    Math.max(1, recentArticles.length);
  if (avgTitleLen < 18) {
    return {
      ok: false,
      reason: `Average title too short (${avgTitleLen.toFixed(1)})`,
      recentArticles,
    };
  }

  // Ensure articles mostly point back to the publisher site rather than an arbitrary link farm
  let sameSiteCount = 0;
  for (const a of recentArticles) {
    const itemHost = URL.parse(a.url)?.hostname?.toLowerCase().replace(/^www\./, '');
    if (
      itemHost &&
      (isSameSiteOrKnownFeedHost(homeHost, itemHost) || isSameSiteOrKnownFeedHost(feedHost, itemHost))
    ) {
      sameSiteCount += 1;
    }
  }
  const sameSiteRatio = sameSiteCount / recentArticles.length;
  if (sameSiteRatio < 0.5) {
    return {
      ok: false,
      reason: `External link aggregator ratio too high (${Math.round(sameSiteRatio * 100)}% on-site)`,
      recentArticles,
    };
  }

  return { ok: true, recentArticles };
}

export function extractAlternateFeedLinksFromHtml(
  html: string,
  baseHomepageUrl: string,
): string[] {
  const discovered: string[] = [];
  const seen = new Set<string>();
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];

  for (const tag of linkTags) {
    const relMatch = /\brel=["']([^"']+)["']/i.exec(tag);
    const typeMatch = /\btype=["']([^"']+)["']/i.exec(tag);
    const hrefMatch = /\bhref=["']([^"']+)["']/i.exec(tag);
    if (!hrefMatch?.[1]) continue;

    const relTokens = (relMatch?.[1] || '').toLowerCase().split(/\s+/);
    const mimeType = (typeMatch?.[1] || '').toLowerCase().trim();
    const isAlternateFeed =
      relTokens.includes('alternate') &&
      (mimeType === 'application/rss+xml' ||
        mimeType === 'application/atom+xml' ||
        mimeType === 'application/rdf+xml' ||
        mimeType === 'application/xml' ||
        mimeType === 'text/xml');
    if (!isAlternateFeed) continue;

    try {
      const resolved = new URL(hrefMatch[1].trim(), baseHomepageUrl).href;
      if (isSafePublicHttpUrl(resolved) && !seen.has(resolved.toLowerCase())) {
        seen.add(resolved.toLowerCase());
        discovered.push(resolved);
      }
    } catch {
      // Ignore malformed href
    }
  }
  return discovered;
}

export function extractRootDomain(hostname: string): string {
  const clean = hostname.toLowerCase().replace(/^www\./, '');
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return clean;
  const sldTwoPart = new Set(['co.uk', 'org.uk', 'com.ua', 'org.ua', 'net.ua', 'gov.ua', 'edu.ua', 'co.jp', 'com.au']);
  const tail2 = parts.slice(-2).join('.');
  if (sldTwoPart.has(tail2) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return tail2;
}

export function isSameSiteOrKnownFeedHost(homeHost: string, feedHost: string): boolean {
  const cleanHome = homeHost.toLowerCase().replace(/^www\./, '');
  const cleanFeed = feedHost.toLowerCase().replace(/^www\./, '');
  if (cleanHome === cleanFeed) return true;
  if (cleanFeed.endsWith(`.${cleanHome}`) || cleanHome.endsWith(`.${cleanFeed}`)) return true;
  return extractRootDomain(cleanHome) === extractRootDomain(cleanFeed);
}

@Injectable()
export class SourceDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SourceDiscoveryService.name);
  private timer?: NodeJS.Timeout;
  private isDestroyed = false;
  private activeDiscovery?: Promise<DiscoveryResult>;
  private lastOnDemandAt = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly feeds: CompanyFeedsService,
  ) {}

  private get geminiKey(): string | undefined {
    return process.env.GEMINI_API_KEY?.trim();
  }

  private get preferredSmartModel(): string {
    const explicit = process.env.GEMINI_DISCOVERY_MODEL?.trim();
    if (explicit) return explicit;
    if (canUseHydrogenQuota()) return DEFAULT_HYDROGEN_MODEL;
    return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  }

  onModuleInit() {
    if (!this.geminiKey) return;
    const intervalMs = 12 * 60 * 60_000; // Every 12 hours
    const scheduleNext = () => {
      this.timer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.discoverAndVerify();
        } catch (err) {
          this.logger.warn(`Scheduled source discovery failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.isDestroyed) scheduleNext();
        }
      }, intervalMs);
    };
    // Run first discovery 90s after boot so startup stays fast
    this.timer = setTimeout(async () => {
      if (this.isDestroyed) return;
      try {
        await this.discoverAndVerify();
      } catch (err) {
        this.logger.warn(`Initial source discovery failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        if (!this.isDestroyed) scheduleNext();
      }
    }, 90_000);
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Non-blocking on-demand trigger when a category/feed lacks healthy sources or fresh items.
   */
  triggerDiscoveryIfNeeded(
    focusCategories?: string[],
    options?: { cooldownMs?: number; query?: string },
  ): boolean {
    if (!this.geminiKey || this.isDestroyed || this.activeDiscovery) return false;
    const cooldown = options?.cooldownMs ?? DISCOVERY_ON_DEMAND_COOLDOWN_MS;
    const now = Date.now();
    if (now - this.lastOnDemandAt < cooldown) return false;
    this.lastOnDemandAt = now;

    const cleanCategories = (focusCategories || []).filter(c =>
      (CATEGORIES as readonly string[]).includes(c),
    );
    void this.discoverAndVerify({
      ...(cleanCategories.length > 0 ? { focusCategories: cleanCategories } : {}),
      ...(options?.query ? { query: options.query } : {}),
    }).catch((err) => {
      this.logger.warn(`On-demand source discovery warning: ${err instanceof Error ? err.message : err}`);
    });
    return true;
  }

  async discoverAndVerify(options?: {
    focusCategories?: string[];
    query?: string;
    requireModeration?: boolean;
    lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
    fetchFn?: typeof fetch;
    parseFeedFn?: (feed: FeedDefinition) => Promise<FeedArticle[]>;
  }): Promise<DiscoveryResult> {
    if (!options && this.activeDiscovery) return this.activeDiscovery;
    const run = this.runDiscovery(options).finally(() => {
      if (!options) this.activeDiscovery = undefined;
    });
    if (!options) this.activeDiscovery = run;
    return run;
  }

  async listPendingSources() {
    try {
      const res = await this.db.query(
        `SELECT slug, name, homepage_url, feed_url, unofficial, enabled, category, provider_id,
                license_mode, review_status, discovery_rationale, created_at
         FROM sources
         WHERE review_status = 'pending_review'
         ORDER BY created_at DESC`,
      );
      return { items: res.rows };
    } catch {
      return { items: [] };
    }
  }

  async approveSource(slug: string, overrides?: { licenseMode?: LicenseMode; category?: NewsCategory }) {
    const cleanSlug = slug.trim().toLowerCase();
    const res = await this.db.query(
      `UPDATE sources
       SET review_status = 'approved',
           enabled = true,
           license_mode = COALESCE($2, license_mode),
           category = COALESCE($3, category),
           updated_at = now()
       WHERE slug = $1
       RETURNING slug, name, feed_url, enabled, review_status, license_mode, category`,
      [cleanSlug, overrides?.licenseMode ?? null, overrides?.category ?? null],
    );
    if (!res.rowCount) {
      return null;
    }
    await this.feeds.reloadFeedsFromDatabase();
    return res.rows[0];
  }

  async rejectSource(slug: string) {
    const cleanSlug = slug.trim().toLowerCase();
    const res = await this.db.query(
      `UPDATE sources
       SET review_status = 'rejected',
           enabled = false,
           updated_at = now()
       WHERE slug = $1
       RETURNING slug, name, enabled, review_status`,
      [cleanSlug],
    );
    if (!res.rowCount) {
      return null;
    }
    await this.feeds.reloadFeedsFromDatabase();
    return res.rows[0];
  }

  /** Counts root domains cited by recently published stories that are not yet monitored sources. */
  async mineReferencedDomains(
    knownRoots: Set<string>,
    rejectedRoots: Set<string>,
    minMentions = 3,
  ): Promise<Array<{ domain: string; mentions: number; category: NewsCategory }>> {
    const { rows } = await this.db.query<{ url: string; category: string | null }>(
      `SELECT src->>'url' AS url, n.category
       FROM news_items n,
            LATERAL jsonb_array_elements(
              COALESCE(n.ai_metadata->'article'->'sources', '[]'::jsonb)
              || COALESCE(n.ai_metadata->'grounding', '[]'::jsonb)
              || COALESCE(n.cluster_sources, '[]'::jsonb)
            ) AS src
       WHERE n.status = 'published' AND n.published_at >= now() - interval '14 days'
         AND jsonb_typeof(src) = 'object' AND src ? 'url'
       LIMIT 5000`,
    );
    const counts = new Map<string, { mentions: number; cats: Map<string, number>; host: string }>();
    for (const row of rows) {
      const host = URL.parse(row.url || '')?.hostname?.toLowerCase().replace(/^www\./, '');
      if (!host) continue;
      const root = extractRootDomain(host);
      if (knownRoots.has(root) || rejectedRoots.has(root) || DISALLOWED_DISCOVERY_ROOTS.has(root) || DISALLOWED_DISCOVERY_ROOTS.has(host)) continue;
      const entry = counts.get(root) ?? { mentions: 0, cats: new Map(), host: root };
      entry.mentions += 1;
      const cat = row.category || 'other';
      entry.cats.set(cat, (entry.cats.get(cat) || 0) + 1);
      counts.set(root, entry);
    }
    return [...counts.values()]
      .filter((e) => e.mentions >= minMentions)
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 4)
      .map((e) => {
        const category = ([...e.cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'other') as NewsCategory;
        return {
          domain: e.host,
          mentions: e.mentions,
          category: (CATEGORIES as readonly string[]).includes(category) ? category : 'other',
        };
      });
  }

  private async runDiscovery(options?: {
    focusCategories?: string[];
    query?: string;
    requireModeration?: boolean;
    lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
    fetchFn?: typeof fetch;
    parseFeedFn?: (feed: FeedDefinition) => Promise<FeedArticle[]>;
  }): Promise<DiscoveryResult> {
    const added: string[] = [];
    const autoApproved: string[] = [];
    const pendingReview: string[] = [];
    const rejected: string[] = [];

    if (!this.geminiKey) {
      return {
        proposed: 0,
        verified: 0,
        added,
        autoApproved,
        pendingReview,
        rejected,
        modelUsed: null,
        pendingModeration: 0,
      };
    }

    const existing = this.feeds.getActiveFeeds();
    const healthSnapshot = this.feeds.getHealthSnapshot?.() ?? [];
    const healthBySlug = new Map(healthSnapshot.map(h => [h.slug, h]));

    const existingUrls = new Set(existing.map(f => f.url.toLowerCase()));
    const existingSlugs = new Set(existing.map(f => f.slug.toLowerCase()));
    const existingRootDomains = new Set(existing.map(f => extractRootDomain(f.domain)));
    const existingRootCategoryPairs = new Set(
      existing.map(f => `${extractRootDomain(f.domain)}::${f.category || 'other'}`),
    );
    const rejectedRootDomains = new Set<string>();
    let existingAutoCount = 0;

    // Also include pending or rejected domains in DB so we never re-propose already reviewed/rejected feeds
    try {
      const dbKnown = await this.db.query<{
        slug: string;
        homepage_url: string;
        feed_url: string | null;
        category?: string | null;
        review_status?: string | null;
        auto_discovered?: boolean | null;
      }>(
        `SELECT slug, homepage_url, feed_url, category, review_status, auto_discovered FROM sources`,
      );
      for (const row of dbKnown.rows) {
        if (row.slug) existingSlugs.add(row.slug.toLowerCase());
        if (row.feed_url) existingUrls.add(row.feed_url.toLowerCase());
        if (row.auto_discovered) existingAutoCount += 1;
        const host = URL.parse(row.homepage_url)?.hostname;
        if (host) {
          const root = extractRootDomain(host);
          existingRootDomains.add(root);
          existingRootCategoryPairs.add(`${root}::${row.category || 'other'}`);
          if (row.review_status === 'rejected') {
            rejectedRootDomains.add(root);
          }
        }
      }
    } catch {
      // Ignore if DB query mock returns no rows or fails
    }

    // Gap analysis by category across HEALTHY active feeds (broken feeds do not count as coverage)
    const healthyCounts = new Map<string, number>();
    const brokenSources: string[] = [];
    for (const cat of CATEGORIES) {
      if (cat !== 'other') healthyCounts.set(cat, 0);
    }
    for (const f of existing) {
      const h = healthBySlug.get(f.slug);
      const isBroken = Boolean(
        h && (h.lastError || h.consecutiveFailures >= 3 || (h.fetchedAt && h.articleCount === 0)),
      );
      const cat = f.category || 'other';
      if (isBroken) {
        brokenSources.push(`${f.name} [${cat}]`);
      } else {
        healthyCounts.set(cat, (healthyCounts.get(cat) || 0) + 1);
      }
    }
    const underrepresentedCategories = [...healthyCounts.entries()]
      .filter(([, count]) => count <= 2)
      .sort((a, b) => a[1] - b[1])
      .map(([cat, count]) => `${cat} (${count} healthy feeds)`);

    const focusList = (options?.focusCategories || [])
      .filter(c => (CATEGORIES as readonly string[]).includes(c));

    const prompt = `You are a rigorous senior news-ecosystem archivist expanding a verified Ukrainian & international news reader (Play Market mass-market app).

Analyze our current monitored source list and fill underrepresented topic gaps logically WITHOUT hallucinating URLs.

Current active sources (${existing.length}):
${existing.map(f => `- ${f.name} [${f.category || 'other'}]: https://${f.domain} (${f.url})`).join('\n')}

Underrepresented categories needing authoritative healthy sources:
${focusList.length > 0 ? focusList.join(', ') : underrepresentedCategories.slice(0, 10).join(', ')}
${brokenSources.length > 0 ? `\nCurrently failing/empty feeds needing reliable alternatives:\n${brokenSources.slice(0, 8).join(', ')}` : ''}
${options?.query ? `\nSpecific curator focus request: ${options.query}` : ''}

Task: Propose up to 6 genuinely reputable, primary institutional, Ukrainian, or Tier-1 international publishers (official newsrooms, public broadcasters, university/research institutions, official product blogs) that:
1. Are NOT already represented in our list and NOT social networks/aggregators (never propose reddit, telegram, twitter/x, facebook, youtube, google news).
2. Publish active public RSS/Atom feeds linked on their official HTTPS website. We will automatically inspect the homepage's HTML <link rel="alternate"> tags and verify live articles (at least 2 articles, latest within 30 days), so provide the exact official HTTPS homepageUrl; include feedUrl ONLY if you are certain it exists on the same domain.
3. Have transparent editorial standards, zero clickbait/propaganda, and directly fill our topic gaps cleanly.
4. Provide a concise Ukrainian rationaleUk explaining WHY this source adds distinct, reliable coverage.`;

    let candidates: CandidateFeed[] = [];
    let modelUsed: string | null = null;
    const candidateModels = canUseHydrogenQuota()
      ? [this.preferredSmartModel, DEFAULT_GEMINI_MODEL, ...FALLBACK_GEMINI_MODELS]
      : [DEFAULT_GEMINI_MODEL, ...FALLBACK_GEMINI_MODELS];

    try {
      const res = await postGeminiGenerateContent({ priority: 'low',
        apiKey: this.geminiKey,
        preferredModel: candidateModels[0],
        candidateModels: [...new Set(candidateModels)],
        timeoutMs: 45_000,
        jsonSchemaWhenNoTools: discoverySchema,
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseJsonSchema: discoverySchema,
            maxOutputTokens: 2500,
          },
        },
      });
      modelUsed = res.modelUsed;
      const raw = res.data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = raw.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text) as { candidates?: CandidateFeed[] };
        candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      }
    } catch (error) {
      // Keep going: domains mined from our own articles below do not need Gemini.
      this.logger.warn(`Gemini source discovery request failed: ${error instanceof Error ? error.message : error}`);
    }

    // "Related sites": domains our published stories keep citing (editorial sources, search grounding,
    // multi-source clusters) but that we do not monitor yet. They pass the same RSS/robots/quality checks.
    if (!options?.query) {
      const mined = await this.mineReferencedDomains(existingRootDomains, rejectedRootDomains).catch(() => []);
      const known = new Set(candidates.map((c) => (URL.parse(c.homepageUrl || '')?.hostname || '').replace(/^www\./, '')));
      for (const m of mined) {
        if (!known.has(m.domain)) {
          candidates.unshift({
            name: m.domain,
            homepageUrl: `https://${m.domain}`,
            category: m.category,
            rationaleUk: `Сайт цитується у ${m.mentions} наших матеріалах за останні 14 днів.`,
          } as CandidateFeed);
        }
      }
    }

    const fetchImpl = options?.fetchFn ?? fetch;
    const parseFeedImpl = options?.parseFeedFn ?? ((f: FeedDefinition) => fetchAndParseFeedUrl(f));
    const requireModeration =
      options?.requireModeration ?? process.env.SOURCE_REQUIRE_MODERATION === 'true';

    let verified = 0;
    for (const candidate of candidates.slice(0, MAX_CANDIDATES_PER_RUN)) {
      const homeUrl = (candidate.homepageUrl || '').trim();
      const suggestedFeedUrl = (candidate.feedUrl || '').trim();
      const parsedHome = URL.parse(homeUrl);

      if (!parsedHome || !isSafePublicHttpUrl(homeUrl)) {
        rejected.push(suggestedFeedUrl || homeUrl || candidate.name);
        continue;
      }

      const homeHost = parsedHome.hostname.toLowerCase();
      const domain = homeHost.replace(/^www\./, '');
      const rootDomain = extractRootDomain(domain);
      const targetCategory: NewsCategory = (CATEGORIES as readonly string[]).includes(candidate.category)
        ? candidate.category
        : 'other';

      // Block social media, generic portals, apex blogging hubs, or previously rejected roots
      if (
        DISALLOWED_DISCOVERY_ROOTS.has(domain) ||
        (domain !== 'substack.com' &&
          domain !== 'medium.com' &&
          domain !== 'github.com' &&
          DISALLOWED_DISCOVERY_ROOTS.has(rootDomain)) ||
        rejectedRootDomains.has(rootDomain)
      ) {
        rejected.push(homeUrl);
        continue;
      }

      const slug = slugifySource(candidate.name || domain);
      if (
        existingSlugs.has(slug) ||
        existingRootCategoryPairs.has(`${rootDomain}::${targetCategory}`)
      ) {
        rejected.push(homeUrl);
        continue;
      }

      const dnsCheck = await resolveAndValidatePublicUrl(homeUrl, { lookupFn: options?.lookupFn });
      if (!dnsCheck.safe) {
        rejected.push(homeUrl);
        continue;
      }

      // Auto-discover real <link rel="alternate"> RSS/Atom links from the verified HTTPS homepage
      let discoveredFeedUrls: string[] = [];
      try {
        const robots = await checkRobotsTxtPermission(homeUrl, {
          userAgent: getHonestUserAgent(),
          fetchFn: fetchImpl,
        });
        if (!robots.allowed) {
          rejected.push(homeUrl);
          continue;
        }
        const homeResp = await fetchImpl(homeUrl, {
          headers: {
            'User-Agent': getHonestUserAgent(),
            'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(8_000),
        });
        if (homeResp.ok) {
          const homeHtml = (await homeResp.text()).slice(0, 200_000);
          discoveredFeedUrls = extractAlternateFeedLinksFromHtml(homeHtml, homeUrl);
        } else {
          await homeResp.body?.cancel();
        }
      } catch {
        // Continue to check same-site candidate feedUrl if homepage fetch timed out
      }

      const feedCandidates: string[] = [...discoveredFeedUrls];
      if (suggestedFeedUrl && isSafePublicHttpUrl(suggestedFeedUrl)) {
        const parsedSuggested = URL.parse(suggestedFeedUrl);
        if (
          parsedSuggested &&
          isSameSiteOrKnownFeedHost(homeHost, parsedSuggested.hostname) &&
          !feedCandidates.some(u => u.toLowerCase() === suggestedFeedUrl.toLowerCase())
        ) {
          feedCandidates.push(suggestedFeedUrl);
        }
      }

      let matchedFeedUrl: string | null = null;
      let matchedArticles: FeedArticle[] = [];

      for (const candidateUrl of feedCandidates.slice(0, 4)) {
        if (existingUrls.has(candidateUrl.toLowerCase())) continue;
        const feedDns = await resolveAndValidatePublicUrl(candidateUrl, { lookupFn: options?.lookupFn });
        if (!feedDns.safe) continue;

        const feedHost = new URL(candidateUrl).hostname.toLowerCase().replace(/^www\./, '');
        if (!isSameSiteOrKnownFeedHost(homeHost, feedHost)) continue;

        const feedRobots = await checkRobotsTxtPermission(candidateUrl, {
          userAgent: getHonestUserAgent(),
          fetchFn: fetchImpl,
        });
        if (!feedRobots.allowed) continue;

        const testFeed: FeedDefinition = {
          slug,
          name: (candidate.name || domain).trim().slice(0, 160),
          domain,
          allowedDomains: [...new Set([domain, feedHost])],
          url: candidateUrl,
          category: targetCategory,
          providerId: candidate.providerId?.trim() || undefined,
          unofficial: Boolean(candidate.unofficial),
          autoDiscovered: true,
          licenseMode: 'headline_link',
        };

        try {
          const articles = await parseFeedImpl(testFeed);
          const quality = assessDiscoveredFeedQuality(articles, domain, feedHost);
          if (quality.ok) {
            matchedFeedUrl = candidateUrl;
            matchedArticles = quality.recentArticles;
            break;
          }
        } catch {
          // Try next discovered feed link
        }
      }

      if (!matchedFeedUrl || matchedArticles.length < 2) {
        rejected.push(suggestedFeedUrl || homeUrl);
        continue;
      }

      verified += 1;
      const shouldAutoEnable =
        !requireModeration &&
        autoApproved.length < MAX_AUTO_ADDED_PER_RUN &&
        existingAutoCount + autoApproved.length < MAX_TOTAL_AUTO_SOURCES;
      const targetEnabled = shouldAutoEnable;
      const targetReviewStatus = shouldAutoEnable ? 'approved' : 'pending_review';

      const allowedDomains = [
        ...new Set([domain, new URL(matchedFeedUrl).hostname.toLowerCase().replace(/^www\./, '')]),
      ];
      const rationale = (candidate.rationaleUk || '').trim().slice(0, 600) || null;

      await this.db.query(`
        INSERT INTO sources (
          slug, name, homepage_url, feed_url, unofficial, enabled, category,
          provider_id, auto_discovered, allowed_domains, license_mode,
          review_status, discovery_rationale, last_fetched_at
        )
        VALUES ($1, $2, $3, $4, $5, $10, $6, $7, true, $8::jsonb, 'headline_link', $11, $9, now())
        ON CONFLICT (slug) DO NOTHING
      `, [
        slug,
        (candidate.name || domain).trim().slice(0, 160),
        `https://${domain}`,
        matchedFeedUrl,
        Boolean(candidate.unofficial),
        targetCategory,
        candidate.providerId?.trim() || null,
        JSON.stringify(allowedDomains),
        rationale,
        targetEnabled,
        targetReviewStatus,
      ]).catch(() =>
        // Pre-migration 013 safe fallback: keep enabled = targetEnabled (only for strictly quality-checked feeds)
        this.db.query(`
          INSERT INTO sources (slug, name, homepage_url, feed_url, unofficial, enabled, category, provider_id, auto_discovered, allowed_domains, last_fetched_at)
          VALUES ($1, $2, $3, $4, $5, $9, $6, $7, true, $8::jsonb, now())
          ON CONFLICT (slug) DO NOTHING
        `, [
          slug,
          (candidate.name || domain).trim().slice(0, 160),
          `https://${domain}`,
          matchedFeedUrl,
          Boolean(candidate.unofficial),
          targetCategory,
          candidate.providerId?.trim() || null,
          JSON.stringify(allowedDomains),
          targetEnabled,
        ]),
      );

      existingUrls.add(matchedFeedUrl.toLowerCase());
      existingSlugs.add(slug);
      existingRootCategoryPairs.add(`${rootDomain}::${targetCategory}`);
      added.push(slug);
      if (shouldAutoEnable) {
        autoApproved.push(slug);
      } else {
        pendingReview.push(slug);
      }
    }

    if (autoApproved.length > 0) {
      await this.feeds.reloadFeedsFromDatabase?.().catch(() => undefined);
      void this.feeds.pollAll?.(false).catch(() => undefined);
      this.logger.log(
        `Source discovery (${modelUsed || 'gemini'}) verified & auto-enabled ${autoApproved.length} source(s): ${autoApproved.join(', ')}`,
      );
    }
    if (pendingReview.length > 0) {
      this.logger.log(
        `Source discovery (${modelUsed || 'gemini'}) queued ${pendingReview.length} source(s) for moderation: ${pendingReview.join(', ')}`,
      );
    }

    return {
      proposed: candidates.length,
      verified,
      added,
      autoApproved,
      pendingReview,
      rejected,
      modelUsed,
      pendingModeration: pendingReview.length,
    };
  }
}

export function slugifySource(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 75);
  if (base.length >= 3) return base;
  return `src-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}
