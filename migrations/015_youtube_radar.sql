-- Migration 015: YouTube RSS Radar, Worthiness Scoring & Daily-Capped Transcription Cache

CREATE TABLE IF NOT EXISTS youtube_videos (
  video_id varchar(32) PRIMARY KEY,
  channel_slug varchar(80) NOT NULL,
  channel_id varchar(64) NOT NULL,
  channel_name varchar(160) NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  description text,
  thumbnail_url text,
  published_at timestamptz NOT NULL,
  views_count bigint NOT NULL DEFAULT 0,
  likes_count bigint NOT NULL DEFAULT 0,
  estimated_duration_sec integer,
  chapters jsonb NOT NULL DEFAULT '[]'::jsonb,
  worth_score integer NOT NULL DEFAULT 0,
  worthiness_reason text,
  status varchar(32) NOT NULL DEFAULT 'pending',
  transcription_provider varchar(40),
  title_uk text,
  summary_uk text,
  why_it_matters_uk text,
  key_takeaways_uk jsonb NOT NULL DEFAULT '[]'::jsonb,
  timestamped_quotes jsonb NOT NULL DEFAULT '[]'::jsonb,
  category varchar(48),
  importance varchar(16) NOT NULL DEFAULT 'medium',
  news_item_id bigint REFERENCES news_items(id) ON DELETE SET NULL,
  transcribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_youtube_videos_status_score
  ON youtube_videos (status, worth_score DESC, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_youtube_videos_transcribed_at
  ON youtube_videos (transcribed_at DESC)
  WHERE transcribed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_youtube_videos_channel_published
  ON youtube_videos (channel_slug, published_at DESC);
