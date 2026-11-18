-- Derived encyclopedia. No seed content; the KB remains the source of truth.
CREATE TABLE encyclopedia_entries (
  id bigserial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  entity_id bigint NOT NULL UNIQUE REFERENCES kb.entities(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  title_uk text,
  category text NOT NULL,
  category_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text NOT NULL DEFAULT '',
  summary_uk text NOT NULL DEFAULT '',
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  related jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  importance real NOT NULL DEFAULT 0,
  mentions integer NOT NULL DEFAULT 0,
  first_seen timestamptz,
  last_seen timestamptz,
  evidence_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'hidden')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX encyclopedia_entries_order ON encyclopedia_entries (importance DESC, id DESC) WHERE status = 'auto';
CREATE INDEX encyclopedia_entries_categories ON encyclopedia_entries USING gin (category_tags);
-- Fair, bounded sweeps include ineligible entities without creating empty encyclopedia entries.
CREATE TABLE encyclopedia_refresh_state (
  entity_id bigint PRIMARY KEY REFERENCES kb.entities(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX encyclopedia_refresh_checked ON encyclopedia_refresh_state (checked_at);
-- The encyclopedia resolves each fact's citations; avoid repeated scans of the full claims table.
CREATE INDEX IF NOT EXISTS idx_kb_claims_fact_evidence ON kb.claims (fact_id, document_id) WHERE fact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_claims_attributed ON kb.claims (attributed_to_entity_id) WHERE attributed_to_entity_id IS NOT NULL;

-- Counts and labels change atomically with entries; stale categories cannot survive a hidden last entry.
CREATE VIEW encyclopedia_categories AS
SELECT tag->>'slug' AS slug, min(tag->>'label') AS label,
       min(COALESCE(NULLIF(tag->>'label_uk', ''), tag->>'label')) AS label_uk,
       count(DISTINCT e.id)::int AS count, max(e.importance) AS importance
FROM encyclopedia_entries e CROSS JOIN LATERAL jsonb_array_elements(e.category_tags) tag
WHERE e.status = 'auto'
GROUP BY tag->>'slug';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX encyclopedia_title_trgm ON encyclopedia_entries USING gin (lower(title) gin_trgm_ops)';
    EXECUTE 'CREATE INDEX encyclopedia_title_uk_trgm ON encyclopedia_entries USING gin (lower(title_uk) gin_trgm_ops)';
  END IF;
END $$;
