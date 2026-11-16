-- Migration 022: objectivity layer — long-lived topics, public change history, prediction tracking,
-- sentence-level error reports from readers.

-- Long-lived topics ("NBU key rate", "EU accession talks"): one page per topic that is updated by every new article.
CREATE TABLE IF NOT EXISTS topics (
  slug varchar(96) PRIMARY KEY,
  title_en text NOT NULL,
  title_uk text,
  category varchar(48),
  -- Generated explainer: {en: {...}, uk: {...}} with essence, timeline, players, glossary, positions, unknowns.
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary_model varchar(120),
  summary_news_count integer NOT NULL DEFAULT 0,
  summarized_at timestamptz,
  news_count integer NOT NULL DEFAULT 0,
  first_news_at timestamptz,
  last_news_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_topics_last_news ON topics (last_news_at DESC);

CREATE TABLE IF NOT EXISTS topic_news (
  topic_slug varchar(96) NOT NULL REFERENCES topics(slug) ON DELETE CASCADE,
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  -- One-line "what changed" for the topic's update log and the "since your last visit" digest.
  update_en text,
  update_uk text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_slug, news_id)
);

CREATE INDEX IF NOT EXISTS idx_topic_news_time ON topic_news (topic_slug, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_news_news ON topic_news (news_id);

-- Public change history: every edit of what readers see is kept with the previous value.
CREATE TABLE IF NOT EXISTS news_revisions (
  id bigserial PRIMARY KEY,
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  changed_fields text[] NOT NULL,
  previous jsonb NOT NULL,
  reason text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_revisions_news ON news_revisions (news_id, changed_at DESC);

CREATE OR REPLACE FUNCTION record_news_revision() RETURNS trigger AS $$
DECLARE
  fields text[] := ARRAY[]::text[];
  prev jsonb := '{}'::jsonb;
BEGIN
  IF NEW.title_uk IS DISTINCT FROM OLD.title_uk THEN
    fields := array_append(fields, 'title_uk'); prev := prev || jsonb_build_object('title_uk', OLD.title_uk);
  END IF;
  IF NEW.summary_uk IS DISTINCT FROM OLD.summary_uk THEN
    fields := array_append(fields, 'summary_uk'); prev := prev || jsonb_build_object('summary_uk', OLD.summary_uk);
  END IF;
  IF NEW.why_it_matters IS DISTINCT FROM OLD.why_it_matters THEN
    fields := array_append(fields, 'why_it_matters'); prev := prev || jsonb_build_object('why_it_matters', OLD.why_it_matters);
  END IF;
  IF (NEW.ai_metadata->'article'->>'title') IS DISTINCT FROM (OLD.ai_metadata->'article'->>'title') THEN
    fields := array_append(fields, 'title'); prev := prev || jsonb_build_object('title', OLD.ai_metadata->'article'->>'title');
  END IF;
  IF (NEW.ai_metadata->'article'->>'body') IS DISTINCT FROM (OLD.ai_metadata->'article'->>'body') THEN
    fields := array_append(fields, 'body'); prev := prev || jsonb_build_object('body', left(OLD.ai_metadata->'article'->>'body', 4000));
  END IF;
  IF NEW.is_retracted IS DISTINCT FROM OLD.is_retracted THEN
    fields := array_append(fields, 'is_retracted'); prev := prev || jsonb_build_object('is_retracted', OLD.is_retracted);
  END IF;
  IF NEW.correction_note IS DISTINCT FROM OLD.correction_note THEN
    fields := array_append(fields, 'correction_note'); prev := prev || jsonb_build_object('correction_note', OLD.correction_note);
  END IF;
  -- Only published items have a public history; the first AI draft is not a "correction".
  -- Automatic polishing in the first 2 hours is part of publishing; corrections/retractions are always recorded.
  IF array_length(fields, 1) > 0 AND OLD.status = 'published' AND (OLD.title_uk IS NOT NULL OR OLD.ai_metadata ? 'article')
     AND (now() - OLD.created_at > interval '2 hours'
          OR NEW.correction_note IS DISTINCT FROM OLD.correction_note
          OR NEW.is_retracted IS DISTINCT FROM OLD.is_retracted) THEN
    INSERT INTO news_revisions (news_id, changed_fields, previous, reason)
    VALUES (NEW.id, fields, prev, NEW.correction_note);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_news_revision ON news_items;
CREATE TRIGGER trg_news_revision
  AFTER UPDATE ON news_items
  FOR EACH ROW EXECUTE FUNCTION record_news_revision();

-- "What to watch next" turned into checkable predictions; later checked against newer reporting.
CREATE TABLE IF NOT EXISTS predictions (
  id bigserial PRIMARY KEY,
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  topic_slug varchar(96) REFERENCES topics(slug) ON DELETE SET NULL,
  statement_en text NOT NULL,
  statement_uk text,
  due_date date,
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'came_true', 'partly', 'did_not_happen', 'unclear')),
  check_note text,
  evidence_news_id bigint REFERENCES news_items(id) ON DELETE SET NULL,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_prediction UNIQUE (news_id, statement_en)
);

CREATE INDEX IF NOT EXISTS idx_predictions_due ON predictions (status, due_date);
CREATE INDEX IF NOT EXISTS idx_predictions_news ON predictions (news_id);

-- Readers point at a specific sentence that is wrong.
CREATE TABLE IF NOT EXISTS error_reports (
  id bigserial PRIMARY KEY,
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  sentence text NOT NULL,
  reason varchar(24) NOT NULL CHECK (reason IN ('factual', 'outdated', 'misleading', 'bias', 'translation', 'other')),
  comment text,
  status varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_error_reports_news ON error_reports (news_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_error_reports_once ON error_reports (news_id, device_id, md5(sentence));
