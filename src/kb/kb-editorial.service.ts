/**
 * Tasks 1 and 4: articles are written per real event from the knowledge base, never as a rewrite of one source.
 *
 * Tiers (chosen by algorithms from the event's evidence):
 *   medium   up to KB_MEDIUM_DAILY (50) — ready events: cheap models (Flash-Lite, 2.5/3.6 Flash), 5 events per request,
 *            350-600 words, algorithmic checks.
 *   big      up to KB_BIG_DAILY (30) — important / well-covered events: Hydrogen writes 3 per request (3.8/3.6 Flash
 *            when Hydrogen's share is used up), 900-1400 words, then a cheap reviewer checks every article against
 *            its dossier and a Flash fixer rewrites what the reviewer flagged.
 *   flagship 5-10 per day, see kb-flagship.service.ts.
 * An event first published as medium is upgraded in place when it later qualifies for big (no duplicate news).
 *
 * Only the English canonical article is generated here; KbTranslationService translates it into Ukrainian and the
 * other app languages with cheap models before the article goes live.
 * Quotas are respected per request (llm-budget.ts); when a tier's models are all used up for the day the events wait
 * for the next cycle — the quality rules never relax because of limits.
 *
 * EDITORIAL_SOURCE=auto (default) uses this path while the Python KB workers are alive and the legacy RSS editor
 * otherwise (e.g. on Render without the KB stack); kb / rss force one of them.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DEFAULT_HYDROGEN_MODEL } from '../common/gemini-client';
import { remainingLlmCalls } from '../common/llm-budget';
import { DatabaseService } from '../database/database.service';
import { validateArticle } from '../ingest/gemini-editor.service';
import { CATEGORIES } from '../ingest/ingest.dto';
import { applyMinify, buildDossier, EventDossier, renderDossier } from './kb-dossier';
import { geminiJson, JsonLlm, models } from './kb-llm';

const CHARS_PER_TOKEN = 3.6;
export type Tier = 'medium' | 'big' | 'flagship';

function envInt(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

let activeCache: { at: number; value: boolean } | null = null;

/** Is the knowledge-base editor in charge (and the legacy RSS editor therefore paused)? */
/**
 * "high" is reserved for stories the model calls important AND that several independent roots confirm with good
 * confidence; everything else is "low" (shown as a regular, non-highlighted story). Tunable via KB_HIGH_MIN_SOURCES
 * (default 3) and KB_HIGH_MIN_CONFIDENCE (default 0.7).
 */
export function importanceLevel(important: boolean, independentSources: number | undefined, confidence: unknown): 'high' | 'low' {
  const minSources = Number(process.env.KB_HIGH_MIN_SOURCES) >= 1 ? Number(process.env.KB_HIGH_MIN_SOURCES) : 3;
  const minConfidence = Number.isFinite(Number(process.env.KB_HIGH_MIN_CONFIDENCE)) && process.env.KB_HIGH_MIN_CONFIDENCE ? Number(process.env.KB_HIGH_MIN_CONFIDENCE) : 0.7;
  const conf = typeof confidence === 'number' ? confidence : Number(confidence);
  const confOk = !Number.isFinite(conf) || conf >= minConfidence;
  return important && (independentSources ?? 0) >= minSources && confOk ? 'high' : 'low';
}

export async function isKbEditorialActive(db: DatabaseService): Promise<boolean> {
  const mode = (process.env.EDITORIAL_SOURCE || 'auto').toLowerCase();
  if (mode === 'kb') return true;
  if (mode === 'rss') return false;
  if (activeCache && Date.now() - activeCache.at < 60_000) return activeCache.value;
  const row = await db
    .query<{ alive: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM kb.pipeline_runs WHERE worker = 'nlp' AND started_at > now() - interval '30 minutes') AS alive`,
    )
    .then((r) => r.rows[0])
    .catch(() => null);
  activeCache = { at: Date.now(), value: Boolean(row?.alive) };
  return activeCache.value;
}

export interface PublishOptions {
  tier?: Tier;
  /** Allowed [H#]/[P#]/[T#] references (deep history of a flagship). */
  historyRefs?: string[];
  /** Extra context the article may take numbers from (history, research). */
  contextText?: string;
  extraMeta?: Record<string, unknown>;
  /** A reviewer rejected the article: keep it out of the feed until a human looks at it. */
  forceReview?: boolean;
}

export interface Candidate {
  eventId: number;
  state: 'ready' | 'deep';
  tier?: Tier;
  isUpdate: boolean;
  articleNewsId: number | null;
  importance: number;
}

export interface GeneratedArticle {
  event_id: number;
  title: string;
  summary: string;
  body: string;
  importance_reason: string;
  important: boolean;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  facts: Array<{ claim: string; ref: string }>;
  background?: string;
  whats_next?: string;
  angles?: string[];
  limitations?: string;
}

const ARTICLE_ITEM = {
  type: 'object',
  properties: {
    event_id: { type: 'integer' },
    title: { type: 'string' },
    summary: { type: 'string' },
    body: { type: 'string' },
    importance_reason: { type: 'string' },
    important: { type: 'boolean' },
    category: { type: 'string', enum: [...CATEGORIES] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    facts: {
      type: 'array',
      items: { type: 'object', properties: { claim: { type: 'string' }, ref: { type: 'string' } }, required: ['claim', 'ref'] },
    },
    background: { type: 'string' },
    whats_next: { type: 'string' },
    angles: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'string' },
  },
  required: ['event_id', 'title', 'summary', 'body', 'importance_reason', 'important', 'category', 'confidence', 'facts'],
};

export const ARTICLE_SCHEMA = { type: 'object', properties: { articles: { type: 'array', items: ARTICLE_ITEM } }, required: ['articles'] };

export const RULES = `Rules:
- Use ONLY information from the material given. Do not add facts, numbers, names or dates from memory.
- Cite after the sentences they support: sources [D1], research pages [R1], official data and registries [S1] (quote
  their numbers exactly with period and source — they make the article stronger); facts [F#]/[B#] map to their sources;
  earlier events [E#]/[H#]/[P#], timeline [T#]. Every paragraph needs a citation.
- Put the event in context with dates: what happened before and why it matters. Links between events are
  algorithmic hypotheses: say "after", "following", "amid"; state a cause only when a cited source states it.
- Attribute statements ("X said") and keep them apart from verified facts. Say when a fact rests on one source.
  If the material lists CONTRADICTIONS, show both versions with their sources.
- Teaser/paywalled sources may only be mentioned as "also reported by".
- Write in English (it is translated later). Short paragraphs, "## " subheadings for longer texts, no bullet-only text.
- facts: the key verifiable claims, each with the reference it rests on ("D2", "F3", "R1").`;

const SYSTEM: Record<'medium' | 'big', string> = {
  medium: `You are an editor of a news site whose advantage is a knowledge base of events, facts and sources.
For EACH dossier write one clear news story (not a rewrite of one source): what happened, confirmed by whom,
what came before, why it matters. 350-600 words, 1-3 subheadings when useful, 3-6 facts.
${RULES}`,
  big: `You are the senior editor of an analytical news site whose advantage is a knowledge base that tracks events,
facts, sources and how events connect over time. For EACH dossier write one complete, original feature article:
the news, the evidence and how strong it is, the background with dated earlier events, the different positions,
what is still unknown and what to watch. 900-1400 words, 3-5 "## " subheadings, 4-8 facts.
${RULES}`,
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          event_id: { type: 'integer' },
          verdict: { type: 'string', enum: ['ok', 'fix', 'reject'] },
          issues: {
            type: 'array',
            items: { type: 'object', properties: { location: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } }, required: ['location', 'problem', 'fix'] },
          },
        },
        required: ['event_id', 'verdict', 'issues'],
      },
    },
  },
  required: ['reviews'],
};

const REVIEW_SYSTEM = `You are a fact-checking editor. For each article compare EVERY claim with its dossier.
Flag: claims not supported by the dossier or cited to the wrong reference, numbers/dates/names that differ,
causality stronger than the evidence, statements presented as facts, contradictions not shown, missing important
context that the dossier contains, misleading headline. verdict: ok (publish as is), fix (fixable issues),
reject (the article misrepresents the event). Be concrete: location, problem, how to fix.`;

const FIX_SYSTEM = `You revise news articles after a fact-check. Fix exactly the listed issues using only the dossier,
keep everything else (structure, citations, length). Return the full revised articles.
${RULES}`;

interface BatchItem {
  cand: Candidate;
  dossier: EventDossier;
  text: string;
}

@Injectable()
export class KbEditorialService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbEditorialService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running?: Promise<unknown>;
  /** Swappable for tests. */
  llm: JsonLlm = geminiJson;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.KB_EDITORIAL === 'false') return;
    this.timer = setTimeout(() => void this.loop(), 40_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`KB editorial cycle failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), envInt('KB_EDITORIAL_INTERVAL_MS', 10 * 60_000, 60_000));
    }
  }

  get enabled(): boolean {
    return Boolean(process.env.GEMINI_API_KEY?.trim()) || this.dryRun || this.llm !== geminiJson;
  }

  get dryRun(): boolean {
    return process.env.KB_EDITORIAL_DRY_RUN === 'true';
  }

  async runOnce(opts: { force?: boolean } = {}) {
    if (this.running) return this.running;
    this.running = this.cycle(opts).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  static tierModels(tier: 'medium' | 'big'): string[] {
    return tier === 'big'
      ? models('KB_BIG_MODELS', `${DEFAULT_HYDROGEN_MODEL},gemini-3-flash-preview,gemini-3.1-flash-lite`)
      : models('KB_MEDIUM_MODELS', 'gemini-3.1-flash-lite,gemini-2.5-flash-lite');
  }

  private async writtenToday(): Promise<Record<string, number>> {
    const rows = (await this.db.query<{ tier: string; n: string }>(
      `SELECT COALESCE(written_evidence->>'tier', 'medium') AS tier, count(*) AS n FROM kb.events
       WHERE written_at > date_trunc('day', now()) GROUP BY 1`,
    )).rows;
    return Object.fromEntries(rows.map((r) => [r.tier, Number(r.n)]));
  }

  private async cycle(opts: { force?: boolean }) {
    const summary = { active: false, candidates: 0, batches: 0, written: 0, updated: 0, rejected: 0, waiting: [] as string[] };
    if (!this.enabled) return { ...summary, waiting: ['no GEMINI_API_KEY'] };
    if (!opts.force && !(await isKbEditorialActive(this.db))) return { ...summary, waiting: ['kb pipeline not active'] };
    summary.active = true;
    const today = await this.writtenToday();
    const caps = { big: envInt('KB_BIG_DAILY', 30, 0, 200), medium: envInt('KB_MEDIUM_DAILY', 50, 0, 500) };
    const maxBatches = envInt('KB_EDITORIAL_BATCHES_PER_CYCLE', 2, 1, 10);
    for (const tier of ['big', 'medium'] as const) {
      const left = caps[tier] - (today[tier] ?? 0);
      if (left <= 0) {
        summary.waiting.push(`${tier}: daily cap reached`);
        continue;
      }
      if (!this.dryRun && this.llm === geminiJson) {
        let calls = 0;
        for (const m of KbEditorialService.tierModels(tier)) calls += Math.min(1000, await remainingLlmCalls(m, `kb_${tier}`));
        if (calls <= 0) {
          summary.waiting.push(`${tier}: model quotas used up, waiting`);
          continue;
        }
      }
      const cands = await this.candidates(tier, Math.min(left, tier === 'big' ? 9 : 15));
      summary.candidates += cands.length;
      const batches = await this.pack(cands, tier);
      for (const batch of batches.slice(0, maxBatches)) {
        if (this.stopped) break;
        summary.batches += 1;
        const res = await this.runBatch(batch, tier);
        summary.written += res.written;
        summary.updated += res.updated;
        summary.rejected += res.rejected;
      }
    }
    this.logger.log(`KB editorial: ${JSON.stringify(summary)}`);
    return summary;
  }

  /**
   * big: deep events, or >= KB_BIG_MIN_SOURCES independent roots, or importance >= KB_BIG_MIN_IMPORTANCE;
   * medium: every other ready event. Plus updates: more evidence since writing, or a medium article now worth big.
   */
  private async candidates(tier: 'medium' | 'big', limit: number): Promise<Candidate[]> {
    const bigCond = `(e.editorial_state = 'deep' OR e.independent_source_count >= ${envInt('KB_BIG_MIN_SOURCES', 3, 2, 50)}
                      OR e.importance >= ${envNum('KB_BIG_MIN_IMPORTANCE', 0.5)})`;
    const tierCond = tier === 'big' ? bigCond : `NOT ${bigCond}`;
    // An event still "collecting" qualifies once AI-found, AI-vetted corroborating pages lift it to the minimum.
    const corroboratedOk = `(e.editorial_state = 'collecting' AND e.independent_source_count >= 1
      AND e.independent_source_count + (SELECT count(*) FROM kb.event_research r WHERE r.event_id = e.id AND r.accepted = true AND r.query = 'corroboration')
          >= ${envInt('KB_READY_MIN_SOURCES', 2, 2, 20)})`;
    const fresh = (await this.db.query(
      `SELECT e.id, CASE WHEN e.editorial_state = 'collecting' THEN 'ready' ELSE e.editorial_state END AS editorial_state, e.importance FROM kb.events e
       WHERE (e.editorial_state IN ('ready', 'deep') OR ${corroboratedOk}) AND e.article_news_id IS NULL AND e.status <> 'merged'
         AND e.editorial_attempts < 3 AND e.last_seen_at > now() - interval '48 hours' AND ${tierCond}
       ORDER BY (e.editorial_state = 'deep') DESC, e.importance DESC LIMIT $1`,
      [limit],
    )).rows.map((r): Candidate => ({ eventId: Number(r.id), state: r.editorial_state, tier, isUpdate: false, articleNewsId: null, importance: Number(r.importance) }));
    const updates = (await this.db.query(
      `SELECT e.id, e.article_news_id, e.importance
       FROM kb.events e
       WHERE e.editorial_state = 'written' AND e.article_news_id IS NOT NULL AND e.status <> 'merged'
         AND e.flagship_at IS NULL AND e.editorial_attempts < 6 AND e.last_seen_at > now() - interval '48 hours'
         AND ${tierCond}
         AND (
           ($2 = 'big' AND COALESCE(e.written_evidence->>'tier', 'medium') = 'medium')
           OR (e.written_at < now() - interval '3 hours' AND e.last_seen_at > e.written_at
               AND (e.independent_source_count >= COALESCE((e.written_evidence->>'roots')::int, 0) + 2
                    OR (SELECT count(DISTINCT c.fact_id) FROM kb.claims c WHERE c.event_id = e.id AND c.fact_id IS NOT NULL)
                       >= COALESCE((e.written_evidence->>'facts')::int, 0) + 3)))
       ORDER BY e.importance DESC LIMIT $1`,
      [Math.max(1, Math.ceil(limit / 3)), tier],
    )).rows.map((r): Candidate => ({ eventId: Number(r.id), state: 'ready', tier, isUpdate: true, articleNewsId: Number(r.article_news_id), importance: Number(r.importance) }));
    return [...fresh, ...updates];
  }

  private async pack(cands: Candidate[], tier: 'medium' | 'big'): Promise<BatchItem[][]> {
    const maxPromptChars = envInt('KB_EDITORIAL_MAX_PROMPT_CHARS', 600_000, 20_000);
    const perBatch = tier === 'big' ? envInt('KB_BIG_BATCH', 3, 1, 6) : envInt('KB_MEDIUM_BATCH', 5, 1, 10);
    const minify = process.env.KB_MINIFY !== 'false';
    // With minification the model can see twice as many sources in the same budget: pull more, then compress without paraphrasing.
    const opts = minify
      ? (tier === 'big' ? { excerptChars: 9_000, maxDocs: 24 } : { excerptChars: 4_500, maxDocs: 14 })
      : (tier === 'big' ? { excerptChars: 7_000, maxDocs: 12 } : { excerptChars: 3_000, maxDocs: 8 });
    const minifyChars = tier === 'big' ? envInt('KB_MINIFY_BIG_CHARS', 70_000, 8_000) : envInt('KB_MINIFY_MEDIUM_CHARS', 28_000, 4_000);
    const batches: BatchItem[][] = [];
    let current: BatchItem[] = [];
    let chars = 0;
    for (const cand of cands) {
      const dossier = await buildDossier(this.db, cand.eventId, opts);
      if (!dossier || !dossier.docs.length) continue;
      if (minify) applyMinify(dossier, minifyChars);
      const text = `### DOSSIER${cand.isUpdate ? ' (UPDATE of an existing article: rewrite it with the new evidence)' : ''}\n${renderDossier(dossier)}`;
      if (current.length >= perBatch || chars + text.length > maxPromptChars) {
        if (current.length) batches.push(current);
        current = [];
        chars = 0;
      }
      current.push({ cand, dossier, text });
      chars += text.length;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  private async runBatch(batch: BatchItem[], tier: 'medium' | 'big') {
    const result = { written: 0, updated: 0, rejected: 0 };
    const prompt = `${batch.map((b) => b.text).join('\n\n')}\n\nWrite ${batch.length} article(s), one per dossier, event_id = the dossier's EVENT number.`;
    const run = (await this.db.query<{ id: string }>(
      `INSERT INTO kb.editorial_runs (event_ids, prompt_chars, dry_run, detail) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [batch.map((b) => b.cand.eventId), prompt.length, this.dryRun, JSON.stringify({ tier })],
    ).catch(() => ({ rows: [] as Array<{ id: string }> }))).rows[0]?.id;
    if (this.dryRun) {
      await this.finishRun(run, null, result, null, { tier, estimated_input_tokens: Math.round((SYSTEM[tier].length + prompt.length) / CHARS_PER_TOKEN) });
      return result;
    }
    const timeoutMs = envInt('KB_EDITORIAL_TIMEOUT_MS', 300_000, 30_000);
    let written: { json: any; model: string };
    try {
      written = await this.llm({
        models: KbEditorialService.tierModels(tier), system: SYSTEM[tier], prompt, schema: ARTICLE_SCHEMA,
        maxOutputTokens: Math.min(64_000, (tier === 'big' ? 7_000 : 3_000) * batch.length + 2_000),
        purpose: `kb_${tier}`, timeoutMs, temperature: 0.35,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // quota or transient failure: no attempt is counted, the events simply wait for the next cycle
      if (!/budget|429|quota/i.test(msg)) {
        await this.db.query(`UPDATE kb.events SET editorial_attempts = editorial_attempts + 1, editorial_error = $2 WHERE id = ANY($1)`,
          [batch.map((b) => b.cand.eventId), msg.slice(0, 500)]).catch(() => undefined);
      }
      await this.finishRun(run, null, result, msg, { tier });
      return result;
    }
    let articles: GeneratedArticle[] = Array.isArray(written.json?.articles) ? written.json.articles : [];
    const detail: Record<string, unknown> = { tier, writer: written.model };

    // big: cheap fact-check of every article against its dossier, then one Flash pass fixes what was flagged
    let reviews = new Map<number, { verdict: string; issues: unknown[] }>();
    if (tier === 'big' && articles.length) {
      const fixed = await this.reviewAndFix(batch.map((b) => ({ eventId: b.cand.eventId, material: b.text })), articles, timeoutMs).catch((err) => {
        detail.review_error = err instanceof Error ? err.message : String(err);
        return null;
      });
      if (fixed) {
        articles = fixed.articles;
        reviews = fixed.reviews;
        detail.reviewer = fixed.reviewer;
        detail.fixer = fixed.fixer;
      }
    }

    for (const item of batch) {
      const art = articles.find((a) => Number(a.event_id) === item.cand.eventId);
      if (!art) {
        result.rejected += 1;
        detail[item.cand.eventId] = 'missing in response';
        await this.bumpAttempt(item.cand.eventId, 'missing in response');
        continue;
      }
      const review = reviews.get(item.cand.eventId);
      try {
        const outcome = await this.publish(item.cand, item.dossier, art, written.model, {
          tier,
          extraMeta: review ? { review: { verdict: review.verdict, issues: review.issues.length } } : undefined,
          forceReview: review?.verdict === 'reject',
        });
        detail[item.cand.eventId] = outcome;
        if (item.cand.isUpdate) result.updated += 1;
        else result.written += 1;
      } catch (err) {
        result.rejected += 1;
        const msg = err instanceof Error ? err.message : String(err);
        detail[item.cand.eventId] = msg;
        await this.bumpAttempt(item.cand.eventId, msg);
      }
    }
    await this.finishRun(run, written.model, result, null, detail);
    return result;
  }

  /** One cheap review call for the whole batch; one Flash call rewrites the flagged articles. Shared with flagships. */
  async reviewAndFix(items: Array<{ eventId: number; material: string }>, articles: GeneratedArticle[], timeoutMs: number) {
    const reviewPrompt = items.map((it) => {
      const art = articles.find((a) => Number(a.event_id) === it.eventId);
      return art ? `=== EVENT ${it.eventId} ===\n--- DOSSIER ---\n${it.material}\n--- ARTICLE ---\n# ${art.title}\n${art.summary}\n\n${art.body}` : '';
    }).filter(Boolean).join('\n\n');
    const review = await this.llm({
      models: models('KB_REVIEW_MODELS', 'gemini-3.1-flash-lite,gemini-2.5-flash-lite'), system: REVIEW_SYSTEM,
      prompt: reviewPrompt, schema: REVIEW_SCHEMA, maxOutputTokens: 6_000, purpose: 'kb_review', timeoutMs,
    });
    const reviews = new Map<number, { verdict: string; issues: Array<{ location: string; problem: string; fix: string }> }>();
    for (const r of review.json?.reviews ?? []) reviews.set(Number(r.event_id), { verdict: r.verdict, issues: Array.isArray(r.issues) ? r.issues : [] });
    const toFix = items.filter((it) => reviews.get(it.eventId)?.verdict === 'fix' && reviews.get(it.eventId)!.issues.length);
    let fixer: string | null = null;
    let out = articles;
    if (toFix.length) {
      const fixPrompt = toFix.map((it) => {
        const art = articles.find((a) => Number(a.event_id) === it.eventId)!;
        const issues = reviews.get(it.eventId)!.issues.map((i, n) => `${n + 1}. [${i.location}] ${i.problem} -> ${i.fix}`).join('\n');
        return `=== EVENT ${it.eventId} ===\n--- DOSSIER ---\n${it.material}\n--- ARTICLE (JSON) ---\n${JSON.stringify(art)}\n--- ISSUES ---\n${issues}`;
      }).join('\n\n');
      try {
        const fixed = await this.llm({
          models: models('KB_FIX_MODELS', 'gemini-3-flash-preview,gemini-3.1-flash-lite'), system: FIX_SYSTEM, prompt: fixPrompt,
          schema: ARTICLE_SCHEMA, maxOutputTokens: Math.min(64_000, 9_000 * toFix.length), purpose: 'kb_fix', timeoutMs,
        });
        fixer = fixed.model;
        const byId = new Map<number, GeneratedArticle>((fixed.json?.articles ?? []).map((a: GeneratedArticle) => [Number(a.event_id), a]));
        out = articles.map((a) => byId.get(Number(a.event_id)) ?? a);
        for (const id of byId.keys()) {
          const r = reviews.get(id);
          if (r) reviews.set(id, { ...r, verdict: 'fixed' });
        }
      } catch (err) {
        // the unfixed articles still pass the algorithmic checks; flagged ones go to manual review
        for (const it of toFix) reviews.set(it.eventId, { ...reviews.get(it.eventId)!, verdict: 'reject' });
        this.logger.warn(`fix pass failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { articles: out, reviews, reviewer: review.model, fixer };
  }

  private async bumpAttempt(eventId: number, error: string) {
    await this.db.query(`UPDATE kb.events SET editorial_attempts = editorial_attempts + 1, editorial_error = $2 WHERE id = $1`, [eventId, error.slice(0, 500)]).catch(() => undefined);
  }

  private async finishRun(runId: string | undefined, model: string | null, r: { written: number; updated: number; rejected: number }, error: string | null,
    detail: Record<string, unknown>) {
    if (!runId) return;
    await this.db.query(
      `UPDATE kb.editorial_runs SET finished_at = now(), model = $2, written = $3, updated = $4, rejected = $5, error = $6, detail = $7::jsonb
       WHERE id = $1`,
      [runId, model, r.written, r.updated, r.rejected, error, JSON.stringify(detail)],
    ).catch(() => undefined);
  }

  /** Map dossier references to real sources, check the text, write/update the news item and link the event. */
  async publish(cand: Candidate, dossier: EventDossier, art: GeneratedArticle, model: string, opts: PublishOptions = {}) {
    const tier: Tier = opts.tier ?? cand.tier ?? 'medium';
    const historyRefs = new Set(opts.historyRefs ?? []);
    const docByRef = new Map(dossier.docs.map((d) => [d.ref, d]));
    const factByRef = new Map([...dossier.facts, ...dossier.background].map((f) => [f.ref, f]));
    // Sources in order of first citation; uncited full-text documents follow (max 12).
    const order: string[] = [];
    const cite = (ref: string) => {
      if (docByRef.has(ref) && !order.includes(ref)) order.push(ref);
    };
    for (const m of `${art.body}`.matchAll(/\b([DRS]\d+)\b/g)) cite(m[1]);
    for (const f of art.facts || []) {
      if (/^[DRS]\d/.test(f.ref ?? '')) cite(f.ref);
      for (const r of factByRef.get(f.ref)?.docRefs ?? []) cite(r);
    }
    for (const d of dossier.docs) if (order.length < 12 && d.extraction === 'full') cite(d.ref);
    const sourceIndex = new Map(order.slice(0, 12).map((ref, i) => [ref, i + 1]));
    const unknownRefs = new Set<string>();
    const rewrite = (text: string) =>
      text
        .replace(/\[((?:[DRSFQEBHPT]\d+)(?:\s*[,;]\s*[DRSFQEBHPT]\d+)*)\]/g, (_all, inner: string) => {
          const parts = inner.split(/\s*[,;]\s*/).flatMap((ref) => {
            if (ref.startsWith('D') || ref.startsWith('R') || ref.startsWith('S')) {
              const n = sourceIndex.get(ref);
              if (!n) unknownRefs.add(ref);
              return n ? [`[${n}]`] : [];
            }
            if (ref.startsWith('F') || ref.startsWith('B')) {
              const f = factByRef.get(ref);
              if (!f) unknownRefs.add(ref);
              return (f?.docRefs ?? []).map((r) => sourceIndex.get(r)).filter(Boolean).map((n) => `[${n}]`);
            }
            if (ref.startsWith('Q')) {
              const q = dossier.quotes.find((x) => x.ref === ref);
              const n = q?.docRef ? sourceIndex.get(q.docRef) : undefined;
              return n ? [`[${n}]`] : [];
            }
            if (ref.startsWith('E') && !dossier.linked.some((l) => l.ref === ref)) unknownRefs.add(ref);
            if (/^[HPT]/.test(ref) && !historyRefs.has(ref)) unknownRefs.add(ref);
            return []; // earlier events are named in the prose; the app shows them under "Що було раніше"
          });
          return [...new Set(parts)].join('');
        })
        .replace(/[ \t]+([.,;:!?])/g, '$1') // a removed [E#] must not leave "reopened ."
        .replace(/[ \t]+\n/g, '\n');
    const body = rewrite(art.body || '');

    const sources = order.slice(0, 12).map((ref) => {
      const d = docByRef.get(ref)!;
      return { title: `${d.sourceName}: ${d.title}`.slice(0, 240), url: d.url };
    });
    if (!sources.length) throw new Error('article cites no dossier source');
    const facts = (art.facts || []).slice(0, 16).flatMap((f) => {
      const fact = factByRef.get(f.ref);
      const docRef = /^[DRS]\d/.test(f.ref ?? '') ? f.ref : fact?.docRefs?.[0];
      const idx = docRef ? sourceIndex.get(docRef) : undefined;
      if (!idx || !f.claim?.trim()) return [];
      const status = fact ? (fact.status === 'confirmed' || fact.status === 'corroborated' ? 'confirmed' : 'unverified') : 'unverified';
      return [{ claim: f.claim.trim().slice(0, 750), status, url: sources[idx - 1].url }];
    });

    // Numbers in the text must exist in the dossier (years and small counts excepted).
    const dossierText = `${renderDossier(dossier)}\n${opts.contextText ?? ''}`;
    const NUM = /\d{1,3}(?:[  ,.]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;
    const known = new Set([...dossierText.matchAll(NUM)].map((m) => normNum(m[0])));
    const unknownNumbers = [...new Set([...`${art.body}`.replace(/\[[A-Z]\d+\]/g, ' ').matchAll(NUM)].map((m) => normNum(m[0])))]
      .filter((n) => n && !known.has(n) && !(Number(n) >= 1900 && Number(n) <= 2100) && !(Number(n) <= 12));
    const words = body.split(/\s+/).filter(Boolean).length;
    const minWords = tier === 'flagship' ? 1100 : tier === 'big' ? 650 : 250;
    const problems: string[] = [];
    if (words < minWords) problems.push(`too short (${words} words)`);
    if (unknownRefs.size) problems.push(`unknown references ${[...unknownRefs].join(',')}`);
    if (unknownNumbers.length > 3) problems.push(`numbers not in dossier: ${unknownNumbers.slice(0, 8).join(', ')}`);

    const category = (CATEGORIES as readonly string[]).includes(art.category) ? art.category : dossier.event.category && (CATEGORIES as readonly string[]).includes(dossier.event.category) ? dossier.event.category : 'other';
    const validated = validateArticle(
      {
        title: art.title, summary: art.summary, body: body.slice(0, 16_000), important: Boolean(art.important),
        importance_reason: (art.importance_reason || '').slice(0, 1500) || 'Reported by several independent sources.',
        category, sources, facts, comparisons: [], confidence: art.confidence,
        editorial: { angles: (art.angles || []).slice(0, 10).map((x) => String(x).slice(0, 100)), style: 'knowledge-base dossier', limitations: (art.limitations || '').slice(0, 2000) },
        background: art.background, whats_next: art.whats_next,
      },
      sources[0].url,
    );
    const lead = dossier.docs.find((d) => d.ref === order[0]) ?? dossier.docs[0];
    const checksPassed = !problems.length && !opts.forceReview && process.env.EDITORIAL_REQUIRE_REVIEW !== 'true';
    // A new article goes live after KbTranslationService translated it (Ukrainian first); an update of a live
    // article stays live and its translations are refreshed.
    const awaitTranslation = process.env.KB_PUBLISH_BEFORE_TRANSLATION !== 'true';
    const status = checksPassed && (cand.articleNewsId || !awaitTranslation) ? 'published' : 'needs_review';
    const kbMeta = {
      event_id: dossier.event.id,
      tier,
      checks_passed: checksPassed,
      awaiting_translation: true,
      ...(opts.extraMeta ?? {}),
      dossier_hash: dossier.hash,
      independent_sources: dossier.event.independentSources,
      related_event_ids: dossier.linked.map((l) => l.eventId),
      storyline_id: dossier.event.storylineId,
      fact_ids: dossier.facts.map((f) => f.factId),
      validation: { words, unknown_numbers: unknownNumbers.slice(0, 20), unknown_refs: [...unknownRefs], problems },
      generated_at: new Date().toISOString(),
      update: cand.isUpdate,
    };
    const metadata = {
      editorial_fingerprint: `kb:${dossier.hash}`, model, researched: true, grounding: [], article: validated, kb: kbMeta,
      // the app already badges hydrogen_deep_analysis items ("🧬 Hydrogen"); flagships are planned and reviewed by Hydrogen
      ...(tier === 'flagship' ? { hydrogen_deep_analysis: true, editorial_tier: 'flagship' } : {}),
    };
    const clusterSources = dossier.docs.slice(0, 12).map((d) => ({
      id: `kb-doc-${d.documentId}`, title: d.title, url: d.url, canonicalUrl: d.url, sourceName: d.sourceName, sourceSlug: d.sourceSlug ?? '',
      publishedAt: d.publishedAt,
    }));
    const hash = createHash('sha256').update(`${validated.title}\n${validated.body}`).digest('hex');

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const src = (await client.query<{ source_id: string }>('SELECT source_id FROM kb.documents WHERE id = $1', [lead.documentId])).rows[0];
      if (!src?.source_id) throw new Error('lead document has no source');
      let newsId: number;
      if (cand.articleNewsId) {
        await client.query(
          `UPDATE news_items SET category = $2, importance = $3,
                  ai_metadata = $4::jsonb, content_hash = $5, cluster_sources = $6::jsonb, kb_event_id = $7, updated_at = now(),
                  status = CASE WHEN status = 'rejected' THEN status ELSE $8 END, editorial_tier = $9
           WHERE id = $1`,
          [cand.articleNewsId, category, importanceLevel(Boolean(validated.important), dossier.event.independentSources, validated.confidence),
            JSON.stringify(metadata), hash, JSON.stringify(clusterSources), dossier.event.id, status, tier],
        );
        newsId = cand.articleNewsId;
      } else {
        const row = (await client.query<{ id: string }>(
          `INSERT INTO news_items (source_id, external_id, url, canonical_url, original_title, original_summary, title_uk, summary_uk,
                                   why_it_matters, category, importance, free_access, published_at, ai_metadata, content_hash, status,
                                   cluster_id, cluster_sources, ai_generated, kb_event_id, editorial_tier)
           VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, 'unknown', $11, $12::jsonb, $13, $14, $15, $16::jsonb, true, $17, $18)
           ON CONFLICT (source_id, external_id) DO UPDATE SET
                  ai_metadata = EXCLUDED.ai_metadata, content_hash = EXCLUDED.content_hash, kb_event_id = EXCLUDED.kb_event_id,
                  editorial_tier = EXCLUDED.editorial_tier, updated_at = now()
           RETURNING id`,
          [src.source_id, `kb-event-${dossier.event.id}`, lead.url, dossier.event.title.slice(0, 350), (dossier.event.summary || '').slice(0, 2000),
            null, null, null, category, importanceLevel(Boolean(validated.important), dossier.event.independentSources, validated.confidence),
            dossier.event.startedAt ?? new Date().toISOString(), JSON.stringify(metadata), hash, status, `kb-${dossier.event.id}`,
            JSON.stringify(clusterSources), dossier.event.id, tier],
        )).rows[0];
        newsId = Number(row.id);
      }
      const factCount = (await client.query<{ n: string }>(
        'SELECT count(DISTINCT fact_id) AS n FROM kb.claims WHERE event_id = $1 AND fact_id IS NOT NULL', [dossier.event.id],
      )).rows[0]?.n;
      await client.query(
        `UPDATE kb.events SET article_news_id = $2, editorial_state = 'written', written_at = now(), dossier_hash = $3,
                written_evidence = $4::jsonb, editorial_error = $5,
                flagship_at = CASE WHEN $6 = 'flagship' THEN now() ELSE flagship_at END WHERE id = $1`,
        [dossier.event.id, newsId, dossier.hash, JSON.stringify({ roots: dossier.event.independentSources, facts: Number(factCount ?? 0), docs: dossier.docs.length, tier }),
          problems.length ? problems.join('; ').slice(0, 500) : null, tier],
      );
      await client.query('COMMIT');
      return { status, newsId, words, problems };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async preview(eventId: number) {
    const dossier = await buildDossier(this.db, eventId, { excerptChars: 2_200, maxDocs: 8 });
    if (!dossier) return null;
    const text = renderDossier(dossier);
    return { dossier, text, estimatedInputTokens: Math.round((SYSTEM.big.length + text.length) / CHARS_PER_TOKEN) };
  }
}

function normNum(raw: string): string {
  return raw.replace(/[\s,]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(/\.0+$/, '');
}
