import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DEFAULT_GEMINI_MODEL, postGeminiGenerateContent } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';
import { CompanyFeedsService } from './company-feeds.service';

export type MemeKind = 'meme' | 'joke' | 'satire';
export type MemePlatform = 'reddit' | 'bluesky' | 'x' | 'threads' | 'telegram' | 'web';

export interface NewsMemeItem {
  id: string;
  kind: MemeKind;
  platform: MemePlatform;
  titleUk: string;
  originalText: string;
  captionUk: string;
  punchlineUk?: string | null;
  author: string;
  community?: string | null;
  imageUrl?: string | null;
  sourceUrl: string;
  upvotes?: number | null;
  publishedAt: string;
  verificationStatus: 'live_public_api' | 'gemini_search_grounded';
}

export interface NewsMemesResponse {
  newsKey: string;
  articleUrl?: string | null;
  category: string;
  queryUsed: string;
  hasMemes: boolean;
  total: number;
  skipReasonUk: string | null;
  items: NewsMemeItem[];
  sourceMode: 'live_hybrid' | 'skipped' | 'none_found';
  cached: boolean;
  updatedAt: string;
}

export interface GetNewsMemesOptions {
  refresh?: boolean;
  query?: string;
  title?: string;
  category?: string;
  source?: string;
  summary?: string;
  skipLiveFetch?: boolean;
}

interface NewsMemeContext {
  newsKey: string;
  articleUrl: string | null;
  title: string;
  summary: string;
  category: string;
  sourceName: string | null;
}

const MEME_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MEME_CACHE_MAX = 400;
const MAX_MEMES_PER_ARTICLE = 6;

const ALLOWED_MEME_HOSTS = [
  'reddit.com',
  'old.reddit.com',
  'i.redd.it',
  'preview.redd.it',
  'redd.it',
  'bsky.app',
  'cdn.bsky.app',
  'x.com',
  'twitter.com',
  'pbs.twimg.com',
  'threads.net',
  't.me',
  'knowyourmeme.com',
  'i.kym-cdn.com',
  'imgflip.com',
  'i.imgflip.com',
  'imgur.com',
  'i.imgur.com',
  '9gag.com',
  'news.ycombinator.com',
];

const HUMOR_SUBREDDITS = new Set([
  'memes',
  'dankmemes',
  'programmerhumor',
  'funny',
  'me_irl',
  'technicallythetruth',
  'ukraine',
  'ukraina',
  'noncredibledefense',
  'localllama',
  'singularity',
  'chatgpt',
  'openai',
  'pcmasterrace',
  'gamingmemes',
  'wallstreetbets',
  'shitposting',
  'facepalm',
  'nottheonion',
]);

const TRAGEDY_SENSITIVITY_RE = /(?:\b(?:massacre|genocide|mass\s+casualties|fatalities|killed\s+\d+|dead\s+\d+|suicide|terrorist\s+attack)\b|загибл|померл|теракт|масов[а-яіїє]+\s+вбивств|катуван|жертв[а-яіїє]*\s+(?:обстріл|удар|атак))/i;
const HUMOR_SIGNAL_RE = /(\blol\b|\blmao\b|\bhaha\b|\bjoke\b|\bmeme\b|\bsatire\b|\bshitpost\b|😂|🤣|🤡|💀|😭|🙃|мем|жарт|смішн|анекдот|прикол|сатира|іроні)/i;

function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  const parsed = URL.parse(trimmed);
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return null;
  }
  return parsed.toString();
}

function isAllowedMemeHost(url: string, groundedUrls?: Set<string>): boolean {
  if (groundedUrls?.has(url)) return true;
  const host = URL.parse(url)?.hostname.toLowerCase().replace(/^www\./, '') || '';
  return ALLOWED_MEME_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

function normalizeKind(raw: unknown): MemeKind {
  const s = String(raw || '').toLowerCase();
  if (s === 'joke' || s === 'satire' || s === 'meme') return s;
  return 'meme';
}

function normalizePlatform(raw: unknown, url?: string): MemePlatform {
  const s = String(raw || '').toLowerCase();
  if (s === 'reddit' || s === 'bluesky' || s === 'x' || s === 'threads' || s === 'telegram') return s;
  const host = url ? (URL.parse(url)?.hostname.toLowerCase() || '') : '';
  if (host.includes('reddit.com') || host.includes('redd.it')) return 'reddit';
  if (host.includes('bsky.app')) return 'bluesky';
  if (host.includes('x.com') || host.includes('twitter.com')) return 'x';
  if (host.includes('threads.net')) return 'threads';
  if (host.includes('t.me')) return 'telegram';
  return 'web';
}

function extractMemeSearchQuery(title: string): string {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'after', 'over',
    'про', 'для', 'що', 'які', 'який', 'яка', 'як', 'від', 'при', 'під', 'над', 'після', 'через',
    'нове', 'нова', 'новий', 'нові', 'оновила', 'оновив', 'оголосила', 'повідомила',
  ]);
  const tokens = title
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !stopWords.has(w.toLowerCase()));
  return tokens.slice(0, 5).join(' ');
}

function makeItemId(url: string, text: string): string {
  return createHash('sha256').update(`${url}::${text.slice(0, 120)}`).digest('hex').slice(0, 16);
}

@Injectable()
export class NewsMemesService {
  private readonly logger = new Logger(NewsMemesService.name);
  private readonly memoryCache = new Map<string, { expiresAt: number; payload: NewsMemesResponse }>();
  private readonly key = process.env.GEMINI_API_KEY?.trim();

  constructor(
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly companyFeeds?: CompanyFeedsService,
  ) {}

  private get activeKey(): string | undefined {
    return this.key || process.env.GEMINI_API_KEY?.trim();
  }

  clearCacheForTests(): void {
    this.memoryCache.clear();
  }

  async getMemesForNews(id: string, options: GetNewsMemesOptions = {}): Promise<NewsMemesResponse> {
    const trimmedId = (id || '').trim();
    if (!trimmedId) {
      throw new NotFoundException('Article not found');
    }

    const context = await this.resolveNewsContext(trimmedId, options);
    const customQuery = options.query?.trim().slice(0, 120) || '';
    const queryUsed = customQuery || extractMemeSearchQuery(context.title);
    const cacheKey = customQuery
      ? `${context.newsKey}:q:${createHash('sha256').update(customQuery.toLowerCase()).digest('hex').slice(0, 12)}`
      : context.newsKey;

    if (!options.refresh) {
      const memHit = this.readMemoryCache(cacheKey);
      if (memHit) {
        return { ...memHit, cached: true };
      }

      const dbHit = await this.readDbCache(cacheKey);
      if (dbHit) {
        this.writeMemoryCache(cacheKey, dbHit);
        return { ...dbHit, cached: true };
      }
    }

    if (!customQuery && TRAGEDY_SENSITIVITY_RE.test(`${context.title} ${context.summary}`)) {
      const skipped: NewsMemesResponse = {
        newsKey: cacheKey,
        articleUrl: context.articleUrl,
        category: context.category,
        queryUsed,
        hasMemes: false,
        total: 0,
        skipReasonUk: 'Гумор і меми приховано через чутливий трагічний контекст новини.',
        items: [],
        sourceMode: 'skipped',
        cached: false,
        updatedAt: new Date().toISOString(),
      };
      this.writeMemoryCache(cacheKey, skipped);
      await this.writeDbCache(skipped);
      return skipped;
    }

    const collected: NewsMemeItem[] = [];

    if (!options.skipLiveFetch && queryUsed) {
      const [redditRes, bskyRes] = await Promise.allSettled([
        this.fetchRedditMemes(queryUsed, context),
        this.fetchBlueskyJokes(queryUsed, context),
      ]);

      if (redditRes.status === 'fulfilled') collected.push(...redditRes.value);
      if (bskyRes.status === 'fulfilled') collected.push(...bskyRes.value);

      if (this.activeKey && process.env.NODE_ENV !== 'test') {
        const geminiItems = await this.discoverMemesWithGemini(queryUsed, context).catch(() => []);
        collected.push(...geminiItems);
      }
    }

    const items = deduplicateMemeItems(collected).slice(0, MAX_MEMES_PER_ARTICLE);
    const translated = await this.enrichUkrainianCaptions(items, context);

    const payload: NewsMemesResponse = {
      newsKey: cacheKey,
      articleUrl: context.articleUrl,
      category: context.category,
      queryUsed,
      hasMemes: translated.length > 0,
      total: translated.length,
      skipReasonUk: translated.length > 0
        ? null
        : 'Для цієї новини поки не знайдено підтверджених публічних мемів чи жартів. Спробуйте уточнити пошуковий запит.',
      items: translated,
      sourceMode: translated.length > 0 ? 'live_hybrid' : 'none_found',
      cached: false,
      updatedAt: new Date().toISOString(),
    };

    this.writeMemoryCache(cacheKey, payload);
    await this.writeDbCache(payload);
    return payload;
  }

  private async resolveNewsContext(id: string, options: GetNewsMemesOptions): Promise<NewsMemeContext> {
    if (this.db) {
      try {
        const { rows } = await this.db.query<{
          id: string;
          external_id: string;
          url: string;
          title_uk: string | null;
          original_title: string;
          summary_uk: string | null;
          original_summary: string | null;
          category: string;
          source_name: string | null;
        }>(
          `SELECT n.id::text, n.external_id, n.url, n.title_uk, n.original_title,
                  n.summary_uk, n.original_summary, n.category, s.name AS source_name
           FROM news_items n
           JOIN sources s ON s.id = n.source_id
           WHERE n.id::text = $1 OR n.external_id = $1
           LIMIT 1`,
          [id],
        );
        const row = rows[0];
        if (row) {
          return {
            newsKey: String(row.id || id),
            articleUrl: row.url,
            title: row.title_uk || row.original_title,
            summary: row.summary_uk || row.original_summary || '',
            category: row.category || options.category || 'other',
            sourceName: row.source_name,
          };
        }
      } catch {
        // Fall through to RSS or query fallback
      }
    }

    if (this.companyFeeds) {
      try {
        const feeds = await this.companyFeeds.list(options.source ? [options.source] : []);
        const rssItem = feeds.items.find((entry) => entry.id === id);
        if (rssItem) {
          return {
            newsKey: rssItem.id,
            articleUrl: rssItem.url,
            title: rssItem.original_title,
            summary: rssItem.original_summary || '',
            category: rssItem.category || options.category || 'other',
            sourceName: rssItem.source_name,
          };
        }
      } catch {
        // Fall through
      }
    }

    if (options.title && options.title.trim()) {
      return {
        newsKey: id,
        articleUrl: null,
        title: options.title.trim().slice(0, 350),
        summary: (options.summary || '').trim().slice(0, 1500),
        category: (options.category || 'other').trim().toLowerCase(),
        sourceName: options.source || null,
      };
    }

    throw new NotFoundException('Article not found');
  }

  private async fetchRedditMemes(query: string, context: NewsMemeContext): Promise<NewsMemeItem[]> {
    try {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=top&t=month&limit=16&raw_json=1`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'OpportunityRadar/1.0 (public meme search)', Accept: 'application/json' },
        signal: AbortSignal.timeout(4_000),
      });
      if (!resp.ok) return [];

      const json = (await resp.json()) as {
        data?: {
          children?: Array<{
            data?: {
              id?: string;
              title?: string;
              selftext?: string;
              permalink?: string;
              url?: string;
              url_overridden_by_dest?: string;
              subreddit?: string;
              author?: string;
              ups?: number;
              over_18?: boolean;
              post_hint?: string;
              created_utc?: number;
              preview?: { images?: Array<{ source?: { url?: string } }> };
            };
          }>;
        };
      };

      const out: NewsMemeItem[] = [];
      for (const child of json.data?.children ?? []) {
        const post = child.data;
        if (!post || post.over_18) continue;
        const title = (post.title || '').replace(/\s+/g, ' ').trim();
        const selftext = (post.selftext || '').replace(/\s+/g, ' ').trim();
        const sub = (post.subreddit || '').trim();
        const subLower = sub.toLowerCase();
        const ups = Number(post.ups) || 0;
        const permalink = post.permalink ? `https://www.reddit.com${post.permalink}` : '';
        const sourceUrl = safeHttpsUrl(permalink);
        if (!sourceUrl || title.length < 6) continue;

        const rawImage =
          post.post_hint === 'image'
            ? post.url_overridden_by_dest || post.url
            : post.preview?.images?.[0]?.source?.url || post.url_overridden_by_dest;
        const candidateImage = safeHttpsUrl(rawImage);
        const imageUrl =
          candidateImage && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(candidateImage)
            ? candidateImage
            : candidateImage && (candidateImage.includes('i.redd.it') || candidateImage.includes('preview.redd.it'))
              ? candidateImage
              : null;

        const isHumorSub = HUMOR_SUBREDDITS.has(subLower);
        const hasHumorSignal = HUMOR_SIGNAL_RE.test(`${title} ${selftext}`);
        const isMemeImage = Boolean(imageUrl) && (isHumorSub || hasHumorSignal || ups >= 25);
        if (!isHumorSub && !hasHumorSignal && !isMemeImage) continue;

        const kind: MemeKind = imageUrl ? 'meme' : 'joke';
        const originalText = selftext ? `${title}\n${selftext.slice(0, 320)}` : title;
        const publishedAt = post.created_utc
          ? new Date(post.created_utc * 1000).toISOString()
          : new Date().toISOString();

        out.push({
          id: makeItemId(sourceUrl, originalText),
          kind,
          platform: 'reddit',
          titleUk: title.slice(0, 180),
          originalText: originalText.slice(0, 480),
          captionUk: selftext
            ? `${title.slice(0, 120)} — ${selftext.slice(0, 220)}`
            : `Популярний пост у r/${sub || 'reddit'} щодо теми «${context.title.slice(0, 80)}».`,
          punchlineUk: selftext ? selftext.slice(0, 220) : null,
          author: post.author ? `u/${post.author}` : 'Reddit user',
          community: sub ? `r/${sub}` : 'Reddit',
          imageUrl,
          sourceUrl,
          upvotes: ups,
          publishedAt,
          verificationStatus: 'live_public_api',
        });
      }

      return out.sort((a, b) => (b.upvotes ?? 0) - (a.upvotes ?? 0)).slice(0, 4);
    } catch {
      return [];
    }
  }

  private async fetchBlueskyJokes(query: string, context: NewsMemeContext): Promise<NewsMemeItem[]> {
    try {
      const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=12`;
      const resp = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'OpportunityRadar/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(3_500),
      });
      if (!resp.ok) return [];

      const data = (await resp.json()) as {
        posts?: Array<{
          uri?: string;
          indexedAt?: string;
          likeCount?: number;
          repostCount?: number;
          author?: { handle?: string; displayName?: string };
          record?: { text?: string; createdAt?: string };
          embed?: {
            images?: Array<{ fullsize?: string; thumb?: string }>;
          };
        }>;
      };

      const out: NewsMemeItem[] = [];
      for (const post of data.posts ?? []) {
        const handle = post.author?.handle?.trim();
        const text = (post.record?.text || '').replace(/\s+/g, ' ').trim();
        const rkey = post.uri?.split('/').pop();
        if (!handle || !rkey || text.length < 20) continue;

        const postUrl = safeHttpsUrl(`https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`);
        if (!postUrl) continue;

        const imageUrl = safeHttpsUrl(post.embed?.images?.[0]?.fullsize || post.embed?.images?.[0]?.thumb);
        const engagement = (Number(post.likeCount) || 0) + (Number(post.repostCount) || 0) * 2;
        const hasHumor = HUMOR_SIGNAL_RE.test(text);
        if (!hasHumor && !(imageUrl && engagement >= 5)) continue;

        out.push({
          id: makeItemId(postUrl, text),
          kind: imageUrl ? 'meme' : 'joke',
          platform: 'bluesky',
          titleUk: post.author?.displayName || `@${handle}`,
          originalText: text.slice(0, 420),
          captionUk: text.slice(0, 320),
          punchlineUk: null,
          author: post.author?.displayName ? `${post.author.displayName} (@${handle})` : `@${handle}`,
          community: 'Bluesky',
          imageUrl,
          sourceUrl: postUrl,
          upvotes: Number(post.likeCount) || null,
          publishedAt: post.record?.createdAt || post.indexedAt || new Date().toISOString(),
          verificationStatus: 'live_public_api',
        });
      }
      return out.sort((a, b) => (b.upvotes ?? 0) - (a.upvotes ?? 0)).slice(0, 3);
    } catch {
      return [];
    }
  }

  private async discoverMemesWithGemini(query: string, context: NewsMemeContext): Promise<NewsMemeItem[]> {
    if (!this.activeKey) return [];
    const { data } = await postGeminiGenerateContent({
      apiKey: this.activeKey,
      preferredModel: DEFAULT_GEMINI_MODEL,
      timeoutMs: 30_000,
      body: {
        systemInstruction: {
          parts: [
            {
              text: 'Find 2 to 5 REAL, publicly circulating memes, jokes, or satirical reactions from X, Reddit, Bluesky, Threads, Telegram, or meme sites about the news topic. Return strict JSON: { "items": [{ "kind": "meme"|"joke"|"satire", "platform": "reddit"|"x"|"bluesky"|"threads"|"telegram"|"web", "titleUk": "...", "originalText": "...", "captionUk": "...", "punchlineUk": "...", "author": "...", "community": "...", "imageUrl": "...optional", "sourceUrl": "...", "upvotes": 123, "publishedAt": "ISO" }] }. NEVER invent jokes, quotes, or URLs; cite only real URLs returned by Google Search grounding. If no real public memes or jokes exist for this news, return { "items": [] }.',
            },
          ],
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: JSON.stringify({
                  title: context.title,
                  summary: context.summary.slice(0, 600),
                  category: context.category,
                  search_query: query,
                }),
              },
            ],
          },
        ],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: 3000 },
      },
    });

    const parsedData = data as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
      }>;
    };
    const groundedUrls = new Set(
      (parsedData.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
        .map((c) => safeHttpsUrl(c.web?.uri))
        .filter((u): u is string => Boolean(u)),
    );
    const rawText = parsedData.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    let parsedJson: { items?: Array<Record<string, unknown>> };
    try {
      parsedJson = JSON.parse(jsonMatch[0]) as { items?: Array<Record<string, unknown>> };
    } catch {
      return [];
    }

    const out: NewsMemeItem[] = [];
    for (const raw of Array.isArray(parsedJson.items) ? parsedJson.items : []) {
      const sourceUrl = safeHttpsUrl(raw.sourceUrl);
      if (!sourceUrl || !isAllowedMemeHost(sourceUrl, groundedUrls)) continue;

      const originalText = typeof raw.originalText === 'string' ? raw.originalText.trim() : '';
      const captionUk = typeof raw.captionUk === 'string' ? raw.captionUk.trim() : '';
      if (originalText.length < 10 && captionUk.length < 10) continue;

      const rawImg = safeHttpsUrl(raw.imageUrl);
      const imageUrl = rawImg && isAllowedMemeHost(rawImg, groundedUrls) ? rawImg : null;
      const author = typeof raw.author === 'string' && raw.author.trim() ? raw.author.trim().slice(0, 100) : 'Спільнота';

      out.push({
        id: makeItemId(sourceUrl, originalText || captionUk),
        kind: normalizeKind(raw.kind),
        platform: normalizePlatform(raw.platform, sourceUrl),
        titleUk: (typeof raw.titleUk === 'string' && raw.titleUk.trim() ? raw.titleUk.trim() : captionUk).slice(0, 180),
        originalText: (originalText || captionUk).slice(0, 480),
        captionUk: (captionUk || originalText).slice(0, 400),
        punchlineUk: typeof raw.punchlineUk === 'string' && raw.punchlineUk.trim() ? raw.punchlineUk.trim().slice(0, 240) : null,
        author,
        community: typeof raw.community === 'string' && raw.community.trim() ? raw.community.trim().slice(0, 80) : null,
        imageUrl,
        sourceUrl,
        upvotes: typeof raw.upvotes === 'number' && Number.isFinite(raw.upvotes) ? Math.max(0, Math.round(raw.upvotes)) : null,
        publishedAt: typeof raw.publishedAt === 'string' && !Number.isNaN(Date.parse(raw.publishedAt))
          ? raw.publishedAt
          : new Date().toISOString(),
        verificationStatus: 'gemini_search_grounded',
      });
    }
    return out;
  }

  private async enrichUkrainianCaptions(
    items: NewsMemeItem[],
    context: NewsMemeContext,
  ): Promise<NewsMemeItem[]> {
    const needsTranslation = items.some(
      (item) => item.verificationStatus === 'live_public_api' && !/[а-яіїєґ]{3,}/i.test(item.captionUk),
    );
    if (!needsTranslation || !this.activeKey || process.env.NODE_ENV === 'test' || items.length === 0) {
      return items;
    }

    try {
      const res = await postGeminiGenerateContent({
        apiKey: this.activeKey,
        preferredModel: DEFAULT_GEMINI_MODEL,
        timeoutMs: 18_000,
        body: {
          systemInstruction: {
            parts: [
              {
                text: 'Переклади та коротко адаптуй українською заголовки й жарти у наданих суспільних постах, зберігаючи гумор і не вигадуючи нових фактів. Поверни JSON { "translations": [{ "id": "...", "titleUk": "...", "captionUk": "...", "punchlineUk": "..." }] }.',
              },
            ],
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: JSON.stringify({
                    newsTitle: context.title,
                    items: items.map((i) => ({
                      id: i.id,
                      originalText: i.originalText,
                      community: i.community,
                    })),
                  }),
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: 'application/json',
            maxOutputTokens: 1600,
          },
        },
      });

      const rawText = (
        res.data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      )?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? '')
        .join('');
      if (!rawText) return items;

      const parsed = JSON.parse(rawText) as {
        translations?: Array<{ id?: string; titleUk?: string; captionUk?: string; punchlineUk?: string }>;
      };
      const byId = new Map((parsed.translations ?? []).map((t) => [t.id, t]));
      return items.map((item) => {
        const tr = byId.get(item.id);
        if (!tr) return item;
        return {
          ...item,
          titleUk: tr.titleUk?.trim() ? tr.titleUk.trim().slice(0, 180) : item.titleUk,
          captionUk: tr.captionUk?.trim() ? tr.captionUk.trim().slice(0, 400) : item.captionUk,
          punchlineUk: tr.punchlineUk?.trim() ? tr.punchlineUk.trim().slice(0, 240) : item.punchlineUk,
        };
      });
    } catch {
      return items;
    }
  }

  private readMemoryCache(key: string): NewsMemesResponse | null {
    const entry = this.memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);
      return null;
    }
    this.memoryCache.delete(key);
    this.memoryCache.set(key, entry);
    return entry.payload;
  }

  private writeMemoryCache(key: string, payload: NewsMemesResponse): void {
    if (this.memoryCache.has(key)) {
      this.memoryCache.delete(key);
    } else if (this.memoryCache.size >= MEME_CACHE_MAX) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey !== undefined) this.memoryCache.delete(oldestKey);
    }
    this.memoryCache.set(key, {
      expiresAt: Date.now() + MEME_CACHE_TTL_MS,
      payload,
    });
  }

  private async readDbCache(newsKey: string): Promise<NewsMemesResponse | null> {
    if (!this.db) return null;
    try {
      const { rows } = await this.db.query<{ payload: NewsMemesResponse }>(
        `SELECT payload
         FROM news_memes_cache
         WHERE news_key = $1 AND expires_at > now()
         LIMIT 1`,
        [newsKey],
      );
      const cachedPayload = rows[0]?.payload;
      if (cachedPayload && typeof cachedPayload === 'object' && Array.isArray(cachedPayload.items)) {
        return cachedPayload;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async writeDbCache(payload: NewsMemesResponse): Promise<void> {
    if (!this.db) return;
    try {
      const expiresAt = new Date(Date.now() + MEME_CACHE_TTL_MS).toISOString();
      await this.db.query(
        `INSERT INTO news_memes_cache (
           news_key, article_url, category, has_memes, payload, source_mode, created_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,now(),$7::timestamptz)
         ON CONFLICT (news_key) DO UPDATE SET
           article_url = EXCLUDED.article_url,
           category = EXCLUDED.category,
           has_memes = EXCLUDED.has_memes,
           payload = EXCLUDED.payload,
           source_mode = EXCLUDED.source_mode,
           created_at = now(),
           expires_at = EXCLUDED.expires_at`,
        [
          payload.newsKey,
          payload.articleUrl ?? null,
          payload.category,
          payload.hasMemes,
          JSON.stringify(payload),
          payload.sourceMode,
          expiresAt,
        ],
      );
    } catch {
      // Gracefully skip if migration 012 is not yet applied
    }
  }
}

function deduplicateMemeItems(items: NewsMemeItem[]): NewsMemeItem[] {
  const seenUrls = new Set<string>();
  const seenTexts = new Set<string>();
  const unique: NewsMemeItem[] = [];
  for (const item of items) {
    const urlKey = item.sourceUrl.toLowerCase();
    const textKey = item.originalText.toLowerCase().replace(/\s+/g, ' ').slice(0, 90);
    if (seenUrls.has(urlKey) || (textKey && seenTexts.has(textKey))) continue;
    seenUrls.add(urlKey);
    if (textKey) seenTexts.add(textKey);
    unique.push(item);
  }
  return unique;
}
