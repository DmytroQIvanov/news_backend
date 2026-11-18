# Proposed 1 GiB deployment profile

This is a repository proposal, not a deployed or measured configuration. No hosts,
containers, credentials, environment files, databases or service placement were inspected
or changed. Live topology remains **unverified** under this task's offline restriction.

The repository describes two distinct stacks:

| Definition | Intended placement | Role |
| --- | --- | --- |
| `compose.server.yaml` | Main server, size unverified | PostgreSQL, API, collector, NLP, connectors, video, maintenance, backup, optional proxy |
| `oracle/compose.yaml` | Separate 1 GiB Oracle helper, per its comments | RSSHub, page watches, monitoring, notifications, scheduler and proxy |
| `compose.low-memory.yaml` | Proposed override for a main server on 1 GiB | Database + serving API + one collector; heavy work excluded from default startup |

Do not add the helper stack to the main VM's memory allowance. An operator must first
record actual hosts, container placement, memory and swap, database size, source count,
network access between hosts, and the separate machine available for heavy jobs.

The override caps PostgreSQL at 256 MiB, Node at 256 MiB (160 MiB heap), and the collector
at 128 MiB with one fetch at a time. PostgreSQL uses 64 MiB shared buffers, 2 MiB work
memory, 32 MiB maintenance memory, 24 connections and no parallel query workers.
Migration is a one-shot 128 MiB process before the API/collector start. Container limits
are ceilings, not measured RSS; the steady default ceiling totals 640 MiB before the
host, Docker and optional proxy. Existing volumes are inherited without replacement.

Editorial, translation and decorative API schedulers are disabled on this VM. NLP,
embedding, connectors, video, maintenance and backup are opt-in profiles, excluded
from ordinary startup. Run the heavy workers on a verified existing separate machine,
one job at a time, against the same database and quota ledger. Keep embeddings disabled
for the initial measurement; use a single NLP worker with `KB_NLP_BATCH=1`, single video
thread and one editorial/translation batch at a time. Schedule backups and maintenance
on that machine outside peak ingest hours. This document does not establish a remote
worker deployment or a backup schedule: those require verified placement and operator
review. Ingest continues locally; publication depends on the separate processing workers.

After review, the proposed file combination is:

```text
docker compose -f compose.server.yaml -f compose.low-memory.yaml --env-file .env.server config
```

This command is for operator review only; it was not run here because resolving the
existing environment can expose secrets. Do not run `up`, relocate workers, change live
database settings or activate profiles until that review and a backup are complete.

Before adoption, record a 24-hour representative workload with embeddings disabled:

| Measurement | Acceptance / record |
| --- | --- |
| Aggregate container RSS and host available RAM, sampled each minute | Aggregate RSS stays below 800 MiB; retain p50/p95/max |
| Container restart counters / kernel OOM records | Zero OOM restarts |
| Swap-in/out and memory pressure | No sustained swapping; record pressure periods |
| Collected, extracted, clustered and published documents/hour | Record each stage throughput and backlog start/end |
| Oldest backlog age and last successful worker completion | No increasing stalled backlog; check guarded `/health/diagnostics` |
| Feed latency and availability | Record p50/p95 and failure count during ingest |
| Publication and quota safeguards | Missing evidence/review and quota outage still hold work |

No measurements are claimed. If the separate machine is unavailable, keep the heavy
profiles disabled and report stalled processing; do not relax publication safeguards.
