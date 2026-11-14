-- Migration 003: add unique index on provider_id for catalog upserts
-- and ensure catalog table is fully compatible with new providers

-- Make sure the catalog table exists (idempotent)
CREATE TABLE IF NOT EXISTS ai_catalogs (
  id varchar(64) PRIMARY KEY,
  provider_id varchar(64) NOT NULL,
  provider_name varchar(120) NOT NULL,
  category varchar(48) NOT NULL,
  title varchar(255) NOT NULL,
  tagline varchar(255),
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  free_tier jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_promotions jsonb NOT NULL DEFAULT '[]'::jsonb,
  advantages jsonb NOT NULL DEFAULT '[]'::jsonb,
  limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  pricing_summary text,
  official_url text,
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_catalogs_provider ON ai_catalogs(provider_id);
CREATE INDEX IF NOT EXISTS idx_ai_catalogs_verified ON ai_catalogs(last_verified_at DESC);
