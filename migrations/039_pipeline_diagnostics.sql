-- Batch 1: bounded diagnostic reads; no data is modified.
CREATE INDEX IF NOT EXISTS idx_kb_pipeline_runs_unfinished
  ON kb.pipeline_runs (worker, started_at) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_news_items_review_age
  ON news_items (updated_at) WHERE status = 'needs_review';
-- Rollback (operator-run only):
-- DROP INDEX IF EXISTS kb.idx_kb_pipeline_runs_unfinished;
-- DROP INDEX IF EXISTS public.idx_news_items_review_age;
