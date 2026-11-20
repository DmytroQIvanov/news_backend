/**
 * Per-language overlay for the parts of an article that the main translator does not cover:
 * `background`, `whats_next`, fact claims and the text inside the visuals (media.visuals).
 *
 * Stored in ai_metadata.article.i18n[lang] = { background?, whats_next?, facts?: string[], visuals?: NewsVisual[], at, model }.
 * The original fields are never overwritten; the API chooses what to show for `?lang=`.
 */
export type UiLang = 'uk' | 'en';

const LETTER = /\p{L}/gu;
const CYRILLIC = /[Ѐ-ӿ]/;

/** Language of a short text from its script, or null when it carries no language (numbers, a lone name, a unit). */
export function scriptLang(text: unknown): UiLang | null {
  if (typeof text !== 'string') return null;
  const letters = text.match(LETTER) ?? [];
  if (letters.length < 3) return null;
  const cyr = letters.filter((c) => CYRILLIC.test(c)).length;
  if (cyr / letters.length > 0.5) return 'uk';
  if (cyr === 0) {
    // Latin only: a single word is most likely a proper name, a ticker or a unit ("Nvidia", "GPU"), not English prose.
    const words = text.trim().split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w));
    return words.length >= 2 && letters.length >= 8 ? 'en' : null;
  }
  return null;
}

/** True when `text` is real prose in the other language, i.e. it must be translated for `target`. */
export function needsTranslation(text: unknown, target: UiLang): boolean {
  const lang = scriptLang(text);
  return lang !== null && lang !== target;
}

/** True when `text` can be shown as is on a `target` page (right language, or language-neutral like a name or number). */
export function fitsLanguage(text: unknown, target: UiLang): boolean {
  return !needsTranslation(text, target);
}

type Json = Record<string, any>;
export interface TextSlot { get: () => string; set: (value: string) => void }

const STRING_KEYS = ['title', 'caption', 'unit', 'prosLabel', 'consLabel'];
const STRING_ARRAYS = ['labels', 'columns', 'rowLabels', 'pros', 'cons'];
const OBJECT_ARRAYS: Record<string, string[]> = {
  items: ['label', 'note', 'unit'],
  events: ['title', 'detail'],
  steps: ['label', 'sub'],
  scenarios: ['name', 'detail'],
  nodes: ['label', 'role'],
  ranges: ['label', 'note'],
  series: ['name'],
};
const OBJECTS: Record<string, string[]> = { center: ['label', 'sub'], before: ['label', 'detail'], after: ['label', 'detail'] };

/** Every human-readable string of a visual with a setter. The data (numbers, ids, tones, source) is never touched. */
export function visualSlots(visual: Json): TextSlot[] {
  const slots: TextSlot[] = [];
  const add = (holder: any, key: string | number) => {
    if (typeof holder?.[key] === 'string') slots.push({ get: () => holder[key], set: (v) => { holder[key] = v; } });
  };
  for (const k of STRING_KEYS) add(visual, k);
  for (const k of STRING_ARRAYS) if (Array.isArray(visual[k])) visual[k].forEach((_: unknown, i: number) => add(visual[k], i));
  for (const [k, fields] of Object.entries(OBJECT_ARRAYS)) {
    if (Array.isArray(visual[k])) for (const row of visual[k]) if (row && typeof row === 'object') for (const f of fields) add(row, f);
  }
  for (const [k, fields] of Object.entries(OBJECTS)) {
    if (visual[k] && typeof visual[k] === 'object') for (const f of fields) add(visual[k], f);
  }
  if (Array.isArray(visual.rows)) {
    for (const row of visual.rows) if (Array.isArray(row)) row.forEach((cell: unknown, i: number) => { if (typeof cell === 'string' && /\p{L}{3,}/u.test(cell)) add(row, i); });
  }
  return slots;
}

/** The text of a visual that is in the wrong language for `target` (what the translator receives). */
export function visualNeedsTranslation(visual: Json, target: UiLang): boolean {
  return visualSlots(visual).some((s) => needsTranslation(s.get(), target));
}

/** Visuals whose main text is not in `target` (a visual is shown whole or not at all, never half-translated). */
export function visualMatchesLanguage(visual: Json, target: UiLang): boolean {
  // The title decides first; the rest may carry a few foreign names ("Project Genie" inside a Ukrainian chart).
  const titleLang = scriptLang(visual.title);
  if (titleLang !== null && titleLang !== target) return false;
  const langs = visualSlots(visual).map((s) => scriptLang(s.get())).filter((l): l is UiLang => l !== null);
  return langs.length === 0 || langs.filter((l) => l === target).length / langs.length >= 0.7;
}

export interface I18nSource {
  background?: string;
  whats_next?: string;
  facts?: Array<{ claim?: string }>;
  visuals?: Json[];
}

export interface I18nOverlay {
  background?: string;
  whats_next?: string;
  facts?: string[];
  visuals?: Json[];
  at?: string;
  model?: string;
}

/** What still has to be translated into `target` for this article (empty = nothing to do). */
export function pendingParts(src: I18nSource, target: UiLang): { background: boolean; whats_next: boolean; facts: boolean; visuals: boolean } {
  return {
    background: needsTranslation(src.background, target),
    whats_next: needsTranslation(src.whats_next, target),
    facts: (src.facts ?? []).some((f) => needsTranslation(f.claim, target)),
    visuals: (src.visuals ?? []).some((v) => !visualMatchesLanguage(v, target)),
  };
}

export const hasPending = (p: ReturnType<typeof pendingParts>) => p.background || p.whats_next || p.facts || p.visuals;

/**
 * Apply the stored overlay for `target`. Fields that are in the wrong language and have no translation yet are
 * dropped (never shown in the wrong language); `i18n_pending` tells the client why.
 */
export function localizeArticleRow<T extends Json>(row: T, target: UiLang): T {
  const article: Json | null = row.article && typeof row.article === 'object' ? { ...row.article } : null;
  const overlay: I18nOverlay | undefined = article?.i18n?.[target];
  let pending = false;
  if (article) {
    for (const key of ['background', 'whats_next'] as const) {
      if (!needsTranslation(article[key], target)) continue;
      if (overlay?.[key]) article[key] = overlay[key];
      else { delete article[key]; pending = true; }
    }
    if (Array.isArray(article.facts)) {
      const translated = overlay?.facts;
      article.facts = article.facts
        .map((f: Json, i: number) => {
          if (!needsTranslation(f.claim, target)) return f;
          if (translated?.[i]) return { ...f, claim: translated[i] };
          pending = true;
          return null;
        })
        .filter(Boolean);
    }
    delete article.i18n;
  }
  const media: Json | null = row.media && typeof row.media === 'object' ? { ...row.media } : null;
  if (media && Array.isArray(media.visuals)) {
    const translatedVisuals: Json[] | undefined = overlay?.visuals;
    media.visuals = media.visuals
      .map((v: Json) => {
        if (visualMatchesLanguage(v, target)) return v;
        const t = translatedVisuals?.find((x) => x.id === v.id);
        if (t) return t;
        pending = true;
        return null;
      })
      .filter(Boolean);
  }
  return { ...row, ...(article ? { article } : {}), ...(media ? { media } : {}), ...(pending ? { i18n_pending: true } : {}) };
}

/** First feed preview in the right language (or the translated one), else null. */
export function localizePreview(preview: Json | null | undefined, translated: Json | null | undefined, target: UiLang): Json | null {
  if (!preview) return null;
  if (visualMatchesLanguage(preview, target)) return preview;
  return translated && translated.id === preview.id ? translated : null;
}
