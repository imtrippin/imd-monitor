'use strict';
// IMD worker monitor — backend. Zero external deps (Node built-ins only, incl. node:sqlite).
// Runs as the unprivileged `imdmon` user, binds 127.0.0.1 only, serves the built UI + a
// read-only JSON API. Reads sanitized seat exports, collects host metrics, fetches the PUBLIC
// agent JSON, and keeps bounded SQLite history for the charts. No worker-control endpoints.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { console.error('node:sqlite unavailable — run node with --experimental-sqlite (Node >=22.5)'); process.exit(1); }

const CONFIG_PATH = process.env.IMD_MONITOR_CONFIG || '/etc/imd-monitor/config.json';
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = Number(process.env.IMD_MONITOR_PORT || cfg.port || 8787);
const HOST = '127.0.0.1';
const INCOMING = cfg.incoming_dir || '/var/lib/imd-monitor/incoming';
const WEBROOT = path.normalize(cfg.web_root || path.join(__dirname, 'public'));
const WEBROOT_SEP = WEBROOT.endsWith(path.sep) ? WEBROOT : WEBROOT + path.sep;
const HISTORY_DAYS = Number(cfg.history_days || 30);
const WORKERS = cfg.workers || [];

// ---------- db ----------
fs.mkdirSync(path.dirname(cfg.db_path), { recursive: true });
const db = new DatabaseSync(cfg.db_path);
db.exec(`CREATE TABLE IF NOT EXISTS snapshots(
  ts INTEGER NOT NULL, seat TEXT NOT NULL, kind TEXT NOT NULL, metric TEXT NOT NULL, value REAL,
  PRIMARY KEY(ts, seat, kind, metric));`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_snap_seat_ts ON snapshots(seat, ts);`);
const insertSnap = db.prepare('INSERT OR IGNORE INTO snapshots(ts,seat,kind,metric,value) VALUES(?,?,?,?,?)');
const pruneSnap = db.prepare('DELETE FROM snapshots WHERE ts < ?');
// Allowance observations keyed by the time the provider reading was OBSERVED (kind 'allowance_obs'), apart from the
// chart rows above (kind 'allowance', stamped with the 30 s sample time): a reading the collector holds forward is
// stored once at its own observed time, never re-stamped with each sample time (INSERT OR IGNORE dedupes it).
const obsAllowance = db.prepare("SELECT ts, value FROM snapshots WHERE seat = ? AND kind = 'allowance_obs' AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC");
const FORECAST_MAX_OBS_AGE_S = 7200;
// R-ALLOWANCE: of several readings of one provider account, the one with the newest allowance.observed_utc wins
// (ties: the higher used fraction). The page, the hub and this backend all apply this same rule.
const epochOf = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const maxUsed = (al) => Math.max(-1, ...(Array.isArray(al?.windows) ? al.windows : []).map((w) => (w && typeof w.used_fraction === 'number' ? w.used_fraction : -1)));
function newerReading(a, b) {
  if (!b) return true;
  const ta = epochOf(a.observed_utc) ?? -Infinity, tb = epochOf(b.observed_utc) ?? -Infinity;
  return ta !== tb ? ta > tb : maxUsed(a) > maxUsed(b);
}
// Run-out forecast for a weekly window of one account: the pace since the last reset (or decrease) inside the CURRENT
// window and the last 24 h, from every observation the account's seats on this box made, projected to 100% from the
// current observation and compared with the window's reset. Needs a current observation at most 2 h old and >= 2 h
// of history in that segment; otherwise the payload says why (`unavailable`) and carries no pace.
function allowanceForecast(seats, win, observedUtc) {
  if (!win || win.used_fraction == null || !['seven_day', 'weekly'].includes(win.name)) return null;
  const base = { window: win.name, observed_utc: observedUtc || null, pace_per_day: null, based_on_hours: null, hours_to_100: null, runs_out_at: null, before_reset: false };
  const obsMs = epochOf(observedUtc);
  if (obsMs == null) return { ...base, unavailable: 'the reading has no observation time' };
  const obs = Math.floor(obsMs / 1000), now = nowSec();
  if (now - obs > FORECAST_MAX_OBS_AGE_S) return { ...base, unavailable: 'the latest reading is older than 2 h' };
  const resetMs = epochOf(win.resets_at), resetAt = resetMs == null ? null : Math.floor(resetMs / 1000);
  if (resetAt != null && resetAt <= obs) return { ...base, unavailable: 'the window has reset since the reading' };
  const winLen = typeof win.window_minutes === 'number' && win.window_minutes > 0 ? win.window_minutes * 60 : 7 * 86400;
  const since = Math.max(obs - 86400, resetAt != null ? resetAt - winLen : -Infinity); // only the current window
  const samples = [];
  for (const s of seats) for (const r of obsAllowance.all(s, win.name, Math.floor(since), obs)) samples.push([r.ts, r.value]);
  samples.push([obs, win.used_fraction]);
  samples.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let start = samples.length - 1; // walk back while the usage never drops: a drop is a reset, the segment starts after it
  while (start > 0 && samples[start - 1][1] <= samples[start][1]) start--;
  const [t0, v0] = samples[start];
  if (obs - t0 < 7200) return { ...base, unavailable: 'less than 2 h of readings since the window started or last dropped' };
  const hours = (obs - t0) / 3600, pace = (win.used_fraction - v0) / hours * 24; // fraction per day
  if (!(pace > 0)) return { ...base, pace_per_day: 0, based_on_hours: Math.round(hours) };
  const hoursTo100 = (1 - win.used_fraction) / pace * 24, runsOut = obs + Math.round(hoursTo100 * 3600);
  return { ...base, pace_per_day: Math.round(pace * 1000) / 1000, based_on_hours: Math.round(hours),
    hours_to_100: Math.round(hoursTo100 * 10) / 10, runs_out_at: runsOut, before_reset: resetAt != null && runsOut < resetAt };
}

// ---------- helpers ----------
const nowSec = () => Math.floor(Date.now() / 1000);
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// concurrent callers of one cached fetch share its in-flight request instead of each starting their own
// (fn must not throw synchronously; every caller below catches inside its async function)
const inflight = new Map();
function shared(key, fn) {
  let p = inflight.get(key);
  if (!p) { p = fn().finally(() => inflight.delete(key)); inflight.set(key, p); }
  return p;
}
// Every api.imd.fun read goes through here: the body is streamed with a byte cap (counted after fetch's own
// decompression), so a broken or hostile upstream cannot make the backend buffer an unbounded answer.
const UPSTREAM_MAX_BYTES = 4 * 1024 * 1024;
async function fetchJSON(url, ms) {
  const ctl = new AbortController();
  const r = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(ms), ctl.signal]) });
  try {
    if (!r.ok) throw new Error('http ' + r.status);
    if (Number(r.headers?.get?.('content-length')) > UPSTREAM_MAX_BYTES) throw new Error(`body over ${UPSTREAM_MAX_BYTES} bytes`);
    const chunks = []; let size = 0;
    if (r.body) for await (const chunk of r.body) {
      size += chunk.byteLength;
      if (size > UPSTREAM_MAX_BYTES) throw new Error(`body over ${UPSTREAM_MAX_BYTES} bytes`);
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) { ctl.abort(); throw e; }
}

function hostMetrics() {
  const out = { collected_utc: new Date().toISOString() };
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k) => { const m = mi.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? Number(m[1]) * 1024 : null; };
    out.mem_total = g('MemTotal'); out.mem_available = g('MemAvailable');
    out.mem_used = (out.mem_total != null && out.mem_available != null) ? out.mem_total - out.mem_available : null;
    out.swap_total = g('SwapTotal'); out.swap_free = g('SwapFree');
    out.swap_used = (out.swap_total != null && out.swap_free != null) ? out.swap_total - out.swap_free : null;
  } catch {}
  try { out.load = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).map(Number); } catch {}
  out.cpus = os.cpus() ? os.cpus().length : null;
  try { out.uptime_s = Math.floor(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0])); } catch {}
  try {
    const s = fs.statfsSync('/');
    out.disk_total = s.blocks * s.bsize; out.disk_free = s.bavail * s.bsize;
    out.disk_used = out.disk_total - s.bfree * s.bsize;
  } catch {}
  return out;
}

// cpu utilization from two /proc/stat reads
let lastCpu = null;
function cpuSample() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = line[3] + (line[4] || 0), total = line.reduce((a, b) => a + b, 0);
    if (lastCpu) { const dt = total - lastCpu.total, di = idle - lastCpu.idle; lastCpu = { idle, total }; return dt > 0 ? Math.max(0, Math.min(1, 1 - di / dt)) : null; }
    lastCpu = { idle, total }; return null;
  } catch { return null; }
}

// public agent JSON (no creds). cached per token for an hour: the card (agent id, enrolled, explorer)
// almost never changes, and the dashboard polls /api/state every 10 s — keep api.imd.fun load tiny.
const AGENT_TTL_MS = 3600000, AGENT_RETRY_MS = 600000;
const agentCache = new Map();
async function fetchAgent(token) {
  const c = agentCache.get(token);
  if (c && Date.now() - c.at < AGENT_TTL_MS) return c.data;
  return shared('agent:' + token, () => loadAgent(token, c));
}
async function loadAgent(token, c) {
  try {
    const j = await fetchJSON(`https://api.imd.fun/agents/by-token/${token}.json`, 10000);
    const reg = (j.registrations || [])[0] || {};
    const data = { token, agent_id: reg.agentId ?? null, enrolled: !!j.enrolled, active: !!j.active,
      explorer: (j.services || []).find(s => s.name === 'web')?.endpoint || null, observed_utc: new Date().toISOString() };
    agentCache.set(token, { at: Date.now(), data });
    return data;
  } catch (e) {
    const data = (c && c.data) ? { ...c.data, stale: true } : { token, unavailable: String(e.message || e) };
    agentCache.set(token, { at: Date.now() - AGENT_TTL_MS + AGENT_RETRY_MS, data }); // retry in 10 min, not on every poll
    return data;
  }
}

// ---------- state assembly ----------
// The drop dir is shared (sticky, world-writable), so any local user could pre-create another seat's <seat>.json:
// an export is read only when its owner is that seat's Linux user. Uids come from /etc/passwd, read once at start;
// without that file (a dev machine) there is no check, and a seat missing from it is never read (logged once).
const SEAT_UID = (() => {
  let text; try { text = fs.readFileSync('/etc/passwd', 'utf8'); } catch { return null; }
  const m = new Map();
  for (const line of text.split('\n')) { const f = line.split(':'); if (f.length >= 3 && /^\d+$/.test(f[2])) m.set(f[0], Number(f[2])); }
  for (const w of WORKERS) if (!m.has(w.seat)) console.error(`seat ${w.seat} not in /etc/passwd: its export is skipped`);
  return m;
})();
// Untrusted jobs run as the seat users, so an export is opened without following links or blocking (a FIFO
// fails the regular-file check), must be a regular file of at most 256 KiB, and only known fields of known
// types are copied out: strings cut to 200 characters, numbers finite, lists bounded, at most 6 allowance
// windows with allowlisted names (any other name becomes 'other'). An export never relays other keys.
const EXPORT_MAX_BYTES = 256 * 1024;
const WINDOW_NAMES = ['five_hour', 'seven_day', 'weekly', 'daily', 'monthly', 'other'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// each sanitizer returns the clean value, null for null, or undefined (the key is dropped) for anything else
const sStr = (v) => (v === null ? null : typeof v === 'string' ? v.slice(0, 200) : undefined);
const sNum = (v) => (v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const sList = (max, f) => (v) => (Array.isArray(v) ? v.slice(0, max).map(f).filter((x) => x !== undefined && x !== null) : undefined);
const sObj = (spec) => (v) => {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const out = {};
  for (const [k, f] of Object.entries(spec)) if (Object.hasOwn(v, k)) { const x = f(v[k]); if (x !== undefined) out[k] = x; }
  return out;
};
const sTokens = sObj({ uncached_input: sNum, output: sNum, cached_input: sNum, cache_write: sNum, total: sNum });
const sWindowRest = sObj({ window_minutes: sNum, used_fraction: sNum, resets_at: sStr });
const sWindow = (v) => (isObj(v) ? { name: WINDOW_NAMES.includes(v.name) ? v.name : 'other', ...sWindowRest(v) } : undefined);
const sExport = sObj({
  seat: sStr, host: sStr, runtime: sStr, runtime_version: sStr, worker_version: sStr, generated_utc: sStr, concurrency: sNum,
  profiles: sList(16, sStr), tools: sList(64, sStr),
  toolchain: sObj({ forge: sStr, verifier_forge: sStr }),
  service: sObj({ active: sStr, enabled: sStr, restarts: sNum, main_pid: sNum, uptime_s: sNum, started_utc: sStr,
    tasks_running: sNum, fleet_online: sNum, fleet_enrolled: sNum, last_heartbeat_utc: sStr }),
  jobs: sObj({ accepted_total: sNum, submitted_total: sNum, accepted_today: sNum, submitted_today: sNum, ratelimit_today: sNum, reconnects_today: sNum }),
  tokens: sObj({ today: sTokens, alltime: sTokens, days_tracked: sNum }),
  allowance: sObj({ provider: sStr, plan: sStr, source: sStr, observed_utc: sStr, windows: sList(6, sWindow) }),
  reset_credits: sObj({ available: sNum, observed_utc: sStr, attempted_utc: sStr, error: sStr, auth_error: sStr,
    credits: sList(20, sObj({ title: sStr, status: sStr, type: sStr, granted_utc: sStr, expires_utc: sStr })) }),
});
function readSeatExport(seat) {
  if (SEAT_UID && !SEAT_UID.has(seat)) return null;
  let fd;
  try {
    const c = fs.constants;
    fd = fs.openSync(path.join(INCOMING, `${seat}.json`), c.O_RDONLY | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > EXPORT_MAX_BYTES) return null;
    if (SEAT_UID && st.uid !== SEAT_UID.get(seat)) return null;
    // read at most one byte past the cap, so a file that grew after the fstat is refused too
    const buf = Buffer.alloc(EXPORT_MAX_BYTES + 1); let n = 0, r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
    if (n > EXPORT_MAX_BYTES) return null;
    return sExport(JSON.parse(buf.toString('utf8', 0, n))) || null;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

async function buildState() {
  const host = hostMetrics(); host.cpu = cpuSample();
  const workers = [];
  const agents = await Promise.all(WORKERS.map((w) => fetchAgent(w.token)));
  const snaps = WORKERS.map((w) => { // one bad export never stops the other seats
    try { return readSeatExport(w.seat); } catch (e) { console.error(`state ${w.seat}: ${e && e.message || e}`); return null; }
  });
  // R-ALLOWANCE: one forecast per account, from the account's newest reading on this box, attached to each of its seats
  const acctKey = (w) => w.account || '\u0000' + w.seat;
  const chosen = new Map(); // account -> { seat, al }
  for (const [i, w] of WORKERS.entries()) {
    const al = snaps[i]?.allowance;
    if (al && Array.isArray(al.windows) && newerReading(al, chosen.get(acctKey(w))?.al)) chosen.set(acctKey(w), { seat: w.seat, al });
  }
  const forecasts = new Map();
  for (const [key, { seat, al }] of chosen) {
    try {
      const weekly = al.windows.find((x) => ['seven_day', 'weekly'].includes(x.name));
      const seats = WORKERS.filter((o) => acctKey(o) === key).map((o) => o.seat);
      const f = allowanceForecast(seats, weekly, al.observed_utc);
      if (f) forecasts.set(key, { ...f, basis_seat: seat });
    } catch (e) { console.error(`forecast ${seat}: ${e && e.message || e}`); }
  }
  for (const [i, w] of WORKERS.entries()) {
    const snap = snaps[i];
    if (snap?.allowance && forecasts.has(acctKey(w))) snap.allowance.forecast = forecasts.get(acctKey(w));
    const agent = agents[i];
    let ageSec = null;
    if (snap?.generated_utc) ageSec = Math.max(0, nowSec() - Math.floor(new Date(snap.generated_utc).getTime() / 1000));
    const sharesWith = WORKERS.filter(o => o.account && o.account === w.account && o.seat !== w.seat).map(o => o.alias || o.seat);
    workers.push({ seat: w.seat, alias: w.alias || w.seat, token: w.token, configured_runtime: w.runtime || null,
      account: w.account || null, shares_account_with: sharesWith,
      agent, snapshot: snap, snapshot_age_s: ageSec });
  }
  return { generated_utc: new Date().toISOString(), host, workers,
    config: { history_days: HISTORY_DAYS, port: PORT, workers: WORKERS.map(w => ({ seat: w.seat, alias: w.alias, token: w.token })) } };
}

// ---------- history recording ----------
function recordHistory() {
  const ts = nowSec();
  const host = hostMetrics(); const cpu = cpuSample();
  if (host.mem_used != null) insertSnap.run(ts, '_host', 'host', 'mem_used', host.mem_used);
  if (host.mem_total != null) insertSnap.run(ts, '_host', 'host', 'mem_total', host.mem_total);
  if (host.disk_free != null) insertSnap.run(ts, '_host', 'host', 'disk_free', host.disk_free);
  if (cpu != null) insertSnap.run(ts, '_host', 'host', 'cpu', cpu);
  if (host.load) insertSnap.run(ts, '_host', 'host', 'load1', host.load[0]);
  for (const w of WORKERS) {
    try { // one bad export never stops the other seats
      const snap = readSeatExport(w.seat);
      if (!snap) continue;
      const obsMs = epochOf(snap.allowance?.observed_utc);
      const obs = obsMs != null && obsMs <= Date.now() + 120000 ? Math.floor(obsMs / 1000) : null;
      for (const win of (snap.allowance?.windows || [])) {
        if (win.used_fraction == null) continue;
        insertSnap.run(ts, w.seat, 'allowance', win.name, win.used_fraction); // chart row, sample time
        if (obs != null) insertSnap.run(obs, w.seat, 'allowance_obs', win.name, win.used_fraction); // forecast row, observed time
      }
      if (snap.tokens?.alltime?.total != null) insertSnap.run(ts, w.seat, 'tokens', 'total', snap.tokens.alltime.total);
      if (snap.jobs?.submitted_total != null) insertSnap.run(ts, w.seat, 'jobs', 'submitted_total', snap.jobs.submitted_total);
    } catch (e) { console.error(`history ${w.seat}: ${e && e.message || e}`); }
  }
  pruneSnap.run(ts - HISTORY_DAYS * 86400);
  recorded = ts;
}
let recorded = 0; // ts of the last recordHistory(); cached history is valid until it changes

// Every range is bucket-averaged to ~300 points per series (24h = 5 min, 7d = 30 min, 30d = 2 h).
// Charts are ~1000 px wide; raw 30 s samples made the 24h payload ~4 MB per fleet.
const BUCKET_S = { 86400: 300, [7 * 86400]: 1800, [30 * 86400]: 7200 };
const roundVal = (v) => (v == null || Number.isInteger(v) ? v : Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 1e4) / 1e4);
function history(rangeSec) {
  const since = nowSec() - rangeSec;
  const bucket = BUCKET_S[rangeSec] || 300;
  // node:sqlite binds JS numbers as REAL, so force integer bucket arithmetic explicitly
  const rows = db.prepare('SELECT CAST(ts / CAST(? AS INTEGER) AS INTEGER) * CAST(? AS INTEGER) AS ts, seat, kind, metric, AVG(value) AS value FROM snapshots WHERE ts >= ? AND kind != ? GROUP BY 1,2,3,4 ORDER BY 1 ASC').all(bucket, bucket, since, 'allowance_obs'); // forecast rows stay out of the charts
  const series = {};
  for (const r of rows) { const key = `${r.seat}.${r.kind}.${r.metric}`; (series[key] ||= []).push([r.ts, roundVal(r.value)]); }
  return { since, until: nowSec(), bucket_s: bucket, series };
}
// history only changes when recordHistory() runs (every 30 s): build + gzip each range once per recording
const histCache = new Map();
function historyBody(rangeSec) {
  const hit = histCache.get(rangeSec);
  if (hit && hit.stamp === recorded) return hit;
  const json = Buffer.from(JSON.stringify(history(rangeSec)));
  const entry = { stamp: recorded, json, gz: zlib.gzipSync(json) };
  histCache.set(rangeSec, entry);
  return entry;
}

// ---------- work by category (only where the heavy-work watcher runs) ----------
// Verified totals per seat come from ONE light public call (/seats/records, cached server-side), at most
// every 10 min; the non-oracle split comes from the watcher's own log, so this adds no per-seat history
// sweeps against api.imd.fun (be gentle with the shared public API).
const WATCH_DIR = cfg.watch_dir || '/var/lib/imd-monitor/watch';
const RECORDS_TTL_MS = 600000;
let records = { at: 0, data: null, error: null };
async function seatRecords() {
  if (Date.now() - records.at < RECORDS_TTL_MS) return records; // also spaces out retries after an error
  return shared('records', loadRecords);
}
// A /seats/records answer (the watcher's copy or our own read) is used only when it is a non-empty seats list whose
// every row has a tokenId and numeric counts; anything else (an error object, an empty list, a changed schema)
// throws, so the last good records stay in place instead of being replaced by fresh-looking emptiness.
const RECORD_COUNTS = ['attempts', 'accepted', 'rejected', 'failed', 'pending'];
function recordsData(j) {
  if (!isObj(j) || j.error != null || !Array.isArray(j.seats) || !j.seats.length) throw new Error('bad records: no seats list');
  const data = {};
  for (const s of j.seats) {
    if (!isObj(s) || s.tokenId == null || String(s.tokenId) === '' || typeof s.tokenId === 'object') throw new Error('bad records: row without tokenId');
    for (const k of RECORD_COUNTS) if (s[k] != null && !(typeof s[k] === 'number' && Number.isFinite(s[k]))) throw new Error(`bad records: ${k} not a number`);
    if (typeof s.attempts !== 'number' || typeof s.accepted !== 'number') throw new Error('bad records: counts missing');
    data[String(s.tokenId)] = { attempts: s.attempts, accepted: s.accepted, rejected: s.rejected, failed: s.failed, pending: s.pending, lastWorkedAt: s.lastWorkedAt };
  }
  return data;
}
// On the watcher box the watcher already reads /seats/records every 10 min for its failure digest and leaves the
// response in records-latest.json: a valid copy serves this view too, so both readers cost the API one request.
// The copy must be at most one watcher cycle (plus slack) old and not more than 2 min in the future (clock skew).
function watcherRecords() {
  const st = readJSON(path.join(WATCH_DIR, 'records-latest.json'));
  if (!isObj(st)) return null;
  const at = typeof st.fetched_at === 'string' ? Date.parse(st.fetched_at) : NaN;
  if (!Number.isFinite(at) || at > Date.now() + 120000 || Date.now() - at > RECORDS_TTL_MS + 120000) return null;
  try { return { at, data: recordsData(st), error: null }; } catch { return null; }
}
async function loadRecords() {
  // a valid copy within its age bound is used as is, even when it is not newer than what we hold: comparing stamps
  // alone made an unchanged 10-12 min old copy trigger a direct read every time our own TTL ran out
  const copy = watcherRecords();
  if (copy) { if (copy.at >= records.at || records.error) records = copy; return records; }
  try {
    records = { at: Date.now(), data: recordsData(await fetchJSON('https://api.imd.fun/seats/records', 20000)), error: null };
  } catch (e) { records = { at: Date.now(), data: records.data, error: String(e.message || e) }; }
  return records;
}
// node key -> the categories people compare agents by (oracle / frontend / contract / review / research / other)
const CATEGORIES = [[/^oracle_assess/, 'oracle'], [/^(build_website|frontend|implement_component|better_interface)/, 'frontend'],
  [/^(adversarial_review|review|contract_review|solidity_security|security)/, 'review'], [/^research/, 'research'],
  [/^(build_contract|contracts?|impl|implement|registry|deploy|tests?|write_foundry|gas_and|fix_findings|scaffold|manifest|refine)/, 'contract']];
const categoryOf = (key) => { const k = String(key || '').replace(/_\d+$/, ''); for (const [re, c] of CATEGORIES) if (re.test(k)) return c; return 'other'; };
// heavy attempts recorded before the watcher existed (optional `heavy_baseline` rows in the config:
// {seat, key, accepted?, verdict?, outcome?, job}); an empty list is the normal case
const HEAVY_BASELINE = Array.isArray(cfg.heavy_baseline) ? cfg.heavy_baseline.filter((a) => a && typeof a === 'object' && a.seat && a.key) : [];
// heavy.jsonl is never trimmed, so its parse is kept until the file's size or mtime changes
let heavyCache = { sig: null, data: null };
function heavyByToken() {
  let text = '', sig, fd;
  try {
    fd = fs.openSync(path.join(WATCH_DIR, 'heavy.jsonl'), 'r');
    const st = fs.fstatSync(fd); sig = `${st.size}:${st.mtimeMs}`;
    if (heavyCache.sig === sig) return heavyCache.data;
    text = fs.readFileSync(fd, 'utf8');
  } catch { sig = 'no-log'; text = ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} } // the baseline still counts without a readable log
  if (heavyCache.sig === sig) return heavyCache.data;
  const parsed = parseHeavy(text);
  heavyCache = { sig, data: parsed.by, recent: parsed.recent };
  return heavyCache.data;
}
// the last heavy steps each seat attempted, newest first, with the usage the submission reported (model, turns,
// tokens, wall clock): the same parse as heavyByToken, so no extra read
function heavyRecent() { heavyByToken(); return heavyCache.recent || {}; }
// R-RESULT: an attempt's result label, computed once here; the aggregates and every heavy_recent row use it.
function classifyAttempt(a) {
  if (a.accepted === true) return 'accepted';
  if (a.outcome === 'failed' || a.failure) return 'failed';
  if (a.verdict === 'rejected') return 'rejected';
  if (a.outcome === 'completed') return 'submitted'; // completed, no verdict yet
  return 'pending';
}
function parseHeavy(text) {
  const latest = new Map(); // job -> last observation
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); latest.set(r.job, r); } catch {} }
  const logged = [];
  for (const r of latest.values()) {
    if (Array.isArray(r.attempts)) for (const a of r.attempts) logged.push({ ...a, job: r.job });
    else for (const n of r.nodes || []) if (n.seat) logged.push({ seat: n.seat, key: n.key, verdict: n.verdict, accepted: n.verdict === 'accepted', outcome: n.state, job: r.job });
  }
  // a baseline row the log also holds (same seat, step key and job) is that one attempt, counted once
  const idOf = (a) => `${a.seat}\u0000${a.key}\u0000${a.job}`;
  const loggedIds = new Set(logged.map(idOf));
  const attempts = [...HEAVY_BASELINE.filter((a) => !loggedIds.has(idOf(a))), ...logged];
  const out = {};
  for (const a of attempts) {
    const c = categoryOf(a.key); if (!a.seat || c === 'oracle') continue;
    const x = ((out[a.seat] ||= {})[c] ||= { attempts: 0, jobs: new Set(), accepted: 0, rejected: 0, failed: 0, pending: 0, submitted: 0 });
    x.attempts++; x.jobs.add(a.job);
    // `pending` counts every attempt still without a verdict; `submitted` is the part of it that completed
    const res = classifyAttempt(a);
    if (res === 'submitted') { x.submitted++; x.pending++; } else x[res]++;
  }
  for (const t of Object.values(out)) for (const x of Object.values(t)) x.jobs = x.jobs.size;
  const recent = {}; const fleet = new Set(fleetTokens()); // the log covers every seat on the network; keep the fleet's own
  for (const a of attempts) {
    if (!a.seat || !a.at || !fleet.has(String(a.seat)) || categoryOf(a.key) === 'oracle') continue;
    (recent[a.seat] ||= []).push({ job: a.job, key: a.key, at: a.at, result: classifyAttempt(a), outcome: a.outcome, accepted: a.accepted === true, verdict: a.verdict, failure: a.failure, failureClass: a.failureClass, usage: a.usage && typeof a.usage === 'object' ? a.usage : null });
  }
  for (const [t, list] of Object.entries(recent)) recent[t] = list.sort((x, y) => (Date.parse(y.at) || 0) - (Date.parse(x.at) || 0)).slice(0, 12);
  return { by: out, recent };
}
// the date (YYYY-MM-DD) the heavy-work log starts: `ts` is the first key of every watcher line, so the file's
// first bytes are enough; null when there is no log yet. `heavy_since` in the config overrides it.
function firstHeavyTs() {
  let fd;
  try {
    fd = fs.openSync(path.join(WATCH_DIR, 'heavy.jsonl'), 'r');
    const buf = Buffer.alloc(256); const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = buf.toString('utf8', 0, n).match(/^\s*\{\s*"ts"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
async function workState() {
  if (!fs.existsSync(WATCH_DIR)) return { enabled: false };
  const rec = await seatRecords();
  return { enabled: true, generated_utc: new Date().toISOString(), records_at: rec.at ? new Date(rec.at).toISOString() : null,
    records_error: rec.error, records: rec.data || {}, heavy: heavyByToken(), heavy_recent: heavyRecent(), heavy_since: cfg.heavy_since || firstHeavyTs() || null };
}

// ---------- since last check: failures / releases / news / payments (watcher files, on the watcher box; docs/watch.md) ----------
// The files grow by a few lines a day, so they are read whole; one build per minute at most.
const WATCH_TTL_MS = 60000;
let watchCache = { at: 0, data: null };
function readJSONL(name) {
  let text = '';
  try { text = fs.readFileSync(path.join(WATCH_DIR, name), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); if (r && typeof r === 'object') out.push(r); } catch {} }
  return out;
}
// contract-work standing (IMD's contract-work rules; watcher contract-state.json + contract.jsonl). ONE definition of
// "in rotation" and "alert" for the hub and the page. No state file, no section, or a snapshot older than
// 2 h (four missed presence passes) reads as unknown, never as healthy.
function contractState(now) {
  const st = readJSON(path.join(WATCH_DIR, 'contract-state.json'));
  if (!st || typeof st !== 'object') return { contract: null, contract_changes: [] };
  const readAt = Date.parse(st.read_at) || 0; const stale = !readAt || now - readAt > 2 * 3600000;
  const seatsIn = st.seats && typeof st.seats === 'object' ? st.seats : {};
  const sum = { tokens: 0, in_rotation: 0, qualifies: 0, probation: 0, retry_due: 0, not_qualifying: 0, missing: [], unknown: 0, bad_recent: 0 };
  const seats = [];
  for (const t of fleetTokens()) {
    const e = seatsIn[t] && typeof seatsIn[t] === 'object' ? seatsIn[t] : null;
    const c = e && e.contract && typeof e.contract === 'object' ? e.contract : null;
    const row = { token: t, ts: typeof e?.ts === 'string' ? e.ts : null, at: typeof e?.at === 'string' ? e.at : null, src: e?.src ?? null,
      unknown: !c || stale, qualifies: c ? c.qualifies === true : null, missing: Array.isArray(c?.missing) ? c.missing.map(String) : [],
      lastTurnAt: typeof c?.lastTurnAt === 'string' ? c.lastTurnAt : null, good: Number(c?.good) || 0, bad: Number(c?.bad) || 0,
      recent: Array.isArray(c?.recent) ? c.recent.map(String).slice(-3) : [], probationUntil: typeof c?.probationUntil === 'string' ? c.probationUntil : null,
      retryDue: c?.retryDue === true, probations: Number(c?.probations) || 0 };
    const onProbation = !!row.probationUntil && Date.parse(row.probationUntil) > now;
    row.in_rotation = !row.unknown && row.qualifies === true && !onProbation;
    row.alert = row.unknown || row.qualifies === false || onProbation || row.retryDue || row.missing.length > 0;
    sum.tokens++; if (row.in_rotation) sum.in_rotation++; if (row.qualifies) sum.qualifies++; if (onProbation) sum.probation++;
    if (row.retryDue) sum.retry_due++; if (row.qualifies === false) sum.not_qualifying++; if (row.unknown) sum.unknown++;
    if (row.missing.length) sum.missing.push({ token: t, missing: row.missing }); if (row.recent.includes('bad')) sum.bad_recent++;
    seats.push(row);
  }
  // why a sweep may be missing: the watcher's own error log for the standing-reading tasks in the last 3 h
  const errs = readJSONL('errors.jsonl').filter(e => (e.task === 'presence' || e.task === 'failures') && (Date.parse(e.ts) || 0) >= now - 3 * 3600000);
  const last = errs[errs.length - 1];
  const read_errors = { count: errs.length, last_ts: last ? last.ts : null, last_error: last ? String(last.error).slice(0, 120) : null };
  return { contract: { read_at: typeof st.read_at === 'string' ? st.read_at : null, server: typeof st.server === 'string' ? st.server : null,
    rules: st.rules && typeof st.rules === 'object' ? st.rules : null, stale, seats, summary: sum, read_errors },
    contract_changes: readJSONL('contract.jsonl').slice(-200).reverse() };
}
function watchState() {
  if (!fs.existsSync(WATCH_DIR)) return { enabled: false };
  if (watchCache.data && Date.now() - watchCache.at < WATCH_TTL_MS) return watchCache.data;
  const now = Date.now(), since7d = now - 7 * 86400000, since24h = now - 86400000;
  const patterns = readJSON(path.join(WATCH_DIR, 'patterns.json')) || {};
  const recent = readJSONL('failures.jsonl').map(r => ({ r, t: Date.parse(r.at) })).filter(x => x.t >= since7d).sort((a, b) => b.t - a.t);
  const byPattern = {};
  for (const { r, t } of recent) {
    const p = (byPattern[r.pattern || 'unknown'] ||= { count_7d: 0, count_24h: 0, last_at: null, first_seen: patterns[r.pattern]?.first_seen ?? null });
    p.count_7d++; if (t >= since24h) p.count_24h++;
    if (!p.last_at) p.last_at = r.at; // recent is newest first
  }
  const data = { enabled: true, generated_utc: new Date().toISOString(),
    failures: { since_days: 7, items: recent.slice(0, 100).map(x => x.r), by_pattern: byPattern, patterns },
    releases: readJSONL('releases.jsonl').slice(-6).reverse(), news: readJSONL('news.jsonl').slice(-20).reverse() };
  // payments: the total counts every line, the list keeps the last 200 (newest first by `at`)
  // one line per hash (the last wins): a re-emitted payment must never double the total
  const pays = [...new Map(readJSONL('payments.jsonl').filter(p => typeof p.hash === 'string').map(p => [p.hash, p])).values()];
  const byAt = (a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0);
  const ats = pays.map(p => p.at).filter(a => typeof a === 'string' && Date.parse(a)).sort((a, b) => Date.parse(a) - Date.parse(b));
  data.payments = pays.slice(-200).sort(byAt);
  data.payments_total = { amount: Math.round(pays.reduce((s, p) => s + (Number(p.amount) || 0), 0) * 1e4) / 1e4,
    count: pays.length, first_at: ats[0] ?? null, last_at: ats[ats.length - 1] ?? null };
  // launch allocations (docs/watch.md, Allocations): one line per launchId (the last wins),
  // the list keeps the last 200 (newest first by `at`); never summed with payments
  const allocs = [...new Map(readJSONL('allocations.jsonl').filter(a => typeof a.launchId === 'string').map(a => [a.launchId, a])).values()];
  const byChain = {};
  for (const a of allocs) { const c = String(a.chainId ?? 'unknown'); byChain[c] = (byChain[c] || 0) + 1; }
  const allocAts = allocs.map(a => a.at).filter(a => typeof a === 'string' && Date.parse(a)).sort((a, b) => Date.parse(a) - Date.parse(b));
  data.allocations = allocs.slice(-200).sort(byAt);
  data.allocations_total = { count: allocs.length, launches_by_chain: byChain, latest_at: allocAts[allocAts.length - 1] ?? null };
  Object.assign(data, contractState(now));
  watchCache = { at: now, data };
  return data;
}

// ---------- network: overall job stats and our fleet's share (on the watcher box; docs/network-tab.md) ----------
// Four light public reads on a slow cadence (health every 5 min, steps/hourly every 10 min, oracle and
// publication counts hourly) next to the /seats/records read the work route already makes: about 20 requests
// an hour in total (be gentle with the shared public API). Totals are recorded every 10 min so the fleet's
// rolling share can be charted. The fleet's tokens come from the watcher's config (every seat on every box),
// not from this box's own workers.
const WATCH_CONFIG = cfg.watch_config || '/etc/imd-monitor/watch.json';
db.exec(`CREATE TABLE IF NOT EXISTS network_totals(ts INTEGER PRIMARY KEY, accepted INTEGER, attempts INTEGER, seats INTEGER, connected INTEGER, fleet_accepted INTEGER, fleet_attempts INTEGER)`);
const netCache = new Map(); // key -> { at, data, error }; an error keeps the last data and spaces out retries
async function cachedFetch(key, url, ttlMs) {
  const hit = netCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit;
  return shared('net:' + key, () => loadNet(key, url, hit));
}
async function loadNet(key, url, hit) {
  let entry;
  try {
    entry = { at: Date.now(), data: await fetchJSON(url, 20000), error: null };
  } catch (e) { entry = { at: Date.now(), data: hit?.data ?? null, error: String(e.message || e) }; }
  netCache.set(key, entry);
  return entry;
}
function fleetTokens() {
  const w = readJSON(WATCH_CONFIG);
  return Array.isArray(w?.tokens) && w.tokens.length ? w.tokens.map(String) : WORKERS.map(x => String(x.token ?? x.tokenId));
}
function latestLandscape() {
  let text = ''; try { text = fs.readFileSync(path.join(WATCH_DIR, 'landscape.jsonl'), 'utf8'); } catch { return null; }
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) { try { const r = JSON.parse(lines[i]); if (r && r.tools) return r; } catch {} }
  return null;
}
let lastNetRecord = 0;
async function recordNetwork() {
  if (!fs.existsSync(WATCH_DIR)) return;
  const rec = await seatRecords(); const h = await cachedFetch('health', 'https://api.imd.fun/health', 300000);
  if (!rec.data || rec.at === lastNetRecord) return; // one row per fresh records read
  lastNetRecord = rec.at;
  const tokens = new Set(fleetTokens()); const t = { accepted: 0, attempts: 0, seats: 0 }, f = { accepted: 0, attempts: 0 };
  for (const [tok, r] of Object.entries(rec.data)) {
    t.seats++; t.accepted += Number(r.accepted) || 0; t.attempts += Number(r.attempts) || 0;
    if (tokens.has(tok)) { f.accepted += Number(r.accepted) || 0; f.attempts += Number(r.attempts) || 0; }
  }
  const connected = Number(h.data?.connectedDaemons);
  db.prepare('INSERT OR REPLACE INTO network_totals(ts, accepted, attempts, seats, connected, fleet_accepted, fleet_attempts) VALUES (?,?,?,?,?,?,?)')
    .run(Math.floor(rec.at / 1000), t.accepted, t.attempts, t.seats, Number.isFinite(connected) ? connected : null, f.accepted, f.attempts);
  db.prepare('DELETE FROM network_totals WHERE ts < ?').run(nowSec() - 90 * 86400);
}
async function networkState() {
  if (!fs.existsSync(WATCH_DIR)) return { enabled: false };
  const [rec, health, hourly, oracle, pubs] = await Promise.all([seatRecords(),
    cachedFetch('health', 'https://api.imd.fun/health', 300000), cachedFetch('hourly', 'https://api.imd.fun/steps/hourly', 600000),
    cachedFetch('oracle', 'https://api.imd.fun/oracle/counts', 3600000), cachedFetch('pubs', 'https://api.imd.fun/publications/counts', 3600000)]);
  const tokens = fleetTokens(); const tset = new Set(tokens);
  const keys = ['attempts', 'accepted', 'rejected', 'failed', 'pending'];
  const network = { seats: 0, attempts: 0, accepted: 0, rejected: 0, failed: 0, pending: 0 };
  const fleet = { tokens, seats: 0, attempts: 0, accepted: 0, rejected: 0, failed: 0, pending: 0 };
  const all = [];
  for (const [tok, r] of Object.entries(rec.data || {})) {
    network.seats++; for (const k of keys) network[k] += Number(r[k]) || 0;
    all.push({ token: tok, accepted: Number(r.accepted) || 0, lastWorkedAt: r.lastWorkedAt ?? null });
    if (tset.has(tok)) { fleet.seats++; for (const k of keys) fleet[k] += Number(r[k]) || 0; }
  }
  all.sort((a, b) => b.accepted - a.accepted);
  const rank = new Map(all.map((x, i) => [x.token, i + 1]));
  const ranks = { top: all.slice(0, 10), ours: tokens.map(t => ({ token: t, rank: rank.get(t) ?? null, accepted: rec.data?.[t]?.accepted ?? null })) };
  const h = health.data || {};
  const rows = db.prepare('SELECT ts, accepted, fleet_accepted, connected, seats FROM network_totals WHERE ts >= ? ORDER BY ts ASC').all(nowSec() - 7 * 86400);
  return { enabled: true, generated_utc: new Date().toISOString(), records_at: rec.at ? new Date(rec.at).toISOString() : null, records_error: rec.error,
    health: { at: health.at ? new Date(health.at).toISOString() : null, error: health.error, version: h.version ?? null, connectedDaemons: h.connectedDaemons ?? null,
      activeEnrollments: h.activeEnrollments ?? null, acceptedLastDay: h.acceptedLastDay ?? null, workingNow: h.workingNow ?? null, awaitingVerdict: h.awaitingVerdict ?? null,
      pendingVerification: h.pendingVerification ?? null, pendingFeedback: h.pendingFeedback ?? null, pendingOracle: h.pendingOracle ?? null, computedAt: h.computedAt ?? null },
    hourly: hourly.data ? { until: hourly.data.until, hours: hourly.data.hours, accepted: hourly.data.accepted, error: hourly.error } : { error: hourly.error },
    counts: { oracle: oracle.data ?? null, publications: pubs.data?.counts ?? pubs.data ?? null },
    network, fleet, ranks, landscape: latestLandscape(), history: rows.map(r => [r.ts, r.accepted, r.fleet_accepted, r.connected, r.seats]) };
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  const full = path.normalize(path.join(WEBROOT, p));
  if (full !== WEBROOT && !full.startsWith(WEBROOT_SEP)) { res.writeHead(403).end(); return; }
  fs.readFile(full, (err, data) => {
    if (err) { // SPA fallback
      fs.readFile(path.join(WEBROOT, 'index.html'), (e2, idx) => e2 ? res.writeHead(404).end('not found') : (res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }), res.end(idx)));
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}
function sendJSON(res, code, obj) { sendBody(res, code, Buffer.from(JSON.stringify(obj))); }
// gzip when the client accepts it: the hub pulls every box through an SSH tunnel
function sendBody(res, code, json, gz) {
  const zip = json.length > 1024 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '');
  const body = zip ? (gz || zlib.gzipSync(json)) : json;
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': body.length, vary: 'accept-encoding', ...(zip && { 'content-encoding': 'gzip' }) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  // Host allowlist (loopback only) — reject DNS-rebinding / off-host Host headers.
  const host = (req.headers.host || '').split(':')[0];
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) { res.writeHead(421).end('bad host'); return; }
  // Reject genuinely cross-site requests only. Browsers attach an Origin to same-origin
  // module-script / CORS-mode subresource fetches too, so allow any loopback origin; the
  // listener is loopback-only and the Host allowlist already blocks DNS-rebinding.
  if (req.headers.origin) {
    let oh = null; try { oh = new URL(req.headers.origin).hostname; } catch {}
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(oh)) { res.writeHead(403).end('cross-origin not allowed'); return; }
  }
  if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
  let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end('bad url'); return; }
  try {
    if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, service: 'imd-monitor', workers: WORKERS.length, time: new Date().toISOString() });
    if (url.pathname === '/api/state') return sendJSON(res, 200, await buildState());
    if (url.pathname === '/api/work') return sendJSON(res, 200, await workState());
    if (url.pathname === '/api/watch') return sendJSON(res, 200, watchState());
    if (url.pathname === '/api/network') return sendJSON(res, 200, await networkState());
    if (url.pathname === '/api/history') {
      const map = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
      const h = historyBody(map[url.searchParams.get('range')] || 86400);
      return sendBody(res, 200, h.json, h.gz);
    }
    return serveStatic(req, res);
  } catch (e) { console.error(`${url.pathname}: ${e && e.stack || e}`); return sendJSON(res, 500, { error: 'internal' }); }
});

// Started only as the service's entry point; tests require() this file for its helpers (no listener, no timers).
if (require.main === module) {
  recordHistory();
  setInterval(recordHistory, 30000).unref?.();
  recordNetwork().catch(() => {});
  setInterval(() => recordNetwork().catch(() => {}), 600000).unref?.();
  // A failed bind (another process on the port) exits non-zero; the unit's start limit then shows a failed unit.
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') console.error(`FATAL: ${HOST}:${PORT} is already in use by another process; the monitor is NOT serving. Find it with: ss -ltnp 'sport = :${PORT}'`);
    else console.error(`FATAL: server error: ${e && e.stack || e}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => console.log(`imd-monitor listening on http://${HOST}:${PORT} (workers: ${WORKERS.map(w => w.seat).join(', ')})`));
  process.on('SIGTERM', () => { try { db.close(); } catch {} server.close(() => process.exit(0)); });
} else {
  module.exports = { history, allowanceForecast, newerReading, classifyAttempt, parseHeavy, heavyByToken, heavyRecent, recordsData, watcherRecords,
    loadRecords, seatRecords, recordHistory, buildState, workState, fetchJSON, fetchAgent, cachedFetch, db,
    _resetForTests: () => { records = { at: 0, data: null, error: null }; heavyCache = { sig: null, data: null }; agentCache.clear(); netCache.clear(); } };
}
