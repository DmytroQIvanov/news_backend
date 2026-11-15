-- Migration 011: Dynamic AI-managed Expert Knowledge Base

ALTER TABLE expert_profiles
  ADD COLUMN IF NOT EXISTS bias_keywords text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS conflict_disclosure_uk text,
  ADD COLUMN IF NOT EXISTS documented_positions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source_mode varchar(32) NOT NULL DEFAULT 'seed',
  ADD COLUMN IF NOT EXISTS ai_notes text,
  ADD COLUMN IF NOT EXISTS last_ai_reviewed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_expert_profiles_ai_review
  ON expert_profiles (source_mode, last_ai_reviewed_at NULLS FIRST);
