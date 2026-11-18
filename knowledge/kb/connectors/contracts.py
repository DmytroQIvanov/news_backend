"""Public money: US federal awards (USAspending) and EU public tenders (TED).

Both are searched for the topics and companies our readers follow (KB_CONTRACT_KEYWORDS, default about Ukraine,
defence and energy) and for the companies in the news. Large awards become records linked to the recipient company
(created as a dataset entity when new) and to the buyer, so articles can say "the company holds a $X contract with Y".
"""
from __future__ import annotations

import logging
import os
from datetime import date, timedelta

from ..collect.http import client
from .base import Connector, ensure_entity, entity_by_name, link_record_entity, register, upsert_record

log = logging.getLogger(__name__)
KEYWORDS = [k.strip() for k in os.environ.get(
    "KB_CONTRACT_KEYWORDS", "Ukraine,drone,ammunition,air defense,artillery,energy security,demining").split(",") if k.strip()]
MIN_USD = float(os.environ.get("KB_CONTRACT_MIN_USD", "5000000"))


def _post(url: str, body: dict) -> dict:
    resp = client().post(url, json=body, timeout=90)
    resp.raise_for_status()
    return resp.json()


@register
class UsaSpending(Connector):
    name = "usaspending"
    interval_s = 24 * 3600

    def run(self, cursor: dict) -> dict:
        start = cursor.get("since") or (date.today() - timedelta(days=30)).isoformat()
        end = date.today().isoformat()
        for kw in KEYWORDS:
            body = {
                "filters": {"award_type_codes": ["A", "B", "C", "D"], "time_period": [{"start_date": start, "end_date": end}],
                            "keywords": [kw], "award_amounts": [{"lower_bound": MIN_USD}]},
                "fields": ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "Description",
                           "generated_internal_id"],
                "limit": 50, "page": 1, "sort": "Award Amount", "order": "desc",
            }
            try:
                data = _post("https://api.usaspending.gov/api/v2/search/spending_by_award/", body)
            except Exception as exc:  # noqa: BLE001
                self.add("errors")
                log.warning("USAspending %s: %s", kw, exc)
                continue
            for a in data.get("results", []):
                rid, inserted = upsert_record(
                    "usaspending", "contract_award", str(a.get("generated_internal_id") or a.get("Award ID")),
                    f"{a.get('Awarding Agency')} -> {a.get('Recipient Name')}: {(a.get('Description') or '')[:200]}",
                    happened_on=date.fromisoformat(a["Start Date"]) if a.get("Start Date") else None, geo="USA",
                    amount=a.get("Award Amount"), currency="USD",
                    data={"keyword": kw, **{k: a.get(k) for k in ("Award ID", "Recipient Name", "Awarding Agency", "Description")}},
                    url=f"https://www.usaspending.gov/award/{a.get('generated_internal_id')}" if a.get("generated_internal_id") else None,
                )
                if a.get("Recipient Name"):
                    link_record_entity(rid, ensure_entity(a["Recipient Name"].title(), "company", country="US"), "recipient")
                buyer = entity_by_name(a.get("Awarding Agency") or "", ["government", "organization"])
                link_record_entity(rid, buyer, "buyer")
                self.add("new" if inserted else "seen")
        cursor["since"] = (date.today() - timedelta(days=3)).isoformat()
        return cursor


@register
class TedTenders(Connector):
    name = "ted"
    interval_s = 24 * 3600

    def run(self, cursor: dict) -> dict:
        since = (cursor.get("since") or (date.today() - timedelta(days=14)).isoformat()).replace("-", "")
        for kw in KEYWORDS:
            body = {"query": f'FT~"{kw}" AND PD>={since}', "limit": 50,
                    "fields": ["publication-number", "notice-title", "buyer-name", "buyer-country", "publication-date",
                               "notice-type", "total-value", "total-value-cur"]}
            try:
                data = _post("https://api.ted.europa.eu/v3/notices/search", body)
            except Exception as exc:  # noqa: BLE001
                self.add("errors")
                log.warning("TED %s: %s", kw, exc)
                continue
            for n in data.get("notices", []):
                num = n.get("publication-number")
                if not num:
                    continue
                title = _first(n.get("notice-title")) or num
                buyer = _first(n.get("buyer-name"))
                country = _first(n.get("buyer-country"))
                value = n.get("total-value")
                pub = str(n.get("publication-date") or "")[:10]
                rid, inserted = upsert_record(
                    "ted", "tender", num, f"{buyer or 'EU buyer'}: {title}"[:900],
                    happened_on=date.fromisoformat(pub) if len(pub) == 10 else None, geo=country,
                    amount=float(value[0]) if isinstance(value, list) and value else (float(value) if isinstance(value, (int, float)) else None),
                    currency=_first(n.get("total-value-cur")), data={"keyword": kw, "notice_type": n.get("notice-type"), "buyer": buyer},
                    url=f"https://ted.europa.eu/en/notice/-/detail/{num}",
                )
                if buyer:
                    link_record_entity(rid, entity_by_name(buyer, ["government", "organization", "company"]), "buyer")
                self.add("new" if inserted else "seen")
        cursor["since"] = (date.today() - timedelta(days=2)).isoformat()
        return cursor


def _first(v):
    """TED returns multilingual fields as {lang: [values]} or plain lists; prefer English."""
    if isinstance(v, dict):
        for lang in ("eng", "ENG", "en"):
            if v.get(lang):
                return _first(v[lang])
        for vals in v.values():
            return _first(vals)
        return None
    if isinstance(v, list):
        return v[0] if v else None
    return v
