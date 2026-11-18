/**
 * Minification of source material before it goes to an expensive model (task: more sources per call, same authority).
 *
 * Principles (no model involved, deterministic and testable):
 *  1. Extractive, never abstractive: only original sentences survive, so every quote, number and name stays verbatim.
 *  2. Query-focused salience: sentences are scored by overlap with the event (title, participants, known facts), numbers,
 *     named entities, attribution verbs and position; the lead sentence is always kept.
 *  3. Cross-source deduplication: a sentence that another (more reliable / earlier) source already carries is dropped from the
 *     later source and recorded as "also in D1,D3" — corroboration is preserved, repetition is not paid for.
 *  4. Budgeting by value: reliability, primary-source status and novelty decide how many characters each document gets (MMR-like:
 *     redundant documents shrink first); primary documents and official statements are never cut below a floor.
 *  5. Boilerplate removal: subscribe/cookie/share lines, bylines, "read also" and link lists are dropped.
 */
import { jaccard, shingles } from './kb-syndication';

const WORD = /[\p{L}\p{N}]+/gu;

export function splitSentences(text: string): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const out: string[] = [];
  for (const para of clean.split(/\n{1,}/)) {
    const p = para.trim();
    if (!p) continue;
    // split on sentence punctuation followed by space + capital/digit/quote (Latin and Cyrillic)
    const parts = p.split(/(?<=[.!?…»”"])\s+(?=[\p{Lu}\p{N}«“"(])/u);
    for (const s of parts) {
      const t = s.trim();
      if (t.length >= 25) out.push(t);
    }
  }
  return out;
}

const BOILERPLATE = /(subscribe|sign up for|newsletter|cookie|all rights reserved|follow us|share this|read (also|more)|related (articles|stories)|advertisement|click here|підпишіться|читайте також|поділитися|слідкуйте|всі права захищені|реклама|дивіться також|підписуйтесь|photo:|фото:|©|getty images|image caption|\bcopyright\b)/i;

export function isBoilerplate(sentence: string): boolean {
  if (BOILERPLATE.test(sentence)) return true;
  const letters = (sentence.match(/\p{L}/gu) ?? []).length;
  return letters < sentence.length * 0.45; // link lists, tables of numbers, separators
}

const ATTRIBUTION = /(said|says|told|according to|announced|confirmed|denied|stated|reported|warned|заявив|заявила|повідомив|повідомила|за словами|підтвердив|спростував|зазначив|сказав|сообщил|заявил)/i;

export interface SalienceContext {
  /** Lower-cased tokens that matter for this event: title words, participants, key fact terms. */
  focus: Set<string>;
}

export function focusTokens(...texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const w of t.toLowerCase().normalize('NFKC').match(WORD) ?? []) if (w.length >= 4) out.add(w);
  return out;
}

export function sentenceScore(sentence: string, index: number, total: number, ctx: SalienceContext): number {
  const words = sentence.toLowerCase().normalize('NFKC').match(WORD) ?? [];
  if (!words.length) return 0;
  let overlap = 0;
  for (const w of words) if (ctx.focus.has(w)) overlap += 1;
  const focus = Math.min(1, overlap / Math.max(3, Math.sqrt(words.length)));
  const numbers = Math.min(1, ((sentence.match(/\d[\d.,]*/g) ?? []).length) / 3);
  const entities = Math.min(1, ((sentence.match(/(?<![.!?]\s)\b\p{Lu}[\p{L}'’-]{2,}/gu) ?? []).length - 1) / 4);
  const quote = /["«“]/.test(sentence) || ATTRIBUTION.test(sentence) ? 0.35 : 0;
  const position = index === 0 ? 1 : Math.max(0, 0.5 - index / Math.max(1, total * 2));
  const length = sentence.length < 60 ? -0.25 : sentence.length > 420 ? -0.15 : 0;
  return focus * 1.6 + numbers * 0.6 + entities * 0.5 + quote + position * 0.9 + length;
}

const NEGATION = /\b(not|no|never|none|neither|nor|without|denied|denies|deny|refused|cannot|can't|won't|didn't|isn't|wasn't|не|ні|немає|заперечив|спростував|без)\b/giu;

/** Numbers, negations and quoted text of a sentence: two sentences are the same claim only when these match. */
export function claimSignature(sentence: string): string {
  const numbers = (sentence.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]$/, '')).sort().join('|');
  const neg = (sentence.match(NEGATION) ?? []).length;
  const quotes = (sentence.match(/["«“][^"»”]{3,}["»”]/g) ?? []).join('').toLowerCase();
  return `${numbers}#${neg}#${quotes}`;
}

export interface DocForMinify {
  ref: string;
  text: string;
  /** 0..1 reliability prior (primary sources high). */
  weight: number;
  primary?: boolean;
  /** Earlier first: when two sources carry the same sentence the earlier / more reliable one keeps it. */
  order: number;
}

export interface MinifiedDoc {
  ref: string;
  text: string;
  originalChars: number;
  keptChars: number;
  alsoIn: Record<string, string[]>;
}

/**
 * Greedy extractive selection of one document under a character budget, in original order, skipping sentences that
 * `seen` (shingles of already-kept sentences of other documents) already contains.
 */
export function minifyDocument(
  doc: DocForMinify, budgetChars: number, ctx: SalienceContext, seen: Array<{ ref: string; sh: Set<string>; sig: string }>,
): MinifiedDoc {
  const sentences = splitSentences(doc.text).filter((s) => !isBoilerplate(s));
  const alsoIn: Record<string, string[]> = {};
  const candidates: Array<{ i: number; s: string; score: number; dup: string | null }> = sentences.map((s, i) => {
    const sh = shingles(s, 4);
    let dup: string | null = null;
    if (sh.size >= 3) {
      const sig = claimSignature(s);
      for (const other of seen) {
        // the same words AND the same numbers, polarity and quoted text: a different figure is a different claim
        if (jaccard(sh, other.sh) >= 0.6 && sig === other.sig) {
          dup = other.ref;
          break;
        }
      }
    }
    return { i, s, score: sentenceScore(s, i, sentences.length, ctx), dup };
  });
  const keep = new Set<number>();
  let used = 0;
  // lead sentence first, then by score
  const order = [...candidates].sort((a, b) => (a.i === 0 ? -1 : b.i === 0 ? 1 : b.score - a.score));
  for (const c of order) {
    if (c.dup) {
      (alsoIn[c.dup] ??= []).push(c.s.slice(0, 60));
      continue;
    }
    if (used + c.s.length + 1 > budgetChars) {
      if (keep.size === 0 && budgetChars > 60) {
        const cut = c.s.slice(0, budgetChars - 1);
        c.s = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`;
        keep.add(c.i);
        used += c.s.length + 1;
      }
      continue;
    }
    if (c.score < 0.35 && keep.size >= 2) continue;
    keep.add(c.i);
    used += c.s.length + 1;
  }
  const kept = candidates.filter((c) => keep.has(c.i)).map((c) => c.s);
  for (const s of kept) seen.push({ ref: doc.ref, sh: shingles(s, 4), sig: claimSignature(s) });
  const text = kept.join(' ');
  return { ref: doc.ref, text, originalChars: doc.text.length, keptChars: text.length, alsoIn };
}

export interface MinifyResult {
  docs: MinifiedDoc[];
  budgetChars: number;
  originalChars: number;
  keptChars: number;
  /** Documents that did not fit at all: only a one-line digest is possible for them. */
  overflow: string[];
}

/**
 * Allocate `totalChars` across documents by value and minify each. Primary/official documents get a floor; documents are
 * processed best-first so duplicates are charged to the weaker source.
 */
export function minifyDossierDocs(docs: DocForMinify[], totalChars: number, ctx: SalienceContext, opts: { floor?: number; minPerDoc?: number } = {}): MinifyResult {
  const floor = opts.floor ?? 1200;
  const minPerDoc = opts.minPerDoc ?? 450;
  const ranked = [...docs].sort((a, b) => Number(!!b.primary) - Number(!!a.primary) || b.weight - a.weight || a.order - b.order);
  const weights = ranked.map((d) => 0.4 + d.weight + (d.primary ? 0.6 : 0));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const seen: Array<{ ref: string; sh: Set<string>; sig: string }> = [];
  const out: MinifiedDoc[] = [];
  const overflow: string[] = [];
  let remaining = totalChars;
  ranked.forEach((d, idx) => {
    const share = Math.floor((totalChars * weights[idx]) / sum);
    // primary documents get their floor only while the global budget still has room; the total never exceeds totalChars
    const want = Math.max(d.primary ? floor : minPerDoc, share);
    const budget = Math.min(want, remaining);
    if (budget < Math.min(minPerDoc, 200)) {
      overflow.push(d.ref);
      return;
    }
    const m = minifyDocument(d, budget, ctx, seen);
    remaining -= m.keptChars;
    out.push(m);
  });
  const byRef = new Map(out.map((m) => [m.ref, m]));
  const ordered = docs.map((d) => byRef.get(d.ref)).filter((m): m is MinifiedDoc => !!m);
  return {
    docs: ordered, budgetChars: totalChars, overflow,
    originalChars: docs.reduce((a, d) => a + d.text.length, 0), keptChars: ordered.reduce((a, m) => a + m.keptChars, 0),
  };
}
