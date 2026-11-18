-- Automatic corroboration: for events with too few independent sources an AI search finds other reliable reports,
-- our collector fetches them, and a second AI pass vets every page (same event? reliable? independent? what kind of
-- source?). Only accepted pages count as extra sources in the dossier.
ALTER TABLE kb.events ADD COLUMN IF NOT EXISTS corroboration_attempts int NOT NULL DEFAULT 0;
ALTER TABLE kb.events ADD COLUMN IF NOT EXISTS corroboration_at timestamptz;
ALTER TABLE kb.event_research ADD COLUMN IF NOT EXISTS accepted boolean;
ALTER TABLE kb.event_research ADD COLUMN IF NOT EXISTS verdict jsonb;
CREATE INDEX IF NOT EXISTS idx_kb_event_research_pending ON kb.event_research (event_id)
  WHERE query = 'corroboration' AND accepted IS NULL;
