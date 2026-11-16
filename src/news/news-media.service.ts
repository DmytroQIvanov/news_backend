import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { generateJsonWithRouter } from '../common/llm-router';
import { checkRobotsTxtPermission, getHonestUserAgent, resolveAndValidatePublicUrl } from '../common/source-compliance';
import { DatabaseService } from '../database/database.service';
import { CompanyFeedsService } from './company-feeds.service';
import {
  ArticleFigure,
  ArticleResource,
  buildResources,
  extractEmbeds,
  extractFigures,
  extractLinkCandidates,
  extractTextIdentifiers,
  keywordsOf,
} from './article-resources';
import { ExtractedImage, extractPageDescription, extractPageImages, normalizeImageUrl } from './image-extraction';
import { enrichResource, findCommonsImage } from './resource-enrichment';
import {
  buildVisualsPrompt,
  NewsVisual,
  sanitizeVisuals,
  VISUALS_RESPONSE_SCHEMA,
} from './news-visuals';

export interface NewsHeroImage {
  url: string;
  caption?: string;
  /** Always shown under the photo, e.g. "Фото: BBC News". */
  credit: string;
  sourceUrl: string;
  width?: number;
  height?: number;
}

export interface NewsMedia {
  hero?: NewsHeroImage;
  gallery?: Array<{ url: string; caption?: string; credit: string }>;
  visuals?: NewsVisual[];
  /** Outbound material the story refers to (documents, reports, repos, demos, posts...), best first. */
  links?: ArticleResource[];
  /** In-article photos and videos with placement hints. */
  figures?: ArticleFigure[];
  checked_at?: string;
  visuals_checked_at?: string;
  links_checked_at?: string;
}

interface PendingRow {
  id: string;
  url: string;
  category: string;
  title: string;
  title_en: string | null;
  summary: string;
  body: string;
  source_name: string;
  important: boolean;
  media: NewsMedia;
}

const MAX_PAGE_BYTES = 600_000;

/** Fetches an article page politely: public host only, robots.txt respected, honest UA, hard size cap. */
export async function fetchArticleHtml(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const safe = await resolveAndValidatePublicUrl(url);
  if (!safe.safe) return null;
  const robots = await checkRobotsTxtPermission(url).catch(() => ({ allowed: false }));
  if (!robots.allowed) return null;
  const resp = await fetchFn(url, {
    headers: { 'User-Agent': getHonestUserAgent(), Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(8_000),
    redirect: 'follow',
  });
  const type = resp.headers.get('content-type') || '';
  if (!resp.ok || !/html|xml/i.test(type) || !resp.body) {
    await resp.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
      if (total >= MAX_PAGE_BYTES) break; // <head> and the lead of <article> are all that is needed
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Background worker that decorates published news with:
 *  1. a lead photo (+ caption + credit) and up to 3 more images, hotlinked from the publisher (never re-hosted);
 *  2. visuals: charts/tables/key figures, either built from open-data APIs or extracted from the article by an LLM.
 */
@Injectable()
export class NewsMediaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NewsMediaService.name);
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private running = false;
  private visualsToday = { day: '', count: 0 };

  constructor(
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly feeds?: CompanyFeedsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.NEWS_MEDIA_ENABLED === 'false' || !this.db) return;
    const loop = (delay: number) => {
      this.timer = setTimeout(async () => {
        if (this.destroyed) return;
        try {
          await this.runOnce();
        } catch (err) {
          this.logger.warn(`News media cycle failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.destroyed) loop(3 * 60_000);
        }
      }, delay);
    };
    loop(60_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private visualsDailyMax(): number {
    const n = Number(process.env.NEWS_VISUALS_DAILY_MAX);
    return Number.isInteger(n) && n >= 0 && n <= 200 ? n : 30;
  }

  private visualsBudgetLeft(): number {
    const day = new Date().toISOString().slice(0, 10);
    if (this.visualsToday.day !== day) this.visualsToday = { day, count: 0 };
    return Math.max(0, this.visualsDailyMax() - this.visualsToday.count);
  }

  async runOnce(): Promise<{ images: number; visuals: number; resources: number }> {
    if (!this.db || this.running) return { images: 0, visuals: 0, resources: 0 };
    this.running = true;
    let images = 0;
    let visuals = 0;
    let resources = 0;
    try {
      for (const row of await this.pending('NOT (n.media ? \'checked_at\')', 6)) {
        if (this.destroyed) break;
        await this.attachImages(row).then(() => { images += 1; }).catch((err) =>
          this.logger.debug(`Images for ${row.id}: ${err instanceof Error ? err.message : err}`),
        );
      }
      for (const row of await this.pending("n.media ? 'checked_at' AND NOT (n.media ? 'visuals_checked_at')", 4)) {
        if (this.destroyed) break;
        const done = await this.attachVisuals(row).catch((err) => {
          this.logger.debug(`Visuals for ${row.id}: ${err instanceof Error ? err.message : err}`);
          return false;
        });
        if (done) visuals += 1;
      }
      if (process.env.NEWS_RESOURCES_ENABLED !== 'false') {
        // Wait for the entity scan (or 20 minutes) so stories without a photo can get a Commons picture of their subject.
        for (const row of await this.pending(
          "n.media ? 'checked_at' AND NOT (n.media ? 'links_checked_at') AND (n.insights_scanned_at IS NOT NULL OR n.published_at < now() - interval '20 minutes')",
          4,
        )) {
          if (this.destroyed) break;
          await this.attachResources(row).then(() => { resources += 1; }).catch(async (err) => {
            this.logger.debug(`Resources for ${row.id}: ${err instanceof Error ? err.message : err}`);
            await this.save(row.id, { links_checked_at: new Date().toISOString() }).catch(() => undefined);
          });
        }
      }
    } finally {
      this.running = false;
    }
    return { images, visuals, resources };
  }

  private async pending(where: string, limit: number): Promise<PendingRow[]> {
    const { rows } = await this.db!.query<{
      id: string; url: string; category: string; title: string; title_en: string | null; summary: string; body: string;
      source_name: string; important: boolean; media: NewsMedia | null;
    }>(
      `SELECT n.id::text, n.url, n.category,
              COALESCE(n.title_uk, n.original_title) AS title,
              n.original_title AS title_en,
              COALESCE(n.summary_uk, n.original_summary, '') AS summary,
              COALESCE(n.ai_metadata->'article'->>'body', n.summary_uk, n.original_summary, '') AS body,
              s.name AS source_name,
              COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
              n.media
       FROM news_items n JOIN sources s ON s.id = n.source_id
       WHERE n.status = 'published' AND n.published_at >= now() - interval '48 hours'
         AND COALESCE(n.ai_metadata->>'source_type', '') <> 'youtube_video'
         AND ${where}
       ORDER BY n.published_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ ...r, media: r.media ?? {} }));
  }

  private async save(id: string, patch: Partial<NewsMedia>): Promise<void> {
    await this.db!.query(`UPDATE news_items SET media = COALESCE(media, '{}'::jsonb) || $2::jsonb WHERE id = $1::bigint`, [id, JSON.stringify(patch)]);
  }

  /** Step 1: lead photo + gallery from the feed cache, falling back to the article page's Open Graph tags. */
  private async attachImages(row: PendingRow): Promise<void> {
    const cached = this.feeds?.findCachedArticle(row.url);
    let found: ExtractedImage[] = [];
    if (cached?.image_url) {
      found.push({ url: cached.image_url, caption: cached.image_caption });
      for (const g of cached.gallery ?? []) found.push(g);
    }
    let pageDescription: string | undefined;
    if (found.length === 0 || !found[0].caption) {
      const html = await fetchArticleHtml(row.url).catch(() => null);
      if (html) {
        const page = extractPageImages(html, row.url, 4);
        pageDescription = extractPageDescription(html);
        if (found.length === 0) found = page;
        else if (!found[0].caption && page[0]?.url === found[0].url) found[0].caption = page[0].caption;
        else found.push(...page.filter((p) => !found.some((f) => f.url === p.url)));
      }
    }
    const unique = [...new Map(found.filter((f) => normalizeImageUrl(f.url)).map((f) => [f.url, f])).values()];
    const credit = row.source_name;
    const patch: Partial<NewsMedia> = { checked_at: new Date().toISOString() };
    if (unique[0]) {
      patch.hero = {
        url: unique[0].url,
        ...(unique[0].caption ? { caption: unique[0].caption } : pageDescription ? { caption: pageDescription } : {}),
        credit,
        sourceUrl: row.url,
        ...(unique[0].width ? { width: unique[0].width } : {}),
        ...(unique[0].height ? { height: unique[0].height } : {}),
      };
      const rest = unique.slice(1, 4).map((g) => ({ url: g.url, ...(g.caption ? { caption: g.caption } : {}), credit }));
      if (rest.length) patch.gallery = rest;
    }
    // Statistics built by open-data adapters need no LLM: attach them right away.
    if (cached?.prebuilt_visuals?.length) {
      const prebuilt = sanitizeVisuals(cached.prebuilt_visuals, 'open_data');
      if (prebuilt.length) {
        patch.visuals = prebuilt;
        patch.visuals_checked_at = new Date().toISOString();
      }
    }
    await this.save(row.id, patch);
  }

  /** Step 2: an LLM pass that extracts figures from the article text into validated chart/table data. */
  private async attachVisuals(row: PendingRow): Promise<boolean> {
    const hasNumbers = (row.summary.match(/\d[\d\s.,]*\s?(%|млн|млрд|тис|тис\.|million|billion|\$|€|грн|₴|USD|EUR)?/g) ?? []).length >= 3;
    const worthIt = hasNumbers || row.important;
    if (!worthIt || this.visualsBudgetLeft() <= 0 || process.env.NEWS_VISUALS_ENABLED === 'false') {
      await this.save(row.id, { visuals_checked_at: new Date().toISOString() });
      return false;
    }
    this.visualsToday.count += 1;
    const routed = await generateJsonWithRouter<{ visuals?: unknown[]; heroCaptionUk?: string }>({
      task: 'summary',
      prompt: buildVisualsPrompt({
        title: row.title,
        titleEn: row.title_en ?? undefined,
        summary: row.summary,
        body: row.body,
        category: row.category,
      }),
      schema: VISUALS_RESPONSE_SCHEMA,
      schemaName: 'news_visuals',
      maxTokens: 1800,
      temperature: 0.1,
      timeoutMs: 40_000,
    });
    const patch: Partial<NewsMedia> = { visuals_checked_at: new Date().toISOString() };
    if (routed) {
      const visuals = sanitizeVisuals(routed.data?.visuals, 'extracted');
      if (visuals.length) patch.visuals = visuals;
      const caption = typeof routed.data?.heroCaptionUk === 'string' ? routed.data.heroCaptionUk.trim().slice(0, 160) : '';
      if (caption && row.media.hero && !row.media.hero.caption) patch.hero = { ...row.media.hero, caption };
    }
    await this.save(row.id, patch);
    return Boolean(patch.visuals?.length);
  }
  /**
   * Step 3: links and figures. Every outbound link of the article body is classified and verified; exact identifiers
   * in the text (GitHub/Hugging Face paths, arXiv ids, DOIs, bare URLs) are checked against their APIs; in-article
   * photos and embedded videos get placement hints; a story with no picture at all gets a free Commons photo.
   */
  async attachResources(row: PendingRow): Promise<void> {
    const html = await fetchArticleHtml(row.url).catch(() => null);
    const candidates: Array<{ url: string; anchor: string; context: string; origin: ArticleResource['origin']; inline?: boolean }> = [];
    const embeds = html ? extractEmbeds(html) : [];
    if (html) {
      for (const c of extractLinkCandidates(html, row.url)) candidates.push({ ...c, origin: 'article' });
      for (const e of embeds.filter((x) => x.kind === 'post')) candidates.push({ url: e.url, anchor: '', context: e.context, origin: 'article' });
    }
    for (const c of extractTextIdentifiers(`${row.body}\n${row.summary}`)) candidates.push({ ...c, origin: 'identifier', inline: true });

    // An embedded video is shown as a figure in the text, so it is not repeated in the link list.
    const embeddedVideos = new Set(embeds.filter((e) => e.videoId).map((e) => `https://www.youtube.com/watch?v=${e.videoId}`));
    const built = buildResources(candidates.filter((c) => !embeddedVideos.has(c.url)), row.url);
    const enriched = await mapLimit(built, 3, (r) => enrichResource(r, (u) => fetchArticleHtml(u)).catch(() => r));
    const links = enriched.filter((r): r is ArticleResource => Boolean(r)).map((r, i) => ({ ...r, id: `r${i + 1}` }));

    const heroKey = imageKey(row.media.hero?.url);
    const figures: ArticleFigure[] = [];
    if (html) {
      for (const f of extractFigures(html, row.url, row.source_name)) {
        if (imageKey(f.url) === heroKey || figures.some((x) => imageKey(x.url) === imageKey(f.url))) continue;
        figures.push(f);
        if (figures.length >= 6) break;
      }
    }
    for (const e of embeds.filter((x) => x.kind === 'video').slice(0, 2)) {
      const video = await enrichResource(
        { id: 'v', url: e.url, type: 'video', title: '', site: 'YouTube', match: [], origin: 'article' },
        (u) => fetchArticleHtml(u),
      ).catch(() => null);
      if (!video?.verified_at || !video.image) continue;
      figures.push({
        id: '',
        kind: 'video',
        url: video.image,
        caption: video.title,
        credit: video.meta?.author ? `${video.meta.author} / YouTube` : 'YouTube',
        link: video.url,
        match: keywordsOf(`${video.title} ${video.title} ${e.context}`),
        position: e.position,
        origin: 'embed',
      });
    }
    figures.sort((a, b) => a.position - b.position).forEach((f, i) => { f.id = `f${i + 1}`; });

    const patch: Partial<NewsMedia> = { links, figures, links_checked_at: new Date().toISOString() };
    if (!row.media.hero && figures.length === 0) {
      const commons = await this.commonsPhoto(row.id);
      if (commons) {
        patch.hero = {
          url: commons.url,
          ...(commons.caption ? { caption: commons.caption } : {}),
          credit: commons.credit,
          sourceUrl: commons.link || commons.url,
          ...(commons.width ? { width: commons.width } : {}),
          ...(commons.height ? { height: commons.height } : {}),
        };
      }
    }
    await this.save(row.id, patch);
  }

  /** A freely licensed Wikipedia/Commons photo of the story's main person, place or organisation. */
  private async commonsPhoto(newsId: string): Promise<ArticleFigure | null> {
    if (process.env.NEWS_COMMONS_IMAGES === 'false') return null;
    const { rows } = await this.db!.query<{ name: string }>(
      `SELECT e.name
       FROM news_entities ne JOIN kg_entities e ON e.id = ne.entity_id
       WHERE ne.news_id = $1::bigint AND e.entity_type IN ('person', 'place', 'organization', 'company', 'event')
       ORDER BY (e.entity_type = 'person') DESC, (e.entity_type = 'place') DESC
       LIMIT 3`,
      [newsId],
    ).catch(() => ({ rows: [] as Array<{ name: string }> }));
    for (const { name } of rows) {
      for (const lang of ['uk', 'en'] as const) {
        const found = await findCommonsImage(name, lang).catch(() => null);
        if (found) return found;
      }
    }
    return null;
  }
}

/** Same photo at another size or with another query string counts as the same image. */
function imageKey(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/[-_]\d{2,4}x\d{2,4}(?=\.\w+$)/, '')}`.toLowerCase();
  } catch {
    return url;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
