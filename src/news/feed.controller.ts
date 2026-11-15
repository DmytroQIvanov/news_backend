import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { isSafeObjectKey } from '../common/r2-storage';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES } from '../ingest/ingest.dto';
import { CaricatureService } from './caricature.service';
import { CompanyFeedsService } from './company-feeds.service';
import { NewsClusteringService } from './news-clustering.service';
import { NewsController, TOPIC_ALIAS_MAP } from './news.controller';
import {
  isValidDeviceId,
  pickTopStories,
  PersonalizationService,
  rankForReader,
  READER_EVENT_TYPES,
  ReaderEvent,
  ReaderEventType,
} from './personalization.service';
import { SourceDiscoveryService } from './source-discovery.service';
import { StoryBriefingService } from './story-briefing.service';
import { AudioBriefingService } from './audio-briefing.service';
import { llmRouterStatus } from '../common/llm-router';

type Lang = 'uk' | 'en';

function parseLang(raw?: string): Lang {
  if (raw === undefined || raw === 'uk') return 'uk';
  if (raw === 'en') return 'en';
  throw new BadRequestException('lang must be uk or en');
}

function apiBase(req: Request): string {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : '';
}

/** Declared onboarding topics (subtopic ids) → categories they map to. */
export function declaredTopicsToCategories(topics: string[]): Set<string> {
  const out = new Set<string>();
  const cats = new Set<string>(CATEGORIES);
  for (const t of topics) {
    if (cats.has(t)) out.add(t);
    for (const c of TOPIC_ALIAS_MAP[t]?.categories ?? []) out.add(c);
  }
  return out;
}

@Controller()
export class FeedController {
  private readonly news: NewsController;

  constructor(
    private readonly db: DatabaseService,
    companyFeeds: CompanyFeedsService,
    private readonly personalization: PersonalizationService,
    private readonly stories: StoryBriefingService,
    private readonly caricatures: CaricatureService,
    private readonly audio: AudioBriefingService,
    @Optional() clustering?: NewsClusteringService,
    @Optional() discovery?: SourceDiscoveryService,
  ) {
    this.news = new NewsController(db, companyFeeds, undefined, undefined, undefined, clustering, discovery);
  }

  /**
   * Personal feed: the day's main stories first (same for everyone), then the reader's ranked feed
   * with AI caricature cards mixed in every ~7 items.
   */
  @Get('feed')
  async feed(
    @Req() req: Request,
    @Query('deviceId') deviceId?: string,
    @Query('lang') langRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
    @Query('topics') topicsRaw?: string,
    @Query('sources') sourcesRaw?: string,
    @Query('depth') depthRaw?: string,
  ) {
    const lang = parseLang(langRaw);
    const limit = limitRaw === undefined ? 30 : Number(limitRaw);
    const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 1000) {
      throw new BadRequestException('limit: 1–50, offset: 0–1000');
    }
    if (deviceId !== undefined && !isValidDeviceId(deviceId)) throw new BadRequestException('deviceId must be a UUID');

    const profile = deviceId ? await this.personalization.getProfile(deviceId) : null;
    const declared = topicsRaw ? topicsRaw.split(',').map((t) => t.trim()).filter(Boolean) : profile?.declaredTopics ?? [];
    // Pull a wide pool (no topic hard-filter: interests re-rank instead of hiding everything else).
    const pool = (await this.news.list('50', '0', undefined, sourcesRaw, undefined, undefined, depthRaw, 'newest', '72', lang, 300)) as {
      items: Array<Record<string, unknown> & { id: string }>;
    };
    const items = pool.items;
    const ranked = rankForReader(items, profile, declaredTopicsToCategories(declared));

    const top = offset === 0 ? pickTopStories(items, 6) : [];
    const topIds = new Set(top.map((t) => String(t.id)));
    const rest = ranked.filter((i) => !topIds.has(String(i.id)));
    const page = rest.slice(offset, offset + limit);

    const [storyList, caricatureList] = await Promise.all([
      offset === 0 ? this.stories.list(8, lang, 36) : Promise.resolve([]),
      this.caricatures.list({ limit: 6, lang, apiBase: apiBase(req) }),
    ]);
    const storyByCluster = new Map(storyList.map((s) => [s.clusterId, s]));

    // Interleave caricatures as their own cards (never next to the story they joke about if it is sensitive).
    const cards: Array<Record<string, unknown>> = [];
    let cIdx = offset === 0 ? 0 : Math.floor(offset / 7) % Math.max(1, caricatureList.length);
    page.forEach((item, i) => {
      cards.push({ type: 'news', ...item, story: item.cluster_id ? storyByCluster.get(String(item.cluster_id)) ?? null : null });
      if ((i + 1) % 7 === 0 && caricatureList[cIdx]) {
        cards.push({ type: 'caricature', ...caricatureList[cIdx] });
        cIdx += 1;
      }
    });

    return {
      lang,
      personalized: Boolean(profile),
      top: top.map((t) => ({ ...t, story: t.cluster_id ? storyByCluster.get(String(t.cluster_id)) ?? null : null })),
      stories: offset === 0 ? storyList.slice(0, 5) : [],
      items: cards,
      hasMore: offset + page.length < rest.length,
      interests: this.personalization.describe(profile),
    };
  }

  /** Small payload for background notification checks on the phone. */
  @Get('feed/top')
  async top(@Query('lang') langRaw?: string, @Query('since') since?: string) {
    const lang = parseLang(langRaw);
    const sinceMs = since ? Date.parse(since) : Date.now() - 6 * 3_600_000;
    if (!Number.isFinite(sinceMs)) throw new BadRequestException('since must be an ISO date');
    const pool = (await this.news.list('50', '0', undefined, undefined, 'true', undefined, undefined, 'newest', '24', lang, 120)) as {
      items: Array<Record<string, unknown> & { id: string }>;
    };
    const top = pickTopStories(pool.items, 5).filter((t) => {
      const ts = t.published_at ? new Date(t.published_at as string).getTime() : 0;
      return ts >= sinceMs;
    });
    return {
      items: top.map((t) => ({
        id: t.id,
        title: t.display_title ?? t.title_uk ?? t.original_title,
        source_slug: t.source_slug,
        cluster_id: t.cluster_id ?? null,
        published_at: t.published_at,
      })),
    };
  }

  @Post('feed/events')
  async events(@Body() body: { deviceId?: unknown; lang?: unknown; events?: unknown }) {
    if (!isValidDeviceId(body?.deviceId)) throw new BadRequestException('deviceId must be a UUID');
    const lang = body.lang === 'en' ? 'en' : 'uk';
    if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > 200) {
      throw new BadRequestException('events must be a non-empty array (max 200)');
    }
    const types = new Set<string>(READER_EVENT_TYPES);
    const cats = new Set<string>(CATEGORIES);
    const events: ReaderEvent[] = [];
    for (const raw of body.events) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      if (typeof e.itemId !== 'string' || !e.itemId || e.itemId.length > 120) continue;
      if (typeof e.type !== 'string' || !types.has(e.type)) continue;
      events.push({
        itemId: e.itemId,
        type: e.type as ReaderEventType,
        category: typeof e.category === 'string' && cats.has(e.category) ? e.category : null,
        sourceSlug: typeof e.sourceSlug === 'string' && /^[a-z0-9][a-z0-9-]{1,79}$/.test(e.sourceSlug) ? e.sourceSlug : null,
        clusterId: typeof e.clusterId === 'string' ? e.clusterId.slice(0, 120) : null,
        dwellMs: typeof e.dwellMs === 'number' ? e.dwellMs : null,
      });
    }
    if (!events.length) throw new BadRequestException('No valid events');
    const profile = await this.personalization.recordEvents(body.deviceId, lang, events);
    return { accepted: events.length, interests: this.personalization.describe(profile) };
  }

  @Post('feed/profile')
  async profile(@Body() body: { deviceId?: unknown; lang?: unknown; topics?: unknown }) {
    if (!isValidDeviceId(body?.deviceId)) throw new BadRequestException('deviceId must be a UUID');
    const topics = Array.isArray(body.topics)
      ? body.topics.filter((t): t is string => typeof t === 'string' && /^[a-z0-9_-]{2,48}$/.test(t)).slice(0, 40)
      : [];
    await this.personalization.saveDeclared(body.deviceId, body.lang === 'en' ? 'en' : 'uk', topics);
    return { ok: true, topics };
  }

  @Get('stories')
  async storyList(@Query('lang') langRaw?: string, @Query('limit') limitRaw?: string) {
    const lang = parseLang(langRaw);
    const limit = limitRaw === undefined ? 10 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new BadRequestException('limit: 1–30');
    return { items: await this.stories.list(limit, lang) };
  }

  @Get('stories/by-news/:id')
  async storyForNews(@Param('id') id: string, @Query('lang') langRaw?: string) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new BadRequestException('Invalid id');
    const story = await this.stories.getForNews(id, parseLang(langRaw));
    if (!story) throw new NotFoundException('No story briefing for this article yet');
    return story;
  }

  @Get('stories/:clusterId')
  async story(@Param('clusterId') clusterId: string, @Query('lang') langRaw?: string) {
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(clusterId)) throw new BadRequestException('Invalid cluster id');
    const story = await this.stories.get(clusterId, parseLang(langRaw));
    if (!story) throw new NotFoundException('Story not found');
    return story;
  }

  @Post('stories/refresh')
  @UseGuards(IngestKeyGuard)
  async refreshStories() {
    return this.stories.refreshTopStories(6);
  }

  @Get('caricatures')
  async caricatureList(@Req() req: Request, @Query('lang') langRaw?: string, @Query('limit') limitRaw?: string) {
    const limit = limitRaw === undefined ? 12 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new BadRequestException('limit: 1–40');
    return {
      enabled: this.caricatures.enabled,
      items: await this.caricatures.list({ limit, lang: parseLang(langRaw), apiBase: apiBase(req) }),
    };
  }

  @Post('caricatures/generate')
  @UseGuards(IngestKeyGuard)
  async generateCaricatures() {
    return this.caricatures.generateBatch(3);
  }

  @Post('caricatures/:id/report')
  async reportCaricature(@Param('id') id: string, @Body() body: { deviceId?: unknown; reason?: unknown }) {
    if (!/^\d{1,18}$/.test(id)) throw new BadRequestException('Invalid id');
    if (!isValidDeviceId(body?.deviceId)) throw new BadRequestException('deviceId must be a UUID');
    const reasons = new Set(['offensive', 'misleading', 'not_funny', 'other']);
    const reason = typeof body.reason === 'string' && reasons.has(body.reason) ? body.reason : 'other';
    return this.caricatures.report(id, body.deviceId, reason);
  }

  /**
   * Audio briefing for an article. Never waits for generation: returns a ready R2 URL, or the script
   * (the app reads it with the on-device voice) plus the item's place in the generation queue.
   */
  @Get('audio/news/:id')
  async newsAudio(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('lang') langRaw?: string,
    @Query('depth') depth?: string,
    @Query('style') style?: string,
  ) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new BadRequestException('Invalid id');
    const lang = langRaw && /^[a-z]{2}$/.test(langRaw) ? langRaw : 'en';
    const res = await this.audio.getAudio(id, lang, { depth, style }, apiBase(req));
    if (!res) throw new NotFoundException('Article not found');
    return res;
  }

  @Get('audio/playlist')
  async audioPlaylist(@Req() req: Request, @Query('lang') langRaw?: string, @Query('limit') limitRaw?: string) {
    const lang = langRaw && /^[a-z]{2}$/.test(langRaw) ? langRaw : 'en';
    const limit = limitRaw === undefined ? 8 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new BadRequestException('limit: 1–30');
    return { items: await this.audio.playlist(lang, limit, apiBase(req)) };
  }

  @Get('audio/stats')
  async audioStats() {
    return this.audio.stats();
  }

  /** Free-tier budgets per AI provider/model (Gemini, Groq, OpenRouter): used today, cooldowns, successes. */
  @Get('ai/status')
  aiStatus() {
    return { providers: llmRouterStatus() };
  }

  @Get('media/tts/:lang/:file')
  async ttsMedia(@Param('lang') lang: string, @Param('file') file: string, @Res() res: Response) {
    const key = `tts/${lang}/${file}`;
    if (!/^[a-z]{2}$/.test(lang) || !/^[0-9]+-[a-f0-9]{24}\.(mp3|wav|ogg)$/.test(file) || !isSafeObjectKey(key)) {
      throw new BadRequestException('Invalid file');
    }
    const obj = await this.audio.readMedia(key).catch(() => null);
    if (!obj) throw new NotFoundException('Not found');
    res.setHeader('Content-Type', obj.contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.end(obj.body);
  }

  /** Proxies stored media from private R2 so no public bucket is required. */
  @Get('media/caricatures/:file')
  async media(@Param('file') file: string, @Res() res: Response) {
    const key = `caricatures/${file}`;
    if (!/^[a-z0-9-]+\.(jpg|png)$/i.test(file) || !isSafeObjectKey(key)) throw new BadRequestException('Invalid file');
    const obj = await this.caricatures.readMedia(key).catch(() => null);
    if (!obj) throw new NotFoundException('Not found');
    res.setHeader('Content-Type', obj.contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(obj.body);
  }
}
