"""Collection invariants. Database checks opt in only through KB_TEST_DATABASE_URL."""
import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import gzip
import os
import uuid
from contextlib import nullcontext
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import Mock

import pytest
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from kb import db
from kb.connectors import base, provenance
from kb.connectors.sec_facts import parse_companyfacts, store_companyfacts


def payload():
    common={'end':'2025-12-31','filed':'2026-02-01','form':'10-K','accn':'0000000001-26-000001'}
    return {'cik':1,'facts':{'us-gaap':{'Revenues':{'label':'Revenue','units':{
        'USD':[{**common,'start':'2025-01-01','val':Decimal('9007199254740993.123456789')},
               {**common,'start':'2025-10-01','val':Decimal('30.123456789')}],
        'EUR':[{**common,'start':'2025-01-01','val':80}]}}}}}


def test_sec_retains_precision_periods_units_and_conservative_availability():
    rows=parse_companyfacts(payload(),'0000000001')
    assert len(rows)==3
    assert rows[0]['value']==Decimal('9007199254740993.123456789')
    assert rows[0]['start']!=rows[1]['start']
    assert rows[0]['available']==datetime(2026,2,2,tzinfo=timezone.utc)
    exact=parse_companyfacts(payload(),'1',{'0000000001-26-000001':'2026-02-01T18:00:00Z'})
    assert exact[0]['available'].hour==18


def test_sec_rejects_wrong_company_and_nonfinite_values():
    with pytest.raises(ValueError,match='CIK mismatch'):
        parse_companyfacts(payload(),'2')
    data=payload()
    data['facts']['us-gaap']['Revenues']['units']['USD'][0]['val']='NaN'
    assert len(parse_companyfacts(data,'1'))==2


def test_request_identity_removes_secrets_and_is_stable():
    safe=provenance.safe_request('https://user:password@example.com/api?token=hidden&b=2#fragment',{'api_key':'hidden','a':1})
    assert safe=='https://example.com/api?a=1&b=2'


def test_partial_collection_does_not_advance_cursor_or_last_success(monkeypatch):
    import kb.connectors
    class Partial(base.Connector):
        name='partial_test'
        def run(self,cursor):
            self.add('errors')
            return {'offset':999}
    state={'enabled':True,'cursor':{'offset':1},'consecutive_failures':0}
    monkeypatch.setattr(kb.connectors,'load_all',lambda:None)
    monkeypatch.setitem(base.REGISTRY,'partial_test',Partial)
    monkeypatch.setattr(db,'fetch_one',Mock(return_value=state))
    monkeypatch.setattr(db,'try_advisory_lock',lambda key:nullcontext())
    execute=Mock();monkeypatch.setattr(db,'execute',execute)
    assert 'error:' in base.run_due('partial_test',force=True)['partial_test']
    assert all('last_ok_at = now()' not in call.args[0] and 'SET cursor' not in call.args[0] for call in execute.call_args_list)


@pytest.fixture
def storage(monkeypatch):
    url=os.environ.get('KB_TEST_DATABASE_URL')
    if not url:
        pytest.skip('Set an isolated KB_TEST_DATABASE_URL')
    pool=ConnectionPool(url,min_size=1,max_size=4,kwargs={'row_factory':dict_row})
    monkeypatch.setattr(db,'_pool',pool)
    token=uuid.uuid4().hex
    eid=db.fetch_one("INSERT INTO kb.entities(kind,name,origin) VALUES('company',%s,'dataset') RETURNING id",(token,))['id']
    try:
        yield eid,token
    finally:
        db.execute('DELETE FROM kb.entities WHERE id=%s',(eid,))
        db.execute('DELETE FROM kb.records WHERE provider=%s AND external_id=%s',('test_data',token))
        db.execute('DELETE FROM kb.data_snapshots WHERE provider=%s',(token,))
        pool.close()


def test_source_snapshot_roundtrip_and_idempotence(storage):
    _,token=storage
    raw=b'{"value":9007199254740993.123456789}'
    with provenance.collection_scope(token):
        a=provenance.capture('https://example.com/data?api_key=hidden',None,raw,'application/json')
        b=provenance.capture('https://example.com/data?api_key=hidden',None,raw,'application/json')
        assert a==b
        row=db.fetch_one('SELECT *,payload->>\'value\' AS exact FROM kb.data_snapshots WHERE id=%s',(a,))
        assert gzip.decompress(row['body_gzip'])==raw
        assert row['exact']=='9007199254740993.123456789'
        assert 'hidden' not in row['source_url']
    assert provenance.snapshot_ids()==()


def test_observation_upsert_preserves_history_and_latest_cache(storage):
    eid,token=storage
    with provenance.collection_scope(token):
        sid=base.upsert_series('nbu',token,'Test','D',entity_id=eid)
        provenance.capture('https://example.com/data',None,b'{"value":42}')
        assert base.upsert_observations(sid,[('2026-11-17',Decimal('42'),None)])=={'new':1,'revised':0}
        assert base.upsert_observations(sid,[('2026-11-17',Decimal('42'),None)])=={'new':0,'revised':0}
        assert base.upsert_observations(sid,[('2026-11-17',Decimal('43'),'p')])=={'new':0,'revised':1}
        base.upsert_observations(sid,[('2026-10-01',Decimal('20'),None)])
        assert db.fetch_one('SELECT last_period FROM kb.series WHERE id=%s',(sid,))['last_period']=='2026-11-17'
        versions=db.fetch_all("SELECT value FROM kb.observation_versions WHERE series_id=%s AND period='2026-11-17' ORDER BY id",(sid,))
        assert [v['value'] for v in versions]==[Decimal(42),Decimal(43)]
        assert db.fetch_one('SELECT count(*) AS n FROM kb.observation_version_sources vs JOIN kb.observation_versions v ON v.id=vs.version_id WHERE v.series_id=%s',(sid,))['n']==3


def test_sec_storage_is_idempotent_and_records_retain_revisions(storage):
    eid,token=storage
    assert store_companyfacts(eid,payload(),'0000000001',{})==3
    store_companyfacts(eid,payload(),'0000000001',{})
    assert db.fetch_one('SELECT count(*) AS n FROM kb.financial_facts WHERE entity_id=%s',(eid,))['n']==3
    rid,_=base.upsert_record('test_data','contract_award',token,'Original',happened_on=date(2026,1,1),amount=10,currency='UAH')
    base.upsert_record('test_data','contract_award',token,'Corrected',happened_on=date(2026,1,2),amount=20,currency='EUR')
    versions=db.fetch_all('SELECT data FROM kb.record_versions WHERE record_id=%s ORDER BY id',(rid,))
    assert [v['data']['title'] for v in versions]==['Original','Corrected']
    assert versions[-1]['data']['currency']=='EUR'
