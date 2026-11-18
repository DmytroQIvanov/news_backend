"""Periodic maintenance worker: grows and cleans the knowledge graph.

Every KB_MAINTAIN_INTERVAL_S (15 min):
  refresh_candidates   exact doc/source counts for unknown names
  resolve_candidates   names seen in 2+ sources -> Wikidata -> new entities (+ aliases, identifiers), re-link old mentions
  entity_stats         mention/doc/source counts, first/last seen, category priors
  cooccurrence         entity pairs that appear in the same events (NPMI) -> kb.entity_relations('cooccurrence')
  close_events         events quiet for 72h are closed (never-ready ones become 'skipped' context)
  merge_events         near-identical open events (centroid >= 0.88 and entity overlap) are merged
  link_events          storylines / precedents / reactions for recently changed events
  enrich_entities      entities without a Wikidata ID get one (and registry IDs) when the match is confident
Daily: train-classifier (level-2 category model and level-3 centroids).
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone

from . import db
from .config import settings
from .entities import add_alias, merge, upsert_from_wikidata
from .graph import importance, storylines
from .llm.queue import enqueue

log = logging.getLogger(__name__)


def learn_boilerplate(days: int = 14, min_docs: int = 4) -> int:
    """Paragraphs that occur in >= min_docs articles of the same source are boilerplate (CTA blocks, disclaimers)."""
    from collections import defaultdict

    from .text.normalize import fingerprint_text, sha256

    sources = db.fetch_all(
        """SELECT source_id FROM kb.documents WHERE body IS NOT NULL AND created_at > now() - make_interval(days => %s)
           GROUP BY source_id HAVING count(*) >= 8""",
        (days,),
    )
    learned = 0
    for s in sources:
        rows = db.fetch_all(
            """SELECT body FROM kb.documents WHERE source_id = %s AND body IS NOT NULL
                 AND created_at > now() - make_interval(days => %s) ORDER BY id DESC LIMIT 400""",
            (s["source_id"], days),
        )
        counts: dict[str, int] = defaultdict(int)
        sample: dict[str, str] = {}
        for r in rows:
            seen = set()
            for para in r["body"].split("\n\n"):
                p = para.strip()
                if len(p) < 15 or len(p) > 700:
                    continue
                h = sha256(fingerprint_text(p))[:16]
                if h not in seen:
                    seen.add(h)
                    counts[h] += 1
                    sample.setdefault(h, p[:300])
        threshold = max(min_docs, int(0.15 * len(rows)))
        with db.tx() as conn:
            for h, n in counts.items():
                if n >= threshold:
                    conn.execute(
                        """INSERT INTO kb.source_boilerplate (source_id, para_hash, sample, doc_count) VALUES (%s, %s, %s, %s)
                           ON CONFLICT (source_id, para_hash) DO UPDATE SET doc_count = EXCLUDED.doc_count, updated_at = now()""",
                        (s["source_id"], h, sample[h], n),
                    )
                    learned += 1
    return learned


def link_source_speakers() -> int:
    """A primary source speaks for one actor (NVIDIA Blog -> NVIDIA, OpenAI News -> OpenAI): only then its own
    statements about that actor count as confirmation."""
    from .text.stem import term_key

    rows = db.fetch_all(
        """SELECT p.source_id, s.name, s.provider_id FROM kb.source_profiles p JOIN public.sources s ON s.id = p.source_id
           WHERE p.tier = 'primary' AND p.speaks_for_entity_id IS NULL"""
    )
    linked = 0
    for r in rows:
        name = re.sub(r"\b(blog|news|newsroom|releases?|research|press|official|community feed|feed|ai|labs?|sdk|python)\b",
                      " ", r["name"], flags=re.I).strip()
        for cand in [c for c in (name, r["provider_id"]) if c]:
            hit = db.fetch_one(
                """SELECT a.entity_id FROM kb.entity_aliases a JOIN kb.entities e ON e.id = a.entity_id
                   WHERE a.alias_key = %s AND e.status = 'active' AND e.kind IN ('company', 'organization', 'government', 'product')
                   ORDER BY e.mention_count DESC LIMIT 1""",
                (term_key(cand),),
            )
            if hit:
                db.execute("UPDATE kb.source_profiles SET speaks_for_entity_id = %s WHERE source_id = %s", (hit["entity_id"], r["source_id"]))
                linked += 1
                break
    return linked


def requeue_outdated(limit: int = 500) -> int:
    """Documents analyzed by an older analyzer version are re-analyzed (recent ones first)."""
    from .nlp.pipeline import ANALYZER_VERSION

    return db.execute(
        """UPDATE kb.documents SET stage = 'analyzed', stage_attempts = 0, updated_at = now()
           WHERE id IN (SELECT id FROM kb.documents
                        WHERE stage = 'clustered' AND COALESCE(analyzer_version, 0) < %s
                          AND created_at > now() - interval '30 days'
                        ORDER BY id DESC LIMIT %s)""",
        (ANALYZER_VERSION, limit),
    )


def refresh_candidates() -> int:
    return db.execute(
        """WITH agg AS (
             SELECT m.surface_key, count(DISTINCT m.document_id) AS docs, count(DISTINCT d.source_id) AS sources,
                    count(*) AS mentions, array_agg(DISTINCT d.source_id) FILTER (WHERE d.source_id IS NOT NULL) AS src
             FROM kb.mentions m JOIN kb.documents d ON d.id = m.document_id
             WHERE m.entity_id IS NULL AND m.surface_key IN (SELECT surface_key FROM kb.entity_candidates
                                                             WHERE status = 'pending' AND updated_at > now() - interval '1 day')
             GROUP BY m.surface_key)
           UPDATE kb.entity_candidates c SET doc_count = agg.docs, source_count = agg.sources, mention_count = agg.mentions,
                  source_ids = COALESCE(agg.src, '{}')
           FROM agg WHERE c.surface_key = agg.surface_key"""
    )


def _relink(conn, surface_key: str, entity_id: int) -> int:
    """Link old mentions now, and send the affected documents back to analysis so their claims, facts and
    event profiles include the new entity (cheap: re-analysis is idempotent and keeps the event)."""
    conn.execute(
        """UPDATE kb.documents SET stage = 'analyzed', stage_attempts = 0, updated_at = now()
           WHERE stage = 'clustered' AND id IN (SELECT document_id FROM kb.mentions WHERE surface_key = %s AND entity_id IS NULL
                                                ORDER BY document_id DESC LIMIT 300)""",
        (surface_key,),
    )
    n = conn.execute(
        "UPDATE kb.mentions SET entity_id = %s, link_confidence = 0.8 WHERE surface_key = %s AND entity_id IS NULL",
        (entity_id, surface_key),
    ).rowcount
    conn.execute(
        """INSERT INTO kb.document_entities (document_id, entity_id, mentions, salience, in_title)
           SELECT document_id, %s, count(*), LEAST(1.0, 0.2 + 0.45 * bool_or(in_title)::int + 0.1 * count(*)), bool_or(in_title)
           FROM kb.mentions WHERE surface_key = %s AND entity_id = %s GROUP BY document_id
           ON CONFLICT (document_id, entity_id) DO NOTHING""",
        (entity_id, surface_key, entity_id),
    )
    return n


def resolve_candidates(limit: int | None = None) -> dict:
    from .enrich import wikidata

    stats = {"checked": 0, "linked": 0, "created": 0, "local": 0, "noise": 0}
    if not settings.wikidata_enabled:
        return stats
    rows = db.fetch_all(
        """SELECT * FROM kb.entity_candidates
           WHERE status = 'pending' AND source_count >= %s AND mention_count >= %s
             AND (wikidata_checked_at IS NULL OR wikidata_checked_at < now() - interval '14 days')
           ORDER BY source_count DESC, mention_count DESC LIMIT %s""",
        (settings.candidate_min_sources, settings.candidate_min_mentions, limit or settings.wikidata_per_run),
    )
    for c in rows:
        stats["checked"] += 1
        if c["label"] == "group":
            # nationality adjectives ("Chinese", "Israeli", "російські") are not entities of their own
            db.execute("UPDATE kb.entity_candidates SET status = 'noise', wikidata_checked_at = now() WHERE id = %s", (c["id"],))
            stats["noise"] += 1
            continue
        surface = re.sub(r"^(?:the|The)\s+", "", c["surface"]).strip()
        lang = "uk" if any("\u0400" <= ch <= "\u04ff" for ch in surface) else "en"
        common = wikidata.is_common_word(surface)
        try:
            info = None if common else wikidata.resolve(surface, c["label"], lang)
        except Exception as exc:
            log.warning("wikidata lookup failed for %s: %s", surface, exc)
            continue
        if common or (info and info.get("ambiguous")):
            # The algorithm is not sure: ask the cheap LLM tier with real contexts, once.
            samples = db.fetch_all(
                "SELECT left(sentence, 300) AS s FROM kb.claims WHERE document_id = ANY(%s) AND sentence ILIKE %s LIMIT 3",
                (c["sample_document_ids"], f"%{surface}%"),
            )
            enqueue("entity_resolve", f"entity_resolve:{c['surface_key']}",
                    {"candidate_id": c["id"], "surface": surface, "label": c["label"],
                     "options": (info or {}).get("options", []), "contexts": [r["s"] for r in samples]},
                    priority=min(1.0, c["source_count"] / 10), tier="lite")
            db.execute("UPDATE kb.entity_candidates SET wikidata_checked_at = now(), wikidata_result = %s::jsonb WHERE id = %s",
                       (db.jsonb(info or {"common_word": True}), c["id"]))
            stats["to_llm"] = stats.get("to_llm", 0) + 1
            continue
        with db.tx() as conn:
            if info:
                existed = conn.execute("SELECT id FROM kb.entities WHERE wikidata_id = %s AND status <> 'merged'", (info["qid"],)).fetchone()
                entity_id = upsert_from_wikidata(conn, info, fallback_kind=c["label"] or "other")
                add_alias(conn, entity_id, surface, lang, "ner")
                _relink(conn, c["surface_key"], entity_id)
                conn.execute(
                    """UPDATE kb.entity_candidates SET status = %s, entity_id = %s, wikidata_checked_at = now(),
                              wikidata_result = %s::jsonb WHERE id = %s""",
                    ("resolved" if existed else "created", entity_id, db.jsonb({"qid": info["qid"], "kind": info["kind"]}), c["id"]),
                )
                stats["linked" if existed else "created"] += 1
            elif (c["source_count"] >= 3 and c["label"] in ("person", "organization", "product", "facility")
                  and len(surface) >= 4 and _nominative(surface)):
                # Not in Wikidata but reported by 3+ sources: a local entity (new official, startup, unit).
                similar = _similar_local(conn, surface, c["label"])
                if similar:
                    entity_id = similar
                    stats["local_alias"] = stats.get("local_alias", 0) + 1
                else:
                    entity_id = conn.execute(
                        "INSERT INTO kb.entities (kind, name, origin) VALUES (%s, %s, 'ner') RETURNING id",
                        (c["label"], surface[:300]),
                    ).fetchone()["id"]
                    stats["local"] += 1
                add_alias(conn, entity_id, surface, lang, "ner")
                _relink(conn, c["surface_key"], entity_id)
                conn.execute("UPDATE kb.entity_candidates SET status = 'created', entity_id = %s, wikidata_checked_at = now() WHERE id = %s",
                             (entity_id, c["id"]))
            else:
                conn.execute("UPDATE kb.entity_candidates SET wikidata_checked_at = now() WHERE id = %s", (c["id"],))
    return stats


def _nominative(surface: str) -> bool:
    """Ukrainian/Russian names become entities only from a nominative form ("Дженсен Хуанг", not "Дженсена Хуанга")."""
    from .text.stem import _morph, is_cyrillic

    if not is_cyrillic(surface):
        return True
    morph = _morph("uk")
    if morph is None:
        return True
    last = surface.split()[-1]
    return any("nomn" in p.tag for p in morph.parse(last)[:3])


def _similar_local(conn, surface: str, kind: str) -> int | None:
    """An existing entity of the same kind with a near-identical alias (inflection or spelling variant)."""
    from .text.stem import term_key

    key = term_key(surface)
    if db.features()["trgm"]:
        row = conn.execute(
            """SELECT a.entity_id FROM kb.entity_aliases a JOIN kb.entities e ON e.id = a.entity_id
               WHERE e.status = 'active' AND e.kind = %s AND similarity(a.alias_key, %s) >= 0.6
               ORDER BY similarity(a.alias_key, %s) DESC LIMIT 1""",
            (kind, key, key),
        ).fetchone()
        return row["entity_id"] if row else None
    return None


def entity_stats() -> int:
    n = db.execute(
        """WITH s AS (
             SELECT de.entity_id, sum(de.mentions) AS mentions, count(*) AS docs, count(DISTINCT d.source_id) AS sources,
                    min(COALESCE(d.published_at, d.created_at)) AS first_seen, max(COALESCE(d.published_at, d.created_at)) AS last_seen
             FROM kb.document_entities de JOIN kb.documents d ON d.id = de.document_id
             GROUP BY de.entity_id)
           UPDATE kb.entities e SET mention_count = s.mentions, doc_count = s.docs, source_count = s.sources,
                  first_seen = s.first_seen, last_seen = s.last_seen, updated_at = now()
           FROM s WHERE e.id = s.entity_id AND (e.mention_count, e.doc_count) IS DISTINCT FROM (s.mentions, s.docs)"""
    )
    # Category priors learned from confidently categorized documents (seed priors are kept until there is data).
    db.execute(
        """WITH c AS (
             SELECT de.entity_id, d.category, sum(de.salience) AS w
             FROM kb.document_entities de JOIN kb.documents d ON d.id = de.document_id
             WHERE d.category IS NOT NULL AND d.category <> 'other' AND d.category_confidence >= 0.6
             GROUP BY de.entity_id, d.category),
           t AS (SELECT entity_id, sum(w) AS total FROM c GROUP BY entity_id HAVING sum(w) >= 3),
           p AS (SELECT c.entity_id, jsonb_object_agg(c.category, round((c.w / t.total)::numeric, 3)) AS prior
                 FROM c JOIN t USING (entity_id) WHERE c.w / t.total >= 0.1 GROUP BY c.entity_id)
           UPDATE kb.entities e SET category_prior = p.prior FROM p WHERE e.id = p.entity_id"""
    )
    return n


def cooccurrence(days: int = 180) -> int:
    """NPMI over events (not documents: 30 reprints of one story are one co-occurrence)."""
    with db.tx() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(7311003)")
        conn.execute("DELETE FROM kb.entity_relations WHERE origin = 'cooccurrence'")
        return conn.execute(
        """WITH ev AS (
             SELECT ee.event_id, ee.entity_id FROM kb.event_entities ee JOIN kb.events e ON e.id = ee.event_id
             WHERE e.started_at > now() - make_interval(days => %s) AND ee.weight >= 0.2 AND e.status <> 'merged'),
           n AS (SELECT count(DISTINCT event_id)::float AS total FROM ev),
           single AS (SELECT entity_id, count(*)::float AS c FROM ev GROUP BY entity_id HAVING count(*) >= 2),
           pairs AS (
             SELECT a.entity_id AS x, b.entity_id AS y, count(*)::float AS c
             FROM ev a JOIN ev b ON a.event_id = b.event_id AND a.entity_id < b.entity_id
             GROUP BY 1, 2 HAVING count(*) >= 2)
           INSERT INTO kb.entity_relations (from_entity_id, to_entity_id, relation, origin, weight, evidence_count)
           SELECT p.x, p.y, 'co_mentioned', 'cooccurrence',
                  GREATEST(0.01, ln(p.c * n.total / (sx.c * sy.c)) / -ln(p.c / n.total)) * ln(1 + p.c), p.c::int
           FROM pairs p JOIN single sx ON sx.entity_id = p.x JOIN single sy ON sy.entity_id = p.y, n
           WHERE n.total > 0 AND p.c < n.total AND ln(p.c * n.total / (sx.c * sy.c)) > 0""",
        (days,),
        ).rowcount


def close_events() -> int:
    n = db.execute(
        "UPDATE kb.events SET status = 'closed', updated_at = now() WHERE status = 'open' AND last_seen_at < now() - interval '72 hours'"
    )
    db.execute(
        """UPDATE kb.events SET editorial_state = 'skipped'
           WHERE status = 'closed' AND editorial_state = 'collecting'"""
    )
    return n


def merge_events() -> int:
    if not db.features()["vector"]:
        return 0
    pairs = db.fetch_all(
        """SELECT a.event_id AS a, b.event_id AS b, 1 - (a.centroid <=> b.centroid) AS sim
           FROM kb.event_embeddings a JOIN kb.events ea ON ea.id = a.event_id AND ea.status = 'open'
           JOIN LATERAL (
             SELECT b.event_id, b.centroid FROM kb.event_embeddings b JOIN kb.events eb ON eb.id = b.event_id
             WHERE eb.status = 'open' AND b.event_id > a.event_id AND abs(extract(epoch FROM eb.started_at - ea.started_at)) < 172800
             ORDER BY a.centroid <=> b.centroid LIMIT 3) b ON true
           WHERE ea.last_seen_at > now() - interval '48 hours' AND 1 - (a.centroid <=> b.centroid) >= 0.88"""
    )
    merged = 0
    for p in pairs:
        overlap = db.fetch_one(
            """SELECT count(*) FILTER (WHERE x.entity_id IS NOT NULL AND y.entity_id IS NOT NULL)::float
                      / GREATEST(1, count(*)) AS j
               FROM (SELECT entity_id FROM kb.event_entities WHERE event_id = %s AND weight >= 0.3) x
               FULL JOIN (SELECT entity_id FROM kb.event_entities WHERE event_id = %s AND weight >= 0.3) y USING (entity_id)""",
            (p["a"], p["b"]),
        )
        if not overlap or overlap["j"] < 0.4:
            continue
        keep, drop = sorted((p["a"], p["b"]), key=lambda e: -(db.fetch_one("SELECT doc_count FROM kb.events WHERE id = %s", (e,)) or {"doc_count": 0})["doc_count"])
        with db.tx() as conn:
            st = conn.execute("SELECT status FROM kb.events WHERE id IN (%s, %s) FOR UPDATE", (keep, drop)).fetchall()
            if len(st) < 2 or any(s["status"] != "open" for s in st):
                continue
            conn.execute("UPDATE kb.event_documents SET event_id = %s WHERE event_id = %s", (keep, drop))
            conn.execute("UPDATE kb.claims SET event_id = %s WHERE event_id = %s", (keep, drop))
            conn.execute(
                """INSERT INTO kb.event_entities (event_id, entity_id, weight, doc_count, role)
                   SELECT %s, entity_id, weight, doc_count, role FROM kb.event_entities WHERE event_id = %s
                   ON CONFLICT (event_id, entity_id) DO UPDATE SET weight = kb.event_entities.weight + EXCLUDED.weight,
                          doc_count = kb.event_entities.doc_count + EXCLUDED.doc_count""",
                (keep, drop),
            )
            conn.execute(
                """UPDATE kb.events k SET entity_weights = (
                     SELECT jsonb_object_agg(entity_id::text, round(weight::numeric, 4)) FROM kb.event_entities WHERE event_id = k.id)
                   WHERE k.id = %s""",
                (keep,),
            )
            cents = {r["event_id"]: r for r in conn.execute(
                "SELECT event_id, centroid::text AS c, n FROM kb.event_embeddings WHERE event_id IN (%s, %s) FOR UPDATE", (keep, drop)
            ).fetchall()}
            if keep in cents and drop in cents:
                import numpy as np

                from .nlp.embed import from_pg, to_pg

                k, d = cents[keep], cents[drop]
                merged_vec = from_pg(k["c"]) * k["n"] + from_pg(d["c"]) * d["n"]
                merged_vec = merged_vec / (np.linalg.norm(merged_vec) or 1.0)
                conn.execute("UPDATE kb.event_embeddings SET centroid = %s::vector, n = %s, updated_at = now() WHERE event_id = %s",
                             (to_pg(merged_vec), k["n"] + d["n"], keep))
            conn.execute("UPDATE kb.events SET status = 'merged', merged_into = %s, updated_at = now() WHERE id = %s", (keep, drop))
        importance.refresh_event(keep)
        merged += 1
    return merged


def link_recent_events(since_minutes: int = 30, limit: int = 300) -> int:
    rows = db.fetch_all(
        """SELECT id FROM kb.events WHERE status <> 'merged' AND updated_at > now() - make_interval(mins => %s)
           AND (doc_count >= 2 OR editorial_state IN ('ready', 'deep'))
           ORDER BY importance DESC LIMIT %s""",
        (since_minutes, limit),
    )
    made = 0
    for r in rows:
        try:
            made += storylines.link_event(r["id"])
            importance.refresh_event(r["id"])
        except Exception:
            log.exception("linking event %s failed", r["id"])
    return made


def enrich_entities(limit: int = 20) -> int:
    from .enrich import wikidata

    if not settings.wikidata_enabled:
        return 0
    rows = db.fetch_all(
        """SELECT e.id, e.name, e.name_uk, e.kind FROM kb.entities e
           WHERE e.wikidata_id IS NULL AND e.status = 'active' AND NOT (e.attributes ? 'wikidata_checked')
           ORDER BY e.mention_count DESC, e.id LIMIT %s""",
        (limit,),
    )
    done = 0
    to_reaggregate: list[int] = []
    kind_to_label = {"person": "person", "company": "organization", "organization": "organization", "government": "organization",
                     "place": "place", "facility": "facility", "product": "product", "model": "product", "weapon": "product",
                     "law": "law", "event": "event", "group": "group"}
    for r in rows:
        try:
            info = wikidata.resolve(r["name"], kind_to_label.get(r["kind"]), "en") or (
                wikidata.resolve(r["name_uk"], kind_to_label.get(r["kind"]), "uk") if r["name_uk"] else None)
        except Exception as exc:
            log.warning("wikidata enrich %s failed: %s", r["name"], exc)
            continue
        if info and info.get("ambiguous"):
            info = None
        with db.tx() as conn:
            if info:
                other = conn.execute("SELECT id FROM kb.entities WHERE wikidata_id = %s AND status <> 'merged' AND id <> %s",
                                     (info["qid"], r["id"])).fetchone()
                if other:
                    to_reaggregate += merge(conn, other["id"], r["id"])
                else:
                    conn.execute("UPDATE kb.entities SET wikidata_id = %s WHERE id = %s", (info["qid"], r["id"]))
                    upsert_from_wikidata(conn, info, fallback_kind=r["kind"])
                done += 1
            conn.execute(
                "UPDATE kb.entities SET attributes = attributes || jsonb_build_object('wikidata_checked', now()::text) WHERE id = %s",
                (r["id"],),
            )
    if to_reaggregate:
        from .graph.facts import aggregate_document

        for doc_id in sorted(set(to_reaggregate)):
            row = db.fetch_one("SELECT event_id FROM kb.event_documents WHERE document_id = %s", (doc_id,))
            aggregate_document(doc_id, row["event_id"] if row else None)
    return done


def run_once() -> dict:
    """One maintenance pass. Only one maintainer runs at a time (advisory lock), even if the service is scaled."""
    from .graph.facts import rebuild_fact_relations

    held = db.try_advisory_lock(7_311_000)
    if held is None:
        return {"skipped": "another maintainer is running"}
    with held:
        return _run_steps(rebuild_fact_relations)


def _run_steps(rebuild_fact_relations) -> dict:
    stats: dict = {}
    for name, fn in (
        ("queue_expired", db.expire_exhausted),
        ("requeued_outdated", requeue_outdated),
        ("source_speakers", link_source_speakers),
        ("boilerplate", learn_boilerplate),
        ("candidates_refreshed", refresh_candidates),
        ("candidates", resolve_candidates),
        ("entity_stats", entity_stats),
        ("events_closed", close_events),
        ("events_merged", merge_events),
        ("event_links", link_recent_events),
        ("entities_enriched", enrich_entities),
        ("fact_relations", rebuild_fact_relations),
    ):
        t0 = time.time()
        try:
            stats[name] = fn()
        except Exception as exc:
            log.exception("maintenance step %s failed", name)
            stats[name] = f"error: {exc}"[:200]
        stats[f"{name}_s"] = round(time.time() - t0, 2)
    return stats


def run_forever() -> None:
    log.info("maintenance worker started")
    from .entities import import_legacy_kg, seed_from_yaml

    seed_from_yaml()
    import_legacy_kg()
    last_daily = 0.0
    while True:
        with db.RunRecorder("maintain") as run:
            for k, v in run_once().items():
                run.stats[k] = v
            if time.time() - last_daily > 24 * 3600:
                from .train import train_category_models

                try:
                    run.stats["cooccurrence"] = cooccurrence()
                    run.stats["classifier"] = train_category_models()
                except Exception as exc:
                    log.exception("daily jobs failed")
                    run.stats["daily_error"] = str(exc)[:200]
                last_daily = time.time()
            run.stats["at"] = datetime.now(timezone.utc).isoformat()
        time.sleep(settings.maintain_interval_s)
