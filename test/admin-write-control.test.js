import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createBridgeWriteGate, createBridgeWriteControl } from '../playwright/octopus-write-control.js';
const source = readFileSync(new URL('../playwright/octopus-admin-mcp.js', import.meta.url), 'utf8');
const request = (body, secret = 'fixture', method = 'POST') => ({url:'/internal/octopus-writes', method,
  headers:{'x-genie-secret':secret}, async *[Symbol.asyncIterator]() {yield JSON.stringify(body);}});
const response = () => ({writeHead(code,headers){this.code=code;this.headers=headers;},end(raw){this.body=JSON.parse(raw);}});
const defer = () => {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('default mirror is unchanged; explicit pause/native/invalid settings fail closed', async () => {
  for (const env of [{},{OCTOPUS_WRITES_PAUSED:'false'},{GENIE_CRM_SOURCE_MODE:'mirror'}]) {
    const gate=createBridgeWriteGate(env);assert.equal(await gate.run('write',async()=>42),42);assert.equal(gate.status().paused,false);
  }
  for (const env of [{OCTOPUS_WRITES_PAUSED:'true'},{OCTOPUS_WRITES_PAUSED:'typo'},
    {GENIE_CRM_SOURCE_MODE:'native'},{GENIE_CRM_SOURCE_MODE:'typo',OCTOPUS_WRITES_PAUSED:'false'}]) {
    const gate=createBridgeWriteGate(env);await assert.rejects(gate.run('write',()=>assert.fail()),{code:'OCTOPUS_WRITES_PAUSED'});
    assert.equal(gate.status().restartSafe,true);
  }
});

test('drain leaves current operation running and denies every fresh admission',async()=>{
  const gate=createBridgeWriteGate({}),d=defer();const work=gate.run('assignment',()=>d.promise);
  const state=gate.drain();assert.equal(state.active,1);assert.equal(state.drained,false);
  await assert.rejects(gate.run('cancel',()=>assert.fail()),{code:'OCTOPUS_WRITES_PAUSED'});
  d.resolve('verified');assert.equal(await work,'verified');assert.equal(gate.status().drained,true);
  assert.equal(gate.status().restartSafe,false);assert.equal(gate.status().globalCutoverReady,false);
});

test('failed existing work remains uncertain and active counter releases',async()=>{
  const gate=createBridgeWriteGate({});await assert.rejects(gate.run('reschedule',async()=>{throw Error('timeout');}));
  assert.equal(gate.status().active,0);assert.equal(gate.status().uncertain,1);
  assert.equal(gate.drain().uncertain,1);
  await assert.rejects(gate.run('retry',()=>assert.fail()),{code:'OCTOPUS_WRITES_PAUSED'});
});

test('authenticated control is bounded, read-only on GET, and has no resume action',async()=>{
  const gate=createBridgeWriteGate({}),handle=createBridgeWriteControl(gate,{GENIE_CRM_SYNC_SECRET:'fixture'});
  for(const secret of ['', 'wrong']){const res=response();await handle(request({action:'drain'},secret),res);assert.equal(res.code,401);assert.equal(gate.status().paused,false);}
  let res=response();await handle(request({},'fixture','GET'),res);assert.equal(res.body.paused,false);assert.equal(res.headers['cache-control'],'no-store');
  res=response();await handle(request({action:'resume'}),res);assert.equal(res.code,400);
  res=response();await handle(request({action:'drain',extra:'x'.repeat(513)}),res);assert.equal(res.code,413);assert.equal(gate.status().paused,false);
  res=response();await handle(request({action:'drain'}),res);assert.equal(res.code,200);assert.equal(res.body.drained,true);
  assert.equal(JSON.stringify(res.body).includes('fixture'),false);
});

test('actual MCP dispatcher blocks all three writes while retaining read tools',async()=>{
  const gate=createBridgeWriteGate({OCTOPUS_WRITES_PAUSED:'true'}),called=[];
  const code=source.slice(source.indexOf('const mutatingToolNames'),source.indexOf('async function callToolUnlocked'));
  const context=vm.createContext({octopusWrites:gate,Set,callToolUnlocked:async(name)=>{called.push(name);return 'read';}});
  vm.runInContext(code,context);
  for(const name of ['create_booking','reschedule_booking','cancel_booking']) await assert.rejects(context.callTool(name,{}),{code:'OCTOPUS_WRITES_PAUSED'});
  for(const name of ['octopus_login_health','get_booking','inspect_booking_billing','search_clients_and_bookings','get_client_history','get_booking_page','lookup_address']) assert.equal(await context.callTool(name,{}),'read');
  assert.equal(called.length,7);
});

test('actual assignment primitive cannot bypass pause',async()=>{
  const code=source.slice(source.indexOf('async function assignExistingBookingByName('),source.indexOf('async function assignExistingBookingByNameUnlocked'));
  const context=vm.createContext({octopusWrites:createBridgeWriteGate({OCTOPUS_WRITES_PAUSED:'true'}),assignExistingBookingByNameUnlocked:()=>assert.fail()});
  vm.runInContext(code,context);await assert.rejects(context.assignExistingBookingByName('123','Worker'),{code:'OCTOPUS_WRITES_PAUSED'});
});

test('returned assignment verification failure latches admission despite changed:false',async()=>{
  const code=source.slice(source.indexOf('async function assignExistingBookingByName('),source.indexOf('async function assignExistingBookingByNameUnlocked'));
  const gate=createBridgeWriteGate({});let calls=0;
  const context=vm.createContext({octopusWrites:gate,assignExistingBookingByNameUnlocked:async()=>{calls++;return {success:false,changed:false,outcome:'assignment_verification_failed'};}});
  vm.runInContext(code,context);await context.assignExistingBookingByName('123','Worker');
  assert.equal(gate.status().uncertain,1);assert.equal(gate.status().paused,true);
  await assert.rejects(context.assignExistingBookingByName('123','Worker'),{code:'OCTOPUS_WRITES_PAUSED'});assert.equal(calls,1);
});

test('actual MCP dispatcher requires verified results; known duplicate rejection is no-write',async()=>{
  const code=source.slice(source.indexOf('const mutatingToolNames'),source.indexOf('async function callToolUnlocked'));
  for(const [name,result] of [['create_booking',{success:false}],['cancel_booking',{ok:true,verified_cancelled_in_octopus:false}],
    ['reschedule_booking',{ok:false,changed:false}]]) {
    const gate=createBridgeWriteGate({});let calls=0;
    const context=vm.createContext({octopusWrites:gate,Set,callToolUnlocked:async()=>{calls++;return result;}});
    vm.runInContext(code,context);await context.callTool(name,{});assert.equal(gate.status().uncertain,1);
    await assert.rejects(context.callTool(name,{}),{code:'OCTOPUS_WRITES_PAUSED'});assert.equal(calls,1);
  }
  const gate=createBridgeWriteGate({});const context=vm.createContext({octopusWrites:gate,Set,
    callToolUnlocked:async()=>({success:false,outcome:'duplicate_booking_blocked'})});
  vm.runInContext(code,context);await context.callTool('create_booking',{});
  assert.equal(gate.status().uncertain,0);assert.equal(gate.status().paused,false);
});

test('read-only booking page cannot navigate arbitrary admin action URLs',async()=>{
  let pages=0;
  const code=source.slice(source.indexOf('async function callToolUnlocked'),source.indexOf('const protectedMetadata'));
  const context=vm.createContext({withPage:async()=>{pages++;return {read:true};}});
  vm.runInContext(code,context);
  for(const url of ['https://admin.octopuspro.com/booking/delete/123','https://admin.octopuspro.com/customer/edit/123',
    'https://admin.octopuspro.com/booking/view/123?action=cancel','https://elsewhere.invalid/booking/view/123']) {
    await assert.rejects(context.callToolUnlocked('get_booking_page',{booking_url:url}),/read-only/);
  }
  await context.callToolUnlocked('get_booking_page',{booking_url:'https://admin.octopuspro.com/booking/view/123'});
  assert.equal(pages,1);
});

test('configured startup customer edit is held without reading its contents or replaying',async()=>{
  const gate=createBridgeWriteGate({OCTOPUS_WRITES_PAUSED:'true'});
  const code=source.slice(source.indexOf('async function runTargetedCustomerNameFix(){'),source.indexOf('async function runTargetedCustomerNameFixUnlocked'));
  const context=vm.createContext({process:{env:{OCTOPUS_TARGET_CUSTOMER_NAME_FIX:'private fixture'}},console:{log(){}},octopusWrites:gate,runTargetedCustomerNameFixUnlocked:()=>assert.fail()});
  vm.runInContext(code,context);await context.runTargetedCustomerNameFix();await context.runTargetedCustomerNameFix();
  assert.equal(gate.status().active,0);assert.equal(gate.status().held,1);
});

test('actual HTTP dispatch exposes drain before other routes and retains health',async()=>{
  let handler;const gate=createBridgeWriteGate({OCTOPUS_WRITES_PAUSED:'true'});
  const control=createBridgeWriteControl(gate,{GENIE_CRM_SYNC_SECRET:'fixture'});
  const context=vm.createContext({http:{createServer(fn){handler=fn;return {listen(){}};}},URL,BASE:'https://test.invalid',PORT:3000,
    handleWriteControl:control,GENIE_SECRET:'fixture',body:async(req)=>{let raw='';for await(const chunk of req)raw+=chunk;return raw;},
    assignExistingBookingByName:()=>gate.run('assign',()=>assert.fail()),console:{error(){}},
    json:(res,code,data,headers={})=>{res.writeHead(code,headers);res.end(JSON.stringify(data));}});
  vm.runInContext(source.slice(source.indexOf('const server=http.createServer'),source.indexOf('server.listen(')),context);
  let res=response();await handler({...request({},'fixture','GET'),url:'/health'},res);assert.equal(res.code,200);
  res=response();await handler(request({},'fixture','GET'),res);assert.equal(res.body.paused,true);
  res=response();await handler({...request({bookingId:'123',cleanerName:'Fixture'}),url:'/internal/assign-booking'},res);assert.equal(res.code,409);assert.equal(res.body.outcome,'octopus_writes_paused');
});
