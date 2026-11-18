-- Migration 028: articles are written from knowledge-base events (task 1) and every LLM request is counted in one
-- shared, atomic daily budget (NestJS and the Python workers use the same table).

-- One row per (UTC day, model, purpose). Reservation happens BEFORE each HTTP attempt (retries included), so the
-- daily limit (20 requests per Flash model, 20 for Hydrogen by default) is never exceeded by any process.
CREATE TABLE IF NOT EXISTS llm_budget_days (
  day date NOT NULL,
  model varchar(80) NOT NULL,
  purpose varchar(40) NOT NULL,
  used integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, model, purpose)
);

-- Article <-> event link (an article is written per event, not per RSS item).
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS kb_event_id bigint;
CREATE INDEX IF NOT EXISTS idx_news_items_kb_event ON news_items (kb_event_id) WHERE kb_event_id IS NOT NULL;

-- What the article was written from: lets the editor update it only when the evidence materially changed.
ALTER TABLE kb.events
  ADD COLUMN IF NOT EXISTS written_at timestamptz,
  ADD COLUMN IF NOT EXISTS written_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS dossier_hash char(64),
  ADD COLUMN IF NOT EXISTS editorial_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS editorial_error text;

CREATE INDEX IF NOT EXISTS idx_kb_events_to_write
  ON kb.events (importance DESC)
  WHERE editorial_state IN ('ready', 'deep') AND article_news_id IS NULL;

-- One row per editorial batch: what was sent, what came back (monitoring of quality and cost).
CREATE TABLE IF NOT EXISTS kb.editorial_runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  event_ids bigint[] NOT NULL DEFAULT '{}',
  model varchar(80),
  prompt_chars integer,
  input_tokens integer,
  output_tokens integer,
  written integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  dry_run boolean NOT NULL DEFAULT false,
  error text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_kb_editorial_runs_recent ON kb.editorial_runs (started_at DESC);
