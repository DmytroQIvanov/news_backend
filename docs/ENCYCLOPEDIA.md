# Automatic encyclopedia

Apply migration `040_automatic_encyclopedia.sql` through the existing migration runner before starting the new backend. It has no seed rows. Migrations were not executed during this offline change.

`EncyclopediaService` starts after 90 seconds and schedules the next run after the previous run finishes. Each run acquires a PostgreSQL advisory session lock, uses that same connection, and visits a bounded, fair batch. Ineligible entities have separate refresh state, so they cannot monopolize selection. Existing entries are checked again even if their entity becomes rejected/merged; withdrawn/expired evidence hides entries. A hidden entry can return when evidence qualifies again. Slugs remain stable when names change.

Recent usable, nonduplicate KB documents must have at least two independent evidence roots/owners. Published articles pass the shared `NEWS_ELIGIBILITY_SQL` gate and retraction check; their source lineage can also establish independent evidence. Mention totals alone and seeded/Wikidata identities never qualify an entry. Ranking uses observed event importance, document salience and published article importance. At least one cited section is required, avoiding empty name-only profiles.

Facts retain status, negation and planned modality. Claims remain explicitly attributed/unconfirmed; events retain dates and storylines. Relations require a matching corroborated/confirmed positive fact or a Wikidata edge. Related entries may also come from KB co-occurrence edges. Citations reference the original usable documents and eligible published news. API reads recheck related news eligibility, including timeline links.

Only the introductory paragraph uses `gemmaJson`. It selects up to three complete statements from the collected bilingual facts/reporting. Exact statement validation preserves names, numbers, status, negation and predicate direction; a vocabulary-only check would permit invented claims using familiar words. Failure, missing credentials or disabled introductions uses the first short deterministic statement. No model selects entries, facts, categories, relations or events. `gemmaJson` uses the existing Gemini client and shared `llm-budget.ts` reservations; Gemma is uncapped, cheap fallback models retain their shared budgets.

Category tags come from observed event/article categories, entity kind and locally available Wikidata P31 classes. `encyclopedia_categories` is a view over visible entries, so its counts and labels cannot retain empty seed categories. Multilingual labels use stored `category_labels`, `kind_labels` and cached Wikidata labels. If a translation is absent, the source label/identifier is retained rather than inventing a translation. The Python Wikidata importer now preserves P31 IDs and Ukrainian descriptions on existing entities too. Existing caches are read locally; refresh does not make registry requests. Model introductions are the only new external HTTP capability at runtime.

## Configuration

No `.env` file is required or changed by this implementation. Configure through the deployment environment.

| Variable | Default | Bound / purpose |
| --- | --- | --- |
| `ENCYCLOPEDIA_ENABLED` | enabled | `false` disables scheduling, reads remain available |
| `ENCYCLOPEDIA_INTERVAL_MS` | 1800000 | 60000–86400000; delay after each cycle |
| `ENCYCLOPEDIA_START_DELAY_MS` | 90000 | 1000–86400000 |
| `ENCYCLOPEDIA_BATCH_SIZE` | 6 | 1–20 entities per cycle |
| `ENCYCLOPEDIA_CYCLE_MS` | 120000 | 5000–600000; stop starting new entities after this elapsed time; an in-flight bounded model request finishes |
| `ENCYCLOPEDIA_EVIDENCE_LIMIT` | 24 | 4–40 rows per evidence type per entity |
| `ENCYCLOPEDIA_EVIDENCE_DAYS` | 90 | 1–730 days |
| `ENCYCLOPEDIA_MIN_OUTLETS` | 2 | 2–20; cannot relax independence below two |
| `ENCYCLOPEDIA_MIN_IMPORTANCE` | 0.15 | 0–1 |
| `ENCYCLOPEDIA_INTRO_ENABLED` | enabled | `false` uses deterministic introductions only |
| `ENCYCLOPEDIA_INTRO_TIMEOUT_MS` | 15000 | 1000–30000 per model attempt; existing client retry/quota rules apply |

All work is asynchronous I/O with sequential bounded entity processing. Fast hiding is capped at 100 rows per cycle; class tags and related cards at 12; citations at three per fact/event; related news at 20. Published importance maps to 1 for highlighted articles and 0.25 for ordinary articles; event importance/document salience can raise the score. Queries exclude document bodies, limit long claim/title fields, and reuse existing indexes plus new fact-citation indexes. Refresh state prevents unnecessary model calls when the canonical evidence hash is unchanged. Defaults favor the 1 GB server; a large cold knowledge base populates progressively rather than all at once.

## Read API and mobile

* `GET /api/v1/encyclopedia/categories?lang=uk|en` → `{items:[{slug,label,label_uk,count}]}`.
* `GET /api/v1/encyclopedia?lang=&category=&q=&kind=&limit=&cursor=` → `{items,nextCursor}`. Default page 20, maximum 50, stable importance/ID keyset cursor. Queries treat `%` and `_` literally. Available `pg_trgm` adds typo matching; otherwise ILIKE works without the extension.
* `GET /api/v1/encyclopedia/:slug?lang=uk|en` → localized entry, sections, timeline, related entries, eligible related news and IDs. Missing/hidden entries return 404.

Controllers advertise public caching for 180 seconds. The shared cache now also matches the collection root and query string, retains its bounded stale-outage behavior, and keeps languages separate through query keys.

Mobile adds Expo Router routes `/encyclopedia` and `/encyclopedia/[slug]`, reachable through the Encyclopedia link below the existing home header. Categories are server-derived chips; search is debounced and filter changes remount results to isolate stale responses. Lists load one page at a time. Details include clickable citations, dates, storylines and related navigation. Both themes, both locale dictionaries, accessible controls, loading/empty/error/retry states are supported. No fabricated encyclopedia fallback is shipped.

Live PostgreSQL execution, migration application, live model quality and device navigation were not exercised because this task prohibits network calls. SQL/API behavior has fixture-based regression coverage; production data and query plans still require a deployment verification.
