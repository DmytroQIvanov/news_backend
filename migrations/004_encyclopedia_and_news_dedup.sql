-- Migration 004: News canonical URL deduplication, source health tracking,
-- and AI Encyclopedia structured verification & change history.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS last_fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;

ALTER TABLE news_items
  ADD COLUMN IF NOT EXISTS canonical_url text;

UPDATE news_items
SET canonical_url = regexp_replace(split_part(url, '#', 1), '/+$', '')
WHERE canonical_url IS NULL;

CREATE INDEX IF NOT EXISTS idx_news_canonical_url ON news_items(canonical_url);

ALTER TABLE ai_catalogs
  ADD COLUMN IF NOT EXISTS evidence_hash char(64),
  ADD COLUMN IF NOT EXISTS pricing_doc_url text,
  ADD COLUMN IF NOT EXISTS verification_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS ai_catalog_changes (
  id bigserial PRIMARY KEY,
  provider_id varchar(64) NOT NULL,
  change_type varchar(32) NOT NULL,
  field_name varchar(64) NOT NULL,
  summary text NOT NULL,
  source_url text,
  confidence varchar(16) NOT NULL DEFAULT 'confirmed'
    CHECK (confidence IN ('confirmed', 'company_claim', 'unverified')),
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_catalog_changes_provider
  ON ai_catalog_changes(provider_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_catalog_changes_recent
  ON ai_catalog_changes(detected_at DESC);
