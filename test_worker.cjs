const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(__dirname + '/index.js', 'utf8');
const functions = source.slice(source.indexOf('function isReusableWarmBookingWorker'), source.indexOf('async function runWithWarmBookingWorker'));
const marker = source.slice(source.indexOf('function waitForWorkerMarker'), source.indexOf('function beginFastBookingDraft'));
function worker(overrides = {}) {
  const child = new EventEmitter();
  child.exitCode = null; child.killed = false;
  child.stdin = { writable: true, destroyed: false };
  child.stdout = new EventEmitter();
  child.kill = () => { child.killed = true; };
  return { child, readyAt: Date.now(), claimed: false, getStdout: () => '', getStderr: () => '', ...overrides };
}
function context(first) {
  const ctx = vm.createContext({ console: {warn() {}}, Date, setTimeout, clearTimeout, first, makeWorker: worker });
  vm.runInContext('let warmBookingWorkerPromise = Promise.resolve(first); function ensureWarmBookingWorker() { return warmBookingWorkerPromise ||= Promise.resolve(makeWorker()); }' + functions + marker, ctx);
  return ctx;
}
test('rejects failed worker even while stdin is writable', () => {
  const ctx = context(worker());
  assert.equal(ctx.isReusableWarmBookingWorker(worker({getStdout: () => 'LISA_BOOKING_DRAFT_FAILED={"error":"PREWARM_PAYLOAD_TIMEOUT"}'})), false);
});
test('replaces waiting browser before its 30-minute timeout', async () => {
  const old = worker({readyAt: Date.now() - 26*60*1000});
  const ctx = context(old);
  const fresh = await ctx.acquireWritableWarmBookingWorker();
  assert.notEqual(fresh, old); assert.equal(old.child.killed, true); assert.equal(fresh.claimed, true);
});
test('concurrent calls reserve distinct browser processes', async () => {
  const first = worker(); const ctx = context(first);
  const [a,b] = await Promise.all([ctx.acquireWritableWarmBookingWorker(),ctx.acquireWritableWarmBookingWorker()]);
  assert.notEqual(a,b); assert.equal(a.claimed, true); assert.equal(b.claimed, true); assert.equal(a.child.killed, false);
});
test('already exited process rejects immediately instead of waiting 150 seconds', async () => {
  const dead = worker(); dead.child.exitCode = 1;
  const ctx = context(dead);
  await assert.rejects(ctx.waitForWorkerMarker(dead, 'LISA_BOOKING_DRAFT_READY=', 150000), /WORKER_FAILED/);
});
test('failure marker cannot be mistaken for readiness', async () => {
  const failed = worker({getStdout: () => 'LISA_BOOKING_DRAFT_FAILED={"error":"PREWARM_PAYLOAD_TIMEOUT"}'});
  await assert.rejects(context(failed).waitForWorkerMarker(failed, 'LISA_BOOKING_DRAFT_READY=', 150000), /PREWARM_PAYLOAD_TIMEOUT/);
});
