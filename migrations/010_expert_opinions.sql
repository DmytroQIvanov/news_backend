-- Migration 010: Expert Knowledge Base & Grounded Expert Opinions Cache

CREATE TABLE IF NOT EXISTS expert_profiles (
  slug varchar(80) PRIMARY KEY,
  full_name varchar(160) NOT NULL,
  handle varchar(120) NOT NULL,
  platform varchar(40) NOT NULL,
  role_uk varchar(200) NOT NULL,
  organization varchar(180),
  primary_domains text[] NOT NULL DEFAULT '{}'::text[],
  specializations text[] NOT NULL DEFAULT '{}'::text[],
  profile_url text NOT NULL,
  public_feed_url text,
  known_affiliations_uk text,
  credibility_weight integer NOT NULL DEFAULT 85,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expert_profiles_domains
  ON expert_profiles USING gin (primary_domains);

CREATE TABLE IF NOT EXISTS news_expert_opinions_cache (
  news_key text PRIMARY KEY,
  article_url text,
  category varchar(48),
  should_display_block boolean NOT NULL DEFAULT false,
  value_add_score integer NOT NULL DEFAULT 0,
  skip_reason_uk text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_mode varchar(32) NOT NULL DEFAULT 'hybrid',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expert_cache_expires
  ON news_expert_opinions_cache(expires_at DESC);
