-- Migration 029: flagship long-reads (task 4).
-- standard = a normal article per event; flagship = a marked, deeply researched long-read (5-10 per day).
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS editorial_tier varchar(12);
CREATE INDEX IF NOT EXISTS idx_news_items_flagship ON news_items (published_at DESC) WHERE editorial_tier = 'flagship';

ALTER TABLE kb.events
  ADD COLUMN IF NOT EXISTS flagship_at timestamptz,
  ADD COLUMN IF NOT EXISTS flagship_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flagship_plan jsonb;

-- Causal/precedent links confirmed (or rejected) by the flagship planner are kept, so later articles reuse the verdict.
ALTER TABLE kb.event_links ADD COLUMN IF NOT EXISTS verdict jsonb;

-- Web research for flagships: pages found by a cheap search model, fetched and extracted by our own collector.
ALTER TABLE kb.documents DROP CONSTRAINT IF EXISTS documents_kind_check;
ALTER TABLE kb.documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('news', 'press_release', 'official_statement', 'filing', 'dataset_record', 'paper', 'release', 'transcript', 'research', 'other'));

CREATE TABLE IF NOT EXISTS kb.event_research (
  event_id bigint NOT NULL REFERENCES kb.events(id) ON DELETE CASCADE,
  document_id bigint NOT NULL REFERENCES kb.documents(id) ON DELETE CASCADE,
  query text,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, document_id)
);
