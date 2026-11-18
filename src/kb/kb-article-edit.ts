/**
 * Article edits that never regenerate the whole text:
 *   - applyPatches: exact find/replace edits proposed by a cheap model after a fact-check (each `find` must occur exactly once);
 *   - insertParagraphs: adds new, cited paragraphs to a too-short article before its closing section;
 *   - cleanCitations: removes citation markers that point to references the dossier does not have.
 */

export interface TextPatch {
  field: 'title' | 'summary' | 'body';
  find: string;
  replace: string;
}

export interface PatchableArticle {
  title: string;
  summary: string;
  body: string;
}

export const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    patches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { event_id: { type: 'integer' }, field: { type: 'string', enum: ['title', 'summary', 'body'] }, find: { type: 'string' }, replace: { type: 'string' } },
        required: ['event_id', 'field', 'find', 'replace'],
      },
    },
  },
  required: ['patches'],
};

export function validatePatches(raw: unknown): Array<TextPatch & { event_id: number }> | null {
  const list = (raw as { patches?: unknown })?.patches;
  if (!Array.isArray(list)) return null;
  const out: Array<TextPatch & { event_id: number }> = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    if (!['title', 'summary', 'body'].includes(String(o.field)) || typeof o.find !== 'string' || typeof o.replace !== 'string') continue;
    if (o.find.length < 6 || o.find.length > 1200 || o.replace.length > 2400) continue;
    out.push({ event_id: Number(o.event_id), field: o.field as TextPatch['field'], find: o.find, replace: o.replace });
  }
  return out;
}

/** Applies the patches that match exactly once; returns the new article and how many were applied / skipped. */
export function applyPatches<T extends PatchableArticle>(art: T, patches: TextPatch[]): { article: T; applied: number; skipped: number } {
  const next = { ...art };
  let applied = 0;
  let skipped = 0;
  for (const p of patches) {
    const text = next[p.field];
    const first = text.indexOf(p.find);
    if (first < 0 || text.indexOf(p.find, first + 1) >= 0) {
      skipped += 1;
      continue;
    }
    // a patch may not grow a field by more than 60% and may not delete a citation without replacing it
    if (p.replace.length > p.find.length * 1.6 + 120) {
      skipped += 1;
      continue;
    }
    if (p.field !== 'body' && /\[[A-Z]\d+\]/.test(p.replace) && !/\[[A-Z]\d+\]/.test(p.find)) {
      skipped += 1; // titles and summaries carry no citation markers
      continue;
    }
    const cites = (s: string) => (s.match(/\[[A-Z]\d+\]/g) ?? []).length;
    if (cites(p.replace) < cites(p.find) && !/\bremove\b/i.test(p.find)) {
      // dropping a claim is allowed only when the whole sentence goes (replace empty), never a silent citation loss
      if (p.replace.trim() !== '') {
        skipped += 1;
        continue;
      }
    }
    next[p.field] = text.slice(0, first) + p.replace + text.slice(first + p.find.length);
    applied += 1;
  }
  return { article: next, applied, skipped };
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export const EXPAND_SCHEMA = {
  type: 'object',
  properties: { paragraphs: { type: 'array', items: { type: 'string' } } },
  required: ['paragraphs'],
};

export function validateParagraphs(raw: unknown, allowedRefs: Set<string>): string[] | null {
  const list = (raw as { paragraphs?: unknown })?.paragraphs;
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const p of list) {
    if (typeof p !== 'string') continue;
    const text = p.trim();
    const words = countWords(text);
    if (words < 25 || words > 220) continue;
    const refs = text.match(/\[[A-Z]\d+\]/g) ?? [];
    if (!refs.length) continue; // every paragraph must cite the material
    if (refs.some((r) => !allowedRefs.has(r.slice(1, -1)))) continue; // never invent a reference
    out.push(text);
  }
  return out;
}

/** Adds paragraphs before the last "## " section when the article ends with a short closing section, else at the end. */
export function insertParagraphs(body: string, paragraphs: string[]): string {
  if (!paragraphs.length) return body;
  const extra = paragraphs.join('\n\n');
  const idx = body.lastIndexOf('\n## ');
  const tail = idx >= 0 ? body.slice(idx) : '';
  if (idx > 0 && countWords(tail) < 140) return `${body.slice(0, idx).trimEnd()}\n\n${extra}\n${tail}`;
  return `${body.trimEnd()}\n\n${extra}`;
}

/** Reference ids ([D1], [F3], ...) present in a rendered dossier. */
export function dossierRefs(rendered: string): Set<string> {
  const out = new Set<string>();
  for (const m of rendered.matchAll(/\[([A-Z]\d+)\]/g)) out.add(m[1]);
  return out;
}
