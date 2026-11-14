import { Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { GrantsService } from './grants.service';

@Controller('grants')
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  @Get()
  list(
    @Query('country') country?: string,
    @Query('sector') sector?: string,
    @Query('type') type?: string,
    @Query('stage') stage?: string,
    @Query('audience') audience?: string,
    @Query('equityFree') equityFreeRaw?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 30;
    const offset = offsetRaw ? Number(offsetRaw) : 0;
    const equityFree =
      equityFreeRaw === 'true' ? true
      : equityFreeRaw === 'false' ? false
      : undefined;

    return this.grants.list({
      country: country?.trim() || undefined,
      sector: sector?.trim() || undefined,
      type: type?.trim() || undefined,
      stage: stage?.trim() || undefined,
      audience: audience?.trim() || undefined,
      equityFree,
      q: q?.trim() || undefined,
      sort: sort?.trim() || undefined,
      limit: Number.isFinite(limit) ? limit : 30,
      offset: Number.isFinite(offset) ? offset : 0,
    });
  }

  @Get('meta')
  getMeta() {
    return this.grants.getMeta();
  }

  @Get(':externalId')
  async detail(@Param('externalId') externalId: string) {
    const item = await this.grants.getByExternalId(externalId);
    if (!item) {
      throw new NotFoundException(`Grant opportunity "${externalId}" not found`);
    }
    return item;
  }

  @Post('refresh')
  @UseGuards(IngestKeyGuard)
  refresh(@Query('force') force?: string) {
    return this.grants.refresh(force === 'true');
  }
}
