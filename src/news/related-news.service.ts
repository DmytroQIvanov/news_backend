/**
 * "Related news" that is actually related. Old behaviour: every article of the same category or outlet. New behaviour:
 *   1. knowledge-base links between events (follow-up, precedent, reaction, cause, contradiction, same storyline);
 *   2. other events of the same storyline;
 *   3. events that share the strongest participants (weighted entity overlap, recent);
 *   4. semantic neighbours (event embeddings), when the optional vector tables exist;
 *   5. for articles without an event: strong title similarity inside a short window — never "same category".
 * Candidates are scored, de-duplicated per storyline and per outlet, labelled with WHY they are related, and must pass the
 * same publication eligibility as the feed.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { NEWS_ELIGIBILITY_SQL } from './eligibility';

export type RelationKind = 'follow_up' | 'precedent' | 'reaction' | 'cause' | 'contradicts' | 'storyline' | 'participant' | 'similar';

export interface Candidate {
  newsId: string;
  eventId: number | null;
  storylineId: number | null;
  sourceSlug: string;
  publishedAt: number;
  kind: RelationKind;
  /** Raw strength before the shared adjustments (0..~4). */
  base: number;
  detail?: string;
}

const KIND_WEIGHT: Record<RelationKind, number> = { follow_up: 1.3, precedent: 1.0, reaction: 1.15, cause: 1.2, contradicts: 1.25, storyline: 1.0, participant: 0.8, similar: 0.7 };

/** Pure ranking so it can be tested without a database. Higher is better. */
export function scoreCandidate(c: Candidate, now = Date.now()): number {
  const ageDays = Math.max(0, (now - c.publishedAt) / 86_400_000);
  const recency = Math.exp(-ageDays / (c.kind === 'precedent' ? 120 : 20)); // precedents may be old, news decays fast
  return c.base * KIND_WEIGHT[c.kind] * (0.35 + 0.65 * recency);
}

/** Keeps the best candidate per news item, then at most `perSource` per outlet and one per storyline unless it is an explicit link. */
export function selectRelated(cands: Candidate[], limit = 6, perSource = 2, now = Date.now()): Candidate[] {
  const best = new Map<string, Candidate & { score: number }>();
  for (const c of cands) {
    const score = scoreCandidate(c, now);
    const cur = best.get(c.newsId);
    if (!cur || score > cur.score) best.set(c.newsId, { ...c, score });
  }
  const ordered = [...best.values()].sort((a, b) => b.score - a.score);
  const bySource = new Map<string, number>();
  const storylines = new Set<number>();
  const out: Candidate[] = [];
  for (const c of ordered) {
    const explicit = ['follow_up', 'precedent', 'reaction', 'cause', 'contradicts'].includes(c.kind);
    if (!explicit && c.storylineId !== null && storylines.has(c.storylineId)) continue;
    if ((bySource.get(c.sourceSlug) ?? 0) >= perSource) continue;
    bySource.set(c.sourceSlug, (bySource.get(c.sourceSlug) ?? 0) + 1);
    if (c.storylineId !== null) storylines.add(c.storylineId);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Pipeline links point from the newer event to the older one (follow_up, reaction_to) and from cause to effect (causes).
 * `incoming` = the link ends at the article being read, so the other event is the later one (or the effect's source).
 */
export function directedKind(linkType: string, incoming: boolean): RelationKind {
  switch (linkType) {
    case 'follow_up': return incoming ? 'follow_up' : 'precedent';
    case 'reaction_to': return incoming ? 'reaction' : 'precedent';
    case 'causes': return incoming ? 'cause' : 'follow_up';
    case 'precedent': return 'precedent';
    case 'contradicts': return 'contradicts';
    case 'same_storyline': return 'storyline';
    default: return 'precedent';
  }
}

const LINK_KIND: Record<string, RelationKind> = {
  same_storyline: 'storyline', follow_up: 'follow_up', precedent: 'precedent', reaction_to: 'reaction', causes: 'cause', contradicts: 'contradicts', context: 'precedent',
};

@Injectable()
export class RelatedNewsService {
  private readonly logger = new Logger(RelatedNewsService.name);

  constructor(private readonly db: DatabaseService) {}

  async related(id: string, limit = 6) {
    const target = (await this.db.query(
      `SELECT n.id, n.kb_event_id, n.category, n.original_title, n.title_uk, s.slug AS source_slug
       FROM news_items n JOIN sources s ON s.id = n.source_id
       WHERE (n.external_id = $1 OR n.id::text = $1) AND n.status = 'published' LIMIT 1`, [id],
    )).rows[0];
    if (!target) return { items: [] };
    const cands: Candidate[] = [];
    if (target.kb_event_id) cands.push(...(await this.fromEvent(Number(target.kb_event_id), String(target.id))));
    let chosen = selectRelated(cands, limit);
    // shortage is judged AFTER diversity selection (twenty candidates of one storyline still yield one result)
    if (chosen.length < limit) {
      cands.push(...(await this.fromTitle(String(target.id), String(target.original_title || target.title_uk || ''), target.category)));
      chosen = selectRelated(cands, limit);
    }
    if (!chosen.length) return { items: [] };
    const rows = (await this.db.query(
      `SELECT n.id, n.url, n.title_uk, n.summary_uk, n.original_title, n.category, n.importance, n.published_at,
              COALESCE(n.ai_metadata->'article'->'important' = 'true'::jsonb, false) AS important,
              s.name AS source_name, s.slug AS source_slug
       FROM news_items n JOIN sources s ON s.id = n.source_id
       WHERE n.id = ANY($1::bigint[]) AND ${NEWS_ELIGIBILITY_SQL}`, [chosen.map((c) => c.newsId)],
    )).rows;
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    return {
      items: chosen.flatMap((c) => {
        const row = byId.get(c.newsId);
        return row ? [{ ...row, relation: c.kind, relation_detail: c.detail ?? null }] : [];
      }),
    };
  }

  /** Candidates connected to the article's knowledge-base event. */
  private async fromEvent(eventId: number, selfId: string): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const base = `
      SELECT n.id::text AS news_id, e.id AS event_id, e.storyline_id, s.slug, COALESCE(n.published_at, n.created_at) AS at`;
    const join = `
      FROM kb.events e JOIN news_items n ON n.id = COALESCE(e.article_news_id, (SELECT min(x.id) FROM news_items x WHERE x.kb_event_id = e.id AND x.status = 'published')) JOIN sources s ON s.id = n.source_id`;
    const links = await this.db.query(
      `${base}, l.link_type, l.score, (l.to_event_id = $1) AS incoming, l.verified ${join}
       JOIN kb.event_links l ON (l.from_event_id = $1 AND l.to_event_id = e.id) OR (l.to_event_id = $1 AND l.from_event_id = e.id)
       WHERE e.status <> 'merged' AND n.id::text <> $2 AND ${NEWS_ELIGIBILITY_SQL}
         AND COALESCE(l.verdict->>'supported', 'true') <> 'false'
       ORDER BY l.verified DESC, l.score DESC LIMIT 40`, [eventId, selfId],
    ).catch(() => ({ rows: [] as Array<Record<string, any>> }));
    for (const r of links.rows) {
      out.push({
        newsId: r.news_id, eventId: Number(r.event_id), storylineId: r.storyline_id ? Number(r.storyline_id) : null, sourceSlug: r.slug, publishedAt: new Date(r.at).getTime(),
        kind: directedKind(r.link_type, Boolean(r.incoming)), base: 1.2 + Number(r.score) * 2 + (r.verified ? 0.6 : 0), detail: r.incoming ? 'later' : 'earlier',
      });
    }
    const story = await this.db.query(
      `${base} ${join}
       WHERE e.status <> 'merged' AND e.storyline_id = (SELECT storyline_id FROM kb.events WHERE id = $1) AND e.storyline_id IS NOT NULL
         AND e.id <> $1 AND n.id::text <> $2 AND ${NEWS_ELIGIBILITY_SQL} ORDER BY at DESC LIMIT 20`, [eventId, selfId],
    ).catch(() => ({ rows: [] as Array<Record<string, any>> }));
    for (const r of story.rows) {
      out.push({ newsId: r.news_id, eventId: Number(r.event_id), storylineId: Number(r.storyline_id), sourceSlug: r.slug, publishedAt: new Date(r.at).getTime(), kind: 'storyline', base: 2.0 });
    }
    // shared participants, weighted; only the strongest participants of this event count
    const shared = await this.db.query(
      `WITH mine AS (SELECT entity_id, weight FROM kb.event_entities WHERE event_id = $1 ORDER BY weight DESC LIMIT 6)
       ${base}, sum(m.weight * x.weight) AS overlap, count(*) AS shared, (array_agg(en.name ORDER BY x.weight DESC))[1] AS top_name
       ${join}
       JOIN kb.event_entities x ON x.event_id = e.id JOIN mine m ON m.entity_id = x.entity_id JOIN kb.entities en ON en.id = x.entity_id
       WHERE e.status <> 'merged' AND e.id <> $1 AND n.id::text <> $2 AND COALESCE(n.published_at, n.created_at) > now() - interval '45 days' AND ${NEWS_ELIGIBILITY_SQL}
       GROUP BY n.id, e.id, s.slug, n.published_at, n.created_at HAVING count(*) >= 2
       ORDER BY overlap DESC LIMIT 25`, [eventId, selfId],
    ).catch(() => ({ rows: [] as Array<Record<string, any>> }));
    for (const r of shared.rows) {
      out.push({ newsId: r.news_id, eventId: Number(r.event_id), storylineId: r.storyline_id ? Number(r.storyline_id) : null, sourceSlug: r.slug, publishedAt: new Date(r.at).getTime(),
        kind: 'participant', base: Math.min(2.2, 0.8 + Number(r.shared) * 0.35 + Number(r.overlap)), detail: r.top_name });
    }
    const near = await this.db.query(
      `${base}, 1 - (ee.centroid <=> me.centroid) AS sim ${join}
       JOIN kb.event_embeddings ee ON ee.event_id = e.id, kb.event_embeddings me
       WHERE me.event_id = $1 AND e.id <> $1 AND e.status <> 'merged' AND n.id::text <> $2 AND ${NEWS_ELIGIBILITY_SQL}
         AND 1 - (ee.centroid <=> me.centroid) >= 0.62 ORDER BY ee.centroid <=> me.centroid LIMIT 15`, [eventId, selfId],
    ).catch(() => ({ rows: [] as Array<Record<string, any>> })); // vector tables are optional
    for (const r of near.rows) {
      out.push({ newsId: r.news_id, eventId: Number(r.event_id), storylineId: r.storyline_id ? Number(r.storyline_id) : null, sourceSlug: r.slug, publishedAt: new Date(r.at).getTime(), kind: 'similar', base: 1.2 + (Number(r.sim) - 0.62) * 4 });
    }
    return out;
  }

  /** Articles without a knowledge-base event: close titles in a two-week window, never "same category". */
  private async fromTitle(selfId: string, title: string, category: string | null): Promise<Candidate[]> {
    if (title.trim().length < 12) return [];
    const rows = (await this.db.query(
      `SELECT n.id::text AS news_id, n.kb_event_id AS event_id, s.slug, COALESCE(n.published_at, n.created_at) AS at,
              greatest(similarity(COALESCE(n.title_uk, ''), $2), similarity(n.original_title, $2)) AS sim
       FROM news_items n JOIN sources s ON s.id = n.source_id
       WHERE n.id::text <> $1 AND ${NEWS_ELIGIBILITY_SQL} AND COALESCE(n.published_at, n.created_at) > now() - interval '14 days'
         AND ($3::text IS NULL OR n.category = $3)
         AND greatest(similarity(COALESCE(n.title_uk, ''), $2), similarity(n.original_title, $2)) >= 0.32
       ORDER BY sim DESC LIMIT 12`, [selfId, title, category],
    ).catch((err) => {
      this.logger.debug(`title similarity unavailable: ${err instanceof Error ? err.message : err}`);
      return { rows: [] as Array<Record<string, any>> };
    })).rows;
    return rows.map((r): Candidate => ({ newsId: r.news_id, eventId: r.event_id ? Number(r.event_id) : null, storylineId: null, sourceSlug: r.slug, publishedAt: new Date(r.at).getTime(), kind: 'similar', base: 1 + Number(r.sim) * 3 }));
  }
}
