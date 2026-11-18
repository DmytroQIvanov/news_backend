/**
 * Task 4: flagship long-reads — 5-10 per day, marked, for the site where depth is critical.
 *
 *   1. KNOWLEDGE BASE (SQL, free): full dossier (long excerpts, up to 16 sources) + deep history (kb-history.ts:
 *      3-hop chain of earlier events, precedents with the same actors, actor timelines).
 *   2. WEB RESEARCH (cheap model + our collector): a cheap Gemini model with Google Search looks for background,
 *      official documents, data and other perspectives; the URLs it found are fetched and extracted by OUR collector
 *      (trafilatura, robots.txt, quality status) — the model's own notes are only leads, never cited. The flagship
 *      waits (up to KB_FLAGSHIP_RESEARCH_WAIT_MIN) until the pages are extracted.
 *   3. ONE HYDROGEN CALL: plan + verdicts on the algorithmic links + the English long-read itself.
 *   4. CHECK: a cheap fact-checker compares the text with the material; a Flash pass fixes what it flagged; then the
 *      same algorithmic checks as every article (real sources, numbers from the material, known references).
 *   5. Publish (a standard article of the same event is upgraded in place); KbTranslationService translates it;
 *      the media worker adds section images (Commons / Pexels) and charts.
 * If Hydrogen's daily quota is used up, flagships wait for the next day instead of being written by a weaker model
 * (KB_FLAGSHIP_MODELS can add a fallback deliberately).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DEFAULT_HYDROGEN_MODEL } from '../common/gemini-client';
import { remainingLlmCalls } from '../common/llm-budget';
import { DatabaseService } from '../database/database.service';
import { buildDossier, DossierDoc, EventDossier, renderDossier } from './kb-dossier';
import { ARTICLE_SCHEMA, Candidate, GeneratedArticle, isKbEditorialActive, KbEditorialService, RULES } from './kb-editorial.service';
import { buildHistory, EventHistory, renderHistory } from './kb-history';
import { geminiJson, geminiSearch, JsonLlm, models, resolveRedirect, SearchLlm } from './kb-llm';

function envInt(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

const ARTICLE_ITEM = (ARTICLE_SCHEMA.properties.articles as { items: Record<string, unknown> }).items;

const FLAGSHIP_SCHEMA = {
  type: 'object',
  properties: {
    plan: {
      type: 'object',
      properties: {
        thesis: { type: 'string' },
        angle: { type: 'string' },
        why_now: { type: 'string' },
        causal_chain: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from_ref: { type: 'string' }, to_ref: { type: 'string' },
              relation: { type: 'string', enum: ['caused', 'enabled', 'response_to', 'followed', 'context'] },
              evidence_ref: { type: 'string' }, stated_by_source: { type: 'boolean' },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, explanation: { type: 'string' },
            },
            required: ['from_ref', 'to_ref', 'relation', 'evidence_ref', 'stated_by_source', 'confidence', 'explanation'],
          },
        },
        link_verdicts: {
          type: 'array',
          items: { type: 'object', properties: { ref: { type: 'string' }, supported: { type: 'boolean' }, reason: { type: 'string' } }, required: ['ref', 'supported', 'reason'] },
        },
        uncertainties: { type: 'array', items: { type: 'string' } },
      },
      required: ['thesis', 'angle', 'causal_chain', 'link_verdicts', 'uncertainties'],
    },
    article: ARTICLE_ITEM,
  },
  required: ['plan', 'article'],
};

const FLAGSHIP_SYSTEM = `You are the editor-in-chief and lead writer of an analytical news outlet. You write a FLAGSHIP
long-read: the piece readers cannot get by asking a chatbot, because it rests on our knowledge base — many independent
sources, extracted facts with evidence status, the history of how events connect, and web research pages that our
own collector fetched.

Material: DOSSIER (sources [D#], web research pages [R#], facts [F#], statements [Q#], related events [E#],
background [B#]) and DEEP HISTORY (candidate chain [H#], precedents [P#], actor timeline [T#]); RESEARCH NOTES are
leads from a search assistant — never cite them, use only what the [R#]/[D#] pages confirm.

First think as an editor (the "plan" object):
1. Judge every [H#] and [P#]: really connected to this event, and how? Be strict — sharing a country name is not a
   connection (link_verdicts).
2. The causal chain worth telling: from_ref -> to_ref, relation, the evidence, and whether a source STATES the
   causality (stated_by_source) or it is an analytical inference. Few strong links beat many weak ones.
3. Thesis, angle, why now, uncertainties.
Then write the article (the "article" object, event_id = the EVENT number):
- 1600-2400 words, 5-8 "## " sections: what happened and why it matters; the evidence and how strong it is; the chain
  of earlier events with dates; the actors and their positions; the numbers and data; what is still unknown; what to
  watch next.
- Causality: "caused"/"led to" only where a cited source states it; otherwise "followed", "came after", "amid",
  "analysts link" — make the difference visible to the reader.
- 6-10 facts with the reference each rests on.
${RULES}`;

const SEARCH_FOCUS = [
  'background and history: earlier decisions, agreements, incidents and dates that explain this event; official statements and primary documents (government, court, company, international organisations)',
  'numbers and data, expert and independent analysis, and other perspectives (including Ukrainian, European and the other side) on this event and its consequences',
];

interface FlagshipCandidate extends Candidate {
  category: string | null;
  storylineId: number | null;
  score: number;
}

@Injectable()
export class KbFlagshipService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbFlagshipService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running?: Promise<unknown>;
  /** Swappable for tests. */
  llm: JsonLlm = geminiJson;
  search: SearchLlm = geminiSearch;
  resolve: (url: string) => Promise<string | null> = resolveRedirect;

  constructor(private readonly db: DatabaseService, private readonly editorial: KbEditorialService) {}

  onModuleInit() {
    if (process.env.KB_FLAGSHIP === 'false') return;
    this.timer = setTimeout(() => void this.loop(), 120_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`Flagship cycle failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), envInt('KB_FLAGSHIP_INTERVAL_MS', 20 * 60_000, 60_000));
    }
  }

  private writerModels(): string[] {
    return models('KB_FLAGSHIP_MODELS', DEFAULT_HYDROGEN_MODEL);
  }

  async runOnce(opts: { force?: boolean; eventId?: number } = {}) {
    if (this.running) return this.running;
    this.running = this.cycle(opts).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private stubbed(): boolean {
    return this.llm !== geminiJson;
  }

  private async flagshipsToday(): Promise<number> {
    return Number((await this.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM kb.events WHERE flagship_at > date_trunc('day', now())`,
    )).rows[0]?.n ?? 0);
  }

  private async writerCallsLeft(): Promise<number> {
    let n = 0;
    for (const m of this.writerModels()) n += Math.min(1000, await remainingLlmCalls(m, 'kb_flagship'));
    return n;
  }

  private async cycle(opts: { force?: boolean; eventId?: number }) {
    const out = { written: 0, researching: 0, waiting: [] as string[], events: [] as unknown[] };
    if (!process.env.GEMINI_API_KEY?.trim() && !this.stubbed()) return { ...out, waiting: ['no GEMINI_API_KEY'] };
    if (!opts.force && !(await isKbEditorialActive(this.db))) return { ...out, waiting: ['kb pipeline not active'] };
    const cap = envInt('KB_FLAGSHIP_DAILY', 8, 1, 20);
    const done = await this.flagshipsToday();
    if (done >= cap && !opts.eventId) return { ...out, waiting: [`daily cap ${cap} reached`] };

    // 1) events whose research is ready (or waited long enough) are written now
    const ready = opts.eventId ? await this.candidateById(opts.eventId) : await this.researched();
    for (const cand of ready) {
      if (this.stopped || done + out.written >= cap) break;
      if (!this.stubbed() && (await this.writerCallsLeft()) < 1) {
        out.waiting.push('flagship model quota used up, waiting');
        break;
      }
      if (opts.eventId && !(await this.researchStarted(cand.eventId))) {
        await this.startResearch(cand); // manual run: research first, write in the same run when nothing to fetch
        if (!(await this.researchDone(cand.eventId)) && !this.stubbed()) {
          out.researching += 1;
          continue;
        }
      }
      try {
        const res = await this.writeFlagship(cand);
        out.events.push(res);
        if (res.status === 'published' || res.status === 'needs_review') out.written += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.events.push({ eventId: cand.eventId, error: msg });
        if (!/budget|429|quota/i.test(msg)) {
          await this.db.query('UPDATE kb.events SET flagship_attempts = flagship_attempts + 1, editorial_error = $2 WHERE id = $1', [cand.eventId, msg.slice(0, 500)]).catch(() => undefined);
        }
      }
    }

    // 2) start research for the next candidates so they are ready next cycle
    if (!opts.eventId) {
      const inFlight = Number((await this.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM kb.events WHERE flagship_at IS NULL AND flagship_plan ? 'research' AND flagship_attempts < 2`,
      )).rows[0]?.n ?? 0);
      const room = Math.max(0, Math.min(envInt('KB_FLAGSHIP_PARALLEL', 2, 1, 6) - inFlight, cap - done - out.written));
      for (const cand of (await this.candidates(room * 2)).slice(0, room)) {
        await this.startResearch(cand).catch((err) => this.logger.warn(`research for ${cand.eventId} failed: ${err instanceof Error ? err.message : err}`));
        out.researching += 1;
      }
    }
    this.logger.log(`Flagship cycle: ${JSON.stringify({ written: out.written, researching: out.researching, waiting: out.waiting })}`);
    return out;
  }

  private async candidates(limit: number): Promise<FlagshipCandidate[]> {
    if (limit <= 0) return [];
    const minSources = envInt('KB_FLAGSHIP_MIN_SOURCES', 3, 2, 20);
    const rows = (await this.db.query(
      `WITH today AS (
         SELECT category, count(*) AS n FROM kb.events WHERE flagship_at > date_trunc('day', now()) GROUP BY category),
       storylines_today AS (
         SELECT DISTINCT storyline_id FROM kb.events
         WHERE (flagship_at > now() - interval '20 hours' OR flagship_plan ? 'research') AND storyline_id IS NOT NULL)
       SELECT e.id, e.importance, e.article_news_id, e.category, e.storyline_id,
              e.importance
                + 0.15 * LEAST(1, (SELECT count(*) FROM kb.event_links l WHERE l.from_event_id = e.id) / 5.0)
                + 0.10 * LEAST(1, COALESCE((SELECT event_count FROM kb.storylines s WHERE s.id = e.storyline_id), 0) / 5.0)
                + 0.10 * LEAST(1, e.independent_source_count / 6.0)
                + CASE WHEN e.editorial_state = 'deep' THEN 0.1 ELSE 0 END AS score
       FROM kb.events e
       WHERE e.status <> 'merged' AND e.flagship_at IS NULL AND e.flagship_attempts < 2 AND NOT (COALESCE(e.flagship_plan, '{}') ? 'research')
         AND e.editorial_state IN ('ready', 'deep', 'written')
         AND e.independent_source_count >= $1 AND e.full_text_doc_count >= 2
         AND e.last_seen_at > now() - interval '36 hours'
         AND COALESCE((SELECT n FROM today t WHERE t.category IS NOT DISTINCT FROM e.category), 0) < 3
         AND (e.storyline_id IS NULL OR e.storyline_id NOT IN (SELECT storyline_id FROM storylines_today))
       ORDER BY score DESC LIMIT $2`,
      [minSources, limit],
    )).rows;
    return rows.map((r) => this.toCandidate(r, Number(r.score)));
  }

  /** Research started and either all pages are processed or the wait is over. */
  private async researched(): Promise<FlagshipCandidate[]> {
    const waitMin = envInt('KB_FLAGSHIP_RESEARCH_WAIT_MIN', 25, 0, 600);
    const rows = (await this.db.query(
      `SELECT e.id, e.importance, e.article_news_id, e.category, e.storyline_id
       FROM kb.events e
       WHERE e.flagship_at IS NULL AND e.flagship_attempts < 2 AND e.flagship_plan ? 'research' AND e.status <> 'merged'
         AND ((e.flagship_plan->'research'->>'requested_at')::timestamptz < now() - make_interval(mins => $1)
              OR NOT EXISTS (SELECT 1 FROM kb.event_research r JOIN kb.documents d ON d.id = r.document_id
                             WHERE r.event_id = e.id AND d.stage IN ('new', 'extracted', 'analyzed')))
       ORDER BY e.importance DESC LIMIT 3`,
      [waitMin],
    )).rows;
    return rows.map((r) => this.toCandidate(r, 1));
  }

  private toCandidate(r: Record<string, any>, score: number): FlagshipCandidate {
    return {
      eventId: Number(r.id), state: 'deep', tier: 'flagship', isUpdate: Boolean(r.article_news_id),
      articleNewsId: r.article_news_id ? Number(r.article_news_id) : null, importance: Number(r.importance),
      category: r.category, storylineId: r.storyline_id ? Number(r.storyline_id) : null, score,
    };
  }

  private async candidateById(eventId: number): Promise<FlagshipCandidate[]> {
    const r = (await this.db.query('SELECT id, importance, article_news_id, category, storyline_id FROM kb.events WHERE id = $1', [eventId])).rows[0];
    return r ? [this.toCandidate(r, 1)] : [];
  }

  private async researchStarted(eventId: number): Promise<boolean> {
    const r = (await this.db.query(`SELECT flagship_plan ? 'research' AS ok FROM kb.events WHERE id = $1`, [eventId])).rows[0];
    return Boolean(r?.ok);
  }

  private async researchDone(eventId: number): Promise<boolean> {
    const r = (await this.db.query(
      `SELECT NOT EXISTS (SELECT 1 FROM kb.event_research r JOIN kb.documents d ON d.id = r.document_id
                          WHERE r.event_id = $1 AND d.stage IN ('new', 'extracted', 'analyzed')) AS ok`, [eventId],
    )).rows[0];
    return Boolean(r?.ok);
  }

  /** Cheap search model finds pages; our collector fetches and extracts them (kind 'research'). */
  async startResearch(cand: FlagshipCandidate) {
    const dossier = await buildDossier(this.db, cand.eventId, { excerptChars: 600, maxDocs: 8 });
    if (!dossier) return;
    const known = [
      `EVENT: ${dossier.event.title} (${dossier.event.startedAt?.slice(0, 10) ?? ''})`,
      dossier.event.summary ? `SUMMARY: ${dossier.event.summary}` : '',
      `PARTICIPANTS: ${dossier.entities.slice(0, 8).map((e) => e.name).join(', ')}`,
      `ALREADY HAVE: ${dossier.docs.map((d) => `${d.sourceName}: ${d.title}`).join(' | ')}`,
      `KNOWN FACTS: ${dossier.facts.slice(0, 10).map((f) => `${f.subject?.name} ${f.predicate} ${f.object?.name ?? f.objectText ?? ''}`).join('; ')}`,
    ].filter(Boolean).join('\n');
    const notes: string[] = [];
    const found = new Map<string, { title: string; query: string }>();
    let model = '';
    for (const focus of SEARCH_FOCUS.slice(0, envInt('KB_FLAGSHIP_SEARCH_CALLS', 2, 1, 4))) {
      try {
        const res = await this.search({
          models: models('KB_RESEARCH_MODELS', 'gemini-3.1-flash-lite,gemini-2.5-flash-lite'),
          purpose: 'kb_research', timeoutMs: 120_000,
          prompt: `You research for a journalist writing an in-depth article. Search the web for: ${focus}.
Prefer original sources (official sites, documents, data, reputable agencies) over aggregators. Do not repeat what is
listed under ALREADY HAVE. Answer with short factual notes, each with the source.\n\n${known}`,
        });
        model = res.model;
        notes.push(res.text.slice(0, 6000));
        for (const s of res.sources.slice(0, 10)) if (!found.has(s.url)) found.set(s.url, { title: s.title, query: focus.slice(0, 80) });
      } catch (err) {
        notes.push(`(search failed: ${err instanceof Error ? err.message : err})`);
      }
    }
    const max = envInt('KB_FLAGSHIP_RESEARCH_PAGES', 12, 0, 40);
    let inserted = 0;
    for (const [raw, meta] of found) {
      if (inserted >= max) break;
      const url = await this.resolve(raw);
      if (!url) continue;
      const canon = url.split('#')[0].replace(/\/+$/, '');
      const row = (await this.db.query<{ id: string }>(
        `INSERT INTO kb.documents (kind, url, canonical_url, title, stage, meta)
         VALUES ('research', $1, $2, $3, 'new', $4::jsonb)
         ON CONFLICT (canonical_url) DO UPDATE SET canonical_url = EXCLUDED.canonical_url RETURNING id`,
        [url, canon, (meta.title || url).slice(0, 500), JSON.stringify({ research_for_event: cand.eventId, query: meta.query })],
      ).catch(() => ({ rows: [] as Array<{ id: string }> }))).rows[0];
      if (!row) continue;
      await this.db.query(`INSERT INTO kb.event_research (event_id, document_id, query) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [cand.eventId, row.id, meta.query]);
      inserted += 1;
    }
    await this.db.query(
      `UPDATE kb.events SET flagship_plan = COALESCE(flagship_plan, '{}'::jsonb) || jsonb_build_object('research', $2::jsonb) WHERE id = $1`,
      [cand.eventId, JSON.stringify({ requested_at: new Date().toISOString(), model, pages: inserted, notes: notes.join('\n---\n').slice(0, 12_000) })],
    );
  }

  /** Research pages that our collector extracted, as citable [R#] sources. */
  private async researchDocs(eventId: number): Promise<DossierDoc[]> {
    const rows = (await this.db.query(
      `SELECT d.id, d.url, d.title, d.published_at, d.lang, d.extraction_status, left(d.body, 7000) AS excerpt
       FROM kb.event_research r JOIN kb.documents d ON d.id = r.document_id
       WHERE r.event_id = $1 AND d.extraction_status IN ('full', 'partial') AND d.body IS NOT NULL
       ORDER BY d.word_count DESC LIMIT 10`,
      [eventId],
    ).catch(() => ({ rows: [] as Record<string, any>[] }))).rows;
    return rows.map((d, i) => {
      let host = '';
      try {
        host = new URL(d.url).hostname.replace(/^www\./, '');
      } catch {
        host = 'web';
      }
      return {
        ref: `R${i + 1}`, documentId: Number(d.id), sourceName: host, sourceSlug: null, tier: 'research', evidenceRoot: host,
        role: 'research', title: d.title, url: d.url, publishedAt: d.published_at ? new Date(d.published_at).toISOString() : null,
        lang: d.lang, extraction: d.extraction_status, excerpt: String(d.excerpt || ''), newsId: null,
      };
    });
  }

  async writeFlagship(cand: FlagshipCandidate) {
    const dossier = await buildDossier(this.db, cand.eventId, { excerptChars: 9_000, maxDocs: 16 });
    if (!dossier) throw new Error('event not found');
    dossier.docs.push(...(await this.researchDocs(cand.eventId)));
    const history = await buildHistory(this.db, cand.eventId);
    const plan0 = (await this.db.query(`SELECT flagship_plan FROM kb.events WHERE id = $1`, [cand.eventId])).rows[0]?.flagship_plan ?? {};
    const notes = plan0?.research?.notes ? `\n\n=== RESEARCH NOTES (leads only, not citable) ===\n${plan0.research.notes}` : '';
    const material = `${renderDossier(dossier)}\n\n=== DEEP HISTORY ===\n${renderHistory(history) || '(no earlier events in the knowledge base)'}${notes}`;
    const timeoutMs = envInt('KB_FLAGSHIP_TIMEOUT_MS', 420_000, 30_000);

    // ONE Hydrogen call: plan, link verdicts and the English long-read
    const res = await this.llm({
      models: this.writerModels(), system: FLAGSHIP_SYSTEM, prompt: material, schema: FLAGSHIP_SCHEMA,
      maxOutputTokens: 28_000, purpose: 'kb_flagship', timeoutMs, temperature: 0.35,
    });
    const plan = res.json?.plan ?? {};
    let art: GeneratedArticle | undefined = res.json?.article ? { ...res.json.article, event_id: cand.eventId } : undefined;
    if (!art?.body) throw new Error('flagship writer returned no article');
    await this.storeVerdicts(cand.eventId, history, plan);
    await this.db.query(`UPDATE kb.events SET flagship_plan = COALESCE(flagship_plan, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [cand.eventId, JSON.stringify({ plan, writer: res.model })]);

    // cheap fact-check of the whole text against the material; Flash fixes what was flagged
    let review: { verdict: string; issues: unknown[] } | undefined;
    const checked = await this.editorial.reviewAndFix([{ eventId: cand.eventId, material }], [art], timeoutMs).catch((err) => {
      this.logger.warn(`flagship review failed for ${cand.eventId}: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (checked) {
      art = checked.articles[0] ?? art;
      review = checked.reviews.get(cand.eventId);
    }

    const historyRefs = [...history.steps.map((s) => s.ref), ...history.precedents.map((p) => p.ref), ...history.timeline.map((t) => t.ref)];
    const published = await this.editorial.publish(cand, dossier, art, res.model, {
      tier: 'flagship', historyRefs, contextText: renderHistory(history), forceReview: review?.verdict === 'reject',
      extraMeta: {
        flagship: {
          writer: res.model, thesis: plan.thesis, angle: plan.angle, why_now: plan.why_now,
          causal_chain: plan.causal_chain, uncertainties: plan.uncertainties,
          review: review ? { verdict: review.verdict, issues: review.issues.length } : null,
          research_pages: dossier.docs.filter((d) => d.role === 'research').length,
          history: { steps: history.steps.length, precedents: history.precedents.length, timeline: history.timeline.length },
        },
      },
    });
    return { eventId: cand.eventId, ...published, review: review?.verdict ?? null };
  }

  /** Hydrogen's verdicts on [H#]/[P#] links are stored on kb.event_links so every later article reuses them. */
  private async storeVerdicts(eventId: number, history: EventHistory, plan: any) {
    const verdicts: Array<{ ref: string; supported: boolean; reason: string }> = Array.isArray(plan?.link_verdicts) ? plan.link_verdicts : [];
    for (const v of verdicts) {
      const verdict = JSON.stringify({ supported: Boolean(v.supported), reason: String(v.reason || '').slice(0, 300), by: 'flagship', at: new Date().toISOString() });
      const step = history.steps.find((s) => s.ref === v.ref);
      if (step) {
        await this.db.query(`UPDATE kb.event_links SET verdict = $3::jsonb, verified = $4 WHERE from_event_id = $1 AND to_event_id = $2`,
          [step.viaEventId, step.eventId, verdict, Boolean(v.supported)]).catch(() => undefined);
        continue;
      }
      const prec = history.precedents.find((p) => p.ref === v.ref);
      if (prec && v.supported) {
        await this.db.query(
          `INSERT INTO kb.event_links (from_event_id, to_event_id, link_type, score, method, evidence, verified, verdict)
           VALUES ($1, $2, 'precedent', 0.7, 'llm', '{}'::jsonb, true, $3::jsonb)
           ON CONFLICT (from_event_id, to_event_id, link_type) DO UPDATE SET verified = true, verdict = EXCLUDED.verdict`,
          [eventId, prec.eventId, verdict]).catch(() => undefined);
      }
    }
    // causes stated by a source become 'causes' links (this event -> its cause)
    for (const c of Array.isArray(plan?.causal_chain) ? plan.causal_chain : []) {
      if (c?.relation !== 'caused' || !c?.stated_by_source) continue;
      const step = history.steps.find((s) => s.ref === c.from_ref && s.hop === 1);
      if (!step) continue;
      await this.db.query(
        `INSERT INTO kb.event_links (from_event_id, to_event_id, link_type, score, method, evidence, verified, verdict)
         VALUES ($1, $2, 'causes', 0.8, 'llm', $3::jsonb, true, $3::jsonb)
         ON CONFLICT (from_event_id, to_event_id, link_type) DO UPDATE SET verified = true, verdict = EXCLUDED.verdict`,
        [eventId, step.eventId, JSON.stringify({ supported: true, evidence_ref: c.evidence_ref, explanation: String(c.explanation || '').slice(0, 300), by: 'flagship' })],
      ).catch(() => undefined);
    }
  }
}

export type { EventDossier };
