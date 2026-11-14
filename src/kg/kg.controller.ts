import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { KgService } from './kg.service';

@Controller('kg')
export class KgController {
  constructor(private readonly kg: KgService) {}

  @Get('overview')
  overview() {
    return this.kg.getOverview();
  }

  @Get('entity/:slug')
  async entity(@Param('slug') slug: string) {
    if (!/^[a-z0-9-]{2,80}$/.test(slug)) {
      throw new BadRequestException('Invalid entity slug');
    }
    const result = await this.kg.getEntityGraph(slug);
    if (!result) throw new NotFoundException('Entity not found');
    return result;
  }

  @Get('news/:id')
  async newsEntities(@Param('id') id: string) {
    const entities = await this.kg.getEntitiesForNews(id);
    return { items: entities };
  }

  @Post('sync')
  @UseGuards(IngestKeyGuard)
  sync() {
    return this.kg.syncNewsLinks(200);
  }

  @Post('news/:id/correct')
  @UseGuards(IngestKeyGuard)
  async correctNews(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { correctionNote?: string; correctedByNewsId?: number; isRetracted?: boolean },
  ) {
    const note = body?.correctionNote?.trim();
    if (!note || note.length < 5) {
      throw new BadRequestException('correctionNote must be at least 5 characters');
    }
    const updated = await this.kg.markNewsCorrection(
      id,
      note,
      body.correctedByNewsId,
      body.isRetracted !== false,
    );
    if (!updated) throw new NotFoundException('News item not found');
    return updated;
  }
}
