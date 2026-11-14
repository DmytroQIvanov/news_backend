import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Math.max(1, Math.min(10, Number(process.env.DB_POOL_MAX || 3))),
      connectionTimeoutMillis: 12_000,
      idleTimeoutMillis: 15_000,
    });
    this.pool.on('error', err => console.error('Database idle client error:', err.message));
  }
  query<T extends QueryResultRow = QueryResultRow>(sql: string, args: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, args);
  }
  connect(): Promise<PoolClient> { return this.pool.connect(); }
  async onModuleDestroy(): Promise<void> { await this.pool.end(); }
}
