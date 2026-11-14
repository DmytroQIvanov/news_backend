CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(80) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  homepage_url text NOT NULL,
  feed_url text,
  unofficial boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS news_items (
  id bigserial PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  external_id varchar(250) NOT NULL,
  url text NOT NULL,
  original_title varchar(350) NOT NULL,
  original_summary text,
  title_uk varchar(350),
  summary_uk text,
  why_it_matters text,
  category varchar(24) NOT NULL,
  importance varchar(16) NOT NULL,
  free_access varchar(16) NOT NULL,
  published_at timestamptz,
  status varchar(24) NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review','published','rejected')),
  ai_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_source_item UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_news_public ON news_items(status,published_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_news_category ON news_items(category,status,published_at DESC);
