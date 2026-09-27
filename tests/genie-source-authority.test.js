import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyActionGuard} from '../lib/genie-source-authority.js';
import {createOpenAiToolHandlers} from '../lib/openAiToolHandlers.js';
const env={GENIE_CRM_SYNC_SECRET:'unit-secret',GENIE_CRM_BUSINESS_ID:'tenant'};
const result=mode=>({ok:true,sourceMode:mode,authoritative:mode==='native',businessId:'tenant'});
const response=data=>async()=>Response.json(data);
test('native source blocks legacy actions and fixed endpoint does not accept caller authority',async()=>{
 const seen=[];const blocked=await legacyActionGuard(async(url,options)=>{seen.push({url,options});return Response.json(result('native'));},env);
 assert.equal(blocked.outcome,'native_action_requires_staff');assert.equal(blocked.success,false);
 assert.equal(seen[0].url,'https://getgeniecaller.com/api/integrations/lisa/job-context');
 assert.equal(seen[0].options.headers['x-sync-secret'],'unit-secret');
});
test('healthy mirror and predeployment outage preserve legacy path',async()=>{
 assert.equal(await legacyActionGuard(response(result('mirror')),env),null);
 assert.equal(await legacyActionGuard(async()=>{throw Error('offline');},env),null);
 assert.equal(await legacyActionGuard(null,{}),null);
});
test('persistent native mode fails closed across outage, absent credentials, wrong mode, malformed response',async()=>{
 const native={...env,GENIE_CRM_SOURCE_MODE:'native'};
 for(const fetcher of [async()=>{throw Error('offline');},response(result('mirror')),response({}),async()=>new Response('',{status:503})]){
  assert.equal((await legacyActionGuard(fetcher,native)).needsStaffReview,true);
 }
 assert.equal((await legacyActionGuard(null,{GENIE_CRM_SOURCE_MODE:'native'})).outcome,'source_authority_unavailable');
});
test('wrong tenant is rejected in both modes and native requires configured tenant',async()=>{
 for(const mode of ['native','mirror'])assert.equal((await legacyActionGuard(response({...result(mode),businessId:'other'}),env)).outcome,'source_tenant_mismatch');
 assert.equal((await legacyActionGuard(response(result('native')),{GENIE_CRM_SYNC_SECRET:'unit-secret'})).outcome,'source_authority_unavailable');
 assert.equal((await legacyActionGuard(response({sourceMode:'native'}),env)).outcome,'source_authority_unavailable');
});
test('direct cancel/reschedule tools cannot bypass persistent native setting',async()=>{
 const old=process.env.GENIE_CRM_SOURCE_MODE,secret=process.env.GENIE_CRM_SYNC_SECRET;
 process.env.GENIE_CRM_SOURCE_MODE='native';delete process.env.GENIE_CRM_SYNC_SECRET;
 try{
  const handlers=createOpenAiToolHandlers({});
  for(const action of [handlers.cancelBookingAction,handlers.rescheduleBookingAction]){
   const result=await action({bookingId:'123',customerConfirmed:true,requestedDate:'2026-10-01',requestedStartTime:'10:00'});
   assert.equal(result.needsStaffReview,true);assert.equal(result.success,false);
  }
 }finally{if(old===undefined)delete process.env.GENIE_CRM_SOURCE_MODE;else process.env.GENIE_CRM_SOURCE_MODE=old;if(secret===undefined)delete process.env.GENIE_CRM_SYNC_SECRET;else process.env.GENIE_CRM_SYNC_SECRET=secret;}
});
