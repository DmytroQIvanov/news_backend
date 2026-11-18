"""Ukrainian registries and satellite fires: NASA FIRMS, Verkhovna Rada bills, ЄДР (legal entities), court decisions.

  firms   NASA FIRMS VIIRS/MODIS hot spots over Ukraine and western Russia (NASA_FIRMS_MAP_KEY, free key). Stored in
          kb.fire_detections; the dossier shows fires near the places of an event (refinery, depot, port strikes).
          Place coordinates come from Wikidata P625 (filled here for places/facilities that lack them).
  rada    bills of the current convocation from data.rada.gov.ua open data (CSV). The portal blocks some foreign
          networks, so the URL is configurable (KB_RADA_BILLS_URL) and failures only back off.
  edr     ЄДР legal entities (data.gov.ua, weekly XML dump, ~3 GB unpacked). Heavy, so opt-in: KB_EDR_ENABLED=1.
          Streams the XML into kb.ua_companies and adds 'edrpou' identifiers to graph entities with the same name.
  courts  Court decisions registry (ЄДРСР) yearly dump: metadata of criminal / administrative-offence decisions of the
          last KB_COURT_DAYS days into kb.court_documents; decisions whose case number is quoted in the news get their
          text fetched as documents. Opt-in: KB_COURTS_ENABLED=1.
"""
from __future__ import annotations

import csv
import io
import logging
import os
import re
import tempfile
import zipfile
from datetime import date, datetime, timedelta, timezone
from xml.etree.ElementTree import iterparse

from .. import db
from ..text.stem import term_key
from .base import Connector, add_document, ensure_entity, get, get_json, link_record_entity, register, upsert_record

log = logging.getLogger(__name__)


# ------------------------------------------------------------------------------------------------------- FIRMS --

FIRMS_SOURCES = [s.strip() for s in os.environ.get("KB_FIRMS_SOURCES", "VIIRS_SNPP_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT").split(",") if s.strip()]
FIRMS_BBOX = os.environ.get("KB_FIRMS_BBOX", "22,44,50,57")  # west,south,east,north: Ukraine + western Russia + Belarus


def parse_firms_csv(text: str, source: str) -> list[tuple]:
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        try:
            t = (r.get("acq_time") or "0").zfill(4)
            at = datetime.strptime(f"{r['acq_date']} {t}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
            frp = float(r["frp"]) if r.get("frp") else None
            out.append((source, at, float(r["latitude"]), float(r["longitude"]), frp, (r.get("confidence") or "")[:8],
                        (r.get("daynight") or "")[:1] or None))
        except (KeyError, ValueError):
            continue
    return out


def fill_place_coords(limit: int = 100) -> int:
    """Wikidata P625 for places/facilities that have a QID but no coordinates yet."""
    from ..enrich import wikidata

    rows = db.fetch_all(
        """SELECT id, wikidata_id FROM kb.entities WHERE kind IN ('place', 'facility') AND wikidata_id IS NOT NULL
           AND status = 'active' AND NOT (attributes ? 'coord') AND NOT (attributes ? 'coord_checked')
           ORDER BY mention_count DESC LIMIT %s""", (limit,))
    done = 0
    for i in range(0, len(rows), 50):
        chunk = rows[i:i + 50]
        try:
            ents = wikidata.entities([r["wikidata_id"] for r in chunk])
        except Exception as exc:  # noqa: BLE001
            log.warning("wikidata coords: %s", type(exc).__name__)
            break
        for r in chunk:
            coord = wikidata.summarize(ents[r["wikidata_id"]]).get("coord") if r["wikidata_id"] in ents else None
            patch = {"coord": coord} if coord else {"coord_checked": date.today().isoformat()}
            db.execute("UPDATE kb.entities SET attributes = attributes || %s::jsonb WHERE id = %s", (db.jsonb(patch), r["id"]))
            done += bool(coord)
    return done


@register
class Firms(Connector):
    name = "firms"
    interval_s = 3 * 3600
    requires_env = "NASA_FIRMS_MAP_KEY"

    def run(self, cursor: dict) -> dict:
        key = os.environ["NASA_FIRMS_MAP_KEY"].strip()
        for src in FIRMS_SOURCES:
            try:
                # the key is part of the path: never log the URL
                resp = get(f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{src}/{FIRMS_BBOX}/2", timeout=120)
            except Exception as exc:  # noqa: BLE001
                self.add("errors")
                log.warning("FIRMS %s failed: %s %s", src, type(exc).__name__, getattr(getattr(exc, "response", None), "status_code", ""))
                continue
            rows = parse_firms_csv(resp.text, src)
            with db.tx() as conn:
                for r in rows:
                    cur = conn.execute(
                        """INSERT INTO kb.fire_detections (source, detected_at, latitude, longitude, frp, confidence, daynight)
                           VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""", r)
                    self.add("new", cur.rowcount or 0)
            self.add("rows", len(rows))
        db.execute("DELETE FROM kb.fire_detections WHERE detected_at < now() - interval '400 days'")
        self.add("coords", fill_place_coords())
        return cursor


# -------------------------------------------------------------------------------------------------------- Rada --

RADA_BILLS_URL = os.environ.get("KB_RADA_BILLS_URL", "https://data.rada.gov.ua/ogd/zpr/skl9/bills_main-skl9.csv")


def _col(row: dict, *names: str) -> str:
    low = {k.lower().strip(): v for k, v in row.items() if k}
    for n in names:
        if low.get(n):
            return str(low[n]).strip()
    return ""


@register
class Rada(Connector):
    name = "rada"
    interval_s = 12 * 3600

    def run(self, cursor: dict) -> dict:
        resp = get(RADA_BILLS_URL, timeout=180)
        text = resp.content.decode("utf-8-sig", errors="replace")
        if text.count(";") > text.count(","):
            reader = csv.DictReader(io.StringIO(text), delimiter=";")
        else:
            reader = csv.DictReader(io.StringIO(text))
        since = cursor.get("since") or (date.today() - timedelta(days=60)).isoformat()
        for row in reader:
            number = _col(row, "number", "bill_number", "num")
            title = _col(row, "title", "name")
            reg = _col(row, "registrationdate", "registration_date", "date_registration", "date")[:10]
            if not number or not title or (reg and reg < since):
                continue
            rid, inserted = upsert_record(
                "rada", "bill", number, f"Законопроєкт №{number}: {title}"[:900],
                happened_on=date.fromisoformat(reg) if len(reg) == 10 else None, geo="UKR",
                data={"status": _col(row, "currentphase_title", "status", "phase"), "initiators": _col(row, "initiators", "authors"),
                      "committee": _col(row, "mainexecutives", "committee"), "type": _col(row, "type")},
                url=f"https://itd.rada.gov.ua/billInfo/Bills/Card/{_col(row, 'bill_id', 'id')}" if _col(row, "bill_id", "id") else None,
            )
            link_record_entity(rid, ensure_entity("Верховна Рада України", "government", country="UA"), "subject")
            self.add("new" if inserted else "seen")
        cursor["since"] = (date.today() - timedelta(days=7)).isoformat()
        return cursor


# --------------------------------------------------------------------------------------------------------- ЄДР --

EDR_PACKAGE = os.environ.get("KB_EDR_PACKAGE", "03cc1239-3988-4451-aa0d-aadb77448714")


def _resource_url(package: str, want: str) -> str:
    data = get_json("https://data.gov.ua/api/3/action/package_show", params={"id": package}, timeout=60)
    res = [r for r in data["result"]["resources"] if (r.get("name") or "").lower().startswith(want.lower())]
    if not res:
        res = sorted(data["result"]["resources"], key=lambda r: r.get("last_modified") or "", reverse=True)
    return res[0]["url"]


def _download(url: str) -> str:
    from ..collect.http import client

    fd, path = tempfile.mkstemp(suffix=".zip")
    with os.fdopen(fd, "wb") as fh, client().stream("GET", url, timeout=3600) as resp:
        resp.raise_for_status()
        for chunk in resp.iter_bytes(1 << 20):
            fh.write(chunk)
    return path


def _texts(el, tag: str) -> list[str]:
    return [(x.text or "").strip() for x in el.iter(tag) if (x.text or "").strip()]


def parse_edr_subject(el) -> dict | None:
    def one(tag: str) -> str:
        x = el.find(tag)
        return (x.text or "").strip() if x is not None and x.text else ""

    code = one("EDRPOU")
    if not code:
        return None
    stan = one("STAN")
    cap = re.sub(r"[^\d.]", "", one("AUTHORIZED_CAPITAL").replace(",", "."))
    return {"edrpou": code[:10], "name": one("NAME") or one("SHORT_NAME"), "short_name": one("SHORT_NAME") or None,
            "legal_form": one("OPF") or None, "status": stan or None, "founders": _texts(el, "FOUNDER")[:30],
            "beneficiaries": _texts(el, "BENEFICIARY")[:30], "signers": _texts(el, "SIGNER")[:10],
            "capital": float(cap) if cap and cap.count(".") <= 1 else None,
            "terminated": "припинен" in stan.lower()}


@register
class Edr(Connector):
    name = "edr"
    interval_s = 7 * 24 * 3600
    requires_env = "KB_EDR_ENABLED"

    def run(self, cursor: dict) -> dict:
        path = _download(_resource_url(EDR_PACKAGE, "UO"))
        try:
            with zipfile.ZipFile(path) as zf:
                member = next(n for n in zf.namelist() if "UO" in n.upper() and n.lower().endswith(".xml"))
                batch: list[dict] = []
                with zf.open(member) as fh:
                    for _, el in iterparse(fh, events=("end",)):
                        if el.tag != "SUBJECT":
                            continue
                        rec = parse_edr_subject(el)
                        el.clear()
                        if rec and rec["name"]:
                            batch.append(rec)
                        if len(batch) >= 2000:
                            self._flush(batch)
                            batch = []
                if batch:
                    self._flush(batch)
        finally:
            os.unlink(path)
        # graph companies without a code: exact name match against the register
        linked = db.fetch_all(
            """INSERT INTO kb.entity_identifiers (entity_id, scheme, value)
               SELECT DISTINCT ON (e.id) e.id, 'edrpou', c.edrpou FROM kb.entities e
               JOIN kb.entity_aliases a ON a.entity_id = e.id
               JOIN kb.ua_companies c ON c.name_key = a.alias_key AND NOT c.terminated
               WHERE e.kind IN ('company', 'organization', 'government') AND e.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM kb.entity_identifiers i WHERE i.entity_id = e.id AND i.scheme = 'edrpou')
               ON CONFLICT DO NOTHING RETURNING entity_id""")
        self.add("linked", len(linked))
        return cursor

    def _flush(self, batch: list[dict]) -> None:
        with db.tx() as conn:
            for r in batch:
                conn.execute(
                    """INSERT INTO kb.ua_companies (edrpou, name, short_name, legal_form, status, founders, beneficiaries, signers,
                                                    capital, terminated, name_key, updated_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                       ON CONFLICT (edrpou) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name,
                         legal_form = EXCLUDED.legal_form, status = EXCLUDED.status, founders = EXCLUDED.founders,
                         beneficiaries = EXCLUDED.beneficiaries, signers = EXCLUDED.signers, capital = EXCLUDED.capital,
                         terminated = EXCLUDED.terminated, name_key = EXCLUDED.name_key, updated_at = now()""",
                    (r["edrpou"], r["name"][:1000], r["short_name"], r["legal_form"], r["status"], r["founders"], r["beneficiaries"],
                     r["signers"], r["capital"], r["terminated"], term_key(r["short_name"] or r["name"])))
        self.add("companies", len(batch))


# ------------------------------------------------------------------------------------------------------ courts --

COURT_DAYS = int(os.environ.get("KB_COURT_DAYS", "14"))
COURT_KINDS = {"2": "кримінальне", "5": "адмінправопорушення"}
CASE_RE = re.compile(r"\b(?:справ[аиіу]\s*(?:№|N)?\s*)(\d{1,4}/\d{1,7}/\d{2})\b", re.I)


def _dict_csv(zf: zipfile.ZipFile, name: str) -> dict[str, str]:
    member = next((n for n in zf.namelist() if n.lower().endswith(name)), None)
    if not member:
        return {}
    text = zf.read(member).decode("utf-8-sig", errors="replace")
    out = {}
    for row in csv.reader(io.StringIO(text), delimiter="\t"):
        if len(row) >= 2 and row[0].strip().isdigit():
            out[row[0].strip()] = row[1].strip()
    return out


@register
class Courts(Connector):
    name = "courts"
    interval_s = 24 * 3600
    requires_env = "KB_COURTS_ENABLED"

    def run(self, cursor: dict) -> dict:
        year = date.today().year
        found = get_json("https://data.gov.ua/api/3/action/package_search",
                         params={"q": f"Єдиний державний реєстр судових рішень за {year} рік", "rows": 5}, timeout=60)
        package = next(p["id"] for p in found["result"]["results"]
                       if any(f"edrsr_data_{year}" in (r.get("name") or "") for r in p["resources"]))
        path = _download(_resource_url(package, f"edrsr_data_{year}"))
        since = (date.today() - timedelta(days=COURT_DAYS)).isoformat()
        try:
            with zipfile.ZipFile(path) as zf:
                courts = _dict_csv(zf, "courts.csv")
                forms = _dict_csv(zf, "judgment_forms.csv")
                cats = _dict_csv(zf, "cause_categories.csv")
                member = next(n for n in zf.namelist() if n.lower().endswith("documents.csv"))
                with zf.open(member) as fh, db.tx() as conn:
                    for row in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace"), delimiter="\t"):
                        kind = (row.get("justice_kind") or "").strip()
                        adj = (row.get("adjudication_date") or "")[:10]
                        if kind not in COURT_KINDS or adj < since:
                            continue
                        cur = conn.execute(
                            """INSERT INTO kb.court_documents (doc_id, court_code, court_name, judgment_form, justice_kind, category,
                                                               cause_num, adjudication_date, judge, doc_url)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (doc_id) DO NOTHING""",
                            (int(row["doc_id"]), int(row["court_code"]) if (row.get("court_code") or "").isdigit() else None,
                             courts.get(row.get("court_code", "")), forms.get(row.get("judgment_code", "")), COURT_KINDS[kind],
                             cats.get(row.get("category_code", "")), (row.get("cause_num") or "")[:64], adj or None,
                             (row.get("judge") or "")[:300], row.get("doc_url")))
                        self.add("new", cur.rowcount or 0)
        finally:
            os.unlink(path)
        self._link_news_cases()
        return cursor

    def _link_news_cases(self) -> None:
        """Decisions in cases quoted by recent news: fetch the text (RTF -> plain) as a document for the NLP pipeline."""
        rows = db.fetch_all("SELECT body FROM kb.documents WHERE kind = 'news' AND fetched_at > now() - interval '3 days' "
                            "AND body ~* 'справ[аиіу]' LIMIT 2000")
        nums = {m for r in rows for m in CASE_RE.findall(r["body"] or "")}
        for num in list(nums)[:200]:
            for d in db.fetch_all("SELECT * FROM kb.court_documents WHERE cause_num = %s AND document_id IS NULL AND doc_url IS NOT NULL",
                                  (num,)):
                try:
                    body = rtf_to_text(get(d["doc_url"], timeout=60).content.decode("cp1251", errors="replace"))
                except Exception as exc:  # noqa: BLE001
                    self.add("errors")
                    log.warning("court doc %s: %s", d["doc_id"], type(exc).__name__)
                    continue
                title = f"{d['court_name'] or 'Суд'}: {d['judgment_form'] or 'рішення'} у справі №{num} ({d['adjudication_date']})"
                doc_id = add_document("data-court", "official_statement", f"https://reyestr.court.gov.ua/Review/{d['doc_id']}", title,
                                      body, meta={"court_doc_id": d["doc_id"], "cause_num": num})
                if doc_id:
                    db.execute("UPDATE kb.court_documents SET document_id = %s WHERE doc_id = %s", (doc_id, d["doc_id"]))
                    rid, _ = upsert_record("court", "decision", str(d["doc_id"]), title, happened_on=d["adjudication_date"], geo="UKR",
                                           data={"cause_num": num, "category": d["category"]},
                                           url=f"https://reyestr.court.gov.ua/Review/{d['doc_id']}")
                    self.add("texts")


_RTF_CTRL = re.compile(r"\\[a-z]+-?\d* ?|[{}]|\\'([0-9a-f]{2})", re.I)


def rtf_to_text(rtf: str) -> str:
    """Minimal RTF to text (court decisions are simple RTF in cp1251)."""
    def sub(m):
        return bytes([int(m.group(1), 16)]).decode("cp1251", errors="replace") if m.group(1) else ""

    text = re.sub(r"\\par[d]?", "\n", rtf)
    text = _RTF_CTRL.sub(sub, text)
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n\n", text)).strip()
