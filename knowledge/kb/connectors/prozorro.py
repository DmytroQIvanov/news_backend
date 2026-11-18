"""Prozorro: Ukrainian public procurement (open API, no key, CC BY 4.0 / open data law).

The tender feed (/api/2.5/tenders?offset=...) lists ~10k changes a day but only exposes the buyer in `opt_fields`
(value and suppliers need one request per tender). So the connector fetches details only where it matters:

  * tenders of buyers we follow: the EDRPOU codes of entities in our graph (kb.entity_identifiers scheme 'edrpou',
    from Wikidata P3125 or the ЄДР import) plus KB_PROZORRO_BUYERS (defaults: Ministry of Defence, Naftogaz,
    Ukrzaliznytsia, Ukrenergo, Energoatom; branches have their own codes, add them in the env);
  * tender IDs quoted in the news ("UA-2026-11-17-000056-a"), found in recent documents.

A tender becomes a record (provider 'prozorro', type 'tender') when its expected value is at least KB_PROZORRO_MIN_UAH
(default 20 million) or it was quoted in the news; buyer and winners are linked as entities (created as dataset
entities with the EDRPOU identifier when new), so articles can say "Company X won tenders of Y for Z UAH".
"""
from __future__ import annotations

import logging
import os
import re
import time
from datetime import date, datetime, timedelta, timezone

from .. import db
from .base import Connector, ensure_entity, get_json, link_record_entity, register, upsert_record

log = logging.getLogger(__name__)
API = "https://public-api.prozorro.gov.ua/api/2.5"
MIN_UAH = float(os.environ.get("KB_PROZORRO_MIN_UAH", "20000000"))
MAX_PAGES = int(os.environ.get("KB_PROZORRO_MAX_PAGES", "400"))
MAX_DETAILS = int(os.environ.get("KB_PROZORRO_MAX_DETAILS", "300"))
DEFAULT_BUYERS = {
    "00034022": "Міністерство оборони України",
    "20077720": "НАК «Нафтогаз України»",
    "40075815": "АТ «Укрзалізниця»",
    "00100227": "НЕК «Укренерго»",
    "24584661": "НАЕК «Енергоатом»",
}
TENDER_ID_RE = re.compile(r"\bUA-20\d\d-\d\d-\d\d-\d{6}-[a-z]\b")


def followed_buyers() -> set[str]:
    codes = set(DEFAULT_BUYERS)
    codes |= {c.strip() for c in os.environ.get("KB_PROZORRO_BUYERS", "").split(",") if c.strip()}
    rows = db.fetch_all("SELECT DISTINCT value FROM kb.entity_identifiers WHERE scheme = 'edrpou'")
    codes |= {r["value"] for r in rows}
    return codes


def tender_ids_in_news(days: int = 3) -> set[str]:
    rows = db.fetch_all(
        """SELECT body FROM kb.documents WHERE fetched_at > now() - make_interval(days => %s)
           AND body ~ 'UA-20[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{6}-[a-z]' LIMIT 500""",
        (days,),
    )
    found: set[str] = set()
    for r in rows:
        found |= set(TENDER_ID_RE.findall(r["body"] or ""))
    return found


def tender_amount(t: dict) -> float | None:
    v = t.get("value") or {}
    try:
        return float(v["amount"]) if v.get("amount") is not None else None
    except (TypeError, ValueError):
        return None


def winners(t: dict) -> list[dict]:
    """Suppliers of active awards (the winners), deduplicated by EDRPOU."""
    out: dict[str, dict] = {}
    for a in t.get("awards") or []:
        if a.get("status") != "active":
            continue
        for s in a.get("suppliers") or []:
            ident = s.get("identifier") or {}
            code = str(ident.get("id") or "")
            out[code or s.get("name", "")] = {"name": ident.get("legalName") or s.get("name") or "", "edrpou": code,
                                              "scheme": ident.get("scheme"), "amount": (a.get("value") or {}).get("amount")}
    return list(out.values())


def store_tender(t: dict, quoted: bool = False) -> tuple[int, bool] | None:
    amount = tender_amount(t)
    if not quoted and (amount is None or amount < MIN_UAH):
        return None
    buyer = t.get("procuringEntity") or {}
    bid = buyer.get("identifier") or {}
    buyer_name = bid.get("legalName") or buyer.get("name") or "Замовник"
    won = winners(t)
    title = f"{buyer_name}: {t.get('title') or t.get('tenderID')}"
    if won:
        title += " — " + ", ".join(w["name"] for w in won[:3])
    happened = (t.get("date") or t.get("dateModified") or "")[:10]
    rid, inserted = upsert_record(
        "prozorro", "tender", t.get("tenderID") or t["id"], title[:900],
        happened_on=date.fromisoformat(happened) if len(happened) == 10 else None, geo="UKR",
        amount=amount, currency=(t.get("value") or {}).get("currency") or "UAH",
        data={"status": t.get("status"), "category": t.get("mainProcurementCategory"), "method": t.get("procurementMethodType"),
              "cpv": ((t.get("items") or [{}])[0].get("classification") or {}).get("id"),
              "buyer": {"name": buyer_name, "edrpou": bid.get("id")}, "winners": won, "quoted_in_news": quoted},
        url=f"https://prozorro.gov.ua/tender/{t.get('tenderID')}",
    )
    if bid.get("id"):
        link_record_entity(rid, ensure_entity(buyer_name, "organization", {"edrpou": str(bid["id"])}, country="UA"), "buyer")
    for w in won:
        if w["edrpou"] and (w.get("scheme") or "UA-EDR") == "UA-EDR":
            link_record_entity(rid, ensure_entity(w["name"], "company", {"edrpou": w["edrpou"]}, country="UA"), "supplier")
    return rid, inserted


def search_tender(text: str) -> dict:
    """The public search of prozorro.gov.ua (POST JSON); used to resolve a tenderID quoted in the news."""
    from ..collect.http import _wait_for_host, client

    _wait_for_host("prozorro.gov.ua")
    resp = client().post("https://prozorro.gov.ua/api/search/tenders", json={"text": text}, timeout=60)
    resp.raise_for_status()
    return resp.json()


@register
class Prozorro(Connector):
    name = "prozorro"
    interval_s = 2 * 3600

    def run(self, cursor: dict) -> dict:
        buyers = followed_buyers()
        offset = cursor.get("offset") or str((datetime.now(timezone.utc) - timedelta(days=2)).timestamp())
        to_fetch: dict[str, bool] = {}
        for _ in range(MAX_PAGES):
            page = get_json(f"{API}/tenders", params={"offset": offset, "limit": 100,
                                                      "opt_fields": "procuringEntity,status,tenderID"}, timeout=60)
            items = page.get("data") or []
            self.add("scanned", len(items))
            for t in items:
                code = str(((t.get("procuringEntity") or {}).get("identifier") or {}).get("id") or "")
                if code in buyers and t.get("status") not in ("draft", "cancelled", "unsuccessful"):
                    to_fetch[t["id"]] = False
            nxt = (page.get("next_page") or {}).get("offset")
            if not items or not nxt or nxt == offset:
                break
            offset = nxt
            time.sleep(0.2)
        # tenders quoted in the news are fetched by their public ID through the search on the tenderID
        for tid in tender_ids_in_news():
            if not db.fetch_one("SELECT 1 FROM kb.records WHERE provider = 'prozorro' AND external_id = %s", (tid,)):
                to_fetch[tid] = True
        for n, (key, quoted) in enumerate(to_fetch.items()):
            if n >= MAX_DETAILS:
                self.add("deferred", len(to_fetch) - MAX_DETAILS)
                break
            try:
                if quoted:
                    found = search_tender(key)
                    hits = [h for h in (found.get("data") or []) if h.get("tenderID") == key]
                    if not hits:
                        continue
                    key = hits[0]["id"]
                t = get_json(f"{API}/tenders/{key}", timeout=60).get("data") or {}
                stored = store_tender(t, quoted=quoted)
                if stored:
                    self.add("new" if stored[1] else "updated")
                else:
                    self.add("below_threshold")
            except Exception as exc:  # noqa: BLE001
                self.add("errors")
                log.warning("Prozorro tender %s: %s", key, type(exc).__name__)
        cursor["offset"] = offset
        return cursor
