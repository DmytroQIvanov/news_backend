import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { postGeminiGenerateContent } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES, NewsCategory } from '../ingest/ingest.dto';
import { CompanyFeedsService, type FeedDefinition, fetchAndParseFeedUrl } from './company-feeds.service';

interface CandidateFeed {
  name: string;
  homepageUrl: string;
  feedUrl: string;
  category: NewsCategory;
  providerId?: string;
  unofficial?: boolean;
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
        },
        required: ['name', 'homepageUrl', 'feedUrl', 'category'],
      },
    },
  },
  required: ['candidates'],
};

@Injectable()
export class SourceDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SourceDiscoveryService.name);
  private readonly geminiKey = process.env.GEMINI_API_KEY?.trim();
  private readonly geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-2.0-flash-lite';
  private timer?: NodeJS.Timeout;
  private isDestroyed = false;
  private activeDiscovery?: Promise<{ proposed: number; verified: number; added: string[]; rejected: string[] }>;

  constructor(
    private readonly db: DatabaseService,
    private readonly feeds: CompanyFeedsService,
  ) {}

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

  async discoverAndVerify(): Promise<{ proposed: number; verified: number; added: string[]; rejected: string[] }> {
    if (this.activeDiscovery) return this.activeDiscovery;
    this.activeDiscovery = this.runDiscovery().finally(() => {
      this.activeDiscovery = undefined;
    });
    return this.activeDiscovery;
  }

  private async runDiscovery(): Promise<{ proposed: number; verified: number; added: string[]; rejected: string[] }> {
    const added: string[] = [];
    const rejected: string[] = [];

    if (!this.geminiKey) {
      return { proposed: 0, verified: 0, added, rejected };
    }

    const existing = this.feeds.getActiveFeeds();
    const existingUrls = new Set(existing.map(f => f.url.toLowerCase()));
    const existingSlugs = new Set(existing.map(f => f.slug.toLowerCase()));

    const prompt = `You are a multi-domain Ukrainian and global news curator covering politics, legislation, economy & personal finance, labor market, science & space, evidence-based medicine & psychology, culture/cinema/games, defense, cybersecurity, and technology.
Already monitored feeds:
${existing.map(f => `- ${f.name}: ${f.url}`).join('\n')}

Suggest up to 6 additional real, publicly accessible HTTPS RSS or Atom feed URLs from reputable Ukrainian or international newsrooms across politics, law/economy, science/space, medicine/psychology, culture/cinema/gaming, or technology.
Rules:
- Only return real HTTPS RSS (.xml, /rss, /feed) or Atom URLs.
- Prioritize reputable general news, economics, science, health, psychology, and culture feeds over niche developer libraries.
- Do NOT repeat any URL from the already monitored list above.
- Do NOT invent URLs if unsure.`;

    let candidates: CandidateFeed[] = [];
    try {
      const { data } = await postGeminiGenerateContent({
        apiKey: this.geminiKey!,
        preferredModel: this.geminiModel,
        timeoutMs: 45_000,
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: discoverySchema,
            maxOutputTokens: 2000,
          },
        },
      });
      const raw = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = raw.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text) as { candidates?: CandidateFeed[] };
        candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      }
    } catch (error) {
      this.logger.warn(`Gemini source discovery request failed: ${error instanceof Error ? error.message : error}`);
      return { proposed: 0, verified: 0, added, rejected };
    }

    let verified = 0;
    for (const candidate of candidates.slice(0, 8)) {
      const feedUrl = (candidate.feedUrl || '').trim();
      const homeUrl = (candidate.homepageUrl || '').trim();
      const parsedFeed = URL.parse(feedUrl);
      const parsedHome = URL.parse(homeUrl);

      if (
        !parsedFeed ||
        parsedFeed.protocol !== 'https:' ||
        !parsedHome ||
        parsedHome.protocol !== 'https:' ||
        existingUrls.has(feedUrl.toLowerCase())
      ) {
        rejected.push(feedUrl || candidate.name);
        continue;
      }

      const slug = slugifySource(candidate.name || parsedHome.hostname);
      if (existingSlugs.has(slug)) {
        rejected.push(feedUrl);
        continue;
      }

      const domain = parsedHome.hostname.toLowerCase().replace(/^www\./, '');
      const feedHost = parsedFeed.hostname.toLowerCase().replace(/^www\./, '');
      const allowedDomains = [...new Set([domain, feedHost])];

      const testFeed: FeedDefinition = {
        slug,
        name: candidate.name.slice(0, 160),
        domain,
        allowedDomains,
        url: feedUrl,
        category: candidate.category || 'other',
        providerId: candidate.providerId?.trim() || undefined,
        unofficial: Boolean(candidate.unofficial),
        autoDiscovered: true,
      };

      try {
        const articles = await fetchAndParseFeedUrl(testFeed);
        if (!articles.length) {
          rejected.push(feedUrl);
          continue;
        }
        verified += 1;
        await this.db.query(`
          INSERT INTO sources (slug, name, homepage_url, feed_url, unofficial, enabled, category, provider_id, auto_discovered, allowed_domains, last_fetched_at)
          VALUES ($1, $2, $3, $4, $5, true, $6, $7, true, $8::jsonb, now())
          ON CONFLICT (slug) DO NOTHING
        `, [
          testFeed.slug,
          testFeed.name,
          `https://${domain}`,
          testFeed.url,
          testFeed.unofficial ?? false,
          testFeed.category || 'other',
          testFeed.providerId || null,
          JSON.stringify(allowedDomains),
        ]);
        existingUrls.add(feedUrl.toLowerCase());
        existingSlugs.add(slug);
        added.push(testFeed.slug);
      } catch {
        rejected.push(feedUrl);
      }
    }

    if (added.length > 0) {
      await this.feeds.reloadFeedsFromDatabase();
      this.logger.log(`Source discovery verified and added ${added.length} new feeds: ${added.join(', ')}`);
    }

    return { proposed: candidates.length, verified, added, rejected };
  }
}

export function slugifySource(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 75);
  if (base.length >= 3) return base;
  return `src-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}
