-- Migration 032: Ukrainian registries and satellite fire detections (task 3, part 2).
-- (031 is used by the photo storage work.)

-- NASA FIRMS thermal anomalies (VIIRS/MODIS) over Ukraine and the neighbouring regions of Russia/Belarus.
CREATE TABLE IF NOT EXISTS kb.fire_detections (
  id bigserial PRIMARY KEY,
  source varchar(24) NOT NULL,            -- VIIRS_SNPP_NRT, VIIRS_NOAA20_NRT, VIIRS_NOAA21_NRT, MODIS_NRT
  detected_at timestamptz NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  frp real,                               -- fire radiative power, MW (bigger = more intense fire)
  confidence varchar(8),
  daynight char(1),
  CONSTRAINT uq_kb_fire UNIQUE (source, detected_at, latitude, longitude)
);
CREATE INDEX IF NOT EXISTS idx_kb_fire_time ON kb.fire_detections (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_fire_geo ON kb.fire_detections (latitude, longitude);

-- Unified State Register (ЄДР), legal entities: compact copy for lookups by code and by name.
CREATE TABLE IF NOT EXISTS kb.ua_companies (
  edrpou varchar(10) PRIMARY KEY,
  name text NOT NULL,
  short_name text,
  legal_form text,
  status text,
  founders text[] NOT NULL DEFAULT '{}',
  beneficiaries text[] NOT NULL DEFAULT '{}',
  signers text[] NOT NULL DEFAULT '{}',
  capital numeric,
  registered_on date,
  terminated boolean NOT NULL DEFAULT false,
  name_key text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_ua_companies_name_key ON kb.ua_companies (name_key);

-- Court decisions registry (ЄДРСР) metadata of criminal and administrative-offence cases; texts are fetched only for
-- cases that the news mention (by case number) or that concern followed entities.
CREATE TABLE IF NOT EXISTS kb.court_documents (
  doc_id bigint PRIMARY KEY,
  court_code integer,
  court_name text,
  judgment_form text,
  justice_kind text,
  category text,
  cause_num varchar(64),
  adjudication_date date,
  judge text,
  doc_url text,
  document_id bigint REFERENCES kb.documents(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_court_cause ON kb.court_documents (cause_num);
CREATE INDEX IF NOT EXISTS idx_kb_court_date ON kb.court_documents (adjudication_date DESC);

INSERT INTO public.sources (slug, name, homepage_url, feed_url, category, unofficial, enabled)
VALUES
  ('data-prozorro', 'Prozorro', 'https://prozorro.gov.ua', NULL, 'economy', false, false),
  ('data-rada', 'Верховна Рада України (відкриті дані)', 'https://data.rada.gov.ua', NULL, 'politics', false, false),
  ('data-court', 'Єдиний державний реєстр судових рішень', 'https://reyestr.court.gov.ua', NULL, 'law', false, false),
  ('data-ukrstat', 'Державна служба статистики України', 'https://stat.gov.ua', NULL, 'economy', false, false),
  ('data-nasa-firms', 'NASA FIRMS', 'https://firms.modaps.eosdis.nasa.gov', NULL, 'defense', false, false)
ON CONFLICT (slug) DO NOTHING;
