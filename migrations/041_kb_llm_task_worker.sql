-- Worker for kb.llm_tasks: leases survive crashes, quota waits do not count as failures.
ALTER TABLE kb.llm_tasks ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE kb.llm_tasks ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE kb.llm_tasks ADD COLUMN IF NOT EXISTS not_before timestamptz;
ALTER TABLE kb.llm_tasks ADD COLUMN IF NOT EXISTS last_error text;
CREATE INDEX IF NOT EXISTS idx_kb_llm_tasks_leases ON kb.llm_tasks (lease_until) WHERE status = 'running';

-- The AI assessment is stored beside the fact: it never changes the status the algorithms derived from the evidence.
ALTER TABLE kb.facts ADD COLUMN IF NOT EXISTS llm_verdict jsonb;
