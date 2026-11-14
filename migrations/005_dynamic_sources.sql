-- Migration 005: Dynamic sources metadata for automated RSS/Atom discovery & audit

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS category varchar(24) NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS provider_id varchar(64),
  ADD COLUMN IF NOT EXISTS auto_discovered boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allowed_domains jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled, name);
