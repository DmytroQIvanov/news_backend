"""SEC EDGAR: primary-source corporate events of the companies we follow (8-K, 10-K, 10-Q, 6-K, 20-F, S-1, SC 13D).

1. company_tickers.json maps tickers/names to CIKs -> kb.entity_identifiers (sec_cik, ticker) for our company entities.
2. For followed companies (mentioned in the news), new filings since the last run become records, and their primary
   documents go to the NLP pipeline as kind 'filing' (source tier 'data'): the company's own statement confirms facts.
SEC asks for a descriptive User-Agent with contact (CONTACT_EMAIL) and <= 10 requests/s; we do far fewer.
"""
from __future__ import annotations

import logging
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from .. import db
from .base import Connector, add_document, get_json, link_record_entity, register, upsert_record
from .provenance import begin_series
from .sec_facts import cik_key, store_companyfacts

log = logging.getLogger(__name__)
FORMS = {"8-K", "10-K", "10-Q", "6-K", "20-F", "40-F", "S-1", "SC 13D", "424B4", "DEF 14A"}
TEXT_FORMS = FORMS - {"424B4", "DEF 14A"}
_SUFFIX = re.compile(r"[,.]|\b(inc|corp|corporation|co|ltd|plc|holdings?|group|the|company|incorporated|sa|nv|ag|se)\b", re.I)


def norm_company(name: str) -> str:
    return re.sub(r"\s+", " ", _SUFFIX.sub(" ", name.lower())).strip()


@register
class SecEdgar(Connector):
    name = "sec_edgar"
    interval_s = 3 * 3600

    def _map_ciks(self) -> None:
        data = get_json("https://www.sec.gov/files/company_tickers.json", timeout=120)
        by_name, by_ticker = defaultdict(list), defaultdict(list)
        for value in data.values():
            by_name[norm_company(value['title'])].append(value)
            by_ticker[value['ticker'].upper()].append(value)
        rows = db.fetch_all(
            """SELECT e.id, e.name, (SELECT value FROM kb.entity_identifiers i WHERE i.entity_id = e.id AND i.scheme = 'ticker' LIMIT 1) AS ticker
               FROM kb.entities e WHERE e.kind = 'company' AND e.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM kb.entity_identifiers i WHERE i.entity_id = e.id AND i.scheme = 'sec_cik')"""
        )
        for r in rows:
            hits = by_ticker.get((r["ticker"] or "").split(":")[-1].upper()) or by_name.get(norm_company(r["name"])) or []
            ciks = {cik_key(hit['cik_str']) for hit in hits}
            if len(ciks) == 1:
                db.execute("INSERT INTO kb.entity_identifiers (entity_id, scheme, value) VALUES (%s, 'sec_cik', %s) ON CONFLICT DO NOTHING",
                           (r["id"], str(int(next(iter(ciks))))))
                self.add("cik_mapped")

    def run(self, cursor: dict) -> dict:
        today = date.today().isoformat()
        if cursor.get("mapped_on") != today:
            self._map_ciks()
            cursor["mapped_on"] = today
        db.execute("""INSERT INTO kb.sec_company_state(entity_id,cik)
                      SELECT e.id,i.value FROM kb.entities e JOIN kb.entity_identifiers i ON i.entity_id=e.id AND i.scheme='sec_cik'
                      WHERE e.status='active' AND e.mention_count>0 ON CONFLICT(entity_id) DO UPDATE SET cik=EXCLUDED.cik""")
        companies = db.fetch_all("""SELECT e.id,e.name,s.cik,s.submissions_since FROM kb.sec_company_state s
                                    JOIN kb.entities e ON e.id=s.entity_id WHERE e.status='active' AND e.mention_count>0
                                    ORDER BY s.last_attempt_at NULLS FIRST,e.last_seen DESC NULLS LAST LIMIT 40""")
        for c in companies:
            cik = cik_key(c['cik'])
            since = (c.get('submissions_since') or (datetime.now(timezone.utc)-timedelta(days=730)).date()).isoformat()
            db.execute('UPDATE kb.sec_company_state SET last_attempt_at=now() WHERE entity_id=%s', (c['id'],))
            try:
                begin_series()
                sub = get_json(f"https://data.sec.gov/submissions/CIK{cik}.json")
                if sub.get('cik') is not None and cik_key(sub['cik']) != cik:
                    raise ValueError('Submissions CIK mismatch')
                self._store_filings(c, cik, sub.get('filings', {}).get('recent', {}), since, sub)
                for archive in sub.get('filings', {}).get('files', []):
                    if archive.get('filingTo', '') < since:
                        continue
                    name = archive.get('name', '')
                    if not re.fullmatch(r'CIK\d{10}-submissions-\d+\.json', name):
                        raise ValueError('Invalid SEC archive name')
                    self._store_filings(c, cik, get_json(f'https://data.sec.gov/submissions/{name}'), since, sub)
                acceptance = {r['external_id']: r['data']['accepted_at'] for r in db.fetch_all(
                    "SELECT external_id,data FROM kb.records WHERE provider='sec' AND data->>'cik'=%s AND data->>'accepted_at' IS NOT NULL", (cik,))}
                begin_series()
                facts = get_json(f'https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json', precise=True)
                self.add('financial_values', store_companyfacts(c['id'], facts, cik, acceptance))
                db.execute('UPDATE kb.sec_company_state SET submissions_since=%s,last_ok_at=now(),last_error=NULL WHERE entity_id=%s',
                           ((datetime.now(timezone.utc)-timedelta(days=2)).date(), c['id']))
            except Exception as exc:  # noqa: BLE001
                self.add("errors")
                db.execute('UPDATE kb.sec_company_state SET last_error=%s WHERE entity_id=%s', (type(exc).__name__, c['id']))
                log.warning("SEC company %s: %s", c['id'], type(exc).__name__)
                continue
        return cursor

    def _store_filings(self, c, cik, recent, since, sub):
        for i, form in enumerate(recent.get("form", [])):
            filed = recent["filingDate"][i]
            if form.removesuffix('/A') not in FORMS or filed < since:
                continue
            acc = recent["accessionNumber"][i]
            doc = recent["primaryDocument"][i]
            if not re.fullmatch(r'\d{10}-\d{2}-\d{6}', acc) or not re.fullmatch(r'[A-Za-z0-9_.-]+', doc):
                raise ValueError('Invalid SEC filing identifiers')
            url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}/{doc}"
            items = recent.get("items", [""] * len(recent["form"]))[i] if recent.get("items") else ""
            title = f"{sub.get('name', c['name'])}: SEC {form}{f' (items {items})' if items else ''} filed {filed}"
            accepted = recent.get('acceptanceDateTime') or []
            reports = recent.get('reportDate') or []
            rid, inserted = upsert_record("sec", "filing", acc, title, happened_on=date.fromisoformat(filed), geo="USA",
                                          data={"form": form, "items": items, "cik": cik, "report_date": reports[i] if i < len(reports) else None,
                                                "accepted_at": accepted[i] if i < len(accepted) else None},
                                          url=url)
            link_record_entity(rid, c["id"], "subject")
            if inserted:
                self.add("filings")
            if form.removesuffix('/A') in TEXT_FORMS:
                doc_id = add_document("data-sec-edgar", "filing", url, title,
                                      published_at=datetime.fromisoformat(filed).replace(tzinfo=timezone.utc),
                                      meta={"sec_form": form, "items": items, "record_id": rid})
                if doc_id:
                    db.execute("UPDATE kb.records SET document_id = %s WHERE id = %s", (doc_id, rid))
                    self.add("documents")
                else:
                    found = db.fetch_one('SELECT id FROM kb.documents WHERE url=%s LIMIT 1', (url,))
                    if found:
                        db.execute('UPDATE kb.records SET document_id=%s WHERE id=%s', (found['id'], rid))
