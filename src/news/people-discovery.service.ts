/**
 * Authors and experts discovered from evidence, not invented by a model:
 *   - AUTHORS: bylines of articles our collector extracted (kb.documents.author), per outlet, with article counts;
 *   - EXPERTS: people who are quoted ("state"/"deny" claims) in several different events, with the topics of those events,
 *              their entity description and Wikidata id when the knowledge base has them.
 * Every row keeps its evidence (counts, sample events/articles) and status 'auto' until someone confirms or hides it.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export function nameKey(name: string): string {
  return name.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const NOT_A_PERSON = /(staff|editor(s)?\b|редакці|редактор|team|desk|admin|agency|агентств|news\b|новини|press|прес|reuters|associated|afp|bloomberg|контент|content|wire|bureau|корреспондент|кореспондент|correspondents?|\.com|\.ua|\.org|@|\d)/i;

/** A plausible human byline: 2-4 capitalised words, no organisation words, no digits. */
export function looksLikePersonName(name: string): boolean {
  const n = name.trim().replace(/^by\s+/i, '').replace(/^від\s+/i, '');
  if (n.length < 2 || n.length > 60 || NOT_A_PERSON.test(n)) return false;
  const words = n.split(/\s+/);
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(n) && (n.length < 5 || words.length < 2 || words.length > 4)) return false;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(n)) return n.length >= 2 && n.length <= 12 && !/\d/.test(n); // uncased scripts have no capitals
  return words.every((w) => /^[\p{Lu}][\p{L}'’.-]+$/u.test(w) || /^(de|van|von|der|di|da|el|al|bin|ibn|le|la)$/i.test(w));
}

@Injectable()
export class PeopleDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PeopleDiscoveryService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.PEOPLE_DISCOVERY === 'false') return;
    this.timer = setTimeout(() => void this.loop(), 300_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      const r = await this.runOnce();
      this.logger.log(`People discovery: ${JSON.stringify(r)}`);
    } catch (err) {
      this.logger.warn(`people discovery failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), Number(process.env.PEOPLE_DISCOVERY_INTERVAL_MS) || 6 * 3_600_000);
    }
  }

  async runOnce(): Promise<{ authors: number; experts: number }> {
    return { authors: await this.authors(), experts: await this.experts() };
  }

  async authors(): Promise<number> {
    const minArticles = Number(process.env.PEOPLE_MIN_ARTICLES) || 3;
    const rows = (
      await this.db.query(
        `SELECT d.author, s.slug, s.name AS source_name, s.country, count(*) AS n, max(d.published_at) AS last_at,
                (array_agg(d.url ORDER BY d.published_at DESC))[1:3] AS samples
         FROM kb.documents d JOIN public.sources s ON s.id = d.source_id
         WHERE d.author IS NOT NULL AND d.published_at > now() - interval '90 days'
         GROUP BY d.author, s.slug, s.name, s.country
         HAVING count(*) >= $1
         ORDER BY count(*) DESC LIMIT 800`,
        [minArticles],
      )
    ).rows;
    let saved = 0;
    for (const r of rows) {
      const name = String(r.author).replace(/^by\s+/i, '').replace(/^від\s+/i, '').trim();
      if (!looksLikePersonName(name)) continue;
      await this.db.query(
        `INSERT INTO discovered_people (kind, name, name_key, affiliation, source_slug, country, mentions, evidence, confidence, last_seen)
         VALUES ('author', $1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
         ON CONFLICT (kind, name_key, source_slug) DO UPDATE SET mentions = EXCLUDED.mentions, evidence = EXCLUDED.evidence,
           confidence = EXCLUDED.confidence, last_seen = now()`,
        [name, nameKey(name), r.source_name, r.slug, r.country ?? null, Number(r.n), JSON.stringify({ articles: Number(r.n), last_published: r.last_at, samples: r.samples }), Math.min(0.95, 0.4 + Number(r.n) / 40)],
      );
      saved += 1;
    }
    return saved;
  }

  async experts(): Promise<number> {
    const minEvents = Number(process.env.PEOPLE_MIN_EVENTS) || 2;
    const rows = (
      await this.db
        .query(
          `SELECT en.id, en.name, en.name_uk, en.description, en.wikidata_id,
                  count(DISTINCT c.event_id) AS events, count(DISTINCT c.document_id) AS docs,
                  array_remove(array_agg(DISTINCT ev.category), NULL) AS cats,
                  (array_agg(DISTINCT c.event_id))[1:5] AS sample_events
           FROM kb.claims c
           JOIN kb.entities en ON en.id = c.subject_entity_id AND en.kind = 'person'
           JOIN kb.events ev ON ev.id = c.event_id
           WHERE c.predicate IN ('state', 'deny') AND c.event_id IS NOT NULL
           GROUP BY en.id
           HAVING count(DISTINCT c.event_id) >= $1
           ORDER BY count(DISTINCT c.event_id) DESC LIMIT 800`,
          [minEvents],
        )
        .catch(() => ({ rows: [] as Array<Record<string, any>> }))
    ).rows;
    let saved = 0;
    for (const r of rows) {
      const name = String(r.name);
      await this.db.query(
        `INSERT INTO discovered_people (kind, name, name_key, name_uk, source_slug, topics, description, wikidata_id, entity_id, mentions, events, evidence, confidence, last_seen)
         VALUES ($12, $1, $2, $3, '', $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now())
         ON CONFLICT (kind, name_key, source_slug) DO UPDATE SET topics = EXCLUDED.topics, description = EXCLUDED.description, entity_id = EXCLUDED.entity_id,
           wikidata_id = EXCLUDED.wikidata_id, mentions = EXCLUDED.mentions, events = EXCLUDED.events, evidence = EXCLUDED.evidence,
           confidence = EXCLUDED.confidence, last_seen = now()`,
        [name, nameKey(name), r.name_uk ?? null, r.cats ?? [], r.description ?? null, r.wikidata_id ?? null, Number(r.id), Number(r.docs), Number(r.events),
          JSON.stringify({ quoted_in_events: Number(r.events), quoted_in_documents: Number(r.docs), sample_events: r.sample_events }), Math.min(0.95, 0.35 + Number(r.events) / 20 + (r.wikidata_id ? 0.2 : 0)), r.description || r.wikidata_id ? 'expert' : 'quoted'],
      );
      saved += 1;
    }
    return saved;
  }
}
