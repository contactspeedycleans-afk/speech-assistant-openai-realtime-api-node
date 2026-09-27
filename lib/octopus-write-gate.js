import { randomUUID, timingSafeEqual } from 'node:crypto';

export const pausedWriteResult = () => ({success:false, outcome:'octopus_writes_paused', needsStaffReview:true, retry_booking:false,
  error:'External booking changes are paused. Staff must review this request; do not retry or claim it was saved.'});
export function createOctopusWriteGate(env = process.env) {
  const instanceId = randomUUID(), active = new Map();
  let draining = false, unknown = 0;
  const envPaused = () => !['', 'false'].includes(String(env.OCTOPUS_WRITES_PAUSED || '').trim().toLowerCase());
  const paused = () => draining || envPaused() || unknown > 0;
  function begin(kind) {
    if (paused()) throw Object.assign(new Error('OCTOPUS_WRITES_PAUSED'), {code:'OCTOPUS_WRITES_PAUSED'});
    const id = randomUUID(); active.set(id, {kind, startedAt:new Date().toISOString()});
    let finished = false;
    return (verified = true) => {if (!finished) {finished=true;active.delete(id);if (!verified) unknown++;}};
  }
  async function run(kind, operation, verified = () => true) {
    const finish = begin(kind);
    try {const result = await operation();finish(verified(result));return result;}
    catch(error) {finish(false);throw error;}
  }
  function status() {
    const activeByKind = {}; for (const item of active.values()) activeByKind[item.kind]=(activeByKind[item.kind]||0)+1;
    return {instanceId,processLocal:true,paused:paused(),restartSafe:envPaused(),active:active.size,activeByKind,
      oldestStartedAt:active.values().next().value?.startedAt || null,unknown,drained:paused() && active.size===0,
      safeToCutover:paused() && active.size===0 && unknown===0};
  }
  return {begin,run,paused,status,drain(){draining=true;return status();}};
}
export const octopusWriteGate = createOctopusWriteGate();

export function verifiedProcessOutput(result) {
  const stdout = String(result?.stdout || '');
  const line = stdout.split(/\r?\n/).find(line=>/^LISA_(?:BOOKING|ASSIGN|NOTE_UPDATE)_RESULT=/.test(line));
  if (!line) return false;
  try {const data=JSON.parse(line.slice(line.indexOf('=')+1));return data.success===true || data.ok===true;} catch {return false;}
}

export function registerOctopusWriteRoutes(app, gate, queue, env=process.env) {
  async function handler(request, reply) {
    reply.header('Cache-Control','no-store');
    const expected=String(env.LISA_ACTION_SECRET || '').trim(), supplied=String(request.headers['x-lisa-secret'] || '').trim();
    if (!expected || Buffer.byteLength(expected)!==Buffer.byteLength(supplied) || !timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)))
      return reply.code(401).send({success:false,outcome:'unauthorized'});
    if (request.method==='POST') {
      if (request.body?.action!=='drain' || Object.keys(request.body).some(k=>k!=='action')) return reply.code(400).send({success:false,outcome:'drain_only'});
      gate.drain();
    }
    try {const notes=await queue.status();const state=gate.status();return reply.send({...state,notes,
      safeToCutover:state.safeToCutover && notes.running===0 && notes.unknown===0});}
    catch {return reply.code(503).send({...gate.status(),safeToCutover:false,outcome:'queue_status_unavailable'});}
  }
  app.get('/internal/octopus-writes',handler);app.post('/internal/octopus-writes',handler);
}
