-- Migration 027: knowledge base ("kb" schema) — the algorithmic foundation of the project.
--
-- Raw material (documents) -> mentions of entities -> events (story clusters) -> claims -> facts -> graph.
-- Everything here is filled by the Python pipeline in knowledge/ (python -m kb ...) WITHOUT an LLM.
-- An LLM is used only through kb.llm_tasks, a budgeted queue for what algorithms cannot decide
-- (new facts that need verification, contradictions, complex relations, change summaries).
--
-- Optional extensions: pgvector (embeddings / semantic search) and pg_trgm (fuzzy titles and names).
-- When they are not installed the pipeline still works; it just skips those signals.

CREATE SCHEMA IF NOT EXISTS kb;

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm is not available: %', SQLERRM;
  END;
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector is not available: %', SQLERRM;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Sources: reliability profile and polling state (public.sources stays the registry)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb.source_profiles (
  source_id uuid PRIMARY KEY REFERENCES public.sources(id) ON DELETE CASCADE,
  -- primary = the actor itself (company blog, ministry, regulator, court, statistics office)
  -- wire = news agencies; major = large editorial media; specialist = trade media; blog; aggregator; community
  tier varchar(16) NOT NULL DEFAULT 'major'
    CHECK (tier IN ('primary', 'wire', 'major', 'specialist', 'blog', 'aggregator', 'community', 'data')),
  reliability real NOT NULL DEFAULT 0.6 CHECK (reliability BETWEEN 0 AND 1),
  country char(2),
  language varchar(8),
  -- Owner group: two outlets of one group are not independent confirmations.
  owner_group varchar(80),
  -- Entity this source speaks for (an official blog of a company is a primary source about that company).
  speaks_for_entity_id bigint,
  fetch_full_text boolean NOT NULL DEFAULT true,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  poll_interval_s integer NOT NULL DEFAULT 600,
  etag text,
  last_modified text,
  last_polled_at timestamptz,
  last_ok_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error text,
  -- Rolling extraction health: share of articles where only a teaser could be extracted.
  teaser_ratio real NOT NULL DEFAULT 0,
  docs_total integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_source_profiles_due ON kb.source_profiles (next_poll_at);

-- ---------------------------------------------------------------------------
-- Documents: every collected article / press release / statement / filing / record
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb.documents (
  id bigserial PRIMARY KEY,
  source_id uuid REFERENCES public.sources(id) ON DELETE SET NULL,
  kind varchar(24) NOT NULL DEFAULT 'news'
    CHECK (kind IN ('news', 'press_release', 'official_statement', 'filing', 'dataset_record', 'paper', 'release', 'transcript', 'other')),
  external_id text,
  url text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  feed_summary text,
  body text,
  lang varchar(8),
  lang_confidence real,
  author text,
  published_at timestamptz,
  feed_updated_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  -- full: article text extracted; partial: some paragraphs (soft paywall / lazy loading);
  -- teaser: only the feed summary; blocked: HTTP 401/403/451 or bot wall; failed: network/parse error.
  extraction_status varchar(12) NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'full', 'partial', 'teaser', 'blocked', 'failed', 'skipped')),
  extraction_method varchar(24),
  word_count integer NOT NULL DEFAULT 0,
  content_sha256 char(64),
  title_sha256 char(64),
  simhash bigint,
  duplicate_of bigint REFERENCES kb.documents(id) ON DELETE SET NULL,
  duplicate_kind varchar(8) CHECK (duplicate_kind IN ('exact', 'near', 'reprint')),
  -- Work queue: new -> extracted -> analyzed -> clustered (or error). Claimed with FOR UPDATE SKIP LOCKED.
  stage varchar(12) NOT NULL DEFAULT 'new'
    CHECK (stage IN ('new', 'extracted', 'analyzed', 'clustered', 'error', 'ignored')),
  stage_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  -- Owner of the current lease: every write checks it, so a worker whose lease expired can never overwrite the
  -- result of the worker that took the row over.
  lease_token uuid,
  -- Version of the analysis code that produced mentions/claims; bumping it re-queues documents for re-analysis.
  analyzer_version smallint,
  -- Where the document's information originally comes from: its owner group, or the outlet it cites in the
  -- title/lead ("за даними Reuters"). Two outlets retelling Reuters are one evidence root, not two.
  evidence_root varchar(80),
  last_error text,
  category varchar(24),
  category_confidence real,
  category_method varchar(12) CHECK (category_method IN ('rules', 'model', 'embedding', 'source', 'llm', 'legacy')),
  category_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  keywords text[] NOT NULL DEFAULT '{}',
  quality_score real,
  quality_flags text[] NOT NULL DEFAULT '{}',
  legacy_news_id bigint REFERENCES public.news_items(id) ON DELETE SET NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_kb_documents_canonical UNIQUE (canonical_url)
);
CREATE INDEX IF NOT EXISTS idx_kb_documents_queue ON kb.documents (stage, id) WHERE stage IN ('new', 'extracted', 'analyzed');
CREATE INDEX IF NOT EXISTS idx_kb_documents_published ON kb.documents (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_documents_source ON kb.documents (source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_documents_sha ON kb.documents (content_sha256) WHERE content_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_documents_title_sha ON kb.documents (title_sha256) WHERE title_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_documents_legacy ON kb.documents (legacy_news_id) WHERE legacy_news_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_documents_category ON kb.documents (category, published_at DESC);

-- Paragraphs that repeat across many articles of one source (subscribe blocks, disclaimers, bylines):
-- learned from the data and removed from new article bodies before analysis.
CREATE TABLE IF NOT EXISTS kb.source_boilerplate (
  source_id uuid NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
  para_hash char(16) NOT NULL,
  sample text NOT NULL,
  doc_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, para_hash)
);

-- Change tracking: a new row whenever the title/body of a known URL changes (corrections, updates, stealth edits).
CREATE TABLE IF NOT EXISTS kb.document_versions (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES kb.documents(id) ON DELETE CASCADE,
  content_sha256 char(64) NOT NULL,
  title text NOT NULL,
  body text,
  -- Algorithmic diff: changed numbers, added/removed sentences, title change.
  diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_kb_document_version UNIQUE (document_id, content_sha256)
);

-- ---------------------------------------------------------------------------
-- Entities: people, organizations, places, products ... linked to Wikidata and other registries
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb.entities (
  id bigserial PRIMARY KEY,
  kind varchar(16) NOT NULL
    CHECK (kind IN ('person', 'organization', 'company', 'government', 'place', 'product', 'model', 'technology',
                    'event', 'law', 'facility', 'weapon', 'group', 'other')),
  name text NOT NULL,
  name_uk text,
  description text,
  wikidata_id varchar(16),
  legacy_kg_id uuid REFERENCES public.kg_entities(id) ON DELETE SET NULL,
  country char(2),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- active: usable for linking; candidate: auto-created, waiting for enough evidence; merged/rejected: kept for history.
  status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'candidate', 'merged', 'rejected')),
  merged_into bigint REFERENCES kb.entities(id) ON DELETE SET NULL,
  origin varchar(12) NOT NULL DEFAULT 'seed' CHECK (origin IN ('seed', 'legacy', 'wikidata', 'ner', 'manual', 'dataset', 'llm')),
  mention_count integer NOT NULL DEFAULT 0,
  doc_count integer NOT NULL DEFAULT 0,
  source_count integer NOT NULL DEFAULT 0,
  -- Category priors learned from documents that mention this entity ({"defense": 0.7, ...}).
  category_prior jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen timestamptz,
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_entities_wikidata ON kb.entities (wikidata_id) WHERE wikidata_id IS NOT NULL AND status <> 'merged';
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_entities_legacy ON kb.entities (legacy_kg_id) WHERE legacy_kg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_entities_kind ON kb.entities (kind, status);
CREATE INDEX IF NOT EXISTS idx_kb_entities_last_seen ON kb.entities (last_seen DESC);

-- All surface forms. alias_key is the matching key (lowercased, light-stemmed for Cyrillic), see kb/text/stem.py.
CREATE TABLE IF NOT EXISTS kb.entity_aliases (
  entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  alias text NOT NULL,
  alias_key text NOT NULL,
  lang varchar(8),
  origin varchar(12) NOT NULL DEFAULT 'seed',
  -- ambiguous aliases (e.g. "Apple", "Мир") need context before linking
  ambiguous boolean NOT NULL DEFAULT false,
  weight real NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_id, alias_key)
);
CREATE INDEX IF NOT EXISTS idx_kb_entity_aliases_key ON kb.entity_aliases (alias_key);

-- Registry identifiers: wikidata, lei, sec_cik, ticker, isin, edrpou, opensanctions, gdelt, acled_actor, ror, iso3166 ...
CREATE TABLE IF NOT EXISTS kb.entity_identifiers (
  entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  scheme varchar(24) NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (scheme, value)
);
CREATE INDEX IF NOT EXISTS idx_kb_entity_identifiers_entity ON kb.entity_identifiers (entity_id);

-- Mentions found in documents (linked or not). Unlinked ones feed kb.entity_candidates.
CREATE TABLE IF NOT EXISTS kb.mentions (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES kb.documents(id) ON DELETE CASCADE,
  entity_id bigint REFERENCES kb.entities(id) ON DELETE SET NULL,
  surface text NOT NULL,
  surface_key text NOT NULL,
  label varchar(12),
  sentence_idx integer NOT NULL DEFAULT 0,
  char_start integer,
  char_end integer,
  in_title boolean NOT NULL DEFAULT false,
  method varchar(12) NOT NULL CHECK (method IN ('gazetteer', 'ner', 'pattern', 'llm')),
  link_confidence real
);
CREATE INDEX IF NOT EXISTS idx_kb_mentions_doc ON kb.mentions (document_id);
CREATE INDEX IF NOT EXISTS idx_kb_mentions_entity ON kb.mentions (entity_id, document_id) WHERE entity_id IS NOT NULL;

-- Per-document entity summary (salience used for clustering and importance).
CREATE TABLE IF NOT EXISTS kb.document_entities (
  document_id bigint NOT NULL REFERENCES kb.documents(id) ON DELETE CASCADE,
  entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  mentions integer NOT NULL,
  salience real NOT NULL,
  in_title boolean NOT NULL DEFAULT false,
  PRIMARY KEY (document_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_document_entities_entity ON kb.document_entities (entity_id);

CREATE TABLE IF NOT EXISTS kb.entity_candidates (
  id bigserial PRIMARY KEY,
  surface_key text NOT NULL UNIQUE,
  surface text NOT NULL,
  label varchar(12),
  mention_count integer NOT NULL DEFAULT 0,
  doc_count integer NOT NULL DEFAULT 0,
  source_count integer NOT NULL DEFAULT 0,
  sample_document_ids bigint[] NOT NULL DEFAULT '{}',
  source_ids uuid[] NOT NULL DEFAULT '{}',
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'created', 'rejected', 'noise')),
  wikidata_checked_at timestamptz,
  wikidata_result jsonb,
  entity_id bigint REFERENCES kb.entities(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_entity_candidates_queue ON kb.entity_candidates (status, source_count DESC, mention_count DESC);

-- Wikidata API cache (search and entity fetches), so repeated names never hit the API twice.
CREATE TABLE IF NOT EXISTS kb.wikidata_cache (
  cache_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Events (story clusters) and storylines (long threads of events)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb.storylines (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  category varchar(24),
  -- Entities that define the storyline (the "signature" used to attach new events).
  signature_entity_ids bigint[] NOT NULL DEFAULT '{}',
  event_count integer NOT NULL DEFAULT 0,
  first_at timestamptz,
  last_at timestamptz,
  topic_slug varchar(96),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_storylines_last ON kb.storylines (last_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_storylines_signature ON kb.storylines USING gin (signature_entity_ids);

CREATE TABLE IF NOT EXISTS kb.events (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  -- Extractive summary: lead sentences chosen by an algorithm (no LLM).
  summary text,
  category varchar(24),
  event_type varchar(32),
  lang_set text[] NOT NULL DEFAULT '{}',
  keywords text[] NOT NULL DEFAULT '{}',
  started_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  doc_count integer NOT NULL DEFAULT 0,
  source_count integer NOT NULL DEFAULT 0,
  -- Sources from different owner groups; reprints and syndicated copies do not count.
  independent_source_count integer NOT NULL DEFAULT 0,
  primary_source_count integer NOT NULL DEFAULT 0,
  full_text_doc_count integer NOT NULL DEFAULT 0,
  -- Signals for editorial selection (task 1/4)
  importance real NOT NULL DEFAULT 0,
  velocity real NOT NULL DEFAULT 0,
  novelty real NOT NULL DEFAULT 0,
  quality real NOT NULL DEFAULT 0,
  -- collecting: still gathering coverage; ready: enough material for a normal article; deep: material for a long-read;
  -- written: an article exists (article_news_id); skipped: not worth an article on its own (kept as context).
  editorial_state varchar(10) NOT NULL DEFAULT 'collecting'
    CHECK (editorial_state IN ('collecting', 'ready', 'deep', 'written', 'skipped')),
  article_news_id bigint REFERENCES public.news_items(id) ON DELETE SET NULL,
  storyline_id bigint REFERENCES kb.storylines(id) ON DELETE SET NULL,
  status varchar(8) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'merged')),
  merged_into bigint REFERENCES kb.events(id) ON DELETE SET NULL,
  -- Running sums so the centroid can be updated without re-reading all documents.
  entity_weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_events_open ON kb.events (status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_events_editorial ON kb.events (editorial_state, importance DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_kb_events_storyline ON kb.events (storyline_id, started_at);

CREATE TABLE IF NOT EXISTS kb.event_documents (
  document_id bigint PRIMARY KEY REFERENCES kb.documents(id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES kb.events(id) ON DELETE CASCADE,
  similarity real NOT NULL,
  role varchar(10) NOT NULL DEFAULT 'report' CHECK (role IN ('seed', 'report', 'primary', 'reprint', 'analysis', 'update')),
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_event_documents_event ON kb.event_documents (event_id);

CREATE TABLE IF NOT EXISTS kb.event_entities (
  event_id bigint NOT NULL REFERENCES kb.events(id) ON DELETE CASCADE,
  entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  weight real NOT NULL,
  doc_count integer NOT NULL DEFAULT 1,
  -- actor / target / location / mentioned (from claims: subject -> actor, object -> target)
  role varchar(10) NOT NULL DEFAULT 'mentioned',
  PRIMARY KEY (event_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_event_entities_entity ON kb.event_entities (entity_id, event_id);

-- Links between events: same storyline, follow-up, precedent (same kind of event earlier), reaction, cause/effect.
CREATE TABLE IF NOT EXISTS kb.event_links (
  from_event_id bigint NOT NULL REFERENCES kb.events(id) ON DELETE CASCADE,
  to_event_id bigint NOT NULL REFERENCES kb.events(id) ON DELETE CASCADE,
  link_type varchar(16) NOT NULL
    CHECK (link_type IN ('same_storyline', 'follow_up', 'precedent', 'reaction_to', 'causes', 'contradicts', 'context')),
  score real NOT NULL,
  method varchar(16) NOT NULL DEFAULT 'algorithm',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_event_id, to_event_id, link_type),
  CHECK (from_event_id <> to_event_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_event_links_to ON kb.event_links (to_event_id);

-- ---------------------------------------------------------------------------
-- Claims (what a document asserts) -> facts (deduplicated assertions with evidence)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb.claims (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES kb.documents(id) ON DELETE CASCADE,
  event_id bigint REFERENCES kb.events(id) ON DELETE SET NULL,
  sentence_idx integer NOT NULL,
  sentence text NOT NULL,
  subject_entity_id bigint REFERENCES kb.entities(id) ON DELETE SET NULL,
  subject_text text,
  predicate varchar(32) NOT NULL,
  object_entity_id bigint REFERENCES kb.entities(id) ON DELETE SET NULL,
  object_text text,
  value_num numeric,
  value_unit varchar(16),
  time_text text,
  time_start date,
  time_end date,
  -- fact: stated as happened; plan: will/intends; claim: attributed ("X said"); speculation: may/reportedly; denial
  modality varchar(12) NOT NULL DEFAULT 'fact' CHECK (modality IN ('fact', 'plan', 'claim', 'speculation', 'denial', 'question')),
  negated boolean NOT NULL DEFAULT false,
  attributed_to_entity_id bigint REFERENCES kb.entities(id) ON DELETE SET NULL,
  confidence real NOT NULL,
  extractor varchar(24) NOT NULL,
  -- Evidence root of this claim: the outlet cited in its sentence, else the document's root (see attribution.py).
  evidence_root varchar(80),
  fact_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_claims_doc ON kb.claims (document_id);
CREATE INDEX IF NOT EXISTS idx_kb_claims_subject ON kb.claims (subject_entity_id, predicate);
CREATE INDEX IF NOT EXISTS idx_kb_claims_object ON kb.claims (object_entity_id) WHERE object_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_claims_event ON kb.claims (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_claims_unfacted ON kb.claims (id) WHERE fact_id IS NULL;

CREATE TABLE IF NOT EXISTS kb.facts (
  id bigserial PRIMARY KEY,
  subject_entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  predicate varchar(32) NOT NULL,
  object_entity_id bigint REFERENCES kb.entities(id) ON DELETE CASCADE,
  -- Identity of the assertion besides subject/predicate/object entity:
  --   'NOT|' / 'PLAN|' prefix for negated / planned assertions,
  --   't:<normalized text>' when the object is not a linked entity,
  --   '|ev:<event id>' for episodic actions (a strike, an aid delivery, a meeting): each occurrence is its own fact,
  --   while durable facts (acquired, appointed, captured) collapse across events.
  -- Amounts are NOT part of the identity: they live in kb.fact_values with their history.
  object_key text NOT NULL DEFAULT '',
  object_text text,
  value_num numeric,
  value_unit varchar(16),
  valid_from date,
  valid_to date,
  -- single_source -> corroborated (2+ independent sources) / confirmed (primary source) / disputed / retracted
  status varchar(14) NOT NULL DEFAULT 'single_source'
    CHECK (status IN ('single_source', 'corroborated', 'confirmed', 'disputed', 'retracted', 'superseded')),
  support_count integer NOT NULL DEFAULT 0,
  source_count integer NOT NULL DEFAULT 0,
  primary_support boolean NOT NULL DEFAULT false,
  first_event_id bigint REFERENCES kb.events(id) ON DELETE SET NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  llm_checked boolean NOT NULL DEFAULT false,
  -- NULLS NOT DISTINCT (PostgreSQL 15+): facts without an object entity still collapse into one row.
  CONSTRAINT uq_kb_fact UNIQUE NULLS NOT DISTINCT (subject_entity_id, predicate, object_entity_id, object_key)
);
CREATE INDEX IF NOT EXISTS idx_kb_facts_object ON kb.facts (object_entity_id) WHERE object_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kb_facts_recent ON kb.facts (last_seen DESC);

ALTER TABLE kb.claims DROP CONSTRAINT IF EXISTS fk_kb_claims_fact;
ALTER TABLE kb.claims ADD CONSTRAINT fk_kb_claims_fact FOREIGN KEY (fact_id) REFERENCES kb.facts(id) ON DELETE SET NULL;

-- Every value reported for a fact ("65 млн €", "64,7 млн €"; "10 загиблих" → "12 загиблих") with its evidence roots.
-- The fact's current value is chosen from here; differences become revisions or contradictions.
CREATE TABLE IF NOT EXISTS kb.fact_values (
  fact_id bigint NOT NULL REFERENCES kb.facts(id) ON DELETE CASCADE,
  value_bucket text NOT NULL,
  value_num numeric NOT NULL,
  value_unit varchar(16) NOT NULL DEFAULT '',
  evidence_roots text[] NOT NULL DEFAULT '{}',
  support integer NOT NULL DEFAULT 0,
  primary_support boolean NOT NULL DEFAULT false,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  PRIMARY KEY (fact_id, value_unit, value_bucket)
);

-- numeric: independent roots report incompatible values for one fact;
-- negation: "X did Y" vs "X did not do Y" / a denial (other_fact_id = the negated fact).
CREATE TABLE IF NOT EXISTS kb.contradictions (
  id bigserial PRIMARY KEY,
  fact_id bigint NOT NULL REFERENCES kb.facts(id) ON DELETE CASCADE,
  other_fact_id bigint REFERENCES kb.facts(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL CHECK (kind IN ('numeric', 'negation', 'date', 'exclusive_value', 'retraction')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_contradiction ON kb.contradictions (fact_id, kind, COALESCE(other_fact_id, 0));

-- Aggregated typed graph edges between entities (from facts, Wikidata statements, datasets, co-occurrence).
CREATE TABLE IF NOT EXISTS kb.entity_relations (
  from_entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  to_entity_id bigint NOT NULL REFERENCES kb.entities(id) ON DELETE CASCADE,
  relation varchar(32) NOT NULL,
  origin varchar(12) NOT NULL CHECK (origin IN ('fact', 'wikidata', 'dataset', 'cooccurrence', 'manual', 'llm')),
  weight real NOT NULL DEFAULT 1,
  evidence_count integer NOT NULL DEFAULT 1,
  valid_from date,
  valid_to date,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_entity_id, to_entity_id, relation, origin),
  CHECK (from_entity_id <> to_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_entity_relations_to ON kb.entity_relations (to_entity_id, relation);

-- ---------------------------------------------------------------------------
-- LLM escalation queue with explicit budgets (Gemini only when algorithms are not enough)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb.llm_tasks (
  id bigserial PRIMARY KEY,
  task_type varchar(24) NOT NULL
    CHECK (task_type IN ('verify_fact', 'contradiction', 'complex_relation', 'change_summary', 'classify',
                         'entity_resolve', 'event_brief', 'causal_check')),
  -- Same work is never queued twice.
  dedupe_key text NOT NULL UNIQUE,
  priority real NOT NULL DEFAULT 0,
  -- lite: cheap/fast model; standard: flash; deep: top model (Hydrogen) — only for flagship work
  tier varchar(10) NOT NULL DEFAULT 'lite' CHECK (tier IN ('lite', 'standard', 'deep')),
  payload jsonb NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'dropped')),
  result jsonb,
  model varchar(80),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_kb_llm_tasks_queue ON kb.llm_tasks (status, priority DESC, id) WHERE status = 'queued';

-- ---------------------------------------------------------------------------
-- Observability
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb.pipeline_runs (
  id bigserial PRIMARY KEY,
  worker varchar(24) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);
CREATE INDEX IF NOT EXISTS idx_kb_pipeline_runs_recent ON kb.pipeline_runs (worker, started_at DESC);

-- ---------------------------------------------------------------------------
-- Optional indexes that need extensions
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_kb_documents_title_trgm ON kb.documents USING gin (lower(title) gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_kb_entity_aliases_trgm ON kb.entity_aliases USING gin (alias_key gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_kb_events_title_trgm ON kb.events USING gin (lower(title) gin_trgm_ops)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    -- 384 dims = paraphrase-multilingual-MiniLM-L12-v2 / multilingual-e5-small. Change KB_EMBED_DIM only together with a new migration.
    EXECUTE 'CREATE TABLE IF NOT EXISTS kb.document_embeddings (
               document_id bigint PRIMARY KEY REFERENCES kb.documents(id) ON DELETE CASCADE,
               model varchar(80) NOT NULL,
               embedding vector(384) NOT NULL,
               created_at timestamptz NOT NULL DEFAULT now())';
    EXECUTE 'CREATE TABLE IF NOT EXISTS kb.event_embeddings (
               event_id bigint PRIMARY KEY REFERENCES kb.events(id) ON DELETE CASCADE,
               model varchar(80) NOT NULL,
               centroid vector(384) NOT NULL,
               n integer NOT NULL DEFAULT 1,
               updated_at timestamptz NOT NULL DEFAULT now())';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_kb_document_embeddings_hnsw ON kb.document_embeddings USING hnsw (embedding vector_cosine_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_kb_event_embeddings_hnsw ON kb.event_embeddings USING hnsw (centroid vector_cosine_ops)';
  END IF;
END $$;
