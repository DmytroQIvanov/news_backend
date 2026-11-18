import { NEWS_ELIGIBILITY_SQL, NEWS_SOURCE_COUNTS_SQL } from './eligibility';
import { BadRequestException, Body, Controller, Get, NotFoundException, Optional, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES } from '../ingest/ingest.dto';
import { importanceScore, isValidDeviceId, pickTopStories, PersonalizationService, RankableItem } from './personalization.service';
import { analyzeCoverage, LENS_LABELS, lensOf, SourceLens } from './source-profiles';
import { TopicsService } from './topics.service';

type Lang = 'uk' | 'en';

function parseLang(raw?: string): Lang {
  if (raw === undefined || raw === 'uk') return 'uk';
  if (raw === 'en') return 'en';
  throw new BadRequestException('lang must be uk or en');
}

function parseCategories(raw?: string): Set<string> {
  if (!raw) return new Set();
  const cats = new Set<string>(CATEGORIES);
  const list = raw.split(',').map((c) => c.trim()).filter(Boolean);
  if (list.length > 40 || list.some((c) => !cats.has(c))) throw new BadRequestException('Invalid muted categories');
  return new Set(list);
}

export const ERROR_REPORT_REASONS = ['factual', 'outdated', 'misleading', 'bias', 'translation', 'other'] as const;

type BriefRow = RankableItem & {
  document_count: number;
  independent_source_count: number;
  id: string;
  url: string;
  title_uk: string | null;
  original_title: string;
  title_en: string | null;
  summary_uk: string | null;
  summary_en: string | null;
  source_name: string;
  source_slug: string;
  cluster_id: string | null;
  insight: Record<string, unknown> | null;
  insight_uk: Record<string, unknown> | null;
  content_warning: string | null;
  is_solutions_story: boolean | null;
};

const BRIEF_SQL = `
  SELECT n.id::text AS id, n.url, n.title_uk, n.original_title, n.summary_uk, n.category, n.published_at,
         ${NEWS_SOURCE_COUNTS_SQL}, n.credibility_tier, n.cluster_id, COALESCE(n.cluster_sources, '[]'::jsonb) AS cluster_sources,
         COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
         COALESCE((n.ai_metadata->>'hydrogen_deep_analysis')::boolean, false) AS hydrogen_deep_analysis,
         CASE WHEN n.ai_metadata->'article'->>'canonical_lang' = 'en' THEN n.ai_metadata->'article'->>'title' END AS title_en,
         CASE WHEN n.ai_metadata->'article'->>'canonical_lang' = 'en' THEN n.ai_metadata->'article'->>'summary' END AS summary_en,
         n.ai_metadata->'article'->'insight' AS insight, n.ai_metadata->'article'->'insight_uk' AS insight_uk,
         n.ai_metadata->'article'->>'content_warning' AS content_warning,
         (n.ai_metadata->'article'->>'is_solutions_story')::boolean AS is_solutions_story,
         s.name AS source_name, s.slug AS source_slug
  FROM news_items n JOIN sources s ON s.id = n.source_id
  WHERE ${NEWS_ELIGIBILITY_SQL} AND n.published_at >= now() - ($1::int * interval '1 hour')
  ORDER BY n.published_at DESC
  LIMIT 400`;

function briefCard(r: BriefRow, lang: Lang) {
  const insight = (lang === 'en' ? r.insight : r.insight_uk || r.insight) as Record<string, unknown> | null;
  const sources = Array.isArray(r.cluster_sources) ? (r.cluster_sources as Array<{ url?: string; sourceSlug?: string; sourceName?: string }>) : [];
  return {
    id: r.id,
    url: r.url,
    sourceName: r.source_name,
    sourceSlug: r.source_slug,
    category: r.category,
    publishedAt: r.published_at,
    clusterId: r.cluster_id,
    documentCount: r.document_count, independentSourceCount: r.independent_source_count,
    title: lang === 'en' ? r.title_en || r.original_title : r.title_uk || r.original_title,
    tldr: typeof insight?.tldr === 'string' && insight.tldr ? insight.tldr : (lang === 'en' ? r.summary_en : r.summary_uk) || '',
    keyPoints: Array.isArray(insight?.key_points) ? (insight!.key_points as string[]).slice(0, 5) : [],
    forYou: typeof insight?.for_you === 'string' ? insight.for_you : '',
    contentWarning: r.content_warning && r.content_warning !== 'none' ? r.content_warning : null,
    sourceCount: Math.max(1, sources.length),
    coverage: analyzeCoverage(
      sources.length ? sources.map((s) => ({ sourceSlug: s.sourceSlug, url: s.url })) : [{ sourceSlug: r.source_slug, url: r.url }],
      lang,
    ),
  };
}

/** Lens share of a reader's positive source weights; null when there is too little reading history. */
export function readerLensProfile(sourceWeights: Record<string, number>): { dominant: SourceLens; share: number; total: number } | null {
  const byLens = new Map<SourceLens, number>();
  let total = 0;
  for (const [slug, w] of Object.entries(sourceWeights)) {
    if (!(w > 0)) continue;
    const lens = lensOf(slug);
    if (lens === 'unknown') continue;
    byLens.set(lens, (byLens.get(lens) ?? 0) + w);
    total += w;
  }
  if (total < 5) return null;
  const [dominant, weight] = [...byLens.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!dominant) return null;
  return { dominant, share: Math.round((weight! / total) * 100) / 100, total: Math.round(total * 10) / 10 };
}

@Controller()
export class ObjectivityController {
  constructor(
    private readonly db: DatabaseService,
    private readonly topics: TopicsService,
    @Optional() private readonly personalization?: PersonalizationService,
  ) {}

  /**
   * Finite daily brief: the 5–7 stories everyone should know (same for every reader), the number of the day,
   * one solutions story, then an explicit end. Muted categories and content warnings are respected.
   */
  @Get('brief/daily')
  async dailyBrief(@Query('lang') langRaw?: string, @Query('muted') mutedRaw?: string, @Query('hideSensitive') hideRaw?: string) {
    const lang = parseLang(langRaw);
    const muted = parseCategories(mutedRaw);
    const hideSensitive = hideRaw === '1' || hideRaw === 'true';
    const { rows } = await this.db.query<BriefRow>(BRIEF_SQL, [36]).catch(() => ({ rows: [] as BriefRow[] }));
    const pool = rows.filter(
      (r) => !muted.has(String(r.category)) && !(hideSensitive && r.content_warning && r.content_warning !== 'none'),
    );
    const top = pickTopStories(pool, 7);
    const topIds = new Set(top.map((t) => t.id));
    const cards = top.map((r) => briefCard(r, lang));

    let numberOfDay: { value: string; label: string; newsId: string; title: string } | null = null;
    for (const r of top) {
      const insight = (lang === 'en' ? r.insight : r.insight_uk || r.insight) as Record<string, unknown> | null;
      const nums = Array.isArray(insight?.key_numbers) ? (insight!.key_numbers as Array<{ value?: string; label?: string }>) : [];
      const first = nums.find((n) => n?.value && n?.label);
      if (first) {
        numberOfDay = { value: String(first.value), label: String(first.label), newsId: r.id, title: briefCard(r, lang).title };
        break;
      }
    }
    const solutionRow = pool
      .filter((r) => r.is_solutions_story && !topIds.has(r.id))
      .sort((a, b) => importanceScore(b) - importanceScore(a))[0];

    const readMinutes = Math.max(3, Math.round(cards.reduce((sum, c) => sum + (c.tldr.length + c.keyPoints.join(' ').length) / 1000, 0) + cards.length * 0.6));
    return {
      lang,
      date: new Date().toISOString().slice(0, 10),
      readMinutes,
      items: cards,
      numberOfDay,
      solution: solutionRow ? briefCard(solutionRow, lang) : null,
      end: lang === 'en'
        ? "You're up to date. That's everything important for today."
        : 'Ви в курсі. На сьогодні це все важливе.',
    };
  }

  /** "What changed since your last visit": topic updates plus how many articles appeared. */
  @Get('feed/since')
  async since(@Query('ts') ts?: string, @Query('lang') langRaw?: string) {
    const lang = parseLang(langRaw);
    const sinceMs = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(sinceMs)) throw new BadRequestException('ts must be an ISO date');
    // Older than two weeks is a new reader in practice: summarise the last 14 days only.
    const bounded = Math.max(sinceMs, Date.now() - 14 * 86_400_000);
    return this.topics.changesSince(new Date(bounded), lang);
  }

  /**
   * Once a day, readers whose history comes almost entirely from one lens (e.g. only Ukrainian media) get one
   * story told by a different lens — preferably the same event they already read, so the framing is comparable.
   */
  @Get('feed/other-perspective')
  async otherPerspective(@Query('deviceId') deviceId?: string, @Query('lang') langRaw?: string) {
    const lang = parseLang(langRaw);
    if (!isValidDeviceId(deviceId)) throw new BadRequestException('deviceId must be a UUID');
    const profile = this.personalization ? await this.personalization.getProfile(deviceId) : null;
    const lensProfile = profile ? readerLensProfile(profile.sourceWeights) : null;
    if (!lensProfile || lensProfile.share < 0.7) {
      return { needed: false, reason: lensProfile ? 'balanced' : 'not_enough_history', profile: lensProfile, item: null };
    }
    const dominant = lensProfile.dominant;
    const { rows } = await this.db.query<BriefRow>(BRIEF_SQL, [48]).catch(() => ({ rows: [] as BriefRow[] }));
    type Candidate = { row: BriefRow; lens: SourceLens; sharedEvent: boolean; score: number };
    const candidates: Candidate[] = [];
    for (const row of rows) {
      const lens = lensOf(row.source_slug, row.url);
      if (lens === dominant || lens === 'unknown') continue;
      const clusterLenses = new Set(
        (Array.isArray(row.cluster_sources) ? (row.cluster_sources as Array<{ url?: string; sourceSlug?: string }>) : []).map((s) =>
          lensOf(s.sourceSlug ?? null, s.url ?? null),
        ),
      );
      const sharedEvent = clusterLenses.has(dominant);
      candidates.push({ row, lens, sharedEvent, score: importanceScore(row) + (sharedEvent ? 0.5 : 0) + (lens === 'official' ? -0.2 : 0) });
    }
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];
    if (!pick) return { needed: true, reason: 'no_candidate', profile: lensProfile, item: null };
    const L = (uk: string, en: string) => (lang === 'en' ? en : uk);
    return {
      needed: true,
      reason: 'single_lens',
      profile: { ...lensProfile, dominantLabel: LENS_LABELS[dominant][lang] },
      otherLens: { lens: pick.lens, label: LENS_LABELS[pick.lens][lang] },
      sharedEvent: pick.sharedEvent,
      explanation: pick.sharedEvent
        ? L(
            `Ви здебільшого читаєте: ${LENS_LABELS[dominant].uk.toLowerCase()}. Ось як цю ж подію подає інше джерело.`,
            `You mostly read ${LENS_LABELS[dominant].en.toLowerCase()}. Here is how a different kind of source tells the same story.`,
          )
        : L(
            `Ви здебільшого читаєте: ${LENS_LABELS[dominant].uk.toLowerCase()}. Ось важлива історія з іншої перспективи.`,
            `You mostly read ${LENS_LABELS[dominant].en.toLowerCase()}. Here is an important story from a different perspective.`,
          ),
      item: briefCard(pick.row, lang),
    };
  }

  @Get('topics')
  async topicList(@Query('lang') langRaw?: string, @Query('limit') limitRaw?: string) {
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('limit: 1–50');
    return { items: await this.topics.list(parseLang(langRaw), limit) };
  }

  @Get('topics/by-news/:id')
  async topicForNews(@Param('id') id: string, @Query('lang') langRaw?: string) {
    const topic = await this.topics.topicForNews(id, parseLang(langRaw));
    if (!topic) throw new NotFoundException('No topic for this article');
    return topic;
  }

  @Get('topics/:slug')
  async topic(@Param('slug') slug: string, @Query('lang') langRaw?: string) {
    if (!/^[a-z0-9-]{3,96}$/.test(slug)) throw new BadRequestException('Invalid topic');
    const topic = await this.topics.get(slug, parseLang(langRaw));
    if (!topic) throw new NotFoundException('Topic not found');
    return topic;
  }

  @Get('predictions/stats')
  predictionStats() {
    return this.topics.predictionStats();
  }

  @Get('news/:id/predictions')
  async newsPredictions(@Param('id') id: string, @Query('lang') langRaw?: string) {
    return { items: await this.topics.predictionsForNews(id, parseLang(langRaw)) };
  }

  /** Public change history of an article (every edit after publication, with the previous text). */
  @Get('news/:id/revisions')
  async revisions(@Param('id') id: string) {
    if (!/^\d{1,18}$/.test(id)) throw new BadRequestException('Invalid id');
    const { rows } = await this.db
      .query<{ id: string; changed_fields: string[]; previous: Record<string, unknown>; reason: string | null; changed_at: Date }>(
        `SELECT id::text, changed_fields, previous, reason, changed_at FROM news_revisions
         WHERE news_id = $1::bigint ORDER BY changed_at DESC LIMIT 50`,
        [id],
      )
      .catch(() => ({ rows: [] as Array<{ id: string; changed_fields: string[]; previous: Record<string, unknown>; reason: string | null; changed_at: Date }> }));
    return {
      items: rows.map((r) => ({ id: r.id, fields: r.changed_fields, previous: r.previous, reason: r.reason, changedAt: r.changed_at })),
    };
  }

  /** Moderation queue of reader error reports (newest first). */
  @Get('error-reports')
  @UseGuards(IngestKeyGuard)
  async errorReports(@Query('status') status?: string) {
    const st = status === 'accepted' || status === 'rejected' ? status : 'open';
    const { rows } = await this.db.query(
      `SELECT e.id::text, e.news_id::text, e.sentence, e.reason, e.comment, e.status, e.created_at,
              n.title_uk, n.original_title, n.url, s.slug AS source_slug,
              COUNT(*) OVER (PARTITION BY e.news_id, md5(e.sentence))::int AS same_sentence_reports
       FROM error_reports e JOIN news_items n ON n.id = e.news_id JOIN sources s ON s.id = n.source_id
       WHERE e.status = $1 ORDER BY e.created_at DESC LIMIT 100`,
      [st],
    );
    return { items: rows };
  }

  /**
   * Accept or reject a report. Accepting with a `correctionNote` also publishes the correction on the article,
   * which the revision trigger records in its public change history.
   */
  @Patch('error-reports/:id')
  @UseGuards(IngestKeyGuard)
  async resolveErrorReport(@Param('id') id: string, @Body() body: { status?: unknown; correctionNote?: unknown }) {
    if (!/^\d{1,18}$/.test(id)) throw new BadRequestException('Invalid id');
    if (body?.status !== 'accepted' && body?.status !== 'rejected') throw new BadRequestException('status must be accepted or rejected');
    const res = await this.db.query<{ news_id: string }>(
      `UPDATE error_reports SET status = $2 WHERE id = $1::bigint RETURNING news_id::text`,
      [id, body.status],
    );
    if (!res.rowCount) throw new NotFoundException('Report not found');
    const note = typeof body.correctionNote === 'string' ? body.correctionNote.trim().slice(0, 1000) : '';
    if (body.status === 'accepted' && note) {
      await this.db.query(`UPDATE news_items SET correction_note = $2, corrected_at = now(), updated_at = now() WHERE id = $1::bigint`, [
        res.rows[0].news_id,
        note,
      ]);
    }
    return { id, status: body.status, corrected: Boolean(body.status === 'accepted' && note) };
  }

  /** "There is a mistake here": a reader marks one sentence. One report per device per sentence. */
  @Post('news/:id/report-error')
  async reportError(
    @Param('id') id: string,
    @Body() body: { deviceId?: unknown; sentence?: unknown; reason?: unknown; comment?: unknown },
  ) {
    if (!/^\d{1,18}$/.test(id)) throw new BadRequestException('Invalid id');
    if (!isValidDeviceId(body?.deviceId)) throw new BadRequestException('deviceId must be a UUID');
    const sentence = typeof body.sentence === 'string' ? body.sentence.replace(/\s+/g, ' ').trim().slice(0, 1200) : '';
    if (sentence.length < 3) throw new BadRequestException('sentence is required');
    const reason = (ERROR_REPORT_REASONS as readonly string[]).includes(String(body.reason)) ? String(body.reason) : 'other';
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 1000) || null : null;
    const { rows: recent } = await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM error_reports WHERE device_id = $1::uuid AND created_at >= now() - interval '1 hour'`,
      [body.deviceId],
    );
    if ((recent[0]?.n ?? 0) >= 20) throw new BadRequestException('Too many reports, try again later');
    const res = await this.db.query(
      `INSERT INTO error_reports (news_id, device_id, sentence, reason, comment)
       SELECT $1::bigint, $2::uuid, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM news_items WHERE id = $1::bigint AND status = 'published')
       ON CONFLICT DO NOTHING RETURNING id`,
      [id, body.deviceId, sentence, reason, comment],
    );
    return { accepted: Boolean(res.rowCount), duplicate: !res.rowCount };
  }
}
