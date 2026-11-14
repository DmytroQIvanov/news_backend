-- Migration 007: Knowledge Graph entities/relations and AI Credibility / Retraction tracking

CREATE TABLE IF NOT EXISTS kg_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(80) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  entity_type varchar(32) NOT NULL CHECK (entity_type IN ('company', 'model', 'technology', 'product', 'event')),
  provider_id varchar(80),
  description_uk text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kg_relations (
  id bigserial PRIMARY KEY,
  from_entity_id uuid NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  to_entity_id uuid NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  relation_type varchar(48) NOT NULL,
  label_uk varchar(120),
  weight integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_kg_relation UNIQUE (from_entity_id, to_entity_id, relation_type)
);

CREATE TABLE IF NOT EXISTS news_entities (
  news_id bigint NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  role varchar(32) NOT NULL DEFAULT 'mentioned',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (news_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_news_entities_entity ON news_entities(entity_id);

ALTER TABLE news_items
  ADD COLUMN IF NOT EXISTS credibility_tier varchar(32) NOT NULL DEFAULT 'company_claim'
    CHECK (credibility_tier IN ('verified_fact', 'company_claim', 'independent_test', 'ai_inference')),
  ADD COLUMN IF NOT EXISTS is_retracted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS correction_note text,
  ADD COLUMN IF NOT EXISTS corrected_at timestamptz,
  ADD COLUMN IF NOT EXISTS corrected_by_news_id bigint REFERENCES news_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fact_claims jsonb NOT NULL DEFAULT '[]'::jsonb;
