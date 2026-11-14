import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from '../common/ingest-key.guard';
import { IngestRequestDto } from './ingest.dto';
import { IngestService } from './ingest.service';
@Controller('ingest')
@UseGuards(IngestKeyGuard)
export class IngestController {
  constructor(private readonly ingest: IngestService) {}
  @Post('news')
  ingestNews(@Body() dto: IngestRequestDto) { return this.ingest.ingest(dto); }
}
