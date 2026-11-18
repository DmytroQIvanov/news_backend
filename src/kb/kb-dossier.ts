/**
 * Event dossier: everything the knowledge base knows about one event, gathered by SQL (no LLM).
 *
 * Used twice:
 *  - by the API (/kb/...), as structured JSON for the app ("Сюжет", "Хронологія", "Що було раніше", учасники);
 *  - by the editor, rendered as compact text with reference IDs ([D1] documents, [F1] facts, [Q1] quotes,
 *    [E1] earlier events) that the generated article must cite. The LLM only writes; the research is done here.
 */
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { buildDataDocs } from './kb-data';
import type { DataAttachment } from './kb-data-selection';
import { FACT_STATUS_LABELS, label, Lang, LINK_LABELS, PREDICATE_LABELS, TIER_LABELS } from './kb-labels';

import { DocForMinify, focusTokens, minifyDossierDocs } from './kb-minify';

export interface DossierDoc {
  ref: string;
  documentId: number;
  sourceName: string;
  sourceSlug: string | null;
  tier: string | null;
  evidenceRoot: string | null;
  role: string;
  title: string;
  url: string;
  publishedAt: string | null;
  lang: string | null;
  extraction: string;
  excerpt: string;
  newsId: number | null;
  reliability?: number;
  data?: DataAttachment;
}

export interface DossierFact {
  ref: string;
  factId: number;
  subject: { id: number; name: string } | null;
  predicate: string;
  object: { id: number; name: string } | null;
  objectText: string | null;
  value: number | null;
  unit: string | null;
  status: string;
  roots: number;
  validFrom: string | null;
  negated: boolean;
  planned: boolean;
  docRefs: string[];
}

export interface DossierQuote {
  ref: string;
  speaker: { id: number; name: string } | null;
  sentence: string;
  docRef: string | null;
  modality: string;
}

export interface DossierLinkedEvent {
  ref: string;
  eventId: number;
  linkType: string;
  direction: 'earlier' | 'later';
  score: number;
  title: string;
  summary: string | null;
  startedAt: string | null;
  sources: number;
  newsId: number | null;
}

export interface DossierEntity {
  id: number;
  name: string;
  nameUk: string | null;
  kind: string;
  description: string | null;
  descriptionUk: string | null;
  wikidataId: string | null;
  weight: number;
}

export interface EventDossier {
  event: {
    id: number;
    title: string;
    summary: string | null;
    category: string | null;
    eventType: string | null;
    startedAt: string | null;
    lastSeenAt: string | null;
    docCount: number;
    independentSources: number;
    primarySources: number;
    fullTextDocs: number;
    importance: number;
    editorialState: string;
    articleNewsId: number | null;
    storylineId: number | null;
  };
  docs: DossierDoc[];
  facts: DossierFact[];
  quotes: DossierQuote[];
  contradictions: Array<{ factRef: string; kind: string; detail: unknown }>;
  entities: DossierEntity[];
  linked: DossierLinkedEvent[];
  storyline: { id: number; title: string; events: Array<{ eventId: number; title: string; startedAt: string | null; newsId: number | null; current: boolean }> } | null;
  background: DossierFact[];
  hash: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
const day = (v: string | null) => (v ? v.slice(0, 10) : '—');

export async function buildDossier(db: DatabaseService, eventId: number, opts: { excerptChars?: number; maxDocs?: number; includeData?: boolean } = {}): Promise<EventDossier | null> {
  const excerptChars = opts.excerptChars ?? 1500;
  const maxDocs = opts.maxDocs ?? 10;
  const ev = (await db.query(
    `SELECT e.*, COALESCE(e.merged_into, e.id) AS effective_id FROM kb.events e WHERE e.id = $1`, [eventId],
  )).rows[0];
  if (!ev) return null;
  if (ev.status === 'merged' && ev.merged_into) return buildDossier(db, Number(ev.merged_into), opts);

  const docs = (await db.query(
    `SELECT d.id, d.title, d.url, d.published_at, d.lang, d.extraction_status, d.evidence_root,
            left(COALESCE(NULLIF(d.body, ''), d.feed_summary, ''), $3) AS excerpt,
            s.name AS source_name, s.slug AS source_slug, p.tier, ed.role, d.legacy_news_id,
            COALESCE(p.reliability, 0.6) AS reliability
     FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id
     LEFT JOIN public.sources s ON s.id = d.source_id
     LEFT JOIN kb.source_profiles p ON p.source_id = d.source_id
     WHERE ed.event_id = $1
     ORDER BY (ed.role = 'reprint'), (d.extraction_status = 'full') DESC, (p.tier = 'primary') DESC,
              COALESCE(p.reliability, 0.6) DESC, d.published_at
     LIMIT $2`,
    [eventId, maxDocs, excerptChars],
  )).rows;
  // Pages found by the AI corroboration search (kb-corroboration.service.ts) that a second AI pass accepted: they are
  // cited like any other source. Pages that were not accepted never appear here.
  const corroborated = (
    await db
      .query(
        `SELECT d.id, d.title, d.url, d.published_at, d.lang, d.extraction_status, d.evidence_root,
                left(COALESCE(d.body, ''), $2) AS excerpt, r.verdict, r.query AS research_kind
         FROM kb.event_research r JOIN kb.documents d ON d.id = r.document_id
         WHERE r.event_id = $1 AND r.accepted = true AND r.query IN ('corroboration', 'video')
           AND d.extraction_status IN ('full', 'partial')
         ORDER BY r.added_at LIMIT 12`,
        [eventId, excerptChars],
      )
      .catch(() => ({ rows: [] as Record<string, any>[] }))
  ).rows;
  // an accepted page counts once: not when the pipeline already attached the same document, not twice per origin root
  const attachedIds = new Set(docs.map((d) => Number(d.id)));
  const attachedRoots = new Set(docs.map((d) => d.evidence_root).filter(Boolean));
  const takenRoots = new Set<string>();
  for (let i = corroborated.length - 1; i >= 0; i -= 1) {
    const c = corroborated[i];
    const root = String(((c.verdict ?? {}) as Record<string, any>).root ?? c.evidence_root ?? '');
    if (attachedIds.has(Number(c.id)) || (c.research_kind !== 'video' && root && (attachedRoots.has(root) || takenRoots.has(root)))) {
      corroborated.splice(i, 1);
      continue;
    }
    if (root) takenRoots.add(root);
  }
  for (const c of corroborated) {
    const verdict = (c.verdict ?? {}) as Record<string, any>;
    docs.push({
      id: c.id, title: c.title, url: c.url, published_at: c.published_at, lang: c.lang, extraction_status: c.extraction_status,
      evidence_root: c.evidence_root ?? verdict.root ?? null, excerpt: c.excerpt, source_name: verdict.root || new URL(c.url).hostname.replace(/^www\./, ''),
      source_slug: null, tier: verdict.source_type === 'official' || verdict.source_type === 'primary_document' ? 'primary' : null,
      role: c.research_kind === 'video' ? 'video' : 'corroboration', legacy_news_id: null, reliability: verdict.reliability === 'high' ? 0.85 : 0.65,
    });
  }
  const docRef = new Map<number, string>();
  const outDocs: DossierDoc[] = docs.map((d, i) => {
    const ref = `D${i + 1}`;
    docRef.set(Number(d.id), ref);
    const teaser = d.extraction_status !== 'full' && d.extraction_status !== 'partial';
    return {
      ref, documentId: Number(d.id), sourceName: d.source_name ?? 'Unknown', sourceSlug: d.source_slug, tier: d.tier,
      evidenceRoot: d.evidence_root, role: d.role, title: d.title, url: d.url, publishedAt: iso(d.published_at), lang: d.lang,
      extraction: d.extraction_status, excerpt: teaser ? String(d.excerpt || '').slice(0, 400) : String(d.excerpt || ''),
      newsId: d.legacy_news_id ? Number(d.legacy_news_id) : null, reliability: d.reliability !== undefined ? Number(d.reliability) : undefined,
    };
  });

  const factRows = (await db.query(
    `SELECT f.id, f.predicate, f.object_text, f.value_num, f.value_unit, f.status, f.source_count, f.valid_from, f.object_key,
            s.id AS sid, COALESCE(s.name_uk, s.name) AS sname_uk, s.name AS sname,
            o.id AS oid, COALESCE(o.name_uk, o.name) AS oname_uk, o.name AS oname,
            array_agg(DISTINCT c.document_id) AS doc_ids, max(c.confidence) AS conf
     FROM kb.claims c JOIN kb.facts f ON f.id = c.fact_id
     JOIN kb.entities s ON s.id = f.subject_entity_id LEFT JOIN kb.entities o ON o.id = f.object_entity_id
     WHERE c.event_id = $1
     GROUP BY f.id, s.id, o.id
     ORDER BY f.source_count DESC, (f.status = 'confirmed') DESC, max(c.confidence) DESC
     LIMIT 30`,
    [eventId],
  )).rows;
  const factRef = new Map<number, string>();
  const facts: DossierFact[] = factRows.map((f, i) => {
    const ref = `F${i + 1}`;
    factRef.set(Number(f.id), ref);
    return toFact(f, ref, docRef);
  });

  const quotes = (await db.query(
    `SELECT c.sentence, c.document_id, c.modality, e.id AS sid, COALESCE(e.name_uk, e.name) AS sname
     FROM kb.claims c LEFT JOIN kb.entities e ON e.id = c.subject_entity_id
     WHERE c.event_id = $1 AND c.predicate IN ('state', 'deny') AND c.subject_entity_id IS NOT NULL
       AND e.kind IN ('person', 'organization', 'government', 'company', 'group')
     ORDER BY c.confidence DESC, length(c.sentence) LIMIT 8`,
    [eventId],
  )).rows.map((q, i): DossierQuote => ({
    ref: `Q${i + 1}`, speaker: q.sid ? { id: Number(q.sid), name: q.sname } : null, sentence: String(q.sentence).slice(0, 400),
    docRef: docRef.get(Number(q.document_id)) ?? null, modality: q.modality,
  }));

  const contradictions = factRef.size
    ? (await db.query(
        `SELECT fact_id, other_fact_id, kind, detail FROM kb.contradictions
         WHERE status = 'open' AND (fact_id = ANY($1) OR other_fact_id = ANY($1))`,
        [[...factRef.keys()]],
      )).rows.map((c) => ({ factRef: factRef.get(Number(c.fact_id)) ?? factRef.get(Number(c.other_fact_id)) ?? '?', kind: c.kind, detail: c.detail }))
    : [];

  const entities = (await db.query(
    `SELECT e.id, e.name, e.name_uk, e.kind, e.description, e.attributes->>'description_uk' AS description_uk, e.wikidata_id, ee.weight
     FROM kb.event_entities ee JOIN kb.entities e ON e.id = ee.entity_id
     WHERE ee.event_id = $1 AND e.status = 'active' ORDER BY ee.weight DESC LIMIT 10`,
    [eventId],
  )).rows.map((e): DossierEntity => ({
    id: Number(e.id), name: e.name, nameUk: e.name_uk, kind: e.kind, description: e.description, descriptionUk: e.description_uk,
    wikidataId: e.wikidata_id, weight: Number(e.weight),
  }));

  // open data about the participants (statistics, registries, coverage) as citable [S#] sources
  if (opts.includeData !== false) {
    outDocs.push(...await buildDataDocs(db, eventId, ev.category, entities, iso(ev.last_seen_at) || iso(ev.started_at), {
      text: [ev.title,ev.summary,...docs.map((d) => `${d.title} ${d.excerpt}`)].filter(Boolean).join(' '),
    }));
  }

  const linked = (await db.query(
    `SELECT l.link_type, l.score, l.from_event_id, l.to_event_id, o.id, o.title, o.summary, o.started_at,
            o.independent_source_count, o.article_news_id
     FROM kb.event_links l JOIN kb.events o ON o.id = CASE WHEN l.from_event_id = $1 THEN l.to_event_id ELSE l.from_event_id END
     WHERE (l.from_event_id = $1 OR l.to_event_id = $1) AND o.status <> 'merged'
     ORDER BY CASE l.link_type WHEN 'reaction_to' THEN 0 WHEN 'precedent' THEN 1 WHEN 'follow_up' THEN 2 ELSE 3 END, l.score DESC
     LIMIT 10`,
    [eventId],
  )).rows.map((l, i): DossierLinkedEvent => ({
    ref: `E${i + 1}`, eventId: Number(l.id), linkType: l.link_type,
    direction: Number(l.from_event_id) === eventId ? 'earlier' : 'later', score: Number(l.score), title: l.title, summary: l.summary,
    startedAt: iso(l.started_at), sources: Number(l.independent_source_count || 0), newsId: l.article_news_id ? Number(l.article_news_id) : null,
  }));

  let storyline: EventDossier['storyline'] = null;
  if (ev.storyline_id) {
    const sl = (await db.query('SELECT id, title FROM kb.storylines WHERE id = $1', [ev.storyline_id])).rows[0];
    if (sl) {
      const events = (await db.query(
        `SELECT id, title, started_at, article_news_id FROM kb.events
         WHERE storyline_id = $1 AND status <> 'merged' ORDER BY started_at LIMIT 30`,
        [sl.id],
      )).rows;
      storyline = {
        id: Number(sl.id), title: sl.title,
        events: events.map((e) => ({ eventId: Number(e.id), title: e.title, startedAt: iso(e.started_at), newsId: e.article_news_id ? Number(e.article_news_id) : null, current: Number(e.id) === eventId })),
      };
    }
  }

  // Durable facts about the main participants learned earlier (who owns what, who holds which post ...).
  const mainIds = entities.slice(0, 4).map((e) => e.id);
  const background = mainIds.length
    ? (await db.query(
        `SELECT f.id, f.predicate, f.object_text, f.value_num, f.value_unit, f.status, f.source_count, f.valid_from, f.object_key,
                s.id AS sid, COALESCE(s.name_uk, s.name) AS sname_uk, s.name AS sname,
                o.id AS oid, COALESCE(o.name_uk, o.name) AS oname_uk, o.name AS oname, '{}'::bigint[] AS doc_ids
         FROM kb.facts f JOIN kb.entities s ON s.id = f.subject_entity_id LEFT JOIN kb.entities o ON o.id = f.object_entity_id
         WHERE (f.subject_entity_id = ANY($1) OR f.object_entity_id = ANY($1))
           AND f.status IN ('corroborated', 'confirmed') AND f.object_key NOT LIKE 'NOT|%' AND f.object_key NOT LIKE 'PLAN|%'
           AND (f.first_event_id IS DISTINCT FROM $2) AND f.last_seen > now() - interval '400 days'
         ORDER BY f.source_count DESC, f.last_seen DESC LIMIT 12`,
        [mainIds, eventId],
      )).rows.map((f, i) => toFact(f, `B${i + 1}`, docRef))
    : [];

  const event = {
    id: Number(ev.id), title: ev.title, summary: ev.summary, category: ev.category, eventType: ev.event_type,
    startedAt: iso(ev.started_at), lastSeenAt: iso(ev.last_seen_at), docCount: Number(ev.doc_count),
    independentSources: Number(ev.independent_source_count) + corroborated.filter((c) => c.research_kind !== 'video').length, primarySources: Number(ev.primary_source_count),
    fullTextDocs: Number(ev.full_text_doc_count), importance: Number(ev.importance), editorialState: ev.editorial_state,
    articleNewsId: ev.article_news_id ? Number(ev.article_news_id) : null, storylineId: ev.storyline_id ? Number(ev.storyline_id) : null,
  };
  const hash = createHash('sha256')
    .update(JSON.stringify([outDocs.map((d) => [d.documentId,d.data?.key,d.data?.value,d.data?.points?.map((p) => [p.versionId,p.value])]), facts.map((f) => [f.factId, f.status, f.roots, f.value]), linked.map((l) => l.eventId)]))
    .digest('hex');
  // Corroborating pages that disagree with the known facts are shown to the editor as contradictions, never dropped.
  for (const c of corroborated) {
    const verdict = (c.verdict ?? {}) as Record<string, any>;
    const ref = docRef.get(Number(c.id));
    if (ref && verdict.conflicts_with_event && verdict.conflict_detail) {
      contradictions.push({ factRef: ref, kind: 'source_disagreement', detail: { source: verdict.root ?? c.url, difference: verdict.conflict_detail } });
    }
  }
  return { event, docs: outDocs, facts, quotes, contradictions, entities, linked, storyline, background, hash };
}

function toFact(f: Record<string, any>, ref: string, docRef: Map<number, string>): DossierFact {
  const key = String(f.object_key || '');
  return {
    ref, factId: Number(f.id),
    subject: f.sid ? { id: Number(f.sid), name: f.sname_uk || f.sname } : null,
    predicate: f.predicate,
    object: f.oid ? { id: Number(f.oid), name: f.oname_uk || f.oname } : null,
    objectText: f.object_text,
    value: f.value_num === null || f.value_num === undefined ? null : Number(f.value_num),
    unit: f.value_unit,
    status: f.status,
    roots: Number(f.source_count || 0),
    validFrom: iso(f.valid_from),
    negated: key.startsWith('NOT|'),
    planned: key.startsWith('PLAN|'),
    docRefs: (f.doc_ids || []).map((id: unknown) => docRef.get(Number(id))).filter(Boolean),
  };
}

export function factSentence(f: DossierFact, lang: Lang): string {
  const subj = f.subject?.name ?? '?';
  const obj = f.object?.name ?? f.objectText ?? '';
  const pred = label(PREDICATE_LABELS, f.predicate, lang);
  const val = f.value !== null ? ` ${formatNumber(f.value)}${f.unit ? ` ${f.unit}` : ''}` : '';
  const neg = f.negated ? (lang === 'uk' ? 'НЕ ' : 'NOT ') : '';
  const plan = f.planned ? (lang === 'uk' ? '(план) ' : '(planned) ') : '';
  return `${plan}${subj} — ${neg}${pred}${obj ? ` — ${obj}` : ''}${val}`;
}

function formatNumber(v: number): string {
  if (Math.abs(v) >= 1e9) return `${+(v / 1e9).toFixed(2)} bn`;
  if (Math.abs(v) >= 1e6) return `${+(v / 1e6).toFixed(2)} m`;
  return v.toLocaleString('en-US');
}

/** Compact text for the LLM (ids are what the article must cite). */
export function renderDossier(d: EventDossier): string {
  const e = d.event;
  const lines: string[] = [];
  lines.push(`EVENT #${e.id}: ${e.title}`);
  lines.push(`category=${e.category ?? '-'} type=${e.eventType ?? '-'} first_report=${day(e.startedAt)} independent_sources=${e.independentSources} primary_sources=${e.primarySources}`);
  lines.push('', 'SOURCES (cite news/documents as [D#], web research as [R#], official data and registries as [S#] — quote data values exactly with their period):');
  for (const doc of d.docs) {
    const root = doc.evidenceRoot && doc.sourceSlug && !doc.sourceSlug.includes(doc.evidenceRoot) ? ` cites:${doc.evidenceRoot}` : '';
    lines.push(`[${doc.ref}] ${doc.sourceName} (${label(TIER_LABELS, doc.tier, 'en') || 'media'}${root}; ${doc.extraction}${doc.role === 'reprint' ? '; reprint' : ''}) ${day(doc.publishedAt)} — "${doc.title}"`);
    if (doc.excerpt) lines.push(`    ${doc.excerpt.replace(/\s+/g, ' ').trim()}`);
  }
  if (d.facts.length) {
    lines.push('', 'FACTS EXTRACTED BY ALGORITHMS (status = strength of evidence):');
    for (const f of d.facts) {
      lines.push(`[${f.ref}] ${factSentence(f, 'en')} | ${label(FACT_STATUS_LABELS, f.status, 'en')}, roots=${f.roots}${f.validFrom ? `, date=${day(f.validFrom)}` : ''}${f.docRefs.length ? `, in ${f.docRefs.join(',')}` : ''}`);
    }
  }
  if (d.contradictions.length) {
    lines.push('', 'CONTRADICTIONS (must be shown to the reader, never resolved silently):');
    for (const c of d.contradictions) lines.push(`- ${c.factRef}: ${c.kind} ${JSON.stringify(c.detail)}`);
  }
  if (d.quotes.length) {
    lines.push('', 'STATEMENTS (attribute, do not present as facts):');
    for (const q of d.quotes) lines.push(`[${q.ref}] ${q.speaker?.name ?? '?'} (${q.docRef ?? '-'}; ${q.modality}): ${q.sentence}`);
  }
  if (d.entities.length) {
    lines.push('', 'PARTICIPANTS:');
    for (const en of d.entities.slice(0, 8)) lines.push(`- ${en.nameUk || en.name} / ${en.name} (${en.kind})${en.description ? `: ${en.description}` : ''}`);
  }
  if (d.linked.length) {
    lines.push('', 'RELATED EVENTS FROM THE KNOWLEDGE BASE (cite as [E#]; link types are algorithmic hypotheses unless stated):');
    for (const l of d.linked) {
      lines.push(`[${l.ref}] ${day(l.startedAt)} ${l.direction} | ${label(LINK_LABELS, l.linkType, 'en')} (score ${l.score.toFixed(2)}) — ${l.title}${l.summary ? ` — ${l.summary.slice(0, 300)}` : ''}`);
    }
  }
  if (d.storyline && d.storyline.events.length > 1) {
    lines.push('', `STORYLINE "${d.storyline.title}":`);
    for (const se of d.storyline.events) lines.push(`- ${day(se.startedAt)} ${se.current ? '(THIS EVENT) ' : ''}${se.title}`);
  }
  if (d.background.length) {
    lines.push('', 'ESTABLISHED EARLIER FACTS ABOUT THE PARTICIPANTS (cite as [B#]):');
    for (const b of d.background) lines.push(`[${b.ref}] ${factSentence(b, 'en')} | ${label(FACT_STATUS_LABELS, b.status, 'en')}${b.validFrom ? `, ${day(b.validFrom)}` : ''}`);
  }
  return lines.join('\n');
}


const TIER_WEIGHT: Record<string, number> = { primary: 1, official: 1, agency: 0.85, wire: 0.85, media: 0.65, research: 0.5 };

/**
 * Shrinks the excerpts of a dossier to `totalChars` without paraphrasing: extractive sentence selection, cross-source
 * deduplication ("also in D1"), reliability-weighted budgets (kb-minify.ts). Teasers and data documents are left alone.
 * Documents that do not fit keep a one-line stub, so a heavy model still sees that the source exists.
 */
export function applyMinify(d: EventDossier, totalChars: number): { originalChars: number; keptChars: number; docs: number } {
  const ctx = {
    focus: focusTokens(
      d.event.title, d.event.summary ?? '', d.entities.slice(0, 12).map((e) => e.name).join(' '),
      d.facts.slice(0, 20).map((f) => `${f.subject?.name ?? ''} ${f.predicate} ${f.object?.name ?? f.objectText ?? ''}`).join(' '),
    ),
  };
  const targets = d.docs.filter((x) => x.excerpt && x.excerpt.length > 600 && !x.data && (x.extraction === 'full' || x.extraction === 'partial'));
  const inputs: DocForMinify[] = targets.map((x, i) => ({
    ref: x.ref, text: x.excerpt, order: i, primary: x.tier === 'primary' || x.role === 'primary',
    weight: typeof x.reliability === 'number' && Number.isFinite(x.reliability) ? Math.max(0.2, Math.min(1, x.reliability)) : TIER_WEIGHT[x.tier ?? ''] ?? (x.role === 'corroboration' ? 0.65 : 0.6),
  }));
  if (inputs.length < 2 && !inputs.some((x) => x.text.length > totalChars)) return { originalChars: 0, keptChars: 0, docs: 0 };
  const res = minifyDossierDocs(inputs, totalChars, ctx);
  const byRef = new Map(res.docs.map((m) => [m.ref, m]));
  for (const doc of targets) {
    const m = byRef.get(doc.ref);
    if (m) {
      const also = Object.keys(m.alsoIn);
      doc.excerpt = m.text + (also.length ? ` (further wording identical to ${also.join(', ')} omitted)` : '');
    } else {
      doc.excerpt = doc.excerpt.slice(0, 220); // overflow stub
    }
  }
  return { originalChars: res.originalChars, keptChars: res.keptChars, docs: res.docs.length };
}
