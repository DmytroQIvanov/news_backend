-- Licensed photos only. Publisher photos remain at their original source.
CREATE TABLE IF NOT EXISTS stored_photos (
  object_key text PRIMARY KEY,
  source_identity text NOT NULL,
  original_url text NOT NULL,
  credit text NOT NULL,
  license text NOT NULL,
  license_url text,
  content_type text,
  size_bytes integer,
  ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '3 months')
);
CREATE INDEX IF NOT EXISTS idx_stored_photos_source ON stored_photos (source_identity, expires_at DESC) WHERE ready;
CREATE INDEX IF NOT EXISTS idx_stored_photos_expiry ON stored_photos (expires_at);

CREATE TABLE IF NOT EXISTS photo_search_cache (
  cache_key text PRIMARY KEY,
  photos jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_photo_search_cache_age ON photo_search_cache (created_at);
