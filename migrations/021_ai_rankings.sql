-- Migration 021: "Top AI" rankings — tools/models, per-subcategory ranks, rank history, news mentions.

CREATE TABLE IF NOT EXISTS ai_tools (
  slug varchar(120) PRIMARY KEY,
  name varchar(200) NOT NULL,
  vendor varchar(160),
  kind varchar(16) NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'model')),
  url text,
  has_free boolean,
  is_open boolean NOT NULL DEFAULT false,
  license varchar(120),
  description_uk text,
  description_en text,
  source varchar(16) NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'arena', 'news')),
  -- Set when a tool genuinely appears after the initial import (powers "new this week").
  new_since timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_tools_new ON ai_tools (new_since DESC) WHERE new_since IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_tools_name ON ai_tools (lower(name));

CREATE TABLE IF NOT EXISTS ai_tool_ranks (
  subcategory varchar(64) NOT NULL,
  tool_slug varchar(120) NOT NULL REFERENCES ai_tools(slug) ON DELETE CASCADE,
  rank integer NOT NULL,
  score double precision,
  votes integer,
  basis varchar(16) NOT NULL CHECK (basis IN ('arena', 'seed', 'news')),
  seed_pos integer,
  added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subcategory, tool_slug)
);

CREATE INDEX IF NOT EXISTS idx_ai_tool_ranks_order ON ai_tool_ranks (subcategory, rank);
CREATE INDEX IF NOT EXISTS idx_ai_tool_ranks_tool ON ai_tool_ranks (tool_slug);

CREATE TABLE IF NOT EXISTS ai_tool_rank_history (
  day date NOT NULL,
  subcategory varchar(64) NOT NULL,
  tool_slug varchar(120) NOT NULL REFERENCES ai_tools(slug) ON DELETE CASCADE,
  rank integer NOT NULL,
  PRIMARY KEY (day, subcategory, tool_slug)
);

CREATE INDEX IF NOT EXISTS idx_ai_tool_rank_history_tool ON ai_tool_rank_history (tool_slug, day DESC);

CREATE TABLE IF NOT EXISTS ai_tool_mentions (
  tool_slug varchar(120) NOT NULL REFERENCES ai_tools(slug) ON DELETE CASCADE,
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  mentioned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_slug, news_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_tool_mentions_time ON ai_tool_mentions (mentioned_at DESC);

CREATE TABLE IF NOT EXISTS ai_tool_news_scans (
  news_id bigint PRIMARY KEY REFERENCES news_items(id) ON DELETE CASCADE,
  scanned_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_rankings_meta (
  key varchar(96) PRIMARY KEY,
  value text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
