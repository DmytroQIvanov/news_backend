/**
 * Deep history of an event for flagship long-reads: what led here, step by step, from the knowledge base.
 *
 *  - Event graph walk: kb.event_links (reaction_to, follow_up, precedent, same_storyline) up to 3 hops back,
 *    each step with its date, sources and best facts — the candidate causal chain.
 *  - Precedents: earlier events of the same type with the same specific actors (up to 2 years), even if no link
 *    was drawn yet ("the previous sanctions package", "the last strike on this bridge").
 *  - Actor timelines: dated durable facts about the main participants (appointments, acquisitions, captures ...).
 * Everything is algorithmic and carries reference IDs ([H#] steps, [P#] precedents, [T#] timeline facts) that the
 * planner verifies and the writer cites. No LLM here.
 */
import { DatabaseService } from '../database/database.service';
import { factSentence } from './kb-dossier';
import { label, LINK_LABELS } from './kb-labels';

export interface HistoryStep {
  ref: string;
  eventId: number;
  hop: number;
  viaEventId: number;
  linkType: string;
  score: number;
  title: string;
  summary: string | null;
  date: string | null;
  sources: number;
  facts: string[];
  verdict: unknown;
}

export interface EventHistory {
  steps: HistoryStep[];
  precedents: Array<{ ref: string; eventId: number; title: string; date: string | null; sources: number; facts: string[] }>;
  timeline: Array<{ ref: string; entity: string; text: string; date: string | null; status: string }>;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
const day = (v: string | null) => (v ? v.slice(0, 10) : '—');
const STEP_TYPES = ['reaction_to', 'follow_up', 'precedent', 'same_storyline', 'causes', 'context'];

async function topFacts(db: DatabaseService, eventId: number, n: number): Promise<string[]> {
  const rows = (await db.query(
    `SELECT DISTINCT ON (f.id) f.id, f.predicate, f.object_text, f.value_num, f.value_unit, f.status, f.source_count, f.valid_from,
            f.object_key, s.id AS sid, COALESCE(s.name_uk, s.name) AS sname_uk, o.id AS oid, COALESCE(o.name_uk, o.name) AS oname_uk
     FROM kb.claims c JOIN kb.facts f ON f.id = c.fact_id
     JOIN kb.entities s ON s.id = f.subject_entity_id LEFT JOIN kb.entities o ON o.id = f.object_entity_id
     WHERE c.event_id = $1 AND f.object_key NOT LIKE 'PLAN|%'
     ORDER BY f.id, f.source_count DESC LIMIT 20`,
    [eventId],
  ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  rows.sort((a, b) => Number(b.source_count) - Number(a.source_count));
  return rows.slice(0, n).map((f) => factSentence({
    ref: '', factId: Number(f.id), subject: { id: Number(f.sid), name: f.sname_uk }, predicate: f.predicate,
    object: f.oid ? { id: Number(f.oid), name: f.oname_uk } : null, objectText: f.object_text,
    value: f.value_num === null ? null : Number(f.value_num), unit: f.value_unit, status: f.status, roots: Number(f.source_count),
    validFrom: iso(f.valid_from), negated: String(f.object_key).startsWith('NOT|'), planned: false, docRefs: [],
  }, 'en'));
}

export async function buildHistory(db: DatabaseService, eventId: number, opts: { maxHops?: number; maxSteps?: number } = {}): Promise<EventHistory> {
  const maxHops = opts.maxHops ?? 3;
  const maxSteps = opts.maxSteps ?? 18;
  const steps: HistoryStep[] = [];
  const seen = new Set<number>([eventId]);
  let frontier = [eventId];
  for (let hop = 1; hop <= maxHops && frontier.length && steps.length < maxSteps; hop += 1) {
    const rows = (await db.query(
      `SELECT l.from_event_id, l.to_event_id, l.link_type, l.score, l.verdict, e.id, e.title, e.summary, e.started_at,
              e.independent_source_count
       FROM kb.event_links l JOIN kb.events e ON e.id = l.to_event_id
       WHERE l.from_event_id = ANY($1) AND l.link_type = ANY($2) AND e.status <> 'merged'
         AND COALESCE((l.verdict->>'supported')::boolean, true)
       ORDER BY l.score DESC LIMIT 40`,
      [frontier, STEP_TYPES],
    ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
    const next: number[] = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (seen.has(id) || steps.length >= maxSteps) continue;
      // deeper hops only through strong links, otherwise the walk drifts into the whole war/economy
      if (hop > 1 && Number(r.score) < 0.6 && r.link_type === 'same_storyline') continue;
      seen.add(id);
      next.push(id);
      steps.push({
        ref: `H${steps.length + 1}`, eventId: id, hop, viaEventId: Number(r.from_event_id), linkType: r.link_type, score: Number(r.score),
        title: r.title, summary: r.summary, date: iso(r.started_at), sources: Number(r.independent_source_count || 0),
        facts: await topFacts(db, id, 3), verdict: r.verdict,
      });
    }
    frontier = next.slice(0, 8);
  }

  // Precedents: same event type, sharing a specific actor, 14 days .. 2 years earlier.
  const ev = (await db.query('SELECT event_type, started_at FROM kb.events WHERE id = $1', [eventId])).rows[0];
  let precedents: EventHistory['precedents'] = [];
  if (ev?.event_type) {
    const rows = (await db.query(
      `WITH mine AS (
         SELECT ee.entity_id FROM kb.event_entities ee JOIN kb.entities en ON en.id = ee.entity_id
         WHERE ee.event_id = $1 AND ee.weight >= 0.3 AND en.doc_count < 400 ORDER BY ee.weight DESC LIMIT 5)
       SELECT e.id, e.title, e.started_at, e.independent_source_count, count(*) AS shared
       FROM kb.events e JOIN kb.event_entities ee ON ee.event_id = e.id AND ee.entity_id IN (SELECT entity_id FROM mine)
       WHERE e.event_type = $2 AND e.id <> $1 AND e.status <> 'merged'
         AND e.started_at < $3::timestamptz - interval '14 days' AND e.started_at > $3::timestamptz - interval '730 days'
         AND NOT (e.id = ANY($4))
       GROUP BY e.id ORDER BY count(*) DESC, e.independent_source_count DESC, e.started_at DESC LIMIT 6`,
      [eventId, ev.event_type, ev.started_at, [...seen]],
    ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
    precedents = await Promise.all(rows.map(async (r, i) => ({
      ref: `P${i + 1}`, eventId: Number(r.id), title: r.title, date: iso(r.started_at), sources: Number(r.independent_source_count || 0),
      facts: await topFacts(db, Number(r.id), 2),
    })));
  }

  // Dated durable facts about the main participants (the "who is who and since when").
  const tl = (await db.query(
    `WITH main AS (
       SELECT ee.entity_id FROM kb.event_entities ee JOIN kb.entities en ON en.id = ee.entity_id
       WHERE ee.event_id = $1 AND en.kind IN ('person', 'company', 'organization', 'government', 'group', 'facility')
       ORDER BY ee.weight DESC LIMIT 4)
     SELECT f.id, f.predicate, f.object_text, f.value_num, f.value_unit, f.status, f.source_count, f.object_key,
            COALESCE(f.valid_from, f.first_seen::date) AS d, s.id AS sid, COALESCE(s.name_uk, s.name) AS sname_uk,
            o.id AS oid, COALESCE(o.name_uk, o.name) AS oname_uk
     FROM kb.facts f JOIN kb.entities s ON s.id = f.subject_entity_id LEFT JOIN kb.entities o ON o.id = f.object_entity_id
     WHERE (f.subject_entity_id IN (SELECT entity_id FROM main) OR f.object_entity_id IN (SELECT entity_id FROM main))
       AND f.status IN ('corroborated', 'confirmed') AND f.object_key NOT LIKE 'PLAN|%'
       AND f.object_key NOT LIKE '%|ev:%' AND f.first_event_id IS DISTINCT FROM $1
     ORDER BY d DESC LIMIT 12`,
    [eventId],
  ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
  const timeline = tl.map((f, i) => ({
    ref: `T${i + 1}`, entity: f.sname_uk, status: f.status, date: iso(f.d),
    text: factSentence({
      ref: '', factId: Number(f.id), subject: { id: Number(f.sid), name: f.sname_uk }, predicate: f.predicate,
      object: f.oid ? { id: Number(f.oid), name: f.oname_uk } : null, objectText: f.object_text,
      value: f.value_num === null ? null : Number(f.value_num), unit: f.value_unit, status: f.status, roots: Number(f.source_count),
      validFrom: iso(f.d), negated: String(f.object_key).startsWith('NOT|'), planned: false, docRefs: [],
    }, 'en'),
  }));
  return { steps, precedents, timeline };
}

export function renderHistory(h: EventHistory): string {
  const lines: string[] = [];
  if (h.steps.length) {
    lines.push('CANDIDATE CAUSAL / CONTEXT CHAIN (algorithmic; hop 1 = directly linked to this event; cite as [H#]):');
    for (const s of h.steps) {
      const v = s.verdict && typeof s.verdict === 'object' ? ` [earlier verdict: ${JSON.stringify(s.verdict)}]` : '';
      lines.push(`[${s.ref}] hop ${s.hop} ${day(s.date)} | ${label(LINK_LABELS, s.linkType, 'en')} of event #${s.viaEventId} (score ${s.score.toFixed(2)}, ${s.sources} sources) — ${s.title}${v}`);
      if (s.summary) lines.push(`    ${s.summary.slice(0, 400)}`);
      for (const f of s.facts) lines.push(`    · ${f}`);
    }
  }
  if (h.precedents.length) {
    lines.push('', 'PRECEDENTS: same kind of event with the same actors earlier (cite as [P#]):');
    for (const p of h.precedents) {
      lines.push(`[${p.ref}] ${day(p.date)} (${p.sources} sources) — ${p.title}`);
      for (const f of p.facts) lines.push(`    · ${f}`);
    }
  }
  if (h.timeline.length) {
    lines.push('', 'ACTOR TIMELINE: established facts about the main participants (cite as [T#]):');
    for (const t of h.timeline) lines.push(`[${t.ref}] ${day(t.date)} ${t.text} (${t.status})`);
  }
  return lines.join('\n');
}
