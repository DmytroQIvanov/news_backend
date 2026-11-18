/**
 * Experts for a heavy model: people the knowledge base already quoted (discovered_people kind 'expert') who are participants
 * of the event, or who were quoted on the same topic recently, with a few of their earlier statements and the event each came from.
 * Everything is evidence from our own corpus; nothing is generated.
 */
import { DatabaseService } from '../database/database.service';
import { EventDossier } from './kb-dossier';

export async function expertsForEvent(db: DatabaseService, d: EventDossier, limit = 8): Promise<string> {
  const entityIds = d.entities.map((e) => e.id).filter(Boolean);
  const category = d.event.category ?? null;
  const people = (
    await db.query(
      `SELECT p.entity_id, p.name, p.name_uk, p.description, p.events, p.topics, p.wikidata_id,
              (p.entity_id = ANY($1::bigint[])) AS participant
       FROM discovered_people p
       WHERE p.kind = 'expert' AND p.status <> 'hidden' AND p.entity_id IS NOT NULL
         AND (p.entity_id = ANY($1::bigint[]) OR ($2::text IS NOT NULL AND $2 = ANY(p.topics)))
       ORDER BY (p.entity_id = ANY($1::bigint[])) DESC, p.events DESC LIMIT $3`,
      [entityIds, category, limit],
    )
  ).rows;
  if (!people.length) return '';
  const lines: string[] = [];
  let n = 0;
  for (const p of people) {
    n += 1;
    const quotes = (
      await db.query(
        `SELECT c.sentence, ev.title, ev.started_at
         FROM kb.claims c JOIN kb.events ev ON ev.id = c.event_id
         WHERE c.subject_entity_id = $1 AND c.predicate IN ('state', 'deny') AND c.event_id <> $2
         ORDER BY ev.started_at DESC NULLS LAST LIMIT 2`,
        [p.entity_id, d.event.id],
      )
    ).rows;
    const head = `[X${n}] ${p.name_uk || p.name}${p.name_uk ? ` / ${p.name}` : ''}${p.description ? ` — ${String(p.description).slice(0, 160)}` : ''} (quoted in ${p.events} events${p.participant ? '; participant of this event' : `; topic ${category}`}${p.wikidata_id ? `; ${p.wikidata_id}` : ''})`;
    lines.push(head);
    for (const q of quotes) lines.push(`    earlier (${q.started_at ? new Date(q.started_at).toISOString().slice(0, 10) : '?'}, "${String(q.title).slice(0, 80)}"): ${String(q.sentence).slice(0, 260)}`);
  }
  return lines.join('\n');
}
