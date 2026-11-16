-- Migration 025: daily AI usage and failure statistics (Gemini / Groq / OpenRouter).
-- One row per UTC day, provider, model, task and outcome. Written in batches by LlmStatsService,
-- read by GET /ai/stats to tune the free-tier limits.
CREATE TABLE IF NOT EXISTS llm_usage_daily (
  day date NOT NULL,
  provider varchar(24) NOT NULL,
  model varchar(120) NOT NULL,
  task varchar(48) NOT NULL,
  -- ok | rate_limited | http_error | timeout | no_content | exhausted | skipped_daily | skipped_rpm | skipped_tpm | skipped_size | skipped_cooldown | skipped_local
  outcome varchar(24) NOT NULL,
  count integer NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0,
  latency_ms bigint NOT NULL DEFAULT 0,
  last_detail text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, provider, model, task, outcome)
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_daily_day ON llm_usage_daily (day DESC);
