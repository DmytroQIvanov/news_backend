-- Immutable source payloads, full observation revision history and explainable data links.
ALTER TABLE kb.fire_detections ADD COLUMN first_seen timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE kb.court_documents ADD COLUMN first_seen timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE TABLE kb.data_snapshots (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  request_key text NOT NULL,
  source_url text NOT NULL,
  payload_hash char(64) NOT NULL,
  payload jsonb,
  body_gzip bytea NOT NULL,
  content_type text,
  first_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, request_key, payload_hash)
);
CREATE INDEX idx_kb_data_snapshots_time ON kb.data_snapshots (provider, last_seen DESC);

ALTER TABLE kb.observations ADD COLUMN snapshot_id bigint REFERENCES kb.data_snapshots(id);
ALTER TABLE kb.observations ADD COLUMN period_end date;
ALTER TABLE kb.observations ADD COLUMN source_published_at timestamptz;

CREATE OR REPLACE FUNCTION kb.period_end(p text, start_day date) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p ~ '^\d{4}$' THEN (start_day + interval '1 year - 1 day')::date
    WHEN p ~ '^\d{4}-?Q[1-4]$' THEN (start_day + interval '3 months - 1 day')::date
    WHEN p ~ '^\d{4}[-M]\d{2}$' THEN (start_day + interval '1 month - 1 day')::date
    ELSE start_day END
$$;
UPDATE kb.observations SET period_end = kb.period_end(period, period_start);
ALTER TABLE kb.observations ALTER COLUMN period_end SET NOT NULL;

CREATE TABLE kb.observation_versions (
  id bigserial PRIMARY KEY,
  series_id bigint NOT NULL REFERENCES kb.series(id) ON DELETE CASCADE,
  period text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  value numeric,
  status text,
  recorded_at timestamptz NOT NULL,
  superseded_at timestamptz,
  source_published_at timestamptz,
  snapshot_id bigint REFERENCES kb.data_snapshots(id),
  history_complete boolean NOT NULL DEFAULT true,
  CHECK (period_end >= period_start),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
);
CREATE UNIQUE INDEX uq_kb_observation_version_current ON kb.observation_versions(series_id, period) WHERE superseded_at IS NULL;
CREATE INDEX idx_kb_observation_versions_asof ON kb.observation_versions(series_id, period_end DESC, recorded_at DESC);
CREATE TABLE kb.observation_version_sources (
  version_id bigint NOT NULL REFERENCES kb.observation_versions(id) ON DELETE CASCADE,
  snapshot_id bigint NOT NULL REFERENCES kb.data_snapshots(id),
  PRIMARY KEY(version_id, snapshot_id)
);
-- Existing rows have only one previous_value: do not fabricate a complete revision history or its dates.
INSERT INTO kb.observation_versions (series_id, period, period_start, period_end, value, status, recorded_at,
                                    source_published_at, snapshot_id, history_complete)
SELECT series_id, period, period_start, period_end, value, status, COALESCE(revised_at, first_seen),
       source_published_at, snapshot_id, false FROM kb.observations;

CREATE OR REPLACE FUNCTION kb.prepare_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.period_end := COALESCE(NEW.period_end, kb.period_end(NEW.period, NEW.period_start));
  IF NEW.period_end < NEW.period_start OR NEW.value::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Invalid observation value or period';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_kb_observation_prepare BEFORE INSERT OR UPDATE ON kb.observations
  FOR EACH ROW EXECUTE FUNCTION kb.prepare_observation();

CREATE OR REPLACE FUNCTION kb.version_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stamp timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'INSERT' OR ROW(NEW.value, NEW.status, NEW.period_start, NEW.period_end, NEW.source_published_at)
      IS DISTINCT FROM ROW(OLD.value, OLD.status, OLD.period_start, OLD.period_end, OLD.source_published_at) THEN
    UPDATE kb.observation_versions SET superseded_at = stamp
      WHERE series_id = NEW.series_id AND period = NEW.period AND superseded_at IS NULL;
    INSERT INTO kb.observation_versions (series_id, period, period_start, period_end, value, status, recorded_at, source_published_at, snapshot_id)
      VALUES (NEW.series_id, NEW.period, NEW.period_start, NEW.period_end, NEW.value, NEW.status, stamp, NEW.source_published_at, NEW.snapshot_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_kb_observation_version AFTER INSERT OR UPDATE ON kb.observations
  FOR EACH ROW EXECUTE FUNCTION kb.version_observation();

CREATE TABLE kb.series_entities (
  series_id bigint NOT NULL REFERENCES kb.series(id) ON DELETE CASCADE,
  entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('subject','publisher','geography')),
  origin text NOT NULL,
  PRIMARY KEY (series_id, entity_id, role)
);
INSERT INTO kb.series_entities(series_id, entity_id, role, origin)
  SELECT id, entity_id, 'subject', 'catalog' FROM kb.series WHERE entity_id IS NOT NULL;
INSERT INTO kb.series_entities(series_id, entity_id, role, origin)
  SELECT s.id,e.id,'publisher','catalog' FROM kb.series s JOIN kb.entities e
    ON (s.provider='nbu' AND e.name='National Bank of Ukraine')
    OR (s.provider='ecb' AND e.name='European Central Bank')
    OR (s.provider='fred' AND e.name='Federal Reserve')
  WHERE e.kind IN ('government','organization') AND e.status='active' ON CONFLICT DO NOTHING;
CREATE INDEX idx_kb_series_entities_entity ON kb.series_entities(entity_id, series_id);

CREATE TABLE kb.sec_company_state (
  entity_id bigint PRIMARY KEY REFERENCES kb.entities(id) ON DELETE CASCADE,
  cik text NOT NULL,
  submissions_since date,
  last_attempt_at timestamptz,
  last_ok_at timestamptz,
  last_error text
);

CREATE TABLE kb.financial_facts (
  id bigserial PRIMARY KEY,
  entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  taxonomy text NOT NULL,
  concept text NOT NULL,
  label text NOT NULL,
  unit text NOT NULL,
  period_start date,
  period_end date NOT NULL,
  value numeric NOT NULL CHECK (value::text NOT IN ('NaN','Infinity','-Infinity')),
  filed_on date NOT NULL,
  available_at timestamptz NOT NULL,
  accession text NOT NULL,
  form text NOT NULL,
  fiscal_year integer,
  fiscal_period text,
  frame text,
  record_id bigint REFERENCES kb.records(id) ON DELETE SET NULL,
  snapshot_id bigint REFERENCES kb.data_snapshots(id),
  raw jsonb NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (period_start IS NULL OR period_start <= period_end),
  UNIQUE NULLS NOT DISTINCT (entity_id, taxonomy, concept, unit, period_start, period_end, accession, value)
);
CREATE INDEX idx_kb_financial_facts_lookup ON kb.financial_facts(entity_id, available_at DESC, period_end DESC);

CREATE TABLE kb.event_data_links (
  event_id bigint NOT NULL REFERENCES kb.events(id) ON DELETE CASCADE,
  data_key text NOT NULL,
  as_of timestamptz NOT NULL,
  series_id bigint REFERENCES kb.series(id) ON DELETE CASCADE,
  record_id bigint REFERENCES kb.records(id) ON DELETE CASCADE,
  financial_fact_id bigint REFERENCES kb.financial_facts(id) ON DELETE CASCADE,
  score real NOT NULL CHECK (score BETWEEN 0 AND 1),
  evidence jsonb NOT NULL,
  algorithm text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  first_linked_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, data_key),
  CHECK (num_nonnulls(series_id, record_id, financial_fact_id) = 1)
);
CREATE INDEX idx_kb_event_data_links_series ON kb.event_data_links(series_id) WHERE active;
CREATE INDEX idx_kb_event_data_links_record ON kb.event_data_links(record_id) WHERE active;
CREATE INDEX idx_kb_event_data_links_financial ON kb.event_data_links(financial_fact_id) WHERE active;

CREATE TABLE kb.event_data_refresh (
  event_id bigint PRIMARY KEY REFERENCES kb.events(id) ON DELETE CASCADE,
  checked_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);

-- Preserve registry revisions too: an amended contract/listing must not erase its earlier contents.
CREATE TABLE kb.record_versions (
  id bigserial PRIMARY KEY,
  record_id bigint NOT NULL REFERENCES kb.records(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  data jsonb NOT NULL,
  history_complete boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_kb_record_versions ON kb.record_versions(record_id,recorded_at DESC);
INSERT INTO kb.record_versions(record_id,recorded_at,data,history_complete)
  SELECT id,updated_at,to_jsonb(r),false FROM kb.records r;
CREATE FUNCTION kb.version_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR (to_jsonb(NEW)-'updated_at'-'first_seen') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at'-'first_seen') THEN
    INSERT INTO kb.record_versions(record_id,data) VALUES(NEW.id,to_jsonb(NEW));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_kb_record_version AFTER INSERT OR UPDATE ON kb.records FOR EACH ROW EXECUTE FUNCTION kb.version_record();

-- If a provider silently corrects a value under the SAME accession, that correction was only known on collection.
CREATE FUNCTION kb.prepare_financial_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM kb.financial_facts f WHERE f.entity_id=NEW.entity_id AND f.taxonomy=NEW.taxonomy
      AND f.concept=NEW.concept AND f.unit=NEW.unit AND f.period_start IS NOT DISTINCT FROM NEW.period_start
      AND f.period_end=NEW.period_end AND f.accession=NEW.accession AND f.value<>NEW.value) THEN
    NEW.available_at := greatest(NEW.available_at,clock_timestamp());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_kb_financial_fact_prepare BEFORE INSERT ON kb.financial_facts
  FOR EACH ROW EXECUTE FUNCTION kb.prepare_financial_fact();

-- Deterministic URL linkage keeps legacy/imported news connected without rewriting their text with an LLM.
CREATE OR REPLACE FUNCTION kb.link_news_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.news_items n SET kb_event_id = NEW.event_id
    FROM kb.documents d WHERE d.id = NEW.document_id
      AND n.kb_event_id IS NULL
      AND (d.legacy_news_id = n.id OR d.canonical_url = COALESCE(n.canonical_url, n.url));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_kb_link_news_document AFTER INSERT OR UPDATE OF event_id ON kb.event_documents
  FOR EACH ROW EXECUTE FUNCTION kb.link_news_document();

CREATE OR REPLACE FUNCTION kb.link_new_news() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kb_event_id IS NULL THEN
    SELECT ed.event_id INTO NEW.kb_event_id FROM kb.documents d JOIN kb.event_documents ed ON ed.document_id = d.id
      WHERE d.legacy_news_id = NEW.id OR d.canonical_url = COALESCE(NEW.canonical_url, NEW.url)
      ORDER BY (d.legacy_news_id = NEW.id) DESC NULLS LAST, d.id LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_kb_link_new_news BEFORE INSERT OR UPDATE OF url, canonical_url ON public.news_items
  FOR EACH ROW EXECUTE FUNCTION kb.link_new_news();
UPDATE public.news_items n SET kb_event_id = ed.event_id
  FROM kb.documents d JOIN kb.event_documents ed ON ed.document_id = d.id
  WHERE n.kb_event_id IS NULL AND (d.legacy_news_id = n.id OR d.canonical_url = COALESCE(n.canonical_url, n.url));
