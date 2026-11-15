-- Migration 017: YouTube channels discovered by Gemini (experts, companies, media), verified before use.

CREATE TABLE IF NOT EXISTS youtube_channels (
  channel_id varchar(64) PRIMARY KEY,
  slug varchar(80) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  handle varchar(120),
  kind varchar(24) NOT NULL DEFAULT 'media',          -- expert | company | media | educator | institution
  category varchar(48) NOT NULL DEFAULT 'other',
  language varchar(8) NOT NULL DEFAULT 'en',
  topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  credibility_weight integer NOT NULL DEFAULT 80,
  priority_tier varchar(16) NOT NULL DEFAULT 'standard',
  subscriber_count bigint,
  discovered_by varchar(24) NOT NULL DEFAULT 'gemini', -- gemini | youtube_search | manual
  rationale_uk text,
  enabled boolean NOT NULL DEFAULT true,
  review_status varchar(20) NOT NULL DEFAULT 'approved', -- approved | pending_review | rejected
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_video_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_youtube_channels_enabled ON youtube_channels (enabled, category);
