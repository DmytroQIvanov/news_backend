import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildSections, deriveCategories, evidenceHash, evidenceChanged, validateGeneratedIntro, introGrounding, boundedNumber, decodeCursor } = require('../dist/encyclopedia/encyclopedia-pure.js');
const { EncyclopediaService } = require('../dist/encyclopedia/encyclopedia.service.js');
const { cacheTtlFor } = require('../dist/common/response-cache.interceptor.js');
const citation = id => ({ ref: `D${id}`,url: `https://outlet${id}.example/report`,title: 'Report',name: `Outlet ${id}` });
const fact = { id: '1',text: 'Aster acquired Boreal for 20 USD',text_uk: 'Aster придбала Boreal за 20 USD',status: 'disputed',refs: ['D1'] };

test('sections preserve disputed/retracted/planned statements, source refs and chronological event order', () => {
  const sections = buildSections([fact,{ ...fact,id: '2',status: 'retracted' }], [{ ...fact,status: 'plan' }],
    [{ id: '2',title: 'Later',date: '2026-02-01',refs: ['D2'],newsId: '5' },{ id: '1',title: 'Earlier',date: '2026-01-01',refs: ['D1'],newsId: null }],
    [{ entityId: '2',name: 'Boreal',relation: 'acquire',refs: ['D1'] }],[citation(1),citation(2)]);
  assert.deepEqual(sections.map(s => s.type), ['facts','claims','timeline','relations']);
  assert.match(sections[0].text,/disputed/); assert.match(sections[0].text,/retracted/);
  assert.ok(sections[2].text.indexOf('Earlier') < sections[2].text.indexOf('Later'));
  assert.deepEqual(sections[2].refs,['D1','D2']);
  assert.deepEqual(buildSections([{ ...fact,refs: ['missing'] }],[],[],[],[citation(1)]),[]);
});

test('intro validation accepts complete grounded sentences in both languages', () => {
  const grounding = introGrounding([fact]);
  assert.deepEqual(validateGeneratedIntro({ summary: grounding.en[0],summary_uk: grounding.uk[0] },grounding), { summary: grounding.en[0],summary_uk: grounding.uk[0] });
  for (const wrong of [grounding.en[0].replace('20','200'),grounding.en[0].replace('Boreal','Cedar'),
    'Boreal acquired Aster for 20 USD [disputed].',grounding.en[0].replace('disputed','confirmed'),
    grounding.en[0]+' Aster is a market leader.', 'Aster acquired Boreal for 20 USD.']) {
    assert.equal(validateGeneratedIntro({ summary: wrong,summary_uk: grounding.uk[0] },grounding),null,wrong);
  }
  assert.equal(validateGeneratedIntro({ summary: grounding.en[0],summary_uk: 'Нові дані 100' },grounding),null);
  assert.equal(validateGeneratedIntro(null,grounding),null);
});

test('categories derive arbitrary event categories, kinds and Wikidata classes with data labels', () => {
  const categories = deriveCategories('new_kind',[{category:'marine_science'},{category:'marine_science'},{category:'space_law'}],{
    category_labels: {marine_science:{en:'Marine science',uk:'Морські науки'}},
    wikidata_classes: [{id:'Q123456',labels:{en:'Research cooperative',uk:'Дослідницький кооператив'}}],
  });
  assert.equal(categories[0].slug,'event:marine-science'); assert.equal(categories[0].label_uk,'Морські науки');
  assert.ok(categories.some(c => c.slug==='kind:new-kind'));
  assert.ok(categories.some(c => c.slug==='class:q123456' && c.label_uk==='Дослідницький кооператив'));
  assert.deepEqual(deriveCategories('novel',[]).map(c=>c.slug),['kind:novel']);
});

test('hash ignores SQL/key order but changes on evidence, status, attribution and category changes', () => {
  const evidence = {facts:[fact],sources:[citation(1),citation(2)]};
  const hash = evidenceHash(evidence);
  assert.equal(evidenceChanged(hash,{sources:[citation(2),citation(1)],facts:[{refs:['D1'],status:'disputed',text_uk:fact.text_uk,text:fact.text,id:'1'}]}),false);
  for (const patch of [{facts:[{...fact,status:'retracted'}]},{sources:[{...citation(1),name:'Changed owner'}]},{category:'new-category'}]) {
    assert.equal(evidenceChanged(hash,{...evidence,...patch}),true);
  }
  assert.equal(evidenceChanged(null,evidence),true);
});

test('filter bounds, malformed cursors and all encyclopedia cache paths are safe', () => {
  assert.equal(boundedNumber('Infinity',20,1,50),20);
  assert.equal(boundedNumber('-1',20,1,50),1);
  assert.equal(boundedNumber('',20,1,50),20);
  assert.equal(decodeCursor('broken'),null);
  for (const payload of [{importance:1e100,id:'1'},{importance:1,id:'9999999999999999999'},{importance:1,id:1}]) {
    assert.equal(decodeCursor(Buffer.from(JSON.stringify(payload)).toString('base64url')),null);
  }
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({importance:0.5,id:'1 OR 1=1'})).toString('base64url')),null);
  for (const path of ['/api/v1/encyclopedia','/api/v1/encyclopedia?q=foo','/api/v1/encyclopedia/categories','/api/v1/encyclopedia/aster-1']) assert.equal(cacheTtlFor('GET',path,false),180000);
});

function fixture() {
  const docs = [1,2].map(id => ({id:String(id),url:`https://outlet${id}.example/report`,title:'Report',name:`Outlet ${id}`,extraction_status:'full',evidence_root:`outlet${id}`,salience:0.6,mentions:1}));
  const facts = [{ id:'7',subject_entity_id:'1',sname:'Aster',sname_uk:'Aster',object_entity_id:'2',oname:'Boreal',oname_uk:'Boreal',
    predicate:'acquire',object_key:'',object_text:null,value_num:20,value_unit:'USD',status:'disputed',source_count:2,valid_from:null,
    citations:[docs[0]] }];
  const entity = { id:'1',name:'Aster',kind:'company',importance:0.5,status:'active',attributes:{},mention_count:2 };
  const writes=[];
  const db={query:async(sql,args=[])=>{
    if(sql.includes('SELECT chosen.*'))return {rows:docs};
    if(sql.includes('FROM kb.facts f'))return {rows:facts};
    if(sql.includes('INSERT INTO encyclopedia_entries') || sql.includes("SET status='hidden'"))writes.push({sql,args});
    return {rows:[],rowCount:0};
  }};
  return {docs,facts,entity,writes,db};
}
test('refresh falls back deterministically, skips unchanged hashes and updates changed evidence', async t => {
  const before=process.env.ENCYCLOPEDIA_INTRO_ENABLED;
  process.env.ENCYCLOPEDIA_INTRO_ENABLED='false';
  t.after(()=>{if(before===undefined)delete process.env.ENCYCLOPEDIA_INTRO_ENABLED;else process.env.ENCYCLOPEDIA_INTRO_ENABLED=before;});
  const f=fixture(); const service=new EncyclopediaService(f.db);
  assert.equal(await service.refreshEntity(f.db,f.entity,90),true);
  assert.match(f.writes[0].args[7],/disputed/);
  const stored=f.writes[0].args;
  f.entity.evidence_hash=stored[17];f.entity.entry_status='auto';
  assert.equal(await service.refreshEntity(f.db,f.entity,90),false);
  assert.equal(f.writes.length,1);
  f.facts[0].status='retracted';
  assert.equal(await service.refreshEntity(f.db,f.entity,90),true);
  assert.match(f.writes[1].args[7],/retracted/);
  f.docs[1].evidence_root=f.docs[0].evidence_root;
  assert.equal(await service.refreshEntity(f.db,f.entity,90),false);
  assert.match(f.writes.at(-1).sql,/status='hidden'/);
});

test('cross-replica lease prevents duplicate refreshes and always releases the connection', async () => {
  let released=false;
  const service=new EncyclopediaService({connect:async()=>({query:async()=>({rows:[{locked:false}]}),release:()=>{released=true;}})});
  assert.deepEqual(await service.runOnce(),{checked:0,updated:0}); assert.equal(released,true);
  assert.deepEqual(await service.runOnce(),{checked:0,updated:0});
});

test('malformed generated intros fall back to cited statements rather than adding unsupported claims', async t => {
  const gemma=require('../dist/kb/kb-gemma.js'); const original=gemma.gemmaJson;
  const before=process.env.ENCYCLOPEDIA_INTRO_ENABLED; delete process.env.ENCYCLOPEDIA_INTRO_ENABLED;
  t.after(()=>{gemma.gemmaJson=original;if(before===undefined)delete process.env.ENCYCLOPEDIA_INTRO_ENABLED;else process.env.ENCYCLOPEDIA_INTRO_ENABLED=before;});
  let calls=0;
  gemma.gemmaJson=async request=>{
    calls++;assert.equal(request.purpose,'encyclopedia_intro');assert.equal(request.validate({summary:'Cedar acquired Aster for 200 USD',summary_uk:'Нові дані'}),null);return null;
  };
  const f=fixture();const service=new EncyclopediaService(f.db);
  assert.equal(await service.refreshEntity(f.db,f.entity,90),true);assert.equal(calls,1);
  assert.match(f.writes[0].args[7],/disputed/);assert.doesNotMatch(f.writes[0].args[7],/Cedar|200/);
});

test('empty knowledge does not publish a name-only encyclopedia card', async () => {
  const f=fixture();f.facts.length=0;
  assert.equal(await new EncyclopediaService(f.db).refreshEntity(f.db,f.entity,90),false);
  assert.ok(f.writes.every(w=>!w.sql.includes('INSERT INTO encyclopedia_entries')));
});

test('usable documents without source registry rows still use their independent URL hosts', async t => {
  const before=process.env.ENCYCLOPEDIA_INTRO_ENABLED;process.env.ENCYCLOPEDIA_INTRO_ENABLED='false';
  t.after(()=>{if(before===undefined)delete process.env.ENCYCLOPEDIA_INTRO_ENABLED;else process.env.ENCYCLOPEDIA_INTRO_ENABLED=before;});
  const f=fixture();for(const doc of f.docs){doc.evidence_root=null;doc.name=null;}
  assert.equal(await new EncyclopediaService(f.db).refreshEntity(f.db,f.entity,90),true);
});

test('listing uses keyset order, literal ILIKE fallback and optional trigram matching', async () => {
  for(const enabled of [false,true]) {
    const sql=[];
    const service=new EncyclopediaService({query:async(q,args)=>{sql.push({q,args});return q.includes('pg_extension')?{rows:[{enabled}]}:{rows:[{id:'2',slug:'two',title:'Two',summary:'',importance:1},{id:'1',slug:'one',title:'One',summary:'',importance:0.5}]};}});
    const result=await service.list({q:'a_%',limit:'1'},'en');
    assert.equal(result.items.length,1); assert.deepEqual(decodeCursor(result.nextCursor),{importance:1,id:'2'});
    assert.equal(sql.at(-1).args[3],'%a\\_\\%%');
    assert.equal(sql.at(-1).q.includes('lower(title) % lower($3)'),enabled);
    assert.match(sql.at(-1).q,/\(importance,id\)</);
  }
});

test('encyclopedia: neutral status brackets are dropped from summaries, qualifiers stay', async () => {
  const { presentSummary } = await import('../dist/encyclopedia/encyclopedia-pure.js').catch(() => require('../dist/encyclopedia/encyclopedia-pure.js'));
  assert.equal(presentSummary('Nvidia reported revenue [published reporting].'), 'Nvidia reported revenue');
  assert.equal(presentSummary('Нвідіа — партнерство [опубліковане повідомлення].'), 'Нвідіа — партнерство');
  assert.ok(presentSummary('Company denied the claim [denial].').endsWith('[denial].'));
});
