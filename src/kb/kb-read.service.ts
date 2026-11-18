/** Read API over the knowledge base for the app: story context of an article, events, entities, storylines. */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { buildDossier, EventDossier, factSentence } from './kb-dossier';
import { FACT_STATUS_LABELS, label, Lang, LINK_LABELS, PREDICATE_LABELS, TIER_LABELS } from './kb-labels';

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

@Injectable()
export class KbReadService {
  constructor(private readonly db: DatabaseService) {}

  /** The event behind a published article (written by the KB editor, or a legacy article whose document joined an event). */
  async contextForNews(newsId: number, lang: Lang) {
    const row = (await this.db.query<{ event_id: string | null }>(
      `SELECT COALESCE(n.kb_event_id,
                       (SELECT ed.event_id FROM kb.documents d JOIN kb.event_documents ed ON ed.document_id = d.id
                        WHERE d.legacy_news_id = n.id LIMIT 1)) AS event_id
       FROM news_items n WHERE n.id = $1`,
      [newsId],
    ).catch(() => ({ rows: [] as Array<{ event_id: string | null }> }))).rows[0];
    if (!row?.event_id) return null;
    return this.event(Number(row.event_id), lang);
  }

  async event(eventId: number, lang: Lang) {
    const d = await buildDossier(this.db, eventId, { excerptChars: 0, maxDocs: 30 });
    if (!d) return null;
    return shapeEvent(d, lang);
  }

  async events(state: string | undefined, limit: number, lang: Lang) {
    const rows = (await this.db.query(
      `SELECT id, title, summary, category, editorial_state, importance, independent_source_count, started_at, article_news_id
       FROM kb.events WHERE status <> 'merged' AND ($1::text IS NULL OR editorial_state = $1)
       ORDER BY ${state === 'written' ? 'written_at DESC NULLS LAST' : 'importance DESC'} LIMIT $2`,
      [state ?? null, limit],
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows;
    return rows.map((r) => ({
      id: Number(r.id), title: r.title, summary: r.summary, category: r.category, state: r.editorial_state,
      importance: Number(r.importance), independentSources: Number(r.independent_source_count), startedAt: iso(r.started_at),
      newsId: r.article_news_id ? Number(r.article_news_id) : null, lang,
    }));
  }

  async entity(entityId: number, lang: Lang): Promise<Record<string, unknown> | null> {
    const e = (await this.db.query(
      `SELECT id, kind, name, name_uk, description, attributes, wikidata_id, country, mention_count, doc_count, source_count,
              first_seen, last_seen, status, merged_into
       FROM kb.entities WHERE id = $1`,
      [entityId],
    ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows[0];
    if (!e) return null;
    if (e.status === 'merged' && e.merged_into) return this.entity(Number(e.merged_into), lang);
    const [identifiers, aliases, relations, facts, events] = await Promise.all([
      this.db.query('SELECT scheme, value FROM kb.entity_identifiers WHERE entity_id = $1 ORDER BY scheme', [entityId]),
      this.db.query('SELECT alias FROM kb.entity_aliases WHERE entity_id = $1 AND NOT ambiguous ORDER BY weight DESC, length(alias) LIMIT 12', [entityId]),
      this.db.query(
        `SELECT CASE WHEN r.from_entity_id = $1 THEN r.to_entity_id ELSE r.from_entity_id END AS other_id,
                (r.from_entity_id = $1) AS outgoing, r.relation, r.origin, r.weight, o.name, o.name_uk, o.kind
         FROM kb.entity_relations r JOIN kb.entities o ON o.id = CASE WHEN r.from_entity_id = $1 THEN r.to_entity_id ELSE r.from_entity_id END
         WHERE (r.from_entity_id = $1 OR r.to_entity_id = $1) AND o.status = 'active'
         ORDER BY (r.origin = 'fact') DESC, r.weight DESC LIMIT 25`,
        [entityId],
      ),
      this.db.query(
        `SELECT f.id, f.predicate, f.object_text, f.value_num, f.value_unit, f.status, f.source_count, f.valid_from, f.object_key,
                f.first_event_id, s.id AS sid, COALESCE(s.name_uk, s.name) AS sname_uk, s.name AS sname,
                o.id AS oid, COALESCE(o.name_uk, o.name) AS oname_uk, o.name AS oname, '{}'::bigint[] AS doc_ids
         FROM kb.facts f JOIN kb.entities s ON s.id = f.subject_entity_id LEFT JOIN kb.entities o ON o.id = f.object_entity_id
         WHERE (f.subject_entity_id = $1 OR f.object_entity_id = $1) AND f.object_key NOT LIKE 'PLAN|%'
         ORDER BY f.last_seen DESC LIMIT 30`,
        [entityId],
      ),
      this.db.query(
        `SELECT e.id, e.title, e.started_at, e.article_news_id, e.editorial_state, e.independent_source_count, ee.weight
         FROM kb.event_entities ee JOIN kb.events e ON e.id = ee.event_id
         WHERE ee.entity_id = $1 AND e.status <> 'merged' AND ee.weight >= 0.25
         ORDER BY e.started_at DESC LIMIT 30`,
        [entityId],
      ),
    ]);
    const uk = lang === 'uk';
    return {
      entity: {
        id: Number(e.id), kind: e.kind, name: uk ? e.name_uk || e.name : e.name, nameOther: uk ? e.name : e.name_uk,
        description: uk ? e.attributes?.description_uk || e.description : e.description || e.attributes?.description_uk,
        wikidataId: e.wikidata_id, country: e.country, mentions: Number(e.mention_count), documents: Number(e.doc_count),
        sources: Number(e.source_count), firstSeen: iso(e.first_seen), lastSeen: iso(e.last_seen),
      },
      identifiers: identifiers.rows,
      aliases: aliases.rows.map((a) => a.alias),
      relations: relations.rows.map((r) => ({
        entityId: Number(r.other_id), name: uk ? r.name_uk || r.name : r.name, kind: r.kind, outgoing: r.outgoing,
        relation: r.relation, label: r.relation === 'co_mentioned' ? (uk ? 'часто разом у новинах' : 'often in the same news') : label(PREDICATE_LABELS, r.relation, lang),
        origin: r.origin, weight: Number(r.weight),
      })),
      facts: facts.rows.map((f) => ({
        id: Number(f.id), text: factSentence(
          { ref: '', factId: Number(f.id), subject: f.sid ? { id: Number(f.sid), name: uk ? f.sname_uk : f.sname } : null, predicate: f.predicate,
            object: f.oid ? { id: Number(f.oid), name: uk ? f.oname_uk : f.oname } : null, objectText: f.object_text,
            value: f.value_num === null ? null : Number(f.value_num), unit: f.value_unit, status: f.status, roots: Number(f.source_count),
            validFrom: iso(f.valid_from), negated: String(f.object_key).startsWith('NOT|'), planned: false, docRefs: [] }, lang),
        status: f.status, statusLabel: label(FACT_STATUS_LABELS, f.status, lang), roots: Number(f.source_count),
        date: iso(f.valid_from), eventId: f.first_event_id ? Number(f.first_event_id) : null,
      })),
      events: events.rows.map((r) => ({
        eventId: Number(r.id), title: r.title, date: iso(r.started_at), newsId: r.article_news_id ? Number(r.article_news_id) : null,
        state: r.editorial_state, independentSources: Number(r.independent_source_count),
      })),
    };
  }

  async storyline(id: number, lang: Lang) {
    const sl = (await this.db.query('SELECT id, title, category, first_at, last_at, event_count FROM kb.storylines WHERE id = $1', [id])
      .catch(() => ({ rows: [] as Record<string, any>[] }))).rows[0];
    if (!sl) return null;
    const events = (await this.db.query(
      `SELECT id, title, summary, started_at, article_news_id, independent_source_count, event_type
       FROM kb.events WHERE storyline_id = $1 AND status <> 'merged' ORDER BY started_at`,
      [id],
    )).rows;
    return {
      id: Number(sl.id), title: sl.title, category: sl.category, firstAt: iso(sl.first_at), lastAt: iso(sl.last_at), lang,
      events: events.map((e) => ({
        eventId: Number(e.id), title: e.title, summary: e.summary, date: iso(e.started_at), eventType: e.event_type,
        newsId: e.article_news_id ? Number(e.article_news_id) : null, independentSources: Number(e.independent_source_count),
      })),
    };
  }
}

export function shapeEvent(d: EventDossier, lang: Lang) {
  const uk = lang === 'uk';
  const ev = d.event;
  return {
    event: { ...ev },
    datasets: d.docs.filter((doc) => doc.data).map((doc) => ({ ref: doc.ref, ...doc.data })),
    badge: uk
      ? `Підтверджено ${ev.independentSources} незалежними джерелами`
      : `Confirmed by ${ev.independentSources} independent sources`,
    sources: d.docs.map((doc) => ({
      name: doc.sourceName, title: doc.title, url: doc.url, tier: doc.tier, tierLabel: label(TIER_LABELS, doc.tier, lang),
      publishedAt: doc.publishedAt, role: doc.role, cites: doc.evidenceRoot, teaser: doc.extraction !== 'full' && doc.extraction !== 'partial',
    })),
    facts: d.facts.map((f) => ({
      id: f.factId, text: factSentence(f, lang), predicate: f.predicate, status: f.status, statusLabel: label(FACT_STATUS_LABELS, f.status, lang),
      roots: f.roots, value: f.value, unit: f.unit, date: f.validFrom,
      subject: f.subject, object: f.object,
    })),
    contradictions: d.contradictions,
    quotes: d.quotes.map((q) => ({ speaker: q.speaker, text: q.sentence, source: d.docs.find((x) => x.ref === q.docRef)?.sourceName ?? null })),
    participants: d.entities.map((e) => ({
      id: e.id, name: uk ? e.nameUk || e.name : e.name, kind: e.kind,
      description: uk ? e.descriptionUk || e.description : e.description || e.descriptionUk,
    })),
    earlier: d.linked.filter((l) => l.direction === 'earlier').map((l) => linkShape(l, lang)),
    later: d.linked.filter((l) => l.direction === 'later').map((l) => linkShape(l, lang)),
    storyline: d.storyline
      ? { id: d.storyline.id, title: d.storyline.title, events: d.storyline.events.map((e) => ({ ...e, date: e.startedAt })) }
      : null,
    background: d.background.map((b) => ({ text: factSentence(b, lang), status: b.status, statusLabel: label(FACT_STATUS_LABELS, b.status, lang), date: b.validFrom })),
  };
}

function linkShape(l: EventDossier['linked'][number], lang: Lang) {
  return {
    eventId: l.eventId, title: l.title, date: l.startedAt, linkType: l.linkType, linkLabel: label(LINK_LABELS, l.linkType, lang),
    newsId: l.newsId, sources: l.sources, score: l.score,
  };
}
