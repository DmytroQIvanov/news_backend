"""Wikidata: resolve names to QIDs, pull multilingual labels/aliases, types and registry identifiers.

Every response is cached in kb.wikidata_cache. Calls are few (only names seen in several sources) and polite:
a descriptive User-Agent (Wikimedia policy), sequential requests, maxlag.
Identifiers pulled here connect the news graph to datasets (task 3): SEC CIK, ticker, LEI, ISIN, GDELT, ISO codes.
"""
from __future__ import annotations

import logging
import time

from .. import db
from ..encyclopedia_metadata import class_tags
from ..collect.http import client

log = logging.getLogger(__name__)
API = "https://www.wikidata.org/w/api.php"
LANGS = ["uk", "en", "de", "ru"]

# instance-of (P31) / subclass targets -> our entity kind
TYPE_MAP = {
    "Q5": "person",
    "Q4830453": "company", "Q891723": "company", "Q6881511": "company", "Q783794": "company", "Q1058914": "company",
    "Q43229": "organization", "Q163740": "organization", "Q484652": "organization", "Q15911314": "organization",
    "Q7210356": "organization", "Q245065": "organization", "Q1127126": "organization", "Q2659904": "government",
    "Q327333": "government", "Q192350": "government", "Q35798": "government", "Q7188": "government",
    "Q6256": "place", "Q3624078": "place", "Q515": "place", "Q1549591": "place", "Q486972": "place", "Q3957": "place",
    "Q1093829": "place", "Q20202352": "place", "Q12131624": "place", "Q107390": "place", "Q35657": "place", "Q82794": "place",
    "Q7397": "product", "Q1172284": "product", "Q431289": "product", "Q2424752": "product",
    "Q7889": "product", "Q11032": "organization", "Q1110794": "organization",
    "Q728": "weapon", "Q18643213": "weapon", "Q11446": "weapon", "Q127771": "weapon", "Q15142889": "weapon",
    "Q820655": "law", "Q131569": "law", "Q93288": "law", "Q7748": "law",
    "Q1656682": "event", "Q178561": "event", "Q40231": "event", "Q645883": "event",
    "Q7278": "organization", "Q2385804": "organization", "Q48204": "group",
    "Q41176": "facility", "Q134447": "facility", "Q12323": "facility", "Q1248784": "facility",
}
IDENTIFIER_PROPS = {"P5531": "sec_cik", "P249": "ticker", "P1278": "lei", "P946": "isin", "P2163": "fast",
                    "P297": "iso3166", "P298": "iso3166_3", "P856": "website", "P3500": "ringgold", "P6782": "ror",
                    "P2002": "twitter", "P10627": "web_archive", "P3125": "edrpou"}
LABEL_TO_KIND = {"person": {"person"}, "organization": {"company", "organization", "government", "group"},
                 "place": {"place", "facility"}, "facility": {"facility", "place"}, "product": {"product", "weapon"},
                 "group": {"group", "organization"}, "event": {"event"}, "law": {"law"}, "other": set(TYPE_MAP.values())}


def _get(params: dict) -> dict:
    key = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    cached = db.fetch_one("SELECT payload FROM kb.wikidata_cache WHERE cache_key = %s AND fetched_at > now() - interval '30 days'", (key,))
    if cached:
        return cached["payload"]
    params = {**params, "format": "json", "maxlag": 5}
    for attempt in range(3):
        resp = client().get(API, params=params, timeout=20.0)
        if resp.status_code == 200:
            data = resp.json()
            if "error" in data and data["error"].get("code") == "maxlag":
                time.sleep(5 * (attempt + 1))
                continue
            db.execute(
                """INSERT INTO kb.wikidata_cache (cache_key, payload) VALUES (%s, %s::jsonb)
                   ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()""",
                (key, db.jsonb(data)),
            )
            return data
        if resp.status_code in (429, 503):
            time.sleep(int(resp.headers.get("retry-after", "10")))
            continue
        break
    return {}


def search(name: str, lang: str = "uk", limit: int = 5) -> list[dict]:
    data = _get({"action": "wbsearchentities", "search": name[:200], "language": lang, "uselang": lang,
                 "type": "item", "limit": limit, "strictlanguage": "false"})
    return data.get("search", [])


def entities(qids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in range(0, len(qids), 40):
        chunk = qids[i:i + 40]
        data = _get({"action": "wbgetentities", "ids": "|".join(chunk), "props": "labels|aliases|descriptions|claims|sitelinks",
                     "languages": "|".join(LANGS)})
        out.update(data.get("entities", {}))
    return out


def _claim_values(entity: dict, prop: str) -> list:
    values = []
    for c in entity.get("claims", {}).get(prop, []):
        snak = c.get("mainsnak", {})
        dv = snak.get("datavalue", {}).get("value")
        if isinstance(dv, dict) and "id" in dv:
            values.append(dv["id"])
        elif dv is not None:
            values.append(dv)
    return values


def kind_of(entity: dict) -> str | None:
    for qid in _claim_values(entity, "P31"):
        if qid in TYPE_MAP:
            return TYPE_MAP[qid]
    return None


def summarize(entity: dict) -> dict:
    labels = {l: v["value"] for l, v in entity.get("labels", {}).items()}
    aliases = {l: [a["value"] for a in v] for l, v in entity.get("aliases", {}).items()}
    desc = entity.get("descriptions", {})
    identifiers = {}
    for prop, scheme in IDENTIFIER_PROPS.items():
        vals = _claim_values(entity, prop)
        if vals and isinstance(vals[0], (str, int)):
            identifiers[scheme] = str(vals[0])
    country = None
    iso = _claim_values(entity, "P297")
    if iso:
        country = str(iso[0])[:2]
    coord = None
    for c in _claim_values(entity, "P625"):
        if isinstance(c, dict) and c.get("latitude") is not None:
            coord = [round(float(c["latitude"]), 5), round(float(c["longitude"]), 5)]
            break
    return {
        "coord": coord,
        "qid": entity.get("id"),
        "kind": kind_of(entity),
        "labels": labels,
        "aliases": aliases,
        "description": (desc.get("en") or desc.get("uk") or {}).get("value"),
        "description_uk": (desc.get("uk") or {}).get("value"),
        "identifiers": identifiers,
        # Preserve observed P31 classes for data-derived encyclopedia grouping (no type dictionary here).
        "wikidata_classes": class_tags(_claim_values(entity, "P31")),
        "country_qids": _claim_values(entity, "P17")[:3],
        "sitelinks": len(entity.get("sitelinks", {})),
        "country": country,
    }


def resolve(name: str, label: str | None, lang: str = "uk") -> dict | None:
    """Best Wikidata match for a name seen in the news, or None if not confident.

    Confident = the label or an alias matches the name (after stemming) AND the type agrees with the NER label,
    preferring well-known items (many sitelinks), since news names refer to notable things.
    """
    from ..text.stem import term_key

    key = term_key(name)
    hits = search(name, lang) or (search(name, "en") if lang != "en" else [])
    if not hits:
        return None
    details = entities([h["id"] for h in hits[:5]])
    scored: list[tuple[float, dict]] = []
    for h in hits[:5]:
        ent = details.get(h["id"])
        if not ent:
            continue
        info = summarize(ent)
        names = list(info["labels"].values()) + [a for v in info["aliases"].values() for a in v]
        if key not in {term_key(n) for n in names}:
            continue
        if not info["kind"]:
            continue  # unknown type (a language, a concept, a profession): never auto-link
        if label and info["kind"] not in LABEL_TO_KIND.get(label, set()):
            continue
        scored.append((1.0 + min(2.0, info["sitelinks"] / 40), info))
    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    if len(scored) > 1 and scored[0][0] - scored[1][0] < 0.35:
        # "Washington" (state / D.C.), "Congress" (US / India): two plausible items, let context decide later
        return {"ambiguous": True, "options": [i["qid"] for _, i in scored[:4]]}
    return scored[0][1] if scored[0][0] >= 1.2 else None


def is_common_word(name: str) -> bool:
    """Single Latin words that are also ordinary English words ("Congress", "Justice", "Labour", "Guardian")."""
    if " " in name.strip() or not name.isascii():
        return False
    try:
        from wordfreq import zipf_frequency  # type: ignore
    except Exception:
        return False
    return zipf_frequency(name.lower(), "en") >= 3.6
