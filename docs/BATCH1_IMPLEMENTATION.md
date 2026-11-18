# Batch 1 operating notes

`src/news/eligibility.ts` owns publication evidence SQL. All news readers require AI
authorship, published status and two usable independent origins. Explicit evidence
roots / owner groups collapse syndication; otherwise normalized URL hosts are used.
Full/partial source URLs count; blocked, failed and teaser sources do not. A KB event
may supply `kb.events.independent_source_count`; a non-null event ID alone never qualifies.
Document count and independent-origin count are separate additive fields in the feed.
Publisher identity improvements beyond explicit lineage remain P06 work.

KB candidates require exactly one valid review verdict for their event and the reviewed
content. Missing, duplicate, malformed or failed reviews hold publication. Patches,
rewrites and expansion require a new review; this batch conservatively holds them.
Unresolved issues retain stable event/issue IDs. Short-article rescue cannot approve
review. Held updates are stored in `ai_metadata.kb_candidate`, preserving the published
article; reconsideration/manual resolution of those candidates is operational follow-up.
Translations and manual publishing recheck evidence/review in the update statement.

`knowledge/kb/quotas.v1.json` is packaged in both runtimes. Defaults are 500/20/20/20
for Gemini 3.1 Flash Lite / 3 Flash / 2.5 Flash Lite / Hydrogen. Gemma has no daily cap;
its existing client rate/concurrency limits remain. Empty quota environment overrides
use these defaults. Both runtimes reserve under the same UTC-day advisory lock before
each attempt. Accounting failure defers budgeted calls. OpenRouter free targets share
the `openrouter:account` ledger key, and paid targets are excluded. The shared reserved
pool protects review, verification, corroboration and translation from decorative work;
purpose alternatives in `LLM_BUDGET_RESERVED` are separated by `|`.

`GET /health/diagnostics` uses the existing `IngestKeyGuard` credentials. Its aggregates
have a 30-second cache with a shared in-flight refresh. It returns only counts, stage
ages, worker timestamps/states, publication-block counts, translation failures, quota
deferrals and memory pressure. A run unfinished for 30 minutes is stalled even when
new runs keep starting; recent successful completion means progressing, a fresh active
run without recent success means running. Missing tables/failed queries are explicitly
unavailable. Public `/health` stays small. Local quota-accounting deferrals are counted
since process start; persisted provider deferrals are grouped for the current UTC day.

Migration 039 adds diagnostic indexes only. It has operator-run rollback statements;
no migration was applied during implementation. See `LOW_MEMORY_PROFILE.md` for the
P04 proposal and the unperformed live-topology and 24-hour measurement requirements.

Changed files by area:

| Area | Files |
| --- | --- |
| News policy/readers | `src/news/eligibility.ts`, `news.controller.ts`, `objectivity.controller.ts`, `topics.service.ts`, `story-briefing.service.ts`, `audio-briefing.service.ts`, `news-tts.service.ts`, `expert-opinions.service.ts`, `caricature.service.ts` |
| Publication/review | `src/ingest/ingest.service.ts`, `src/kb/kb-review.ts`, `kb-editorial.service.ts`, `kb-flagship.service.ts`, `kb-translation.service.ts`, `kb.controller.ts` |
| Quotas/packaging | `src/common/llm-budget.ts`, `llm-router.ts`, `gemini-client.ts`, `knowledge/kb/quotas.v1.json`, `knowledge/kb/config.py`, `knowledge/kb/video/gemini.py`, `worker.py`, `Dockerfile` |
| Diagnostics/schema | `src/health/health.controller.ts`, `pipeline-diagnostics.ts`, `migrations/039_pipeline_diagnostics.sql` |
| Tests/CI | `tests/batch1.test.mjs`, `batch1_python.py`, `quota-ledger.cjs`, `backend.test.mjs`, `kb.test.mjs`, `knowledge/tests/test_eval_quality.py`, `package.json`, `.github/workflows/check.yml`, `knowledge.yml` |
| P04/docs | `compose.low-memory.yaml`, `docs/LOW_MEMORY_PROFILE.md`, this document |

Validation includes an optional standalone PostgreSQL fixture test when local binaries
are available (`BATCH1_POSTGRES_BIN` can select their directory). It initializes a new
disposable cluster in the system temp directory and uses single-user mode with no
server/socket. Existing databases and migrations are never accessed by this test.
