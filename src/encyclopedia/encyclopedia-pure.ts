import { createHash } from 'node:crypto';
import { FACT_STATUS_LABELS, label, Lang } from '../kb/kb-labels';

export interface Citation { ref: string; url: string; title: string; name: string; newsId?: string | null }
export interface Statement { id: string; text: string; text_uk: string; status: string; refs: string[] }
export interface TimelineItem { id: string; title: string; date: string | null; refs: string[]; newsId: string | null; category?: string | null; storyline?: string | null }
export interface Relation { entityId: string; name: string; name_uk?: string; relation: string; refs: string[]; text?: string; text_uk?: string }
export interface Section { heading: string; heading_uk: string; text: string; text_uk: string; refs: string[]; type: string }
export interface Category { slug: string; label: string; label_uk: string }
export interface Grounding { en: string[]; uk: string[] }
export const unique = (xs: string[]) => [...new Set(xs)].sort();
export const iso = (v: unknown): string | null => v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null;
const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/gu, ' ').trim();
export function slugPart(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 90);
}
const human = (s: string) => s.replace(/[_-]+/g, ' ').trim();
// Protocol/status labels, not a topic taxonomy.
const STATUS_LABELS = { ...FACT_STATUS_LABELS,
  registry: { en: 'registry description', uk: 'опис у реєстрі' },
  published: { en: 'published reporting', uk: 'опубліковане повідомлення' },
  fact: { en: 'reported assertion', uk: 'повідомлене твердження' },
  claim: { en: 'attributed claim', uk: 'твердження джерела' },
  plan: { en: 'planned', uk: 'план' },
  speculation: { en: 'speculation', uk: 'припущення' },
  denial: { en: 'denial', uk: 'заперечення' },
};

/** Values, including labels, come only from evidence/registry metadata, never from a topic dictionary. */
export function deriveCategories(kind: string, events: Array<{ category?: string | null }>, attributes: Record<string, any> = {}): Category[] {
  const out = new Map<string, Category>();
  const add = (origin: string, key: string, en?: string, uk?: string) => {
    if (!key?.trim()) return;
    const slug = `${origin}:${slugPart(key)}`;
    if (!out.has(slug)) out.set(slug, { slug, label: en || human(key), label_uk: uk || en || human(key) });
  };
  const counts = new Map<string, number>();
  for (const e of events) if (e.category) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  for (const [c] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const labels = attributes.category_labels?.[c];
    add('event', c, labels?.en, labels?.uk);
  }
  add('kind', kind, attributes.kind_labels?.en, attributes.kind_labels?.uk);
  for (const c of Array.isArray(attributes.wikidata_classes) ? attributes.wikidata_classes.slice(0, 12) : []) {
    if (typeof c === 'string') add('class', c);
    else if (c && typeof c.id === 'string') add('class', c.id, c.labels?.en || c.label, c.labels?.uk || c.label_uk);
  }
  return [...out.values()];
}

export function buildSections(facts: Statement[], claims: Statement[], timeline: TimelineItem[], relations: Relation[], sources: Citation[]): Section[] {
  const known = new Set(sources.map(s => s.ref));
  const sections: Section[] = [];
  const add = (type: string, heading: string, heading_uk: string, text: string, text_uk: string, refs: string[]) => {
    const valid = unique(refs.filter(r => known.has(r)));
    if (text && valid.length) sections.push({ type, heading, heading_uk, text, text_uk, refs: valid });
  };
  for (const [type, en, uk, list] of [
    ['facts', 'Key facts', 'Основні факти', facts], ['claims', 'Reported claims', 'Повідомлені твердження', claims],
  ] as const) {
    const usable = list.filter(f => f.refs.some(r => known.has(r)));
    add(type, en, uk,
      usable.map(f => `${f.text} [${label(STATUS_LABELS, f.status, 'en')}] ${f.refs.filter(r => known.has(r)).map(r => `[${r}]`).join(' ')}`).join('\n'),
      usable.map(f => `${f.text_uk} [${label(STATUS_LABELS, f.status, 'uk')}] ${f.refs.filter(r => known.has(r)).map(r => `[${r}]`).join(' ')}`).join('\n'), usable.flatMap(f => f.refs));
  }
  const ordered = [...timeline].filter(e => e.refs.some(r => known.has(r))).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id.localeCompare(b.id));
  add('timeline', 'Timeline', 'Хронологія', ordered.map(e => `${e.date?.slice(0, 10) ?? '—'}: ${e.title}`).join('\n'),
    ordered.map(e => `${e.date?.slice(0, 10) ?? '—'}: ${e.title}`).join('\n'), ordered.flatMap(e => e.refs));
  const rels = relations.filter(r => r.refs.some(ref => known.has(ref)));
  add('relations', 'Relations', 'Зв’язки', rels.map(r => r.text || `${human(r.relation)}: ${r.name}`).join('\n'),
    rels.map(r => r.text_uk || `${human(r.relation)}: ${r.name_uk || r.name}`).join('\n'), rels.flatMap(r => r.refs));
  return sections;
}

/** Extractive intros deliberately avoid an unverifiable semantic/NER gate.
 * Each whole statement (including status/negation) must be copied intact from the collected facts.
 * This rejects new names, numbers AND recombinations of supported words into new claims.
 */
export function groundedText(text: unknown, allowed: string[]): text is string {
  if (typeof text !== 'string' || !text.trim() || text.length > 900) return false;
  let rest = normalize(text);
  const choices = allowed.map(normalize).filter(Boolean).sort((a, b) => b.length - a.length);
  for (let n = 0; n < 3 && rest; n++) {
    const match = choices.find(s => rest === s || rest.startsWith(`${s} `));
    if (!match) return false;
    rest = rest.slice(match.length).trim();
  }
  return rest.length === 0;
}
export function validateGeneratedIntro(raw: unknown, facts: Grounding): { summary: string; summary_uk: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return groundedText(r.summary, facts.en) && groundedText(r.summary_uk, facts.uk)
    ? { summary: normalize(r.summary), summary_uk: normalize(r.summary_uk) } : null;
}
export function introGrounding(facts: Statement[]): Grounding {
  const sentences = (lang: Lang) => facts.filter(f => f.refs.length).slice(0, 8).map(f =>
    `${lang === 'uk' ? f.text_uk : f.text} [${label(STATUS_LABELS, f.status, lang)}].`).filter(s => s.length <= 700);
  return { en: sentences('en'), uk: sentences('uk') };
}
function canonical(v: any): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
export function evidenceHash(evidence: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(evidence))).digest('hex'); }
export function evidenceChanged(previous: string | null | undefined, evidence: unknown): boolean { return previous !== evidenceHash(evidence); }
export function boundedNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'string' && !raw.trim() ? NaN : Number(raw ?? NaN);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
export function decodeCursor(raw?: string): { importance: number; id: string } | null {
  if (typeof raw !== 'string' || !raw || raw.length > 256) return null;
  try {
    const r = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return Number.isFinite(r.importance) && Math.abs(r.importance)<=3.4e38 && typeof r.id==='string'
      && /^\d{1,19}$/.test(r.id) && BigInt(r.id)<=9223372036854775807n ? { importance: r.importance, id: r.id } : null;
  } catch { return null; }
}
