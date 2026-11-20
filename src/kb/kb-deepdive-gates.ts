/**
 * Deterministic quality gates and text helpers for automatically written deep dives. No model is involved here: these checks are
 * cheap, repeatable and strict. The model-based verification (a different model family) lives in kb-deepdive.service.ts.
 */
export interface Section { heading: string; paragraphs: string[] }

export const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export function parseSections(body: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const block of body.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)) {
    const h = /^##\s+(.+)$/.exec(block);
    if (h) { cur = { heading: h[1]!.trim(), paragraphs: [] }; out.push(cur); continue; }
    if (!cur) { cur = { heading: '', paragraphs: [] }; out.push(cur); }
    cur.paragraphs.push(block);
  }
  return out;
}

export const renderSections = (sections: Section[]): string =>
  sections.map((s) => `${s.heading ? `## ${s.heading}\n\n` : ''}${s.paragraphs.join('\n\n')}`).join('\n\n');

/** Source numbers cited as [S3] or [S3, S4] in a piece of text. */
export function citedSourceNumbers(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\[(S\d+(?:\s*,\s*S?\d+)*)\]/g)) {
    for (const part of m[1]!.split(/\s*,\s*/)) out.add(Number(part.replace(/^S/, '')));
  }
  return [...out].filter((n) => Number.isInteger(n) && n > 0);
}

/** Internal reference ids that readers must never see ([E7], [F3], [D2]). */
export const stripInternalRefs = (text: string): string => text.replace(/\s*\[(?:[EFD]\d+(?:\s*,\s*[EFD]?\d+)*)\]/g, '');

/**
 * [S#] -> [n]: sources are renumbered in order of first appearance and only cited sources are kept, so the numbers in the text
 * match the numbered source list on the page.
 */
export function remapCitations<T>(body: string, sources: T[]): { body: string; sources: T[]; map: Map<number, number> } {
  const map = new Map<number, number>();
  const kept: T[] = [];
  const text = body.replace(/\[(S\d+(?:\s*,\s*S?\d+)*)\]/g, (_all, inner: string) => {
    const nums = inner.split(/\s*,\s*/).map((p) => Number(p.replace(/^S/, ''))).filter((n) => n >= 1 && n <= sources.length);
    const mapped = nums.map((n) => {
      if (!map.has(n)) { map.set(n, kept.length + 1); kept.push(sources[n - 1]!); }
      return map.get(n)!;
    });
    return mapped.length ? `[${[...new Set(mapped)].join(', ')}]` : '';
  });
  return { body: text, sources: kept, map };
}

const HYPE = [
  /\bshatter(?:s|ed|ing)?\b/i, /\bunprecedented\b/i, /\bgame[- ]?chang(?:er|ing)\b/i, /\brevolution(?:ary|ise|ize)?\b/i, /\bcatastroph(?:e|ic)\b/i,
  /\bstaggering\b/i, /\bjaw[- ]dropping\b/i, /\bmonopol(?:y|ist|istic)\b/i, /\bchokepoint\b/i, /\bfrantic\b/i, /\bhyper-?competitive\b/i,
  /\bprofound(?:ly)?\b/i, /\bformidable\b/i, /\bunrivall?ed\b/i, /\bcrippl(?:e|es|ed|ing)\b/i, /\bpanic\b/i, /\bturmoil\b/i, /\bseismic\b/i,
];
export const hypeTerms = (text: string): string[] => HYPE.filter((re) => re.test(text)).map((re) => re.source);

const NUM = /\d{1,3}(?:[ ,.]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;
export const normNumber = (n: string): string => n.replace(/[ ,]/g, '');

/** Numbers of the article that do not appear in the research material (years and tiny counts excepted). */
export function unknownNumbers(body: string, material: string): string[] {
  const known = new Set([...material.matchAll(NUM)].map((m) => normNumber(m[0])));
  return [...new Set([...body.replace(/\[[A-Z]?\d+(?:\s*,\s*[A-Z]?\d+)*\]/g, ' ').matchAll(NUM)].map((m) => normNumber(m[0])))]
    .filter((n) => n && !known.has(n) && !(Number(n) >= 1900 && Number(n) <= 2100) && !(Number(n) <= 12));
}

export interface GateInput { title: string; standfirst: string; body: string; sourcesAvailable: number; material: string }
export interface GateResult { ok: boolean; problems: string[]; stats: { words: number; sections: number; paragraphs: number; cited: number; hype: string[]; unknownNumbers: string[] } }

export function deterministicGates(input: GateInput, opts: { minWords?: number; minSections?: number; minCited?: number } = {}): GateResult {
  const minWords = opts.minWords ?? 1300;
  const minSections = opts.minSections ?? 4;
  const minCited = Math.min(opts.minCited ?? 6, input.sourcesAvailable);
  const sections = parseSections(input.body).filter((s) => s.heading);
  const paragraphs = sections.flatMap((s) => s.paragraphs);
  const words = countWords(input.body);
  const cited = citedSourceNumbers(input.body);
  const bad = cited.filter((n) => n > input.sourcesAvailable);
  const hype = hypeTerms(`${input.body}`);
  const unk = unknownNumbers(input.body, input.material);
  const problems: string[] = [];
  if (words < minWords) problems.push(`too short (${words} words, need ${minWords})`);
  if (sections.length < minSections) problems.push(`only ${sections.length} sections (need ${minSections})`);
  if (cited.length < minCited) problems.push(`cites ${cited.length} distinct sources (need ${minCited})`);
  if (bad.length) problems.push(`citations to missing sources: ${bad.join(', ')}`);
  paragraphs.forEach((p, i) => {
    if (countWords(p) >= 25 && citedSourceNumbers(p).length === 0) problems.push(`paragraph ${i + 1} has no citation`);
  });
  if (unk.length) problems.push(`numbers not in the material: ${unk.slice(0, 6).join(', ')}`);
  if (hype.length > 2) problems.push(`sensational wording (${hype.length} terms)`);
  if (hypeTerms(input.title).length || hypeTerms(input.standfirst).length) problems.push('sensational title or standfirst');
  if (input.title.length > 110 || input.title.length < 15) problems.push('title length');
  if (/\[(?:[EFD]\d+)/.test(input.body)) problems.push('internal reference ids in the text');
  return { ok: problems.length === 0, problems, stats: { words, sections: sections.length, paragraphs: paragraphs.length, cited: cited.length, hype, unknownNumbers: unk } };
}

export interface ParagraphVerdict { index: number; verdict: 'supported' | 'partial' | 'unsupported'; issues: Array<{ claim: string; why: string }> }

/** Passes only when no paragraph has unsupported claims and at most 25% are merely partial. */
export function verificationPasses(verdicts: ParagraphVerdict[], total: number): { ok: boolean; unsupported: number; partial: number; coverage: number } {
  const unsupported = verdicts.filter((v) => v.verdict === 'unsupported').length;
  const partial = verdicts.filter((v) => v.verdict === 'partial').length;
  const coverage = total ? verdicts.length / total : 0;
  return { ok: unsupported === 0 && partial <= Math.floor(total * 0.25) && coverage >= 0.95, unsupported, partial, coverage };
}
