import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { generateJsonWithRouter, generateWithRouter, parseJsonLoose } from '../common/llm-router';
import { readEnv } from '../common/r2-storage';
import { DatabaseService } from '../database/database.service';

/**
 * Long-lived topics ("NBU key rate", "EU accession talks"). Every edited article names its topic; this service
 * keeps one explainer per topic (essence in 60 seconds, timeline, who is who, glossary, positions, open questions),
 * builds the "what changed since your last visit" digest and checks predictions against later reporting.
 */

export interface TopicExplainer {
  essence: string;
  currentState: string;
  timeline: Array<{ when: string; event: string }>;
  players: Array<{ name: string; role: string }>;
  glossary: Array<{ term: string; explanation: string }>;
  positions: Array<{ side: string; position: string }>;
  unknowns: string[];
}

const pair = (a: string, b: string) => ({
  type: 'array',
  items: { type: 'object', properties: { [a]: { type: 'string' }, [b]: { type: 'string' } }, required: [a, b] },
});

const explainerSchema = {
  type: 'object',
  properties: {
    essence: { type: 'string' },
    currentState: { type: 'string' },
    timeline: pair('when', 'event'),
    players: pair('name', 'role'),
    glossary: pair('term', 'explanation'),
    positions: pair('side', 'position'),
    unknowns: { type: 'array', items: { type: 'string' } },
  },
  required: ['essence', 'currentState', 'timeline', 'players', 'glossary', 'positions', 'unknowns'],
};

const topicSchema = {
  type: 'object',
  properties: { title_uk: { type: 'string' }, en: explainerSchema, uk: explainerSchema },
  required: ['title_uk', 'en', 'uk'],
};

const PREDICTION_STATUSES = ['came_true', 'partly', 'did_not_happen', 'unclear'] as const;
type PredictionStatus = (typeof PREDICTION_STATUSES)[number];

const predictionCheckSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: [...PREDICTION_STATUSES, 'too_early'] },
    evidence_index: { type: 'integer' },
    note: { type: 'string' },
  },
  required: ['status', 'evidence_index', 'note'],
};

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[ \t]+/g, ' ').trim().slice(0, max) : '';
}

function pairs<A extends string, B extends string>(v: unknown, a: A, b: B, max: number): Array<Record<A | B, string>> {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
    .map((x) => ({ [a]: clean(x[a], 200), [b]: clean(x[b], 600) }) as Record<A | B, string>)
    .filter((x) => x[a] && x[b])
    .slice(0, max);
}

export function normalizeExplainer(raw: unknown): TopicExplainer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const essence = clean(r.essence, 1200);
  if (!essence) return null;
  return {
    essence,
    currentState: clean(r.currentState, 1200),
    timeline: pairs(r.timeline, 'when', 'event', 14),
    players: pairs(r.players, 'name', 'role', 10),
    glossary: pairs(r.glossary, 'term', 'explanation', 10),
    positions: pairs(r.positions, 'side', 'position', 6),
    unknowns: Array.isArray(r.unknowns) ? r.unknowns.map((u) => clean(u, 400)).filter(Boolean).slice(0, 6) : [],
  };
}

/** Accuracy over resolved predictions; "partly" counts half, "unclear" is excluded. */
export function predictionAccuracy(counts: Partial<Record<string, number>>) {
  const cameTrue = counts.came_true ?? 0;
  const partly = counts.partly ?? 0;
  const missed = counts.did_not_happen ?? 0;
  const resolved = cameTrue + partly + missed;
  return {
    pending: counts.pending ?? 0,
    cameTrue,
    partly,
    didNotHappen: missed,
    unclear: counts.unclear ?? 0,
    resolved,
    accuracy: resolved > 0 ? Math.round(((cameTrue + partly * 0.5) / resolved) * 1000) / 1000 : null,
  };
}

type Lang = 'uk' | 'en';

@Injectable()
export class TopicsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TopicsService.name);
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private running = false;

  constructor(@Optional() private readonly db?: DatabaseService) {}

  onModuleInit(): void {
    const anyLlm = Boolean(process.env.GEMINI_API_KEY?.trim() || readEnv('groq_api_key') || readEnv('openrouter_api_key'));
    if (process.env.NODE_ENV === 'test' || !this.db || !anyLlm || process.env.TOPICS_ENABLED === 'false') return;
    const intervalMs = Math.max(15 * 60_000, Number(process.env.TOPIC_REFRESH_INTERVAL_MS) || 45 * 60_000);
    const loop = (delay: number) => {
      this.timer = setTimeout(async () => {
        if (this.destroyed) return;
        try {
          await this.refreshTopicExplainers();
          await this.checkDuePredictions();
        } catch (err) {
          this.logger.warn(`Topic refresh failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.destroyed) loop(intervalMs);
        }
      }, delay);
    };
    loop(6 * 60_000);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private dailyMax(): number {
    const n = Number(process.env.TOPIC_SUMMARY_DAILY_MAX);
    return Number.isInteger(n) && n >= 0 && n <= 200 ? n : 30;
  }

  /** Regenerates explainers of active topics that received new articles since their last explainer. */
  async refreshTopicExplainers(maxThisRun = 3): Promise<{ generated: number }> {
    if (!this.db || this.running) return { generated: 0 };
    this.running = true;
    let generated = 0;
    try {
      const { rows: usage } = await this.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM topics WHERE summarized_at >= date_trunc('day', now())`,
      );
      const remaining = Math.max(0, this.dailyMax() - (usage[0]?.n ?? 0));
      if (!remaining) return { generated };
      const { rows } = await this.db.query<{ slug: string; title_en: string; title_uk: string | null }>(
        `SELECT slug, title_en, title_uk FROM topics
         WHERE news_count >= 2 AND news_count > summary_news_count
           AND last_news_at >= now() - interval '21 days'
         ORDER BY news_count - summary_news_count DESC, last_news_at DESC
         LIMIT $1`,
        [Math.min(maxThisRun, remaining)],
      );
      for (const topic of rows) {
        if (this.destroyed) break;
        const ok = await this.generateExplainer(topic.slug, topic.title_en).catch((err) => {
          this.logger.warn(`Topic ${topic.slug} failed: ${err instanceof Error ? err.message : err}`);
          return false;
        });
        if (ok) generated += 1;
      }
    } finally {
      this.running = false;
    }
    return { generated };
  }

  private async generateExplainer(slug: string, titleEn: string): Promise<boolean> {
    if (!this.db) return false;
    const { rows } = await this.db.query<{
      title: string; summary: string | null; published_at: Date | null; source_name: string; insight: Record<string, unknown> | null;
      update_en: string | null;
    }>(
      `SELECT COALESCE(n.ai_metadata->'article'->>'title', n.original_title) AS title,
              COALESCE(n.ai_metadata->'article'->>'summary', n.summary_uk, n.original_summary) AS summary,
              n.published_at, s.name AS source_name, n.ai_metadata->'article'->'insight' AS insight, tn.update_en
       FROM topic_news tn
       JOIN news_items n ON n.id = tn.news_id
       JOIN sources s ON s.id = n.source_id
       WHERE tn.topic_slug = $1 AND n.status = 'published'
       ORDER BY n.published_at DESC NULLS LAST
       LIMIT 18`,
      [slug],
    );
    if (rows.length < 2) return false;
    const material = rows
      .slice()
      .reverse()
      .map((r, i) => {
        const date = r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : 'n/a';
        const positions = Array.isArray(r.insight?.positions)
          ? (r.insight!.positions as Array<{ side?: string; position?: string }>).map((p) => `${p.side}: ${p.position}`).join(' | ')
          : '';
        return `[${i + 1}] ${date} · ${r.source_name}: ${r.title}\n    ${(r.summary || '').replace(/\s+/g, ' ').slice(0, 500)}${positions ? `\n    Positions: ${positions.slice(0, 500)}` : ''}`;
      })
      .join('\n');

    const prompt = `You maintain the explainer page of a long-running news topic in an objective news app: "${titleEn}".
Below are our published articles on this topic, oldest first. Use ONLY facts from this material; never invent facts, dates or numbers.

${material}

Write the explainer twice: "en" in natural English and "uk" in natural modern Ukrainian. For each:
- essence: what this topic is about and why it matters, readable in 60 seconds by someone who knows nothing (4–6 sentences)
- currentState: where things stand right now (2–3 sentences, most recent facts)
- timeline: key moments oldest first (when = date as written in the material)
- players: who is involved and their role
- glossary: terms a newcomer needs, one plain sentence each
- positions: each side's position in its strongest, fair form (empty if not controversial); no verdicts, no false balance
- unknowns: open questions not yet answered by the material
Also give title_uk: the topic name in Ukrainian.`;

    const routed = await generateWithRouter({
      task: 'story',
      prompt,
      schema: topicSchema,
      schemaName: 'topic_explainer',
      maxTokens: 5000,
      temperature: 0.25,
      timeoutMs: 75_000,
    });
    if (!routed) return false;
    const parsed = parseJsonLoose(routed.text) as { title_uk?: unknown; en?: unknown; uk?: unknown };
    const en = normalizeExplainer(parsed.en);
    const uk = normalizeExplainer(parsed.uk);
    if (!en || !uk) return false;
    await this.db.query(
      `UPDATE topics SET summary = $2::jsonb, summary_model = $3, summarized_at = now(),
              summary_news_count = news_count, title_uk = COALESCE(NULLIF($4, ''), title_uk), updated_at = now()
       WHERE slug = $1`,
      [slug, JSON.stringify({ en, uk }), `${routed.provider}:${routed.model}`, clean(parsed.title_uk, 160)],
    );
    return true;
  }

  /** Predictions past their date (or 45 days old without one) are checked against newer articles in their topic. */
  async checkDuePredictions(maxThisRun = 6): Promise<{ checked: number }> {
    if (!this.db) return { checked: 0 };
    const { rows } = await this.db.query<{
      id: string; statement_en: string; due_date: Date | null; created_at: Date; topic_slug: string | null; news_id: string;
    }>(
      `SELECT id::text, statement_en, due_date, created_at, topic_slug, news_id::text
       FROM predictions
       WHERE status = 'pending'
         AND (due_date <= current_date OR (due_date IS NULL AND created_at <= now() - interval '45 days'))
         AND (checked_at IS NULL OR checked_at <= now() - interval '3 days')
       ORDER BY due_date ASC NULLS LAST, created_at ASC
       LIMIT $1`,
      [maxThisRun],
    ).catch(() => ({ rows: [] as Array<{ id: string; statement_en: string; due_date: Date | null; created_at: Date; topic_slug: string | null; news_id: string }> }));
    let checked = 0;
    for (const p of rows) {
      if (this.destroyed) break;
      const { rows: evidence } = await this.db.query<{ id: string; title: string; summary: string | null; published_at: Date | null; source_name: string }>(
        `SELECT n.id::text, COALESCE(n.ai_metadata->'article'->>'title', n.original_title) AS title,
                COALESCE(n.ai_metadata->'article'->>'summary', n.summary_uk) AS summary, n.published_at, s.name AS source_name
         FROM news_items n JOIN sources s ON s.id = n.source_id
         WHERE n.status = 'published' AND n.published_at > $2
           AND ($1::text IS NOT NULL AND n.id IN (SELECT news_id FROM topic_news WHERE topic_slug = $1))
         ORDER BY n.published_at DESC LIMIT 10`,
        [p.topic_slug, p.created_at],
      );
      const daysPastDue = p.due_date ? (Date.now() - new Date(p.due_date).getTime()) / 86_400_000 : 0;
      if (evidence.length === 0) {
        // Nothing newer was reported: after a month past the date we stop waiting and say so honestly.
        const giveUp = daysPastDue > 30 || (!p.due_date && Date.now() - new Date(p.created_at).getTime() > 90 * 86_400_000);
        await this.db.query(
          `UPDATE predictions SET checked_at = now(), status = CASE WHEN $2 THEN 'unclear' ELSE status END,
                  check_note = CASE WHEN $2 THEN 'No later reporting found to confirm or refute this.' ELSE check_note END
           WHERE id = $1::bigint`,
          [p.id, giveUp],
        );
        continue;
      }
      const list = evidence
        .map((e, i) => `[${i + 1}] ${e.published_at ? new Date(e.published_at).toISOString().slice(0, 10) : ''} ${e.source_name}: ${e.title}\n    ${(e.summary || '').replace(/\s+/g, ' ').slice(0, 400)}`)
        .join('\n');
      const res = await generateJsonWithRouter<{ status?: string; evidence_index?: number; note?: string }>({
        task: 'classify',
        prompt: `An earlier article expected: "${p.statement_en}"${p.due_date ? ` (by ${new Date(p.due_date).toISOString().slice(0, 10)})` : ''}.
Later reporting:
${list}

Did it happen? status: came_true | partly | did_not_happen | unclear (reporting does not say) | too_early (date not reached and no answer yet).
evidence_index: the number of the article that shows it (0 if none). note: one neutral sentence in English.`,
        schema: predictionCheckSchema,
        schemaName: 'prediction_check',
        maxTokens: 300,
        temperature: 0,
        timeoutMs: 30_000,
      }).catch(() => null);
      if (!res) continue;
      const status = res.data.status;
      const idx = Number(res.data.evidence_index);
      const evidenceId = Number.isInteger(idx) && idx >= 1 && idx <= evidence.length ? evidence[idx - 1].id : null;
      if ((PREDICTION_STATUSES as readonly string[]).includes(String(status))) {
        await this.db.query(
          `UPDATE predictions SET status = $2, check_note = $3, evidence_news_id = $4::bigint, checked_at = now() WHERE id = $1::bigint`,
          [p.id, status as PredictionStatus, clean(res.data.note, 500), evidenceId],
        );
        checked += 1;
      } else {
        await this.db.query(`UPDATE predictions SET checked_at = now() WHERE id = $1::bigint`, [p.id]);
      }
    }
    return { checked };
  }

  async list(lang: Lang, limit = 20) {
    if (!this.db) return [];
    const { rows } = await this.db
      .query<{ slug: string; title_en: string; title_uk: string | null; category: string | null; news_count: number; last_news_at: Date | null; summary: Record<string, TopicExplainer> }>(
        `SELECT slug, title_en, title_uk, category, news_count, last_news_at, summary
         FROM topics WHERE news_count >= 2
         ORDER BY last_news_at DESC NULLS LAST LIMIT $1`,
        [limit],
      )
      .catch(() => ({ rows: [] as Array<{ slug: string; title_en: string; title_uk: string | null; category: string | null; news_count: number; last_news_at: Date | null; summary: Record<string, TopicExplainer> }> }));
    return rows.map((r) => ({
      slug: r.slug,
      title: lang === 'en' ? r.title_en : r.title_uk || r.title_en,
      category: r.category,
      newsCount: r.news_count,
      lastNewsAt: r.last_news_at,
      essence: (r.summary?.[lang] as TopicExplainer | undefined)?.essence ?? null,
    }));
  }

  async get(slug: string, lang: Lang) {
    if (!this.db) return null;
    const { rows } = await this.db
      .query<{ slug: string; title_en: string; title_uk: string | null; category: string | null; news_count: number; first_news_at: Date | null; last_news_at: Date | null; summary: Record<string, TopicExplainer>; summarized_at: Date | null; summary_model: string | null }>(
        `SELECT slug, title_en, title_uk, category, news_count, first_news_at, last_news_at, summary, summarized_at, summary_model
         FROM topics WHERE slug = $1`,
        [slug],
      )
      .catch(() => ({ rows: [] as never[] }));
    const t = rows[0];
    if (!t) return null;
    const [{ rows: news }, { rows: predictions }] = await Promise.all([
      this.db.query<{ id: string; title: string; source_name: string; source_slug: string; published_at: Date | null; update_text: string | null; url: string }>(
        `SELECT n.id::text, ${lang === 'en' ? `COALESCE(n.ai_metadata->'article'->>'title', n.original_title)` : `COALESCE(n.title_uk, n.original_title)`} AS title,
                s.name AS source_name, s.slug AS source_slug, n.published_at, n.url,
                ${lang === 'en' ? 'tn.update_en' : 'COALESCE(tn.update_uk, tn.update_en)'} AS update_text
         FROM topic_news tn JOIN news_items n ON n.id = tn.news_id JOIN sources s ON s.id = n.source_id
         WHERE tn.topic_slug = $1 AND n.status = 'published'
         ORDER BY n.published_at DESC NULLS LAST LIMIT 40`,
        [slug],
      ),
      this.db.query<{ id: string; statement: string; due_date: Date | null; status: string; check_note: string | null; news_id: string }>(
        `SELECT id::text, ${lang === 'en' ? 'statement_en' : 'COALESCE(statement_uk, statement_en)'} AS statement, due_date, status, check_note, news_id::text
         FROM predictions WHERE topic_slug = $1 ORDER BY COALESCE(due_date, created_at::date) DESC LIMIT 20`,
        [slug],
      ),
    ]);
    return {
      slug: t.slug,
      title: lang === 'en' ? t.title_en : t.title_uk || t.title_en,
      category: t.category,
      newsCount: t.news_count,
      firstNewsAt: t.first_news_at,
      lastNewsAt: t.last_news_at,
      explainer: (t.summary?.[lang] as TopicExplainer | undefined) ?? null,
      explainerUpdatedAt: t.summarized_at,
      explainerModel: t.summary_model,
      updates: news.filter((n) => n.update_text).slice(0, 12).map((n) => ({ newsId: n.id, at: n.published_at, text: n.update_text })),
      news: news.map((n) => ({ id: n.id, title: n.title, sourceName: n.source_name, sourceSlug: n.source_slug, publishedAt: n.published_at, url: n.url })),
      predictions: predictions.map((p) => ({ id: p.id, statement: p.statement, dueDate: p.due_date, status: p.status, note: p.check_note, newsId: p.news_id })),
    };
  }

  async topicForNews(newsId: string, lang: Lang) {
    if (!this.db || !/^\d{1,18}$/.test(newsId)) return null;
    const { rows } = await this.db
      .query<{ slug: string; title_en: string; title_uk: string | null; news_count: number }>(
        `SELECT t.slug, t.title_en, t.title_uk, t.news_count FROM topic_news tn JOIN topics t ON t.slug = tn.topic_slug
         WHERE tn.news_id = $1::bigint LIMIT 1`,
        [newsId],
      )
      .catch(() => ({ rows: [] as never[] }));
    const r = rows[0];
    return r ? { slug: r.slug, title: lang === 'en' ? r.title_en : r.title_uk || r.title_en, newsCount: r.news_count } : null;
  }

  /** "Since your last visit": per topic, the one-line updates published after `since`, biggest topics first. */
  async changesSince(since: Date, lang: Lang, limitTopics = 6) {
    if (!this.db) return { since: since.toISOString(), topics: [], newArticles: 0 };
    const { rows } = await this.db
      .query<{ slug: string; title: string; news_id: string; update_text: string | null; published_at: Date | null; total: number }>(
        `WITH fresh AS (
           SELECT tn.topic_slug, tn.news_id, tn.published_at,
                  ${lang === 'en' ? 'tn.update_en' : 'COALESCE(tn.update_uk, tn.update_en)'} AS update_text,
                  COUNT(*) OVER (PARTITION BY tn.topic_slug) AS total,
                  ROW_NUMBER() OVER (PARTITION BY tn.topic_slug ORDER BY tn.published_at DESC) AS rn
           FROM topic_news tn JOIN news_items n ON n.id = tn.news_id
           WHERE n.status = 'published' AND tn.published_at > $1
         )
         SELECT f.topic_slug AS slug, ${lang === 'en' ? 't.title_en' : 'COALESCE(t.title_uk, t.title_en)'} AS title,
                f.news_id::text, f.update_text, f.published_at, f.total::int
         FROM fresh f JOIN topics t ON t.slug = f.topic_slug
         WHERE f.rn <= 3
         ORDER BY f.total DESC, f.published_at DESC`,
        [since.toISOString()],
      )
      .catch(() => ({ rows: [] as Array<{ slug: string; title: string; news_id: string; update_text: string | null; published_at: Date | null; total: number }> }));
    const bySlug = new Map<string, { slug: string; title: string; total: number; updates: Array<{ newsId: string; text: string; at: Date | null }> }>();
    for (const r of rows) {
      const entry = bySlug.get(r.slug) ?? { slug: r.slug, title: r.title, total: r.total, updates: [] };
      if (r.update_text) entry.updates.push({ newsId: r.news_id, text: r.update_text, at: r.published_at });
      bySlug.set(r.slug, entry);
    }
    const { rows: countRows } = await this.db
      .query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM news_items WHERE status = 'published' AND published_at > $1`, [since.toISOString()])
      .catch(() => ({ rows: [{ n: 0 }] }));
    return {
      since: since.toISOString(),
      newArticles: countRows[0]?.n ?? 0,
      topics: [...bySlug.values()].filter((t) => t.updates.length > 0).slice(0, limitTopics),
    };
  }

  async predictionStats() {
    if (!this.db) return predictionAccuracy({});
    const { rows } = await this.db
      .query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM predictions GROUP BY status`)
      .catch(() => ({ rows: [] as Array<{ status: string; n: number }> }));
    return predictionAccuracy(Object.fromEntries(rows.map((r) => [r.status, r.n])));
  }

  async predictionsForNews(newsId: string, lang: Lang) {
    if (!this.db || !/^\d{1,18}$/.test(newsId)) return [];
    const { rows } = await this.db
      .query<{ id: string; statement: string; due_date: Date | null; status: string; check_note: string | null; evidence_news_id: string | null }>(
        `SELECT id::text, ${lang === 'en' ? 'statement_en' : 'COALESCE(statement_uk, statement_en)'} AS statement, due_date, status, check_note,
                evidence_news_id::text
         FROM predictions WHERE news_id = $1::bigint ORDER BY id`,
        [newsId],
      )
      .catch(() => ({ rows: [] as never[] }));
    return rows.map((p) => ({ id: p.id, statement: p.statement, dueDate: p.due_date, status: p.status, note: p.check_note, evidenceNewsId: p.evidence_news_id }));
  }
}
