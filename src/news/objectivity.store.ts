import { normalizePredictions, normalizeTopic } from '../ingest/gemini-editor.service';

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/**
 * Persists the long-lived parts of an edited article: its topic link (with a one-line update for the
 * topic log) and its checkable predictions. Runs inside the ingest transaction behind a savepoint, so a
 * database without migration 022 still ingests the article itself.
 */
export async function persistEditorialExtras(
  client: Queryable,
  newsId: string | number,
  article: unknown,
  category: string | null,
  publishedAt: string | null | undefined,
): Promise<void> {
  if (!article || typeof article !== 'object') return;
  const a = article as Record<string, unknown>;
  const topic = normalizeTopic(a.topic);
  const predictions = normalizePredictions(a.predictions);
  if (!topic && predictions.length === 0) return;

  await client.query('SAVEPOINT editorial_extras_sp');
  try {
    if (topic) {
      const when = publishedAt && Number.isFinite(Date.parse(publishedAt)) ? publishedAt : new Date().toISOString();
      await client.query(
        `INSERT INTO topics (slug, title_en, title_uk, category, first_news_at, last_news_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)
         ON CONFLICT (slug) DO UPDATE SET
           title_uk = COALESCE(topics.title_uk, EXCLUDED.title_uk),
           category = COALESCE(topics.category, EXCLUDED.category),
           first_news_at = LEAST(topics.first_news_at, EXCLUDED.first_news_at),
           last_news_at = GREATEST(topics.last_news_at, EXCLUDED.last_news_at),
           updated_at = now()`,
        [topic.key, topic.title_en, topic.title_uk, category, when],
      );
      await client.query(`DELETE FROM topic_news WHERE news_id = $1::bigint AND topic_slug <> $2`, [newsId, topic.key]);
      await client.query(
        `INSERT INTO topic_news (topic_slug, news_id, update_en, update_uk, published_at)
         VALUES ($1, $2::bigint, $3, $4, $5::timestamptz)
         ON CONFLICT (topic_slug, news_id) DO UPDATE SET update_en = EXCLUDED.update_en, update_uk = EXCLUDED.update_uk`,
        [topic.key, newsId, topic.update_en, topic.update_uk, when],
      );
      await client.query(
        `UPDATE topics SET news_count = (SELECT COUNT(*) FROM topic_news WHERE topic_slug = $1) WHERE slug = $1`,
        [topic.key],
      );
    }
    for (const p of predictions) {
      await client.query(
        `INSERT INTO predictions (news_id, topic_slug, statement_en, statement_uk, due_date)
         VALUES ($1::bigint, $2, $3, $4, $5::date)
         ON CONFLICT (news_id, statement_en) DO NOTHING`,
        [newsId, topic?.key ?? null, p.statement_en, p.statement_uk, p.due_by],
      );
    }
    await client.query('RELEASE SAVEPOINT editorial_extras_sp');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT editorial_extras_sp');
  }
}
