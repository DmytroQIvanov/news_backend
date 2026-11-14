-- Migration 008: Grants, Accelerators, Cloud Credits & Opportunity Tracking
CREATE TABLE IF NOT EXISTS grants_opportunities (
  id bigserial PRIMARY KEY,
  external_id varchar(160) NOT NULL UNIQUE,
  title varchar(350) NOT NULL,
  title_uk varchar(350) NOT NULL,
  organization varchar(180) NOT NULL,
  country_code varchar(32) NOT NULL,
  country_label_uk varchar(80) NOT NULL,
  region_details_uk varchar(240),
  sector varchar(48) NOT NULL,
  sector_label_uk varchar(100) NOT NULL,
  opportunity_type varchar(32) NOT NULL DEFAULT 'grant'
    CHECK (opportunity_type IN ('grant', 'accelerator', 'cloud_credits', 'fellowship', 'competition')),
  funding_amount varchar(120) NOT NULL,
  funding_max_usd numeric NOT NULL DEFAULT 0,
  equity_free boolean NOT NULL DEFAULT true,
  co_financing_pct integer NOT NULL DEFAULT 0,
  stage varchar(48) NOT NULL DEFAULT 'mvp',
  deadline_at timestamptz,
  is_rolling boolean NOT NULL DEFAULT false,
  summary_uk text NOT NULL,
  eligibility_uk text NOT NULL,
  requirements_uk jsonb NOT NULL DEFAULT '[]'::jsonb,
  application_tips_uk text,
  official_url text NOT NULL,
  worth_score integer NOT NULL DEFAULT 85,
  status varchar(24) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired')),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grants_active_filters
  ON grants_opportunities(status, country_code, sector, opportunity_type, worth_score DESC);
