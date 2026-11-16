-- Migration 026: links and figures for news (media.links, media.figures, media.links_checked_at).
-- The data lives in the existing news_items.media jsonb; this only indexes the worker's queue.
CREATE INDEX IF NOT EXISTS idx_news_items_links_pending
  ON news_items (published_at DESC)
  WHERE status = 'published' AND (media ? 'checked_at') AND NOT (media ? 'links_checked_at');
