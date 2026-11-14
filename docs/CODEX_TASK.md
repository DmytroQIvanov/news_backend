# Codex handoff: Opportunity Radar backend

You are working on an existing NestJS 12 + PostgreSQL Docker starter. Preserve its API contracts and deployment approach. Do not replace NestJS, PostgreSQL or move this project to a non-Docker runtime without approval.

## Goal

Ship a secure and reproducible API for a news/opportunity aggregator to Render Free (Docker web service) with Neon Free PostgreSQL. Dev mode must work with `docker compose up -d --build`. Existing Python `ai_news_radar.py` writes `ai_news_uk.json`; `scripts/import_ai_news.py` imports that data. Records must require review before publication.

## Critical tasks (in this order)

1. Run `npm install`, commit generated `package-lock.json`, use `npm ci` consistently in Dockerfile and CI. Pin stable, security-patched dependency versions. Do not fabricate lockfiles.
2. Run `npm run typecheck`, `npm run build`, `npm run preflight`, `python -m unittest discover -s tests -v`, `docker compose config`, and `docker compose up --build -d`. Fix all actual failures, then exercise health, ingest, review, publish and public news endpoints against local PostgreSQL.
3. Check and update docs for actual Windows CMD commands, Render Blueprint free plan, Neon direct/pooled URLs. Validate `render.yaml` against current Render documentation; never commit secrets.
4. Add integration tests (ephemeral test DB) for idempotent ingest, source-level uniqueness, changed-content re-review, invalid data, unauthenticated mutation, and pagination. No data should be published by AI automatically.
5. Make response contracts consistent (prefer camelCase), provide OpenAPI docs in dev mode only, and create explicit versioned DTO types for mobile/web. Retain simple API response shape where already used.
6. Add basic rate limiting for write routes, request body size limit, structured logs without secret contents, safe error responses, and a safe graceful shutdown path.
7. Improve migration/rollback strategy. Forward-only migrations are fine for MVP; prevent concurrent deploy race via advisory lock. Neon DIRECT_URL is required for schema operations; pooled DATABASE_URL for runtime. Make readiness checks meaningful and keep Render startup migrations safe.
8. Define an adapter interface for feed collectors, quality control flags, content change tracking, and source license metadata. Do not re-publish copyrighted full articles. Show original links and RSS-only confidence.
9. Add deployment smoke script (no key printed) and document secrets configuration in Render Dashboard and Neon Console. Do not claim deployment was successful without an actual live check.
10. Keep total monthly infrastructure expense at $0 as long as provider free limits permit, and document trade-offs: Render spin-down, Neon scale-to-zero, free quotas, no SLA.

## Non-negotiables

- No API keys or DATABASE_URL in source control, screenshots, output or commit messages.
- No fake article content, dates, pricing, AI availability, or usage statistics.
- Avoid `synchronize: true` / `schema push` in production; migrations only.
- Public GET endpoints must never expose draft news; publish must require the ingestion admin key.
- Protect against SQL injection with parameterized queries and validate all inputs.
- Use source-provided facts; AI-derived claims require human review and attribution.
- Preserve manual approval by default.
- Do not continuously ping free hosting to defeat idle sleep.

## Acceptance criteria

- `docker compose up -d --build` starts `api` + PostgreSQL and GET `http://localhost:3000/health` returns database connected.
- `scripts/import_ai_news.py --dry-run --file ...` validates import without calling the server.
- Authorized ingest inserts drafts; repeat payload yields zero writes; changed payload resets article to review; publish endpoint makes article public.
- GitHub push + Render Blueprint + Neon PostgreSQL can be configured using README without editing TS source.
- Tests, build and migration work in CI and a clean Docker image.

Provide a precise summary of changed files, executed commands, actual test results and remaining risks. Never claim success for operations you did not execute.
