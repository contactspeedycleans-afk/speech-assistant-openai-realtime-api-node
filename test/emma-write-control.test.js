import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createEmmaWriteGate,runEmmaMutation,registerEmmaWriteControl,STAFF_HANDOFF} from '../lib/emma-write-control.js';
import {createFastBookingAction} from '../lib/fastBookingAction.js';
import {createOpenAiToolHandlers} from '../lib/openAiToolHandlers.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function child(){const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>{c.killed=true;};return c;}
function marker(c,result){c.stdout.emit('data',Buffer.from(`===== BOOKING ACTION RESULT =====\n${JSON.stringify(result)}\n===== END BOOKING ACTION RESULT =====`));}
const ok={ok:true,verified_cancelled_in_octopus:true};
function reply(){return{status:200,headers:{},header(k,v){this.headers[k]=v;return this;},code(n){this.status=n;return this;},send(body){this.body=body;return body;}};}
test('empty/false mirror stays enabled; persisted pause and invalid modes fail closed',()=>{
  for(const env of [{},{OCTOPUS_WRITES_PAUSED:'false'}])assert.equal(createEmmaWriteGate(env).status().paused,false);
  for(const env of [{OCTOPUS_WRITES_PAUSED:'true'},{OCTOPUS_WRITES_PAUSED:'typo'},{GENIE_CRM_SOURCE_MODE:'native'},{GENIE_CRM_SOURCE_MODE:'typo'}]){
    const g=createEmmaWriteGate(env);assert.equal(g.status().restartSafe,true);assert.throws(()=>g.begin('x'),/office/);
  }
});
test('admitted child remains counted after result marker until actual close',async()=>{
  const g=createEmmaWriteGate({}),c=child();const p=runEmmaMutation('cancel',['123'],{gate:g,spawnImpl:()=>c});
  marker(c,ok);assert.equal(g.drain().active,1);assert.equal(g.status().drained,false);
  c.emit('close',0);assert.deepEqual(await p,ok);assert.equal(g.status().safeToCutover,true);
});
test('timeout latches uncertainty and retains child until close',async()=>{
  const g=createEmmaWriteGate({}),c=child();const p=runEmmaMutation('cancel',['123'],{gate:g,spawnImpl:()=>c,timeoutMs:5});
  await assert.rejects(p,/timed out/);assert.equal(c.killed,true);assert.equal(g.status().active,1);
  assert.equal(g.status().uncertain,1);assert.throws(()=>g.begin('retry'),/office/);
  c.emit('close',0);assert.equal(g.status().active,0);assert.equal(g.status().safeToCutover,false);
});
test('returned unverified result and nonzero exit latch new writes closed',async()=>{
  for(const exit of [0,1]){const g=createEmmaWriteGate({}),c=child();const p=runEmmaMutation('cancel',['123'],{gate:g,spawnImpl:()=>c});
    marker(c,exit===0?{ok:false}:ok);c.emit('close',exit);if(exit)await assert.rejects(p);else await p;
    assert.equal(g.status().uncertain,1);assert.equal(g.status().paused,true);
  }
});
test('fast creation remains counted when caller returns processing',async()=>{
  const g=createEmmaWriteGate({});let resolveFetch,done;
  const completion=new Promise(r=>done=r);
  const action=createFastBookingAction({octopusWrites:g,secret:'test',callerWaitMs:1,
    fetchImpl:()=>new Promise(r=>resolveFetch=r),onBackgroundComplete:done});
  assert.equal((await action({})).outcome,'processing');assert.equal(g.drain().active,1);
  resolveFetch(new Response(JSON.stringify({success:true,verified_created_in_octopus:true,bookingNumber:'BOK-1'})));
  await completion;assert.equal(g.status().safeToCutover,true);
});
test('paused fast create does not call external endpoint',async()=>{
  const g=createEmmaWriteGate({OCTOPUS_WRITES_PAUSED:'true'});let calls=0;
  const action=createFastBookingAction({octopusWrites:g,secret:'test',fetchImpl:async()=>{calls++;}});
  await assert.rejects(action({}),/office/);assert.equal(calls,0);
});
test('control requires existing secret and supports status/drain only',async()=>{
  let route;const g=createEmmaWriteGate({});registerEmmaWriteControl({route:r=>route=r},g,{SMS_WEBHOOK_SECRET:'test'});
  assert.equal(route.bodyLimit,512);let r=reply();await route.handler({method:'GET',headers:{}},r);assert.equal(r.status,401);
  r=reply();await route.handler({method:'POST',headers:{'x-lisa-secret':'test'},body:{action:'resume'}},r);assert.equal(r.status,400);
  r=reply();await route.handler({method:'POST',headers:{'x-lisa-secret':'test'},body:{action:'drain'}},r);assert.equal(r.body.drained,true);assert.equal(r.body.restartSafe,false);assert.equal(r.body.globalCutoverReady,false);
  assert.equal(r.headers['cache-control'],'no-store');
});
test('actual direct action helpers reject paused cancel/reschedule',async()=>{
  const g=createEmmaWriteGate({OCTOPUS_WRITES_PAUSED:'true'}),h=createOpenAiToolHandlers({octopusWrites:g,db:{query:async()=>({rows:[{internal_booking_id:'123'}]})}});
  const old=console.error;console.error=()=>{};
  try{for(const r of [await h.cancelBookingAction({bookingId:'123',customerConfirmed:true}),
    await h.rescheduleBookingAction({bookingId:'123',customerConfirmed:true,requestedDate:'2026-10-01',requestedStartTime:'10:00'})]){
    assert.equal(r.outcome,'staff_review_required');assert.equal(r.staffReviewRequired,true);assert.equal(r.customer_message,STAFF_HANDOFF);
  }}finally{console.error=old;}
});

function bookingRoute(g,exec,cache=async()=>{}){
  const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
  const match=source.match(/fastify\.post\(\s*'\/lisa\/booking-action',[\s\S]*?\n    \}\n\);/);assert.ok(match);
  let handler;
  new Function('fastify','octopusWrites','execFileAsync','process','cacheLisaCreatedBooking','STAFF_HANDOFF',match[0])(
    {post:(_p,h)=>handler=h},g,exec,{env:{LISA_ACTION_SECRET:'test'},execPath:'node',cwd:()=>'.'},cache,STAFF_HANDOFF);
  return handler;
}
const createBody={action:'create',customerConfirmed:true,customerName:'Fixture',streetNumber:'1',street:'Main',city:'Detroit',state:'MI',zip:'48000',requestedDate:'2026-10-01',requestedStartTime:'10:00'};
test('actual route blocks paused direct create but retains lookup',async()=>{
  let calls=0;const g=createEmmaWriteGate({OCTOPUS_WRITES_PAUSED:'true'}),h=bookingRoute(g,async()=>{calls++;return{stdout:'LISA_LOOKUP_RESULT={"success":true}',stderr:''};});
  const oldLog=console.log,oldErr=console.error;console.log=console.error=()=>{};
  try{let r=reply();await h({headers:{'x-lisa-secret':'test'},body:createBody},r);assert.equal(r.status,409);assert.equal(calls,0);
    r=reply();await h({headers:{'x-lisa-secret':'test'},body:{action:'lookup'}},r);assert.equal(calls,1);assert.equal(r.body.success,true);
  }finally{console.log=oldLog;console.error=oldErr;}
});
test('actual direct create remains counted through local completion receipt',async()=>{
  const g=createEmmaWriteGate({});let release;
  const h=bookingRoute(g,async()=>({stdout:'LISA_BOOKING_RESULT={"success":true,"bookingId":"123","bookingNumber":"BOK-1"}',stderr:''}),()=>new Promise(r=>release=r));
  const old=console.log;console.log=()=>{};
  try{const r=reply(),p=h({headers:{'x-lisa-secret':'test'},body:createBody},r);await tick();assert.equal(g.drain().active,1);
    release();await p;assert.equal(r.body.success,true);assert.equal(g.status().safeToCutover,true);
  }finally{console.log=old;}
});
