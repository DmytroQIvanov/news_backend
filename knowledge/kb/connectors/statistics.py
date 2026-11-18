"""Statistics adapters. Parsers are pure; HTTP and storage live in connectors.

World Bank catalog codes are ``indicator:ISO3`` because storage keys are unique
on (provider, code), rather than (provider, code, geo). The API receives only
the indicator. All missing observations retain their period and a None value.
"""
from __future__ import annotations

import csv
import io
import logging
import math
import os
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qsl

import yaml

from .base import (
    Connector, ConnectorSkipped, db, get, get_json, register,
    period_start, upsert_observations, upsert_series,
)

log = logging.getLogger(__name__)
CATALOG = Path(__file__).resolve().parents[1] / "resources" / "series.yaml"
Observation = tuple[str, float | None, str | None]
LICENSES = {
    "worldbank": "CC BY 4.0", "eurostat": "Eurostat reuse policy (CC BY 4.0)",
    "ecb": "ECB statistics reuse", "fred": "FRED terms of use",
    "eia": "public domain (US EIA)", "unhcr": "CC BY 4.0",
    "faostat": "CC BY 4.0", "nbu": "NBU open data",
}


def _period(raw: object) -> str:
    text = str(raw).strip()
    if re.fullmatch(r"\d{4}", text):
        date(int(text), 1, 1)
        return text
    match = re.fullmatch(r"(\d{4})-?Q([1-4])", text, re.I)
    if match:
        date(int(match[1]), 1, 1)
        return f"{match[1]}-Q{match[2]}"
    match = re.fullmatch(r"(\d{4})[-M](\d{2})", text, re.I)
    if match:
        return date(int(match[1]), int(match[2]), 1).isoformat()[:7]
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"Unsupported observation period: {text!r}")


def _number(raw: object) -> float | None:
    if raw is None or str(raw).strip() in {"", ".", "..", ":", "NA", "N/A"}:
        return None
    value = float(raw)
    return value if math.isfinite(value) else None


def _status(raw: object) -> str | None:
    if raw is None:
        return None
    return str(raw).strip() or None


def parse_worldbank(payload: list) -> list[Observation]:
    """World Bank v2: [pagination metadata, indicator observations]."""
    if not isinstance(payload, list) or len(payload) != 2:
        raise ValueError("Expected World Bank metadata and observations")
    return sorted(
        (_period(row["date"]), _number(row.get("value")), _status(row.get("obs_status")))
        for row in payload[1] or []
    )


def _cell(values: dict | list, index: int):
    if isinstance(values, list):
        return values[index] if index < len(values) else None
    return values.get(str(index), values.get(index))


def parse_eurostat(payload: dict) -> list[Observation]:
    """JSON-stat 2.0, with every non-time dimension filtered to one value.

    Reject unfiltered cubes: otherwise several different series could overwrite
    each other under the same observation period.
    """
    dimension = payload["dimension"]
    index = dimension["time"]["category"]["index"]
    times = dict(enumerate(index)) if isinstance(index, list) else {int(v): k for k, v in index.items()}
    ids = payload.get("id", list(dimension))
    sizes = payload.get("size", [len(dimension[k]["category"]["index"]) for k in ids])
    axis = ids.index("time")
    if any(size != 1 for i, size in enumerate(sizes) if i != axis):
        raise ValueError("Eurostat query must select one series")
    stride = math.prod(sizes[axis + 1:])
    values, statuses = payload.get("value", {}), payload.get("status", {})
    return sorted(
        (_period(label), _number(_cell(values, position * stride)),
         _status(_cell(statuses, position * stride)))
        for position, label in times.items()
    )


def parse_ecb(csv_text: str) -> list[Observation]:
    """ECB csvdata, including provisional/missing OBS_STATUS flags."""
    reader = csv.DictReader(io.StringIO(csv_text.lstrip("\ufeff")))
    if not {"TIME_PERIOD", "OBS_VALUE"}.issubset(reader.fieldnames or []):
        raise ValueError("Expected ECB TIME_PERIOD and OBS_VALUE columns")
    return sorted(
        (_period(row["TIME_PERIOD"]), _number(row["OBS_VALUE"]), _status(row.get("OBS_STATUS")))
        for row in reader
    )


def parse_fred(payload: dict) -> list[Observation]:
    """FRED values, including '.' for missing observations (no rescaling)."""
    return sorted(
        (_period(row["date"]), _number(row.get("value")), None)
        for row in payload["observations"]
    )


def parse_eia(payload: dict) -> list[Observation]:
    return sorted(
        (_period(row["period"]), _number(row.get("value")), None)
        for row in payload["response"]["data"]
    )


def parse_unhcr(payload: dict, value_field: str = "refugees") -> list[Observation]:
    """Sum destination rows by year, keeping an entirely missing year missing."""
    totals: dict[str, float | None] = {}
    for row in payload["items"]:
        period, value = _period(row["year"]), _number(row.get(value_field))
        totals.setdefault(period, None)
        if value is not None:
            totals[period] = (totals[period] or 0) + value
    return [(period, value, None) for period, value in sorted(totals.items())]


def parse_faostat(payload: dict) -> list[Observation]:
    return sorted(
        (_period(row["Year"]), _number(row.get("Value")), _status(row.get("Flag")))
        for row in payload["data"]
    )


def parse_nbu_exchange(payload: list) -> list[Observation]:
    return sorted(
        (_period(row["exchangedate"]), _number(row.get("rate")), None)
        for row in payload
    )


def parse_nbu_key_rate(payload: list) -> list[Observation]:
    """The endpoint mixes several NBU rates (policy, overnight ...): keep the policy rate, and only the days it changed
    plus the latest day (a daily copy of an unchanged rate is noise)."""
    rows = [r for r in payload if r.get("id_api") in (None, "KEY_PolicyRate")]
    series = sorted((_period(r.get("startdate") or r["dt"]), _number(r.get("value")), None) for r in rows)
    out: list[Observation] = []
    for obs in series:
        if not out or out[-1][1] != obs[1]:
            out.append(obs)
    if series and out[-1][0] != series[-1][0]:
        out.append(series[-1])
    return out


def _today() -> date:
    return date.today()


def _start(last: str | None, first_years: int = 2) -> str:
    """Revisit 60 days for revisions; first fetch covers two calendar years."""
    if last:
        return (period_start(_period(last)) - timedelta(days=60)).isoformat()
    today = _today()
    try:
        return today.replace(year=today.year - first_years).isoformat()
    except ValueError:  # February 29 in a non-leap target year
        return today.replace(year=today.year - first_years, day=28).isoformat()


def _source(provider: str, entry: dict) -> str:
    code = entry["code"]
    if provider == "worldbank":
        return f"https://api.worldbank.org/v2/country/{entry['geo']}/indicator/{code.split(':')[0]}"
    if provider == "eurostat":
        return "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/" + code
    if provider == "ecb":
        flow, key = code.split("/", 1)
        return f"https://data-api.ecb.europa.eu/service/data/{flow}/{key}"
    if provider == "fred":
        return f"https://fred.stlouisfed.org/series/{code}"
    if provider == "eia":
        return "https://api.eia.gov/v2/" + code.split("|")[0].strip("/")
    if provider == "unhcr":
        return "https://api.unhcr.org/population/v1/population/"
    if provider == "faostat":
        return "https://fenixservices.fao.org/faostat/api/v1/en/data/" + code
    endpoint = "exchange" if code.startswith("exchange:") else "key"
    return "https://bank.gov.ua/NBUStatService/v1/statdirectory/" + endpoint


class _Statistics(Connector):
    def run(self, cursor: dict) -> dict:
        if self.requires_env and not os.environ.get(self.requires_env):
            raise ConnectorSkipped(f"set {self.requires_env}")
        entries = yaml.safe_load(CATALOG.read_text(encoding="utf-8"))["series"]
        for entry in entries:
            if entry["provider"] != self.name:
                continue
            try:
                series_id = upsert_series(
                    self.name, entry["code"], entry["title"], entry["frequency"],
                    # The framework/schema use the three-character EMU aggregate.
                    # Keep EA20 membership explicit in catalog codes and titles.
                    unit=entry["unit"], geo="EMU" if entry["geo"] == "EA20" else entry["geo"],
                    title_uk=entry["title_uk"],
                    categories=entry["categories"], keywords=entry["keywords"],
                    source_url=_source(self.name, entry), license=LICENSES[self.name],
                )
                self.add("series")
                stored = db.fetch_one("SELECT last_period FROM kb.series WHERE id = %s", (series_id,))
                last = stored["last_period"] if stored else None
                rows = self.fetch(entry, series_id, last)
                # FRED dates the monthly/quarterly indices at the period's start.
                if self.name == "fred" and entry["frequency"] in {"A", "Q", "M"}:
                    frequency = entry["frequency"]
                    rows = [
                        (p[:4] if frequency == "A" else p[:7] if frequency == "M"
                         else f"{p[:4]}-Q{(int(p[5:7]) - 1) // 3 + 1}", v, s)
                        for p, v, s in rows
                    ]
                # The shared helper derives last_period from this batch only.
                # Filling an older gap must not move a series' latest value back.
                if last and rows and max(period_start(p) for p, _, _ in rows) < period_start(last):
                    latest = db.fetch_one(
                        "SELECT period, value, status FROM kb.observations WHERE series_id = %s AND period = %s",
                        (series_id, last),
                    )
                    if latest:
                        rows.append((latest["period"], latest["value"], latest["status"]))
                counts = upsert_observations(series_id, rows)
                self.add("new", counts["new"])
                self.add("revised", counts["revised"])
            except Exception as exc:  # isolate transport, parsing and database failures per series
                self.add("errors")
                # Never log request URLs: they may contain API keys. Status code and error type are enough.
                status = getattr(getattr(exc, "response", None), "status_code", None)
                log.warning("Statistics series failed: %s %s (%s%s)", self.name, entry["code"], type(exc).__name__,
                            f" HTTP {status}" if status else f": {str(exc).split('api_key')[0][:160]}")
        return cursor

    def fetch(self, entry: dict, series_id: int, last: str | None) -> list[Observation]:
        raise NotImplementedError


@register
class WorldBank(_Statistics):
    name = "worldbank"
    interval_s = 7 * 86400

    def fetch(self, entry, series_id, last):
        params = {"format": "json", "per_page": 100,
                  "date": f"{max(2010, int(last[:4]) - 2) if last else 2010}:{_today().year + 1}"}
        url = _source(self.name, entry)
        payload = get_json(url, params=params)
        rows = parse_worldbank(payload)
        for page in range(2, int(payload[0].get("pages", 1)) + 1):
            rows.extend(parse_worldbank(get_json(url, params={**params, "page": page})))
        return sorted(rows)


@register
class Eurostat(_Statistics):
    name = "eurostat"
    interval_s = 12 * 3600

    def fetch(self, entry, series_id, last):
        dataset, _, filters = entry["code"].partition("?")
        url = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/" + dataset
        params = {**dict(parse_qsl(filters)), "format": "JSON", "lang": "EN",
                  "sinceTimePeriod": _start(last)[:7] if last else "2015"}
        return parse_eurostat(get_json(url, params=params))


@register
class ECB(_Statistics):
    name = "ecb"
    interval_s = 6 * 3600

    def fetch(self, entry, series_id, last):
        return parse_ecb(get(_source(self.name, entry), params={
            "format": "csvdata", "startPeriod": _start(last),
        }).text)


@register
class FRED(_Statistics):
    name = "fred"
    interval_s = 12 * 3600
    requires_env = "FRED_API_KEY"

    def fetch(self, entry, series_id, last):
        return parse_fred(get_json("https://api.stlouisfed.org/fred/series/observations", params={
            "series_id": entry["code"], "api_key": os.environ[self.requires_env],
            "file_type": "json", "observation_start": _start(last),
        }))


@register
class EIA(_Statistics):
    name = "eia"
    interval_s = 12 * 3600
    requires_env = "EIA_API_KEY"

    def fetch(self, entry, series_id, last):
        _, series = entry["code"].split("|", 1)
        params = {"api_key": os.environ[self.requires_env], "frequency": "daily",
                  "data[0]": "value", "facets[series][]": series, "start": _start(last),
                  "sort[0][column]": "period", "sort[0][direction]": "asc", "length": 5000}
        rows = []
        offset = 0
        while True:
            payload = get_json(_source(self.name, entry), params={**params, "offset": offset})
            page = parse_eia(payload)
            rows.extend(page)
            offset += len(page)
            total = int(payload["response"].get("total", offset))
            if offset >= total:
                break
            if not page:
                raise ValueError("Incomplete EIA pagination")
        return sorted(rows)


@register
class UNHCR(_Statistics):
    name = "unhcr"
    interval_s = 7 * 86400

    def fetch(self, entry, series_id, last):
        filters = dict(part.split("=", 1) for part in entry["code"].split(":")[1:])
        params = {**filters, "limit": 100, "yearFrom": max(2014, int(last[:4]) - 2) if last else 2014,
                  "cf_type": "ISO"}
        items = []
        page = 1
        while True:
            payload = get_json(_source(self.name, entry), params={**params, "page": page})
            items.extend(payload["items"])
            if page >= int(payload.get("maxPages", 1)):
                break
            page += 1
        return parse_unhcr({"items": items})


@register
class FAOSTAT(_Statistics):
    name = "faostat"
    interval_s = 7 * 86400

    def fetch(self, entry, series_id, last):
        dataset, _, filters = entry["code"].partition("?")
        url = "https://fenixservices.fao.org/faostat/api/v1/en/data/" + dataset
        params = {**dict(parse_qsl(filters)), "show_flags": "true", "page_size": 1000}
        # Annual production revisions can affect older years; this is a small series.
        return parse_faostat(get_json(url, params=params))


@register
class NBU(_Statistics):
    name = "nbu"
    interval_s = 6 * 3600

    def run(self, cursor: dict) -> dict:
        self._exchange_requests = 0
        return super().run(cursor)

    def fetch(self, entry, series_id, last):
        if entry["code"] == "key_rate":
            return parse_nbu_key_rate(get_json(_source(self.name, entry), params={"json": ""}, timeout=180))
        # Check actual observations: last_period alone misses gaps and null values.
        today = _today()
        days = [today - timedelta(days=i) for i in range(10)]
        stored = db.fetch_all(
            "SELECT period FROM kb.observations WHERE series_id = %s AND period_start >= %s AND value IS NOT NULL",
            (series_id, days[-1]),
        )
        have = {row["period"] for row in stored}
        currency = entry["code"].split(":", 1)[1]
        rows = []
        for day in days:
            if day.isoformat() in have:
                continue
            if getattr(self, "_exchange_requests", 0) >= 10:
                break
            self._exchange_requests = getattr(self, "_exchange_requests", 0) + 1
            payload = get_json(_source(self.name, entry), params={
                "valcode": currency, "date": day.strftime("%Y%m%d"), "json": "",
            })
            rows.extend(parse_nbu_exchange(payload))
        return sorted(rows)
