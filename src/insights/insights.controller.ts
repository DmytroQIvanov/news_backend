import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { InsightsService } from './insights.service';

const KINDS = new Set(['novel_pair', 'surprising_pair', 'predicted', 'bridge', 'burst', 'lead_lag', 'topic_link', 'sequence']);
const SLUG = /^[a-z0-9-]{2,96}$/;
const lang = (v?: string): 'uk' | 'en' => (v === 'en' ? 'en' : 'uk');
const int = (v: string | undefined, d: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : d;
};

@Controller('insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  list(@Query('kind') kind?: string, @Query('lang') l?: string, @Query('limit') limit?: string, @Query('days') days?: string) {
    if (kind && !KINDS.has(kind)) throw new BadRequestException('Unknown kind');
    return this.insights.listInsights({ kind, lang: lang(l), limit: int(limit, 30, 100), days: int(days, 7, 60) });
  }

  @Get('trends')
  trends(@Query('lang') l?: string, @Query('limit') limit?: string) {
    return this.insights.trends(lang(l), int(limit, 20, 100));
  }

  @Get('patterns')
  patterns() {
    return this.insights.patterns();
  }

  @Get('status')
  status() {
    return this.insights.lastRun();
  }

  @Get('path')
  async path(@Query('from') from: string, @Query('to') to: string, @Query('lang') l?: string) {
    if (!SLUG.test(from || '') || !SLUG.test(to || '')) throw new BadRequestException('from and to must be entity slugs');
    const res = await this.insights.path(from, to, lang(l));
    if (!res) throw new NotFoundException('Entity not found');
    return res;
  }

  @Get('entity/:slug')
  async entity(@Param('slug') slug: string, @Query('lang') l?: string) {
    if (!SLUG.test(slug)) throw new BadRequestException('Invalid slug');
    const res = await this.insights.entityInsights(slug, lang(l));
    if (!res) throw new NotFoundException('Entity not found');
    return res;
  }

  @Get('news/:id/related')
  async related(@Param('id') id: string, @Query('lang') l?: string) {
    const res = await this.insights.relatedNews(id, lang(l));
    if (!res) throw new NotFoundException('News item not found');
    return { items: res };
  }

  @Get('topics/:slug/related')
  topics(@Param('slug') slug: string, @Query('lang') l?: string) {
    if (!SLUG.test(slug)) throw new BadRequestException('Invalid slug');
    return this.insights.relatedTopics(slug, lang(l));
  }

  @Post('run')
  @UseGuards(IngestKeyGuard)
  run() {
    return this.insights.runAll();
  }

  @Get('candidates')
  @UseGuards(IngestKeyGuard)
  candidates(@Query('status') status?: string) {
    const s = status === 'accepted' || status === 'rejected' ? status : 'pending';
    return this.insights.listCandidates(s);
  }

  @Post('candidates/:id')
  @UseGuards(IngestKeyGuard)
  async decide(@Param('id') id: string, @Body() body: { action?: string; type?: string; name?: string; aliasOf?: string }) {
    if (!/^\d+$/.test(id)) throw new BadRequestException('Invalid id');
    if (body?.action === 'reject') return { ok: await this.insights.rejectCandidate(id) };
    if (body?.action !== 'accept') throw new BadRequestException('action must be accept or reject');
    const res = await this.insights.acceptCandidate(id, { type: body.type, name: body.name, aliasOf: body.aliasOf, origin: 'manual' });
    if (!res) throw new NotFoundException('Candidate or aliasOf entity not found');
    return res;
  }
}
