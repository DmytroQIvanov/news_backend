import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('api/v1/catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  async list() {
    const items = await this.catalogService.getAll();
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
}
