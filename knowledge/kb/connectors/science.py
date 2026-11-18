"""Science behind the news: OpenAlex (papers) and Crossref (DOI metadata, retractions and corrections).

For important events in research / science / health / AI categories the connector finds the most relevant recent
papers (OpenAlex search by the event's keywords and participants), stores them as records, and adds their landing
pages as web-research pages for the event (flagships and big articles can cite real papers). Crossref tells whether a
paper was retracted or corrected (`update-to`), which the dossier must mention.
OPENALEX_API_KEY is optional (higher daily budget); CONTACT_EMAIL is sent as mailto for the polite pools.
"""
from __future__ import annotations

import logging
import os
from datetime import date, timedelta

from .. import db
from ..config import settings
from .base import Connector, get_json, register, upsert_record

log = logging.getLogger(__name__)
SCIENCE_CATEGORIES = ("research", "science_space", "health", "biotech", "model", "climate_energy", "psychology", "ai_policy", "robotics")


def parse_openalex(payload: dict) -> list[dict]:
    out = []
    for w in payload.get("results", []):
        inv = w.get("abstract_inverted_index") or {}
        words = sorted(((pos, word) for word, positions in inv.items() for pos in positions))
        out.append({
            "id": w.get("id", "").rsplit("/", 1)[-1], "doi": (w.get("doi") or "").replace("https://doi.org/", "") or None,
            "title": w.get("title") or w.get("display_name") or "", "date": w.get("publication_date"),
            "cited_by": w.get("cited_by_count") or 0, "abstract": " ".join(word for _, word in words)[:3000],
            "venue": ((w.get("primary_location") or {}).get("source") or {}).get("display_name"),
            "url": ((w.get("primary_location") or {}).get("landing_page_url")) or w.get("doi"),
            "retracted": bool(w.get("is_retracted")),
        })
    return out


@register
class OpenAlexScience(Connector):
    name = "openalex"
    interval_s = 3 * 3600

    def run(self, cursor: dict) -> dict:
        events = db.fetch_all(
            """SELECT e.id, e.keywords, ARRAY(SELECT en.name FROM kb.event_entities ee JOIN kb.entities en ON en.id = ee.entity_id
                                       WHERE ee.event_id = e.id ORDER BY ee.weight DESC LIMIT 2) AS names
               FROM kb.events e
               WHERE e.status = 'open' AND e.category = ANY(%s) AND e.editorial_state IN ('ready', 'deep', 'written')
                 AND e.last_seen_at > now() - interval '30 hours'
                 AND NOT EXISTS (SELECT 1 FROM kb.event_research r JOIN kb.documents d ON d.id = r.document_id
                                 WHERE r.event_id = e.id AND d.meta->>'via' = 'openalex')
               ORDER BY e.importance DESC LIMIT 6""",
            (list(SCIENCE_CATEGORIES),),
        )
        params_base = {"per_page": 5, "select": "id,doi,title,display_name,publication_date,cited_by_count,abstract_inverted_index,primary_location,is_retracted",
                       "filter": f"from_publication_date:{(date.today() - timedelta(days=730)).isoformat()}"}
        if os.environ.get("OPENALEX_API_KEY"):
            params_base["api_key"] = os.environ["OPENALEX_API_KEY"]
        if settings.contact_email:
            params_base["mailto"] = settings.contact_email
        for ev in events:
            terms = [k for k in (ev["keywords"] or [])[:3]] + list(ev["names"] or [])[:1]
            if not terms:
                continue
            try:
                works = parse_openalex(get_json("https://api.openalex.org/works", params={**params_base, "search": " ".join(terms)[:200]}))
            except Exception as exc:  # noqa: BLE001
                self.add("errors")
                log.warning("OpenAlex %s: %s", terms, exc)
                continue
            for w in works[:3]:
                if not w["title"] or not w["url"]:
                    continue
                if w["doi"]:
                    w.update(crossref_status(w["doi"]))
                rid, _ = upsert_record("openalex", "paper", w["id"], w["title"],
                                       happened_on=date.fromisoformat(w["date"]) if w.get("date") else None, data=w, url=w["url"])
                body = f"{w['title']}\n\n{w['abstract']}" if w["abstract"] else None
                row = db.fetch_one(
                    """INSERT INTO kb.documents (kind, url, canonical_url, title, body, published_at, extraction_status, word_count, stage, meta)
                       VALUES ('research', %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                       ON CONFLICT (canonical_url) DO UPDATE SET canonical_url = EXCLUDED.canonical_url RETURNING id""",
                    (w["url"], w["url"].rstrip("/"), w["title"][:1000], body, w.get("date"), "partial" if body else "pending",
                     len((body or "").split()), "extracted" if body else "new",
                     db.jsonb({"via": "openalex", "research_for_event": ev["id"], "record_id": rid, "doi": w["doi"],
                               "retracted": w.get("retracted"), "venue": w.get("venue")})),
                )
                if row:
                    db.execute("INSERT INTO kb.event_research (event_id, document_id, query) VALUES (%s, %s, 'openalex') ON CONFLICT DO NOTHING",
                               (ev["id"], row["id"]))
                self.add("papers")
        return cursor


def crossref_status(doi: str) -> dict:
    """Retraction / correction notices and publisher from Crossref (best effort)."""
    try:
        params = {"mailto": settings.contact_email} if settings.contact_email else None
        msg = get_json(f"https://api.crossref.org/works/{doi}", params=params, timeout=30).get("message", {})
    except Exception:  # noqa: BLE001
        return {}
    updates = [u.get("type") for u in msg.get("updated-by", []) or []]
    return {"publisher": msg.get("publisher"), "crossref_updates": updates,
            "retracted": "retraction" in updates or None, "corrected": any(t in ("correction", "erratum") for t in updates) or None}
