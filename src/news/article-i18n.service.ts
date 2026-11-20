/**
 * Translates what the main translators leave out: background, "what's next", fact claims and the text inside the visuals,
 * into whichever of Ukrainian / English the original is not written in, so each language version shows its own language only.
 *
 * Uses the router's 'translate' chain (cheapest free model with budget first: Groq, Gemini Flash-Lite, OpenRouter), one queue,
 * a few articles per cycle, newest first. Results go to ai_metadata.article.i18n[lang]; originals are never overwritten.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { cheapJson } from '../kb/kb-llm';
import {
  I18nOverlay, I18nSource, UiLang, hasPending, needsTranslation, pendingParts, scriptLang, visualSlots,
} from './article-i18n';

const LANG_NAME: Record<UiLang, string> = { uk: 'Ukrainian', en: 'English' };
const SCHEMA = { type: 'object', properties: { texts: { type: 'array', items: { type: 'string' } } }, required: ['texts'] };
const MAX_BATCH_CHARS = 5000;
const MAX_ATTEMPTS = 3;

const system = (lang: UiLang) => `You translate short pieces of news-article UI text (chart titles, labels, captions, notes, short paragraphs) into ${LANG_NAME[lang]}.
Translate faithfully and naturally, in news style. Keep every number, date, currency amount and proper name correct; use the standard ${LANG_NAME[lang]} spelling of names${lang === 'uk' ? ' (Ukrainian media style)' : ''}.
Units stay short ("%", "$ bn", "млрд грн"). Keep [n] citation markers and line breaks exactly. Never add or remove information.
Return JSON {"texts": [...]} with exactly one translated string per input string, in the same order.`;

export type TextTranslator = (lang: UiLang, texts: string[]) => Promise<{ texts: string[]; model: string } | null>;

export const cheapTextTranslator: TextTranslator = async (lang, texts) => {
  const out: string[] = [];
  let model = '';
  let batch: string[] = [];
  let size = 0;
  const flush = async (): Promise<boolean> => {
    if (!batch.length) return true;
    const res = await cheapJson<{ texts?: string[] }>('translate', system(lang),
      `Translate every string of this JSON array into ${LANG_NAME[lang]}:\n${JSON.stringify(batch)}`, SCHEMA, Math.ceil(size / 2) + 800);
    const got = res?.json?.texts;
    if (Array.isArray(got) && got.length === batch.length && !got.some((t) => typeof t !== 'string' || !t.trim())) {
      out.push(...got.map((t) => t.trim()));
      model = res!.model;
    } else if (batch.length > 1) {
      // The model merged/split strings or answered badly: translate the strings one by one so one bad string cannot sink the article.
      for (const one of batch) {
        const r1 = await cheapJson<{ texts?: string[] }>('translate', system(lang),
          `Translate every string of this JSON array into ${LANG_NAME[lang]}:
${JSON.stringify([one])}`, SCHEMA, Math.ceil(one.length / 2) + 600);
        const g1 = r1?.json?.texts;
        if (!Array.isArray(g1) || g1.length !== 1 || typeof g1[0] !== 'string' || !g1[0].trim()) return false;
        out.push(g1[0].trim());
        model = r1!.model;
      }
    } else return false;
    batch = [];
    size = 0;
    return true;
  };
  for (const t of texts) {
    if (size + t.length > MAX_BATCH_CHARS && !(await flush())) return null;
    batch.push(t);
    size += t.length;
  }
  if (!(await flush())) return null;
  return { texts: out, model };
};

interface Job { text: string; apply: (value: string) => void }

/** Builds the overlay for one language, or null when nothing is missing. Throws nothing; null on any translator failure. */
export async function buildOverlay(
  src: I18nSource, target: UiLang, existing: I18nOverlay | undefined, translate: TextTranslator,
): Promise<I18nOverlay | null> {
  const parts = pendingParts(src, target);
  const overlay: I18nOverlay = { ...(existing ?? {}) };
  const jobs: Job[] = [];
  if (parts.background && !overlay.background && src.background) jobs.push({ text: src.background, apply: (v) => { overlay.background = v; } });
  if (parts.whats_next && !overlay.whats_next && src.whats_next) jobs.push({ text: src.whats_next, apply: (v) => { overlay.whats_next = v; } });
  if (parts.facts && !(overlay.facts && overlay.facts.length === (src.facts ?? []).length)) {
    const facts = (src.facts ?? []).map((f) => f.claim ?? '');
    overlay.facts = [...facts];
    facts.forEach((claim, i) => { if (needsTranslation(claim, target)) jobs.push({ text: claim, apply: (v) => { overlay.facts![i] = v; } }); });
  }
  if (parts.visuals) {
    const have = new Set((overlay.visuals ?? []).map((v) => v.id));
    const visuals = [...(overlay.visuals ?? [])];
    for (const original of src.visuals ?? []) {
      if (have.has(original.id)) continue;
      const copy = JSON.parse(JSON.stringify(original));
      const slots = visualSlots(copy).filter((s) => needsTranslation(s.get(), target));
      if (!slots.length) continue;
      visuals.push(copy);
      for (const s of slots) jobs.push({ text: s.get(), apply: (v) => s.set(v) });
    }
    overlay.visuals = visuals;
  }
  if (!jobs.length) return null;
  const res = await translate(target, jobs.map((j) => j.text));
  if (!res || res.texts.length !== jobs.length) return null;
  // Language sanity: a "translation" that is still in the source language is a failure, not a result.
  // Short strings made of product names ("Gemini 4 Carbon pricing") legitimately stay Latin, so only prose or a majority counts.
  let wrong = 0;
  for (let i = 0; i < jobs.length; i += 1) {
    const text = res.texts[i]!;
    const l = scriptLang(text);
    // Identical to the source = a name or label that has no translation ("Oracle (CVSS 3.1)"): fine.
    if (l !== null && l !== target && text.trim() !== jobs[i]!.text.trim()) {
      wrong += 1;
      if ((text.match(/\p{L}/gu) ?? []).length >= 60) return null;
    }
  }
  if (wrong / jobs.length > 0.4) return null;
  jobs.forEach((j, i) => j.apply(res.texts[i]!));
  return { ...overlay, at: new Date().toISOString(), model: res.model };
}

@Injectable()
export class ArticleI18nService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArticleI18nService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;
  translator: TextTranslator = cheapTextTranslator;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.ARTICLE_I18N === 'false') return;
    this.timer = setTimeout(() => void this.loop(), 90_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`Article i18n failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), 90_000);
    }
  }

  async runOnce(limit = 4) {
    const out = { translated: 0, failed: 0, skipped: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const { rows } = await this.db.query<{ id: string; article: any; visuals: any }>(
        `SELECT n.id, n.ai_metadata->'article' AS article, COALESCE(n.media->'visuals', '[]'::jsonb) AS visuals
         FROM news_items n
         WHERE n.status = 'published' AND n.ai_metadata->'article' IS NOT NULL
         ORDER BY n.published_at DESC NULLS LAST, n.id DESC
         LIMIT 80`,
      );
      let done = 0;
      for (const r of rows) {
        if (this.stopped || done >= limit) break;
        const article = r.article ?? {};
        const src: I18nSource = { background: article.background, whats_next: article.whats_next, facts: article.facts, visuals: r.visuals };
        for (const target of ['uk', 'en'] as UiLang[]) {
          const attempts = Number(article.i18n_attempts?.[target] ?? 0);
          if (attempts >= MAX_ATTEMPTS) continue;
          const existing: I18nOverlay | undefined = article.i18n?.[target];
          const overlay = await buildOverlay(src, target, existing, this.translator).catch(() => null);
          const wanted = hasPending(pendingParts(src, target));
          if (!overlay) {
            if (wanted && !(await this.coveredBy(src, target, existing))) {
              out.failed += 1;
              // jsonb_set cannot create two missing levels at once, so the whole counter object is written.
              await this.db.query(
                `UPDATE news_items SET ai_metadata = jsonb_set(ai_metadata, '{article,i18n_attempts}',
                   COALESCE(ai_metadata->'article'->'i18n_attempts', '{}'::jsonb) || jsonb_build_object($2::text, $3::int), true) WHERE id = $1`,
                [r.id, target, attempts + 1],
              ).catch(() => undefined);
              this.logger.warn(`Article ${r.id}: translation to ${target} failed (attempt ${attempts + 1}/${MAX_ATTEMPTS})`);
            } else out.skipped += 1;
            continue;
          }
          await this.db.query(
            `UPDATE news_items SET ai_metadata = jsonb_set(ai_metadata, '{article,i18n}',
               COALESCE(ai_metadata->'article'->'i18n', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb), true) WHERE id = $1`,
            [r.id, target, JSON.stringify(overlay)],
          );
          out.translated += 1;
          done += 1;
        }
      }
    } finally {
      this.running = false;
    }
    if (out.translated || out.failed) this.logger.log(`Article i18n: ${JSON.stringify(out)}`);
    return out;
  }

  /** True when the stored overlay already contains every part that is still in the wrong language. */
  private async coveredBy(src: I18nSource, target: UiLang, overlay: I18nOverlay | undefined): Promise<boolean> {
    if (!overlay) return false;
    const p = pendingParts(src, target);
    if (p.background && !overlay.background) return false;
    if (p.whats_next && !overlay.whats_next) return false;
    if (p.facts && !(overlay.facts && overlay.facts.length === (src.facts ?? []).length)) return false;
    if (p.visuals) {
      const have = new Set((overlay.visuals ?? []).map((v) => v.id));
      if ((src.visuals ?? []).some((v) => !have.has(v.id) && visualSlots(v).some((s) => needsTranslation(s.get(), target)))) return false;
    }
    return true;
  }
}
