-- Migration 030: open-data connectors (task 3).
-- Three kinds of data, each stored where it is most useful:
--   * statistics (World Bank, Eurostat, ECB, FRED, EIA, UNHCR, FAOSTAT) -> kb.series / kb.observations (with vintages);
--   * structured records (sanctions, conflict events, arms transfers, contracts, filings metadata) -> kb.records,
--     plus facts in kb.facts when the record states one (X sanctioned Y, agency awarded Z to company W);
--   * texts (SEC 8-K, EU press releases, papers) -> kb.documents and the normal NLP pipeline.

CREATE TABLE IF NOT EXISTS kb.connector_state (
  connector varchar(40) PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- One statistical series: indicator x geography x frequency x unit (x adjustment).
CREATE TABLE IF NOT EXISTS kb.series (
  id bigserial PRIMARY KEY,
  provider varchar(24) NOT NULL,
  provider_code text NOT NULL,
  title text NOT NULL,
  title_uk text,
  unit varchar(40),
  frequency varchar(10) NOT NULL CHECK (frequency IN ('A', 'Q', 'M', 'W', 'D')),
  geo char(3),                       -- ISO 3166 alpha-3 ('WLD', 'EUU' for aggregates)
  entity_id bigint REFERENCES kb.entities(id) ON DELETE SET NULL,
  categories text[] NOT NULL DEFAULT '{}',
  keywords text[] NOT NULL DEFAULT '{}',
  source_url text,
  license text,
  last_period varchar(16),
  last_value numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_kb_series UNIQUE (provider, provider_code)
);
CREATE INDEX IF NOT EXISTS idx_kb_series_entity ON kb.series (entity_id);
CREATE INDEX IF NOT EXISTS idx_kb_series_geo ON kb.series (geo);
CREATE INDEX IF NOT EXISTS idx_kb_series_categories ON kb.series USING gin (categories);

-- Values; a revised value keeps the old one (vintage) so "what was known then" stays reproducible.
CREATE TABLE IF NOT EXISTS kb.observations (
  series_id bigint NOT NULL REFERENCES kb.series(id) ON DELETE CASCADE,
  period varchar(16) NOT NULL,       -- '2025', '2025-Q3', '2025-09', '2025-09-30'
  period_start date NOT NULL,
  value numeric,
  status varchar(16),                -- provider flags (estimate, provisional, break ...)
  first_seen timestamptz NOT NULL DEFAULT now(),
  revised_at timestamptz,
  previous_value numeric,
  PRIMARY KEY (series_id, period)
);
CREATE INDEX IF NOT EXISTS idx_kb_observations_time ON kb.observations (series_id, period_start DESC);

-- Structured records from registries and event datasets.
CREATE TABLE IF NOT EXISTS kb.records (
  id bigserial PRIMARY KEY,
  provider varchar(24) NOT NULL,     -- 'eu_sanctions', 'acled', 'sipri', 'usaspending', 'ted', 'sec', 'gdelt', 'openalex' ...
  record_type varchar(32) NOT NULL,  -- 'sanction_listing', 'conflict_event', 'arms_transfer', 'contract_award', 'filing', 'paper' ...
  external_id text NOT NULL,
  revision text NOT NULL DEFAULT '',
  title text NOT NULL,
  happened_on date,
  geo char(3),
  location text,
  latitude double precision,
  longitude double precision,
  amount numeric,
  currency varchar(8),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  url text,
  document_id bigint REFERENCES kb.documents(id) ON DELETE SET NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_kb_record UNIQUE (provider, external_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_kb_records_type_time ON kb.records (record_type, happened_on DESC);
CREATE INDEX IF NOT EXISTS idx_kb_records_geo_time ON kb.records (geo, happened_on DESC);

CREATE TABLE IF NOT EXISTS kb.record_entities (
  record_id bigint NOT NULL REFERENCES kb.records(id) ON DELETE CASCADE,
  entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  role varchar(24) NOT NULL DEFAULT 'subject',  -- subject / target / supplier / recipient / buyer / actor1 / actor2 ...
  PRIMARY KEY (record_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS idx_kb_record_entities_entity ON kb.record_entities (entity_id);

-- Data sources need a registry row (reliability tier 'data'); one per connector.
INSERT INTO public.sources (slug, name, homepage_url, feed_url, category, unofficial, enabled)
VALUES
  ('data-sec-edgar', 'SEC EDGAR', 'https://www.sec.gov', NULL, 'finance', false, false),
  ('data-eu-sanctions', 'EU Financial Sanctions', 'https://finance.ec.europa.eu', NULL, 'politics', false, false),
  ('data-ec-press', 'European Commission Press Corner', 'https://ec.europa.eu/commission/presscorner', NULL, 'politics', false, false),
  ('data-gdelt', 'GDELT Project', 'https://www.gdeltproject.org', NULL, 'politics', false, false),
  ('data-openalex', 'OpenAlex', 'https://openalex.org', NULL, 'research', false, false)
ON CONFLICT (slug) DO NOTHING;
