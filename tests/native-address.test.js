import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNativeAddress,nativeAddressAction} from '../lib/native-address.js';
const jason={streetNumber:'746',street:'Northwest 170 Terrace',city:'Pembroke Pines',state:'FL',zip:'33028'};
test('real complete Jason address survives lookup miss with explicit confirmation and no booking claim',async()=>{
 const r=await resolveNativeAddress(jason,{lookup:async()=>[]});assert.equal(r.success,true);assert.equal(r.normalizedAddress,'746 Northwest 170 Terrace, Pembroke Pines, FL 33028');assert.equal(r.addressConfirmed,false);assert.equal(r.bookingCreated,false);assert.equal(r.needsStaffReview,undefined);
});
test('provider outage uses complete supplied address; incomplete address asks only missing part',async()=>{
 const r=await resolveNativeAddress(jason,{lookup:async()=>{throw Error('offline');}});assert.equal(r.success,true);
 const missing=await resolveNativeAddress({streetNumber:'746',street:'NW 170 Terrace'},{lookup:async()=>[]});assert.equal(missing.success,false);assert.deepEqual(missing.missingFields,['city','state']);
});
test('unique close spelling/direction suggestion requires explicit confirmation and preserves original',async()=>{
 const r=await resolveNativeAddress(jason,{lookup:async()=>[{...jason,street:'NW 170 Ter'}]});assert.equal(r.lookupMatched,true);assert.equal(r.originalAddress.street,'Northwest 170 Terrace');assert.equal(r.addressConfirmed,false);
});
test('ties, unrelated house numbers and other states are not silently substituted',async()=>{
 for(const found of [[{...jason,streetNumber:'744'}],[{...jason,state:'MI'}],[jason,jason]]){
  const r=await resolveNativeAddress(jason,{lookup:async()=>found});assert.equal(r.lookupMatched,false);assert.equal(r.address.streetNumber,'746');assert.equal(r.address.state,'FL');
 }
});
test('only verified native lookup action bypasses old write guard; failed authority and all writes remain guarded',async()=>{
 const native={outcome:'native_action_requires_staff'};
 assert.equal((await nativeAddressAction('lookup_address',jason,native,{lookup:async()=>[]})).success,true);
 for(const action of ['create','create_fast','draft_fast','finalize_fast','cancel','reschedule'])assert.equal(await nativeAddressAction(action,jason,native),null);
 for(const outcome of ['source_tenant_mismatch','source_authority_unavailable','source_mode_conflict'])assert.equal(await nativeAddressAction('lookup_address',jason,{outcome}),null);
 assert.equal(await nativeAddressAction('lookup_address',jason,null),null);
});
test('structured unit remains in spoken address and stored line without changing original street',async()=>{
 const r=await resolveNativeAddress({...jason,unit:'2'},{lookup:async()=>[]});assert.match(r.addressLine1,/Unit 2/);assert.match(r.normalizedAddress,/Unit 2/);assert.equal(r.originalAddress.street,jason.street);
});
test('existing OpenAI read search uses fixed endpoint and authorization; bad output only falls back to entered address',async()=>{
 let called=0;const r=await resolveNativeAddress(jason,{env:{OPENAI_API_KEY:'unit-key'},fetcher:async(url,options)=>{called++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.headers.Authorization,'Bearer unit-key');assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).tools[0].type,'web_search_preview');return Response.json({output:[]});}});assert.equal(called,1);assert.equal(r.success,true);assert.equal(r.lookupMatched,false);
});
import fs from 'node:fs';
test('actual authenticated action block routes native address reads and still rejects legacy writes',async()=>{
 const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
 const start=source.indexOf("            if (!(action === 'reconcile_notes' && body.bookingSystem === 'genie_crm' && body.genieJobId)) {");
 const end=source.indexOf("            if (!['lookup','lookup_address','reconcile_notes'].includes(action)",start);
 assert.ok(start>=0&&end>start);
 const run=new (Object.getPrototypeOf(async function(){}).constructor)('action','body','reply','legacyActionGuard','nativeAddressAction',source.slice(start,end));
 const reply={status:200,code(value){this.status=value;return this;},send(value){return value;}};
 let called=0;
 const native=async(action,body,blocked)=>{called++;return nativeAddressAction(action,body,blocked,{lookup:async()=>[]});};
 const result=await run('lookup_address',jason,reply,async()=>({outcome:'native_action_requires_staff'}),native);
 assert.equal(result.success,true);assert.equal(reply.status,200);assert.equal(called,1);
 const blocked=await run('create_fast',jason,reply,async()=>({outcome:'native_action_requires_staff',success:false}),native);
 assert.equal(blocked.success,false);assert.equal(reply.status,409);
});
