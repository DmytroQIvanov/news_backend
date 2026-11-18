"""War and arms: ACLED conflict events and SIPRI arms transfers.

ACLED (account required: ACLED_EMAIL + ACLED_PASSWORD, OAuth token; respect ACLED's terms of use): geolocated political
violence events with actors, event type and fatalities for KB_ACLED_COUNTRIES (default Ukraine, Russia). Stored as
records with coordinates; the dossier uses them to compare a reported strike with the documented pattern in the same
oblast (counts, fatalities, trend). ACLED fatality figures are estimates and are labelled as such.

SIPRI Arms Transfers Database has no API: download the trade register CSV from
https://armstrade.sipri.org/armstrade/page/trade_register.php and run `python -m kb import-sipri <file.csv>`.
Values in SIPRI TIV are a volume indicator, not money — stored and shown as TIV.
"""
from __future__ import annotations

import csv
import io
import logging
import os
import re
from datetime import date, timedelta

from ..collect.http import client
from .base import Connector, country_entity, entity_by_name, link_record_entity, register, upsert_record

log = logging.getLogger(__name__)
ACLED_COUNTRIES = [c.strip() for c in os.environ.get("KB_ACLED_COUNTRIES", "Ukraine,Russia").split(",") if c.strip()]
ACLED_ISO = {"Ukraine": "UKR", "Russia": "RUS", "Belarus": "BLR", "Moldova": "MDA", "Poland": "POL", "Israel": "ISR",
             "Palestine": "PSE", "Lebanon": "LBN", "Syria": "SYR", "Iran": "IRN", "Sudan": "SDN"}


def _acled_token() -> str:
    resp = client().post("https://acleddata.com/oauth/token", data={
        "username": os.environ["ACLED_EMAIL"], "password": os.environ["ACLED_PASSWORD"],
        "grant_type": "password", "client_id": "acled"}, timeout=60)
    resp.raise_for_status()
    return resp.json()["access_token"]


def actor_entity(name: str | None) -> int | None:
    """'Military Forces of Russia (2000-)' -> Russia; 'Military Forces of Ukraine (2019-)' -> Ukraine; else by name."""
    if not name:
        return None
    m = re.match(r"(?:Military|Police) Forces of ([A-Za-z ]+?)\s*(?:\(|$)", name)
    if m:
        return country_entity(ACLED_ISO.get(m.group(1).strip())) or entity_by_name(m.group(1).strip(), ["place"])
    return entity_by_name(re.sub(r"\s*\(.*\)$", "", name), ["group", "organization", "government"])


@register
class Acled(Connector):
    name = "acled"
    interval_s = 24 * 3600
    requires_env = "ACLED_EMAIL"

    def run(self, cursor: dict) -> dict:
        if not os.environ.get("ACLED_PASSWORD"):
            from .base import ConnectorSkipped

            raise ConnectorSkipped("set ACLED_PASSWORD")
        token = _acled_token()
        since = cursor.get("since") or (date.today() - timedelta(days=60)).isoformat()
        for country in ACLED_COUNTRIES:
            page = 1
            while page <= 20:
                resp = client().get("https://acleddata.com/api/acled/read", headers={"Authorization": f"Bearer {token}"}, params={
                    "country": country, "event_date": f"{since}|{date.today().isoformat()}", "event_date_where": "BETWEEN",
                    "limit": 5000, "page": page, "_format": "json"}, timeout=180)
                resp.raise_for_status()
                rows = resp.json().get("data", [])
                for e in rows:
                    fat = int(e.get("fatalities") or 0)
                    rid, inserted = upsert_record(
                        "acled", "conflict_event", str(e.get("event_id_cnty")), f"{e.get('event_type')}: {e.get('sub_event_type')} — {e.get('location')}, {e.get('admin1')}",
                        happened_on=date.fromisoformat(e["event_date"]), geo=ACLED_ISO.get(country), location=f"{e.get('location')}, {e.get('admin1')}",
                        latitude=float(e["latitude"]) if e.get("latitude") else None, longitude=float(e["longitude"]) if e.get("longitude") else None,
                        amount=fat, currency="fatalities",
                        data={k: e.get(k) for k in ("event_type", "sub_event_type", "actor1", "actor2", "admin1", "admin2", "notes", "source",
                                                     "fatalities", "civilian_targeting", "disorder_type")},
                    )
                    link_record_entity(rid, actor_entity(e.get("actor1")), "actor1")
                    link_record_entity(rid, actor_entity(e.get("actor2")), "actor2")
                    self.add("new" if inserted else "seen")
                if len(rows) < 5000:
                    break
                page += 1
        cursor["since"] = (date.today() - timedelta(days=14)).isoformat()  # ACLED revises recent weeks
        return cursor


def import_sipri(path: str) -> dict:
    """SIPRI trade register CSV -> arms_transfer records (supplier, recipient, weapon, years, numbers, TIV)."""
    from ..connectors.base import ensure_entity

    raw = open(path, encoding="utf-8-sig", errors="replace").read()
    lines = raw.splitlines()
    start = next((i for i, l in enumerate(lines) if l.lower().startswith(("recipient", "\"recipient", "supplier", "\"supplier"))), 0)
    reader = csv.reader(io.StringIO("\n".join(lines[start:])))
    header = [h.strip().lower() for h in next(reader)]

    def col(*names: str) -> int | None:
        for n in names:
            for i, h in enumerate(header):
                if h.startswith(n):
                    return i
        return None

    ix = {k: col(*v) for k, v in {
        "recipient": ("recipient",), "supplier": ("supplier",), "order_year": ("year of order",), "ordered": ("number ordered",),
        "designation": ("weapon designation",), "description": ("weapon description",), "delivered": ("number delivered",),
        "delivery_years": ("year(s) of deliver", "years of deliver"), "status": ("status",), "comments": ("comments",),
        "tiv_total": ("sipri tiv for total", "tiv for total"), "tiv_delivered": ("sipri tiv of delivered", "tiv delivered"),
    }.items()}
    stats = {"rows": 0, "records": 0}
    for row in reader:
        def g(k: str) -> str:
            i = ix.get(k)
            return row[i].strip() if i is not None and i < len(row) else ""

        if not g("supplier") or not g("recipient"):
            continue
        stats["rows"] += 1
        oy = re.sub(r"\D", "", g("order_year"))[:4]
        ext = f"{g('supplier')}|{g('recipient')}|{oy}|{g('designation')}|{g('ordered')}"
        tiv = g("tiv_total").replace(",", "")
        rid, _ = upsert_record(
            "sipri", "arms_transfer", ext, f"{g('supplier')} -> {g('recipient')}: {g('ordered')} {g('designation')} ({g('description')})",
            happened_on=date(int(oy), 1, 1) if oy else None, amount=float(tiv) if re.fullmatch(r"[\d.]+", tiv or "") else None,
            currency="SIPRI TIV", data={k: g(k) for k in ix}, url="https://armstrade.sipri.org/",
        )
        sup = entity_by_name(g("supplier"), ["place", "group", "organization"])
        rec = entity_by_name(g("recipient"), ["place", "group", "organization"])
        link_record_entity(rid, sup, "supplier")
        link_record_entity(rid, rec, "recipient")
        weapon = entity_by_name(g("designation"), ["weapon", "product"])
        if weapon is None and g("designation"):
            weapon = ensure_entity(g("designation"), "weapon")
        link_record_entity(rid, weapon, "weapon")
        stats["records"] += 1
    return stats
