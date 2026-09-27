import { randomUUID, timingSafeEqual } from 'node:crypto';

export function createBridgeWriteGate(env = process.env) {
  const pauseSetting = String(env.OCTOPUS_WRITES_PAUSED || '').trim().toLowerCase();
  const sourceMode = String(env.GENIE_CRM_SOURCE_MODE || 'mirror').trim().toLowerCase();
  const restartSafe = (pauseSetting !== '' && pauseSetting !== 'false') || sourceMode !== 'mirror';
  let paused = restartSafe, uncertain = 0;
  const active = new Map(), held = new Set(), instanceId = randomUUID();
  async function run(kind, operation, verified = () => true) {
    if (paused) throw Object.assign(new Error('Octopus updates are paused. Hand this request to staff; do not retry.'),
      { code: 'OCTOPUS_WRITES_PAUSED' });
    const id = randomUUID();
    active.set(id, { kind, startedAt: new Date().toISOString() });
    try {
      const result = await operation();
      if (!verified(result)) { uncertain++; paused = true; }
      return result;
    }
    catch (error) { uncertain++; paused = true; throw error; }
    finally { active.delete(id); }
  }
  function status() {
    const activeByKind = {};
    for (const item of active.values()) activeByKind[item.kind] = (activeByKind[item.kind] || 0) + 1;
    return { scope: 'admin_bridge_process_only', instanceId, paused, restartSafe,
      active: active.size, activeByKind, oldestStartedAt: active.values().next().value?.startedAt || null,
      queued: 0, held: held.size, uncertain, drained: paused && active.size === 0,
      globalCutoverReady: false };
  }
  return { run, status, hold(kind) { held.add(kind); }, drain() { paused = true; return status(); } };
}

export function createBridgeWriteControl(gate, env = process.env) {
  return async (req, res) => {
    if (req.url !== '/internal/octopus-writes') return false;
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const expected = Buffer.from(String(env.GENIE_CRM_SYNC_SECRET || '').trim());
    const supplied = Buffer.from(String(req.headers['x-genie-secret'] || '').trim());
    if (!expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      send(401, { success: false, error: 'Unauthorized' }); return true;
    }
    if (req.method === 'GET') { send(200, { success: true, ...gate.status() }); return true; }
    if (req.method !== 'POST') { send(405, { success: false, error: 'Use GET or POST' }); return true; }
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 512) { send(413, { success: false, error: 'Request too large' }); return true; }
      }
      const body = JSON.parse(raw);
      if (body?.action !== 'drain' || Object.keys(body).some(key => key !== 'action')) {
        send(400, { success: false, error: 'Only drain is supported' }); return true;
      }
      const state = gate.drain();
      send(state.drained ? 200 : 202, { success: true, ...state });
    } catch { send(400, { success: false, error: 'Invalid request' }); }
    return true;
  };
}
