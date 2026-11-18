"""Online event clustering: each new document joins the best matching open event or starts a new one.

Candidate events come from three cheap indexes (pgvector HNSW, shared entities, pg_trgm title similarity) and are
scored with interpretable signals:

  semantic  cosine(document embedding, event centroid)           cross-language: UA/EN/DE reports of one event
  entities  weighted Jaccard of salient linked entities           language-independent IDs, the strongest signal
  title     token-set ratio of titles (same script only)
  time      exp(-|dt| / 36h)
  type      same/different event type from claims (acquisition vs lawsuit)

Guards: no join without either entity overlap or very high semantic similarity (stops "topic drift": two different
strikes on Kyiv on two days are two events because breaking-news types have a short window).
Signals are stored on kb.event_documents.signals so thresholds can be tuned on real data.
"""
from __future__ import annotations

import logging
import math
import time
from collections import Counter
from datetime import datetime, timezone

import numpy as np
from rapidfuzz import fuzz

from .. import db
from ..config import settings
from ..nlp import embed as emb
from ..text.stem import is_cyrillic

log = logging.getLogger(__name__)

# Breaking-news event types are "one day" events; others can gather coverage for days.
TYPE_WINDOW_H = {"military_strike": 20, "statement": 24, "diplomacy": 36, "outage": 24, "security": 48}
NOT_A_TYPE = {"statement", "announcement"}


def doc_event_type(claims) -> str | None:
    counts = Counter(c.event_type for c in claims if c.event_type not in NOT_A_TYPE)
    return counts.most_common(1)[0][0] if counts else None


def _entity_vector(salience: dict[int, tuple[int, float, bool]]) -> dict[int, float]:
    return {eid: s for eid, (_n, s, _t) in salience.items() if s >= 0.15}


class _Specificity:
    """IDF of entities over the last 14 days: "Ukraine"/"Russia" barely count, "Nemtsov"/"An-12" count fully."""

    def __init__(self) -> None:
        self.total = 0
        self.total_at = 0.0
        self.cache: dict[int, tuple[float, float]] = {}

    def get(self, ids: list[int]) -> dict[int, float]:
        now = time.time()
        if now - self.total_at > 300:
            row = db.fetch_one("SELECT count(*) AS n FROM kb.documents WHERE stage IN ('analyzed', 'clustered') AND created_at > now() - interval '14 days'")
            self.total, self.total_at = int(row["n"] if row else 0), now
        missing = [i for i in ids if i not in self.cache or now - self.cache[i][1] > 300]
        if missing:
            rows = db.fetch_all(
                """SELECT de.entity_id, count(*) AS df FROM kb.document_entities de JOIN kb.documents d ON d.id = de.document_id
                   WHERE de.entity_id = ANY(%s) AND d.created_at > now() - interval '14 days' GROUP BY de.entity_id""",
                (missing,),
            )
            df = {r["entity_id"]: int(r["df"]) for r in rows}
            n = max(self.total, 200)  # small corpora at bootstrap would make everything look common
            for i in missing:
                spec = math.log(n / (df.get(i, 0) + 1)) / math.log(n)
                self.cache[i] = (max(0.08, min(1.0, spec)), now)
        return {i: self.cache[i][0] for i in ids}


SPECIFICITY = _Specificity()


def _weighted(vec: dict[int, float], spec: dict[int, float]) -> dict[int, float]:
    return {k: v * spec.get(k, 1.0) for k, v in vec.items()}


def weighted_jaccard(a: dict[int, float], b: dict[int, float]) -> float:
    if not a or not b:
        return 0.0
    keys = set(a) | set(b)
    num = sum(min(a.get(k, 0.0), b.get(k, 0.0)) for k in keys)
    den = sum(max(a.get(k, 0.0), b.get(k, 0.0)) for k in keys)
    return num / den if den else 0.0


def _event_entity_vector(weights: dict, doc_count: int) -> dict[int, float]:
    n = max(1, doc_count)
    return {int(k): min(1.0, float(v) / n) for k, v in (weights or {}).items()}


def score_candidate(
    *,
    sem: float | None,
    ent: float,
    title_sim: float | None,
    hours_apart: float,
    doc_type: str | None,
    event_type: str | None,
    same_category: bool,
) -> float:
    time_s = math.exp(-abs(hours_apart) / 36.0)
    if sem is not None:
        s = 0.42 * sem + 0.33 * ent + 0.10 * (title_sim or 0.0) + 0.15 * time_s
    else:
        s = 0.55 * ent + 0.28 * (title_sim or 0.0) + 0.17 * time_s
    if doc_type and event_type:
        s += 0.05 if doc_type == event_type else -0.08
    if not same_category:
        s -= 0.04
    # guard against topic drift
    if ent == 0.0 and (sem is None or sem < 0.80) and (title_sim or 0.0) < 0.85:
        s = min(s, 0.3)
    return s


def _candidates(doc: dict, vec, ents: dict[int, float], when: datetime) -> dict[int, dict]:
    window = settings.event_window_h
    cands: dict[int, dict] = {}
    if vec is not None and db.features()["vector"]:
        rows = db.fetch_all(
            """SELECT ee.event_id, 1 - (ee.centroid <=> %s::vector) AS sim
               FROM kb.event_embeddings ee JOIN kb.events e ON e.id = ee.event_id
               WHERE e.status = 'open' AND e.last_seen_at > %s::timestamptz - make_interval(hours => %s)
               ORDER BY ee.centroid <=> %s::vector LIMIT 15""",
            (emb.to_pg(vec), when, window, emb.to_pg(vec)),
        )
        for r in rows:
            cands.setdefault(r["event_id"], {})["sem"] = float(r["sim"])
    top = sorted(ents, key=ents.get, reverse=True)[:6]
    if top:
        rows = db.fetch_all(
            """SELECT ev.event_id, sum(ev.weight) AS w FROM kb.event_entities ev JOIN kb.events e ON e.id = ev.event_id
               WHERE ev.entity_id = ANY(%s) AND e.status = 'open' AND e.last_seen_at > %s::timestamptz - make_interval(hours => %s)
               GROUP BY ev.event_id ORDER BY w DESC LIMIT 15""",
            (top, when, window),
        )
        for r in rows:
            cands.setdefault(r["event_id"], {})
    if db.features()["trgm"]:
        rows = db.fetch_all(
            """SELECT id FROM kb.events
               WHERE status = 'open' AND last_seen_at > %s::timestamptz - make_interval(hours => %s)
                 AND similarity(lower(title), lower(%s)) > 0.35
               ORDER BY similarity(lower(title), lower(%s)) DESC LIMIT 8""",
            (when, window, doc["title"], doc["title"]),
        )
        for r in rows:
            cands.setdefault(r["id"], {})
    if doc.get("duplicate_of"):
        row = db.fetch_one("SELECT event_id FROM kb.event_documents WHERE document_id = %s", (doc["duplicate_of"],))
        if row:
            cands.setdefault(row["event_id"], {})["dup"] = True
    # Candidates found through entities/titles also get a semantic score, so every candidate is judged the same way.
    missing_sem = [eid for eid, c in cands.items() if "sem" not in c]
    if vec is not None and missing_sem and db.features()["vector"]:
        for r in db.fetch_all(
            "SELECT event_id, 1 - (centroid <=> %s::vector) AS sim FROM kb.event_embeddings WHERE event_id = ANY(%s)",
            (emb.to_pg(vec), missing_sem),
        ):
            cands[r["event_id"]]["sem"] = float(r["sim"])
    return cands


def _role(doc: dict, source: dict) -> str:
    if doc.get("duplicate_kind") in ("reprint", "near", "exact"):
        return "reprint"
    if (doc.get("meta") or {}).get("was_recheck"):
        return "update"
    if source.get("tier") == "primary":
        return "primary"
    if (doc.get("word_count") or 0) > 1500:
        return "analysis"
    return "report"


def assign(doc: dict, analysis: dict) -> int:
    when = doc.get("published_at") or doc.get("created_at") or datetime.now(timezone.utc)
    existing = db.fetch_one("SELECT event_id FROM kb.event_documents WHERE document_id = %s", (doc["id"],))
    if existing:
        # Re-analysis of an updated article keeps its event; the update itself is recorded in document_versions.
        with db.tx() as conn:
            conn.execute("UPDATE kb.claims SET event_id = %s WHERE document_id = %s", (existing["event_id"], doc["id"]))
        rebuild_event_entities(existing["event_id"])
        return existing["event_id"]
    vec = analysis.get("vector")
    raw_ents = _entity_vector(analysis["salience"])
    doc_type = doc_event_type(analysis["claims"])
    category = analysis["category"].category
    cands = _candidates(doc, vec, _weighted(raw_ents, SPECIFICITY.get(list(raw_ents))), when)
    best_id, best_score, best_signals = None, -1.0, {}
    if cands:
        rows = db.fetch_all(
            """SELECT e.id, e.title, e.category, e.event_type, e.entity_weights, e.last_seen_at, e.started_at,
                      (SELECT count(*) FROM kb.event_documents ed WHERE ed.event_id = e.id AND ed.role <> 'reprint') AS contrib,
                      (SELECT array_agg(DISTINCT d.source_id::text) FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id
                       WHERE ed.event_id = e.id) AS sources
               FROM kb.events e WHERE e.id = ANY(%s) AND e.status = 'open'""",
            (list(cands),),
        )
        for ev in rows:
            c = cands[ev["id"]]
            if c.get("dup"):
                best_id, best_score, best_signals = ev["id"], 1.0, {"dup": True}
                break
            hours = abs((when - (ev["last_seen_at"] or when)).total_seconds()) / 3600
            limit_h = TYPE_WINDOW_H.get(ev["event_type"] or doc_type or "", settings.event_window_h)
            if hours > limit_h:
                continue
            ev_vec = _event_entity_vector(ev["entity_weights"], ev["contrib"])
            spec = SPECIFICITY.get(list(set(raw_ents) | set(ev_vec)))
            a, b = _weighted(raw_ents, spec), _weighted(ev_vec, spec)
            # Jaccard alone says 1.0 when the only shared entity is "United States"; scale by how much specific
            # evidence is actually shared (sum of min weights), saturating at 0.6.
            shared_mass = sum(min(a[k], b[k]) for k in set(a) & set(b))
            ent = weighted_jaccard(a, b) * min(1.0, shared_mass / 0.6)
            title_sim = None
            if is_cyrillic(doc["title"]) == is_cyrillic(ev["title"]):
                title_sim = fuzz.token_set_ratio(doc["title"].lower(), ev["title"].lower()) / 100.0
            same_source_only = ev["sources"] == [str(doc.get("source_id"))]
            s = score_candidate(
                sem=c.get("sem"), ent=ent, title_sim=title_sim, hours_apart=hours,
                doc_type=doc_type, event_type=ev["event_type"], same_category=(ev["category"] == category),
            )
            if same_source_only:
                # one outlet rarely files two separate reports of one event within hours; demand more evidence
                s -= 0.12
            if s > best_score:
                best_id, best_score = ev["id"], s
                best_signals = {"sem": c.get("sem"), "ent": round(ent, 3), "title": title_sim, "hours": round(hours, 1), "score": round(s, 3)}
    source = analysis.get("source") or {}
    role = _role(doc, source)
    # Without a semantic signal the decision rests on entities and titles only: demand more.
    threshold = settings.event_join_threshold + (0.0 if best_signals.get("sem") is not None or best_signals.get("dup") else 0.08)
    if best_id is not None and best_score >= threshold:
        return _join(best_id, doc, analysis, vec, best_score, best_signals, role)
    return _create(doc, analysis, vec, doc_type, category, when, role)


def _create(doc: dict, analysis: dict, vec, doc_type, category, when, role) -> int:
    ents = _entity_vector(analysis["salience"])
    with db.tx() as conn:
        row = conn.execute(
            """INSERT INTO kb.events (title, category, event_type, lang_set, keywords, started_at, first_seen_at, last_seen_at,
                                      entity_weights)
               VALUES (%s, %s, %s, %s, %s, %s, now(), %s, %s::jsonb) RETURNING id""",
            (doc["title"][:500], category, doc_type, [analysis["lang"]], analysis["keywords"][:12], when, when,
             db.jsonb({str(k): round(v, 4) for k, v in ents.items()})),
        ).fetchone()
        event_id = row["id"]
        conn.execute(
            """INSERT INTO kb.event_documents (document_id, event_id, similarity, role, signals) VALUES (%s, %s, 1.0, %s, '{}'::jsonb)
               ON CONFLICT (document_id) DO UPDATE SET event_id = EXCLUDED.event_id""",
            (doc["id"], event_id, "seed" if role == "report" else role),
        )
        for eid, w in ents.items():
            conn.execute(
                "INSERT INTO kb.event_entities (event_id, entity_id, weight, doc_count) VALUES (%s, %s, %s, 1) ON CONFLICT DO NOTHING",
                (event_id, eid, w),
            )
        conn.execute("UPDATE kb.claims SET event_id = %s WHERE document_id = %s", (event_id, doc["id"]))
        if vec is not None and db.features()["vector"]:
            conn.execute(
                "INSERT INTO kb.event_embeddings (event_id, model, centroid, n) VALUES (%s, %s, %s::vector, 1)",
                (event_id, settings.embed_model[:80], emb.to_pg(vec)),
            )
    return event_id


def _join(event_id: int, doc: dict, analysis: dict, vec, score: float, signals: dict, role: str) -> int:
    ents = _entity_vector(analysis["salience"])
    with db.tx() as conn:
        ev = conn.execute("SELECT entity_weights, lang_set, keywords, status, merged_into FROM kb.events WHERE id = %s FOR UPDATE",
                          (event_id,)).fetchone()
        hops = 0
        while ev["status"] == "merged" and ev["merged_into"] and hops < 5:
            # maintenance merged the event after we picked it: follow it to the survivor
            event_id = ev["merged_into"]
            ev = conn.execute("SELECT entity_weights, lang_set, keywords, status, merged_into FROM kb.events WHERE id = %s FOR UPDATE",
                              (event_id,)).fetchone()
            hops += 1
        weights = {str(k): float(v) for k, v in (ev["entity_weights"] or {}).items()}
        if role != "reprint":
            for k, v in ents.items():
                weights[str(k)] = round(weights.get(str(k), 0.0) + v, 4)
        langs = sorted(set(ev["lang_set"] or []) | {analysis["lang"]})
        kw = list(dict.fromkeys(list(ev["keywords"] or []) + analysis["keywords"][:5]))[:20]
        conn.execute(
            """INSERT INTO kb.event_documents (document_id, event_id, similarity, role, signals) VALUES (%s, %s, %s, %s, %s::jsonb)
               ON CONFLICT (document_id) DO UPDATE SET event_id = EXCLUDED.event_id, similarity = EXCLUDED.similarity,
                                                      role = EXCLUDED.role, signals = EXCLUDED.signals""",
            (doc["id"], event_id, round(score, 4), role, db.jsonb(signals)),
        )
        if role != "reprint":
            for eid, w in ents.items():
                conn.execute(
                    """INSERT INTO kb.event_entities (event_id, entity_id, weight, doc_count) VALUES (%s, %s, %s, 1)
                       ON CONFLICT (event_id, entity_id) DO UPDATE SET weight = kb.event_entities.weight + EXCLUDED.weight,
                                                                      doc_count = kb.event_entities.doc_count + 1""",
                    (event_id, eid, w),
                )
        conn.execute(
            """UPDATE kb.events SET entity_weights = %s::jsonb, lang_set = %s, keywords = %s,
                      last_seen_at = GREATEST(last_seen_at, %s), started_at = LEAST(started_at, %s), updated_at = now()
               WHERE id = %s""",
            (db.jsonb(weights), langs, kw, doc.get("published_at") or datetime.now(timezone.utc),
             doc.get("published_at") or datetime.now(timezone.utc), event_id),
        )
        conn.execute("UPDATE kb.claims SET event_id = %s WHERE document_id = %s", (event_id, doc["id"]))
        if vec is not None and db.features()["vector"] and role != "reprint":
            row = conn.execute("SELECT centroid::text AS c, n FROM kb.event_embeddings WHERE event_id = %s FOR UPDATE", (event_id,)).fetchone()
            if row:
                old = emb.from_pg(row["c"])
                n = int(row["n"])
                new = (old * n + vec) / (n + 1)
                new = new / (np.linalg.norm(new) or 1.0)
                conn.execute(
                    "UPDATE kb.event_embeddings SET centroid = %s::vector, n = %s, updated_at = now() WHERE event_id = %s",
                    (emb.to_pg(new), n + 1, event_id),
                )
            else:
                conn.execute(
                    "INSERT INTO kb.event_embeddings (event_id, model, centroid, n) VALUES (%s, %s, %s::vector, 1)",
                    (event_id, settings.embed_model[:80], emb.to_pg(vec)),
                )
    return event_id


def rebuild_event_entities(event_id: int) -> None:
    """Recompute an event's entity profile from its current (non-reprint) documents, e.g. after re-analysis."""
    with db.tx() as conn:
        conn.execute("SELECT id FROM kb.events WHERE id = %s FOR UPDATE", (event_id,))
        conn.execute("DELETE FROM kb.event_entities WHERE event_id = %s", (event_id,))
        conn.execute(
            """INSERT INTO kb.event_entities (event_id, entity_id, weight, doc_count)
               SELECT %s, de.entity_id, sum(de.salience), count(*)
               FROM kb.event_documents ed JOIN kb.document_entities de ON de.document_id = ed.document_id
               WHERE ed.event_id = %s AND ed.role <> 'reprint' AND de.salience >= 0.15
               GROUP BY de.entity_id""",
            (event_id, event_id),
        )
        conn.execute(
            """UPDATE kb.events e SET entity_weights = COALESCE(
                 (SELECT jsonb_object_agg(entity_id::text, round(weight::numeric, 4)) FROM kb.event_entities WHERE event_id = e.id),
                 '{}'::jsonb), updated_at = now()
               WHERE e.id = %s""",
            (event_id,),
        )
