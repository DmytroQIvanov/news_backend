import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {selectEventData,matchDataKeywords,seriesCurrencyMatches}=require('../dist/kb/kb-data-selection.js');
const {buildDataDocs}=require('../dist/kb/kb-data.js');
const {KbDataService}=require('../dist/kb/kb-data.service.js');
const {Pool}=require('pg');

test('metric topics require specific words and distinguish exchange currencies',()=>{
  assert.deepEqual(matchDataKeywords('НБУ оприлюднив прогноз України',['НБУ','Україна','долар']),[]);
  assert.ok(matchDataKeywords('Зростання прибутку компанії',['прибуток']).length);
  assert.equal(seriesCurrencyMatches('Офіційний курс євро','exchange:USD'),false);
  assert.equal(seriesCurrencyMatches('Офіційний курс долара','exchange:USD'),true);
});

// Explicit opt-in URL only; every fixture is rolled back, including all automatic links.
const url=process.env.KB_TEST_DATABASE_URL;
async function fixture(fn){
  const pool=new Pool({connectionString:url,max:1});
  const db=await pool.connect();
  try { await db.query('BEGIN'); await fn(db); }
  finally { await db.query('ROLLBACK'); db.release(); await pool.end(); }
}
async function entity(db,name='Data fixture',kind='company'){
  return Number((await db.query('INSERT INTO kb.entities(kind,name,origin) VALUES($1,$2,\'dataset\') RETURNING id',[kind,name])).rows[0].id);
}
async function event(db,entityIds,title='Revenue and exchange rate'){
  const id=Number((await db.query("INSERT INTO kb.events(title,category,started_at,last_seen_at) VALUES($1,'economy','2026-04-01','2026-04-01') RETURNING id",[title])).rows[0].id);
  for(const eid of entityIds)await db.query('INSERT INTO kb.event_entities(event_id,entity_id,weight) VALUES($1,$2,1)',[id,eid]);
  return id;
}
async function series(db,eid,code='revenue'){
  return Number((await db.query(`INSERT INTO kb.series(provider,provider_code,title,frequency,unit,entity_id,categories,keywords)
    VALUES('nbu',$1,'Exact dataset','A','USD',$2,ARRAY['economy'],ARRAY['revenue','exchange rate','курс','долар']) RETURNING id`,[`${code}-${eid}`,eid])).rows[0].id);
}
async function observation(db,sid,period,value){
  await db.query(`INSERT INTO kb.observations(series_id,period,period_start,value) VALUES($1,$2::text,($2::text||'-01-01')::date,$3)
    ON CONFLICT(series_id,period) DO UPDATE SET value=EXCLUDED.value`,[sid,period,value]);
}
const dbtest=(name,fn)=>test(name,{skip:!url},()=>fixture(fn));

dbtest('observation history is idempotent, preserves revisions and rejects invalid values',async db=>{
  const sid=await series(db,await entity(db));
  await observation(db,sid,'2025','9007199254740993.123456789');
  await observation(db,sid,'2025','9007199254740993.123456789');
  assert.equal((await db.query('SELECT count(*)::int n FROM kb.observation_versions WHERE series_id=$1',[sid])).rows[0].n,1);
  await observation(db,sid,'2025','9007199254740994.123456789');
  const versions=(await db.query('SELECT value::text,period_end,superseded_at FROM kb.observation_versions WHERE series_id=$1 ORDER BY id',[sid])).rows;
  assert.equal(versions.length,2);
  assert.equal(versions[0].value,'9007199254740993.123456789');
  assert.ok(versions[0].superseded_at);
  assert.equal(versions[1].superseded_at,null);
  await db.query('SAVEPOINT invalid');
  await assert.rejects(observation(db,sid,'2026','NaN'),/Invalid observation/);
  await db.query('ROLLBACK TO SAVEPOINT invalid');
});

dbtest('point-in-time selection excludes future periods and later revisions; persisted links stay bounded',async db=>{
  const eid=await entity(db),ev=await event(db,[eid]),sid=await series(db,eid);
  await observation(db,sid,'2025','100');
  await db.query("UPDATE kb.observation_versions SET recorded_at='2026-01-01' WHERE series_id=$1",[sid]);
  await observation(db,sid,'2025','200');
  await db.query("UPDATE kb.observation_versions SET recorded_at='2026-03-01' WHERE series_id=$1 AND superseded_at IS NULL",[sid]);
  await observation(db,sid,'2026','999');
  const old=await selectEventData(db,ev,'economy',[eid],'2026-02-01T00:00:00Z','revenue');
  assert.deepEqual(old[0].points.map(p=>p.value),['100']);
  const current=await selectEventData(db,ev,'economy',[eid],'2026-04-01T00:00:00Z','revenue');
  assert.deepEqual(current[0].points.map(p=>p.value),['200']);
  assert.equal((await db.query('SELECT count(*)::int n FROM kb.event_data_links WHERE event_id=$1',[ev])).rows[0].n,1);
  assert.deepEqual(await selectEventData(db,ev,'economy',[eid],'2026-04-01','celebrity gossip'),[]);
  assert.equal((await db.query('SELECT active FROM kb.event_data_links WHERE event_id=$1',[ev])).rows[0].active,false);
});

dbtest('trusted ownership paths reach two hops; co-occurrence and country fan-out do not',async db=>{
  const ids=[];for(const n of ['Parent','Child','Grandchild','Unrelated','Country'])ids.push(await entity(db,n,n==='Country'?'place':'company'));
  const [parent,child,grandchild,other,country]=ids;
  const ev=await event(db,[parent]);
  for(const [a,b,relation,origin] of [[parent,child,'owns','manual'],[child,grandchild,'owns','dataset'],[parent,other,'owns','cooccurrence'],[parent,country,'headquarters','wikidata'],[other,country,'headquarters','wikidata']])
    await db.query("INSERT INTO kb.entity_relations(from_entity_id,to_entity_id,relation,origin,weight,first_seen) VALUES($1,$2,$3,$4,1,'2020-01-01')",[a,b,relation,origin]);
  for(const eid of [grandchild,other]){const sid=await series(db,eid);await observation(db,sid,'2025','5');await db.query("UPDATE kb.observation_versions SET recorded_at='2026-01-01' WHERE series_id=$1",[sid]);}
  const result=await selectEventData(db,ev,'economy',[parent],'2026-04-01','revenue');
  assert.equal(result.length,1);
  assert.deepEqual(result[0].evidence.entityPath,[parent,child,grandchild]);
  assert.deepEqual(result[0].evidence.relations,['owns:forward','owns:forward']);
});

dbtest('SEC data keeps quarterly and annual durations, units, decimals and filing availability',async db=>{
  const eid=await entity(db),ev=await event(db,[eid]);
  async function fact(start,value,unit,accession,available){
    await db.query(`INSERT INTO kb.financial_facts(entity_id,taxonomy,concept,label,unit,period_start,period_end,value,filed_on,available_at,accession,form,raw)
      VALUES($1,'us-gaap','Revenues','Revenue',$2,$3,'2025-12-31',$4,'2026-01-31',$5,$6,'10-K','{}')`,[eid,unit,start,value,available,accession]);
  }
  await fact('2025-01-01','9007199254740993','USD','0000000001-26-000001','2026-02-01');
  await fact('2025-10-01','30.123456789','USD','0000000001-26-000001','2026-02-01');
  await fact('2025-01-01','80','EUR','0000000001-26-000001','2026-02-01');
  await fact('2025-01-01','120','USD','0000000001-26-000002','2026-03-01');
  const old=await selectEventData(db,ev,'economy',[eid],'2026-02-15','revenue');
  assert.equal(old.length,3);
  assert.equal(old.find(f=>f.periodStart==='2025-10-01').value,'30.123456789');
  assert.equal(old.find(f=>f.unit==='USD'&&f.periodStart==='2025-01-01').value,'9007199254740993');
  const revised=await selectEventData(db,ev,'economy',[eid],'2026-04-01','revenue');
  assert.equal(revised.find(f=>f.unit==='USD'&&f.periodStart==='2025-01-01').value,'120');
  await fact('2025-01-01','121','USD','0000000001-26-000002','2026-03-01');
  assert.ok(new Date((await db.query("SELECT available_at FROM kb.financial_facts WHERE entity_id=$1 AND value=121",[eid])).rows[0].available_at)>new Date('2026-04-01'));
});

dbtest('registry revisions are selected historically rather than overwritten',async db=>{
  const eid=await entity(db),ev=await event(db,[eid]);
  const rid=(await db.query(`INSERT INTO kb.records(provider,record_type,external_id,title,happened_on,amount,currency,first_seen)
    VALUES('prozorro','contract_award',$1,'Contract original','2026-01-01',10,'UAH','2026-01-02') RETURNING id`,[String(eid)])).rows[0].id;
  await db.query('INSERT INTO kb.record_entities(record_id,entity_id,role) VALUES($1,$2,\'subject\')',[rid,eid]);
  await db.query("UPDATE kb.record_versions SET recorded_at='2026-01-02' WHERE record_id=$1",[rid]);
  await db.query("UPDATE kb.records SET title='Contract corrected',amount=20 WHERE id=$1",[rid]);
  const old=await selectEventData(db,ev,'economy',[eid],'2026-04-01','contract');
  assert.equal(old[0].title,'Contract original');
  assert.match(old[0].excerpt,/Amount: 10 UAH/);
});

dbtest('dossier data and background refresh execute real SQL without an LLM',async db=>{
  const eid=await entity(db),ev=await event(db,[eid],'Revenue');
  const sid=await series(db,eid);await observation(db,sid,'2025','10');
  const docs=await buildDataDocs(db,ev,'economy',[{id:eid}],'2026-04-01',{text:'revenue'});
  assert.equal(docs.filter(d=>d.data).length,1);
  const service=new KbDataService(db);
  const result=await service.runOnce();
  assert.equal(result.failed,0);
  assert.ok(result.checked>=1);
  assert.equal((await db.query('SELECT last_error FROM kb.event_data_refresh WHERE event_id=$1',[ev])).rows[0].last_error,null);
});

dbtest('news-document links work with both insertion orders and preserve explicit event links',async db=>{
  const source=(await db.query("SELECT id FROM public.sources LIMIT 1")).rows[0].id;
  const ev=await event(db,[]),ev2=await event(db,[]);
  async function news(url,kb=null){ return (await db.query(`INSERT INTO public.news_items(source_id,external_id,url,canonical_url,original_title,category,importance,free_access,content_hash,kb_event_id)
    VALUES($1,$2::text,$2::text,$2::text,'Fixture','economy','normal','free',repeat('0',64),$3) RETURNING id`,[source,url,kb])).rows[0].id; }
  async function document(url){const id=(await db.query("INSERT INTO kb.documents(url,canonical_url,title) VALUES($1,$1,'Fixture') RETURNING id",[url])).rows[0].id;await db.query('INSERT INTO kb.event_documents(document_id,event_id,similarity) VALUES($1,$2,1)',[id,ev]);}
  const a=`https://fixture.test/${ev}/a`,b=`https://fixture.test/${ev}/b`,c=`https://fixture.test/${ev}/c`;
  const n1=await news(a);await document(a);await document(b);const n2=await news(b);const n3=await news(c,ev2);await document(c);
  const rows=(await db.query('SELECT kb_event_id::int FROM public.news_items WHERE id=ANY($1::bigint[]) ORDER BY id',[[n1,n2,n3]])).rows;
  assert.deepEqual(rows.map(r=>r.kb_event_id),[ev,ev,ev2]);
});
