"""Lossless XBRL Company Facts parser. No fiscal-period guessing or currency conversion."""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from .. import db
from .provenance import snapshot_ids


def cik_key(raw) -> str:
    text = str(raw).strip()
    if not text.isdigit() or len(text) > 10 or int(text) <= 0:
        raise ValueError('Invalid SEC CIK')
    return text.zfill(10)


def parse_companyfacts(payload: dict, expected_cik: str, acceptance: dict | None = None) -> list[dict]:
    if cik_key(payload.get('cik', '')) != cik_key(expected_cik):
        raise ValueError('Company Facts CIK mismatch')
    rows = {}
    for taxonomy, concepts in payload.get('facts', {}).items():
        if taxonomy not in {'us-gaap', 'ifrs-full', 'dei', 'srt'}:
            continue
        for concept, details in concepts.items():
            for unit, facts in details.get('units', {}).items():
                for fact in facts:
                    try:
                        if isinstance(fact.get('val'), bool):
                            continue
                        value = Decimal(str(fact['val']))
                        end = date.fromisoformat(fact['end'])
                        start = date.fromisoformat(fact['start']) if fact.get('start') else None
                        filed = date.fromisoformat(fact['filed'])
                        accession, form = str(fact['accn']), str(fact['form'])
                        if not value.is_finite() or (start and start > end) or not re.fullmatch(r'\d{10}-\d{2}-\d{6}', accession):
                            continue
                        if form.removesuffix('/A') not in {'10-K', '10-Q', '8-K', '20-F', '40-F', '6-K'}:
                            continue
                        # Without an exact acceptance timestamp, do not claim availability before filing-day end.
                        available = (acceptance or {}).get(accession) or datetime.combine(filed + timedelta(days=1), datetime.min.time(), timezone.utc)
                        if isinstance(available, str):
                            available = datetime.fromisoformat(available.replace('Z', '+00:00'))
                        if available.tzinfo is None:
                            available = available.replace(tzinfo=timezone.utc)
                    except (KeyError, ValueError, InvalidOperation, TypeError):
                        continue
                    key = (taxonomy, concept, unit, start, end, accession, value)
                    rows[key] = {'taxonomy': taxonomy, 'concept': concept, 'label': details.get('label') or concept,
                                 'unit': unit, 'start': start, 'end': end, 'value': value, 'filed': filed,
                                 'available': available, 'accession': accession, 'form': form,
                                 'fy': fact.get('fy'), 'fp': fact.get('fp'), 'frame': fact.get('frame'), 'raw': fact}
    return list(rows.values())


def store_companyfacts(entity_id: int, payload: dict, cik: str, acceptance: dict) -> int:
    rows = parse_companyfacts(payload, cik, acceptance)
    snapshots = snapshot_ids()
    with db.tx() as conn:
        records = {r['external_id']: r['id'] for r in conn.execute(
            "SELECT id, external_id FROM kb.records WHERE provider='sec' AND data->>'cik'=%s", (cik,)).fetchall()}
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO kb.financial_facts(entity_id,taxonomy,concept,label,unit,period_start,period_end,
                       value,filed_on,available_at,accession,form,fiscal_year,fiscal_period,frame,record_id,snapshot_id,raw)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                   ON CONFLICT(entity_id,taxonomy,concept,unit,period_start,period_end,accession,value)
                   DO UPDATE SET last_seen=clock_timestamp(),record_id=COALESCE(kb.financial_facts.record_id,EXCLUDED.record_id)""",
                [(entity_id,r['taxonomy'],r['concept'],r['label'],r['unit'],r['start'],r['end'],r['value'],r['filed'],
                  r['available'],r['accession'],r['form'],r['fy'],r['fp'],r['frame'],records.get(r['accession']),
                  snapshots[-1] if snapshots else None,db.jsonb(r['raw'])) for r in rows],
            )
    return len(rows)
