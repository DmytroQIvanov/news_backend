import { publicationReadySql } from '../news/eligibility';
/**
 * Translations of knowledge-base articles. The editor writes only the English canonical text; this worker translates
 * it with cheap models (the router's 'translate' chain: Groq, Gemini Flash-Lite, OpenRouter) into Ukrainian and the
 * extra app languages (APP_EXTRA_LANGS), body included, chunk by chunk so long reads are never cut.
 *
 * A NEW article goes live only after its Ukrainian version exists and passed the length check; an updated article
 * stays live and its translations are refreshed. Flagships are translated first.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { splitParagraphChunks, translationTooShort } from '../ingest/gemini-editor.service';
import { getExtraLangs } from '../news/translation.service';
import { cheapJson } from './kb-llm';

const LANG_NAMES: Record<string, string> = {
  uk: 'Ukrainian', pl: 'Polish', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', pt: 'Portuguese',
  ro: 'Romanian', cs: 'Czech', tr: 'Turkish', ja: 'Japanese', ko: 'Korean', zh: 'Chinese (Simplified)', ar: 'Arabic',
};

const HEAD_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, summary: { type: 'string' }, why: { type: 'string' } },
  required: ['title', 'summary', 'why'],
};
const CHUNK_SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };

const system = (lang: string) => `You are a professional news translator into ${LANG_NAMES[lang] ?? lang}.
Translate faithfully and naturally for news readers: same facts, numbers, names, dates and nuance; nothing added or
removed; keep every [n] citation exactly where it is; keep "## " headings and paragraph breaks; proper names in the
standard spelling of that language${lang === 'uk' ? ' (Ukrainian media style, e.g. Зеленський, Сирський, Пентагон)' : ''}.`;

export type Translator = (lang: string, head: { title: string; summary: string; why: string }, body: string) =>
  Promise<{ title: string; summary: string; why: string; body: string; model: string } | null>;

export const cheapTranslator: Translator = async (lang, head, body) => {
  const h = await cheapJson<{ title: string; summary: string; why: string }>('translate', system(lang),
    `Translate this JSON (values only) into ${LANG_NAMES[lang] ?? lang}:\n${JSON.stringify(head)}`, HEAD_SCHEMA, 2000);
  if (!h?.json?.title) return null;
  const parts: string[] = [];
  for (const chunk of splitParagraphChunks(body, 5000)) {
    const c = await cheapJson<{ text: string }>('translate', system(lang),
      `Translate this part of a news article into ${LANG_NAMES[lang] ?? lang}. Return {"text": "..."}.\n\n${chunk}`, CHUNK_SCHEMA,
      Math.ceil(chunk.length / 2) + 1500);
    if (!c?.json?.text?.trim()) return null; // never publish a half-translated body
    parts.push(c.json.text.trim());
  }
  return { title: h.json.title, summary: h.json.summary, why: h.json.why, body: parts.join('\n\n'), model: h.model };
};

@Injectable()
export class KbTranslationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbTranslationService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;
  translator: Translator = cheapTranslator;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.KB_TRANSLATION === 'false') return;
    this.timer = setTimeout(() => void this.loop(), 60_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`KB translation failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), 2 * 60_000);
    }
  }

  async runOnce(limit = 6) {
    if (this.running) return { translated: 0, published: 0, failed: 0 };
    this.running = true;
    const out = { translated: 0, published: 0, failed: 0 };
    const run = await this.db.query<{ id: string }>(`INSERT INTO kb.pipeline_runs (worker) VALUES ('translation') RETURNING id`)
      .then((r) => r.rows[0]?.id).catch(() => undefined);
    let completed = false;
    try {
      const rows = (await this.db.query(
        `SELECT id, status, ai_metadata->'article' AS article, COALESCE((ai_metadata->'kb'->>'translation_attempts')::int, 0) AS attempts,
                COALESCE((ai_metadata->'kb'->>'checks_passed')::boolean, false) AS checks_passed
         FROM news_items
         WHERE kb_event_id IS NOT NULL AND ai_metadata->'kb'->>'awaiting_translation' = 'true'
           AND COALESCE((ai_metadata->'kb'->>'translation_attempts')::int, 0) < 3
         ORDER BY (editorial_tier = 'flagship') DESC, (editorial_tier = 'big') DESC, updated_at
         LIMIT $1`,
        [limit],
      )).rows;
      for (const r of rows) {
        if (this.stopped) break;
        const a = r.article ?? {};
        const head = { title: String(a.title ?? ''), summary: String(a.summary ?? ''), why: String(a.importance_reason ?? '') };
        const body = String(a.body ?? '');
        const uk = await this.translator('uk', head, body).catch(() => null);
        if (!uk || translationTooShort(body, uk.body)) {
          out.failed += 1;
          await this.db.query(
            `UPDATE news_items SET ai_metadata = jsonb_set(ai_metadata, '{kb,translation_attempts}', to_jsonb($2::int)) WHERE id = $1`,
            [r.id, Number(r.attempts) + 1],
          );
          continue;
        }
        const goLive = r.status === 'needs_review' && r.checks_passed;
        const translated = await this.db.query<{ status: string }>(
          `UPDATE news_items n SET title_uk = $2::text, summary_uk = $3::text, why_it_matters = $4::text,
                  ai_metadata = jsonb_set(
                    jsonb_set(ai_metadata, '{article}', (ai_metadata->'article') || jsonb_build_object(
                      'title_uk', $2::text, 'summary_uk', $3::text, 'why_it_matters_uk', $4::text, 'body_uk', $5::text)),
                    '{kb,awaiting_translation}', 'false'::jsonb) || jsonb_build_object('translation_model', $6::text),
                  status = CASE WHEN $7 AND status = 'needs_review' AND ${publicationReadySql()} THEN 'published' ELSE status END,
                  published_at = CASE WHEN $7 AND status = 'needs_review' AND ${publicationReadySql()} THEN GREATEST(COALESCE(published_at, now()), now() - interval '6 hours') ELSE published_at END,
                  updated_at = now()
           WHERE id = $1 AND status <> 'rejected' AND ai_metadata->'article' = $8::jsonb RETURNING status`,
          [r.id, uk.title.slice(0, 350), uk.summary.slice(0, 2500), uk.why.slice(0, 1500), uk.body.slice(0, 20_000), uk.model, goLive, JSON.stringify(a)],
        );
        if (!translated.rows[0]) continue; // Concurrent replacement/rejection: discard this result.
        out.translated += 1;
        if (goLive && translated.rows[0].status === 'published') out.published += 1;
        for (const lang of getExtraLangs()) {
          const tr = await this.translator(lang, head, body).catch(() => null);
          if (!tr) continue;
          await this.db.query(
            `INSERT INTO news_translations (news_id, lang, title, summary, why_it_matters, body, model) VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (news_id, lang) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary,
                    why_it_matters = EXCLUDED.why_it_matters, body = EXCLUDED.body, model = EXCLUDED.model`,
            [r.id, lang, tr.title.slice(0, 350), tr.summary.slice(0, 2500), tr.why.slice(0, 1500), tr.body, tr.model],
          ).catch(() => undefined);
        }
      }
      completed = true;
    } finally {
      if (run) await this.db.query(`UPDATE kb.pipeline_runs SET finished_at = now(), stats = $2::jsonb, error = $3 WHERE id = $1`,
        [run, JSON.stringify(out), completed && !out.failed ? null : 'translation_failed']).catch(() => undefined);
      this.running = false;
    }
    if (out.translated || out.failed) this.logger.log(`KB translation: ${JSON.stringify(out)}`);
    return out;
  }
}
