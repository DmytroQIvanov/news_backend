-- 'quoted' = a person quoted in several events; 'expert' only when the knowledge base also has a description or Wikidata identity.
ALTER TABLE discovered_people DROP CONSTRAINT IF EXISTS discovered_people_kind_check;
ALTER TABLE discovered_people ADD CONSTRAINT discovered_people_kind_check CHECK (kind IN ('author', 'expert', 'editor', 'quoted'));
