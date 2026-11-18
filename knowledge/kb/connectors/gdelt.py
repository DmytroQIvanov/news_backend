"""GDELT DOC 2.0: how the world covers our events.

For the most important open events the connector asks GDELT which articles worldwide mention the event's key
participants in the last 3 days. Results are stored as coverage records (country, language, outlet) — the dossier then
says "covered by N outlets in M countries" — and, for events a flagship is being prepared for, the articles become web
research pages (kind 'research') that our collector fetches. GDELT asks for at most one request per 5 seconds.
GDELT records are never counted as independent confirmation: they say who wrote, not what is true.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from .. import db
from .base import Connector, get, register, upsert_record

log = logging.getLogger(__name__)
API = "https://api.gdeltproject.org/api/v2/doc/doc"


def event_query(names: list[str]) -> str | None:
    terms = [f'"{n}"' if " " in n else n for n in names if n and len(n) > 2][:2]
    if len(terms) < 2:
        return None
    return " ".join(terms)


def parse_artlist(payload: dict) -> list[dict]:
    out = []
    for a in payload.get("articles") or []:
        url = a.get("url") or ""
        if not url.startswith("http"):
            continue
        seen = a.get("seendate") or ""
        try:
            when = datetime.strptime(seen, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            when = None
        out.append({"url": url, "title": (a.get("title") or "")[:500], "domain": a.get("domain"), "language": a.get("language"),
                    "country": a.get("sourcecountry"), "seen": when})
    return out


@register
class GdeltCoverage(Connector):
    name = "gdelt"
    interval_s = 45 * 60

    def run(self, cursor: dict) -> dict:
        events = db.fetch_all(
            """SELECT e.id, (e.flagship_plan ? 'research') AS researching,
                      -- the shortest unambiguous Latin alias ("NVIDIA", not "NVIDIA Corporation"): GDELT matches phrases
                      ARRAY(SELECT COALESCE((SELECT a.alias FROM kb.entity_aliases a WHERE a.entity_id = en.id AND NOT a.ambiguous
                                               AND a.alias ~ '^[A-Za-z][A-Za-z0-9 .-]{2,}$' ORDER BY length(a.alias) LIMIT 1), en.name)
                            FROM kb.event_entities ee JOIN kb.entities en ON en.id = ee.entity_id
                            WHERE ee.event_id = e.id AND en.doc_count < 2000 ORDER BY ee.weight DESC LIMIT 2) AS names
               FROM kb.events e
               WHERE e.status = 'open' AND e.editorial_state IN ('ready', 'deep', 'written') AND e.last_seen_at > now() - interval '30 hours'
                 AND NOT EXISTS (SELECT 1 FROM kb.records r WHERE r.provider = 'gdelt' AND r.data->>'event_id' = e.id::text
                                 AND r.first_seen > now() - interval '12 hours')
               ORDER BY (e.flagship_plan ? 'research') DESC, e.importance DESC LIMIT 8"""
        )
        for ev in events:
            q = event_query(list(ev["names"] or []))
            if not q:
                continue
            time.sleep(5.5)
            try:
                resp = get(API, params={"query": q, "mode": "artlist", "maxrecords": 75, "format": "json", "timespan": "3d", "sort": "hybridrel"})
                if not resp.text.lstrip().startswith("{"):
                    raise RuntimeError(resp.text[:120])  # GDELT answers throttling with plain text
                arts = parse_artlist(resp.json())
            except Exception as exc:  # noqa: BLE001
                self.add("errors")
                log.warning("GDELT %s: %s", q, exc)
                continue
            countries = sorted({a["country"] for a in arts if a["country"]})
            langs = sorted({a["language"] for a in arts if a["language"]})
            upsert_record("gdelt", "coverage", f"event:{ev['id']}:{datetime.now(timezone.utc):%Y%m%d%H}", f"Global coverage of event {ev['id']}",
                          happened_on=datetime.now(timezone.utc).date(),
                          data={"event_id": ev["id"], "query": q, "articles": len(arts), "countries": countries, "languages": langs,
                                "outlets": sorted({a["domain"] for a in arts if a["domain"]})[:60]})
            self.add("events")
            self.add("articles", len(arts))
            if ev["researching"]:
                for a in arts[:8]:
                    row = db.fetch_one(
                        """INSERT INTO kb.documents (kind, url, canonical_url, title, published_at, stage, meta)
                           VALUES ('research', %s, %s, %s, %s, 'new', %s::jsonb)
                           ON CONFLICT (canonical_url) DO UPDATE SET canonical_url = EXCLUDED.canonical_url RETURNING id""",
                        (a["url"], a["url"].split("#")[0].rstrip("/"), a["title"] or a["url"], a["seen"],
                         db.jsonb({"research_for_event": ev["id"], "via": "gdelt", "country": a["country"], "language": a["language"]})),
                    )
                    if row:
                        db.execute("INSERT INTO kb.event_research (event_id, document_id, query) VALUES (%s, %s, 'gdelt') ON CONFLICT DO NOTHING",
                                   (ev["id"], row["id"]))
                        self.add("research_pages")
        return cursor
