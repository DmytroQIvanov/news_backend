-- Deep dives: long explanatory articles that the system writes on its own (no news trigger). One row per attempt, so topics are not repeated.
CREATE TABLE IF NOT EXISTS kb.deepdives (
  id bigserial PRIMARY KEY,
  topic_key varchar(160) NOT NULL,
  topic jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(16) NOT NULL DEFAULT 'writing' CHECK (status IN ('writing', 'published', 'rejected', 'deferred')),
  title text,
  news_id bigint REFERENCES public.news_items(id) ON DELETE SET NULL,
  review jsonb NOT NULL DEFAULT '{}'::jsonb,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_kb_deepdives_topic ON kb.deepdives (topic_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_deepdives_day ON kb.deepdives (started_at DESC);

-- The "author" of deep dives, so they appear with their own source name.
INSERT INTO sources (slug, name, homepage_url, unofficial, enabled)
VALUES ('kb-deepdive', 'Deep dive', 'https://hovimo.com', false, true)
ON CONFLICT (slug) DO NOTHING;
