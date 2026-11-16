# Opportunity Radar API

For the Expo Go setup, point the mobile app's `EXPO_PUBLIC_API_URL` at the API base URL. For a deployed backend, use the HTTPS URL assigned by Render.

NestJS 12 + TypeScript + PostgreSQL 17. Local Docker Compose -> GitHub -> Render Free (Docker) + Neon Free (managed PostgreSQL). Data flow: existing `ai_news_radar.py` -> `ai_news_uk.json` -> Python importer -> NestJS -> PostgreSQL -> mobile/web.

## Prerequisites (Windows)

- Docker Desktop with WSL2 integration running.
- Git for Windows. For easy GitHub push: GitHub CLI (`winget install GitHub.cli`).
- Node.js 22+ only if you want to run NestJS without Docker.
- Python 3.10+ if you want to run the existing news importer.

## 1. Start locally with one command

In **CMD**, from extracted project directory:

```cmd
copy .env.example .env
notepad .env
docker compose up -d --build
docker compose ps
curl http://localhost:3000/health
curl http://localhost:3000/health/db
```

In `.env`, set `POSTGRES_PASSWORD` and `INGEST_API_KEY` (32+ random chars) and update **both** local `DATABASE_URL`/`DIRECT_URL` to match new password for running Nest outside Docker. For Docker Compose, URLs are formed from `POSTGRES_*` and override `.env` inside API container. Use URL-safe alphanumeric passwords to simplify local Compose; production Neon URLs come from dashboard.

```cmd
docker compose logs -f api
docker compose down
```

`docker compose down` keeps the development database volume.

## 2. Import your existing Gemini news

First run your earlier `ai_news_radar.py` so it creates `ai_news_uk.json`. Then:

```cmd
python scripts\import_ai_news.py --file "C:\Users\Dmytro\Downloads\ai_news_uk.json" --dry-run
python scripts\import_ai_news.py --file "C:\Users\Dmytro\Downloads\ai_news_uk.json"
```

The importer asks for `INGEST_API_KEY` securely. Enter the same key as in `.env`. It only uploads RSS metadata and Gemini's labeled results; it **does not generate AI content** itself. API saves items as `needs_review` and won't publish them automatically.

To review and publish in Windows PowerShell (replace secret locally; never commit):

```powershell
$h = @{ 'x-ingest-key' = 'YOUR_SECRET' }
Invoke-RestMethod -Uri 'http://localhost:3000/api/v1/news/review' -Headers $h
Invoke-RestMethod -Method Patch -Uri 'http://localhost:3000/api/v1/news/1/publish' -Headers $h
Invoke-RestMethod 'http://localhost:3000/api/v1/news?limit=20'
```

## 3. Connect Neon PostgreSQL Free

1. Visit https://console.neon.tech and create a **Free** project in a nearby region.
2. Click **Connect**. Get **pooled** URL (with `-pooler`) for runtime `DATABASE_URL` and **direct** URL (without `-pooler`) for migrations `DIRECT_URL`.
3. Keep `sslmode=require` and any other security parameters supplied by Neon. Do not modify hostnames/passwords manually.
4. Store credentials only in hosting environment variables. Never commit `.env`.

Neon Free as of Nov 2026: 1 GB/project, 100 CU-hours per project per month, 5 GB transfer. Compute scales to zero after idle. Limits can change.

## 4. Push to GitHub

```cmd
winget install --id GitHub.cli -e
gh auth login
scripts\push_github.cmd opportunity-radar-api
```

After subsequent changes, run `scripts\update_github.cmd` to commit and push.

Or manually: `git init -b main`, `git add .`, `git commit -m "Initial API"`, then create a private repo on GitHub and `git push`. If you run `npm install` locally first, commit `package-lock.json`. CI uses the lock when available.

## 5. Free deploy to Render using `render.yaml`

1. Go to https://dashboard.render.com -> **New** -> **Blueprint** and connect your GitHub repository.
2. Render reads `render.yaml`, builds the included `Dockerfile` and deploys **one Free Web Service**, not a Render DB.
3. During Blueprint creation, fill the three prompted secrets:
   - `DATABASE_URL`: Neon **pooled** connection string.
   - `DIRECT_URL`: Neon **direct** connection string.
   - `INGEST_API_KEY`: same new random 32+ char admin secret used by importer.
4. In Render environment settings, adjust `CORS_ORIGINS` for your actual public web frontend domain (React Native native requests don't use browser CORS).
5. Visit your real Render URL, e.g. `https://YOUR-RENDER-SERVICE.onrender.com/health` and verify `database: connected`. Your actual host is assigned by Render.
6. Import your existing JSON remotely:

```cmd
python scripts\import_ai_news.py --file "C:\Users\Dmytro\Downloads\ai_news_uk.json" --api https://YOUR-RENDER-SERVICE.onrender.com
```

**Do not use Render Free Postgres** for a long-lived project: its free database expires after 30 days. Render free web instances sleep after 15 minutes idle and cold start can be slow. They have no uptime SLA. This setup is for MVP/testing, not 24/7 critical production.

Render startup runs forward-only migrations via `DIRECT_URL`. A failed migration fails the deploy. Migration advisory lock prevents two instances applying the same migration concurrently. Render Free lacks one-off predeploy migration jobs, so the entrypoint handles migrations.

## 6. Optional Docker Hub push

Docker Hub is an image registry, *not* a running server. Render doesn't require you to push a Docker image there if it can build from GitHub. If you still want a portable image:

```cmd
scripts\push_docker.cmd YOUR_DOCKERHUB_USERNAME
```

## 7. Development without rebuilding image

```cmd
copy .env.example .env
docker compose up -d db
npm install
npm run migrate
npm run start:dev
```

Make sure `.env` local connection strings match your PostgreSQL password and host port 5432. `npm install` creates `package-lock.json`; commit it. Avoid typing credentials into chat.

## 8. Routes

The news listing combines published database records with the latest linked headlines from Anthropic, OpenAI, Google DeepMind, Mistral AI, and Hugging Face. Anthropic and Mistral AI use community RSS mirrors. The API downloads the requested feeds on demand, caches successful downloads for 10 minutes, and can reuse the last successful result for up to 24 hours if a feed is unavailable. Feed headlines are served directly and keep their original titles and links. Imported records continue through the existing review workflow.

Set `GEMINI_API_KEY` in the Render service environment to enable editorial processing. `GEMINI_MODEL` defaults to `gemini-3.8-flash`. `GEMINI_RESEARCH` controls a separate research pass with Google Search and URL Context: `important` (default) runs it only for stories already reported by 2+ outlets or boosted by the planner, `all` runs it for every article, `off` disables it. Research uses your Gemini project quota. Edit `src/ingest/editorial-prompt.md` to change editorial instructions and redeploy.

### Objectivity layer (migration 022)

Each edited article now carries an `insight` object (English) and `insight_uk`: one-sentence and 5-point reading levels, "what it means for you", timeline, key players, glossary, a claims table (fact / official claim / opinion with confidence), how outlets framed the story, each side's position in its strongest form, analogs, open questions and key numbers. Before writing, the editor receives `STORY_MEMORY` — our own related coverage from the last 120 days — and the list of active topics.

- `GET /api/v1/topics`, `/topics/:slug`, `/topics/by-news/:id` — long-lived topic pages with an explainer (regenerated by `TopicsService`, capped by `TOPIC_SUMMARY_DAILY_MAX`), update log, articles and predictions.
- `GET /api/v1/feed/since?ts=` — "what changed since your last visit".
- `GET /api/v1/feed/other-perspective?deviceId=` — one story from a different kind of source when a reader's history is ≥70% one lens.
- `GET /api/v1/brief/daily` — finite daily brief (top stories, number of the day, one solutions story, explicit end). `muted` and `hideSensitive` are respected here and in `/feed`.
- `GET /api/v1/sources/profiles` — source cards (country, owner, funding, lens) and each source's corrections record.
- `GET /api/v1/news/:id/revisions` — public change history (filled by a database trigger). `POST /api/v1/news/:id/report-error` — sentence-level error reports. `GET /api/v1/predictions/stats` — how often our "what's next" expectations came true.
- `GET /api/v1/error-reports?status=open` and `PATCH /api/v1/error-reports/:id` (`{"status":"accepted","correctionNote":"..."}`) need `INGEST_API_KEY`. Accepting with a note publishes the correction on the article and adds it to the change history.
- Caricatures are no longer mixed into `/feed` unless `entertainment=1` is passed.

While the server is running, it processes up to one outstanding headline per company per cycle, starting shortly after startup and scheduling the next cycle ten minutes after the previous one finishes. It stores validated editorial JSON in the existing `ai_metadata` column before publishing RSS articles. Manual imports still enter review. Editorial fingerprints avoid spending tokens again on the same input, model, research setting, and prompt during ingestion. The Free Render web service may sleep, which pauses editorial processing until it wakes. Raw RSS headlines remain available before processing. Only published, Gemini-classified important stories appear with `important=true`.

| Method | Endpoint | Authorization | Function |
|---|---|---|---|
| GET | `/health` | Public | DB readiness |
| GET | `/health/db` | Public | Checks PostgreSQL with `SELECT 1` |
| GET | `/api/v1/news/test-notification` | Public | Static Anthropic test notification for the mobile screen |
| GET | `/api/v1/sources` | Public | Sources |
| GET | `/api/v1/news?limit=20&offset=0&category=api` | Public | **Published** news only |
| GET | `/api/v1/news?sources=openai-news,google-deepmind` | Public | Latest feed headlines and published database records from the specified source slugs |
| GET | `/api/v1/news?important=true` | Public | Published stories classified as important |
| GET | `/api/v1/news/:id` | Public | Source material or the full editorial article with citations |
| GET | `/api/v1/news/review` | `x-ingest-key` | Pending review |
| POST | `/api/v1/ingest/news` | `x-ingest-key` | Batch upsert source and up to 25 news |
| PATCH | `/api/v1/news/:id/publish` | `x-ingest-key` | Manual publish |

Data contract of POST `/api/v1/ingest/news`:

```json
{
  "source": {"slug":"anthropic-news","name":"Anthropic News","homepageUrl":"https://www.anthropic.com/news","unofficial":false},
  "items": [{
    "externalId":"demo-1",
    "url":"https://example.org/sample",
    "originalTitle":"Example title",
    "originalSummary":"Example RSS excerpt",
    "titleUk":"Приклад заголовка",
    "summaryUk":"Приклад викладу RSS",
    "category":"model",
    "importance":"medium",
    "freeAccess":"unknown"
  }]
}
```

All AI-derived data requires human review. Re-sending the same record and unchanged fields doesn't rewrite it. Changes reset an approved item back to `needs_review`.

### Insights: non-obvious links (migration 024)

`InsightsService` runs every hour (first run 4 minutes after start) and mostly uses scripts, not AI:

1. **Scan**: every new article is matched against entity aliases in `kg_entities.aliases`. Latin names match whole words; Ukrainian names match by word prefix, so case endings still match. Event types (funding, acquisition, partnership, launch, lawsuit, ...) and dollar amounts come from regex patterns in `news_event_tags`. New proper names from titles go to `entity_candidates`.
2. **Statistics**: articles are grouped into stories through `cluster_id`, so one press release counts once. For each entity pair the service computes co-mentions, PMI, NPMI and lift (`entity_pair_stats`).
3. **Graph**: it finds Louvain communities, PageRank, betweenness ("bridges") and Adamic-Adar scores, which suggest likely links that have not been mentioned yet (`entity_metrics`).
4. **Time**: it detects mention spikes (Poisson z-score), finds pairs where one entity's activity leads another's by a few days, and finds event sequences such as "funding → launch in about N days" (`event_sequence_stats`). It also links topics that share rare entities but no articles.
5. **Findings**: results go to `insight_links`, one per subject per day. Each finding has a title in Ukrainian and English and links to the articles behind it.

AI is used only when an LLM key is configured, and stays within `INSIGHTS_AI_DAILY_MAX` calls per day. It classifies repeated new names (whether each is a new entity or another name for an existing one) and writes a two-sentence explanation for a few top findings, using only the articles behind them. When a finding is not supported by those articles, it is hidden.

Public routes (`lang=uk|en`):

```text
GET /insights?kind=novel_pair|surprising_pair|predicted|bridge|burst|lead_lag|topic_link|sequence&days=7&limit=30
GET /insights/trends
GET /insights/patterns
GET /insights/entity/:slug
GET /insights/path?from=nvidia&to=mistral
GET /insights/news/:id/related
GET /insights/topics/:slug/related
GET /insights/status
```

Admin routes (header `x-ingest-key`):

```powershell
$h = @{ 'x-ingest-key' = $env:INGEST_API_KEY }
Invoke-RestMethod -Method Post -Headers $h http://127.0.0.1:3000/insights/run
Invoke-RestMethod -Headers $h http://127.0.0.1:3000/insights/candidates
# accept as a new entity, as an alias of an existing one, or reject
Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' -Body '{"action":"accept","type":"company","name":"Perplexity"}' http://127.0.0.1:3000/insights/candidates/12
Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' -Body '{"action":"accept","aliasOf":"google"}' http://127.0.0.1:3000/insights/candidates/13
Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' -Body '{"action":"reject"}' http://127.0.0.1:3000/insights/candidates/14
```

Settings are listed under "Insights" in `.env.example`.

## 9. Validation / limitations

- Run `npm run preflight`, `npm run typecheck`, `npm run build`, `python -m unittest discover -s tests -v`.
- Actual Docker and live database tests must be performed on your machine. This scaffold was statically checked, not live-deployed.
- No auth accounts, sophisticated source licensing, news revision snapshots, throttling, moderation UI or scheduled collectors yet: these are deliberate MVP omissions.
- PostgreSQL data lives in its own Docker volume locally and in Neon remotely, *not inside* the Docker image.
- Don't upload full copyrighted articles or treat RSS-only AI summaries as independently fact-checked.

## 10. Codex next step

Read [`docs/CODEX_TASK.md`](docs/CODEX_TASK.md) and execute its acceptance tests. It is intended as a precise task description for Codex to review and harden this scaffold.

## Official sources

- Render Free https://render.com/docs/free
- Render Blueprint https://render.com/docs/blueprint-spec
- Neon https://neon.com/docs/get-started/connect-neon
- Neon pooling https://neon.com/docs/connect/connection-pooling
- Docker Compose https://docs.docker.com/compose/
- NestJS https://docs.nestjs.com/

For alternative Koyeb Free and Supabase Free deployment instructions, see [`docs/OTHER_FREE_HOSTS.md`](docs/OTHER_FREE_HOSTS.md).
