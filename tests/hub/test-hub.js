'use strict';
// Offline regression tests for windows/hub.js (review 2026-10-07 items 4, 15, 19, 22).
// Run from the monitor root: node tests/hub/test-hub.js   (exit 1 on any failure)
// hub.js is evaluated in a VM with fetch, timers, files, sockets and process spawning stubbed: no listener, no
// network, no toast is ever shown (toast() is replaced by a recorder).
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'windows', 'hub.js'), 'utf8');

function setup({ windows = false, fetchImpl } = {}) {
  let clock = Date.parse('2026-10-07T12:00:00Z');
  const calls = [], toasts = [], pending = [];
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } }
  const context = vm.createContext({
    module: { exports: {} }, __dirname: path.join(__dirname, 'no-such-dir'), Date: FakeDate,
    console: { log() {}, error() {} }, Buffer, AbortController, AbortSignal, Promise,
    setInterval() {}, setTimeout() {},
    process: { argv: ['node', 'hub.js', '--box', 'demo=19001=Demo box'], platform: windows ? 'win32' : 'linux', env: {}, on() {}, exit(n) { throw Error('exit ' + n); } },
    require(id) {
      if (id === 'node:path') return path;
      if (id === 'node:fs') return { readFileSync() { throw Error('stubbed'); }, writeFileSync() {} };
      if (id === 'node:child_process') return { spawn() { throw Error('must not spawn'); } };
      if (id === 'node:http') return { createServer() { return { on() {}, listen() {}, close() {} }; } };
      throw Error('unexpected require ' + id);
    },
    fetch(url, options) {
      calls.push(url);
      if (fetchImpl) return fetchImpl(url, options);
      return new Promise((resolve) => pending.push(() => resolve(response(url))));
    },
  });
  vm.runInContext(SOURCE + '\nmodule.exports = { cachedState, cachedHistory, notifyAllowance, notifyNews, buildState };', context);
  context.recordToast = (m) => toasts.push(m);
  vm.runInContext('toast = (message) => { recordToast(message); return true; };', context);
  return { api: context.module.exports, calls, toasts, pending, advance(ms) { clock += ms; },
    async finish() { await flush(); const p = pending.splice(0); p.forEach((f) => f()); await flush(); } };
}
const flush = () => new Promise((r) => setImmediate(r));
function response(url, custom) {
  const payload = custom || (url.includes('/api/history') ? { since: 1, until: 2, series: {} } : { generated_utc: '2026-10-07T12:00:00Z', host: {}, workers: [] });
  return { ok: true, body: (async function* () { yield Buffer.from(JSON.stringify(payload)); })() };
}
const seat = (alias, obs, used) => ({ live: true, w: { account: 'Demo account', alias, snapshot: { allowance: { provider: 'codex', observed_utc: obs, windows: [{ name: 'weekly', used_fraction: used }] } } } });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('#22 state: one fan-out while pending; the 10 s reuse starts at completion', async () => {
  const h = setup();
  const s1 = h.api.cachedState(); h.advance(11000); const s2 = h.api.cachedState(); h.advance(11000); const s3 = h.api.cachedState();
  await flush();
  assert.equal(h.calls.length, 1); assert.equal(s1, s2); assert.equal(s2, s3);
  await h.finish(); await s1;
  h.advance(9000); assert.equal(h.api.cachedState(), s1); // 9 s after completion: reused
  h.advance(2000); const s4 = h.api.cachedState(); await flush();
  assert.notEqual(s4, s1); assert.equal(h.calls.length, 2);
  await h.finish(); await s4;
});
test('#22 history: one fan-out per range while pending; ranges stay apart', async () => {
  const h = setup();
  const a = h.api.cachedHistory('30d'); h.advance(26000); const b = h.api.cachedHistory('30d'); h.advance(26000); const c = h.api.cachedHistory('30d');
  const d = h.api.cachedHistory('24h');
  await flush();
  assert.equal(a, b); assert.equal(b, c); assert.notEqual(a, d); assert.equal(h.calls.length, 2);
  await h.finish(); await Promise.all([a, d]);
});
test('#22 an unreachable box still settles the memo', async () => {
  let n = 0;
  const h = setup({ fetchImpl: () => { n++; return Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })); } });
  const r = await h.api.cachedState(); // boxState catches: the build itself resolves with the box marked unreachable
  assert.equal(r.boxes[0].ok, false); assert.equal(n, 1);
});
test('#4 allowance toast follows the newest reading, not the highest usage (R-ALLOWANCE)', () => {
  const h = setup({ windows: true });
  h.api.notifyAllowance([seat('A', '2026-10-07T10:00:00Z', 0.98), seat('B', '2026-10-07T11:59:00Z', 0.2)]);
  assert.deepEqual(h.toasts, []);
  const k = setup({ windows: true });
  k.api.notifyAllowance([seat('A', '2026-10-07T10:00:00Z', 0.2), seat('B', '2026-10-07T11:59:00Z', 0.95)]);
  assert.equal(k.toasts.length, 1); assert.match(k.toasts[0], /Demo account: weekly allowance at 95%/);
  const t = setup({ windows: true }); // equal times: the higher used fraction
  t.api.notifyAllowance([seat('A', '2026-10-07T11:00:00Z', 0.2), seat('B', '2026-10-07T11:00:00Z', 0.93)]);
  assert.equal(t.toasts.length, 1); assert.match(t.toasts[0], /93%/);
});
test('#15 a fresh pattern under failures.patterns yields exactly one toast', async () => {
  const h = setup({ windows: true, fetchImpl: (url) => Promise.resolve(response(url, { enabled: true, failures: { patterns: { synthetic_pattern: { first_seen: '2026-10-07T11:59:00Z', count: 1 } } } })) });
  await h.api.notifyNews();
  assert.equal(h.toasts.length, 1); assert.match(h.toasts[0], /synthetic_pattern x1/);
});
test('#15 an older backend with a top-level patterns still toasts', async () => {
  const h = setup({ windows: true, fetchImpl: (url) => Promise.resolve(response(url, { enabled: true, patterns: { old_pattern: { first_seen: '2026-10-07T11:58:00Z', count: 2 } } })) });
  await h.api.notifyNews();
  assert.equal(h.toasts.length, 1); assert.match(h.toasts[0], /old_pattern x2/);
});
test('#19 a non-array allowance.windows cannot break buildState', async () => {
  const bad = { generated_utc: '2026-10-07T12:00:00Z', host: {}, workers: [{ seat: 'seatx', alias: 'Demo seat', account: 'Demo account', snapshot: { allowance: { windows: {} } } },
    { seat: 'seaty', alias: 'Demo seat 2', account: 'Demo account', snapshot: { allowance: { windows: [null, 5, { name: 'weekly', used_fraction: 0.97 }], observed_utc: '2026-10-07T11:59:00Z' } } }] };
  const h = setup({ windows: true, fetchImpl: (url) => Promise.resolve(response(url, bad)) });
  const s = await h.api.buildState();
  assert.equal(s.boxes[0].ok, true); assert.equal(s.boxes[0].workers.length, 2);
  assert.equal(h.toasts.length, 1); // the valid seat still gets its existing allowance toast
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
  }
  console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
