"""Links between events — the material for "what led to this" and "what happened before" (task 4).

  same_storyline  shares defining entities with a recent event (<= 45 days) and is semantically close
  precedent       same event type with the same actor earlier (the previous sanctions package, the last acquisition)
  reaction_to     the later event reacts to the earlier one: its claims condemn/deny/accuse/state about the earlier
                  event's actor or target within 14 days, or its text uses causal cues ("у відповідь на", "after")
  follow_up       same actors and type, shortly after (the deal closes, the court rules, the strike continues)

All links are algorithmic with a score and evidence. 'reaction_to'/'causes' links that will be printed in a deep
article are verified by the LLM ('causal_check' task) — the algorithm proposes, the model confirms.
"""
from __future__ import annotations

import logging
import re

from .. import db
from ..llm.queue import enqueue

log = logging.getLogger(__name__)

REACTION_PREDICATES = ("condemn", "accuse", "deny", "reject", "sanction")
CAUSAL_CUES = re.compile(
    r"\b(in response to|in retaliation for|following|after|as a result of|because of|due to)\b|"
    r"у відповідь на|після того,? як|внаслідок|через те,? що|на тлі|після\b|"
    r"als reaktion auf|nach dem|infolge|wegen",
    re.I,
)


def _top_entities(event_id: int, limit: int = 6) -> list[dict]:
    return db.fetch_all(
        """SELECT ee.entity_id, ee.weight, e.doc_count, e.kind FROM kb.event_entities ee JOIN kb.entities e ON e.id = ee.entity_id
           WHERE ee.event_id = %s ORDER BY ee.weight DESC LIMIT %s""",
        (event_id, limit),
    )


def link_event(event_id: int) -> int:
    ev = db.fetch_one("SELECT * FROM kb.events WHERE id = %s", (event_id,))
    if not ev or ev["status"] == "merged":
        return 0
    top = _top_entities(event_id)
    if not top:
        return 0
    ids = [t["entity_id"] for t in top]
    # Rare entities define a storyline better than "Ukraine" or "USA": weight by inverse document frequency.
    # Same IDF specificity as clustering: "Ukraine"/"Russia" link everything to everything, so they barely count.
    from .clustering import SPECIFICITY

    idf = SPECIFICITY.get(ids)
    specific = {e for e, v in idf.items() if v >= 0.55}
    rows = db.fetch_all(
        """SELECT e.id, e.title, e.event_type, e.category, e.started_at, e.storyline_id,
                  array_agg(ee.entity_id) AS shared, sum(ee.weight) AS shared_weight
           FROM kb.event_entities ee JOIN kb.events e ON e.id = ee.event_id
           WHERE ee.entity_id = ANY(%s) AND e.id <> %s AND e.status <> 'merged'
             AND e.started_at < %s AND e.started_at > %s - interval '400 days'
           GROUP BY e.id ORDER BY sum(ee.weight) DESC LIMIT 60""",
        (ids, event_id, ev["started_at"], ev["started_at"]),
    )
    if not rows:
        return 0
    sem: dict[int, float] = {}
    if db.features()["vector"]:
        for r in db.fetch_all(
            """SELECT b.event_id, 1 - (a.centroid <=> b.centroid) AS sim FROM kb.event_embeddings a, kb.event_embeddings b
               WHERE a.event_id = %s AND b.event_id = ANY(%s)""",
            (event_id, [r["id"] for r in rows]),
        ):
            sem[r["event_id"]] = float(r["sim"])
    texts = db.fetch_all(
        """SELECT d.body, d.title FROM kb.event_documents ed JOIN kb.documents d ON d.id = ed.document_id
           WHERE ed.event_id = %s AND ed.role <> 'reprint' LIMIT 5""",
        (event_id,),
    )
    has_cue = any(CAUSAL_CUES.search(f"{t['title']} {(t['body'] or '')[:3000]}") for t in texts)
    actors = {r["subject_entity_id"] for r in db.fetch_all(
        "SELECT DISTINCT subject_entity_id FROM kb.claims WHERE event_id = %s AND subject_entity_id IS NOT NULL", (event_id,))}
    made = 0
    best_story: tuple[float, int | None, dict] | None = None
    for r in rows:
        shared = set(r["shared"])
        overlap = sum(idf.get(e, 0.3) for e in shared) / max(1e-6, sum(idf.values()))
        days = max(0.0, (ev["started_at"] - r["started_at"]).total_seconds() / 86400)
        s_sem = sem.get(r["id"])
        score = 0.55 * overlap + (0.35 * s_sem if s_sem is not None else 0.15) + (0.1 if r["category"] == ev["category"] else 0.0)
        evidence = {"shared_entities": sorted(shared), "overlap": round(overlap, 3), "sem": s_sem, "days": round(days, 1)}
        links: list[tuple[str, float]] = []
        if days <= 45 and score >= 0.45:
            links.append(("same_storyline", score))
            if best_story is None or score > best_story[0]:
                best_story = (score, r["storyline_id"], r)
        if ev["event_type"] and ev["event_type"] == r["event_type"] and overlap >= 0.5 and shared & specific:
            # previous occurrence of the same kind with the same actors
            links.append(("follow_up" if days <= 14 else "precedent", min(1.0, 0.4 + overlap)))
        if days <= 14:
            reacting = db.fetch_one(
                """SELECT count(*) AS n FROM kb.claims c
                   WHERE c.event_id = %s AND c.predicate = ANY(%s)
                     AND (c.object_entity_id = ANY(%s) OR c.subject_entity_id = ANY(%s))
                     AND (c.object_entity_id IN (SELECT subject_entity_id FROM kb.claims WHERE event_id = %s)
                          OR c.subject_entity_id IN (SELECT object_entity_id FROM kb.claims WHERE event_id = %s AND object_entity_id IS NOT NULL))""",
                (event_id, list(REACTION_PREDICATES), list(specific), list(specific), r["id"], r["id"]),
            )
            # a reaction must concern a specific actor/target, not just "Russia"; a causal cue alone needs strong overlap
            if (reacting and reacting["n"]) or (has_cue and overlap >= 0.6 and actors & shared & specific):
                links.append(("reaction_to", min(0.9, 0.45 + 0.1 * (reacting["n"] if reacting else 0) + 0.2 * overlap)))
        for link_type, s in links:
            made += db.execute(
                """INSERT INTO kb.event_links (from_event_id, to_event_id, link_type, score, evidence)
                   VALUES (%s, %s, %s, %s, %s::jsonb)
                   ON CONFLICT (from_event_id, to_event_id, link_type) DO UPDATE SET score = EXCLUDED.score, evidence = EXCLUDED.evidence""",
                (event_id, r["id"], link_type, round(s, 4), db.jsonb(evidence)),
            )
    if best_story is not None:
        _attach_storyline(ev, best_story)
    if ev["editorial_state"] == "deep":
        for r in db.fetch_all(
            "SELECT to_event_id FROM kb.event_links WHERE from_event_id = %s AND link_type = 'reaction_to' AND NOT verified LIMIT 3",
            (event_id,),
        ):
            enqueue("causal_check", f"causal:{event_id}:{r['to_event_id']}", {"from_event_id": event_id, "to_event_id": r["to_event_id"]},
                    priority=0.6, tier="standard")
    return made


def _attach_storyline(ev: dict, best: tuple) -> None:
    _score, storyline_id, other = best
    if storyline_id is None:
        shared = sorted(set(other["shared"]))
        row = db.fetch_one(
            """INSERT INTO kb.storylines (title, category, signature_entity_ids, first_at, last_at)
               VALUES (%s, %s, %s, %s, %s) RETURNING id""",
            (other["title"][:300], other["category"], shared, other["started_at"], ev["started_at"]),
        )
        storyline_id = row["id"]
        db.execute("UPDATE kb.events SET storyline_id = %s WHERE id = %s AND storyline_id IS NULL", (storyline_id, other["id"]))
    db.execute("UPDATE kb.events SET storyline_id = %s WHERE id = %s", (storyline_id, ev["id"]))
    db.execute(
        """UPDATE kb.storylines s SET event_count = (SELECT count(*) FROM kb.events WHERE storyline_id = s.id),
                  first_at = LEAST(first_at, %s), last_at = GREATEST(last_at, %s), updated_at = now() WHERE id = %s""",
        (ev["started_at"], ev["started_at"], storyline_id),
    )
