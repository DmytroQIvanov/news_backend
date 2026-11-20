/**
 * Multi-source "synthesis" mode for medium articles (flag KB_SYNTHESIS=true).
 *
 *  - Trigger: not the first report of an event but a TOPIC with enough material. An event qualifies when the event itself plus its
 *    sibling events (same storyline, or linked as follow-up / same storyline / reaction / context within 72 h) have at least
 *    KB_SYNTH_MIN_DOCS (3) distinct documents from at least KB_SYNTH_MIN_ORIGINS (2) independent origins. Until then it waits.
 *  - Enrichment: the dossier gets documents of the sibling events (up to KB_SYNTH_SIBLING_DOCS) next to the event's own documents
 *    (up to KB_SYNTH_MAX_DOCS = 10 in total), on top of what it already had (facts, quotes, earlier events, GDELT coverage, data).
 *  - Budget: the minified dossier may be 1.4x the old medium budget (KB_SYNTH_MINIFY_CHARS, default 28 000 x 1.4 = 39 200).
 *  - Writing: the system prompt asks for comparison of sources, contradictions, chronology, "what is new" and forbids reusing a
 *    source headline; the article must cite at least 3 distinct sources when the dossier has them.
 */
import { DatabaseService } from '../database/database.service';
import { applyMinify, buildDossier, renderDossier } from './kb-dossier';

const envInt = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export const synthesisEnabled = (): boolean => process.env.KB_SYNTHESIS === 'true';

export const synthConfig = () => ({
  minDocs: envInt('KB_SYNTH_MIN_DOCS', 3, 2, 10),
  minOrigins: envInt('KB_SYNTH_MIN_ORIGINS', 2, 1, 10),
  maxDocs: envInt('KB_SYNTH_MAX_DOCS', 10, 4, 14),
  siblingDocs: envInt('KB_SYNTH_SIBLING_DOCS', 5, 0, 10),
  siblings: envInt('KB_SYNTH_SIBLINGS', 4, 0, 8),
  minifyChars: envInt('KB_SYNTH_MINIFY_CHARS', 39_200, 8_000, 120_000),
  excerptChars: envInt('KB_SYNTH_EXCERPT_CHARS', 3_000, 500, 9_000),
  minWords: envInt('KB_SYNTH_MIN_WORDS', 350, 150, 900),
});

export interface TopicMaterial { siblingIds: number[]; docs: number; origins: number }

/**
 * Sibling events (same storyline or linked within 72 h) and how much independent material the topic has in total.
 * Reprints and research pages do not count; an origin is the evidence root of a document (or its source when unknown).
 */
export async function topicMaterial(db: DatabaseService, eventId: number): Promise<TopicMaterial> {
  const cfg = synthConfig();
  const siblings = (await db.query<{ id: string }>(
    `WITH base AS (SELECT id, storyline_id FROM kb.events WHERE id = $1)
     SELECT DISTINCT e.id FROM kb.events e, base
     WHERE e.id <> base.id AND e.status <> 'merged' AND e.last_seen_at > now() - interval '72 hours'
       AND ((base.storyline_id IS NOT NULL AND e.storyline_id = base.storyline_id)
            OR EXISTS (SELECT 1 FROM kb.event_links l WHERE l.link_type IN ('same_storyline','follow_up','reaction_to','context')
                       AND ((l.from_event_id = base.id AND l.to_event_id = e.id) OR (l.to_event_id = base.id AND l.from_event_id = e.id))))
     ORDER BY e.id DESC LIMIT $2`,
    [eventId, cfg.siblings],
  )).rows.map((r) => Number(r.id));
  const ids = [eventId, ...siblings];
  const stat = (await db.query<{ docs: string; origins: string }>(
    `SELECT count(DISTINCT d.id) AS docs, count(DISTINCT COALESCE(d.evidence_root, d.source_id::text, d.id::text)) AS origins
     FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id
     WHERE ed.event_id = ANY($1::bigint[]) AND ed.role <> 'reprint' AND d.kind <> 'research'`,
    [ids],
  )).rows[0];
  return { siblingIds: siblings, docs: Number(stat?.docs ?? 0), origins: Number(stat?.origins ?? 0) };
}

export function topicReady(m: TopicMaterial): boolean {
  const cfg = synthConfig();
  return m.docs >= cfg.minDocs && m.origins >= cfg.minOrigins;
}

/** Extra instructions appended to the medium system prompt in synthesis mode. */
export const SYNTHESIS_PROMPT = `
SYNTHESIS RULES (this story is built from several sources and several related events, not from one report):
- Do not follow one source. Compare what the different sources say; state where they agree, where they differ, and who says what.
- Give a short chronology of how the story developed, using the dated documents and the related earlier events.
- Say what is NEW compared with what was reported before ("earlier ...; now ...").
- Never reuse the headline or the opening sentence of any source. Write your own headline and structure.
- Use facts from at least three different sources when the dossier has them, and cite each with its [D#]. 350-600 words.
- If the material lists CONTRADICTIONS or one-source claims, say so plainly.`;

/** Minimum number of distinct sources an article must cite in synthesis mode (only when the dossier had that many). */
export const minCitedSources = () => synthConfig().minDocs;

export interface TrialRow {
  eventId: number; title: string; topicDocs: number; topicOrigins: number; ready: boolean;
  oldDocs: number; oldChars: number; newDocs: number; newOrigins: number; newChars: number;
}

/**
 * Dry run on real events (no model calls, no writes): what the dossier looks like with the old medium settings versus the synthesis
 * settings, and which events would wait because their topic has too little material. Used to compare before turning the flag on.
 */
export async function synthesisTrial(db: DatabaseService, limit = 20): Promise<{ rows: TrialRow[]; summary: Record<string, number> }> {
  const cfg = synthConfig();
  const events = (await db.query<{ id: string; title: string }>(
    `SELECT e.id, e.title FROM kb.events e
     WHERE e.status <> 'merged' AND e.article_news_id IS NULL AND e.last_seen_at > now() - interval '48 hours'
       AND e.editorial_state IN ('collecting', 'ready', 'deep')
     ORDER BY e.importance DESC NULLS LAST, e.last_seen_at DESC LIMIT $1`,
    [limit],
  )).rows;
  const rows: TrialRow[] = [];
  for (const e of events) {
    const id = Number(e.id);
    const topic = await topicMaterial(db, id);
    const oldD = await buildDossier(db, id, { excerptChars: 4_500, maxDocs: 14 });
    const newD = await buildDossier(db, id, { excerptChars: cfg.excerptChars, maxDocs: Math.max(4, cfg.maxDocs - cfg.siblingDocs), siblingEventIds: topic.siblingIds, siblingMaxDocs: cfg.siblingDocs });
    if (!oldD || !newD) continue;
    applyMinify(oldD, 28_000);
    applyMinify(newD, cfg.minifyChars);
    const origins = new Set(newD.docs.map((d) => d.evidenceRoot ?? d.sourceSlug ?? d.documentId)).size;
    rows.push({
      eventId: id, title: String(e.title).slice(0, 70), topicDocs: topic.docs, topicOrigins: topic.origins, ready: topicReady(topic),
      oldDocs: oldD.docs.length, oldChars: renderDossier(oldD).length, newDocs: newD.docs.length, newOrigins: origins, newChars: renderDossier(newD).length,
    });
  }
  const sum = (f: (r: TrialRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const ready = rows.filter((r) => r.ready);
  return {
    rows,
    summary: {
      events: rows.length, ready: ready.length, waiting: rows.length - ready.length,
      avgOldDocs: Math.round((sum((r) => r.oldDocs) / Math.max(1, rows.length)) * 10) / 10,
      avgNewDocsReady: Math.round((ready.reduce((s, r) => s + r.newDocs, 0) / Math.max(1, ready.length)) * 10) / 10,
      avgNewOriginsReady: Math.round((ready.reduce((s, r) => s + r.newOrigins, 0) / Math.max(1, ready.length)) * 10) / 10,
      charRatioReady: Math.round((ready.reduce((s, r) => s + r.newChars, 0) / Math.max(1, ready.reduce((s, r) => s + r.oldChars, 0))) * 100) / 100,
    },
  };
}
