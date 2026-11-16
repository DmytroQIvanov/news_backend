-- Migration 024: scripted link analysis ("insights") on top of the knowledge graph.
-- Everything here is computed by InsightsService with dictionaries, regexes and statistics.
-- AI is optional: it only classifies new entity candidates and explains a few top insights per day.

-- Entities: aliases live in the database so new ones can be added without a deploy.
ALTER TABLE kg_entities DROP CONSTRAINT IF EXISTS kg_entities_entity_type_check;
ALTER TABLE kg_entities
  ADD CONSTRAINT kg_entities_entity_type_check
    CHECK (entity_type IN ('company', 'model', 'technology', 'product', 'event', 'person', 'organization', 'place', 'other'));
ALTER TABLE kg_entities
  ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS origin varchar(16) NOT NULL DEFAULT 'seed';

-- Which news items the analyzer has already scanned for entities and event types.
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS insights_scanned_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_news_insights_unscanned
  ON news_items (id) WHERE insights_scanned_at IS NULL;

ALTER TABLE news_entities ADD COLUMN IF NOT EXISTS source varchar(16) NOT NULL DEFAULT 'keyword';

-- Event type of a news item found by patterns ("acquisition", "funding", ...), with an amount when present.
CREATE TABLE IF NOT EXISTS news_event_tags (
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  event_type varchar(32) NOT NULL,
  amount_usd numeric,
  matched text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (news_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_news_event_tags_type ON news_event_tags (event_type);

-- Proper names that are not in the dictionary yet. Accepted ones become kg_entities.
CREATE TABLE IF NOT EXISTS entity_candidates (
  id bigserial PRIMARY KEY,
  term varchar(120) NOT NULL,
  normalized varchar(120) NOT NULL UNIQUE,
  mention_count integer NOT NULL DEFAULT 0,
  source_count integer NOT NULL DEFAULT 0,
  sample_news_ids bigint[] NOT NULL DEFAULT '{}',
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  suggested_type varchar(32),
  ai_checked_at timestamptz,
  ai_verdict jsonb,
  entity_id uuid REFERENCES kg_entities(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entity_candidates_pending
  ON entity_candidates (status, mention_count DESC);

-- One row per candidate per article, so re-scanning never double counts.
CREATE TABLE IF NOT EXISTS entity_candidate_mentions (
  candidate_id bigint NOT NULL REFERENCES entity_candidates(id) ON DELETE CASCADE,
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  source_id uuid,
  PRIMARY KEY (candidate_id, news_id)
);

-- Co-mention statistics for every entity pair (entity_a < entity_b), counted per story, not per article.
CREATE TABLE IF NOT EXISTS entity_pair_stats (
  entity_a uuid NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  entity_b uuid NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  co_count integer NOT NULL,
  recent_count integer NOT NULL DEFAULT 0,
  source_count integer NOT NULL DEFAULT 0,
  pmi real NOT NULL,
  npmi real NOT NULL,
  lift real NOT NULL,
  adamic_adar real NOT NULL DEFAULT 0,
  first_seen timestamptz,
  last_seen timestamptz,
  known_relation boolean NOT NULL DEFAULT false,
  same_community boolean NOT NULL DEFAULT false,
  score real NOT NULL DEFAULT 0,
  evidence_news_ids bigint[] NOT NULL DEFAULT '{}',
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_a, entity_b),
  CHECK (entity_a < entity_b)
);
CREATE INDEX IF NOT EXISTS idx_entity_pair_score ON entity_pair_stats (score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_pair_b ON entity_pair_stats (entity_b);

-- Per-entity graph and trend metrics.
CREATE TABLE IF NOT EXISTS entity_metrics (
  entity_id uuid PRIMARY KEY REFERENCES kg_entities(id) ON DELETE CASCADE,
  mentions_total integer NOT NULL DEFAULT 0,
  mentions_recent integer NOT NULL DEFAULT 0,
  baseline_daily real NOT NULL DEFAULT 0,
  burst_z real NOT NULL DEFAULT 0,
  degree integer NOT NULL DEFAULT 0,
  pagerank real NOT NULL DEFAULT 0,
  pagerank_prev real,
  betweenness real NOT NULL DEFAULT 0,
  community integer,
  daily_series jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Ready-to-show findings. key makes one finding per subject per day idempotent.
CREATE TABLE IF NOT EXISTS insight_links (
  id bigserial PRIMARY KEY,
  kind varchar(24) NOT NULL CHECK (kind IN ('novel_pair', 'surprising_pair', 'predicted', 'bridge', 'burst', 'lead_lag', 'topic_link', 'sequence')),
  key text NOT NULL,
  day date NOT NULL DEFAULT current_date,
  entity_ids uuid[] NOT NULL DEFAULT '{}',
  topic_slugs text[] NOT NULL DEFAULT '{}',
  score real NOT NULL,
  title_uk text NOT NULL,
  title_en text NOT NULL,
  evidence_news_ids bigint[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation_uk text,
  explanation_en text,
  explained_by varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_insight_key_day UNIQUE (kind, key, day)
);
CREATE INDEX IF NOT EXISTS idx_insight_links_recent ON insight_links (day DESC, score DESC);
CREATE INDEX IF NOT EXISTS idx_insight_links_entities ON insight_links USING gin (entity_ids);

-- "Event A at a company is often followed by event B at the same company within N days".
CREATE TABLE IF NOT EXISTS event_sequence_stats (
  from_type varchar(32) NOT NULL,
  to_type varchar(32) NOT NULL,
  support integer NOT NULL,
  entity_count integer NOT NULL,
  avg_gap_days real NOT NULL,
  confidence real NOT NULL,
  lift real NOT NULL,
  examples jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_type, to_type)
);

CREATE TABLE IF NOT EXISTS insight_runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);
