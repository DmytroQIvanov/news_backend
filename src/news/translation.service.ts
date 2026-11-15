import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { generateJsonWithRouter } from '../common/llm-router';
import { readEnv } from '../common/r2-storage';
import { DatabaseService } from '../database/database.service';

/**
 * English is canonical; this worker fills every other language.
 * - Ukrainian: fills title_uk / summary_uk / why_it_matters when the editorial pass did not return them.
 * - Extra languages (APP_EXTRA_LANGS, e.g. "pl,de,es"): rows in news_translations.
 * Uses the router's 'translate' chain (Groq first: fast and cheap on tokens; then Gemini, OpenRouter).
 */

const LANG_NAMES: Record<string, string> = {
  uk: 'Ukrainian', pl: 'Polish', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', pt: 'Portuguese',
  ro: 'Romanian', cs: 'Czech', tr: 'Turkish', ja: 'Japanese', ko: 'Korean', zh: 'Chinese (Simplified)', ar: 'Arabic',
};

const BATCH = 6;

const schema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, why: { type: 'string' } },
        required: ['id', 'title', 'summary', 'why'],
      },
    },
  },
  required: ['items'],
};

export function getExtraLangs(): string[] {
  return (readEnv('APP_EXTRA_LANGS') || '')
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => /^[a-z]{2}$/.test(l) && l !== 'en' && l !== 'uk');
}

export function buildTranslationPrompt(lang: string, items: Array<{ id: string; title: string; summary: string; why: string }>): string {
  const name = LANG_NAMES[lang] || lang;
  return `Translate these news items from English into natural, modern ${name} for a news app.
Keep facts, numbers, names and [n] source references exactly; do not add or remove information; no clickbait.
Return JSON {"items":[{"id","title","summary","why"}]} with the same ids.

${JSON.stringify(items)}`;
}

@Injectable()
export class TranslationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TranslationService.name);
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private running = false;

  constructor(@Optional() private readonly db?: DatabaseService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.db || process.env.TRANSLATIONS_ENABLED === 'false') return;
    const loop = (delay: number) => {
      this.timer = setTimeout(async () => {
        if (this.destroyed) return;
        try {
          await this.runOnce();
        } catch (err) {
          this.logger.warn(`Translation run failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.destroyed) loop(Math.max(3 * 60_000, Number(readEnv('TRANSLATION_INTERVAL_MS')) || 8 * 60_000));
        }
      }, delay);
    };
    loop(2 * 60_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async runOnce(): Promise<{ uk: number; extra: number }> {
    if (!this.db || this.running) return { uk: 0, extra: 0 };
    this.running = true;
    try {
      const uk = await this.fillUkrainian();
      let extra = 0;
      for (const lang of getExtraLangs()) extra += await this.fillExtra(lang);
      if (uk || extra) this.logger.log(`Translated ${uk} item(s) to Ukrainian, ${extra} to extra languages`);
      return { uk, extra };
    } finally {
      this.running = false;
    }
  }

  private async translate(lang: string, items: Array<{ id: string; title: string; summary: string; why: string }>) {
    const res = await generateJsonWithRouter<{ items?: Array<{ id: string; title: string; summary: string; why: string }> }>({
      task: 'translate',
      prompt: buildTranslationPrompt(lang, items),
      schema,
      schemaName: 'translations',
      maxTokens: 2500,
      temperature: 0.2,
      timeoutMs: 40_000,
    });
    if (!res) return { rows: [], model: null as string | null };
    const ids = new Set(items.map((i) => i.id));
    const rows = (res.data.items ?? []).filter((r) => r && ids.has(String(r.id)) && typeof r.title === 'string' && r.title.trim());
    return { rows, model: `${res.provider}:${res.model}` };
  }

  private async sourceRows(where: string, params: unknown[]) {
    const { rows } = await this.db!.query<{ id: string; title: string; summary: string; why: string }>(
      `SELECT n.id::text,
              COALESCE(n.ai_metadata->'article'->>'title', n.original_title) AS title,
              COALESCE(n.ai_metadata->'article'->>'summary', n.original_summary, '') AS summary,
              COALESCE(n.ai_metadata->'article'->>'importance_reason', '') AS why
       FROM news_items n
       WHERE n.status = 'published' AND n.published_at >= now() - interval '48 hours'
         AND n.ai_metadata->'article'->>'canonical_lang' = 'en' ${where}
       ORDER BY COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) DESC, n.published_at DESC
       LIMIT ${BATCH * 3}`,
      params,
    );
    return rows.map((r) => ({ ...r, summary: r.summary.slice(0, 900), why: r.why.slice(0, 400) }));
  }

  private async fillUkrainian(): Promise<number> {
    const rows = await this.sourceRows(`AND n.title_uk IS NULL`, []);
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { rows: out } = await this.translate('uk', rows.slice(i, i + BATCH)).catch(() => ({ rows: [], model: null }));
      for (const r of out) {
        await this.db!.query(
          `UPDATE news_items SET title_uk = $2, summary_uk = $3, why_it_matters = COALESCE(why_it_matters, NULLIF($4, '')), updated_at = now()
           WHERE id = $1::bigint AND title_uk IS NULL`,
          [r.id, r.title.slice(0, 350), r.summary.slice(0, 2500), r.why.slice(0, 1500)],
        );
        done += 1;
      }
      if (!out.length) break;
    }
    return done;
  }

  private async fillExtra(lang: string): Promise<number> {
    const rows = await this.sourceRows(`AND NOT EXISTS (SELECT 1 FROM news_translations t WHERE t.news_id = n.id AND t.lang = $1)`, [lang]);
    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { rows: out, model } = await this.translate(lang, rows.slice(i, i + BATCH)).catch(() => ({ rows: [], model: null }));
      for (const r of out) {
        await this.db!.query(
          `INSERT INTO news_translations (news_id, lang, title, summary, why_it_matters, model) VALUES ($1::bigint, $2, $3, $4, $5, $6)
           ON CONFLICT (news_id, lang) DO NOTHING`,
          [r.id, lang, r.title.slice(0, 350), r.summary.slice(0, 2500), r.why.slice(0, 1500), model],
        );
        done += 1;
      }
      if (!out.length) break;
    }
    return done;
  }
}
