import {randomUUID, timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';

export const STAFF_HANDOFF = 'Booking changes are paused. Please have the office handle this request; do not retry or say the appointment changed.';
export function createEmmaWriteGate(env = process.env) {
  const setting = String(env.OCTOPUS_WRITES_PAUSED || '').trim().toLowerCase();
  const mode = String(env.GENIE_CRM_SOURCE_MODE || 'mirror').trim().toLowerCase();
  const restartSafe = (setting !== '' && setting !== 'false') || mode !== 'mirror';
  let paused = restartSafe, uncertain = 0;
  const active = new Map(), instanceId = randomUUID();
  function begin(kind) {
    if (paused) throw Object.assign(new Error(STAFF_HANDOFF), {code:'OCTOPUS_WRITES_PAUSED'});
    const id = randomUUID(); active.set(id, {kind, startedAt:new Date().toISOString()});
    let unknown = false;
    return {uncertain() {if (!unknown) {unknown=true; uncertain++; paused=true;}}, finish() {active.delete(id);}};
  }
  async function run(kind, operation, verified = () => true) {
    const lease = begin(kind);
    try {const result=await operation(); if (!verified(result)) lease.uncertain(); return result;}
    catch(error) {lease.uncertain(); throw error;}
    finally {lease.finish();}
  }
  function status() {
    const activeByKind={}; for(const v of active.values()) activeByKind[v.kind]=(activeByKind[v.kind]||0)+1;
    return {scope:'emma_process_only',instanceId,paused,restartSafe,active:active.size,activeByKind,
      oldestStartedAt:active.values().next().value?.startedAt||null,queued:0,held:0,uncertain,
      drained:paused&&active.size===0,safeToCutover:paused&&active.size===0&&uncertain===0,globalCutoverReady:false};
  }
  return {begin,run,status,drain(){paused=true;return status();}};
}
let singleton;
export const getEmmaWriteGate = () => singleton ||= createEmmaWriteGate();

// A timeout rejects the caller promptly, but the admitted child remains active
// until its actual close event. Unknown results latch admission closed.
export function runEmmaMutation(action, args, {gate=getEmmaWriteGate(), spawnImpl=spawn, timeoutMs=180000}={}) {
  const lease=gate.begin(action);
  return new Promise((resolve,reject)=>{
    let child, settled=false, stdout='', stderr='', timer;
    const fail=error=>{lease.uncertain();if(!settled){settled=true;reject(error);}};
    try {child=spawnImpl(process.execPath,['playwright/octopus-booking-actions.js',action,...args.map(String)],
      {cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});}
    catch(error){fail(error);lease.finish();return;}
    timer=setTimeout(()=>{fail(new Error('Octopus operation timed out; office verification is required.'));child.kill('SIGTERM');},timeoutMs);
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
    child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    child.on('error',error=>{clearTimeout(timer);fail(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      try {
        if(settled)return;
        if(code!==0)throw new Error('Octopus operation exited without a clean result; office verification is required.');
        const match=stdout.match(/===== BOOKING ACTION RESULT =====\s*([\s\S]*?)\s*===== END BOOKING ACTION RESULT =====/);
        if(!match)throw new Error('Octopus operation returned no verified result; office verification is required.');
        const result=JSON.parse(match[1]);
        if(result.ok!==true||result[action==='cancel'?'verified_cancelled_in_octopus':'verified_rescheduled_in_octopus']!==true)lease.uncertain();
        settled=true;resolve(result);
      }catch(error){fail(error);}finally{lease.finish();}
    });
  });
}

export function registerEmmaWriteControl(app, gate=getEmmaWriteGate(), env=process.env) {
  app.route({method:['GET','POST'],url:'/internal/octopus-writes',bodyLimit:512,handler:async(req,reply)=>{
    reply.header('cache-control','no-store');
    const expected=Buffer.from(String(env.LISA_ACTION_SECRET||env.SMS_WEBHOOK_SECRET||'').trim());
    const supplied=Buffer.from(String(req.headers['x-lisa-secret']||'').trim());
    if(!expected.length||expected.length!==supplied.length||!timingSafeEqual(expected,supplied))return reply.code(401).send({success:false,error:'Unauthorized'});
    if(req.method==='GET')return reply.send({success:true,...gate.status()});
    const b=req.body;
    if(!b||Array.isArray(b)||b.action!=='drain'||Object.keys(b).some(k=>k!=='action'))return reply.code(400).send({success:false,error:'Only drain is supported'});
    const state=gate.drain(); return reply.code(state.drained?200:202).send({success:true,...state});
  }});
}
