"""Claims -> facts (deduplicated assertions) with value history, evidence roots and contradictions.

Identity. A fact is (subject, predicate, object entity, object_key):
  * durable predicates (acquired, appointed, captured ...) describe a state of the world: all reports collapse
    into one fact, across events;
  * episodic predicates (attack, provide, meet ...) happen again and again: the event id is part of the key, so
    "Russia attacked Kharkiv" yesterday and today are two facts;
  * negated / denied and planned assertions get their own keys ('NOT|', 'PLAN|');
  * without a linked object, the normalized object text keeps "launched X" and "launched Y" apart.
Amounts are not part of the identity: every reported value goes to kb.fact_values with its evidence roots.

Evidence. Support is counted in evidence ROOTS (attribution.py): two outlets retelling Reuters are one root.
Only full/partial texts confirm; teasers and reprints never do.
  single_source  one root
  corroborated   2+ independent roots
  confirmed      a primary source speaking for the subject/object (the company itself, a ministry about its own
                 action) or a data source (registry, statistics office)
  disputed       an open contradiction

Values. One bucket -> that value. Several buckets (>15% apart, same unit):
  * the same root reported both, later one is newer -> a revision ("the death toll rose to 12"): latest wins;
  * casualty-like counts that only grow -> revision, latest wins;
  * otherwise independent roots disagree -> a 'numeric' contradiction, the fact is 'disputed' and an LLM task is queued.
"""
from __future__ import annotations

import logging
from functools import lru_cache
from math import floor, log10

from .. import db
from ..llm.queue import enqueue
from ..nlp.relations import lexicon
from ..text.stem import term_key

log = logging.getLogger(__name__)

MIN_CONFIDENCE = 0.45
NO_FACT = {"state", "deny", "announce"}   # quotes and announcements stay claims
NUMERIC_TOLERANCE = 0.15
GROWING_UNITS = {"people"}                # tolls and counts are revised upwards, that is not a contradiction


@lru_cache(maxsize=1)
def _symmetric() -> set[str]:
    return {name for name, p in lexicon().preds.items() if p.symmetric}


@lru_cache(maxsize=1)
def _durable() -> set[str]:
    return {name for name, p in lexicon().preds.items() if p.durable}


def value_key(value, unit: str | None) -> str:
    """Two significant digits: 1.2e9 and 1.24e9 share a bucket, 1.2e9 and 1.5e9 do not."""
    if value is None:
        return ""
    v = float(value)
    if v == 0:
        return f"0{unit or ''}"
    digits = 2 - int(floor(log10(abs(v)))) - 1
    return f"{round(v, digits):g}{unit or ''}"


def fact_key(predicate: str, obj: int | None, object_text: str | None, event_id: int | None, negated: bool, plan: bool) -> str:
    text_key = "" if obj is not None or not object_text else "t:" + term_key(object_text)[:80]
    key = f"{obj or text_key}"
    if predicate not in _durable():
        key += f"|ev:{event_id or 0}"
    if negated:
        key = "NOT|" + key
    if plan:
        key = "PLAN|" + key
    return key


def aggregate_document(document_id: int, event_id: int | None) -> int:
    rows = db.fetch_all(
        """SELECT c.*, d.published_at, d.created_at AS doc_created FROM kb.claims c JOIN kb.documents d ON d.id = c.document_id
           WHERE c.document_id = %s AND c.fact_id IS NULL""",
        (document_id,),
    )
    created = 0
    touched: set[int] = set()
    for c in rows:
        if c["predicate"] in NO_FACT or c["subject_entity_id"] is None:
            continue
        if c["confidence"] < MIN_CONFIDENCE or c["modality"] in ("speculation", "question"):
            continue
        subj, obj = c["subject_entity_id"], c["object_entity_id"]
        if c["predicate"] in _symmetric() and obj is not None and obj < subj:
            subj, obj = obj, subj
        if obj is None and not c["object_text"] and c["value_num"] is None:
            continue  # "Russia attacked —": not an assertion about the world
        okey = fact_key(c["predicate"], obj, c["object_text"], c["event_id"] or event_id,
                        bool(c["negated"]) or c["modality"] == "denial", c["modality"] == "plan")
        seen_at = c["published_at"] or c["doc_created"]
        with db.tx() as conn:
            fact = conn.execute(
                """INSERT INTO kb.facts (subject_entity_id, predicate, object_entity_id, object_key, object_text,
                                         valid_from, valid_to, first_event_id, first_seen, last_seen)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (subject_entity_id, predicate, object_entity_id, object_key)
                   DO UPDATE SET last_seen = GREATEST(kb.facts.last_seen, EXCLUDED.last_seen),
                                 valid_from = COALESCE(kb.facts.valid_from, EXCLUDED.valid_from)
                   RETURNING id, (xmax = 0) AS inserted""",
                (subj, c["predicate"], obj, okey, c["object_text"], c["time_start"], c["time_end"],
                 c["event_id"] or event_id, seen_at, seen_at),
            ).fetchone()
            fact_id = fact["id"]
            created += 1 if fact["inserted"] else 0
            conn.execute("UPDATE kb.claims SET fact_id = %s WHERE id = %s", (fact_id, c["id"]))
            touched.add(fact_id)
            if fact["inserted"]:
                _check_negation(conn, fact_id, subj, c["predicate"], obj, okey)
    if touched:
        reconcile(sorted(touched))
    return created


def reconcile(fact_ids: list[int]) -> None:
    """Recount evidence, rebuild value history and the value decision; delete facts that lost all claims."""
    for fid in fact_ids:
        with db.tx() as conn:
            n = conn.execute("SELECT count(*) AS n FROM kb.claims WHERE fact_id = %s", (fid,)).fetchone()["n"]
            if n == 0:
                conn.execute("DELETE FROM kb.facts WHERE id = %s", (fid,))
                continue
            _rebuild_values(conn, fid)
            _recount(conn, fid)


_EVIDENCE = """
    FROM kb.claims c JOIN kb.documents d ON d.id = c.document_id
    LEFT JOIN kb.source_profiles p ON p.source_id = d.source_id
    JOIN kb.facts f ON f.id = c.fact_id
    WHERE c.fact_id = %s"""
_CONFIRMS = "(d.extraction_status IN ('full', 'partial') AND COALESCE(d.duplicate_kind, '') <> 'reprint')"
_PRIMARY = ("(p.tier = 'data' OR (p.tier = 'primary' AND p.speaks_for_entity_id IS NOT NULL "
            "AND p.speaks_for_entity_id IN (f.subject_entity_id, f.object_entity_id)))")


def _recount(conn, fact_id: int) -> None:
    row = conn.execute(
        f"""SELECT count(*) AS support,
                   count(DISTINCT COALESCE(c.evidence_root, d.source_id::text)) FILTER (WHERE {_CONFIRMS}) AS roots,
                   COALESCE(bool_or({_PRIMARY} AND {_CONFIRMS}), false) AS primary_support
            {_EVIDENCE}""",
        (fact_id,),
    ).fetchone()
    disputed = conn.execute(
        "SELECT 1 FROM kb.contradictions WHERE (fact_id = %s OR other_fact_id = %s) AND status = 'open' LIMIT 1",
        (fact_id, fact_id),
    ).fetchone()
    conn.execute(
        """UPDATE kb.facts SET support_count = %s, source_count = %s, primary_support = %s,
                  status = CASE WHEN status IN ('retracted', 'superseded') THEN status
                                WHEN %s THEN 'disputed'
                                WHEN %s THEN 'confirmed'
                                WHEN %s >= 2 THEN 'corroborated'
                                ELSE 'single_source' END
           WHERE id = %s""",
        (row["support"], row["roots"], row["primary_support"], bool(disputed), row["primary_support"], row["roots"], fact_id),
    )


def _median(values: list[float]) -> float:
    return sorted(values)[len(values) // 2]


def _rebuild_values(conn, fact_id: int) -> None:
    rows = conn.execute(
        f"""SELECT c.value_num, COALESCE(c.value_unit, '') AS unit, COALESCE(c.evidence_root, d.source_id::text) AS root,
                   {_PRIMARY} AS is_primary, {_CONFIRMS} AS confirms, COALESCE(d.published_at, d.created_at) AS at
            {_EVIDENCE} AND c.value_num IS NOT NULL""",
        (fact_id,),
    ).fetchall()
    conn.execute("DELETE FROM kb.fact_values WHERE fact_id = %s", (fact_id,))
    if not rows:
        return
    buckets: dict[tuple[str, str], dict] = {}
    for r in rows:
        k = (r["unit"], value_key(r["value_num"], r["unit"]))
        b = buckets.setdefault(k, {"values": [], "roots": set(), "primary": False, "first": r["at"], "last": r["at"], "support": 0})
        b["values"].append(float(r["value_num"]))
        if r["confirms"]:
            b["roots"].add(r["root"])
        b["primary"] = b["primary"] or bool(r["is_primary"] and r["confirms"])
        b["first"], b["last"] = min(b["first"], r["at"]), max(b["last"], r["at"])
        b["support"] += 1
    for (unit, bucket), b in buckets.items():
        conn.execute(
            """INSERT INTO kb.fact_values (fact_id, value_bucket, value_num, value_unit, evidence_roots, support, primary_support,
                                           first_seen, last_seen) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (fact_id, bucket, _median(b["values"]), unit, sorted(b["roots"]), b["support"], b["primary"], b["first"], b["last"]),
        )
    best = None
    conflicts = []
    for unit in {u for u, _ in buckets}:
        group = [(k, b) for k, b in buckets.items() if k[0] == unit]
        group.sort(key=lambda kb_: (kb_[1]["primary"], len(kb_[1]["roots"]), kb_[1]["last"]), reverse=True)
        chosen_key, chosen = group[0]
        for other_key, other in group[1:]:
            a, b = _median(chosen["values"]), _median(other["values"])
            if max(a, b) == 0 or abs(a - b) / max(a, b) <= NUMERIC_TOLERANCE:
                continue
            if chosen["primary"]:
                continue  # the actor's own number stands; others are recorded in fact_values
            if bool(chosen["roots"] & other["roots"]) or unit in GROWING_UNITS:
                # a revision: the same root updated its number, or a toll grew -> the newest value wins
                if other["last"] > chosen["last"]:
                    chosen_key, chosen = other_key, other
                continue
            if chosen["roots"] and other["roots"]:
                conflicts.append({"values": sorted({a, b}), "unit": unit,
                                  "roots": [sorted(chosen["roots"]), sorted(other["roots"])]})
        if best is None or len(chosen["roots"]) > len(best[1]["roots"]):
            best = (chosen_key, chosen)
    if best is not None:
        (unit, _bucket), b = best
        conn.execute("UPDATE kb.facts SET value_num = %s, value_unit = %s WHERE id = %s", (_median(b["values"]), unit or None, fact_id))
    for conflict in conflicts[:1]:
        inserted = conn.execute(
            """INSERT INTO kb.contradictions (fact_id, kind, detail) VALUES (%s, 'numeric', %s::jsonb)
               ON CONFLICT (fact_id, kind, COALESCE(other_fact_id, 0)) DO UPDATE SET detail = EXCLUDED.detail, updated_at = now()
               RETURNING (xmax = 0) AS inserted""",
            (fact_id, db.jsonb(conflict)),
        ).fetchone()
        if inserted and inserted["inserted"]:
            enqueue("contradiction", f"contradiction:numeric:{fact_id}", {"fact_id": fact_id, "detail": conflict},
                    priority=0.4, tier="lite", conn=conn)
    if not conflicts:
        # an earlier numeric dispute that new evidence explained (revision / primary source) is resolved
        conn.execute(
            """UPDATE kb.contradictions SET status = 'resolved', resolution = '{"by": "algorithm"}'::jsonb, updated_at = now()
               WHERE fact_id = %s AND kind = 'numeric' AND status = 'open'""",
            (fact_id,),
        )


def _check_negation(conn, fact_id: int, subj: int, predicate: str, obj, okey: str) -> None:
    """'X did Y' vs 'X did not do Y' / 'X denied doing Y' for the same occurrence."""
    if okey.startswith("PLAN|"):
        return
    base = okey.removeprefix("NOT|")
    other_key = base if okey.startswith("NOT|") else "NOT|" + base
    other = conn.execute(
        """SELECT id FROM kb.facts WHERE subject_entity_id = %s AND predicate = %s
             AND object_entity_id IS NOT DISTINCT FROM %s AND object_key = %s""",
        (subj, predicate, obj, other_key),
    ).fetchone()
    if not other:
        return
    positive, negative = (other["id"], fact_id) if okey.startswith("NOT|") else (fact_id, other["id"])
    inserted = conn.execute(
        """INSERT INTO kb.contradictions (fact_id, other_fact_id, kind) VALUES (%s, %s, 'negation')
           ON CONFLICT (fact_id, kind, COALESCE(other_fact_id, 0)) DO NOTHING""",
        (positive, negative),
    ).rowcount
    if inserted:
        conn.execute("UPDATE kb.facts SET status = 'disputed' WHERE id IN (%s, %s) AND status NOT IN ('retracted', 'superseded')",
                     (positive, negative))
        enqueue("contradiction", f"contradiction:negation:{positive}:{negative}",
                {"fact_ids": [positive, negative], "kind": "negation"}, priority=0.5, tier="lite", conn=conn)


def rebuild_fact_relations() -> int:
    """kb.entity_relations(origin='fact') = affirmative, undisputed facts with an entity object, weighted by roots.
    Rebuilt from kb.facts so negations, plans, merges and corrections are always reflected exactly."""
    with db.tx() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(7311002)")
        conn.execute("DELETE FROM kb.entity_relations WHERE origin = 'fact'")
        return conn.execute(
            """INSERT INTO kb.entity_relations (from_entity_id, to_entity_id, relation, origin, weight, evidence_count,
                                                valid_from, first_seen, last_seen)
               SELECT subject_entity_id, object_entity_id, predicate, 'fact',
                      sum(source_count + CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END), sum(support_count),
                      min(valid_from), min(first_seen), max(last_seen)
               FROM kb.facts
               WHERE object_entity_id IS NOT NULL AND subject_entity_id <> object_entity_id
                 AND object_key NOT LIKE 'NOT|%%' AND object_key NOT LIKE 'PLAN|%%'
                 AND status NOT IN ('retracted', 'superseded', 'disputed') AND source_count >= 1
               GROUP BY subject_entity_id, object_entity_id, predicate"""
        ).rowcount
