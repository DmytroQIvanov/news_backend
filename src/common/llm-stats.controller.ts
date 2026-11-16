import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { IngestKeyGuard } from './ingest-key.guard';
import { llmLimits } from './llm-router';
import { formatLlmReportText, LlmStatsService } from './llm-stats';

@Controller('ai')
@UseGuards(IngestKeyGuard)
export class LlmStatsController {
  constructor(private readonly stats: LlmStatsService) {}

  /** AI usage and failures per provider/model/task. `?days=7` (1-90), `?format=text` for a readable report. Needs x-ingest-key. */
  @Get('stats')
  @Header('Cache-Control', 'no-store')
  async report(@Query('days') daysRaw?: string, @Query('format') format?: string) {
    const report = await this.stats.report(Number(daysRaw) || 7, llmLimits());
    return format === 'text' ? formatLlmReportText(report) : report;
  }
}
