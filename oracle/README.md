# Helper server on Oracle (1 GB RAM)

Light services that bring extra sources into the knowledge base and watch the main server. Nothing here processes
text or calls LLMs — that stays on the main server.

## Setup
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo ufw allow 22,80,443/tcp && sudo ufw enable
cp .env.example .env && chmod 600 .env && nano .env
docker compose up -d
```
Oracle also blocks ports in the VCN security list: open 80 and 443 there too.

## How it feeds the knowledge base
- **RSSHub** — RSS for Telegram channels, YouTube channels and sites without feeds. Add the route as a source in the
  main app, e.g. `https://helper.example.com/rsshub/telegram/channel/<name>?key=<RSSHUB_ACCESS_KEY>` (category, license
  mode `headline_link`). kb-collector polls it like any RSS feed; texts go through the same pipeline and checks.
- **changedetection.io** — watch pages that have no RSS: government decisions, regulator registers, sanctions pages,
  procurement portals. In each watch enable its RSS feed and add that URL as a source; every change becomes a document
  (kind `official_statement` once the source tier is set to `primary` in `knowledge/kb/resources/source_tiers.yaml`).
  The image without a browser engine keeps memory low; pages that need JavaScript are better covered by RSSHub routes.
- **Gatus** — checks the API, the database, whether the knowledge-base editor is active, the LLM budget endpoint and
  RSSHub; failures and recoveries are pushed by **ntfy** (install the ntfy app and subscribe to the topic).
- **Ofelia** — scheduled housekeeping (image pruning); add jobs with labels.

## What not to put here (1 GB)
Redis (the queue lives in Postgres), FreshRSS/Miniflux (readers for people, duplicate the collector), Full-Text RSS
(trafilatura already extracts text), a permanent Scrapy worker or whisper.cpp (CPU/RAM). Video transcription is a
separate worker planned for the main server or run on schedule here with strict limits.
