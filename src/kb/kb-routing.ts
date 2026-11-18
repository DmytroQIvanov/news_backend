/**
 * Which event gets which kind of article, which models write it, and how fast the small Flash quotas are spent.
 *
 * Gemini 3.8, 3.6 and 3 Flash have 20 requests a day each, so they are kept for work a cheaper model cannot do:
 * 3.8 writes big articles and rewrites what patches could not fix, 3.6 is the independent flagship reviewer and the first
 * spare writer, 3 drafts flagship plans and is the second spare writer. Big articles never fall back to a Lite model:
 * when the Flash quotas are gone the events wait for the next day.
 */
export const MODEL_DEFAULTS = {
  big: 'gemini-3.8-flash,gemini-3.6-flash,gemini-3-flash-preview',
  medium: 'gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash-lite',
  review: 'gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash-lite',
  rewrite: 'gemini-3.8-flash,gemini-3.6-flash,gemini-3-flash-preview',
  flagshipReview: 'gemini-3.6-flash,gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-2.5-flash-lite',
  flagshipPlan: 'gemini-3-flash-preview',
};

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** 0..1. Weights are a starting point: importance 35%, independent sources 20%, primary sources 15%, novelty 15%, story value 15%. */
export function eventScoreSql(e = 'e'): string {
  return `(0.35 * LEAST(1, GREATEST(0, ${e}.importance))
    + 0.20 * LEAST(1, ${e}.independent_source_count / 6.0)
    + 0.15 * LEAST(1, ${e}.primary_source_count / 2.0)
    + 0.15 * LEAST(1, GREATEST(0, ${e}.novelty))
    + 0.15 * LEAST(1, CASE WHEN ${e}.storyline_id IS NOT NULL THEN 0.3 ELSE 0 END
        + 0.2 * (SELECT count(*) FROM (SELECT 1 FROM kb.event_links l
                 WHERE (l.from_event_id = ${e}.id OR l.to_event_id = ${e}.id) AND l.verified LIMIT 2) v)
        + CASE WHEN ${openContradictionSql(e)} THEN 0.3 ELSE 0 END))`;
}

function openContradictionSql(e: string, since?: string): string {
  return `EXISTS (SELECT 1 FROM kb.claims c JOIN kb.contradictions x ON x.fact_id = c.fact_id
                  WHERE c.event_id = ${e}.id AND x.status = 'open'${since ? ` AND x.created_at > ${since}` : ''})`;
}

export function bigEventSql(e = 'e'): string {
  const sources = Math.floor(envNumber('KB_BIG_MIN_SOURCES', 3, 2, 50));
  const fullText = Math.floor(envNumber('KB_BIG_MIN_FULL_TEXT', 3, 1, 50));
  const score = envNumber('KB_BIG_MIN_SCORE', 0.35, 0, 1);
  return `(${e}.independent_source_count >= ${sources} AND ${e}.full_text_doc_count >= ${fullText} AND ${eventScoreSql(e)} >= ${score})`;
}

/** Enough changed to justify a new article: more independent reporting, or a new open contradiction. */
export function majorChangeSql(e = 'e'): string {
  return `(${e}.independent_source_count >= COALESCE((${e}.written_evidence->>'roots')::int, 0) + 2
           OR ${openContradictionSql(e, `${e}.written_at`)})`;
}

export function newFactsSql(e = 'e', atLeast = 3): string {
  return `(SELECT count(DISTINCT c.fact_id) FROM kb.claims c WHERE c.event_id = ${e}.id AND c.fact_id IS NOT NULL)
          >= COALESCE((${e}.written_evidence->>'facts')::int, 0) + ${atLeast}`;
}

export const urgentScore = () => envNumber('KB_URGENT_MIN_SCORE', 0.7, 0, 1);

/** Keeps the best event first and puts events of the same storyline or category next to it, so a batch shares context. */
export function groupRelated<T extends { storylineId?: number | null; category?: string | null }>(items: T[]): T[] {
  const rest = [...items];
  const out: T[] = [];
  while (rest.length) {
    const lead = rest.shift()!;
    out.push(lead);
    for (const key of ['storylineId', 'category'] as const) {
      if (lead[key] === null || lead[key] === undefined) continue;
      for (let i = 0; i < rest.length;) {
        if (rest[i][key] === lead[key]) out.push(...rest.splice(i, 1));
        else i += 1;
      }
    }
  }
  return out;
}

/** Free-tier quotas return at midnight Pacific time (10:00 in Kyiv in winter). */
export function hoursUntilQuotaReset(now = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return 24 - (part('hour') + part('minute') / 60 + part('second') / 3600);
}

/**
 * How many calls may be spent now so the budget lasts until the reset. `urgentReserve` calls are kept for breaking news;
 * one call of slack lets the first batch of the day go out right after the reset.
 */
export function paceAllowance(p: { remaining: number; dayBudget: number; hoursLeft: number; urgentReserve: number }): number {
  const paced = Math.max(0, p.dayBudget - p.urgentReserve) * Math.min(1, Math.max(0, p.hoursLeft) / 24) + p.urgentReserve;
  return Math.max(0, Math.min(p.remaining - p.urgentReserve, Math.ceil(p.remaining - paced) + 1));
}
