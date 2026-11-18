-- World-wide source discovery: every automatically found outlet is labelled (country, language, type, ownership,
-- reliability) and every person (author / expert) is stored with the evidence that produced it.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS country varchar(2);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS language varchar(12);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS outlet_type varchar(24);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS state_affiliated boolean;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS reliability varchar(8);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS labels jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS discovered_via varchar(24);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS verified_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_sources_country ON sources (country) WHERE country IS NOT NULL;

-- Which countries have been searched, when, and with what result (rotation + progress).
CREATE TABLE IF NOT EXISTS discovery_coverage (
  country varchar(2) NOT NULL,
  kind varchar(16) NOT NULL DEFAULT 'outlets',
  last_run timestamptz NOT NULL DEFAULT now(),
  proposed integer NOT NULL DEFAULT 0,
  accepted integer NOT NULL DEFAULT 0,
  runs integer NOT NULL DEFAULT 1,
  PRIMARY KEY (country, kind)
);

-- Authors (bylines of articles we collected) and experts (people quoted in several events), with evidence.
CREATE TABLE IF NOT EXISTS discovered_people (
  id bigserial PRIMARY KEY,
  kind varchar(12) NOT NULL CHECK (kind IN ('author', 'expert', 'editor')),
  name text NOT NULL,
  name_key text NOT NULL,
  name_uk text,
  affiliation text,
  source_slug text,
  country varchar(2),
  topics text[] NOT NULL DEFAULT '{}',
  description text,
  wikidata_id text,
  entity_id bigint,
  mentions integer NOT NULL DEFAULT 0,
  events integer NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real NOT NULL DEFAULT 0.5,
  status varchar(12) NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'confirmed', 'hidden')),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name_key, source_slug)
);
CREATE INDEX IF NOT EXISTS idx_discovered_people_kind ON discovered_people (kind, mentions DESC);
