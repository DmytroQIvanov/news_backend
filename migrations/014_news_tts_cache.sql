-- Migration 014: Persistent Pre-generated Audio Briefings Cache

CREATE TABLE IF NOT EXISTS news_tts_cache (
  cache_key text PRIMARY KEY,
  news_id bigint REFERENCES news_items(id) ON DELETE CASCADE,
  external_id varchar(250),
  depth varchar(32) NOT NULL,
  style varchar(32) NOT NULL,
  voice_name varchar(64) NOT NULL DEFAULT 'Kore',
  status varchar(24) NOT NULL DEFAULT 'script_only',
  model_used varchar(120),
  mime_type varchar(64),
  audio_base64 text,
  script_uk text NOT NULL,
  duration_estimate_sec integer NOT NULL DEFAULT 60,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_tts_cache_news_id
  ON news_tts_cache(news_id, depth, style);

CREATE INDEX IF NOT EXISTS idx_news_tts_cache_updated
  ON news_tts_cache(updated_at DESC);
