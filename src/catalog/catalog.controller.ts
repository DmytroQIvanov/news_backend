import { Controller, Get, Post, Param, Query, NotFoundException, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { CatalogService } from './catalog.service';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('hasFree') hasFree?: string,
    @Query('sort') sort?: string,
  ) {
    const items = await this.catalogService.getAll({
      q: q?.trim() || undefined,
      category: category?.trim() || undefined,
      hasFree: hasFree === 'true' ? true : undefined,
      sort: sort?.trim() || undefined,
    });
    return { items, count: items.length };
  }

  @Get('models')
  async listModels(
    @Query('q') q?: string,
    @Query('providerId') providerId?: string,
    @Query('capability') capability?: string,
    @Query('minContext') minContextRaw?: string,
  ) {
    const minContext = minContextRaw ? Number(minContextRaw) : undefined;
    const items = await this.catalogService.getModels({
      q: q?.trim() || undefined,
      providerId: providerId?.trim() || undefined,
      capability: capability?.trim() || undefined,
      minContext: Number.isFinite(minContext) ? minContext : undefined,
    });
    return { items, count: items.length };
  }

  @Get('promotions')
  async listPromotions(
    @Query('q') q?: string,
    @Query('providerId') providerId?: string,
  ) {
    const items = await this.catalogService.getPromotions({
      q: q?.trim() || undefined,
      providerId: providerId?.trim() || undefined,
    });
    return { items, count: items.length };
  }

  @Get('changes')
  async listChanges(
    @Query('providerId') providerId?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 30;
    const items = await this.catalogService.getRecentChanges(
      providerId?.trim() || undefined,
      Number.isFinite(limit) ? limit : 30,
    );
    return { items, count: items.length };
  }

  @Get(':providerId')
  async detail(@Param('providerId') providerId: string) {
    const item = await this.catalogService.getByProvider(providerId);
    if (!item) {
      throw new NotFoundException(`Provider ${providerId} not found in catalog`);
    }
    return item;
  }

  @Post('refresh')
  @UseGuards(IngestKeyGuard)
  async refreshAll(@Query('force') force?: string) {
    return this.catalogService.triggerRefresh(undefined, force === 'true');
  }

  @Post('refresh/:providerId')
  @UseGuards(IngestKeyGuard)
  async refreshOne(@Param('providerId') providerId: string, @Query('force') force?: string) {
    return this.catalogService.triggerRefresh(providerId, force === 'true');
  }
}
