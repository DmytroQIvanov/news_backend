/**
 * Pure, dependency-free analysis used by InsightsService.
 * No AI here: dictionaries, regexes, statistics and graph algorithms only.
 */

// ---------------------------------------------------------------------------
// Entity matching
// ---------------------------------------------------------------------------

export interface MatchableEntity {
  id: string;
  aliases: string[];
}

const CYRILLIC = /[Ѐ-ӿ]/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeAlias(alias: string): string {
  return alias.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Builds one matcher for all aliases. Latin aliases must match whole words ("o3" does not match "co3").
 * Cyrillic aliases match as word prefixes, so Ukrainian case endings still match ("агент" → "агентів").
 * An alias ending with "*" is always a prefix.
 */
export function buildEntityMatcher(entities: MatchableEntity[]): (text: string) => Set<string> {
  const byAlias = new Map<string, Set<string>>();
  const exact: string[] = [];
  const prefix: string[] = [];
  for (const entity of entities) {
    for (const raw of entity.aliases) {
      let alias = normalizeAlias(raw);
      const isPrefix = alias.endsWith('*') || CYRILLIC.test(alias);
      alias = alias.replace(/\*+$/, '');
      if (alias.length < 2) continue;
      const set = byAlias.get(alias) ?? new Set<string>();
      set.add(entity.id);
      byAlias.set(alias, set);
      (isPrefix ? prefix : exact).push(alias);
    }
  }
  const byLength = (a: string, b: string) => b.length - a.length;
  const parts: string[] = [];
  const uniqExact = [...new Set(exact)].sort(byLength).map(escapeRegex);
  const uniqPrefix = [...new Set(prefix)].sort(byLength).map(escapeRegex);
  if (uniqExact.length) parts.push(`(?<![\\p{L}\\p{N}])(?:${uniqExact.join('|')})(?![\\p{L}\\p{N}])`);
  if (uniqPrefix.length) parts.push(`(?<![\\p{L}\\p{N}])(?:${uniqPrefix.join('|')})`);
  if (!parts.length) return () => new Set();
  const re = new RegExp(parts.join('|'), 'giu');
  return (text: string) => {
    const found = new Set<string>();
    if (!text) return found;
    const lower = text.toLowerCase();
    for (const m of lower.matchAll(re)) {
      const hit = m[0];
      const ids = byAlias.get(hit) ?? findPrefixOwner(byAlias, hit);
      if (ids) for (const id of ids) found.add(id);
    }
    return found;
  };
}

function findPrefixOwner(byAlias: Map<string, Set<string>>, hit: string): Set<string> | undefined {
  // A prefix alias matched exactly itself, so the lookup above normally succeeds; this is a safety net.
  for (let len = hit.length; len >= 2; len -= 1) {
    const ids = byAlias.get(hit.slice(0, len));
    if (ids) return ids;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Event types by patterns (English + Ukrainian)
// ---------------------------------------------------------------------------

export type EventType =
  | 'acquisition'
  | 'funding'
  | 'partnership'
  | 'launch'
  | 'open_source'
  | 'pricing'
  | 'legal'
  | 'regulation'
  | 'layoffs'
  | 'hiring'
  | 'leadership'
  | 'security'
  | 'outage'
  | 'research'
  | 'benchmark'
  | 'hardware'
  | 'ipo';

export const EVENT_LABELS: Record<EventType, { uk: string; en: string }> = {
  acquisition: { uk: 'поглинання', en: 'acquisition' },
  funding: { uk: 'інвестиції', en: 'funding' },
  partnership: { uk: 'партнерство', en: 'partnership' },
  launch: { uk: 'запуск продукту', en: 'product launch' },
  open_source: { uk: 'відкритий код', en: 'open-source release' },
  pricing: { uk: 'зміна цін', en: 'pricing change' },
  legal: { uk: 'суд', en: 'lawsuit' },
  regulation: { uk: 'регулювання', en: 'regulation' },
  layoffs: { uk: 'скорочення', en: 'layoffs' },
  hiring: { uk: 'найм', en: 'hiring' },
  leadership: { uk: 'зміна керівництва', en: 'leadership change' },
  security: { uk: 'безпека', en: 'security incident' },
  outage: { uk: 'збій', en: 'outage' },
  research: { uk: 'дослідження', en: 'research' },
  benchmark: { uk: 'бенчмарк', en: 'benchmark' },
  hardware: { uk: 'залізо', en: 'hardware' },
  ipo: { uk: 'IPO', en: 'IPO' },
};

const EVENT_PATTERNS: Array<[EventType, RegExp]> = [
  ['acquisition', /\b(acquires?|acquired|acquisition|to acquire|buys|bought|takeover|merger|merges with)\b|придба\p{L}*|купу\p{L}*|поглина\p{L}*|поглинан\p{L}*|злиття/iu],
  ['funding', /\b(raises?|raised|funding round|series [a-f]\b|seed round|valuation|valued at|invests?|investment|backed by)\b|залуч\p{L}*|інвест\p{L}*|раунд\p{L}*|оцін\p{L}* у \$?\d/iu],
  ['partnership', /\b(partners? with|partnership|teams up|collaborat\w+|alliance|joint venture|deal with|signs? (?:a )?deal)\b|партнер\p{L}*|співпрац\p{L}*|угод\p{L}*/iu],
  ['launch', /\b(launch(?:es|ed)?|releas(?:es|ed)|unveil(?:s|ed)?|introduc(?:es|ed)|rolls? out|now available|debuts?|announc(?:es|ed))\b|запуска\p{L}*|запусти\p{L}*|представи\p{L}*|випусти\p{L}*|презентува\p{L}*|анонсува\p{L}*/iu],
  ['open_source', /\b(open[- ]source[ds]?|open[- ]weights?|apache 2\.0|mit licen[sc]e|on hugging ?face|github release)\b|відкрит\p{L}* (?:код|ваг)\p{L}*/iu],
  ['pricing', /\b(price cut|cuts? prices?|pricing|cheaper|per million tokens|free tier|price increase|subscription)\b|знизи\p{L}* ц[іе]н\p{L}*|ціноутвор\p{L}*|підписк\p{L}*|тариф\p{L}*/iu],
  ['legal', /\b(lawsuit|sues?|sued|court|copyright|settlement|antitrust|class action)\b|позов\p{L}*|суд\p{L}*|авторськ\p{L}* прав\p{L}*|антимонопол\p{L}*/iu],
  ['regulation', /\b(regulat\w+|ai act|ban(?:s|ned)?|executive order|compliance|senate|congress|ftc|eu commission)\b|регулюван\p{L}*|закон\p{L}*|заборон\p{L}*|єврокоміс\p{L}*/iu],
  ['layoffs', /\b(layoffs?|lays? off|job cuts?|cuts? jobs|restructuring)\b|скороч\p{L}*|звільн\p{L}*/iu],
  ['hiring', /\b(hires?|hired|hiring|poach\w*|joins? (?:openai|anthropic|google|meta|xai|microsoft|apple|nvidia))\b|найм\p{L}*|переманю\p{L}*|переходить до/iu],
  ['leadership', /\b(ceo|cto|chief \w+ officer|steps? down|resigns?|appointed|names? new)\b|гендиректор\p{L}*|очоли\p{L}*|пішов у відставку|призначи\p{L}*/iu],
  ['security', /\b(vulnerabilit\w+|breach|leak(?:ed|s)?|exploit|jailbreak|malware|cve-\d+|prompt injection)\b|вразлив\p{L}*|витік\p{L}*|злам\p{L}*/iu],
  ['outage', /\b(outage|downtime|is down|service disruption|degraded performance)\b|збій\p{L}*|недоступн\p{L}*/iu],
  ['research', /\b(paper|arxiv|study|researchers?|preprint)\b|дослідж\p{L}*|науков\p{L}* стат\p{L}*/iu],
  ['benchmark', /\b(benchmark|swe-bench|leaderboard|mmlu|gpqa|arena|state[- ]of[- ]the[- ]art|sota)\b|бенчмарк\p{L}*|рейтинг\p{L}*/iu],
  ['hardware', /\b(gpu|chips?|tpu|datacenter|data center|accelerator|semiconductor|h100|h200|b200|blackwell)\b|чип\p{L}*|дата-?центр\p{L}*|напівпровідник\p{L}*/iu],
  ['ipo', /\b(ipo|goes public|public listing|files to go public)\b|виходить на біржу/iu],
];

export interface EventTag {
  eventType: EventType;
  matched: string;
  amountUsd: number | null;
}

/** Finds event types. The amount is attached to money-related events only. */
export function detectEvents(text: string): EventTag[] {
  if (!text) return [];
  const amount = parseAmountUsd(text);
  const tags: EventTag[] = [];
  for (const [eventType, re] of EVENT_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const moneyEvent = eventType === 'funding' || eventType === 'acquisition' || eventType === 'ipo';
    tags.push({ eventType, matched: m[0].slice(0, 80), amountUsd: moneyEvent ? amount : null });
  }
  return tags;
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, thousand: 1e3, тис: 1e3,
  m: 1e6, mn: 1e6, million: 1e6, millions: 1e6, млн: 1e6, мільйон: 1e6, мільйони: 1e6, мільйонів: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9, млрд: 1e9, мільярд: 1e9, мільярди: 1e9, мільярдів: 1e9,
  t: 1e12, trillion: 1e12, трлн: 1e12,
};

/** Largest US-dollar amount mentioned: "$6.6B", "$500 million", "2 млрд доларів". */
export function parseAmountUsd(text: string): number | null {
  const amounts: number[] = [];
  const unit = '(k|thousand|m|mn|million|millions|b|bn|billion|billions|t|trillion|тис|млн|млрд|трлн|мільйон\\p{L}*|мільярд\\p{L}*)';
  const dollarFirst = new RegExp(`\\$\\s?(\\d+(?:[.,]\\d+)?)\\s?${unit}?(?![\\p{L}])`, 'giu');
  const dollarAfter = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s?${unit}\\.?\\s?(?:usd|dollars|доларів|дол\\.?|\\$)`, 'giu');
  for (const re of [dollarFirst, dollarAfter]) {
    for (const m of text.matchAll(re)) {
      const num = Number(m[1].replace(',', '.'));
      if (!Number.isFinite(num)) continue;
      const key = (m[2] || '').toLowerCase();
      const mult = key ? MULTIPLIERS[key] ?? (key.startsWith('мільярд') ? 1e9 : key.startsWith('мільйон') ? 1e6 : 1) : 1;
      amounts.push(num * mult);
    }
  }
  const valid = amounts.filter((a) => a >= 1e4);
  return valid.length ? Math.max(...valid) : null;
}

// ---------------------------------------------------------------------------
// New proper-name candidates from English titles
// ---------------------------------------------------------------------------

const CANDIDATE_STOP = new Set(
  (
    'a an the and or but of in on at to for with from by as is are was were be been it its this that these those ' +
    'new how why what when where who which will can could should would may might says said report reports ' +
    'ai artificial intelligence llm llms model models agent agents chatbot chatbots data cloud app apps api ' +
    'update updates launch launches launched release releases released introducing introduces announces announced ' +
    'today week year years month day first latest best top more most just now here there our your their his her ' +
    'ceo cto cfo inc ltd llc corp co company startup startups people users developers us uk eu un ' +
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday breaking exclusive opinion analysis review ' +
    'research paper study guide tutorial video podcast episode part beta preview free open source'
  ).split(/\s+/),
);

const TOKEN_RE = /[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*|\d+(?:\.\d+)*/g;

function isNameToken(token: string): boolean {
  if (/^\d/.test(token)) return false;
  if (/^[A-Z]{2,}[0-9]*$/.test(token)) return true; // NVIDIA, GPU, H100
  if (/[a-z][A-Z]/.test(token)) return true; // DeepSeek, OpenAI
  if (/[A-Za-z]\d|\d[A-Za-z]/.test(token)) return true; // o3, R1, Llama4
  return /^[A-Z][a-z]/.test(token);
}

/**
 * Proper-name phrases in a Latin-script title: up to 4 consecutive capitalised/CamelCase tokens,
 * optionally followed by a version number ("Grok 5", "Gemini 3.1 Pro").
 * The first word of the title is kept only when it does not look like an ordinary capitalised word.
 */
export function extractCandidateTerms(title: string): string[] {
  if (!title) return [];
  const tokens = [...title.matchAll(TOKEN_RE)].map((m) => ({ text: m[0], index: m.index ?? 0 }));
  const out = new Set<string>();
  let run: string[] = [];
  const flush = () => {
    while (run.length && CANDIDATE_STOP.has(run[0].toLowerCase())) run.shift();
    while (run.length && CANDIDATE_STOP.has(run[run.length - 1].toLowerCase())) run.pop();
    if (run.length && run.some((t) => !CANDIDATE_STOP.has(t.toLowerCase()) && !/^\d/.test(t))) {
      const phrase = run.slice(0, 4).join(' ');
      if (phrase.length >= 3 && phrase.length <= 60) out.add(phrase);
    }
    run = [];
  };
  tokens.forEach((tok, i) => {
    const prev = tokens[i - 1];
    const adjacent = prev ? /^[\s]+$/.test(title.slice(prev.index + prev.text.length, tok.index)) || prev.index + prev.text.length === tok.index : false;
    if (run.length && !adjacent) flush();
    const first = i === 0;
    const name = isNameToken(tok.text);
    const plainCapital = /^[A-Z][a-z]+$/.test(tok.text);
    if (name && !(first && plainCapital && CANDIDATE_STOP.has(tok.text.toLowerCase()))) {
      run.push(tok.text);
    } else if (run.length && /^\d+(?:\.\d+)*$/.test(tok.text)) {
      run.push(tok.text);
      flush();
    } else {
      flush();
    }
  });
  flush();
  return [...out];
}

// ---------------------------------------------------------------------------
// Co-mention statistics
// ---------------------------------------------------------------------------

/** One story (a cluster of articles about the same event, or a single article). */
export interface StoryDoc {
  key: string;
  time: number;
  entityIds: string[];
  sourceIds: string[];
  newsIds: string[];
}

export interface PairStat {
  a: string;
  b: string;
  coCount: number;
  recentCount: number;
  sourceCount: number;
  pmi: number;
  npmi: number;
  lift: number;
  firstSeen: number;
  lastSeen: number;
  evidence: string[];
}

export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function computeEntityCounts(docs: StoryDoc[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const doc of docs) for (const id of new Set(doc.entityIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/**
 * PMI / NPMI / lift per pair, counted per story so that 20 copies of one press release count once.
 * Stories with more than maxEntitiesPerDoc entities (round-ups, digests) are skipped for pairs.
 */
export function computePairStats(docs: StoryDoc[], now: number, recentDays = 14, maxEntitiesPerDoc = 12): Map<string, PairStat> {
  const n = docs.filter((d) => d.entityIds.length > 0).length;
  const counts = computeEntityCounts(docs);
  const recentFrom = now - recentDays * 86_400_000;
  const pairs = new Map<string, PairStat & { sources: Set<string> }>();
  const sorted = [...docs].sort((x, y) => y.time - x.time);
  for (const doc of sorted) {
    const ids = [...new Set(doc.entityIds)].sort();
    if (ids.length < 2 || ids.length > maxEntitiesPerDoc) continue;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = `${ids[i]}|${ids[j]}`;
        let p = pairs.get(key);
        if (!p) {
          p = {
            a: ids[i], b: ids[j], coCount: 0, recentCount: 0, sourceCount: 0,
            pmi: 0, npmi: 0, lift: 0, firstSeen: doc.time, lastSeen: doc.time, evidence: [], sources: new Set(),
          };
          pairs.set(key, p);
        }
        p.coCount += 1;
        if (doc.time >= recentFrom) p.recentCount += 1;
        p.firstSeen = Math.min(p.firstSeen, doc.time);
        p.lastSeen = Math.max(p.lastSeen, doc.time);
        for (const s of doc.sourceIds) p.sources.add(s);
        if (p.evidence.length < 6) p.evidence.push(doc.newsIds[0]);
      }
    }
  }
  const out = new Map<string, PairStat>();
  for (const [key, p] of pairs) {
    const ca = counts.get(p.a) ?? 1;
    const cb = counts.get(p.b) ?? 1;
    const pab = p.coCount / n;
    const pmi = Math.log((p.coCount * n) / (ca * cb));
    const npmi = pab >= 1 ? 1 : pmi / -Math.log(pab);
    const { sources, ...rest } = p;
    out.set(key, { ...rest, sourceCount: sources.size, pmi, npmi, lift: Math.exp(pmi) });
  }
  return out;
}

export interface PairScoreInput {
  npmi: number;
  coCount: number;
  sourceCount: number;
  recentCount: number;
  firstSeen: number;
  knownRelation: boolean;
  sameCommunity: boolean;
}

/**
 * "Non-obviousness": a surprising (high NPMI) pair seen in several stories and sources,
 * preferably new, not already a known relation and connecting different communities of the graph.
 */
export function scorePair(p: PairScoreInput, now: number, recentDays = 14): number {
  const surprise = Math.max(0, p.npmi);
  const support = Math.log1p(p.coCount);
  const diversity = 0.5 + 0.5 * Math.min(1, Math.max(0, p.sourceCount - 1) / 2);
  const isNew = p.firstSeen >= now - recentDays * 86_400_000;
  const novelty = isNew ? 1 : p.recentCount / Math.max(1, p.coCount);
  const obvious = p.knownRelation ? 0.4 : 1;
  const crossCommunity = p.sameCommunity ? 1 : 1.5;
  return surprise * support * (1 + novelty) * obvious * crossCommunity * diversity;
}

// ---------------------------------------------------------------------------
// Graph algorithms on the co-mention graph
// ---------------------------------------------------------------------------

export interface Graph {
  nodes: string[];
  index: Map<string, number>;
  adj: Array<Map<number, number>>;
}

export function buildGraph(edges: Array<{ a: string; b: string; weight: number }>): Graph {
  const index = new Map<string, number>();
  const nodes: string[] = [];
  const adj: Array<Map<number, number>> = [];
  const idx = (id: string) => {
    let i = index.get(id);
    if (i === undefined) {
      i = nodes.length;
      index.set(id, i);
      nodes.push(id);
      adj.push(new Map());
    }
    return i;
  };
  for (const e of edges) {
    if (e.a === e.b || e.weight <= 0) continue;
    const i = idx(e.a);
    const j = idx(e.b);
    adj[i].set(j, (adj[i].get(j) ?? 0) + e.weight);
    adj[j].set(i, (adj[j].get(i) ?? 0) + e.weight);
  }
  return { nodes, index, adj };
}

export function pagerank(g: Graph, damping = 0.85, iterations = 60): number[] {
  const n = g.nodes.length;
  if (!n) return [];
  let rank = new Array<number>(n).fill(1 / n);
  const strength = g.adj.map((m) => [...m.values()].reduce((s, w) => s + w, 0));
  for (let it = 0; it < iterations; it += 1) {
    const next = new Array<number>(n).fill((1 - damping) / n);
    let dangling = 0;
    for (let i = 0; i < n; i += 1) {
      if (!strength[i]) {
        dangling += rank[i];
        continue;
      }
      for (const [j, w] of g.adj[i]) next[j] += (damping * rank[i] * w) / strength[i];
    }
    for (let i = 0; i < n; i += 1) next[i] += (damping * dangling) / n;
    rank = next;
  }
  return rank;
}

/** Brandes betweenness on the unweighted graph, normalised to 0..1. Samples sources on large graphs. */
export function betweenness(g: Graph, maxSources = 600): number[] {
  const n = g.nodes.length;
  const cb = new Array<number>(n).fill(0);
  if (n < 3) return cb;
  const neighbors = g.adj.map((m) => [...m.keys()]);
  const step = Math.max(1, Math.ceil(n / maxSources));
  let used = 0;
  for (let s = 0; s < n; s += step) {
    used += 1;
    const stack: number[] = [];
    const pred: number[][] = Array.from({ length: n }, () => []);
    const sigma = new Array<number>(n).fill(0);
    const dist = new Array<number>(n).fill(-1);
    sigma[s] = 1;
    dist[s] = 0;
    const queue = [s];
    for (let qi = 0; qi < queue.length; qi += 1) {
      const v = queue[qi];
      stack.push(v);
      for (const w of neighbors[v]) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          pred[w].push(v);
        }
      }
    }
    const delta = new Array<number>(n).fill(0);
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of pred[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) cb[w] += delta[w];
    }
  }
  const scale = (n / used) / ((n - 1) * (n - 2));
  return cb.map((v) => v * scale);
}

/** Louvain community detection (modularity), deterministic order. Returns a community id per node. */
export function louvain(g: Graph, maxPasses = 10): number[] {
  const n = g.nodes.length;
  let membership = Array.from({ length: n }, (_, i) => i);
  let adj = g.adj.map((m) => new Map(m));
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const size = adj.length;
    const k = adj.map((m) => [...m.values()].reduce((s, w) => s + w, 0));
    const m2 = k.reduce((s, x) => s + x, 0);
    if (!m2) break;
    const comm = Array.from({ length: size }, (_, i) => i);
    const tot = [...k];
    let moved = false;
    let improved = true;
    for (let sweep = 0; improved && sweep < 50; sweep += 1) {
      improved = false;
      for (let i = 0; i < size; i += 1) {
        const ci = comm[i];
        const links = new Map<number, number>();
        for (const [j, w] of adj[i]) {
          if (j === i) continue;
          links.set(comm[j], (links.get(comm[j]) ?? 0) + w);
        }
        tot[ci] -= k[i];
        let best = ci;
        let bestGain = (links.get(ci) ?? 0) - (tot[ci] * k[i]) / m2;
        for (const [c, w] of links) {
          const gain = w - (tot[c] * k[i]) / m2;
          if (gain > bestGain + 1e-12) {
            bestGain = gain;
            best = c;
          }
        }
        tot[best] += k[i];
        if (best !== ci) {
          comm[i] = best;
          improved = true;
          moved = true;
        }
      }
    }
    if (!moved) break;
    const renumber = new Map<number, number>();
    for (const c of comm) if (!renumber.has(c)) renumber.set(c, renumber.size);
    membership = membership.map((c) => renumber.get(comm[c])!);
    const next: Array<Map<number, number>> = Array.from({ length: renumber.size }, () => new Map());
    for (let i = 0; i < size; i += 1) {
      const ci = renumber.get(comm[i])!;
      for (const [j, w] of adj[i]) {
        const cj = renumber.get(comm[j])!;
        next[ci].set(cj, (next[ci].get(cj) ?? 0) + w);
      }
    }
    adj = next;
  }
  return membership;
}

/** Adamic-Adar score for non-adjacent pairs with at least minCommon shared neighbours. */
export function adamicAdar(g: Graph, minCommon = 2, maxHubDegree = 300): Map<string, { score: number; common: string[] }> {
  const acc = new Map<string, { score: number; common: number[] }>();
  g.adj.forEach((nbrs, z) => {
    const deg = nbrs.size;
    if (deg < 2 || deg > maxHubDegree) return;
    const weight = 1 / Math.log(deg);
    const list = [...nbrs.keys()].sort((x, y) => x - y);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const u = list[i];
        const v = list[j];
        if (g.adj[u].has(v)) continue;
        const key = `${u}|${v}`;
        const cur = acc.get(key) ?? { score: 0, common: [] };
        cur.score += weight;
        cur.common.push(z);
        acc.set(key, cur);
      }
    }
  });
  const out = new Map<string, { score: number; common: string[] }>();
  for (const [key, val] of acc) {
    if (val.common.length < minCommon) continue;
    const [u, v] = key.split('|').map(Number);
    const [a, b] = pairKey(g.nodes[u], g.nodes[v]);
    out.set(`${a}|${b}`, { score: val.score, common: val.common.map((c) => g.nodes[c]) });
  }
  return out;
}

/** Shortest path between two nodes (BFS), preferring stronger edges among equal-length paths. */
export function shortestPath(g: Graph, from: string, to: string, maxDepth = 4): string[] | null {
  const s = g.index.get(from);
  const t = g.index.get(to);
  if (s === undefined || t === undefined) return null;
  if (s === t) return [from];
  const prev = new Map<number, number>([[s, -1]]);
  let frontier = [s];
  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next: number[] = [];
    for (const v of frontier) {
      const sorted = [...g.adj[v].entries()].sort((x, y) => y[1] - x[1]);
      for (const [w] of sorted) {
        if (prev.has(w)) continue;
        prev.set(w, v);
        if (w === t) {
          const path: string[] = [];
          for (let cur = t; cur !== -1; cur = prev.get(cur)!) path.unshift(g.nodes[cur]);
          return path;
        }
        next.push(w);
      }
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export function dailySeries(times: number[], endDay: number, days: number): number[] {
  const series = new Array<number>(days).fill(0);
  const start = endDay - (days - 1) * 86_400_000;
  for (const t of times) {
    const idx = Math.floor((t - start) / 86_400_000);
    if (idx >= 0 && idx < days) series[idx] += 1;
  }
  return series;
}

/** Poisson z-score of the last `recentDays` against the preceding baseline. */
export function burstScore(series: number[], recentDays = 3): { recent: number; baselineDaily: number; z: number } {
  const recent = series.slice(-recentDays).reduce((s, x) => s + x, 0);
  const base = series.slice(0, -recentDays);
  const baselineDaily = base.length ? base.reduce((s, x) => s + x, 0) / base.length : 0;
  const expected = Math.max(0.1, baselineDaily) * recentDays;
  const z = (recent - expected) / Math.sqrt(expected);
  return { recent, baselineDaily, z };
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * Does activity of A precede activity of B? Correlates A[t] with B[t+lag] for lag 1..maxLag
 * and reports the best lag only when it clearly beats the same-day correlation.
 */
export function leadLag(a: number[], b: number[], maxLag = 7): { lag: number; corr: number; sameDay: number } | null {
  const sameDay = pearson(a, b);
  let best = { lag: 0, corr: -1 };
  for (let lag = 1; lag <= maxLag; lag += 1) {
    const corr = pearson(a.slice(0, a.length - lag), b.slice(lag));
    if (corr > best.corr) best = { lag, corr };
  }
  if (best.lag === 0 || best.corr < sameDay + 0.1) return null;
  return { ...best, sameDay };
}

// ---------------------------------------------------------------------------
// Event sequences ("funding → launch within 60 days")
// ---------------------------------------------------------------------------

export interface EntityEvent {
  entityId: string;
  eventType: string;
  time: number;
}

export interface SequenceStat {
  fromType: string;
  toType: string;
  support: number;
  entityCount: number;
  avgGapDays: number;
  confidence: number;
  lift: number;
  examples: string[];
}

export function eventSequences(events: EntityEvent[], windowDays = 60, minSupport = 3): SequenceStat[] {
  const byEntity = new Map<string, EntityEvent[]>();
  for (const e of events) {
    const list = byEntity.get(e.entityId) ?? [];
    list.push(e);
    byEntity.set(e.entityId, list);
  }
  const entitiesWithType = new Map<string, Set<string>>();
  const pairs = new Map<string, { entities: Set<string>; gaps: number[] }>();
  const windowMs = windowDays * 86_400_000;
  for (const [entityId, list] of byEntity) {
    list.sort((x, y) => x.time - y.time);
    const seenPairs = new Set<string>();
    for (const e of list) {
      const set = entitiesWithType.get(e.eventType) ?? new Set();
      set.add(entityId);
      entitiesWithType.set(e.eventType, set);
    }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const gap = list[j].time - list[i].time;
        if (gap > windowMs) break;
        if (gap < 86_400_000 || list[i].eventType === list[j].eventType) continue;
        const key = `${list[i].eventType}>${list[j].eventType}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const cur = pairs.get(key) ?? { entities: new Set(), gaps: [] };
        cur.entities.add(entityId);
        cur.gaps.push(gap / 86_400_000);
        pairs.set(key, cur);
      }
    }
  }
  const totalEntities = byEntity.size || 1;
  const out: SequenceStat[] = [];
  for (const [key, val] of pairs) {
    const [fromType, toType] = key.split('>');
    const support = val.entities.size;
    if (support < minSupport) continue;
    const withFrom = entitiesWithType.get(fromType)?.size ?? support;
    const withTo = entitiesWithType.get(toType)?.size ?? support;
    const confidence = support / withFrom;
    const lift = confidence / (withTo / totalEntities);
    out.push({
      fromType, toType, support, entityCount: withFrom,
      avgGapDays: val.gaps.reduce((s, g) => s + g, 0) / val.gaps.length,
      confidence, lift, examples: [...val.entities].slice(0, 5),
    });
  }
  return out.sort((x, y) => y.lift * y.support - x.lift * x.support);
}

// ---------------------------------------------------------------------------
// Similarity helpers
// ---------------------------------------------------------------------------

export function titleTokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !CANDIDATE_STOP.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Cosine similarity of two sparse weight vectors. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
