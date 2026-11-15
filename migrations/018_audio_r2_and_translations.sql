-- Migration 018: pre-generated audio in Cloudflare R2 (capped, LRU) + generic per-language translations.

CREATE TABLE IF NOT EXISTS audio_briefings (
  cache_key varchar(32) PRIMARY KEY,
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  lang varchar(8) NOT NULL,
  depth varchar(32) NOT NULL,
  style varchar(32) NOT NULL,
  voice varchar(64) NOT NULL,
  object_key text NOT NULL,
  mime_type varchar(48) NOT NULL,
  bytes bigint NOT NULL,
  provider varchar(24) NOT NULL,
  model varchar(120) NOT NULL,
  duration_sec integer NOT NULL DEFAULT 60,
  script text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  plays integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_access_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audio_briefings_news ON audio_briefings (news_id, lang);
CREATE INDEX IF NOT EXISTS idx_audio_briefings_lru ON audio_briefings (last_access_at);

-- English is the canonical editorial language; every other language is a translation row.
CREATE TABLE IF NOT EXISTS news_translations (
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  lang varchar(8) NOT NULL,
  title text NOT NULL,
  summary text,
  why_it_matters text,
  model varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (news_id, lang)
);
