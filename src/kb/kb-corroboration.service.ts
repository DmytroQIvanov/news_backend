/**
 * Automatic corroboration of thin events.
 *
 *   1. SEARCH   an event with fewer independent sources than KB_READY_MIN_SOURCES is sent to a cheap search model
 *               (Google Search grounding) that looks for independent reports of the SAME event.
 *   2. FILTER   URLs are resolved, must be https, must not be social media / aggregators / the same outlet we already
 *               have; our own collector then fetches and extracts the pages (robots.txt, quality status).
 *   3. VET      every fetched page is judged by a second AI pass against the extracted text: is it really the same
 *               event, what kind of source is it, how reliable, is it independent of the sources we already have.
 *               Only accepted pages become sources of the article (kb-dossier.ts adds them as extra documents).
 * Pages are never added "for the sake of sources": at most KB_CORROBORATE_MAX_ACCEPTED per event, each with a stored
 * verdict (kb.event_research.verdict) that explains the decision.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { remainingLlmCalls } from '../common/llm-budget';
import { DatabaseService } from '../database/database.service';
import { DISALLOWED_DISCOVERY_ROOTS } from '../news/source-discovery.service';
import { buildDossier } from './kb-dossier';
import { isKbEditorialActive } from './kb-editorial.service';
import { geminiJson, geminiSearch, JsonLlm, models, resolveRedirect, SearchLlm } from './kb-llm';

function envInt(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

export const ACCEPTED_SOURCE_TYPES = new Set([
  'news_agency', 'national_outlet', 'regional_outlet', 'official', 'primary_document', 'specialist_press', 'international_org',
]);

export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    same_event: { type: 'boolean' },
    match_confidence: { type: 'number' },
    on_topic: { type: 'boolean' },
    source_type: {
      type: 'string',
      enum: ['news_agency', 'national_outlet', 'regional_outlet', 'official', 'primary_document', 'specialist_press',
        'international_org', 'aggregator', 'blog', 'opinion', 'press_release_mill', 'forum_social', 'unknown'],
    },
    reliability: { type: 'string', enum: ['high', 'medium', 'low'] },
    independent: { type: 'boolean' },
    adds_information: { type: 'boolean' },
    country: { type: 'string' },
    language: { type: 'string' },
    characterization: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['same_event', 'match_confidence', 'on_topic', 'source_type', 'reliability', 'independent', 'adds_information', 'characterization', 'reason'],
};

export interface Verdict {
  same_event: boolean;
  match_confidence: number;
  on_topic: boolean;
  source_type: string;
  reliability: string;
  independent: boolean;
  adds_information: boolean;
  country?: string;
  language?: string;
  characterization: string;
  reason: string;
}

/** Pure decision rule: a page is accepted only when every criterion holds. */
export function acceptVerdict(v: Verdict, minConfidence = 0.75): { accepted: boolean; why: string } {
  if (!v.same_event || !v.on_topic) return { accepted: false, why: 'not the same event' };
  if (!(Number(v.match_confidence) >= minConfidence)) return { accepted: false, why: 'low match confidence' };
  if (!ACCEPTED_SOURCE_TYPES.has(v.source_type)) return { accepted: false, why: `source type ${v.source_type}` };
  if (v.reliability === 'low') return { accepted: false, why: 'low reliability' };
  if (!v.independent) return { accepted: false, why: 'not independent (rewrite of a known source)' };
  if (!v.adds_information) return { accepted: false, why: 'adds nothing new' };
  return { accepted: true, why: 'ok' };
}

export function rootOf(url: string): string {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, '').split('.');
    const twoPart = ['co', 'com', 'org', 'gov', 'net'].includes(parts[parts.length - 2] ?? '') && parts.length >= 3;
    return parts.slice(twoPart ? -3 : -2).join('.');
  } catch {
    return '';
  }
}

const VET_SYSTEM = `You are a strict source editor for a news knowledge base. You judge whether a fetched web page is a good
additional source for one specific event. Be sceptical: reject aggregators, content farms, blogs, opinion pieces,
reposts and pages about a related but different event. Accept only pages that report the same event on their own (their
own reporting, an official statement, a primary document, a wire agency). Characterize the source honestly.`;

@Injectable()
export class KbCorroborationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbCorroborationService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running?: Promise<{ searched: number; vetted: number; accepted: number }>;
  llm: JsonLlm = geminiJson;
  search: SearchLlm = geminiSearch;
  resolve: (url: string) => Promise<string | null> = resolveRedirect;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.KB_CORROBORATE === 'false' || !process.env.GEMINI_API_KEY) return;
    this.timer = setTimeout(() => void this.loop(), 150_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`corroboration cycle failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), envInt('KB_CORROBORATE_INTERVAL_MS', 10 * 60_000, 60_000));
    }
  }

  runOnce(): Promise<{ searched: number; vetted: number; accepted: number }> {
    if (this.running) return this.running;
    this.running = this.cycle().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async cycle() {
    const out = { searched: 0, vetted: 0, accepted: 0 };
    if (!(await isKbEditorialActive(this.db))) return out;
    const vet = await this.vetPending(envInt('KB_CORROBORATE_VET_PER_CYCLE', 6, 1, 30));
    out.vetted = vet.vetted;
    out.accepted = vet.accepted;
    let calls = 0;
    for (const m of models('KB_CORROBORATE_MODELS', 'gemini-2.5-flash-lite,gemini-2.5-flash')) {
      calls += Math.min(1000, await remainingLlmCalls(m, 'kb_corroborate'));
    }
    if (calls > 0) {
      for (const eventId of await this.thinEvents(envInt('KB_CORROBORATE_PER_CYCLE', 2, 1, 10))) {
        if (this.stopped) break;
        try {
          await this.searchFor(eventId);
          out.searched += 1;
        } catch (err) {
          this.logger.warn(`corroboration search for event ${eventId}: ${err instanceof Error ? err.message : err}`);
          await this.db
            .query('UPDATE kb.events SET corroboration_at = now(), corroboration_attempts = corroboration_attempts + 1 WHERE id = $1', [eventId])
            .catch(() => undefined);
        }
      }
    }
    if (out.searched || out.vetted) this.logger.log(`KB corroboration: ${JSON.stringify(out)}`);
    return out;
  }

  /** Events still collecting, with 1..(min-1) independent sources, fresh, not tried recently. */
  async thinEvents(limit: number): Promise<number[]> {
    const min = envInt('KB_READY_MIN_SOURCES', 2, 2, 20);
    const minImportance = Number(process.env.KB_CORROBORATE_MIN_IMPORTANCE) || 0;
    const daily = envInt('KB_CORROBORATE_DAILY', 40, 0, 500);
    const today = Number(
      (await this.db.query(`SELECT count(*) AS n FROM kb.events WHERE corroboration_at > date_trunc('day', now())`)).rows[0]?.n ?? 0,
    );
    if (today >= daily) return [];
    const rows = (
      await this.db.query(
        `SELECT e.id FROM kb.events e
         WHERE e.status <> 'merged' AND e.editorial_state = 'collecting' AND e.article_news_id IS NULL
           AND e.independent_source_count >= 1 AND e.independent_source_count < $1
           AND e.last_seen_at > now() - interval '30 hours'
           AND e.corroboration_attempts < 2 AND (e.corroboration_at IS NULL OR e.corroboration_at < now() - interval '3 hours')
           AND e.importance >= $2
         ORDER BY e.importance DESC, e.last_seen_at DESC LIMIT $3`,
        [min, minImportance, Math.min(limit, daily - today)],
      )
    ).rows;
    return rows.map((r) => Number(r.id));
  }

  async searchFor(eventId: number) {
    const dossier = await buildDossier(this.db, eventId, { excerptChars: 500, maxDocs: 6 });
    if (!dossier) return;
    const seenRoots = new Set<string>(dossier.docs.map((d) => rootOf(d.url)).filter(Boolean));
    const known = [
      `EVENT: ${dossier.event.title} (${dossier.event.startedAt?.slice(0, 10) ?? ''})`,
      dossier.event.summary ? `SUMMARY: ${dossier.event.summary}` : '',
      `PARTICIPANTS: ${dossier.entities.slice(0, 8).map((e) => e.name).join(', ')}`,
      `ALREADY HAVE: ${dossier.docs.map((d) => `${d.sourceName}: ${d.title} (${d.url})`).join(' | ')}`,
    ].filter(Boolean).join('\n');
    const res = await this.search({
      models: models('KB_CORROBORATE_MODELS', 'gemini-2.5-flash-lite,gemini-2.5-flash'),
      purpose: 'kb_corroborate',
      timeoutMs: 120_000,
      prompt: `Find independent reports of EXACTLY this event from other reputable outlets, news agencies, official
websites or primary documents. Use only pages that report the event itself (not related background, not opinion, not
aggregator listings). Do not return outlets already listed under ALREADY HAVE. If nothing reliable exists, say so.\n\n${known}`,
    });
    const max = envInt('KB_CORROBORATE_MAX_PAGES', 5, 1, 12);
    let inserted = 0;
    for (const s of res.sources.slice(0, 12)) {
      if (inserted >= max) break;
      const url = await this.resolve(s.url);
      if (!url) continue;
      const root = rootOf(url);
      if (!root || DISALLOWED_DISCOVERY_ROOTS.has(root) || seenRoots.has(root)) continue;
      if (/\/(tag|category|topic|search|feed)\b|[?&](s|q)=/.test(url)) continue; // listing pages are not reports
      seenRoots.add(root);
      const canon = url.split('#')[0].replace(/\/+$/, '');
      const row = (
        await this.db
          .query<{ id: string }>(
            `INSERT INTO kb.documents (kind, url, canonical_url, title, stage, meta)
             VALUES ('research', $1, $2, $3, 'new', $4::jsonb)
             ON CONFLICT (canonical_url) DO UPDATE SET canonical_url = EXCLUDED.canonical_url RETURNING id`,
            [url, canon, (s.title || url).slice(0, 500), JSON.stringify({ research_for_event: eventId, query: 'corroboration' })],
          )
          .catch(() => ({ rows: [] as Array<{ id: string }> }))
      ).rows[0];
      if (!row) continue;
      await this.db.query(
        `INSERT INTO kb.event_research (event_id, document_id, query) VALUES ($1, $2, 'corroboration') ON CONFLICT DO NOTHING`,
        [eventId, row.id],
      );
      inserted += 1;
    }
    await this.db.query('UPDATE kb.events SET corroboration_at = now(), corroboration_attempts = corroboration_attempts + 1 WHERE id = $1', [eventId]);
    this.logger.debug(`event ${eventId}: ${inserted} candidate pages queued for vetting`);
  }

  /** Vet pages the collector has extracted (or gave up on). */
  async vetPending(limit: number): Promise<{ vetted: number; accepted: number }> {
    const rows = (
      await this.db.query(
        `SELECT r.event_id, r.document_id, d.url, d.title, d.lang, d.extraction_status, d.published_at,
                left(COALESCE(d.body, ''), 4500) AS excerpt, r.added_at
         FROM kb.event_research r JOIN kb.documents d ON d.id = r.document_id
         WHERE r.query = 'corroboration' AND r.accepted IS NULL
           AND (d.extraction_status IN ('full', 'partial', 'failed', 'blocked', 'empty') OR r.added_at < now() - interval '90 minutes')
         ORDER BY r.added_at LIMIT $1`,
        [limit],
      )
    ).rows;
    let vetted = 0;
    let accepted = 0;
    const maxAccepted = envInt('KB_CORROBORATE_MAX_ACCEPTED', 4, 1, 12);
    for (const r of rows) {
      if (this.stopped) break;
      const eventId = Number(r.event_id);
      const docId = Number(r.document_id);
      const text = String(r.excerpt || '').trim();
      if (!['full', 'partial'].includes(r.extraction_status) || text.length < 400) {
        await this.save(eventId, docId, false, { reason: 'page could not be extracted or is too short' });
        vetted += 1;
        continue;
      }
      const have = (
        await this.db.query(`SELECT count(*) AS n FROM kb.event_research WHERE event_id = $1 AND accepted = true AND query = 'corroboration'`, [eventId])
      ).rows[0];
      if (Number(have?.n ?? 0) >= maxAccepted) {
        await this.save(eventId, docId, false, { reason: 'enough accepted sources already' });
        vetted += 1;
        continue;
      }
      const dossier = await buildDossier(this.db, eventId, { excerptChars: 500, maxDocs: 6 });
      if (!dossier) continue;
      try {
        const res = await this.llm({
          models: models('KB_CORROBORATE_VET_MODELS', 'gemini-3.1-flash-lite,gemini-2.5-flash-lite'),
          system: VET_SYSTEM,
          schema: VERDICT_SCHEMA,
          maxOutputTokens: 1200,
          purpose: 'kb_corroborate',
          timeoutMs: 90_000,
          temperature: 0.1,
          prompt: `EVENT: ${dossier.event.title} (${dossier.event.startedAt?.slice(0, 10) ?? ''})
SUMMARY: ${dossier.event.summary ?? ''}
PARTICIPANTS: ${dossier.entities.slice(0, 8).map((e) => e.name).join(', ')}
KNOWN SOURCES: ${dossier.docs.map((d) => `${d.sourceName}: ${d.title}`).join(' | ')}

CANDIDATE PAGE
URL: ${r.url}
TITLE: ${r.title}
PUBLISHED: ${r.published_at ?? 'unknown'}
TEXT:
${text}`,
        });
        const v = res.json as Verdict;
        const decision = acceptVerdict(v, Number(process.env.KB_CORROBORATE_MIN_CONFIDENCE) || 0.75);
        await this.save(eventId, docId, decision.accepted, { ...v, decision: decision.why, model: res.model, root: rootOf(r.url) });
        vetted += 1;
        if (decision.accepted) accepted += 1;
      } catch (err) {
        this.logger.warn(`vetting document ${docId}: ${err instanceof Error ? err.message : err}`);
        break; // quota or outage: try again next cycle, never accept unvetted pages
      }
    }
    return { vetted, accepted };
  }

  private async save(eventId: number, docId: number, accepted: boolean, verdict: Record<string, unknown>) {
    await this.db.query(`UPDATE kb.event_research SET accepted = $3, verdict = $4::jsonb WHERE event_id = $1 AND document_id = $2`, [
      eventId,
      docId,
      accepted,
      JSON.stringify(verdict),
    ]);
  }
}
