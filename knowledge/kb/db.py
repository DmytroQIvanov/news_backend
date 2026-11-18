"""PostgreSQL access. The database is the queue: workers claim rows with FOR UPDATE SKIP LOCKED,
so any number of worker containers can run side by side without Redis or a broker."""
from __future__ import annotations

import atexit
import contextlib
import json
import logging
from collections.abc import Iterator, Sequence
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

log = logging.getLogger(__name__)

_pool: ConnectionPool | None = None
_features: dict[str, bool] | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        if not settings.database_url:
            raise RuntimeError("Set KB_DATABASE_URL or DATABASE_URL")
        _pool = ConnectionPool(
            settings.database_url,
            min_size=1,
            max_size=4,
            kwargs={"row_factory": dict_row, "autocommit": False},
            open=True,
        )
        atexit.register(_close_pool)
    return _pool


def _close_pool() -> None:
    global _pool
    if _pool is not None:
        try:
            _pool.close(timeout=2)
        except Exception:
            pass
        _pool = None


@contextlib.contextmanager
def tx() -> Iterator[psycopg.Connection]:
    """One transaction; commits on success, rolls back on error."""
    with pool().connection() as conn:
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def fetch_all(sql: str, args: Sequence[Any] | dict | None = None) -> list[dict]:
    with tx() as conn:
        return list(conn.execute(sql, args).fetchall())


def fetch_one(sql: str, args: Sequence[Any] | dict | None = None) -> dict | None:
    with tx() as conn:
        return conn.execute(sql, args).fetchone()


def execute(sql: str, args: Sequence[Any] | dict | None = None) -> int:
    with tx() as conn:
        return conn.execute(sql, args).rowcount


def features() -> dict[str, bool]:
    """Which optional extensions/tables exist (pgvector, pg_trgm)."""
    global _features
    if _features is None:
        rows = fetch_all("SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm')")
        names = {r["extname"] for r in rows}
        emb = fetch_one("SELECT to_regclass('kb.document_embeddings') IS NOT NULL AS ok")
        _features = {
            "vector": "vector" in names and bool(emb and emb["ok"]),
            "trgm": "pg_trgm" in names,
        }
        log.info("database features: %s", _features)
    return _features


def jsonb(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def claim_documents(stage: str | list[str], limit: int, lease_s: int = 600) -> list[dict]:
    """Lease a batch of documents in `stage`. A crashed worker's lease expires and the rows are picked up again."""
    stages = [stage] if isinstance(stage, str) else list(stage)
    with tx() as conn:
        rows = conn.execute(
            """
            WITH picked AS (
              SELECT id FROM kb.documents
              WHERE stage = ANY(%s) AND (locked_until IS NULL OR locked_until < now()) AND stage_attempts < 5
              ORDER BY id
              LIMIT %s
              FOR UPDATE SKIP LOCKED
            )
            UPDATE kb.documents d
            SET locked_until = now() + make_interval(secs => %s), stage_attempts = d.stage_attempts + 1,
                lease_token = gen_random_uuid()
            FROM picked WHERE d.id = picked.id
            RETURNING d.*
            """,
            (stages, limit, lease_s),
        ).fetchall()
    return list(rows)


class LeaseLost(RuntimeError):
    """The row was taken over by another worker after our lease expired: drop our result."""


def renew_lease(doc: dict, lease_s: int = 600) -> None:
    """Called before each document of a batch, so a long batch never outlives its lease."""
    n = execute(
        "UPDATE kb.documents SET locked_until = now() + make_interval(secs => %s) WHERE id = %s AND lease_token = %s",
        (lease_s, doc["id"], doc["lease_token"]),
    )
    if n == 0:
        raise LeaseLost(f"document {doc['id']}")


def check_lease(conn: psycopg.Connection, doc: dict) -> None:
    """First statement of every write transaction on a leased document. The row lock also blocks a concurrent
    claim (claims use SKIP LOCKED) until our transaction ends."""
    row = conn.execute(
        "SELECT 1 FROM kb.documents WHERE id = %s AND lease_token = %s FOR UPDATE", (doc["id"], doc.get("lease_token"))
    ).fetchone()
    if row is None:
        raise LeaseLost(f"document {doc['id']}")


def release(conn: psycopg.Connection, doc: dict, stage: str) -> None:
    """Final write of a stage: move on and give the row back to the queue."""
    conn.execute(
        """UPDATE kb.documents SET stage = %s, locked_until = NULL, lease_token = NULL, stage_attempts = 0,
                  last_error = NULL, updated_at = now()
           WHERE id = %s AND lease_token = %s""",
        (stage, doc["id"], doc.get("lease_token")),
    )


def expire_exhausted() -> int:
    """Rows whose 5th lease expired (worker crashed) would otherwise stay invisible forever."""
    return execute(
        """UPDATE kb.documents SET stage = 'error', locked_until = NULL,
                  last_error = COALESCE(last_error, 'lease expired after 5 attempts'), updated_at = now()
           WHERE stage IN ('new', 'extracted', 'analyzed') AND stage_attempts >= 5
             AND (locked_until IS NULL OR locked_until < now())"""
    )


@contextlib.contextmanager
def advisory_lock(key: int) -> Iterator[None]:
    """Session-level advisory lock held on its own connection: serializes a critical section across replicas."""
    with pool().connection() as conn:
        conn.autocommit = True
        conn.execute("SELECT pg_advisory_lock(%s)", (key,))
        try:
            yield
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (key,))
            conn.autocommit = False


def try_advisory_lock(key: int):
    """Non-blocking variant for singleton jobs: returns a context manager or None if another process holds it."""
    conn_cm = pool().connection()
    conn = conn_cm.__enter__()
    conn.autocommit = True
    got = conn.execute("SELECT pg_try_advisory_lock(%s) AS ok", (key,)).fetchone()["ok"]
    if not got:
        conn.autocommit = False
        conn_cm.__exit__(None, None, None)
        return None

    @contextlib.contextmanager
    def held():
        try:
            yield
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (key,))
            conn.autocommit = False
            conn_cm.__exit__(None, None, None)

    return held()


def set_stage(conn: psycopg.Connection, doc_id: int, stage: str, error: str | None = None) -> None:
    conn.execute(
        """UPDATE kb.documents
           SET stage = %s, locked_until = NULL, last_error = %s::text,
               stage_attempts = CASE WHEN %s::text IS NULL THEN 0 ELSE stage_attempts END, updated_at = now()
           WHERE id = %s""",
        (stage, error, error, doc_id),
    )


def fail_document(doc: dict, error: str) -> None:
    """Record an error; after 5 attempts the row moves to stage 'error' and stops being retried.
    Only the lease owner may do this (a stale worker's failure must not touch a row someone else now holds)."""
    execute(
        """UPDATE kb.documents
           SET last_error = %s, locked_until = now() + interval '10 minutes', lease_token = NULL,
               stage = CASE WHEN stage_attempts >= 5 THEN 'error' ELSE stage END, updated_at = now()
           WHERE id = %s AND lease_token IS NOT DISTINCT FROM %s""",
        (error[:500], doc["id"], doc.get("lease_token")),
    )


class RunRecorder:
    """Writes one kb.pipeline_runs row per loop iteration for monitoring."""

    def __init__(self, worker: str):
        self.worker = worker
        self.stats: dict[str, Any] = {}
        self.run_id: int | None = None

    def __enter__(self) -> "RunRecorder":
        row = fetch_one("INSERT INTO kb.pipeline_runs (worker) VALUES (%s) RETURNING id", (self.worker,))
        self.run_id = row["id"] if row else None
        return self

    def add(self, key: str, n: int | float = 1) -> None:
        self.stats[key] = self.stats.get(key, 0) + n

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.run_id is None:
            return
        try:
            execute(
                "UPDATE kb.pipeline_runs SET finished_at = now(), stats = %s::jsonb, error = %s WHERE id = %s",
                (jsonb(self.stats), str(exc)[:500] if exc else None, self.run_id),
            )
        except Exception:  # monitoring must never break the pipeline
            log.exception("could not record pipeline run")
