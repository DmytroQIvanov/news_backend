"""Event aggregates, importance score and editorial state — the gate against "garbage news" (task 1).

An event becomes article material only when the evidence supports it:
  ready  >= KB_READY_MIN_SOURCES independent owner groups (or one primary source), at least one full-text document,
         and importance >= 0.35. A paywalled teaser alone never qualifies.
  deep   >= KB_DEEP_MIN_SOURCES independent groups, 3+ full texts, importance >= 0.6, and enough history in the graph
         (linked past events or several facts) to write a long-read with context. Candidates for the flagship pieces.
  skipped  closed without reaching 'ready': kept as context for future articles, never published alone.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

from .. import db
from ..config import settings
from ..llm.queue import enqueue

# Audience weight per category (Ukrainian general-news site). Tunable without code changes later.
CATEGORY_WEIGHT = {
    "defense": 1.0, "politics": 0.95, "economy": 0.85, "finance": 0.75, "law": 0.7, "climate_energy": 0.75,
    "cybersecurity": 0.7, "health": 0.7, "science_space": 0.6, "model": 0.7, "ai_policy": 0.7, "global_tech": 0.6,
    "business": 0.6, "hardware_gaming": 0.5, "startups_fintech": 0.5, "research": 0.55, "culture": 0.45, "sports": 0.4,
}
HIGH_STAKES = {"acquire", "sanction", "appoint", "dismiss", "resign", "capture", "liberate", "ban", "approve", "detain", "charge", "convict", "fine", "pledge"}


def _clip(x: float) -> float:
    return max(0.0, min(1.0, x))


def refresh_event(event_id: int) -> dict:
    with db.tx() as conn:
        # Lock first: a concurrent refresh must not overwrite newer counts with an older snapshot.
        ev = conn.execute("SELECT * FROM kb.events WHERE id = %s FOR UPDATE", (event_id,)).fetchone()
        if ev is None:
            return {}
        agg = conn.execute(
            """SELECT count(*) AS docs,
                      count(DISTINCT d.source_id) AS sources,
                      count(DISTINCT COALESCE(d.evidence_root, p.owner_group, d.source_id::text))
                        FILTER (WHERE ed.role <> 'reprint' AND d.extraction_status IN ('full', 'partial')) AS independent,
                      count(DISTINCT d.source_id) FILTER (WHERE p.tier IN ('primary', 'data')) AS primaries,
                      count(*) FILTER (WHERE d.extraction_status = 'full' AND ed.role <> 'reprint') AS full_docs,
                      count(*) FILTER (WHERE COALESCE(d.published_at, d.created_at) > now() - interval '6 hours') AS recent,
                      min(COALESCE(d.published_at, d.created_at)) AS started,
                      max(COALESCE(d.published_at, d.created_at)) AS last_doc
               FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id
               LEFT JOIN kb.source_profiles p ON p.source_id = d.source_id
               WHERE ed.event_id = %s""",
            (event_id,),
        ).fetchone()
        cat = conn.execute(
            """SELECT d.category, sum(COALESCE(d.category_confidence, 0.3)) AS w
               FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id
               WHERE ed.event_id = %s AND d.category IS NOT NULL GROUP BY d.category ORDER BY w DESC LIMIT 1""",
            (event_id,),
        ).fetchone()
        etype = conn.execute(
            """SELECT c.predicate, count(*) AS n FROM kb.claims c
               WHERE c.event_id = %s AND c.predicate NOT IN ('state', 'announce', 'deny') AND c.confidence >= 0.45
               GROUP BY c.predicate ORDER BY n DESC LIMIT 1""",
            (event_id,),
        ).fetchone()
        prominence = conn.execute(
            """SELECT COALESCE(max(ln(1 + e.mention_count)), 0) AS p FROM kb.event_entities ee JOIN kb.entities e ON e.id = ee.entity_id
               WHERE ee.event_id = %s AND ee.weight >= 0.3""",
            (event_id,),
        ).fetchone()["p"]
        fact_stats = conn.execute(
            """SELECT count(*) AS facts, count(*) FILTER (WHERE first_event_id = %s) AS new_facts
               FROM kb.facts f WHERE f.id IN (SELECT fact_id FROM kb.claims WHERE event_id = %s AND fact_id IS NOT NULL)""",
            (event_id, event_id),
        ).fetchone()
        links = conn.execute(
            "SELECT count(*) AS n FROM kb.event_links WHERE from_event_id = %s OR to_event_id = %s", (event_id, event_id)
        ).fetchone()["n"]
        title = conn.execute(
            """SELECT d.title, d.body, d.feed_summary FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id
               LEFT JOIN kb.source_profiles p ON p.source_id = d.source_id
               WHERE ed.event_id = %s AND ed.role <> 'reprint'
               ORDER BY (d.lang = 'uk') DESC, (d.extraction_status = 'full') DESC, COALESCE(p.reliability, 0.5) DESC, d.id
               LIMIT 1""",
            (event_id,),
        ).fetchone()

        independent = int(agg["independent"] or 0)
        full_docs = int(agg["full_docs"] or 0)
        primaries = int(agg["primaries"] or 0)
        docs = int(agg["docs"] or 0)
        coverage = _clip(math.log2(1 + independent) / math.log2(1 + 8))
        velocity = _clip((int(agg["recent"] or 0) / max(1, docs)) * min(1.0, docs / 5))
        novelty = _clip((fact_stats["new_facts"] or 0) / max(1, fact_stats["facts"] or 0)) if fact_stats["facts"] else 0.3
        prom = _clip(float(prominence) / math.log(1 + 5000))
        category = cat["category"] if cat else ev["category"]
        importance = (
            0.32 * coverage + 0.13 * min(1, primaries) + 0.2 * prom + 0.12 * velocity + 0.1 * novelty
            + 0.13 * CATEGORY_WEIGHT.get(category or "", 0.45)
        )
        quality = _clip((0.5 if full_docs >= 1 else 0.0) + 0.5 * min(1.0, full_docs / 3))

        state = ev["editorial_state"]
        last_doc = agg["last_doc"]
        stale = last_doc is not None and (datetime.now(timezone.utc) - last_doc).total_seconds() > 48 * 3600
        if state != "written" and stale:
            # Old news (history backfill, or a story nobody wrote in time) is context, never a new article.
            state = "skipped"
        elif state not in ("written",):
            # Teasers find coverage but never confirm it; a single primary source is not enough on its own either.
            enough = independent >= settings.ready_min_independent_sources and full_docs >= 1
            if (
                enough and independent >= settings.deep_min_independent_sources and full_docs >= 3 and importance >= 0.6
                and (links >= 2 or (fact_stats["facts"] or 0) >= 5)
            ):
                state = "deep"
            elif enough and importance >= 0.35:
                state = "ready" if state != "deep" else state
            elif ev["status"] == "closed":
                state = "skipped"
            else:
                state = "collecting"

        conn.execute(
            """UPDATE kb.events SET doc_count = %s, source_count = %s, independent_source_count = %s, primary_source_count = %s,
                      full_text_doc_count = %s, started_at = COALESCE(%s, started_at), last_seen_at = GREATEST(last_seen_at, COALESCE(%s, last_seen_at)),
                      category = %s, event_type = COALESCE(%s, event_type), importance = %s, velocity = %s, novelty = %s,
                      quality = %s, editorial_state = %s, title = COALESCE(%s, title), summary = COALESCE(%s, summary), updated_at = now()
               WHERE id = %s""",
            (
                docs, int(agg["sources"] or 0), independent, primaries, full_docs, agg["started"], agg["last_doc"],
                category, _event_type_of(etype["predicate"]) if etype else None, round(importance, 4), round(velocity, 4),
                round(novelty, 4), round(quality, 4), state, title["title"][:500] if title else None,
                _lead(title) if title else None, event_id,
            ),
        )
        # LLM only for material that will be published: verify single-source high-stakes facts of ready/deep events.
        if state in ("ready", "deep"):
            risky = conn.execute(
                """SELECT DISTINCT f.id, f.predicate FROM kb.facts f JOIN kb.claims c ON c.fact_id = f.id
                   WHERE c.event_id = %s AND f.status = 'single_source' AND NOT f.llm_checked AND f.predicate = ANY(%s)
                   LIMIT 3""",
                (event_id, list(HIGH_STAKES)),
            ).fetchall()
            for r in risky:
                enqueue("verify_fact", f"verify_fact:{r['id']}", {"fact_id": r["id"], "event_id": event_id},
                        priority=importance, tier="lite", conn=conn)
    return {"event_id": event_id, "state": state, "importance": importance}


def _event_type_of(predicate: str) -> str | None:
    from ..nlp.relations import lexicon

    p = lexicon().preds.get(predicate)
    return p.event_type if p else None


def _lead(row: dict) -> str | None:
    from ..text.normalize import split_sentences

    text = (row.get("body") or row.get("feed_summary") or "").strip()
    if not text:
        return None
    sentences = split_sentences(text)[:3]
    out = " ".join(sentences)
    return out[:700] if out else None
