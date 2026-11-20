/**
 * Deep dives: long explanatory articles the system chooses and writes by itself, without a news trigger (flag KB_DEEPDIVE=true).
 *
 * Pipeline per article (about 25-35 model calls, ~1 hour on the free tier):
 *   topic from knowledge-base signals -> research material (documents of >= 5 independent origins) -> outline -> section by section
 *   -> plain headline -> deterministic gates (length, citations on every paragraph, no unknown numbers, no sensational wording)
 *   -> independent verification of every paragraph against the sources it cites, by a DIFFERENT model family (Gemma) -> one automatic
 *   repair round for flagged paragraphs -> re-verification -> Ukrainian translation -> publication.
 * There is no manual approval step: an article that does not pass every gate is discarded (and the topic is cooled down).
 * Sensitive subjects (people, places, politics, war, health, law) are never written automatically unless KB_DEEPDIVE_SENSITIVE=true.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DecisionQuestion, postGeminiDecisions } from '../common/decision-client';
import { postGeminiGenerateContent } from '../common/gemini-client';
import { remainingLlmCalls } from '../common/llm-budget';
import { DatabaseService } from '../database/database.service';
import { translationTooShort, validateArticle } from '../ingest/gemini-editor.service';
import { CATEGORIES } from '../ingest/ingest.dto';
import {
  ParagraphVerdict, Section, citedSourceNumbers, countWords, deterministicGates, parseSections, remapCitations, renderSections,
  stripInternalRefs, verificationPasses,
} from './kb-deepdive-gates';
import { cheapTranslator, Translator } from './kb-translation.service';

const WRITE_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const VERIFY_MODELS = ['gemma-4-31b-it'];
const ALLOWED_CATEGORY_TOPICS = ['model', 'global_tech', 'coding', 'research', 'hardware_gaming', 'cybersecurity'];
const SENSITIVE_CATEGORIES = new Set(['politics', 'war', 'health', 'law', 'crime', 'other']);

export interface DeepTopic { key: string; title: string; brief: string; category: string; entityId?: number; kind: 'entity' | 'category' }
export interface Material { context: string; docs: Array<{ source: string; pub: string; title: string; url: string; evidenceRoot: string | null }>; origins: number; events: number }
export type ModelCall = (models: string[], system: string, prompt: string, schema: Record<string, unknown> | null, maxTokens: number, purpose: string) => Promise<{ text: string; model: string }>;

const envInt = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

const WRITER_SYSTEM = `You are a senior feature writer at a news site that has a knowledge base of events, facts and sources. You write deep, original, well-structured explanatory articles that are NOT tied to one news item.
Rules: use ONLY the material given. Every paragraph with concrete claims cites its sources as [S#] (only [S#]; never [E#] or [F#]). Never invent numbers, quotes, names or dates.
Say clearly when something rests on one source or is uncertain. Neutral, plain wording: no hype or dramatic adjectives, no speculation presented as fact, no sentence that is not supported by the cited sources.
Explain terms. Short paragraphs. Write in English.`;

const OUTLINE_SCHEMA = { type: 'object', properties: { angle: { type: 'string' }, why: { type: 'string' }, sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, purpose: { type: 'string' }, use: { type: 'array', items: { type: 'string' } } }, required: ['heading', 'purpose', 'use'] } } }, required: ['angle', 'why', 'sections'] };
const HEAD_SCHEMA = { type: 'object', properties: { title: { type: 'string' }, standfirst: { type: 'string' } }, required: ['title', 'standfirst'] };
const VERIFY_SCHEMA = { type: 'object', properties: { paragraphs: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, verdict: { type: 'string', enum: ['supported', 'partial', 'unsupported'] }, issues: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, why: { type: 'string' } }, required: ['claim', 'why'] } } }, required: ['index', 'verdict', 'issues'] } } }, required: ['paragraphs'] };

/** The real model call: overloaded models (503) are retried with a pause, then the next model in the list is tried. */
export const liveModelCall: ModelCall = async (models, system, prompt, schema, maxTokens, purpose) => {
  let lastErr: unknown = null;
  const rounds = purpose === 'deepdive_verify' ? 6 : 3; // the independent verifier is overloaded now and then: wait for it instead of lowering the bar
  for (let round = 0; round < rounds; round += 1) {
    for (const model of models) {
      try {
        const { data, modelUsed } = await postGeminiGenerateContent({
          apiKey: process.env.GEMINI_API_KEY!.trim(), candidateModels: [model], priority: 'normal', statsTask: purpose, budgetPurpose: 'kb_deepdive', timeoutMs: 240_000,
          jsonSchemaWhenNoTools: schema ?? undefined,
          body: {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens, ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}) },
          },
        });
        const parts = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }).candidates?.[0]?.content?.parts ?? [];
        const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
        if (text.trim()) return { text, model: modelUsed };
        lastErr = new Error(`empty answer from ${model}`);
      } catch (err) {
        lastErr = err;
      }
    }
    await new Promise((r) => setTimeout(r, Math.min(120_000, 25_000 * (round + 1))));
  }
  throw lastErr instanceof Error ? lastErr : new Error('all models failed');
};

const parseJson = <T>(text: string): T => JSON.parse(text.replace(/```(?:json)?/g, '').trim()) as T;

const DEEPDIVE_VERIFY_CRITERIA: Record<string, string> = {
  supported: 'Every claim, number, name and date is explicitly stated by its cited [S#] sources',
  partial: 'Main claim is cited, but some wording, emphasis or inference goes beyond the cited [S#] sources',
  unsupported: 'Contains a claim, number, name or date not in the cited [S#] sources or contradicted by them',
};

/**
 * Verifies all target paragraphs of a deep dive in a single `gemini-decision-1` pass against their cited [S#] excerpts.
 * Strict quality gate: a `supported` choice with confidence < 0.80 is conservatively downgraded to `partial` so repair runs.
 */
export async function verifySectionsWithDecisions(
  sections: Section[],
  material: Material,
  only?: Set<string>,
): Promise<{ verdicts: Map<string, ParagraphVerdict>; model: string } | null> {
  if (!process.env.GEMINI_API_KEY?.trim() || process.env.KB_DEEPDIVE_DECISION === 'false') return null;
  const targets: Array<{ si: number; pi: number; key: string; qKey: string; text: string }> = [];
  for (const [si, s] of sections.entries()) {
    for (const [pi, text] of s.paragraphs.entries()) {
      const key = `${si}:${pi}`;
      if (only && !only.has(key)) continue;
      targets.push({ si, pi, key, qKey: `p_${si}_${pi}`, text });
    }
  }
  if (!targets.length) return { verdicts: new Map(), model: 'gemini-decision-1' };

  const needed = new Set(targets.flatMap((x) => citedSourceNumbers(x.text)));
  const contextLines = material.context.split('\n');
  const excerpts = [...needed]
    .filter((n) => n >= 1 && n <= material.docs.length)
    .map((n) => {
      const d = material.docs[n - 1]!;
      const line = contextLines.findIndex((l) => l.startsWith(`[S${n}]`));
      const text = line >= 0 ? (contextLines[line + 1] ?? '').trim() : '';
      return `[S${n}] ${d.source} (${d.pub}) "${d.title}"\n${text}`;
    });

  const questions: Record<string, DecisionQuestion> = {};
  for (const t of targets) {
    questions[t.qKey] = {
      type: 'choice',
      instructions: `Check paragraph [P_${t.si}_${t.pi}] strictly against its cited [S#] sources in SOURCES.`,
      criteria: DEEPDIVE_VERIFY_CRITERIA,
    };
  }

  const input =
    `You are a strict, independent fact-checker. Judge each paragraph ONLY against the [S#] sources it cites.\n\n` +
    `SOURCES (the only evidence):\n${excerpts.join('\n\n')}\n\n` +
    `PARAGRAPHS TO CHECK:\n${targets.map((t) => `[P_${t.si}_${t.pi}] ${t.text}`).join('\n\n')}`;

  const res = await postGeminiDecisions({
    input,
    questions,
    purpose: 'kb_deepdive',
    priority: 'normal',
    timeoutMs: 60_000,
  });

  const minConf = Number(process.env.KB_DEEPDIVE_DECISION_MIN_CONF) || 0.80;
  const verdicts = new Map<string, ParagraphVerdict>();
  for (const t of targets) {
    const ans = res.answers[t.qKey];
    const firstSentence = (t.text.split(/(?<=[.!?])\s+/)[0] ?? t.text).slice(0, 220);
    if (ans.choice === 'supported' && ans.confidence >= minConf) {
      verdicts.set(t.key, { index: t.pi, verdict: 'supported', issues: [] });
    } else if (ans.choice === 'supported') {
      verdicts.set(t.key, {
        index: t.pi,
        verdict: 'partial',
        issues: [{ claim: firstSentence, why: `low verification confidence (${ans.confidence.toFixed(2)}) against cited sources` }],
      });
    } else {
      verdicts.set(t.key, {
        index: t.pi,
        verdict: (ans.choice as 'partial' | 'unsupported') ?? 'unsupported',
        issues: [{ claim: firstSentence, why: `flagged as ${ans.choice} (conf=${ans.confidence.toFixed(2)}) against cited sources` }],
      });
    }
  }
  return { verdicts, model: res.modelUsed };
}

export interface SavedDraft { outline: { angle: string; why: string }; sections: Section[]; head: { title: string; standfirst: string }; models: string[]; material: Material }

export interface DeepDiveOutcome { status: 'published' | 'rejected' | 'deferred' | 'skipped'; reason?: string; newsId?: number; topic?: string; problems?: string[] }

@Injectable()
export class KbDeepDiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbDeepDiveService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;
  call: ModelCall = liveModelCall;
  translator: Translator = cheapTranslator;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    if (process.env.KB_DEEPDIVE !== 'true' || !process.env.GEMINI_API_KEY?.trim()) return;
    this.timer = setTimeout(() => void this.loop(), 10 * 60_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async loop() {
    try {
      const out = await this.runOnce();
      if (out.status !== 'skipped') this.logger.log(`Deep dive: ${JSON.stringify(out).slice(0, 400)}`);
    } catch (err) {
      this.logger.warn(`Deep dive failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!this.stopped) this.timer = setTimeout(() => void this.loop(), envInt('KB_DEEPDIVE_INTERVAL_MIN', 180, 30, 1440) * 60_000);
    }
  }

  private async writtenToday(): Promise<number> {
    const r = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM kb.deepdives WHERE status = 'published' AND started_at > date_trunc('day', now())`);
    return Number(r.rows[0]?.n ?? 0);
  }

  async pickTopic(): Promise<DeepTopic | null> {
    const sensitive = process.env.KB_DEEPDIVE_SENSITIVE === 'true';
    const recent = new Set((await this.db.query<{ topic_key: string }>(
      `SELECT topic_key FROM kb.deepdives WHERE (status IN ('published', 'writing') AND started_at > now() - interval '21 days')
          OR (status = 'rejected' AND started_at > now() - interval '3 days')
          OR (status = 'deferred' AND error LIKE 'not enough%' AND started_at > now() - interval '3 days')`)).rows.map((r) => r.topic_key));
    const topics: DeepTopic[] = [];
    const ents = (await this.db.query<{ id: string; name: string; kind: string; cat: string | null; n: string }>(
      `SELECT en.id, en.name, en.kind, (SELECT key FROM jsonb_each_text(COALESCE(en.category_prior, '{}'::jsonb)) ORDER BY value::float DESC LIMIT 1) AS cat,
              count(DISTINCT e.id) AS n
       FROM kb.entities en JOIN kb.event_entities ee ON ee.entity_id = en.id JOIN kb.events e ON e.id = ee.event_id
       WHERE en.status = 'active' AND en.kind IN ('company', 'product') AND e.last_seen_at > now() - interval '10 days'
       GROUP BY en.id HAVING count(DISTINCT e.id) >= 12 ORDER BY n DESC LIMIT 12`)).rows;
    for (const e of ents) {
      const category = e.cat && (CATEGORIES as readonly string[]).includes(e.cat) ? e.cat : 'global_tech';
      if (!sensitive && SENSITIVE_CATEGORIES.has(category)) continue;
      topics.push({ key: `entity:${e.id}`, kind: 'entity', entityId: Number(e.id), category, title: e.name,
        brief: `An in-depth explainer on ${e.name}: its role, its main relationships (partners, customers, investments, competitors), what has been happening around it recently, the risks and open questions. Build an original thesis from the material.` });
    }
    for (const category of ALLOWED_CATEGORY_TOPICS) {
      topics.push({ key: `category:${category}`, kind: 'category', category, title: category,
        brief: `An in-depth analysis of what is happening in the "${category}" area: the patterns across companies and products, who moves first, how announcements relate to each other, and what the evidence says (and does not say). Build an original thesis from the material.` });
    }
    return topics.find((t) => !recent.has(t.key)) ?? null;
  }

  async gather(topic: DeepTopic): Promise<Material | null> {
    const days = 10;
    const ids = (topic.kind === 'entity'
      ? (await this.db.query<{ id: string }>(
        `SELECT DISTINCT e.id, e.importance FROM kb.events e JOIN kb.event_entities ee ON ee.event_id = e.id
         WHERE ee.entity_id = $1 AND e.status <> 'merged' AND e.last_seen_at > now() - make_interval(days => $2) ORDER BY e.importance DESC NULLS LAST LIMIT 40`, [topic.entityId, days]))
      : (await this.db.query<{ id: string }>(
        `SELECT id FROM kb.events WHERE category = $1 AND status <> 'merged' AND last_seen_at > now() - make_interval(days => $2) ORDER BY importance DESC NULLS LAST LIMIT 40`, [topic.category, days]))
    ).rows.map((r) => Number(r.id));
    if (!ids.length) return null;
    const docs = (await this.db.query<{ source: string; pub: string; title: string; url: string; excerpt: string; root: string | null }>(
      `SELECT DISTINCT ON (COALESCE(d.evidence_root, d.id::text)) s.name AS source, to_char(d.published_at, 'YYYY-MM-DD') AS pub, d.title, d.url,
              left(COALESCE(NULLIF(d.body, ''), d.feed_summary, ''), 1700) AS excerpt, d.evidence_root AS root
       FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id LEFT JOIN public.sources s ON s.id = d.source_id
       WHERE ed.event_id = ANY($1::bigint[]) AND ed.role <> 'reprint' AND d.kind <> 'research' AND d.extraction_status IN ('full', 'partial')
         AND length(COALESCE(d.body, '')) > 600
       ORDER BY COALESCE(d.evidence_root, d.id::text), d.published_at DESC`, [ids])).rows.slice(0, 14);
    const origins = new Set(docs.map((d) => d.root ?? d.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0])).size;
    if (docs.length < envInt('KB_DEEPDIVE_MIN_DOCS', 8, 3, 14) || origins < envInt('KB_DEEPDIVE_MIN_ORIGINS', 5, 2, 14)) return null;
    const facts = (await this.db.query<{ sen: string; predicate: string; oen: string | null; object_text: string | null; value_num: string | null; value_unit: string | null; status: string; source_count: number }>(
      `SELECT s.name AS sen, f.predicate, o.name AS oen, f.object_text, f.value_num, f.value_unit, f.status, f.source_count
       FROM kb.facts f JOIN kb.claims c ON c.fact_id = f.id JOIN kb.entities s ON s.id = f.subject_entity_id LEFT JOIN kb.entities o ON o.id = f.object_entity_id
       WHERE c.event_id = ANY($1::bigint[]) GROUP BY f.id, s.id, o.id ORDER BY f.source_count DESC, max(c.confidence) DESC LIMIT 24`, [ids])).rows;
    const events = (await this.db.query<{ d: string; title: string }>(
      `SELECT to_char(COALESCE(started_at, first_seen_at), 'YYYY-MM-DD') AS d, title FROM kb.events WHERE id = ANY($1::bigint[]) ORDER BY COALESCE(started_at, first_seen_at) LIMIT 40`, [ids])).rows;
    const lines = [`TOPIC: ${topic.title}`, `BRIEF: ${topic.brief}`, '', 'SOURCES (cite only as [S#]):'];
    docs.forEach((d, i) => lines.push(`[S${i + 1}] ${d.source} (${d.pub}) "${d.title}"\n    ${String(d.excerpt).replace(/\s+/g, ' ')}`));
    lines.push('', 'FACTS EXTRACTED BY ALGORITHMS (background only, do not cite):');
    facts.forEach((f) => lines.push(`- ${f.sen} — ${f.predicate} — ${f.oen ?? f.object_text ?? ''}${f.value_num ? ` (${f.value_num} ${f.value_unit ?? ''})` : ''} | ${f.status}, sources=${f.source_count}`));
    lines.push('', 'EVENTS IN THE KNOWLEDGE BASE, chronological (background only, do not cite):');
    events.forEach((e) => lines.push(`- ${e.d} — ${e.title}`));
    return { context: lines.join('\n'), docs: docs.map((d) => ({ source: d.source, pub: d.pub, title: d.title, url: d.url, evidenceRoot: d.root })), origins, events: events.length };
  }

  /** Independent verification of every paragraph against the sources it cites (a different model family than the writer). */
  async verify(sections: Section[], material: Material, only?: Set<string>): Promise<{ verdicts: Map<string, ParagraphVerdict>; model: string }> {
    if (this.call === liveModelCall && process.env.KB_DEEPDIVE_DECISION !== 'false' && process.env.GEMINI_API_KEY?.trim()) {
      const decided = await verifySectionsWithDecisions(sections, material, only).catch(() => null);
      if (decided) return decided;
    }
    const verdicts = new Map<string, ParagraphVerdict>();
    let model = '';
    for (const [si, s] of sections.entries()) {
      const items = s.paragraphs.map((text, pi) => ({ pi, text, key: `${si}:${pi}` })).filter((x) => !only || only.has(x.key));
      if (!items.length) continue;
      const needed = new Set(items.flatMap((x) => citedSourceNumbers(x.text)));
      const excerpts = [...needed].filter((n) => n <= material.docs.length).map((n) => {
        const d = material.docs[n - 1]!;
        const line = material.context.split('\n').findIndex((l) => l.startsWith(`[S${n}]`));
        const text = line >= 0 ? (material.context.split('\n')[line + 1] ?? '').trim() : '';
        return `[S${n}] ${d.source} (${d.pub}) "${d.title}"\n${text}`;
      });
      const prompt = `SOURCES (the only evidence):\n${excerpts.join('\n\n')}\n\nPARAGRAPHS TO CHECK:\n${items.map((x, i) => `#${i} ${x.text}`).join('\n\n')}\n\n`
        + 'For EACH paragraph decide: "supported" (every claim is stated by the sources it cites), "partial" (some wording goes beyond the sources: added emphasis, an inference, a generalisation) or "unsupported" (a claim is not in the cited sources, is contradicted, or is a number/name/date that differs). '
        + 'List each problematic claim with the reason. Be strict: an inference or generalisation the sources do not state is at best "partial". Return JSON {"paragraphs":[{"index":<#>,"verdict":...,"issues":[{"claim":...,"why":...}]}]}.';
      const res = await this.call(VERIFY_MODELS, 'You are a strict, independent fact-checker. You judge only against the supplied sources.', prompt, VERIFY_SCHEMA, 4000, 'deepdive_verify');
      model = res.model;
      const parsed = parseJson<{ paragraphs: ParagraphVerdict[] }>(res.text);
      for (const v of parsed.paragraphs ?? []) {
        const it = items[v.index];
        if (it) verdicts.set(it.key, { ...v, index: it.pi });
      }
    }
    return { verdicts, model };
  }

  /** The whole pipeline for one topic. Every failure path discards the draft. */
  async write(topic: DeepTopic, material: Material, deepdiveId: number, resume?: SavedDraft): Promise<DeepDiveOutcome> {
    const models: string[] = resume ? [...resume.models] : [];
    if (resume) return this.finish(topic, material, deepdiveId, models, resume.outline, resume.sections, resume.head);
    return this.draftAndFinish(topic, material, deepdiveId, models);
  }

  /** Writes the draft (outline, sections, plain headline), saves it, then runs the gates and the independent verification. */
  private async draftAndFinish(topic: DeepTopic, material: Material, deepdiveId: number, models: string[]): Promise<DeepDiveOutcome> {
    const planModels = (await remainingLlmCalls('gemini-3.6-flash', 'kb_deepdive').catch(() => 0)) >= 3 ? ['gemini-3.6-flash', ...WRITE_MODELS] : WRITE_MODELS;
    const outlineRes = await this.call(planModels, WRITER_SYSTEM, `${material.context}\n\nPlan an in-depth article (1500-2200 words, 5-6 sections) on this topic. Choose an ORIGINAL angle that the material can truly support (a thesis, not a news summary).\nFor each section state its purpose and which sources ([S#]) it will use. Return JSON.`, OUTLINE_SCHEMA, 3000, 'deepdive_outline');
    models.push(outlineRes.model);
    const outline = parseJson<{ angle: string; why: string; sections: Array<{ heading: string; purpose: string; use: string[] }> }>(outlineRes.text);
    const sections: Section[] = [];
    for (const [i, s] of outline.sections.slice(0, 6).entries()) {
      const prev = sections.map((x) => x.paragraphs.join('\n\n')).join('\n\n').slice(-1800);
      const w = await this.call(WRITE_MODELS, WRITER_SYSTEM, `${material.context}\n\nARTICLE ANGLE: ${outline.angle}\nYou are writing section ${i + 1} of ${outline.sections.length}: "${s.heading}".\nPurpose: ${s.purpose}\nUse: ${(s.use ?? []).join(', ')}\n${prev ? `Previous text (do not repeat it):\n${prev}\n` : ''}\nWrite 260-380 words for THIS section only (no heading), 3-5 short paragraphs, with [S#] citations in every paragraph. Plain, neutral wording.`, null, 2500, 'deepdive_section');
      models.push(w.model);
      sections.push({ heading: s.heading, paragraphs: stripInternalRefs(w.text.trim()).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) });
    }
    const headRes = await this.call(WRITE_MODELS, WRITER_SYSTEM, `ARTICLE TEXT:\n${renderSections(sections).slice(0, 9000)}\n\nWrite a plain, descriptive, non-dramatic title (30-95 characters, no hype words) and a two-sentence standfirst that states only what the text supports. Return JSON.`, HEAD_SCHEMA, 600, 'deepdive_head');
    models.push(headRes.model);
    const head = parseJson<{ title: string; standfirst: string }>(headRes.text);
    return this.finish(topic, material, deepdiveId, models, { angle: outline.angle, why: outline.why }, sections, head);
  }

  /** Gates, verification, repair, translation, publication. The draft is stored first so a transient failure does not waste the writing. */
  private async finish(topic: DeepTopic, material: Material, deepdiveId: number, models: string[], outline: { angle: string; why: string }, sections: Section[], head: { title: string; standfirst: string }): Promise<DeepDiveOutcome> {

    const gate = () => deterministicGates({ title: head.title, standfirst: head.standfirst, body: renderSections(sections), sourcesAvailable: material.docs.length, material: material.context }, { minWords: envInt('KB_DEEPDIVE_MIN_WORDS', 1300, 600, 4000) });
    let g = gate();
    if (!g.ok) {
      // One automatic repair of the sections that carry the problems (uncited paragraphs, unknown numbers, hype).
      for (const [si, s] of sections.entries()) {
        const text = s.paragraphs.join('\n\n');
        const unk = g.stats.unknownNumbers.filter((n) => text.includes(n));
        const uncited = s.paragraphs.some((p) => countWords(p) >= 25 && citedSourceNumbers(p).length === 0);
        if (!unk.length && !uncited && !/\b(shatter|unprecedented|revolution|catastroph|staggering|monopol|chokepoint|panic|turmoil)/i.test(text)) continue;
        const fix = await this.call(WRITE_MODELS, WRITER_SYSTEM, `${material.context}\n\nRewrite this section so that: every paragraph cites [S#] for its claims; every number appears in the sources (remove ${unk.join(', ') || 'none'} unless the sources state it); wording is plain and neutral (no dramatic adjectives); nothing is added that the sources do not say. Keep the length.\n\nSECTION "${s.heading}":\n${text}`, null, 2500, 'deepdive_repair');
        models.push(fix.model);
        sections[si] = { heading: s.heading, paragraphs: stripInternalRefs(fix.text.trim()).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean) };
      }
      g = gate();
      if (!g.ok) return { status: 'rejected', reason: 'deterministic gates', problems: g.problems };
    }

    await this.db.query(`UPDATE kb.deepdives SET review = jsonb_set(review, '{draft}', $2::jsonb, true) WHERE id = $1`,
      [deepdiveId, JSON.stringify({ outline, sections, head, models, material })]).catch(() => undefined);
    let { verdicts, model: verifier } = await this.verify(sections, material);
    const total = sections.reduce((n, s) => n + s.paragraphs.length, 0);
    let v = verificationPasses([...verdicts.values()], total);
    if (!v.ok) {
      const flagged = new Set([...verdicts.entries()].filter(([, x]) => x.verdict !== 'supported').map(([k]) => k));
      for (const key of flagged) {
        const [si, pi] = key.split(':').map(Number) as [number, number];
        const issues = verdicts.get(key)!.issues.map((x) => `- ${x.claim} (${x.why})`).join('\n');
        const cited = citedSourceNumbers(sections[si]!.paragraphs[pi]!);
        const fix = await this.call(WRITE_MODELS, WRITER_SYSTEM, `${material.context}\n\nRewrite ONLY this paragraph so every claim is stated by the sources it cites; remove or correct these flagged claims:\n${issues}\nCite [S#] (prefer ${cited.map((n) => `S${n}`).join(', ') || 'the relevant sources'}). Plain wording, no additions. Return the paragraph only.\n\nPARAGRAPH:\n${sections[si]!.paragraphs[pi]}`, null, 900, 'deepdive_repair');
        models.push(fix.model);
        sections[si]!.paragraphs[pi] = stripInternalRefs(fix.text.trim());
      }
      ({ verdicts, model: verifier } = await this.verify(sections, material, flagged));
      // the rest were fine before; only the repaired paragraphs are judged again
      const all = new Map<string, ParagraphVerdict>();
      sections.forEach((s, si) => s.paragraphs.forEach((_p, pi) => { all.set(`${si}:${pi}`, verdicts.get(`${si}:${pi}`) ?? { index: pi, verdict: 'supported', issues: [] }); }));
      v = verificationPasses([...all.values()], total);
      g = gate();
      if (!v.ok || !g.ok) return { status: 'rejected', reason: 'verification failed after repair', problems: [...g.problems, `unsupported=${v.unsupported}`, `partial=${v.partial}`] };
    }
    models.push(verifier);

    // Final text: numbered citations of the cited sources only.
    const docsAsSources = material.docs.map((d) => ({ title: `${d.source}: ${d.title}`.slice(0, 240), url: d.url, evidenceRoot: d.evidenceRoot, sourceName: d.source }));
    const mapped = remapCitations(renderSections(sections), docsAsSources);
    const body = mapped.body;
    const facts = parseSections(body).flatMap((s) => s.paragraphs.slice(0, 1)).slice(0, 6).map((p) => {
      const first = p.split(/(?<=[.!?])\s+/)[0] ?? p;
      const nums = [...first.matchAll(/\[(\d+)(?:,\s*\d+)*\]/g)].map((m) => Number(m[1]));
      const url = mapped.sources[(nums[0] ?? 1) - 1]?.url ?? mapped.sources[0]!.url;
      return { claim: first.replace(/\s*\[[\d,\s]+\]/g, '').slice(0, 700), status: (citedSourceNumbers(first).length >= 2 || /\[\d+,\s*\d+/.test(first)) ? 'confirmed' as const : 'unverified' as const, url };
    });
    const category = (CATEGORIES as readonly string[]).includes(topic.category) ? topic.category : 'global_tech';
    const why = outline.why.slice(0, 1400) || head.standfirst;
    const validated = validateArticle({
      title: head.title, summary: head.standfirst.slice(0, 2400), body: body.slice(0, 20_000), important: false, importance_reason: why, category,
      sources: mapped.sources.map((s) => ({ title: s.title, url: s.url })), facts, comparisons: [], confidence: 'medium',
      editorial: { angles: [outline.angle.slice(0, 100)], style: 'deep dive', limitations: 'Written automatically from the collected sources; every paragraph was checked against the sources it cites.' },
    }, mapped.sources[0]!.url);

    const uk = await this.translator('uk', { title: head.title, summary: head.standfirst, why }, body).catch(() => null);
    if (!uk || translationTooShort(body, uk.body)) return { status: 'deferred', reason: 'translation unavailable', problems: [] };

    const hash = createHash('sha256').update(`${validated.title}\n${validated.body}`).digest('hex');
    const article = { ...validated, canonical_lang: 'en', title_uk: uk.title, summary_uk: uk.summary, why_it_matters_uk: uk.why, body_uk: uk.body };
    const metadata = {
      editorial_fingerprint: `deepdive:${hash}`, model: models[0], researched: true, grounding: [], article, editorial_tier: 'deepdive',
      kb: {
        tier: 'deepdive', checks_passed: true, awaiting_translation: false, generated_at: new Date().toISOString(), translation_model: uk.model,
        review: { state: 'approved', verdict: 'ok', issues: [], article_hash: hash, independent_verifier: verifier },
        deepdive: { topic: topic.key, models: [...new Set(models)], gates: g.stats, verification: { unsupported: v.unsupported, partial: v.partial, paragraphs: total }, material: { docs: material.docs.length, origins: material.origins, events: material.events } },
      },
    };
    const src = (await this.db.query<{ id: string }>(`SELECT id FROM sources WHERE slug = 'kb-deepdive'`)).rows[0];
    if (!src) throw new Error('source kb-deepdive missing (migration 042)');
    const row = (await this.db.query<{ id: string }>(
      `INSERT INTO news_items (source_id, external_id, url, canonical_url, original_title, original_summary, title_uk, summary_uk, why_it_matters, category, importance, free_access,
                               published_at, ai_metadata, content_hash, status, cluster_id, cluster_sources, ai_generated, editorial_tier)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, 'low', 'unknown', now(), $10::jsonb, $11, 'published', $12, $13::jsonb, true, 'deepdive')
       RETURNING id`,
      [src.id, `deepdive-${deepdiveId}`, mapped.sources[0]!.url, head.title.slice(0, 350), head.standfirst.slice(0, 2000), uk.title.slice(0, 350), uk.summary.slice(0, 2500),
        uk.why.slice(0, 1500), category, JSON.stringify(metadata), hash, `deepdive-${deepdiveId}`,
        JSON.stringify(mapped.sources.map((s, i) => ({ id: `deepdive-src-${i}`, title: s.title, url: s.url, canonicalUrl: s.url, sourceName: s.sourceName, evidenceRoot: s.evidenceRoot, extraction: 'full' })))],
    )).rows[0]!;
    return { status: 'published', newsId: Number(row.id), topic: topic.key };
  }

  async runOnce(force = false): Promise<DeepDiveOutcome> {
    if (this.running) return { status: 'skipped', reason: 'already running' };
    this.running = true;
    try {
      if (!force && (await this.writtenToday()) >= envInt('KB_DEEPDIVE_DAILY', 1, 1, 6)) return { status: 'skipped', reason: 'daily cap reached' };
      const resumable = (await this.db.query<{ id: string; topic: DeepTopic; draft: SavedDraft }>(
        `SELECT id, topic, review->'draft' AS draft FROM kb.deepdives
         WHERE status = 'deferred' AND review->'draft' IS NOT NULL AND started_at > now() - interval '12 hours'
           AND COALESCE((review->>'resumes')::int, 0) < 3 ORDER BY id DESC LIMIT 1`)).rows[0];
      if (resumable) {
        await this.db.query(`UPDATE kb.deepdives SET status = 'writing', review = jsonb_set(review, '{resumes}', to_jsonb(COALESCE((review->>'resumes')::int, 0) + 1)) WHERE id = $1`, [resumable.id]);
        let outcome: DeepDiveOutcome;
        try {
          outcome = await this.write(resumable.topic, resumable.draft.material, Number(resumable.id), resumable.draft);
        } catch (err) {
          outcome = { status: 'deferred', reason: err instanceof Error ? err.message.slice(0, 300) : String(err) };
        }
        await this.db.query(`UPDATE kb.deepdives SET status = $2, news_id = $3, error = $4, finished_at = now() WHERE id = $1`, [resumable.id, outcome.status === 'skipped' ? 'deferred' : outcome.status, outcome.newsId ?? null, outcome.reason ?? null]);
        return { ...outcome, topic: resumable.topic.key };
      }
      const topic = await this.pickTopic();
      if (!topic) return { status: 'skipped', reason: 'no eligible topic' };
      const material = await this.gather(topic);
      if (!material) {
        await this.db.query(`INSERT INTO kb.deepdives (topic_key, topic, status, error, finished_at) VALUES ($1, $2::jsonb, 'deferred', 'not enough independent material', now())`, [topic.key, JSON.stringify(topic)]);
        return { status: 'deferred', reason: 'not enough independent material', topic: topic.key };
      }
      const id = Number((await this.db.query<{ id: string }>(`INSERT INTO kb.deepdives (topic_key, topic) VALUES ($1, $2::jsonb) RETURNING id`, [topic.key, JSON.stringify(topic)])).rows[0]!.id);
      let outcome: DeepDiveOutcome;
      try {
        outcome = await this.write(topic, material, id);
      } catch (err) {
        outcome = { status: 'deferred', reason: err instanceof Error ? err.message.slice(0, 300) : String(err) };
      }
      await this.db.query(
        `UPDATE kb.deepdives SET status = $2, news_id = $3, error = $4, review = review || $5::jsonb, finished_at = now() WHERE id = $1`,
        [id, outcome.status === 'skipped' ? 'deferred' : outcome.status, outcome.newsId ?? null, outcome.reason ?? null, JSON.stringify({ problems: outcome.problems ?? [] })],
      );
      return { ...outcome, topic: topic.key };
    } finally {
      this.running = false;
    }
  }
}
