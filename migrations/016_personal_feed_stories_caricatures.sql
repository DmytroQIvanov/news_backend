-- Migration 016: personalised feed, multi-source story briefings, AI caricatures (R2) and app localisation

-- Anonymous per-device reader profile. No account, e-mail or name is stored: the device generates a random UUID.
CREATE TABLE IF NOT EXISTS reader_profiles (
  device_id uuid PRIMARY KEY,
  lang varchar(8) NOT NULL DEFAULT 'uk',
  topic_weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  declared_topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  events_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reader_events (
  id bigserial PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES reader_profiles(device_id) ON DELETE CASCADE,
  item_id text NOT NULL,
  cluster_id text,
  event_type varchar(24) NOT NULL,
  category varchar(48),
  source_slug varchar(80),
  dwell_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reader_events_device_time ON reader_events (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reader_events_item ON reader_events (item_id);

-- One generated briefing per multi-source story (cluster). Generated once, served to every reader in uk/en.
CREATE TABLE IF NOT EXISTS story_briefings (
  cluster_id text PRIMARY KEY,
  lead_news_id bigint REFERENCES news_items(id) ON DELETE SET NULL,
  category varchar(48),
  importance_score real NOT NULL DEFAULT 0,
  source_count integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  model_used varchar(80),
  sensitive boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_story_briefings_updated ON story_briefings (updated_at DESC);

-- AI caricatures: images live in Cloudflare R2, only the object key and metadata are stored here.
CREATE TABLE IF NOT EXISTS news_caricatures (
  id bigserial PRIMARY KEY,
  news_item_id bigint REFERENCES news_items(id) ON DELETE CASCADE,
  cluster_id text,
  object_key text NOT NULL UNIQUE,
  caption_uk text NOT NULL,
  caption_en text,
  image_prompt text NOT NULL,
  image_model varchar(120) NOT NULL,
  category varchar(48),
  status varchar(16) NOT NULL DEFAULT 'visible',
  report_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_news_caricatures_news ON news_caricatures (news_item_id) WHERE news_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_news_caricatures_visible ON news_caricatures (status, created_at DESC);

CREATE TABLE IF NOT EXISTS caricature_reports (
  caricature_id bigint NOT NULL REFERENCES news_caricatures(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  reason varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caricature_id, device_id)
);

-- YouTube videos linked to multi-source stories ("what was said on video" sub-items).
ALTER TABLE youtube_videos ADD COLUMN IF NOT EXISTS cluster_id text;
CREATE INDEX IF NOT EXISTS idx_youtube_videos_cluster ON youtube_videos (cluster_id) WHERE cluster_id IS NOT NULL;
