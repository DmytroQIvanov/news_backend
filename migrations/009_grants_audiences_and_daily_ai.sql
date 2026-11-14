-- Migration 009: Grant Audiences, Hackathons/Contests & Daily AI Verification Metadata

ALTER TABLE grants_opportunities
  ADD COLUMN IF NOT EXISTS audiences JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS target_audience_uk TEXT NOT NULL DEFAULT 'Стартапи та розробники',
  ADD COLUMN IF NOT EXISTS last_ai_verified_at timestamptz;

DO $$
DECLARE
  constraint_rec record;
BEGIN
  FOR constraint_rec IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'grants_opportunities'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%opportunity_type%'
  LOOP
    EXECUTE format('ALTER TABLE grants_opportunities DROP CONSTRAINT IF EXISTS %I', constraint_rec.conname);
  END LOOP;
END $$;

ALTER TABLE grants_opportunities
  ADD CONSTRAINT grants_opportunities_opportunity_type_check
  CHECK (opportunity_type IN ('grant', 'hackathon', 'accelerator', 'contest', 'cloud_credits', 'fellowship', 'competition'));

CREATE INDEX IF NOT EXISTS idx_grants_audiences_gin
  ON grants_opportunities USING gin (audiences);
