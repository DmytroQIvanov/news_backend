import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { generateJsonWithRouter } from '../common/llm-router';
import { checkRobotsTxtPermission, fetchPublicUrl, getHonestUserAgent } from '../common/source-compliance';
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
import { pickStockPhoto } from '../common/stock-photos';
import { PhotoStorageService, StoredPhotoMetadata } from '../common/photo-storage.service';
import { extractYoutubeVideoId } from '../youtube/youtube-channels';
import {
  attachUrlTimecodeToVideoFigure,
  fetchYoutubeVideoDetails,
  planArticleMediaWithAi,
  searchVerifiedEventVideos,
} from './event-media';
import { ExtractedImage, extractPageDescription, extractPageImages, normalizeImageUrl } from './image-extraction';
import { enrichResource, findCommonsImage, searchCommonsImages } from './resource-enrichment';
import { findSectionFigures } from '../kb/kb-section-images';
import {
  buildVisualsPrompt,
  NewsVisual,
  sanitizeVisuals,
  VISUALS_RESPONSE_SCHEMA,
} from './news-visuals';

export interface NewsHeroImage extends StoredPhotoMetadata {
  url: string;
  caption?: string;
  /** Always shown under the photo, e.g. "Фото: BBC News". */
  credit: string;
  sourceUrl: string;
  width?: number;
  height?: number;
}

export interface NewsAmbientBg extends StoredPhotoMetadata {
  url: string;
  credit: string;
  sourceUrl: string;
  avgColor?: string | null;
  mood?: 'dark' | 'cool' | 'warm';
  source: 'pixabay' | 'openverse' | 'pexels' | 'commons';
}

export interface NewsMedia {
  hero?: NewsHeroImage;
  ambientBg?: NewsAmbientBg;
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
  published_at: Date | string | null;
  media: NewsMedia;
  /** knowledge-base tier: 'medium' | 'big' | 'flagship' (null for legacy articles) */
  editorial_tier?: string | null;
}

const MAX_PAGE_BYTES = 600_000;

/** Fetches an article page politely: public host only, robots.txt respected, honest UA, hard size cap. */
export async function fetchArticleHtml(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const robots = await checkRobotsTxtPermission(url).catch(() => ({ allowed: false }));
  if (!robots.allowed) return null;
  const resp = await fetchPublicUrl(url, {
    headers: { 'User-Agent': getHonestUserAgent(), Accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 8_000,
    fetchFn,
  });
  const type = resp?.headers.get('content-type') || '';
  if (!resp || !resp.ok || !/html|xml/i.test(type) || !resp.body) {
    await resp?.body?.cancel().catch(() => undefined);
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
  private eventVideoSearchesToday = { day: '', count: 0 };

  constructor(
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly feeds?: CompanyFeedsService,
    @Optional() private readonly photos?: PhotoStorageService,
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
      // Section images for knowledge-base big articles and flagships (cheap model plans, Commons/Pexels APIs search).
      for (const row of await this.pending(
        "n.editorial_tier IN ('big', 'flagship') AND n.media ? 'checked_at' AND NOT (n.media ? 'section_images_checked_at')",
        3,
      )) {
        if (this.destroyed) break;
        await this.attachSectionImages(row).catch(async (err) => {
          this.logger.debug(`Section images for ${row.id}: ${err instanceof Error ? err.message : err}`);
          await this.save(row.id, { section_images_checked_at: new Date().toISOString() } as Partial<NewsMedia>).catch(() => undefined);
        });
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
      source_name: string; important: boolean; published_at: Date | null; media: NewsMedia | null; editorial_tier: string | null;
    }>(
      `SELECT n.id::text, n.url, n.category,
              COALESCE(n.title_uk, n.original_title) AS title,
              n.original_title AS title_en,
              COALESCE(n.summary_uk, n.original_summary, '') AS summary,
              COALESCE(n.ai_metadata->'article'->>'body', n.summary_uk, n.original_summary, '') AS body,
              s.name AS source_name,
              COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
              n.published_at,
              n.media,
              n.editorial_tier
       FROM news_items n JOIN sources s ON s.id = n.source_id
       WHERE n.status = 'published' AND n.published_at >= now() - interval '48 hours'
         AND COALESCE(n.ai_metadata->>'source_type', '') <> 'youtube_video'
         AND ${where}
       ORDER BY (n.editorial_tier = 'flagship') DESC NULLS LAST, (n.editorial_tier = 'big') DESC NULLS LAST, n.published_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ ...r, media: r.media ?? {} }));
  }

  private async attachSectionImages(row: PendingRow): Promise<void> {
    const used = await this.recentStockUrls();
    if (row.media.hero?.url) used.add(row.media.hero.url);
    for (const f of row.media.figures ?? []) used.add(f.url);
    const max = row.editorial_tier === 'flagship' ? 5 : 3;
    const extra = await findSectionFigures(row.title_en || row.title, row.body, max, used, { db: this.db, storage: this.photos });
    const figures = [...(row.media.figures ?? []), ...extra].slice(0, 12);
    await this.save(row.id, { figures, section_images_checked_at: new Date().toISOString() } as Partial<NewsMedia>);
  }

  private async save(id: string, patch: Partial<NewsMedia>): Promise<void> {
    // Only API-selected, licensed images are copied. Publisher photos remain at their source.
    if (this.photos?.configured) {
      if (patch.hero?.license && !patch.hero.objectKey) patch.hero = await this.photos.persist(patch.hero) ?? undefined;
      if (patch.ambientBg?.license && !patch.ambientBg.objectKey) patch.ambientBg = await this.photos.persist(patch.ambientBg) ?? undefined;
      if (patch.figures) {
        const figures: ArticleFigure[] = [];
        for (const figure of patch.figures) {
          if (figure.kind === 'photo' && figure.license && (figure.origin === 'commons' || figure.origin === 'stock') && !figure.objectKey) {
            const stored = await this.photos.persist(figure).catch(() => null);
            if (stored) figures.push(stored);
          } else figures.push(figure);
        }
        patch.figures = figures;
      }
    }
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
    const hasRichText = row.body.trim().length >= 900;
    const worthIt = hasNumbers || row.important || hasRichText;
    // Knowledge-base big articles and flagships always get the charts/tables pass (no daily cap): their depth matters.
    const priority = row.editorial_tier === 'big' || row.editorial_tier === 'flagship';
    if (!(worthIt || priority)) {
      await this.save(row.id, { visuals_checked_at: new Date().toISOString() });
      return false;
    }
    // A temporary quota/provider outage must not permanently remove charts from the article.
    if ((!priority && this.visualsBudgetLeft() <= 0) || process.env.NEWS_VISUALS_ENABLED === 'false') return false;
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
      maxTokens: 3000,
      temperature: 0.1,
      timeoutMs: 40_000,
    });
    if (!routed) return false;
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
    // Section illustrations may have been selected in an earlier pass of this cycle.
    const figures: ArticleFigure[] = [...(row.media.figures ?? [])];
    if (html) {
      for (const f of extractFigures(html, row.url, row.source_name)) {
        if (imageKey(f.url) === heroKey || figures.some((x) => imageKey(x.url) === imageKey(f.url))) continue;
        figures.push(f);
        if (figures.length >= 6) break;
      }
    }
    const youtubeKey = process.env.YOUTUBE_API_KEY?.trim() || '';
    const embedYoutubeIds = embeds
      .filter((e) => e.kind === 'video')
      .map((e) => extractYoutubeVideoId(e.url))
      .filter((id): id is string => Boolean(id));
    const embedDetails = youtubeKey && embedYoutubeIds.length
      ? await fetchYoutubeVideoDetails(embedYoutubeIds, youtubeKey).catch(() => new Map())
      : new Map<string, { title: string; description: string }>();

    for (const e of embeds.filter((x) => x.kind === 'video').slice(0, 2)) {
      const video = await enrichResource(
        { id: 'v', url: e.url, type: 'video', title: '', site: 'YouTube', match: [], origin: 'article' },
        (u) => fetchArticleHtml(u),
      ).catch(() => null);
      if (!video?.verified_at || !video.image) continue;
      const vid = extractYoutubeVideoId(e.url);
      const desc = vid ? embedDetails.get(vid)?.description : undefined;
      const baseFig: ArticleFigure = {
        id: '',
        kind: 'video',
        url: video.image,
        caption: video.title,
        credit: video.meta?.author ? `${video.meta.author} / YouTube` : 'YouTube',
        link: video.url,
        match: keywordsOf(`${video.title} ${video.title} ${e.context}`),
        position: e.position,
        origin: 'embed',
        verified: true,
      };
      figures.push(attachUrlTimecodeToVideoFigure(baseFig, e.url, desc, e.startSec));
    }

    const patch: Partial<NewsMedia> = { links, figures, links_checked_at: new Date().toISOString() };
    const needHero = !row.media.hero;
    const needAmbient = !row.media.ambientBg;
    const needVideo = !figures.some((f) => f.kind === 'video');
    const needPhoto = !figures.some((f) => f.kind === 'photo');

    if (needHero || needAmbient || needVideo || needPhoto) {
      const plan = await planArticleMediaWithAi({
        category: row.category,
        title: row.title,
        titleEn: row.title_en,
        summary: row.summary,
        body: row.body,
      }).catch(() => null);

      const usedUrls = await this.recentStockUrls();
      if (row.media.hero?.url) usedUrls.add(row.media.hero.url);
      if (row.media.hero?.originalUrl) usedUrls.add(row.media.hero.originalUrl);

      if (needHero) {
        const heroPicked = await this.pickHeroFromSources(row.id, plan, usedUrls);
        if (heroPicked) {
          patch.hero = heroPicked;
          usedUrls.add(heroPicked.url);
          if (heroPicked.originalUrl) usedUrls.add(heroPicked.originalUrl);
        }
      }

      if (needAmbient && plan) {
        const ambientPicked = await this.pickAmbientFromSources(plan, usedUrls);
        if (ambientPicked) patch.ambientBg = ambientPicked;
      }

      if (needPhoto && this.commonsEnabled() && plan?.commonsQueryEn && figures.length < 6) {
        const eventPhotos = await searchCommonsImages(plan.commonsQueryEn, {
          limit: 2,
          mustMatchTerms: plan.mustMatchTerms,
          usedUrls,
        }).catch(() => []);
        for (const p of eventPhotos) {
          if (imageKey(p.url) === heroKey || figures.some((x) => imageKey(x.url) === imageKey(p.url))) continue;
          figures.push(p);
          if (figures.length >= 6) break;
        }
      }

      if (needVideo && plan?.eventVideoQueryEn && figures.length < 6) {
        const canSearchYoutube = this.canSearchEventVideo();
        const eventVideos = await searchVerifiedEventVideos({
          query: canSearchYoutube ? plan.eventVideoQueryEn : '',
          mustMatchTerms: plan.mustMatchTerms,
          publishedAt: row.published_at,
          db: this.db,
          apiKey: canSearchYoutube ? youtubeKey : '',
        }).catch(() => []);
        for (const v of eventVideos) {
          figures.push(v);
          if (figures.length >= 6) break;
        }
      }
    }

    figures.sort((a, b) => a.position - b.position).forEach((f, i) => { f.id = `f${i + 1}`; });
    patch.figures = figures;
    await this.save(row.id, patch);
  }

  private commonsEnabled(): boolean {
    return process.env.NEWS_COMMONS_IMAGES !== 'false';
  }

  private canSearchEventVideo(): boolean {
    const day = new Date().toISOString().slice(0, 10);
    if (this.eventVideoSearchesToday.day !== day) this.eventVideoSearchesToday = { day, count: 0 };
    const raw = process.env.EVENT_VIDEO_SEARCH_DAILY_MAX;
    const parsed = raw !== undefined && raw.trim() !== '' ? Number(raw) : NaN;
    const max = Number.isInteger(parsed) && parsed >= 0 ? parsed : 25;
    if (this.eventVideoSearchesToday.count >= max) return false;
    this.eventVideoSearchesToday.count += 1;
    return true;
  }

  private async recentStockUrls(): Promise<Set<string>> {
    if (!this.db) return new Set();
    const { rows } = await this.db
      .query<{ h: string | null; a: string | null; originals: string[]; figures: ArticleFigure[] }>(
        `SELECT media->'hero'->>'url' AS h, media->'ambientBg'->>'url' AS a,
                ARRAY[media->'hero'->>'originalUrl', media->'ambientBg'->>'originalUrl'] AS originals,
                COALESCE(media->'figures', '[]'::jsonb) AS figures
         FROM news_items
         WHERE status = 'published' AND published_at >= now() - interval '7 days'
         ORDER BY published_at DESC
         LIMIT 150`,
      )
      .catch(() => ({ rows: [] }));
    const used = new Set<string>();
    for (const r of rows) {
      if (r.h) used.add(r.h);
      if (r.a) used.add(r.a);
      for (const url of r.originals ?? []) if (url) used.add(url);
      for (const figure of r.figures ?? []) { used.add(figure.url); if (figure.originalUrl) used.add(figure.originalUrl); }
    }
    return used;
  }

  private async pickHeroFromSources(
    newsId: string,
    plan: Awaited<ReturnType<typeof planArticleMediaWithAi>> | null,
    usedUrls: Set<string>,
  ): Promise<NewsHeroImage | null> {
    const pickCommons = async (): Promise<NewsHeroImage | null> => {
      if (!this.commonsEnabled()) return null;
      const entityPhoto = await this.commonsPhoto(newsId);
      if (entityPhoto && !usedUrls.has(entityPhoto.url)) {
        return {
          url: entityPhoto.url,
          ...(entityPhoto.caption ? { caption: entityPhoto.caption } : {}),
          credit: entityPhoto.credit,
          license: entityPhoto.license,
          licenseUrl: entityPhoto.licenseUrl,
          sourceUrl: entityPhoto.link || entityPhoto.url,
          ...(entityPhoto.width ? { width: entityPhoto.width } : {}),
          ...(entityPhoto.height ? { height: entityPhoto.height } : {}),
        };
      }
      if (plan?.commonsQueryEn) {
        const docs = await searchCommonsImages(plan.commonsQueryEn, {
          limit: 2,
          mustMatchTerms: plan.mustMatchTerms,
          usedUrls,
        }).catch(() => []);
        if (docs[0]) {
          return {
            url: docs[0].url,
            ...(docs[0].caption ? { caption: docs[0].caption } : plan.heroCaptionUk ? { caption: plan.heroCaptionUk } : {}),
            credit: docs[0].credit,
            license: docs[0].license,
            licenseUrl: docs[0].licenseUrl,
            sourceUrl: docs[0].link || docs[0].url,
            ...(docs[0].width ? { width: docs[0].width } : {}),
            ...(docs[0].height ? { height: docs[0].height } : {}),
          };
        }
      }
      if (plan?.commonsQueryEn && plan.mustMatchTerms.length && this.photos?.configured) {
        const photo = await pickStockPhoto(plan.commonsQueryEn, {
          query: plan.commonsQueryEn, providers: ['openverse'], mustMatchTerms: plan.mustMatchTerms,
          usedUrls, db: this.db, accept: (candidate) => this.photos!.persist(candidate),
        });
        if (photo) return { ...photo, caption: photo.alt, sourceUrl: photo.photoPageUrl };
      }
      return null;
    };

    const pickStock = async (): Promise<NewsHeroImage | null> => {
      if (!plan?.heroQueryEn || !this.photos?.configured) return null;
      const best = await pickStockPhoto(plan.heroQueryEn, {
        query: plan.heroQueryEn, usedUrls, preferDark: true, db: this.db,
        accept: (photo) => this.photos!.persist(photo),
      });
      if (!best) return null;
      return {
        ...best,
        url: best.url,
        caption: 'Ілюстративне фото',
        credit: best.credit,
        sourceUrl: best.photoPageUrl,
        width: best.width,
        height: best.height,
      };
    };

    if (plan?.preferSource === 'commons') {
      return (await pickCommons()) || (await pickStock());
    }
    return (await pickStock()) || (await pickCommons());
  }

  private async pickAmbientFromSources(
    plan: NonNullable<Awaited<ReturnType<typeof planArticleMediaWithAi>>>,
    usedUrls: Set<string>,
  ): Promise<NewsAmbientBg | null> {
    if (plan.ambientQueryEn && this.photos?.configured) {
      const best = await pickStockPhoto(plan.ambientQueryEn, {
        query: plan.ambientQueryEn,
        usedUrls,
        preferDark: true,
        allowClutterFallback: true,
        db: this.db,
        accept: (photo) => this.photos!.persist(photo),
      });
      if (best) {
        return {
          ...best,
          url: best.url,
          credit: best.credit,
          sourceUrl: best.photoPageUrl,
          avgColor: best.avgColor,
          mood: plan.ambientMood,
          source: best.provider,
        };
      }
    }
    if (this.commonsEnabled() && plan.commonsQueryEn) {
      const docs = await searchCommonsImages(plan.commonsQueryEn, { limit: 1, usedUrls }).catch(() => []);
      if (docs[0]) {
        return {
          url: docs[0].url,
          credit: docs[0].credit,
          license: docs[0].license,
          licenseUrl: docs[0].licenseUrl,
          sourceUrl: docs[0].link || docs[0].url,
          mood: plan.ambientMood,
          source: 'commons',
        };
      }
    }
    return null;
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
