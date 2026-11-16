import { BadRequestException, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { AiRankingsService } from './ai-rankings.service';

const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : def;
}

@Controller('ai-rankings')
export class AiRankingsController {
  constructor(private readonly rankings: AiRankingsService) {}

  /** All groups and subcategories with item counts and the top-3 names. */
  @Get()
  overview() {
    return this.rankings.overview();
  }

  @Get('new')
  async newTools(@Query('days') days?: string, @Query('limit') limit?: string) {
    return { items: await this.rankings.newTools(clampInt(days, 14, 1, 90), clampInt(limit, 40, 1, 100)) };
  }

  @Get('search')
  async search(@Query('q') q?: string) {
    return { items: await this.rankings.search(String(q || '')) };
  }

  @Get('category/:slug')
  async category(@Param('slug') slug: string, @Query('limit') limit?: string) {
    if (!SLUG.test(slug)) throw new BadRequestException('Invalid category');
    const res = await this.rankings.category(slug, clampInt(limit, 50, 1, 100));
    if (!res) throw new NotFoundException('Unknown category');
    return res;
  }

  @Get('tool/:slug')
  async tool(@Param('slug') slug: string) {
    if (!SLUG.test(slug)) throw new BadRequestException('Invalid tool');
    const res = await this.rankings.tool(slug);
    if (!res) throw new NotFoundException('Unknown tool');
    return res;
  }

  @Post('refresh')
  @UseGuards(IngestKeyGuard)
  refresh() {
    return this.rankings.runCycle(true);
  }
}
