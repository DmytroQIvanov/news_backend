"""EU financial sanctions (consolidated list, Financial Sanctions Files): who is sanctioned, under which programme, when.

Every listed person/entity becomes (or is linked to) a kb entity with identifier eu_fsf=<logical id>; the listing is a
record and a confirmed fact "European Union -> sanction -> X" dated by the designation. Delistings close the fact
(valid_to) instead of deleting history. Daily.
"""
from __future__ import annotations

import csv
import hashlib
import io
import logging
import os
import re
from datetime import date

from .. import db
from .base import Connector, add_fact, ensure_entity, entity_by_name, get, link_record_entity, register, upsert_record

log = logging.getLogger(__name__)

FSF_URL = os.environ.get(
    "KB_EU_FSF_URL", "https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw"
)
PROGRAMMES_UK = {
    "UKR": "територіальна цілісність України", "RUSDA": "дестабілізуючі дії Росії", "RUS": "Росія (секторальні)",
    "BLR": "Білорусь", "IRN": "Іран", "PRK": "КНДР", "SYR": "Сирія", "HR": "права людини", "CYB": "кібератаки",
}
_LATIN = re.compile(r"^[A-Za-z0-9 .,'()\-&/]+$")


def _d(v: str) -> date | None:
    try:
        return date.fromisoformat(v[:10]) if v else None
    except ValueError:
        return None


def parse_fsf(text: str) -> dict[str, dict]:
    """Rows (one per name/address/...) grouped into listings by Entity_LogicalId."""
    out: dict[str, dict] = {}
    for row in csv.DictReader(io.StringIO(text), delimiter=";"):
        lid = row.get("Entity_LogicalId") or ""
        if not lid:
            continue
        e = out.setdefault(lid, {
            "id": lid, "type": row.get("Entity_SubjectType"), "programmes": set(), "names": [], "countries": set(),
            "designated": _d(row.get("Entity_DesignationDate", "")), "regulations": {}, "remark": row.get("Entity_Remark") or "",
            "eu_ref": row.get("Entity_EU_ReferenceNumber") or "",
        })
        if row.get("Entity_Regulation_Programme"):
            e["programmes"].add(row["Entity_Regulation_Programme"])
        pub = _d(row.get("Entity_Regulation_PublicationDate", ""))
        if row.get("Entity_Regulation_NumberTitle"):
            e["regulations"][row["Entity_Regulation_NumberTitle"]] = {"date": str(pub) if pub else None, "url": row.get("Entity_Regulation_PublicationUrl")}
        name = (row.get("NameAlias_WholeName") or "").strip()
        if name and name not in e["names"]:
            e["names"].append(name)
        if row.get("Address_CountryIso2Code"):
            e["countries"].add(row["Address_CountryIso2Code"])
        if e["designated"] is None and pub:
            e["designated"] = pub
    return out


@register
class EuSanctions(Connector):
    name = "eu_sanctions"
    interval_s = 24 * 3600

    def run(self, cursor: dict) -> dict:
        resp = get(FSF_URL, timeout=180)
        listings = parse_fsf(resp.content.decode("utf-8-sig", errors="replace"))
        self.add("listings", len(listings))
        eu = entity_by_name("European Union", ["organization", "government"]) or ensure_entity("European Union", "organization")
        seen_hashes: dict[str, str] = cursor.get("hashes", {})
        new_hashes: dict[str, str] = {}
        for lid, e in listings.items():
            payload = {
                "names": e["names"][:20], "programmes": sorted(e["programmes"]), "countries": sorted(e["countries"]),
                "designated": str(e["designated"]) if e["designated"] else None, "regulations": e["regulations"],
                "remark": e["remark"][:1000], "eu_ref": e["eu_ref"],
            }
            h = hashlib.sha1(db.jsonb(payload).encode()).hexdigest()[:16]
            new_hashes[lid] = h
            if seen_hashes.get(lid) == h:
                continue
            latin = [n for n in e["names"] if _LATIN.match(n)] or e["names"]
            if not latin:
                continue
            kind = "person" if e["type"] == "P" else "organization"
            entity_id = ensure_entity(latin[0], kind, {"eu_fsf": lid})
            with db.tx() as conn:
                from ..entities import add_alias

                for alias in e["names"][:12]:
                    add_alias(conn, entity_id, alias, None, "dataset")
            regs = sorted(e["regulations"].items(), key=lambda kv: kv[1]["date"] or "")
            url = regs[-1][1]["url"] if regs else None
            title = f"EU sanctions: {latin[0]} ({', '.join(PROGRAMMES_UK.get(p, p) for p in sorted(e['programmes']))})"
            rid, inserted = upsert_record("eu_sanctions", "sanction_listing", lid, title, happened_on=e["designated"],
                                          geo=next(iter(e["countries"]), None), data=payload, url=url)
            link_record_entity(rid, entity_id, "target")
            link_record_entity(rid, eu, "subject")
            add_fact(eu, "sanction", entity_id, valid_from=e["designated"])
            self.add("new" if inserted else "changed")
        removed = [lid for lid in seen_hashes if lid not in new_hashes]
        for lid in removed:
            # delisted: keep the history, close the fact
            db.execute(
                """UPDATE kb.facts SET valid_to = current_date, status = 'superseded'
                   WHERE predicate = 'sanction' AND subject_entity_id = %s
                     AND object_entity_id = (SELECT entity_id FROM kb.entity_identifiers WHERE scheme = 'eu_fsf' AND value = %s)""",
                (eu, lid),
            )
            db.execute("UPDATE kb.records SET data = data || '{\"delisted\": true}'::jsonb, updated_at = now() WHERE provider = 'eu_sanctions' AND external_id = %s", (lid,))
        self.add("delisted", len(removed))
        return {"hashes": new_hashes}
