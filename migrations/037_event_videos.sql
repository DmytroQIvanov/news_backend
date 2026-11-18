-- YouTube videos linked to knowledge-base events: found by search, judged by AI for relevance and channel authority,
-- analysed by Gemini directly from the YouTube URL (works even though datacenter IPs are blocked for downloads) and
-- stored as a citable transcript-like document of the event.
CREATE TABLE IF NOT EXISTS event_videos (
  event_id bigint NOT NULL,
  video_id varchar(24) NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  channel text,
  channel_id text,
  duration_sec integer,
  published_hint text,
  published_at timestamptz,
  views bigint,
  status varchar(12) NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'accepted', 'rejected', 'analyzed', 'failed')),
  relevance real,
  verdict jsonb,
  analysis jsonb,
  model text,
  document_id bigint,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_event_videos_status ON event_videos (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_event_videos_video ON event_videos (video_id);
