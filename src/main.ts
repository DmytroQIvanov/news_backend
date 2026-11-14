import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import { AppModule } from './app.module';
import { createRateLimiter } from './common/rate-limit.middleware';

async function bootstrap(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('Set DATABASE_URL to your PostgreSQL connection string. See .env.example for local development.');
  }
  if (!process.env.INGEST_API_KEY || process.env.INGEST_API_KEY.length < 32 || process.env.INGEST_API_KEY.startsWith('replace_')) {
    throw new Error('Set a real INGEST_API_KEY at least 32 characters long');
  }
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.use(json({ limit: '2mb' }));
  app.use((req: { method?: string; path?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    if (req.method === 'GET' && req.path && /^\/api\/v1\/(news|catalog|games)/.test(req.path)) {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    }
    next();
  });
  app.use(createRateLimiter({ windowMs: 60_000, maxRequests: 30, paths: [/^\/api\/v1\/(ingest|catalog\/refresh|news\/[^/]+\/publish)/] }));
  app.use(createRateLimiter({ windowMs: 60_000, maxRequests: 180 }));
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/db', 'health/summary'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (origins.length) app.enableCors({ origin: origins, methods: ['GET', 'POST', 'PATCH'], allowedHeaders: ['Content-Type', 'x-ingest-key'] });
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`Opportunity Radar listening on :${port}`);
}
bootstrap().catch(err => { console.error('Startup failed:', err?.message || err); process.exit(1); });
