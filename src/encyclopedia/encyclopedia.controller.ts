import { Controller, Get, Header, NotFoundException, Param, Query } from '@nestjs/common';
import { EncyclopediaService } from './encyclopedia.service';

@Controller('encyclopedia')
export class EncyclopediaController {
  constructor(private readonly encyclopedia: EncyclopediaService) {}
  @Get('categories')
  @Header('Cache-Control', 'public, max-age=180, stale-while-revalidate=300')
  categories(@Query('lang') lang = 'en') { return this.encyclopedia.categories(lang); }
  @Get()
  @Header('Cache-Control', 'public, max-age=180, stale-while-revalidate=300')
  list(@Query('category') category?: string, @Query('q') q?: string, @Query('kind') kind?: string,
    @Query('limit') limit?: string, @Query('cursor') cursor?: string, @Query('lang') lang = 'en') {
    return this.encyclopedia.list({ category,q,kind,limit,cursor },lang);
  }
  @Get(':slug')
  @Header('Cache-Control', 'public, max-age=180, stale-while-revalidate=300')
  async entry(@Param('slug') slug: string, @Query('lang') lang = 'en') {
    const entry = await this.encyclopedia.entry(slug,lang);
    if (!entry) throw new NotFoundException('Encyclopedia entry not found');
    return entry;
  }
}
