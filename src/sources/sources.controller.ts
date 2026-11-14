import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
@Controller('sources')
export class SourcesController {
  constructor(private readonly db: DatabaseService) {}
  @Get()
  async list() {
    const result = await this.db.query('SELECT slug,name,homepage_url,feed_url,unofficial FROM sources WHERE enabled=true ORDER BY name');
    return { items: result.rows };
  }
}
