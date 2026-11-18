"""Nasdaq Trader symbol directories: ticker <-> listed company (NASDAQ and NYSE/other US exchanges).

Our company entities get identifiers ticker=<EXCHANGE>:<SYMBOL>, which connects news about a company with its SEC
filings and market data. Weekly.
"""
from __future__ import annotations

import csv
import io
import re

from .. import db
from .base import Connector, get, register
from .sec import norm_company

FILES = {
    "NASDAQ": "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt",
    "OTHER": "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt",
}
EXCHANGES = {"A": "NYSEAMERICAN", "N": "NYSE", "P": "NYSEARCA", "Z": "BATS", "V": "IEX"}
_SHARE = re.compile(r"\s+-\s+.*$|\b(common stock|class [a-z] (common stock|ordinary shares)|ordinary shares|american depositary shares.*)$", re.I)


def parse_symbols(text: str, kind: str) -> list[dict]:
    rows = []
    for r in csv.DictReader(io.StringIO(text), delimiter="|"):
        sym = r.get("Symbol") or r.get("ACT Symbol") or ""
        name = r.get("Security Name") or ""
        if not sym or sym.startswith("File Creation") or r.get("Test Issue") == "Y" or r.get("ETF") == "Y":
            continue
        exch = "NASDAQ" if kind == "NASDAQ" else EXCHANGES.get(r.get("Exchange", ""), "OTHER")
        rows.append({"symbol": sym, "exchange": exch, "company": _SHARE.sub("", name).strip()})
    return rows


@register
class NasdaqTrader(Connector):
    name = "nasdaq_trader"
    interval_s = 7 * 24 * 3600

    def run(self, cursor: dict) -> dict:
        by_name: dict[str, dict] = {}
        for kind, url in FILES.items():
            for row in parse_symbols(get(url).text, kind):
                by_name.setdefault(norm_company(row["company"]), row)
        self.add("symbols", len(by_name))
        for e in db.fetch_all("SELECT id, name FROM kb.entities WHERE kind = 'company' AND status = 'active'"):
            hit = by_name.get(norm_company(e["name"]))
            if hit:
                n = db.execute("INSERT INTO kb.entity_identifiers (entity_id, scheme, value) VALUES (%s, 'ticker', %s) ON CONFLICT DO NOTHING",
                               (e["id"], f"{hit['exchange']}:{hit['symbol']}"))
                self.add("mapped", n)
        return cursor
