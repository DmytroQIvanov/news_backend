/**
 * Script-level independence and safety checks for pages found by the corroboration search (no AI quota):
 *   - syndication/copy detection: word-shingle Jaccard + 64-bit simhash against every source we already have;
 *   - wire attribution: "according to Reuters", "(AP)", "за даними Укрінформ" -> the page derives from that agency;
 *   - prompt-injection detection: fetched pages are untrusted data, a page that talks to the AI is rejected.
 */

const WORD = /[\p{L}\p{N}]+/gu;

export function normalizeWords(text: string): string[] {
  return (text.toLowerCase().normalize('NFKC').match(WORD) ?? []).filter((w) => w.length > 1);
}

export function shingles(text: string, k = 5): Set<string> {
  const words = normalizeWords(text);
  const out = new Set<string>();
  for (let i = 0; i + k <= words.length; i += 1) out.add(words.slice(i, i + k).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Share of the smaller text's shingles found in the other: catches a short rewrite of a long original. */
export function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter += 1;
  return inter / small.size;
}

function fnv64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i += 1) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

export function simhash(text: string): bigint {
  const counts = new Array<number>(64).fill(0);
  for (const sh of shingles(text, 3)) {
    const h = fnv64(sh);
    for (let b = 0; b < 64; b += 1) counts[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b += 1) if (counts[b] > 0) out |= 1n << BigInt(b);
  return out;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export interface KnownText {
  ref: string;
  text: string;
}

export interface SyndicationVerdict {
  copy: boolean;
  of?: string;
  jaccard: number;
  containment: number;
  hamming: number;
}

/** A page is a copy/rewrite when it shares most of its wording with a source we already have. */
export function checkSyndication(candidate: string, known: KnownText[], opts: { maxContainment?: number; maxJaccard?: number; maxHamming?: number } = {}): SyndicationVerdict {
  const maxContainment = opts.maxContainment ?? 0.6;
  const maxJaccard = opts.maxJaccard ?? 0.45;
  const maxHamming = opts.maxHamming ?? 6;
  const cs = shingles(candidate);
  const ch = simhash(candidate);
  let best: SyndicationVerdict = { copy: false, jaccard: 0, containment: 0, hamming: 64 };
  for (const k of known) {
    const ks = shingles(k.text);
    const j = jaccard(cs, ks);
    const c = containment(cs, ks);
    const h = hamming(ch, simhash(k.text));
    const copy = c >= maxContainment || j >= maxJaccard || (h <= maxHamming && Math.min(cs.size, ks.size) > 20);
    if (copy || c > best.containment) best = { copy, of: copy ? k.ref : best.of, jaccard: j, containment: c, hamming: h };
    if (copy) return best;
  }
  return best;
}

//  is ASCII-only in JavaScript, so Cyrillic names use explicit letter look-arounds.
const agency = (alternatives: string) => new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${alternatives})(?![\p{L}\p{N}])`, 'iu');
const AGENCIES: Array<[RegExp, string]> = [
  [agency('reuters|рейтер[с]?'), 'reuters'],
  [agency('associated press|ap news|ap|ассошиэйтед пресс|ассошіейтед прес'), 'ap'],
  [agency('agence france-presse|afp|франс прес'), 'afp'],
  [agency('укрінформ|ukrinform'), 'ukrinform'],
  [agency('інтерфакс|interfax'), 'interfax'],
  [agency('bloomberg|блумберг'), 'bloomberg'],
  [agency('dpa|ansa|efe|pap|tass|тасс|xinhua|сіньхуа'), 'agency'],
];

const ATTRIBUTION = /(according to|reported by|told|citing|cited by|via|за даними|повідомляє|з посиланням на|інформує|сообщает|по данным)\s+(?:the\s+)?([^.,;\n]{0,40})/gi;

/** Wire agencies named as the origin of the text ("за даними Reuters", "(AP)"). Not proof of copying, but of derivation. */
export function wireAttributions(text: string): string[] {
  const found = new Set<string>();
  const head = text.slice(0, 2500);
  for (const m of head.matchAll(ATTRIBUTION)) {
    for (const [re, name] of AGENCIES) if (re.test(m[2])) found.add(name);
  }
  for (const [re, name] of AGENCIES) {
    if (new RegExp(`(^|\\s)[(\\[—–-]\\s*${re.source}\\s*[)\\]]`, 'i').test(head) || new RegExp(`${re.source}\\s*[—–-]\\s`, 'i').test(head.slice(0, 160))) found.add(name);
  }
  return [...found];
}

const INJECTION: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (all |any |the )?(previous|prior|above)/i,
  /\b(system|developer) (prompt|message|instruction)s?\b/i,
  /you are (now )?(a|an|the) (ai|assistant|language model|llm|chatbot)/i,
  /as an? (ai|language model)/i,
  /(respond|reply|answer|output) (only )?(with|in) (json|yes|true)/i,
  /\bsame_event\b|\bmatch_confidence\b|\badds_information\b/i,
  /забудь (усі )?(попередні )?інструкції|ігноруй (усі )?(попередні )?інструкції/i,
  /(?:ignore|игнорируй) (?:все )?(?:предыдущие )?инструкции/i,
];

export function detectInjection(text: string): string | null {
  for (const re of INJECTION) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 80);
  }
  return null;
}

// control characters, zero-width and bidi/line-separator characters (built from escapes on purpose)
const CONTROL_CHARS = new RegExp('[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\u2028-\u202e\u2060\ufeff]', 'g');

/** Page text for a prompt: injection-looking lines removed, control characters stripped, fenced as data. */
export function fencePageText(text: string, max = 4500): string {
  const clean = text
    .split(/\r?\n/)
    .filter((line) => !detectInjection(line))
    .join('\n')
    .replace(CONTROL_CHARS, '')
    .slice(0, max);
  return `<page_text>\n${clean}\n</page_text>`;
}
