import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { generateJsonWithRouter } from '../common/llm-router';
import { availableImageProviders, generateImage } from '../common/image-providers';
import { MediaStorage } from '../common/media-storage';
import { DatabaseService } from '../database/database.service';
import { TRAGEDY_SENSITIVITY_RE } from './news-memes.service';

/** Only light topics get satire. Politics, defense, health, law and anything tragic never do. */
export const CARICATURE_SAFE_CATEGORIES = new Set([
  'model', 'api', 'coding', 'open_source', 'research', 'global_tech', 'hardware_gaming',
  'startups_fintech', 'business', 'science_space', 'culture', 'career',
]);

const STYLE_PREFIX =
  'Editorial cartoon, clean flat vector illustration, bold outlines, warm limited color palette, ' +
  'witty visual metaphor, symbolic objects and anthropomorphic gadgets, no text, no letters, no logos, ' +
  'no real people, no recognizable faces, no flags, no weapons, no violence. Scene: ';

const MAX_REPORTS_BEFORE_HIDE = 3;

export interface CaricatureItem {
  id: string;
  newsId: string | null;
  clusterId: string | null;
  imageUrl: string;
  caption: string;
  captionUk: string;
  captionEn: string | null;
  category: string | null;
  label: string;
  aiGenerated: true;
  createdAt: string;
}

export interface CaricatureIdea {
  safe: boolean;
  reason: string;
  scene: string;
  captionUk: string;
  captionEn: string;
}

const ideaSchema = {
  type: 'object',
  properties: {
    safe: { type: 'boolean' },
    reason: { type: 'string' },
    scene: { type: 'string' },
    captionUk: { type: 'string' },
    captionEn: { type: 'string' },
  },
  required: ['safe', 'reason', 'scene', 'captionUk', 'captionEn'],
};

export function isCaricatureCandidate(item: { category?: string | null; title?: string | null; summary?: string | null }): boolean {
  if (!item.category || !CARICATURE_SAFE_CATEGORIES.has(item.category)) return false;
  return !TRAGEDY_SENSITIVITY_RE.test(`${item.title || ''} ${item.summary || ''}`);
}

/** Extra guard on the image prompt itself: the generator must never be asked for a real person. */
export function sanitizeCaricatureScene(scene: string): string | null {
  const cleaned = scene.replace(/\s+/g, ' ').trim().slice(0, 600);
  if (cleaned.length < 20) return null;
  if (/\b(photo(?:realistic)?|realistic|portrait of|face of|likeness|Musk|Altman|Zuckerberg|Trump|Putin|Zelensk|Biden|Pichai|Nadella|Huang|Amodei|Hassabis)\b/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

@Injectable()
export class CaricatureService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaricatureService.name);
  private readonly storage: MediaStorage;
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private running = false;
  private lastKick = 0;
  private lastError: string | null = null;
  private lastRunAt: string | null = null;

  constructor(@Optional() private readonly db?: DatabaseService) {
    this.storage = new MediaStorage(db);
  }

  private hasLlm(): boolean {
    return Boolean(
      process.env.GEMINI_API_KEY?.trim() ||
        process.env.groq_api_key?.trim() ||
        process.env.GROQ_API_KEY?.trim() ||
        process.env.openrouter_api_key?.trim() ||
        process.env.OPENROUTER_API_KEY?.trim(),
    );
  }

  /** Works with zero Cloudflare setup: Pollinations is the keyless image fallback, Postgres is the storage fallback. */
  get enabled(): boolean {
    return (
      process.env.CARICATURES_ENABLED !== 'false' &&
      this.storage.configured &&
      availableImageProviders().length > 0 &&
      this.hasLlm()
    );
  }

  get storageConfigured(): boolean {
    return this.storage.configured;
  }

  /** Why caricatures are (not) being produced: shown by GET /api/v1/feed/caricatures so "nothing happens" is never a mystery. */
  diagnostics() {
    const problems: string[] = [];
    if (process.env.CARICATURES_ENABLED === 'false') problems.push('CARICATURES_ENABLED=false');
    if (!this.storage.configured) problems.push('no storage (database unavailable and R2 not configured)');
    if (availableImageProviders().length === 0) {
      problems.push('no image provider (set cloudflare_account_id/cloudflare_api_token or leave POLLINATIONS_ENABLED on)');
    }
    if (!this.hasLlm()) problems.push('no LLM key for the cartoon idea (GEMINI_API_KEY, groq_api_key or openrouter_api_key)');
    return {
      enabled: this.enabled,
      storageBackend: this.storage.backend,
      imageProviders: availableImageProviders(),
      dailyMax: this.dailyMax(),
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      problems,
    };
  }

  /** Called when the app asks for caricatures and none exist yet: kicks one background batch, at most every 20 minutes. */
  kickIfStale(): void {
    if (!this.enabled || this.running || Date.now() - this.lastKick < 20 * 60_000) return;
    this.lastKick = Date.now();
    void this.generateBatch().catch((err) => {
      this.lastError = err instanceof Error ? err.message : String(err);
    });
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.enabled || !this.db) return;
    const intervalMs = Math.max(20 * 60_000, Number(process.env.CARICATURE_INTERVAL_MS) || 90 * 60_000);
    const loop = (delay: number) => {
      this.timer = setTimeout(async () => {
        if (this.destroyed) return;
        try {
          await this.generateBatch();
        } catch (err) {
          this.logger.warn(`Caricature batch failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.destroyed) loop(intervalMs);
        }
      }, delay);
    };
    loop(90_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private dailyMax(): number {
    const n = Number(process.env.CARICATURE_DAILY_MAX);
    return Number.isInteger(n) && n >= 0 && n <= 100 ? n : 12;
  }

  async generateBatch(maxThisRun = 3): Promise<{ generated: number; skipped: number }> {
    if (!this.enabled || !this.db || this.running) return { generated: 0, skipped: 0 };
    this.running = true;
    this.lastRunAt = new Date().toISOString();
    let generated = 0;
    let skipped = 0;
    try {
      const { rows: usage } = await this.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM news_caricatures WHERE created_at >= date_trunc('day', now())`,
      );
      const remaining = Math.max(0, this.dailyMax() - (usage[0]?.n ?? 0));
      if (remaining === 0) return { generated, skipped };

      const { rows } = await this.db.query<{
        id: string; cluster_id: string | null; category: string; title: string; summary: string; original_title: string;
      }>(
        `SELECT n.id::text, n.cluster_id, n.category,
                COALESCE(n.title_uk, n.original_title) AS title,
                COALESCE(n.summary_uk, n.original_summary, '') AS summary,
                n.original_title
         FROM news_items n
         LEFT JOIN news_caricatures c ON c.news_item_id = n.id
         WHERE n.status = 'published'
           AND c.id IS NULL
           AND n.published_at >= now() - interval '36 hours'
           AND n.category = ANY($1::text[])
         ORDER BY (CASE WHEN n.ai_metadata->'article'->'important' = 'true'::jsonb THEN 1 ELSE 0 END
                   + LEAST(jsonb_array_length(COALESCE(n.cluster_sources, '[]'::jsonb)), 5)) DESC,
                  n.published_at DESC
         LIMIT 12`,
        [[...CARICATURE_SAFE_CATEGORIES]],
      );

      for (const row of rows) {
        if (generated >= Math.min(maxThisRun, remaining) || this.destroyed) break;
        if (!isCaricatureCandidate(row)) {
          skipped += 1;
          continue;
        }
        let storageFailed = false;
        const ok = await this.generateForNews(row).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Caricature for news ${row.id} failed: ${msg}`);
          this.lastError = msg.slice(0, 300);
          // Every image provider is down: stop burning time on the remaining rows.
          if (/No image provider succeeded/.test(msg)) storageFailed = true;
          return false;
        });
        if (storageFailed) break;
        if (ok) generated += 1;
        else skipped += 1;
      }
    } finally {
      this.running = false;
    }
    if (generated > 0) {
      this.logger.log(`Generated ${generated} AI caricature(s)`);
      void this.storage.prune();
    }
    return { generated, skipped };
  }

  private async proposeIdea(item: { title: string; summary: string; original_title: string; category: string }): Promise<CaricatureIdea | null> {
    const prompt = `You are a kind, clever editorial cartoonist for a tech news app with a young audience.
News (category ${item.category}):
Title: ${item.original_title}
Ukrainian title: ${item.title}
Summary: ${item.summary.slice(0, 900)}

Decide if a light-hearted cartoon is appropriate. Set safe=false for anything involving death, injury, war, the military, disasters, crime victims, illness, religion, elections or a specific real person being mocked.
If safe, describe ONE visual metaphor scene in English for an image generator (max 60 words): symbolic objects, robots, gadgets, animals or generic cartoon characters. Never depict or name real people, brands, logos, flags or any text in the image.
Write captionUk (Ukrainian, max 120 chars) and captionEn (English, max 120 chars): a gentle witty one-liner about the situation, not about a person. No insults.`;
    const routed = await generateJsonWithRouter<Partial<CaricatureIdea>>({
      task: 'creative',
      prompt,
      schema: ideaSchema,
      schemaName: 'caricature_idea',
      maxTokens: 600,
      temperature: 0.8,
      timeoutMs: 30_000,
    });
    if (!routed) return null;
    const parsed = routed.data;
    return {
      safe: parsed.safe === true,
      reason: String(parsed.reason || '').slice(0, 300),
      scene: String(parsed.scene || ''),
      captionUk: String(parsed.captionUk || '').trim().slice(0, 160),
      captionEn: String(parsed.captionEn || '').trim().slice(0, 160),
    };
  }

  private async generateForNews(row: {
    id: string; cluster_id: string | null; category: string; title: string; summary: string; original_title: string;
  }): Promise<boolean> {
    if (!this.db) return false;
    const idea = await this.proposeIdea(row);
    if (!idea || !idea.safe || !idea.captionUk) return false;
    const scene = sanitizeCaricatureScene(idea.scene);
    if (!scene) return false;

    const imagePrompt = `${STYLE_PREFIX}${scene}`;
    const { image, contentType, model } = await generateImage(imagePrompt);
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const hash = createHash('sha256').update(image).digest('hex').slice(0, 16);
    const objectKey = await this.storage.putObject(`caricatures/${row.id}-${hash}.${ext}`, image, contentType);
    this.lastError = null;

    await this.db.query(
      `INSERT INTO news_caricatures (news_item_id, cluster_id, object_key, caption_uk, caption_en, image_prompt, image_model, category)
       VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [row.id, row.cluster_id, objectKey, idea.captionUk, idea.captionEn || null, imagePrompt, model, row.category],
    );
    return true;
  }

  async list(options: { limit: number; lang: string; apiBase: string; newsIds?: string[] }): Promise<CaricatureItem[]> {
    if (!this.db) return [];
    try {
      const { rows } = await this.db.query<{
        id: string; news_item_id: string | null; cluster_id: string | null; object_key: string;
        caption_uk: string; caption_en: string | null; category: string | null; created_at: Date;
      }>(
        `SELECT id::text, news_item_id::text, cluster_id, object_key, caption_uk, caption_en, category, created_at
         FROM news_caricatures
         WHERE status = 'visible' AND ($2::text[] IS NULL OR news_item_id::text = ANY($2::text[]))
         ORDER BY created_at DESC
         LIMIT $1`,
        [options.limit, options.newsIds?.length ? options.newsIds : null],
      );
      if (rows.length === 0) this.kickIfStale();
      return rows.map((r) => this.toItem(r, options.lang, options.apiBase));
    } catch {
      return [];
    }
  }

  private toItem(
    r: { id: string; news_item_id: string | null; cluster_id: string | null; object_key: string; caption_uk: string; caption_en: string | null; category: string | null; created_at: Date },
    lang: string,
    apiBase: string,
  ): CaricatureItem {
    const caption = lang === 'en' && r.caption_en ? r.caption_en : r.caption_uk;
    return {
      id: r.id,
      newsId: r.news_item_id,
      clusterId: r.cluster_id,
      imageUrl: this.storage.publicUrl(r.object_key, apiBase),
      caption,
      captionUk: r.caption_uk,
      captionEn: r.caption_en,
      category: r.category,
      label: lang === 'en' ? 'Satire · AI-generated' : 'Сатира · згенеровано AI',
      aiGenerated: true,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  /** Google Play AI-content policy: users must be able to flag generated content. Hidden after 3 reports. */
  async report(id: string, deviceId: string, reason: string): Promise<{ hidden: boolean; reports: number }> {
    if (!this.db) return { hidden: false, reports: 0 };
    const inserted = await this.db.query(
      `INSERT INTO caricature_reports (caricature_id, device_id, reason) VALUES ($1::bigint, $2::uuid, $3)
       ON CONFLICT DO NOTHING`,
      [id, deviceId, reason],
    );
    const { rows } = await this.db.query<{ report_count: number; status: string }>(
      `UPDATE news_caricatures
       SET report_count = report_count + $2::int,
           status = CASE WHEN report_count + $2::int >= $3::int THEN 'hidden' ELSE status END
       WHERE id = $1::bigint
       RETURNING report_count, status`,
      [id, inserted.rowCount ? 1 : 0, MAX_REPORTS_BEFORE_HIDE],
    );
    return { hidden: rows[0]?.status === 'hidden', reports: rows[0]?.report_count ?? 0 };
  }

  async readMedia(objectKey: string) {
    return this.storage.getObject(objectKey);
  }
}
