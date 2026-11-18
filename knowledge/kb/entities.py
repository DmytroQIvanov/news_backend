"""Creating, merging and aliasing entities (shared by seeding, Wikidata resolution and maintenance)."""
from __future__ import annotations

import logging
from pathlib import Path

import yaml

from . import db
from .encyclopedia_metadata import enrichment_attributes
from .text.stem import term_key

log = logging.getLogger(__name__)
_SEED = Path(__file__).resolve().parent / "resources" / "seed_entities.yaml"
KINDS = {"person", "organization", "company", "government", "place", "product", "model", "technology", "event", "law",
         "facility", "weapon", "group", "other"}


def add_alias(conn, entity_id: int, alias: str, lang: str | None, origin: str, ambiguous: bool = False) -> None:
    alias = (alias or "").strip()
    key = term_key(alias)
    if not key or len(alias) > 200:
        return
    conn.execute(
        """INSERT INTO kb.entity_aliases (entity_id, alias, alias_key, lang, origin, ambiguous)
           VALUES (%s, %s, %s, %s, %s, %s)
           ON CONFLICT (entity_id, alias_key) DO UPDATE SET ambiguous = kb.entity_aliases.ambiguous AND EXCLUDED.ambiguous""",
        (entity_id, alias, key, lang, origin, ambiguous),
    )


def upsert_from_wikidata(conn, info: dict, fallback_kind: str = "other", origin: str = "wikidata") -> int:
    """Create (or find) the entity for a Wikidata item and store its labels, aliases and identifiers."""
    row = conn.execute("SELECT id FROM kb.entities WHERE wikidata_id = %s AND status <> 'merged'", (info["qid"],)).fetchone()
    labels = info.get("labels", {})
    name = labels.get("en") or labels.get("uk") or next(iter(labels.values()), info["qid"])
    if row:
        entity_id = row["id"]
        conn.execute(
            """UPDATE kb.entities SET name_uk = COALESCE(name_uk, %s), description = COALESCE(description, %s),
                      country = COALESCE(country, %s), updated_at = now() WHERE id = %s""",
            (labels.get("uk"), info.get("description"), info.get("country"), entity_id),
        )
        if info.get("coord"):
            conn.execute("UPDATE kb.entities SET attributes = attributes || jsonb_build_object('coord', %s::jsonb) WHERE id = %s",
                         (db.jsonb(info["coord"]), entity_id))
    else:
        kind = info.get("kind") if info.get("kind") in KINDS else fallback_kind
        entity_id = conn.execute(
            """INSERT INTO kb.entities (kind, name, name_uk, description, wikidata_id, country, origin, attributes)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb) RETURNING id""",
            (kind, name[:300], labels.get("uk"), info.get("description"), info["qid"], info.get("country"), origin,
             db.jsonb({"description_uk": info.get("description_uk"), "sitelinks": info.get("sitelinks"),
                       **({"coord": info["coord"]} if info.get("coord") else {})})),
        ).fetchone()["id"]
    conn.execute(
        "UPDATE kb.entities SET attributes = attributes || %s::jsonb WHERE id = %s",
        (db.jsonb(enrichment_attributes(info)), entity_id),
    )
    for lang, label in labels.items():
        add_alias(conn, entity_id, label, lang, "wikidata")
    for lang, values in info.get("aliases", {}).items():
        for a in values[:15]:
            # very short aliases from Wikidata are a common source of false matches
            add_alias(conn, entity_id, a, lang, "wikidata", ambiguous=len(a) <= 3 and not a.isupper())
    conn.execute(
        "INSERT INTO kb.entity_identifiers (entity_id, scheme, value) VALUES (%s, 'wikidata', %s) ON CONFLICT DO NOTHING",
        (entity_id, info["qid"]),
    )
    for scheme, value in (info.get("identifiers") or {}).items():
        conn.execute(
            "INSERT INTO kb.entity_identifiers (entity_id, scheme, value) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
            (entity_id, scheme, str(value)[:200]),
        )
    return entity_id


def seed_from_yaml(path: Path = _SEED) -> int:
    if not path.exists():
        log.warning("seed file %s not found", path)
        return 0
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    created = 0
    with db.tx() as conn:
        for item in data.get("entities", []):
            name = str(item.get("name", "")).strip()
            kind = item.get("kind") if item.get("kind") in KINDS else "other"
            if not name:
                continue
            row = conn.execute(
                "SELECT id FROM kb.entities WHERE lower(name) = lower(%s) AND kind = %s AND status <> 'merged' LIMIT 1", (name, kind)
            ).fetchone()
            if row:
                entity_id = row["id"]
            else:
                prior = {c: round(1.0 / len(item.get("categories") or [1]), 3) for c in (item.get("categories") or [])}
                entity_id = conn.execute(
                    """INSERT INTO kb.entities (kind, name, name_uk, country, origin, category_prior)
                       VALUES (%s, %s, %s, %s, 'seed', %s::jsonb) RETURNING id""",
                    (kind, name[:300], item.get("name_uk"), (item.get("country") or None), db.jsonb(prior)),
                ).fetchone()["id"]
                created += 1
            add_alias(conn, entity_id, name, "en", "seed")
            if item.get("name_uk"):
                add_alias(conn, entity_id, item["name_uk"], "uk", "seed")
            for a in item.get("aliases") or []:
                add_alias(conn, entity_id, str(a), None, "seed")
            for a in item.get("ambiguous_aliases") or []:
                add_alias(conn, entity_id, str(a), None, "seed", ambiguous=True)
    log.info("seeded %d new entities from %s", created, path.name)
    return created


LEGACY_KIND = {"company": "company", "model": "model", "technology": "technology", "product": "product", "event": "event",
               "person": "person", "organization": "organization", "place": "place", "other": "other"}


def import_legacy_kg() -> int:
    """public.kg_entities (the NestJS insights dictionary) -> kb.entities, keeping the link both ways."""
    rows = db.fetch_all(
        """SELECT k.id, k.name, k.entity_type, k.description_uk, COALESCE(k.aliases, '{}') AS aliases
           FROM public.kg_entities k LEFT JOIN kb.entities e ON e.legacy_kg_id = k.id WHERE e.id IS NULL"""
    )
    created = 0
    with db.tx() as conn:
        for r in rows:
            kind = LEGACY_KIND.get(r["entity_type"], "other")
            existing = conn.execute(
                """SELECT e.id FROM kb.entities e JOIN kb.entity_aliases a ON a.entity_id = e.id
                   WHERE a.alias_key = %s AND e.status = 'active' LIMIT 1""",
                (term_key(r["name"]),),
            ).fetchone()
            if existing:
                entity_id = existing["id"]
                conn.execute("UPDATE kb.entities SET legacy_kg_id = COALESCE(legacy_kg_id, %s) WHERE id = %s", (r["id"], entity_id))
            else:
                entity_id = conn.execute(
                    """INSERT INTO kb.entities (kind, name, description, legacy_kg_id, origin) VALUES (%s, %s, %s, %s, 'legacy')
                       RETURNING id""",
                    (kind, r["name"][:300], r["description_uk"], r["id"]),
                ).fetchone()["id"]
                created += 1
            add_alias(conn, entity_id, r["name"], None, "legacy")
            for a in r["aliases"] or []:
                add_alias(conn, entity_id, str(a).rstrip("*"), None, "legacy")
    return created


def merge(conn, keep_id: int, drop_id: int) -> list[int]:
    """Merge duplicate entities; history is preserved (drop_id stays as status 'merged')."""
    if keep_id == drop_id:
        return []
    affected = [r["document_id"] for r in conn.execute(
        """SELECT DISTINCT c.document_id FROM kb.claims c JOIN kb.facts f ON f.id = c.fact_id
           WHERE f.subject_entity_id = %s OR f.object_entity_id = %s LIMIT 1000""",
        (drop_id, drop_id),
    ).fetchall()]
    conn.execute("UPDATE kb.mentions SET entity_id = %s WHERE entity_id = %s", (keep_id, drop_id))
    conn.execute(
        """INSERT INTO kb.document_entities (document_id, entity_id, mentions, salience, in_title)
           SELECT document_id, %s, mentions, salience, in_title FROM kb.document_entities WHERE entity_id = %s
           ON CONFLICT (document_id, entity_id) DO UPDATE SET mentions = kb.document_entities.mentions + EXCLUDED.mentions,
                  salience = GREATEST(kb.document_entities.salience, EXCLUDED.salience)""",
        (keep_id, drop_id),
    )
    conn.execute("DELETE FROM kb.document_entities WHERE entity_id = %s", (drop_id,))
    conn.execute(
        """INSERT INTO kb.event_entities (event_id, entity_id, weight, doc_count, role)
           SELECT event_id, %s, weight, doc_count, role FROM kb.event_entities WHERE entity_id = %s
           ON CONFLICT (event_id, entity_id) DO UPDATE SET weight = kb.event_entities.weight + EXCLUDED.weight""",
        (keep_id, drop_id),
    )
    conn.execute("DELETE FROM kb.event_entities WHERE entity_id = %s", (drop_id,))
    # Facts are re-derived from claims: detach the dropped entity's facts, re-point claims, re-aggregate later.
    conn.execute(
        """UPDATE kb.claims SET fact_id = NULL WHERE fact_id IN (
             SELECT id FROM kb.facts WHERE subject_entity_id = %s OR object_entity_id = %s)""",
        (drop_id, drop_id),
    )
    conn.execute("DELETE FROM kb.facts WHERE subject_entity_id = %s OR object_entity_id = %s", (drop_id, drop_id))
    for col in ("subject_entity_id", "object_entity_id", "attributed_to_entity_id"):
        conn.execute(f"UPDATE kb.claims SET {col} = %s WHERE {col} = %s", (keep_id, drop_id))
    conn.execute(
        """UPDATE kb.events e SET entity_weights = (e.entity_weights - %s::text)
                  || jsonb_build_object(%s::text, COALESCE((e.entity_weights->>%s::text)::real, 0) + COALESCE((e.entity_weights->>%s::text)::real, 0))
           WHERE e.entity_weights ? %s::text""",
        (str(drop_id), str(keep_id), str(keep_id), str(drop_id), str(drop_id)),
    )
    conn.execute("DELETE FROM kb.entity_relations WHERE from_entity_id = %s OR to_entity_id = %s", (drop_id, drop_id))
    conn.execute(
        """INSERT INTO kb.entity_aliases (entity_id, alias, alias_key, lang, origin, ambiguous, weight)
           SELECT %s, alias, alias_key, lang, origin, ambiguous, weight FROM kb.entity_aliases WHERE entity_id = %s
           ON CONFLICT DO NOTHING""",
        (keep_id, drop_id),
    )
    conn.execute("UPDATE kb.entity_identifiers SET entity_id = %s WHERE entity_id = %s AND scheme <> 'wikidata'", (keep_id, drop_id))
    conn.execute("UPDATE kb.entities SET status = 'merged', merged_into = %s, updated_at = now() WHERE id = %s", (keep_id, drop_id))
    return affected  # caller re-aggregates facts for these documents after commit
