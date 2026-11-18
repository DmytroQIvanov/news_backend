import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { buildDataDocs } from './kb-data';

/** Refreshes deterministic data links independently of the editor/LLM and API traffic. */
@Injectable()
export class KbDataService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(KbDataService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;
  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.KB_DATA_LINKS_ENABLED === 'false') return;
    const schedule = () => {
      this.timer = setTimeout(async () => {
        try { await this.runOnce(); }
        catch (error) { this.log.warn(`Data linking failed: ${error instanceof Error ? error.message : error}`); }
        finally { if (!this.stopped) schedule(); }
      }, 60_000);
      this.timer.unref();
    };
    schedule();
  }
  onModuleDestroy() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  async runOnce() {
    if (this.running) return { checked: 0, failed: 0 };
    this.running = true;
    let checked = 0, failed = 0;
    try {
      const events = (await this.db.query(
        `SELECT e.id,e.category,e.last_seen_at FROM kb.events e
         LEFT JOIN kb.event_data_refresh s ON s.event_id=e.id
         WHERE e.status<>'merged' AND (e.last_seen_at>now()-interval '400 days' OR e.article_news_id IS NOT NULL)
           AND (s.event_id IS NULL OR s.next_check_at<=now())
         ORDER BY s.checked_at NULLS FIRST,e.importance DESC,e.id LIMIT 20`,
      )).rows;
      for (const event of events) {
        // Atomic per-event lease: multiple API replicas cannot process the same event concurrently.
        const claim = await this.db.query(
          `INSERT INTO kb.event_data_refresh(event_id,next_check_at) VALUES($1,now()+interval '10 minutes')
           ON CONFLICT(event_id) DO UPDATE SET next_check_at=EXCLUDED.next_check_at
             WHERE kb.event_data_refresh.next_check_at<=now() RETURNING event_id`, [event.id],
        );
        if (!claim.rowCount) continue;
        try {
          const entities = (await this.db.query(`SELECT entity_id::int AS id FROM kb.event_entities WHERE event_id=$1 ORDER BY weight DESC LIMIT 40`, [event.id])).rows;
          await buildDataDocs(this.db,Number(event.id),event.category,entities as any,
            event.last_seen_at instanceof Date ? event.last_seen_at.toISOString() : event.last_seen_at);
          await this.db.query(`UPDATE kb.event_data_refresh SET checked_at=now(),next_check_at=now()+interval '6 hours',last_error=NULL WHERE event_id=$1`, [event.id]);
          checked++;
        } catch (error) {
          await this.db.query(`UPDATE kb.event_data_refresh SET last_error=$2,next_check_at=now()+interval '10 minutes' WHERE event_id=$1`,
            [event.id,error instanceof Error ? error.message.slice(0,500) : 'Data linking failed']);
          failed++;
        }
      }
      return { checked, failed };
    } finally { this.running = false; }
  }
}
