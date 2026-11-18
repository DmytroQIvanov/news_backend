import { NEWS_ELIGIBILITY_SQL } from '../news/eligibility';
import { BadRequestException, Controller, Get, Header, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { llmBudgetStatus } from '../common/llm-budget';
import { DatabaseService } from '../database/database.service';
import { isKbEditorialActive, KbEditorialService } from './kb-editorial.service';
import { KbFlagshipService } from './kb-flagship.service';
import { corroborationReport } from './kb-corroboration.service';
import { KbReadService } from './kb-read.service';
import { buildDataDocs } from './kb-data';

const lang = (v?: string): 'uk' | 'en' => (v === 'en' ? 'en' : 'uk');
const STATES = new Set(['collecting', 'ready', 'deep', 'written', 'skipped']);

@Controller('kb')
export class KbController {
  constructor(
    private readonly read: KbReadService,
    private readonly editorial: KbEditorialService,
    private readonly flagship: KbFlagshipService,
    private readonly db: DatabaseService,
  ) {}

  /** Story context of an article: sources, facts with evidence status, earlier events, storyline, participants. */
  @Get('news/:id/context')
  @Header('Cache-Control', 'public, max-age=120')
  async newsContext(@Param('id', ParseIntPipe) id: number, @Query('lang') l?: string) {
    const ctx = await this.read.contextForNews(id, lang(l));
    if (!ctx) throw new NotFoundException('No knowledge-base event for this article');
    return ctx;
  }

  @Get('events')
  @Header('Cache-Control', 'public, max-age=60')
  events(@Query('state') state?: string, @Query('limit') limit?: string, @Query('lang') l?: string) {
    if (state && !STATES.has(state)) throw new BadRequestException('Unknown state');
    const n = Math.min(100, Math.max(1, Number(limit) || 30));
    return this.read.events(state, n, lang(l));
  }

  /** Pages the AI found as extra sources: accepted ones (cited) and rejected ones (hidden by default, kept for review). */
  @Get('events/:id/corroboration')
  @Header('Cache-Control', 'public, max-age=60')
  async corroboration(@Param('id', ParseIntPipe) id: number, @Query('rejected') rejected?: string) {
    const report = await corroborationReport(this.db, id);
    return rejected === 'true' ? report : { ...report, rejected: undefined, rejectedCount: report.rejected.length };
  }

  @Get('events/:id')
  @Header('Cache-Control', 'public, max-age=120')
  async event(@Param('id', ParseIntPipe) id: number, @Query('lang') l?: string) {
    const ev = await this.read.event(id, lang(l));
    if (!ev) throw new NotFoundException('Event not found');
    return ev;
  }

  /** Exact values, periods, provenance and selection paths; optional point-in-time knowledge cutoff. */
  @Get('events/:id/data')
  @Header('Cache-Control', 'public, max-age=60')
  async eventData(@Param('id', ParseIntPipe) id: number, @Query('asOf') asOf?: string) {
    const cutoff = asOf ? new Date(asOf) : new Date();
    if (!Number.isFinite(cutoff.getTime()) || cutoff.getTime()>Date.now()+1000) throw new BadRequestException('Invalid or future asOf');
    const event = (await this.db.query(`SELECT * FROM kb.events WHERE id=$1`, [id])).rows[0];
    if (!event) throw new NotFoundException('Event not found');
    const eventId = Number(event.merged_into || id);
    const entities = (await this.db.query(`SELECT entity_id::int AS id FROM kb.event_entities WHERE event_id=$1 ORDER BY weight DESC LIMIT 40`, [eventId])).rows;
    const when = event.last_seen_at instanceof Date ? event.last_seen_at.toISOString() : event.last_seen_at;
    const docs = await buildDataDocs(this.db,eventId,event.category,entities as any,when,{asOf:cutoff.toISOString(),persist:!asOf});
    return { eventId, asOf:cutoff.toISOString(), datasets:docs.filter((doc) => doc.data).map((doc) => ({ref:doc.ref,...doc.data})) };
  }

  @Get('entities/:id')
  @Header('Cache-Control', 'public, max-age=300')
  async entity(@Param('id', ParseIntPipe) id: number, @Query('lang') l?: string) {
    const e = await this.read.entity(id, lang(l));
    if (!e) throw new NotFoundException('Entity not found');
    return e;
  }

  @Get('storylines/:id')
  @Header('Cache-Control', 'public, max-age=300')
  async storyline(@Param('id', ParseIntPipe) id: number, @Query('lang') l?: string) {
    const s = await this.read.storyline(id, lang(l));
    if (!s) throw new NotFoundException('Storyline not found');
    return s;
  }

  /** Daily LLM budget per model and purpose (no secrets). */
  @Get('llm-budget')
  budget() {
    return llmBudgetStatus();
  }

  @Get('editorial/status')
  async editorialStatus() {
    const [runs, today] = await Promise.all([
      this.db.query(
        `SELECT id, started_at, finished_at, event_ids, model, prompt_chars, input_tokens, output_tokens, written, updated, rejected, dry_run, error
         FROM kb.editorial_runs ORDER BY id DESC LIMIT 20`,
      ).catch(() => ({ rows: [] })),
      this.db.query(
        `SELECT count(*) FILTER (WHERE written_at > date_trunc('day', now())) AS written_today,
                count(*) FILTER (WHERE editorial_state IN ('ready', 'deep') AND article_news_id IS NULL) AS waiting
         FROM kb.events`,
      ).catch(() => ({ rows: [{}] })),
    ]);
    return { active: await isKbEditorialActive(this.db), source: process.env.EDITORIAL_SOURCE || 'auto', dryRun: this.editorial.dryRun, ...today.rows[0], runs: runs.rows };
  }

  @Get('editorial/preview/:eventId')
  @UseGuards(IngestKeyGuard)
  async preview(@Param('eventId', ParseIntPipe) eventId: number) {
    const p = await this.editorial.preview(eventId);
    if (!p) throw new NotFoundException('Event not found');
    return p;
  }

  @Post('editorial/run')
  @UseGuards(IngestKeyGuard)
  run() {
    return this.editorial.runOnce({ force: true });
  }

  /** Flagship long-reads written today (marked "flagship"), newest first. */
  @Get('flagships')
  @Header('Cache-Control', 'public, max-age=120')
  async flagships(@Query('limit') limit?: string) {
    const n = Math.min(50, Math.max(1, Number(limit) || 20));
    return (await this.db.query(
      `SELECT n.id, n.title_uk, n.ai_metadata->'article'->>'title' AS title_en, n.published_at, n.category, n.kb_event_id,
              n.ai_metadata->'kb'->'flagship'->>'thesis' AS thesis
       FROM news_items n WHERE n.editorial_tier = 'flagship' AND ${NEWS_ELIGIBILITY_SQL}
       ORDER BY n.updated_at DESC LIMIT $1`,
      [n],
    ).catch(() => ({ rows: [] }))).rows;
  }

  @Post('flagship/run')
  @UseGuards(IngestKeyGuard)
  runFlagship(@Query('eventId') eventId?: string) {
    const id = eventId ? Number(eventId) : undefined;
    if (eventId && !Number.isInteger(id)) throw new BadRequestException('eventId must be an integer');
    return this.flagship.runOnce({ force: true, eventId: id });
  }
}
