-- Migration 023: news photos with captions, animated charts/tables (LLM- or API-built), DB-backed media fallback.

-- media = { hero: {url, caption, credit, ...}, gallery: [...], visuals: [...], checked_at, visuals_checked_at }
ALTER TABLE news_items
  ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_news_items_media_pending
  ON news_items (published_at DESC)
  WHERE status = 'published' AND NOT (media ? 'checked_at');

CREATE INDEX IF NOT EXISTS idx_news_items_visuals_pending
  ON news_items (published_at DESC)
  WHERE status = 'published' AND NOT (media ? 'visuals_checked_at');

-- Generated images (caricatures) when Cloudflare R2 is not configured or is failing: kept in Postgres and
-- served through the API media proxy. Small (<= ~300 KB each), capped by retention in the app code.
CREATE TABLE IF NOT EXISTS media_blobs (
  object_key text PRIMARY KEY,
  content_type text NOT NULL,
  data bytea NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-source health/cadence hints used by the adaptive poller and the sources health endpoint.
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS items_per_day real,
  ADD COLUMN IF NOT EXISTS last_item_at timestamptz;
