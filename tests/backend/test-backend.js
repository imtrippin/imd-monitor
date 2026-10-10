'use strict';
// Offline regression tests for server/index.js (review 2026-10-07 items 4, 9, 11, 12, 16, 23, 25).
// Run from the monitor root: node --experimental-sqlite tests/backend/test-backend.js   (exit 1 on any failure)
// Synthetic fixtures only: a temp config, temp SQLite and temp watch_dir; every fetch is stubbed (no network).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imd-backend-test-'));
const watch = path.join(tmp, 'watch'), incoming = path.join(tmp, 'incoming');
fs.mkdirSync(watch); fs.mkdirSync(incoming);
const cfg = { port: 18799, watch_dir: watch, incoming_dir: incoming, db_path: path.join(tmp, 'hist.sqlite'), watch_config: path.join(tmp, 'watch.json'),
  workers: [{ seat: 'seatx', token: '2', runtime: 'codex', account: 'Demo account' }, { seat: 'seaty', token: '3', runtime: 'codex', account: 'Demo account' }],
  heavy_baseline: [{ seat: '2', key: 'build_contract_project', accepted: true, job: 'job-a' }] };
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
fs.writeFileSync(cfg.watch_config, JSON.stringify({ tokens: ['2', '3'] }));
process.env.IMD_MONITOR_CONFIG = path.join(tmp, 'config.json');

// the backend reads an export only when the seat's Linux user owns it; the fictional seats exist in no passwd file
const realRead = fs.readFileSync;
fs.readFileSync = function (p, ...a) { if (p === '/etc/passwd') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return realRead.call(this, p, ...a); };
let clock = Date.parse('2026-10-07T12:00:00Z');
Date.now = () => clock;
const calls = [];
let route = () => ({ status: 500, json: {} });
global.fetch = async (url) => {
  calls.push(url);
  const r = route(url); const body = r.raw ?? Buffer.from(JSON.stringify(r.json));
  return { ok: r.status === 200, status: r.status, headers: { get: (h) => (h === 'content-length' ? r.length ?? null : null) },
    body: (async function* () { for (let i = 0; i < body.length; i += 65536) yield body.subarray(i, i + 65536); })() };
};
const S = require('../../server/index.js');
const iso = (t) => new Date(t).toISOString();
const MIN = 60000, H = 3600000;
const writeWatch = (f, v) => fs.writeFileSync(path.join(watch, f), typeof v === 'string' ? v : JSON.stringify(v));
const goodSeats = [{ tokenId: 2, attempts: 10, accepted: 9, rejected: 0, failed: 1, pending: 0 }, { tokenId: '3', attempts: 4, accepted: 4, rejected: 0, failed: 0, pending: 0 }];

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('#11 baseline counts without a heavy log', () => {
  S._resetForTests();
  assert.equal(S.heavyByToken()['2']?.contract?.attempts, 1);
});
test('#11 a baseline row the log also holds is counted once; another job still counts', () => {
  const p = S.parseHeavy(JSON.stringify({ job: 'job-a', attempts: [{ seat: '2', key: 'build_contract_project', accepted: true, outcome: 'completed', at: iso(clock) }] }));
  assert.equal(p.by['2'].contract.attempts, 1);
  const q = S.parseHeavy(JSON.stringify({ job: 'job-b', attempts: [{ seat: '2', key: 'build_contract_project', accepted: true, at: iso(clock) }] }));
  assert.equal(q.by['2'].contract.attempts, 2);
});
test('#12 classifyAttempt precedence (R-RESULT)', () => {
  assert.equal(S.classifyAttempt({ accepted: true, outcome: 'failed' }), 'accepted');
  assert.equal(S.classifyAttempt({ outcome: 'failed', verdict: 'rejected', failure: 'runtime_error' }), 'failed');
  assert.equal(S.classifyAttempt({ failure: 'tests_failed', outcome: 'completed' }), 'failed');
  assert.equal(S.classifyAttempt({ verdict: 'rejected', outcome: 'completed' }), 'rejected');
  assert.equal(S.classifyAttempt({ outcome: 'completed', accepted: false, verdict: null }), 'submitted');
  assert.equal(S.classifyAttempt({ outcome: 'running' }), 'pending');
  assert.equal(S.classifyAttempt({}), 'pending');
});
test('#12 aggregates and heavy_recent rows use the same label', () => {
  const at = (m) => iso(clock - m * MIN);
  const p = S.parseHeavy([
    JSON.stringify({ job: 'j1', attempts: [{ seat: '3', key: 'build_contract_project', outcome: 'completed', accepted: false, at: at(1) }] }),
    JSON.stringify({ job: 'j2', attempts: [{ seat: '3', key: 'tests', outcome: 'failed', verdict: 'rejected', failure: 'runtime_error', at: at(2) }] }),
    JSON.stringify({ job: 'j3', attempts: [{ seat: '3', key: 'review', verdict: 'rejected', outcome: 'completed', at: at(3) }] }),
  ].join('\n'));
  const c = p.by['3'].contract;
  assert.deepEqual([c.attempts, c.submitted, c.pending, c.failed], [2, 1, 1, 1]);
  assert.equal(p.by['3'].review.rejected, 1);
  assert.deepEqual(p.recent['3'].map((r) => r.result), ['submitted', 'failed', 'rejected']);
});
test('#16 invalid watcher copies are refused', () => {
  const now = iso(clock);
  for (const bad of [{ error: 'busy' }, { fetched_at: now, error: 'busy', seats: goodSeats }, { fetched_at: now, seats: [] }, { fetched_at: now, seats: [{ wrong: true }] },
    { fetched_at: now, seats: [{ tokenId: 2, attempts: '10', accepted: 9 }] }, { fetched_at: now, seats: [{ tokenId: 2, accepted: 9 }] },
    { fetched_at: iso(clock + H), seats: goodSeats }, { fetched_at: 'yesterday-ish', seats: goodSeats }, { fetched_at: iso(clock - 13 * MIN), seats: goodSeats }]) {
    writeWatch('records-latest.json', bad);
    assert.equal(S.watcherRecords(), null, JSON.stringify(bad).slice(0, 80));
  }
  writeWatch('records-latest.json', '{broken');
  assert.equal(S.watcherRecords(), null);
  writeWatch('records-latest.json', { fetched_at: iso(clock + MIN), seats: goodSeats }); // small clock skew is fine
  assert.deepEqual(Object.keys(S.watcherRecords().data).sort(), ['2', '3']);
});
test('#16 an invalid copy plus a failed or invalid own read keeps the last good records with an error', async () => {
  S._resetForTests();
  writeWatch('records-latest.json', { fetched_at: iso(clock), seats: goodSeats });
  await S.loadRecords();
  clock += 11 * MIN;
  writeWatch('records-latest.json', { fetched_at: iso(clock), error: 'shared memory' });
  route = (u) => (u.endsWith('/seats/records') ? { status: 200, json: { error: 'busy' } } : { status: 500, json: {} });
  const r = await S.seatRecords();
  assert.equal(r.data['2'].accepted, 9);
  assert.match(r.error, /bad records/);
  clock += 11 * MIN;
  route = () => ({ status: 503, json: {} });
  const r2 = await S.seatRecords();
  assert.equal(r2.data['3'].accepted, 4); assert.match(r2.error, /http 503/);
});
test('#23 an unchanged valid copy inside the 12 min bound triggers no direct read', async () => {
  S._resetForTests(); clock += H;
  writeWatch('records-latest.json', { fetched_at: iso(clock), seats: goodSeats });
  await S.seatRecords();
  clock += 11 * MIN; // our own TTL (10 min) ran out; the copy is unchanged and 11 min old
  const before = calls.length;
  const r = await S.seatRecords();
  assert.equal(calls.length - before, 0); assert.equal(r.error, null);
  clock += 2 * MIN; // now 13 min old: fall back to one direct read
  route = (u) => (u.endsWith('/seats/records') ? { status: 200, json: { seats: goodSeats } } : { status: 500, json: {} });
  await S.seatRecords();
  assert.equal(calls.length - before, 1);
});
test('#25 upstream bodies are capped at 4 MiB (streamed and by content-length)', async () => {
  route = () => ({ status: 200, raw: Buffer.alloc(4 * 1024 * 1024 + 1, 0x20) });
  await assert.rejects(S.fetchJSON('https://fixture.invalid/x', 1000), /body over 4194304 bytes/);
  route = () => ({ status: 200, json: { ok: 1 }, length: String(9 * 1024 * 1024) });
  await assert.rejects(S.fetchJSON('https://fixture.invalid/x', 1000), /body over/);
  route = () => ({ status: 200, json: { ok: 1 } });
  assert.deepEqual(await S.fetchJSON('https://fixture.invalid/x', 1000), { ok: 1 });
  // the cached network read keeps the last good data and records the error
  S._resetForTests();
  assert.deepEqual((await S.cachedFetch('k', 'https://fixture.invalid/k', 1000)).data, { ok: 1 });
  clock += 2000;
  route = () => ({ status: 200, raw: Buffer.alloc(5 * 1024 * 1024, 0x20) });
  const e = await S.cachedFetch('k', 'https://fixture.invalid/k', 1000);
  assert.deepEqual(e.data, { ok: 1 }); assert.match(e.error, /body over/);
  // agent cards: an oversized answer reads as unavailable and is never parsed
  const a = await S.fetchAgent('2');
  assert.match(a.unavailable, /body over/);
});

const ins = S.db.prepare('INSERT OR IGNORE INTO snapshots(ts,seat,kind,metric,value) VALUES(?,?,?,?,?)');
const resetsIn = (ms) => iso(clock + ms);
const nowS = () => Math.floor(clock / 1000);
test('#9 a reset/decrease inside the history starts a new segment', () => {
  S.db.exec('DELETE FROM snapshots');
  const now = nowS();
  for (const [o, v] of [[-86400, 0.1], [-7200, 0.95], [-3600, 0.01]]) ins.run(now + o, 'seatx', 'allowance_obs', 'weekly', v);
  const win = { name: 'weekly', used_fraction: 0.2, resets_at: resetsIn(6 * 86400000) };
  const f = S.allowanceForecast(['seatx'], win, iso(clock));
  assert.equal(f.pace_per_day, null); assert.match(f.unavailable, /less than 2 h/); // the old code said 0.10/day, 192 h
  S.db.exec('DELETE FROM snapshots');
  for (const [o, v] of [[-86400, 0.1], [-4 * 3600, 0.95], [-3 * 3600, 0.005]]) ins.run(now + o, 'seatx', 'allowance_obs', 'weekly', v);
  const g = S.allowanceForecast(['seatx'], win, iso(clock));
  assert.equal(g.based_on_hours, 3); assert.ok(g.pace_per_day > 1.5 && g.pace_per_day < 1.6, String(g.pace_per_day));
  assert.ok(Math.abs(g.runs_out_at - (now + g.hours_to_100 * 3600)) <= 360); assert.equal(g.before_reset, true); // projected from the observation time
});
test('#9 only samples inside the current weekly window are used', () => {
  S.db.exec('DELETE FROM snapshots');
  const now = nowS();
  ins.run(now - 20 * 3600, 'seatx', 'allowance_obs', 'weekly', 0.02); // before the window began (12 h ago)
  ins.run(now - 10 * 3600, 'seatx', 'allowance_obs', 'weekly', 0.05);
  const f = S.allowanceForecast(['seatx'], { name: 'weekly', used_fraction: 0.15, resets_at: resetsIn(7 * 86400000 - 12 * H) }, iso(clock));
  assert.equal(f.based_on_hours, 10);
});
test('#9 a stale current observation gives no forecast and says why', () => {
  const f = S.allowanceForecast(['seatx'], { name: 'weekly', used_fraction: 0.5, resets_at: resetsIn(86400000) }, iso(clock - 3 * H));
  assert.equal(f.pace_per_day, null); assert.equal(f.hours_to_100, null); assert.equal(f.before_reset, false);
  assert.match(f.unavailable, /older than 2 h/); assert.equal(f.observed_utc, iso(clock - 3 * H));
});
test('#9 a held reading is stored once at its observed time; the chart keeps the sample time and leaves it out', () => {
  S.db.exec('DELETE FROM snapshots');
  const obs = iso(clock - 86400000);
  fs.writeFileSync(path.join(incoming, 'seatx.json'), JSON.stringify({ seat: 'seatx', generated_utc: iso(clock),
    allowance: { provider: 'codex', source: 'last_observed', observed_utc: obs, windows: [{ name: 'weekly', used_fraction: 0.9, resets_at: resetsIn(86400000) }] } }));
  S.recordHistory(); clock += 30000; S.recordHistory();
  const o = S.db.prepare("SELECT ts FROM snapshots WHERE seat='seatx' AND kind='allowance_obs'").all();
  assert.deepEqual(o.map((r) => r.ts), [Math.floor(Date.parse(obs) / 1000)]);
  assert.equal(S.db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE seat='seatx' AND kind='allowance'").get().n, 2);
  const keys = Object.keys(S.history(2 * 86400).series);
  assert.ok(keys.includes('seatx.allowance.weekly') && !keys.some((k) => k.includes('allowance_obs')), keys.join(','));
});
test("#4 the backend forecast uses the account's newest reading (R-ALLOWANCE)", async () => {
  route = (u) => (u.includes('/agents/by-token/') ? { status: 200, json: { enrolled: true, active: true } } : { status: 500, json: {} });
  const mk = (seat, obs, used) => fs.writeFileSync(path.join(incoming, seat + '.json'), JSON.stringify({ seat, generated_utc: iso(clock),
    allowance: { provider: 'codex', source: 'live', observed_utc: obs, windows: [{ name: 'weekly', used_fraction: used, resets_at: resetsIn(3 * 86400000) }] } }));
  mk('seatx', iso(clock - H), 0.98); mk('seaty', iso(clock - MIN), 0.2);
  const st = await S.buildState();
  for (const w of st.workers) {
    assert.equal(w.snapshot.allowance.forecast.basis_seat, 'seaty', w.seat);
    assert.equal(w.snapshot.allowance.forecast.observed_utc, iso(clock - MIN));
  }
  mk('seaty', iso(clock - H), 0.2); // equal observation times: the higher used fraction wins
  const st2 = await S.buildState();
  assert.equal(st2.workers[0].snapshot.allowance.forecast.basis_seat, 'seatx');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
  }
  try { S.db.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
