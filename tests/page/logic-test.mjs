// Offline checks of the page's pure logic (web/src/App.jsx): freshness, the shared allowance rule, heavy-step
// results and the browser-side contract standing. Synthetic data only; no network.
// Run: node tests/page/logic-test.mjs   (needs `npm ci` in web/ for esbuild and react)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'web/package.json'));
const esbuild = req('esbuild'); const React = req('react'); const { renderToStaticMarkup } = req('react-dom/server');

let src = fs.readFileSync(path.join(root, 'web/src/App.jsx'), 'utf8').replace('export default function App()', 'function App()');
src += '\nexport { statusOf, snapAgeOf, heartbeatAgeOf, accountsOf, AgentRecord, heavyResult, freshWatch, contractOf, attentions, normalizeState };';
const { code } = esbuild.transformSync(src, { loader: 'jsx', format: 'cjs', target: 'es2022' });
let now = Date.parse('2026-10-07T12:00:00Z');
class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
const mod = { exports: {} };
vm.runInNewContext(code, { require: req, module: mod, exports: mod.exports, Date: FakeDate, console }, { filename: 'App.test.cjs' });
const app = mod.exports;

const fails = [];
const check = (name, ok, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  got: ' + JSON.stringify(got))); if (!ok) fails.push(name); };
const iso = (t) => new Date(t).toISOString();
const sec = (t) => Math.floor(t / 1000);
const box = { id: 'box1', name: 'Box 1', ok: true, host: {}, workers: [] };
// synthetic ids only (invented seats, aliases and NFT numbers): this file is public
function worker(seat, { hb = now, used = 0.2, observed = now, age = 10, received = now, token = '9001' } = {}) {
  return { seat, alias: seat, key: 'box1:' + seat, token, account: 'Codex · account 1', configured_runtime: 'codex', box, snapshot_age_s: age, received_s: sec(received),
    snapshot: { generated_utc: iso(now - age * 1000), concurrency: 1, service: { active: 'active', tasks_running: 0, last_heartbeat_utc: hb == null ? null : iso(hb).slice(0, 19) }, jobs: {},
      allowance: { provider: 'codex', source: 'last_observed', observed_utc: iso(observed), windows: [{ name: 'weekly', used_fraction: used, resets_at: '2026-10-09T12:00:00Z' }] } } };
}

// #1 freshness
check('fresh snapshot + fresh heartbeat = Idle', app.statusOf(worker('seatx')).text === 'Idle', app.statusOf(worker('seatx')));
const oldHb = worker('seatx', { hb: now - 3 * 3600e3 });
check('fresh snapshot + 3 h old heartbeat = Stale heartbeat', app.statusOf(oldHb).text === 'Stale heartbeat', app.statusOf(oldHb));
check('heartbeat 9 min old is still Idle', app.statusOf(worker('seatx', { hb: now - 540e3 })).text === 'Idle');
const plus2 = worker('seatx'); plus2.snapshot.service.last_heartbeat_utc = '2026-10-07T13:59:00+02:00'; // = 11:59Z
check('offset-bearing heartbeat stamp is not relabelled UTC', app.heartbeatAgeOf(plus2) < 120 && app.statusOf(plus2).text === 'Idle', app.heartbeatAgeOf(plus2));
const retained = worker('seatx');
now += 3 * 3600e3;
check('same response three hours later ages to Stale (elapsed time counted)', app.statusOf(retained).text === 'Stale' && app.snapAgeOf(retained) >= 3 * 3600, app.snapAgeOf(retained));
check('lost monitor link = Last known', app.statusOf(retained, true).text === 'Last known');
now -= 3 * 3600e3;
const noRecv = worker('seatx'); delete noRecv.received_s;
check('without a fetch stamp the reported age is used as is', app.snapAgeOf(noRecv) === 10);
const ns = app.normalizeState({ hub: true, boxes: [{ id: 'b', name: 'B', ok: true, workers: [{ seat: 'seatx' }] }] }, 12345);
check('normalizeState stamps the fetch time on each worker', ns.workers[0].received_s === 12345);

const two = { boxes: [box], workers: [worker('seatx'), worker('seaty', { token: '9002' })] };
check('fresh agents raise no needs-attention line (the second is not read as lost)', !app.attentions(two, null, null).some((a) => a.key.startsWith('attn:')));

// #4 R-ALLOWANCE
const older = worker('seat-a', { used: 0.98, observed: now - 2 * 3600e3, token: '9001' });
const newer = worker('seat-b', { used: 0.20, observed: now - 60e3, token: '9002' });
const acct = app.accountsOf([older, newer])[0];
check('account reading = newest observation', acct.al.windows[0].used_fraction === 0.2 && acct.alWorker === newer);
const tieA = worker('seat-a', { used: 0.30 }), tieB = worker('seat-b', { used: 0.70 });
check('tie on observed time: higher used fraction', app.accountsOf([tieB, tieA])[0].al.windows[0].used_fraction === 0.7 && app.accountsOf([tieA, tieB])[0].al.windows[0].used_fraction === 0.7);
const state = { generated_utc: iso(now), hub: true, boxes: [box], workers: [older, newer] };
const html = renderToStaticMarkup(React.createElement(app.AgentRecord, { wk: older, acct, state, hist: { series: {} }, work: null, watch: null, range: '24h', setRange() {}, onClose() {} }));
check('agent record shows the account reading (20%), not its own older 98%', html.includes('>20%<') && !html.includes('>98%<'), html.match(/\d+%/g));
check('agent record names the seat the reading came from', html.includes('read on seat-b'));

// #12 R-RESULT display
check('result submitted renders as awaiting verdict', app.heavyResult({ result: 'submitted', outcome: 'completed', accepted: false }) === 'submitted · awaiting verdict');
check('result failed keeps the failure cause', app.heavyResult({ result: 'failed', outcome: 'failed', verdict: 'rejected', failure: 'runtime_error' }) === 'failed · runtime_error');
check('result accepted', app.heavyResult({ result: 'accepted' }) === 'accepted');
check('no result: old inline reading', app.heavyResult({ accepted: false, verdict: 'rejected' }) === 'rejected' && app.heavyResult({ outcome: 'failed', failure: 'x' }) === 'failed · x');

// #1 contract standing
const watch = { contract: { read_at: iso(now - 600e3), stale: false, seats: [{ token: '9001', unknown: false, qualifies: true }] } };
check('fresh standing passes through unchanged', app.freshWatch(watch, false) === watch);
now += 3 * 3600e3;
const aged = app.freshWatch(watch, false);
check('standing read 3 h ago turns stale and unknown in the browser', aged.contract.stale === true && app.contractOf(aged, { token: '9001' }).unknown === true);
now -= 3 * 3600e3;
const lostW = app.freshWatch(watch, true);
check('lost link: standing unknown, not stale', lostW.contract.lost === true && lostW.contract.stale === false && app.contractOf(lostW, { token: '9001' }).unknown === true);
check('lost link adds no unknown-standing attention line', !app.attentions({ boxes: [], workers: [] }, lostW, null).some((a) => a.key.startsWith('unknown:')));

// bad contract results and failed jobs reach the attention strip (2026-10-09: three verifier rejections sat unseen on the News tab)
const wk7 = worker('seat-k', { token: '9007' }); wk7.alias = 'Worker K7';
const stk7 = { boxes: [box], workers: [wk7] };
// the watcher's failure records carry `contract`: 'likely' (counts toward standing), 'no', or null when it could not tell
const watchBad = {
  contract: { read_at: iso(now - 600e3), stale: false, seats: [{ token: '9007', unknown: false, qualifies: true, recent: ['bad', 'good', 'good'], lastTurnAt: iso(now - 3600e3) }] },
  contract_changes: [{ ts: iso(now - 1800e3), at: iso(now - 1900e3), token: '9007', baseline: false, events: ['bad_added'], contract: { good: 2, bad: 1, recent: ['bad', 'good', 'good'] } }],
  items: [{ ts: iso(now - 900e3), at: iso(now - 1000e3), token: '9007', node: 'build_contract_project', pattern: 'tests_failed', contract: 'likely', others: { completed: 3, failed: 0, total: 3 } }],
  patterns: {}, releases: [], news: [], payments: [], allocations: [] };
const at = app.attentions(stk7, watchBad, null);
check('a bad contract result raises a red line naming the worker', at.some((a) => a.key.startsWith('bad:9007:') && a.sev === 'bad' && a.text.includes('Worker K7')), at.map((a) => a.key));
check('a bad among the newest two results raises a live line naming the worker', at.some((a) => a.key.startsWith('onebad:9007') && a.sev === 'bad' && a.text.includes('Worker K7') && a.event === false), at.map((a) => a.key));
check('a likely-counting failed job since the last check raises a red line that says so', at.some((a) => a.key.startsWith('failed:') && a.sev === 'bad' && a.text.includes('likely counts toward') && a.text.includes('tests_failed')), at.map((a) => a.key));
const atSeen = app.attentions(stk7, watchBad, iso(now));
check('after Mark seen the event lines go, the live one-bad line stays', !atSeen.some((a) => a.key.startsWith('bad:') || a.key.startsWith('failed:')) && atSeen.some((a) => a.key.startsWith('onebad:9007')), atSeen.map((a) => a.key));
const watchProb = { ...watchBad, contract: { ...watchBad.contract, seats: [{ ...watchBad.contract.seats[0], recent: ['bad', 'bad', 'good'], probationUntil: iso(now + 20 * 3600e3) }] } };
check('a seat on probation gets the probation line, not the one-bad line', app.attentions(stk7, watchProb, iso(now)).some((a) => a.key.startsWith('probation:9007')) && !app.attentions(stk7, watchProb, iso(now)).some((a) => a.key.startsWith('onebad:')));
const watchOld = { ...watchBad, contract: { ...watchBad.contract, seats: [{ ...watchBad.contract.seats[0], recent: ['good', 'good', 'bad'] }] } };
check('a bad only in the oldest of the three results is no longer a next-result risk', !app.attentions(stk7, watchOld, iso(now)).some((a) => a.key.startsWith('onebad:')));
const noFail = app.attentions(stk7, { ...watchBad, items: [{ ...watchBad.items[0], contract: 'no', pattern: 'missing_outputs' }] }, null).find((a) => a.key.startsWith('failed:'));
check('an oracle failure is a warn line that says it does not count', noFail && noFail.sev === 'warn' && noFail.text.includes('do not count'), noFail);
const unkFail = app.attentions(stk7, { ...watchBad, items: [{ ...watchBad.items[0], contract: null, pattern: 'internal_error' }] }, null).find((a) => a.key.startsWith('failed:'));
check('a failure whose standing impact the watcher could not tell says unknown, not "does not count"', unkFail && unkFail.sev === 'warn' && unkFail.text.includes('unknown'), unkFail);
const legacyFail = app.attentions(stk7, { ...watchBad, items: [{ ...watchBad.items[0], contract: 'yes' }] }, null).find((a) => a.key.startsWith('failed:'));
check('the legacy yes spelling still counts', legacyFail && legacyFail.sev === 'bad', legacyFail);

console.log(fails.length ? `\n${fails.length} FAILED` : '\nall passed');
process.exit(fails.length ? 1 : 0);
