-- Audit remediation, Play Market compliance, multi-source clustering, and moderated source discovery

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS license_mode varchar(32) NOT NULL DEFAULT 'headline_link'
    CHECK (license_mode IN ('headline_link', 'summary', 'full_text_licensed')),
  ADD COLUMN IF NOT EXISTS review_status varchar(24) NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('approved', 'pending_review', 'rejected')),
  ADD COLUMN IF NOT EXISTS discovery_rationale text,
  ADD COLUMN IF NOT EXISTS feed_etag text,
  ADD COLUMN IF NOT EXISTS feed_last_modified text,
  ADD COLUMN IF NOT EXISTS retry_after timestamptz;

ALTER TABLE news_items
  ADD COLUMN IF NOT EXISTS cluster_id text,
  ADD COLUMN IF NOT EXISTS cluster_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS grounding_search_entry_html text;

CREATE INDEX IF NOT EXISTS idx_news_items_cluster_id
  ON news_items (cluster_id)
  WHERE cluster_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_review_enabled
  ON sources (review_status, enabled);
