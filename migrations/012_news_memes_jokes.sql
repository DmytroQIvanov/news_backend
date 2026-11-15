-- Migration 012: Public Memes & Jokes Cache for News Articles

CREATE TABLE IF NOT EXISTS news_memes_cache (
  news_key text PRIMARY KEY,
  article_url text,
  category varchar(48),
  has_memes boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_mode varchar(32) NOT NULL DEFAULT 'live_hybrid',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_news_memes_cache_expires
  ON news_memes_cache(expires_at DESC);
