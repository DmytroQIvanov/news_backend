-- Migration 006: AI provider pricing columns for sorting/filtering + Game Offers & Demos table

ALTER TABLE ai_catalogs
  ADD COLUMN IF NOT EXISTS subscription_price_usd numeric,
  ADD COLUMN IF NOT EXISTS min_input_price_per_1m numeric;

CREATE TABLE IF NOT EXISTS game_offers (
  id bigserial PRIMARY KEY,
  external_id varchar(160) NOT NULL UNIQUE,
  title varchar(350) NOT NULL,
  title_uk varchar(350),
  description_uk text,
  how_to_claim_uk text,
  offer_type varchar(24) NOT NULL DEFAULT 'giveaway'
    CHECK (offer_type IN ('giveaway', 'demo', 'beta', 'dlc', 'discount')),
  store_name varchar(64) NOT NULL,
  platforms jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_url text,
  url text NOT NULL,
  original_price varchar(32),
  is_free boolean NOT NULL DEFAULT true,
  worth_score integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  status varchar(24) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired')),
  ai_enriched boolean NOT NULL DEFAULT false,
  content_hash char(64) NOT NULL,
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_offers_active
  ON game_offers(status, offer_type, store_name, last_verified_at DESC);
