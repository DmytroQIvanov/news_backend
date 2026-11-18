"""Budgeted escalation queue to an LLM. Algorithms decide WHAT is worth an LLM call; the consumer decides WHEN.

Producers call enqueue(); duplicates are ignored by dedupe_key, and a per-tier daily cap stops floods.
The consumer is src/kb/kb-llm-tasks.service.ts: it leases rows in priority order and answers them with Gemma.

The tier is only a separate daily cap on how many tasks of that kind may be queued.
"""
from __future__ import annotations

import logging

from .. import db
from ..config import settings

log = logging.getLogger(__name__)

_BUDGET = {"lite": lambda: settings.llm_daily_lite, "standard": lambda: settings.llm_daily_standard, "deep": lambda: settings.llm_daily_deep}


def enqueue(task_type: str, dedupe_key: str, payload: dict, priority: float = 0.0, tier: str = "lite", conn=None) -> bool:
    budget = _BUDGET.get(tier, _BUDGET["lite"])()
    sql_count = "SELECT count(*) AS n FROM kb.llm_tasks WHERE tier = %s AND created_at > date_trunc('day', now())"
    sql_insert = """INSERT INTO kb.llm_tasks (task_type, dedupe_key, priority, tier, payload)
                    VALUES (%s, %s, %s, %s, %s::jsonb) ON CONFLICT (dedupe_key) DO NOTHING"""
    args = (task_type, dedupe_key[:400], priority, tier, db.jsonb(payload))
    if conn is not None:
        n = conn.execute(sql_count, (tier,)).fetchone()["n"]
        if n >= budget:
            return False
        return conn.execute(sql_insert, args).rowcount > 0
    row = db.fetch_one(sql_count, (tier,))
    if row and row["n"] >= budget:
        log.debug("llm budget for tier %s exhausted today", tier)
        return False
    return db.execute(sql_insert, args) > 0
