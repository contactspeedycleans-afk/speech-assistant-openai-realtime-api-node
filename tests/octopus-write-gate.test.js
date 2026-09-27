import {EventEmitter} from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createOctopusWriteGate,registerOctopusWriteRoutes,verifiedProcessOutput} from '../lib/octopus-write-gate.js';
import {createOpenAiToolHandlers} from '../lib/openAiToolHandlers.js';

test('persistent pause fails closed and drain preserves work already admitted',async()=>{
 for (const value of ['true','TRUE','typo','0']) {const g=createOctopusWriteGate({OCTOPUS_WRITES_PAUSED:value});assert.equal(g.status().restartSafe,true);await assert.rejects(g.run('create',()=>assert.fail()),/PAUSED/);}
 for (const value of ['', 'false']) assert.equal(createOctopusWriteGate({OCTOPUS_WRITES_PAUSED:value}).paused(),false);
 const gate=createOctopusWriteGate({});let finish;const pending=gate.run('notes',()=>new Promise(resolve=>finish=resolve));
 assert.equal(gate.drain().active,1);assert.equal(gate.status().drained,false);assert.equal(gate.status().restartSafe,false);
 await assert.rejects(gate.run('create',()=>assert.fail()),/PAUSED/);finish('saved');assert.equal(await pending,'saved');assert.equal(gate.status().safeToCutover,true);
});
test('unknown result latches new writes and is not reported safe after drain',async()=>{
 const gate=createOctopusWriteGate({});await assert.rejects(gate.run('notes',async()=>{throw Error('timeout after dispatch');}),/timeout/);
 assert.equal(gate.status().unknown,1);assert.equal(gate.status().safeToCutover,false);await assert.rejects(gate.run('notes',()=>assert.fail()),/PAUSED/);
 gate.drain();assert.equal(gate.status().safeToCutover,false);
 const g=createOctopusWriteGate({});await g.run('create',async()=>({success:false}),r=>r.success);assert.equal(g.status().unknown,1);
});
test('authenticated status/drain exposes counts only; no resume or unconfigured auth',async()=>{
 const handlers={};const app={get:(p,h)=>handlers.GET=h,post:(p,h)=>handlers.POST=h};
 const gate=createOctopusWriteGate({});const queue={status:async()=>({queued:2,held:1,running:0,unknown:0})};registerOctopusWriteRoutes(app,gate,queue,{LISA_ACTION_SECRET:'private-test'});
 const call=async(method,secret,body)=>{let status=200,data;const reply={header(){return this;},code(s){status=s;return this;},send(d){data=d;return d;}};await handlers[method]({method,headers:{'x-lisa-secret':secret},body},reply);return{status,data};};
 assert.equal((await call('POST','wrong',{action:'drain'})).status,401);assert.equal(gate.paused(),false);
 assert.equal((await call('POST','private-test',{action:'resume'})).status,400);
 const result=await call('POST','private-test',{action:'drain'});assert.equal(result.data.safeToCutover,true);assert.equal(result.data.notes.held,1);assert.equal(JSON.stringify(result).includes('private-test'),false);
 queue.status=async()=>({running:1,unknown:0});assert.equal((await call('GET','private-test')).data.safeToCutover,false);
 queue.status=async()=>{throw Error('private SQL');};assert.equal((await call('GET','private-test')).status,503);
});
test('direct voice cancellation/reschedule cannot bypass persisted pause',async()=>{
 const previous=process.env.OCTOPUS_WRITES_PAUSED;process.env.OCTOPUS_WRITES_PAUSED='true';
 try{const handlers=createOpenAiToolHandlers({});for(const fn of [handlers.cancelBookingAction,handlers.rescheduleBookingAction]){
 const result=await fn({bookingId:'123456',customerConfirmed:true,requestedDate:'2026-10-01',requestedStartTime:'09:00'});assert.equal(result.outcome,'octopus_writes_paused');assert.equal(result.retry_booking,false);}}
 finally{if(previous===undefined)delete process.env.OCTOPUS_WRITES_PAUSED;else process.env.OCTOPUS_WRITES_PAUSED=previous;}
});
test('actual direct subprocess adapter blocks creates/assignments but permits read lookup',async()=>{
 const source=readFileSync(new URL('../index.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');const code=source.slice(source.indexOf('const execFileAsync ='),source.indexOf('\n\nif (process.env.LISA_BOOKING_PROFILE_TEST)'));
 let calls=0;const gate=createOctopusWriteGate({OCTOPUS_WRITES_PAUSED:'true'});
 const adapter=Function('rawExecFileAsync','octopusWriteGate','verifiedProcessOutput',code+';return execFileAsync;')(async()=>{calls++;return{stdout:''};},gate,verifiedProcessOutput);
 for(const args of [['playwright/octopus-create-booking.js'],['playwright/octopus-booking-actions.js','assign']]) await assert.rejects(adapter('node',args,{}),/PAUSED/);
 await adapter('node',['playwright/octopus-create-booking.js'],{env:{LISA_BOOKING_PAYLOAD:JSON.stringify({action:'lookup_address'})}});
 await adapter('node',['playwright/octopus-live-lookup.js'],{});assert.equal(calls,2);
});

test('verified BOK returns promptly but lease remains until post-result child work closes',async()=>{
 const gate=createOctopusWriteGate({});const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
 const result=await gate.runChild('create_fast',async bind=>{bind(child);return{success:true};});
 assert.equal(result.success,true);assert.equal(gate.drain().active,1);assert.equal(gate.status().safeToCutover,false);
 child.emit('close',0,null);assert.equal(gate.status().active,0);assert.equal(gate.status().safeToCutover,true);
});
test('post-result child failure is unknown and never silently reopened',async()=>{
 const gate=createOctopusWriteGate({});const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
 await gate.runChild('finalize_fast',async bind=>{bind(child);return{success:true};});child.emit('close',null,'SIGTERM');
 assert.equal(gate.status().unknown,1);assert.equal(gate.status().safeToCutover,false);
 await assert.rejects(gate.run('create',()=>assert.fail()),/PAUSED/);
});
test('actual voice creation retains drain accounting through cache and success webhook',async()=>{
 const source=readFileSync(new URL('../index.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const start=source.indexOf('    createBookingAction: async payload => {');const end=source.indexOf('\n    db\n});',start);
 const gate=createOctopusWriteGate({});let finishCache,finishHook;const cache=new Promise(r=>finishCache=r),hook=new Promise(r=>finishHook=r);
 const action=Function('octopusWriteGate','finalizeFastBooking','cacheLisaCreatedBooking','sendFastBookingSuccessWebhook','return ({'+source.slice(start,end)+'}).createBookingAction;')(
 gate,async()=>({success:true,bookingId:'123456',bookingNumber:'BOK-1'}),async()=>cache,async()=>hook);
 const pending=action({phase:'finalize'});await new Promise(r=>setImmediate(r));assert.equal(gate.drain().active,1);
 finishCache();await new Promise(r=>setImmediate(r));assert.equal(gate.status().active,1);finishHook();assert.equal((await pending).success,true);assert.equal(gate.status().active,0);
});
