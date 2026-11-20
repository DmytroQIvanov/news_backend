import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface KeepAliveStats {
  enabled: boolean;
  intervalMs: number;
  targetUrl: string;
  lastPingAt: string | null;
  lastOk: boolean | null;
  lastStatus: number | null;
  lastError: string | null;
  totalPings: number;
  lastDbPingAt: string | null;
  lastDbOk: boolean | null;
}

@Injectable()
export class KeepAliveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeepAliveService.name);
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  private warmupTimer?: NodeJS.Timeout;
  private isDestroyed = false;
  private tickCount = 0;
  private totalPings = 0;
  private lastPingAt: string | null = null;
  private lastOk: boolean | null = null;
  private lastStatus: number | null = null;
  private lastError: string | null = null;
  private lastDbPingAt: string | null = null;
  private lastDbOk: boolean | null = null;

  constructor(@Optional() private readonly db?: DatabaseService) {
    const rawInterval = Number(process.env.KEEP_ALIVE_INTERVAL_MS);
    this.intervalMs =
      Number.isFinite(rawInterval) && rawInterval > 0 ? Math.max(10_000, Math.round(rawInterval)) : 180_000;
    const explicit = process.env.KEEP_ALIVE_ENABLED;
    const hasTarget = Boolean((process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL)?.trim());
    this.enabled =
      process.env.NODE_ENV !== 'test' &&
      explicit !== 'false' &&
      (explicit === 'true' || hasTarget);
  }

  private getTargetHealthUrl(): string {
    const base =
      (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || 'http://127.0.0.1:3000')
        .trim()
        .replace(/\/+$/, '') || 'http://127.0.0.1:3000';
    return `${base}/api/v1/health?t=${Date.now()}`;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.debug('Self keep-alive timer disabled for test/configured environment.');
      return;
    }

    this.warmupTimer = setTimeout(() => {
      if (this.isDestroyed) return;
      void this.runTick();
    }, 10_000);
    this.warmupTimer.unref?.();

    this.timer = setInterval(() => {
      if (this.isDestroyed) return;
      void this.runTick();
    }, this.intervalMs);
    this.timer.unref?.();
    this.logger.log(`Self keep-alive active every ${Math.round(this.intervalMs / 1000)}s -> ${this.getTargetHealthUrl()}`);
  }

  onModuleDestroy(): void {
    this.isDestroyed = true;
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runTick(): Promise<KeepAliveStats> {
    this.tickCount += 1;
    const targetUrl = this.getTargetHealthUrl();
    const nowIso = new Date().toISOString();
    this.lastPingAt = nowIso;
    this.totalPings += 1;

    try {
      const resp = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'x-keep-alive': 'self',
          'User-Agent': 'OpportunityRadar-SelfKeepAlive/1.0',
          Accept: 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        },
        signal: AbortSignal.timeout(10_000),
      });
      await resp.body?.cancel().catch(() => undefined);
      this.lastOk = resp.ok;
      this.lastStatus = resp.status;
      this.lastError = resp.ok ? null : `HTTP ${resp.status}`;
    } catch (error) {
      this.lastOk = false;
      this.lastStatus = 0;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Self keep-alive HTTP ping failed: ${this.lastError}`);
    }

    if (this.tickCount % 3 === 0 && this.db) {
      try {
        await this.db.query('SELECT 1');
        this.lastDbPingAt = new Date().toISOString();
        this.lastDbOk = true;
      } catch (error) {
        this.lastDbPingAt = new Date().toISOString();
        this.lastDbOk = false;
        this.logger.warn(
          `Self keep-alive PostgreSQL ping failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return this.getKeepAliveStats();
  }

  getKeepAliveStats(): KeepAliveStats {
    return {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      targetUrl: this.getTargetHealthUrl(),
      lastPingAt: this.lastPingAt,
      lastOk: this.lastOk,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      totalPings: this.totalPings,
      lastDbPingAt: this.lastDbPingAt,
      lastDbOk: this.lastDbOk,
    };
  }
}
