import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {CatalogService}=require('../dist/catalog/catalog.service.js');
const {INITIAL_CATALOG,PROVIDERS_CONFIG}=require('../dist/catalog/catalog-seed.js');
const {catalogRegistryTargets}=require('../dist/catalog/catalog-registry.js');
const {GrantsService}=require('../dist/grants/grants.service.js');

test('bundled catalog never acquires a fresh verification timestamp',async()=>{
  assert.ok(INITIAL_CATALOG.every(p=>!p.lastVerifiedAt));
  const service=new CatalogService({query:async()=>({rows:[]})});
  const rows=await service.getAll(); assert.ok(rows.every(p=>p.verificationStatus==='outdated'));
});
test('a newly registered provider participates without a code or seed change',()=>{
  const rows=catalogRegistryTargets([{id:'new-provider',providerId:'new',providerName:'New',category:'arbitrary',officialUrl:'https://new.example',pricingDocUrl:'https://new.example/pricing'}]);
  assert.equal(rows.length,1);assert.equal(rows[0].providerId,'new');assert.deepEqual(rows[0].feedUrls,[]);
  assert.deepEqual(catalogRegistryTargets([{id:'bad',providerId:'bad',providerName:'Bad',officialUrl:'http://localhost'}]),[]);
});
test('missing model configuration and failed verification never mark a catalog verified',async()=>{
  const writes=[];const service=new CatalogService({query:async(sql)=>{if(sql.startsWith('UPDATE'))writes.push(sql);return {rows:[]};}});
  service.collectProviderEvidence=async()=> 'Observed official text';
  Object.defineProperty(service,'geminiKey',{value:undefined});
  assert.equal(await service.parseAndRefineProviderWithGemini(PROVIDERS_CONFIG[0],false),'skipped');
  assert.deepEqual(writes,[]);
});
test('grant seeds never overwrite live corrections or advance their verification dates',async()=>{
  const queries=[];const service=new GrantsService({query:async(sql,args)=>{queries.push({sql,args});return {rows:[],rowCount:0};}});
  await service.seedGrants();assert.ok(queries.length>0);
  for(const {sql,args} of queries){assert.match(sql,/ON CONFLICT \(external_id\) DO NOTHING/);assert.doesNotMatch(sql,/last_verified_at = now/);assert.ok(args.at(-1));}
});
test('grant verification rotates through persisted opportunities with a bounded configurable batch',async t=>{
  const before=process.env.GRANTS_VERIFY_BATCH_SIZE;process.env.GRANTS_VERIFY_BATCH_SIZE='2';
  t.after(()=>{if(before===undefined)delete process.env.GRANTS_VERIFY_BATCH_SIZE;else process.env.GRANTS_VERIFY_BATCH_SIZE=before;});
  const service=new GrantsService({query:async(sql,args)=>{assert.match(sql,/ORDER BY last_verified_at ASC/);assert.equal(args[0],2);return {rows:[{externalId:'discovered-program',url:'https://grant.example',status:'active'}]};}});
  const result=await service.verificationTargets();assert.equal(result[0].externalId,'discovered-program');
});
