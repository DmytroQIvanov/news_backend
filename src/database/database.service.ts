import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;
  private keepAliveTimer?: NodeJS.Timeout;
  private isDestroyed = false;

  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Math.max(1, Math.min(10, Number(process.env.DB_POOL_MAX || 3))),
      connectionTimeoutMillis: 25_000, // the DB is on another VM that is CPU-starved at times
      idleTimeoutMillis: 15_000,
    });
    this.pool.on('error', err => console.error('Database idle client error:', err.message));
  }

  onModuleInit() {
    // Neon PostgreSQL free tier suspends compute after 5 minutes of inactivity.
    // Periodic keepalive ping every 4 minutes (or configurable via DB_KEEPALIVE_INTERVAL_MS)
    // keeps database connection active while the backend is alive.
    const intervalMs = Math.max(60_000, Number(process.env.DB_KEEPALIVE_INTERVAL_MS) || 4 * 60_000);
    const schedulePing = () => {
      this.keepAliveTimer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.pool.query('SELECT 1');
          this.logger.debug('Database keepalive ping successful');
        } catch (error) {
          this.logger.warn(`Database keepalive ping failed: ${error instanceof Error ? error.message : error}`);
        } finally {
          if (!this.isDestroyed) schedulePing();
        }
      }, intervalMs);
    };
    schedulePing();
  }

  query<T extends QueryResultRow = QueryResultRow>(sql: string, args: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, args);
  }

  connect(): Promise<PoolClient> { return this.pool.connect(); }

  async onModuleDestroy(): Promise<void> {
    this.isDestroyed = true;
    if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer);
    await this.pool.end();
  }
}
