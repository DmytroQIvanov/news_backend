"""SDMX statistics: OECD (CC BY 4.0) and the State Statistics Service of Ukraine (Держстат, open data CC BY 4.0).

Series are listed in resources/series_sdmx.yaml with provider 'oecd' or 'ukrstat' and code "<dataflow>|<key>", e.g.
  oecd     "OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M,1.0|DEU.UNE_LF_M...Y._T.Y_GE15..M"
  ukrstat  "DF_PRICE_CHANGE_CONSUMER_GOODS_SERVICE,27.2.0|INDEX_CONSUMPRICE.CORMONTH_PREV_YEAR.UA00000000000000000.0.M"
Both answer SDMX-CSV; one parser serves both.

An entry may list several countries: `geos: [USA, DEU, POL]` with "{geo}" in the key. Then one request fetches all of
them ("USA+DEU+POL") and the rows are split by REF_AREA into one series per country (code with the country filled in,
"{name}" in the titles replaced by the country name), which saves requests on the rate-limited OECD API.
Держстат rejects wildcard keys (403), so its keys are always complete.
"""
from __future__ import annotations

import csv
import io
import logging
import re
from datetime import date
from pathlib import Path

import yaml

from .base import Connector, get, register, upsert_observations, upsert_series

log = logging.getLogger(__name__)
CATALOG = Path(__file__).resolve().parents[1] / "resources" / "series_sdmx.yaml"
ENDPOINTS = {
    "oecd": ("https://sdmx.oecd.org/public/rest/data/{flow}/{key}", "OECD", "CC BY 4.0"),
    "ukrstat": ("https://stat.gov.ua/sdmx/workspaces/default:integration/registry/sdmx/2.1/data/SSSU,{flow}/{key}", "Держстат", "CC BY 4.0"),
}
_PERIOD = re.compile(r"^(\d{4})(?:-?(M|Q)?(\d{1,2}))?(?:-(\d{2}))?$")
AGGREGATES = {"OECD", "G20", "G7", "EA20", "EU27_2020", "OECDE"}
_UK_NAMES = {"USA": "США", "DEU": "Німеччина", "FRA": "Франція", "GBR": "Велика Британія", "POL": "Польща", "ITA": "Італія",
             "JPN": "Японія", "CHN": "Китай", "TUR": "Туреччина", "CAN": "Канада", "OECD": "ОЕСР", "G20": "G20",
             "EA20": "єврозона", "UKR": "Україна", "KOR": "Південна Корея", "IND": "Індія", "ESP": "Іспанія"}


def norm_period(p: str) -> str:
    """'2026-M08' / '2026-08' -> '2026-08'; '2026-Q2' -> '2026-Q2'; '2025' -> '2025'."""
    p = p.strip()
    m = _PERIOD.match(p)
    if not m:
        return p
    y, kind, n, d = m.groups()
    if n is None:
        return y
    if kind == "Q":
        return f"{y}-Q{int(n)}"
    if d:
        return f"{y}-{int(n):02d}-{d}"
    return f"{y}-{int(n):02d}"


def parse_sdmx_csv(text: str, area: str | None = None) -> list[tuple[str, float | None, str | None]]:
    """Rows (period, value, status); with `area` only the rows of that REF_AREA."""
    out: dict[str, tuple[str, float | None, str | None]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        if area and row.get("REF_AREA") not in (None, area):
            continue
        period = row.get("TIME_PERIOD") or ""
        raw = (row.get("OBS_VALUE") or "").strip()
        if not period:
            continue
        try:
            value = float(raw) if raw not in ("", "NaN") else None
        except ValueError:
            value = None
        p = norm_period(period)
        out[p] = (p, value, (row.get("OBS_STATUS") or row.get("OBS_FLAG") or None) or None)
    return sorted(out.values())


def country_name(geo: str | None, lang: str = "en") -> str:
    if not geo:
        return ""
    if lang == "uk":
        return _UK_NAMES.get(geo, geo)
    if geo in AGGREGATES:
        return {"OECD": "OECD total", "EA20": "euro area"}.get(geo, geo)
    try:
        import pycountry  # type: ignore

        c = pycountry.countries.get(alpha_3=geo)
        return (getattr(c, "common_name", None) or c.name) if c else geo
    except Exception:  # noqa: BLE001
        return geo


class SdmxConnector(Connector):
    provider = ""

    def run(self, cursor: dict) -> dict:
        catalog = yaml.safe_load(CATALOG.read_text(encoding="utf-8"))
        url_tpl, label, license_ = ENDPOINTS[self.provider]
        start = str(date.today().year - 3)
        for entry in [s for s in catalog.get("series", []) if s.get("provider") == self.provider]:
            flow, key = entry["code"].split("|", 1)
            multi = "{geo}" in key
            geos = entry.get("geos") or [entry.get("geo")]
            try:
                resp = get(url_tpl.format(flow=flow, key=key.replace("{geo}", "+".join(g for g in geos if g))),
                           params={"startPeriod": start, "dimensionAtObservation": "AllDimensions"},
                           headers={"Accept": "application/vnd.sdmx.data+csv;version=1.0.0"}, timeout=180)
            except Exception as exc:  # noqa: BLE001
                self.add("errors")
                status = getattr(getattr(exc, "response", None), "status_code", None)
                log.warning("%s series failed: %s (%s %s)", label, entry["code"], type(exc).__name__, status or "")
                continue
            for geo in geos:
                rows = parse_sdmx_csv(resp.text, area=geo if multi else None)
                if not rows:
                    self.add("empty")
                    continue
                name = country_name(geo)
                sid = upsert_series(
                    self.provider, f"{flow}|{key.replace('{geo}', geo or '')}", entry["title"].replace("{name}", name),
                    entry["frequency"], unit=entry.get("unit"), geo=geo if geo and geo not in AGGREGATES else None,
                    title_uk=(entry.get("title_uk") or "").replace("{name}", country_name(geo, "uk")) or None,
                    categories=entry.get("categories"), keywords=[*(entry.get("keywords") or []), *([name] if name else [])],
                    source_url=entry.get("source_url") or url_tpl.split("/data")[0], license=license_)
                counts = upsert_observations(sid, rows)
                self.add("series")
                self.add("new", counts["new"])
                self.add("revised", counts["revised"])
        return cursor


@register
class Oecd(SdmxConnector):
    name = "oecd"
    provider = "oecd"
    interval_s = 24 * 3600


@register
class UkrStat(SdmxConnector):
    name = "ukrstat"
    provider = "ukrstat"
    interval_s = 12 * 3600
