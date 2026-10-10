'use strict';
// IMD worker monitor — local HUB. Runs on the WORKSTATION, not on a box. Every box keeps its
// own loopback-only backend (server/index.js) reached through its own SSH tunnel; this process
// merges N of them into ONE page: it serves the built SPA and fans /api/state + /api/history
// out to every box, tagging results by box. Zero deps, loopback only, GET only, read-only —
// it cannot control a worker any more than the per-box backends can.
//   node hub.js [--port 18790] [--web ../web/dist] [--watcher <id>] --box <id>=<localPort>=<name>[=<note>] ...
// --watcher pins the watcher box: only that box's /api/watch, /api/work and /api/network are used.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
let PORT = 18790;
let WEBROOT = path.join(__dirname, '..', 'web', 'dist');
const BOXES = [];
let WATCHER = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') PORT = Number(argv[++i]);
  else if (a === '--web') WEBROOT = path.resolve(argv[++i]);
  else if (a === '--watcher') WATCHER = String(argv[++i] || '');
  else if (a === '--box') {
    const [id, port, name, ...note] = String(argv[++i] || '').split('=');
    if (!id || !Number(port)) { console.error('bad --box (want id=port=name[=note]):', argv[i]); process.exit(2); }
    BOXES.push({ id, port: Number(port), name: name || id, note: note.join('=') || null, base: `http://127.0.0.1:${Number(port)}` });
  } else { console.error('unknown arg', a); process.exit(2); }
}
if (!BOXES.length) { console.error('usage: hub.js [--port N] [--web DIR] [--watcher ID] --box id=port=name[=note] ...'); process.exit(2); }
if (WATCHER !== null && !BOXES.some((b) => b.id === WATCHER)) { console.error('--watcher names no --box id:', WATCHER); process.exit(2); }
// boxes asked for the watcher's data (/api/watch, /api/work, /api/network): the pinned one, else every box in order
const WATCHER_BOXES = WATCHER !== null ? BOXES.filter((b) => b.id === WATCHER) : BOXES;
WEBROOT = path.normalize(WEBROOT);
const WEBROOT_SEP = WEBROOT.endsWith(path.sep) ? WEBROOT : WEBROOT + path.sep;
const HOST = '127.0.0.1';
// A per-box /api/state can legitimately take tens of seconds when api.imd.fun hangs (the backend
// fetches agent cards with a 10 s timeout each); /api/history grows ~1 MB/day/box until the backend
// downsamples. Budgets are generous and the last good answer is kept per box, so a slow poll never
// makes a healthy box vanish from the page.
const STATE_TIMEOUT_MS = 30000;
const HISTORY_TIMEOUT_MS = 60000;
// Response bodies are read with a byte cap (counted after decompression), so a box backend or whatever
// listens on a tunnel port cannot make the hub buffer an unbounded answer.
const BODY_CAP = 8 * 1024 * 1024;
const HISTORY_BODY_CAP = 32 * 1024 * 1024;

// ---------- upstream ----------
async function getJSON(url, ms, cap = BODY_CAP) {
  // gzip over the SSH tunnel; fetch decompresses while streaming, so the cap applies to decompressed bytes
  const ctl = new AbortController();
  const r = await fetch(url, { headers: { accept: 'application/json', 'accept-encoding': 'gzip' }, signal: AbortSignal.any([AbortSignal.timeout(ms), ctl.signal]) });
  if (!r.ok) { ctl.abort(); throw new Error('http ' + r.status); }
  const chunks = []; let size = 0;
  if (r.body) for await (const chunk of r.body) {
    size += chunk.byteLength;
    if (size > cap) { ctl.abort(); throw new Error(`bad payload: body over ${cap} bytes`); }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// error kind: 'refused' = nothing listening on the tunnel port (tunnel down); 'timeout' = the
// backend answered too slowly (usually api.imd.fun); 'http' / 'bad payload' / 'error' otherwise.
function errInfo(e) {
  const code = e?.cause?.code || e?.code;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return { kind: 'refused', error: String(code) };
  if (e?.name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT') return { kind: 'timeout', error: 'timeout' };
  const msg = String(e?.message || e);
  if (/^http \d+/.test(msg)) return { kind: 'http', error: msg };
  if (/^bad payload/.test(msg)) return { kind: 'bad payload', error: msg };
  return { kind: 'error', error: code ? String(code) : msg };
}
const boxMeta = (b) => ({ id: b.id, name: b.name, note: b.note, port: b.port });
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

const lastState = new Map();   // box id -> last good { generated_utc, host, workers }
const lastHist = new Map();    // `${box id}:${range}` -> last good { since, until, series }

async function boxState(b) {
  try {
    const s = await getJSON(b.base + '/api/state', STATE_TIMEOUT_MS);
    if (!isObj(s) || !Array.isArray(s.workers)) throw new Error('bad payload: state shape');
    const good = { generated_utc: typeof s.generated_utc === 'string' ? s.generated_utc : null, host: isObj(s.host) ? s.host : {},
      workers: s.workers.filter(isObj).map((w) => ({ ...w })) };
    lastState.set(b.id, { ...good, observed_utc: new Date().toISOString() });
    return { ...boxMeta(b), ok: true, ...good };
  } catch (e) {
    const last = lastState.get(b.id);
    // last_workers lets the page say "5 of 10 workers visible" instead of shrinking the fleet.
    return { ...boxMeta(b), ok: false, ...errInfo(e), last_ok_utc: last?.observed_utc || null,
      last_workers: last ? last.workers.map((w) => ({ seat: w.seat, alias: w.alias, token: w.token, account: w.account || null })) : [] };
  }
}

async function buildState() {
  const boxes = await Promise.all(BOXES.map(boxState));
  // Account sharing is fleet-wide: one provider account can back seats on several boxes, and
  // each box only knows its own seats — recompute across all boxes, using the last-known worker
  // list for a box that is unreachable right now (marked so the page can say so).
  const all = boxes.flatMap((b) => (b.ok ? b.workers.map((w) => ({ w, b, live: true })) : (b.last_workers || []).map((w) => ({ w, b, live: false }))));
  for (const { w, b, live } of all) {
    if (!live || !w.account) continue;
    w.shares_account_with = all
      .filter((o) => o.w !== w && o.w.account === w.account)
      .map((o) => (o.b === b ? o.w.alias : `${o.w.alias} (${o.b.name}${o.live ? '' : ', unreachable'})`));
  }
  // a notification problem (an unexpected payload from one box) must never take the merged state down with it
  try { notifyAllowance(all); } catch (e) { console.error('notifyAllowance:', e?.message || e); }
  try { notifyAttention(boxes); } catch (e) { console.error('notifyAttention:', e?.message || e); }
  return { generated_utc: new Date().toISOString(), hub: true, boxes };
}
// One in-flight build per key: callers share the pending promise until it settles, and the settled answer is reused
// for ttlMs counted from its COMPLETION (a slow tunnel used to outlast a start-time TTL and start overlapping fan-outs).
// A rejected build is not reused. Only the newest build may mark the memo settled.
function memo(ttlMs, build) {
  let m = { seq: 0, promise: null, pending: false, settledAt: 0 };
  return (...args) => {
    if (m.promise && (m.pending || Date.now() - m.settledAt < ttlMs)) return m.promise;
    const seq = m.seq + 1;
    const promise = Promise.resolve().then(() => build(...args));
    m = { seq, promise, pending: true, settledAt: 0 };
    promise.then(() => { if (m.seq === seq) { m.pending = false; m.settledAt = Date.now(); } },
      () => { if (m.seq === seq) m = { seq, promise: null, pending: false, settledAt: 0 }; });
    return promise;
  };
}
// Box state changes once per 30 s collection: reuse one merged answer for 10 s so repeated /api/state
// requests (tabs, reloads, or another page pointing at the hub) do not each fan out to every box.
const cachedState = memo(10000, buildState);

// Windows toasts for things that otherwise sit unseen on the News tab: a NEW failure pattern on your seats
// (watcher patterns.json first_seen later than the last toast) and the "N agents need attention" strip going
// non-empty. Checked every 5 minutes against the watcher box's /api/watch; the last-toasted times persist beside this file
// so a hub restart does not replay old news. IMD_HUB_TOAST=0 disables every toast. toast() rate-limits (see there); a
// toast it holds back leaves the matching state untouched, so the news is toasted on a later check instead of lost.
const TOAST_STATE = path.join(__dirname, '.toast-state.json');
let toastState = {}; try { toastState = JSON.parse(fs.readFileSync(TOAST_STATE, 'utf8')); } catch {}
const saveToastState = () => { try { fs.writeFileSync(TOAST_STATE, JSON.stringify(toastState)); } catch {} };
async function notifyNews() {
  if (process.platform !== 'win32' || process.env.IMD_HUB_TOAST === '0') return;
  for (const b of WATCHER_BOXES) {
    let w; try { w = await getJSON(b.base + '/api/watch', STATE_TIMEOUT_MS); } catch { continue; }
    if (!isObj(w) || w.enabled === false) continue;
    const since = Number(toastState.patterns_since || 0) || (Date.now() - 6 * 3600 * 1000);   // first run: the last 6 h only
    let newest = since; const fresh = [];
    // the documented place is failures.patterns; a top-level patterns is accepted from older backends
    const pats = isObj(w.failures) && isObj(w.failures.patterns) ? w.failures.patterns : isObj(w.patterns) ? w.patterns : {};
    for (const [name, p] of Object.entries(pats)) {
      const t = Date.parse(isObj(p) ? p.first_seen : '') || 0;
      if (t > since) { fresh.push(`${name} x${isObj(p) ? p.count : '?'}`); newest = Math.max(newest, t); }
    }
    if (fresh.length && toast(`New failure pattern on your seats: ${fresh.join(', ')}. Details on the News tab.`, 'patterns')) { toastState.patterns_since = newest; saveToastState(); }
    // contract-work standing (IMD docs, "How contract work is handed out"): one toast when the set of seats needing attention changes (probation,
    // retry due, not qualifying, standing unknown or stale); the key persists so a hub restart does not repeat it and a
    // cleared condition re-arms it. A new bad result gets its own toast (one more within the last 3 = 24 h probation).
    const alerts = contractAlerts(w); const ckey = alerts.join('|');
    if (ckey !== String(toastState.contract_key || '') && (!ckey || toast(`Contract work: ${alerts.slice(0, 4).join(', ')}${alerts.length > 4 ? ` and ${alerts.length - 4} more` : ''}. Details on the Agents tab.`, 'contract'))) { toastState.contract_key = ckey; saveToastState(); }
    const bsince = Number(toastState.contract_bad_since || 0) || (Date.now() - 6 * 3600 * 1000); let bnewest = bsince; const bads = [];
    for (const ch of Array.isArray(w.contract_changes) ? w.contract_changes : []) {
      if (!isObj(ch) || ch.baseline || !Array.isArray(ch.events) || !ch.events.includes('bad_added')) continue;
      const tt = Date.parse(ch.ts) || 0; if (tt > bsince) { bads.push(`#${ch.token}`); bnewest = Math.max(bnewest, tt); }
    }
    if (bads.length && toast(`Bad contract result on ${[...new Set(bads)].join(', ')}: 2 bad of the last 3 means 24 h at lower priority. Details on the News tab.`, 'contract_bad')) { toastState.contract_bad_since = bnewest; saveToastState(); }
    break;   // one watcher (the watcher box)
  }
}
function contractAlerts(w) {
  const c = isObj(w.contract) ? w.contract : null; if (!c) return [];
  const out = [], now = Date.now();
  if (c.stale) out.push(`standing not read since ${String(c.read_at || '?').slice(0, 16).replace('T', ' ')}Z`);   // constant while stale: one toast, not one per hour
  for (const s of Array.isArray(c.seats) ? c.seats : []) {
    if (!isObj(s)) continue;
    const t = `#${s.token}`;
    if (s.probationUntil && Date.parse(s.probationUntil) > now) out.push(`${t} on probation until ${String(s.probationUntil).slice(0, 16).replace('T', ' ')}Z`);
    else if (s.retryDue) out.push(`${t} retry due`);
    if (s.qualifies === false) out.push(`${t} not qualifying${Array.isArray(s.missing) && s.missing.length ? ' (missing ' + s.missing.join(', ') + ')' : ''}`);
    else if (s.unknown && !c.stale) out.push(`${t} standing unknown`);
  }
  return out.sort();
}
setInterval(() => { notifyNews().catch(() => {}); }, 5 * 60 * 1000);
setTimeout(() => { notifyNews().catch(() => {}); }, 20 * 1000);
let attentionToasted = '';
// systemd unit states printed as-is; anything else the seat's export says prints as 'unknown'
const SERVICE_STATES = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating']);
function notifyAttention(boxes) {
  if (process.platform !== 'win32' || process.env.IMD_HUB_TOAST === '0') return;
  const bad = [];
  for (const b of boxes) {
    if (!b.ok) { bad.push(`${b.name} unreachable`); continue; }
    for (const w of b.workers || []) {
      const s = w.snapshot || {}; const svc = s.service || {};
      if (svc.active && svc.active !== 'active') bad.push(`${w.alias} ${SERVICE_STATES.has(svc.active) ? svc.active : 'unknown'}`);
      if (s.reset_credits && s.reset_credits.auth_error) bad.push(`${w.alias} login dead`);
      if (Number(s.jobs?.reconnects_today) >= 100) bad.push(`${w.alias} reconnect storm (${s.jobs.reconnects_today} today)`);
    }
  }
  const key = bad.sort().join('|');
  if (key && key !== attentionToasted && !toast(`Attention: ${bad.join(', ')}.`, 'attention')) return;
  attentionToasted = key;
}
// One Windows toast per provider account when its weekly window crosses 90% (re-armed once it drops
// below 85%), so you know to press the free reset by hand: Claude's reset is web/Desktop only and
// its credit is not exposed to the CLI (Codex accounts get the toast without that hint). Set IMD_HUB_TOAST=0 to disable. Never blocks a poll.
const toasted = new Map();
// R-ALLOWANCE (same rule as the backend and the page): an account's reading is the export with the newest
// allowance.observed_utc among its seats (ties: the higher used fraction), never simply the highest usage.
const epochOf = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const maxUsed = (al) => Math.max(-1, ...al.windows.map((w) => (isObj(w) && typeof w.used_fraction === 'number' ? w.used_fraction : -1)));
function newerReading(a, b) {
  if (!b) return true;
  const ta = epochOf(a.observed_utc) ?? -Infinity, tb = epochOf(b.observed_utc) ?? -Infinity;
  return ta !== tb ? ta > tb : maxUsed(a) > maxUsed(b);
}
function notifyAllowance(all) {
  if (process.platform !== 'win32' || process.env.IMD_HUB_TOAST === '0') return;
  const byAccount = new Map(); // label -> the chosen allowance reading
  for (const { w, live } of all) {
    if (!live) continue;
    const al = w.snapshot?.allowance;
    if (!isObj(al) || !Array.isArray(al.windows)) continue; // an incompatible shape is skipped, never thrown on
    const label = w.account || w.alias || w.seat;
    if (newerReading(al, byAccount.get(label))) byAccount.set(label, al);
  }
  for (const [label, al] of byAccount) {
    const win = al.windows.find((x) => isObj(x) && (x.name === 'seven_day' || x.name === 'weekly') && typeof x.used_fraction === 'number');
    if (!win) continue;
    const used = win.used_fraction, fc = isObj(al.forecast) ? al.forecast : null, provider = al.provider || null;
    if (used >= 0.9 && !toasted.get(label)) {
      const eta = fc && typeof fc.hours_to_100 === 'number' ? `, 100% in about ${Math.round(fc.hours_to_100)} h` : '';
      const hint = provider === 'claude' ? ' Press the free reset on claude.ai to keep its agents working.' : '';
      if (toast(`${label}: weekly allowance at ${Math.round(used * 100)}%${eta}.${hint}`, 'allowance')) toasted.set(label, true);
    } else if (used < 0.85 && toasted.get(label)) toasted.delete(label);
  }
}
// The text reaches PowerShell through an environment variable, never inside the command, so quote
// characters in account labels or watcher strings cannot change the script. PowerShell is started by its
// absolute path under %WINDIR%, never looked up by name. Rate limit: one toast per category per 10 minutes
// and 6 per hour overall; returns false when a toast is held back (or WINDIR is unset).
const POWERSHELL = process.env.WINDIR ? path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
const toastLast = new Map();   // category -> time of its last toast
let toastTimes = [];           // times of the toasts in the last hour
function toast(msg, category) {
  const now = Date.now();
  toastTimes = toastTimes.filter((t) => now - t < 3600 * 1000);
  if (!POWERSHELL || toastTimes.length >= 6 || now - (toastLast.get(category) || 0) < 10 * 60 * 1000) return false;
  toastLast.set(category, now); toastTimes.push(now);
  const text = String(msg).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 300);
  const ps = "$null=[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime];" +
    '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);' +
    "$n=$t.GetElementsByTagName('text');$null=$n.Item(0).AppendChild($t.CreateTextNode('IMD monitor'));" +
    '$null=$n.Item(1).AppendChild($t.CreateTextNode($env:IMD_TOAST));' +
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))";
  try { spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { env: { ...process.env, IMD_TOAST: text }, detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  return true;
}

async function buildHistory(range) {
  const q = '/api/history?range=' + encodeURIComponent(range);
  const parts = await Promise.all(BOXES.map(async (b) => {
    try {
      const h = await getJSON(b.base + q, HISTORY_TIMEOUT_MS, HISTORY_BODY_CAP);
      if (!isObj(h) || !Number.isFinite(h.since) || !Number.isFinite(h.until) || !isObj(h.series)) throw new Error('bad payload: history shape');
      const series = {};
      for (const [k, v] of Object.entries(h.series)) if (Array.isArray(v)) series[k] = v;
      const good = { since: h.since, until: h.until, series };
      lastHist.set(`${b.id}:${range}`, { ...good, observed_utc: new Date().toISOString() });
      return { b, h: good };
    } catch (e) { return { b, err: errInfo(e), last: lastHist.get(`${b.id}:${range}`) }; }
  }));
  const series = {}; const boxes = {}; let since = null, until = null;
  for (const p of parts) {
    const h = p.h || p.last;
    if (p.err) boxes[p.b.id] = { ok: false, ...p.err, stale: !!p.last, last_ok_utc: p.last?.observed_utc || null };
    else boxes[p.b.id] = { ok: true, since: h.since, until: h.until };
    if (!h) continue; // failed and never seen: no series for this box
    since = since == null ? h.since : Math.min(since, h.since);
    until = until == null ? h.until : Math.max(until, h.until);
    for (const [k, v] of Object.entries(h.series)) series[`${p.b.id}/${k}`] = v;
  }
  return { since, until, hub: true, boxes, series };
}
// Box history changes once per 30 s recording: reuse one merged answer per range for 25 s so
// extra tabs, reloads and Refresh clicks don't each pull every box through its tunnel again.
const histMemo = new Map(); // range -> memo (three supported ranges, so bounded)
function cachedHistory(range) {
  if (!histMemo.has(range)) histMemo.set(range, memo(25000, () => buildHistory(range)));
  return histMemo.get(range)();
}

// Verified work by category comes from the one box that runs the heavy-work watcher (the watcher box): ask the boxes
// in order (only the --watcher box when pinned), use the first that has it, keep only your tokens, and add network totals for context.
async function buildWork() {
  if (!lastState.size) await cachedState(); // learn your tokens first
  const ours = new Set([...lastState.values()].flatMap((s) => s.workers.map((w) => String(w.token))));
  for (const b of WATCHER_BOXES) {
    try {
      const w = await getJSON(b.base + '/api/work', STATE_TIMEOUT_MS);
      if (!isObj(w) || !w.enabled) continue;
      const all = isObj(w.records) ? w.records : {};
      const net = { seats: 0, attempts: 0, accepted: 0, rejected: 0, failed: 0, pending: 0 };
      for (const r of Object.values(all)) if (isObj(r)) { net.seats++; for (const k of ['attempts', 'accepted', 'rejected', 'failed', 'pending']) net[k] += Number(r[k]) || 0; }
      const records = {}; for (const t of ours) if (isObj(all[t])) records[t] = all[t];
      return { enabled: true, box: b.id, generated_utc: w.generated_utc, records_at: w.records_at, records_error: w.records_error || null,
        records, network: net, heavy: isObj(w.heavy) ? w.heavy : {}, heavy_recent: isObj(w.heavy_recent) ? w.heavy_recent : {}, heavy_since: w.heavy_since };
    } catch {}
  }
  return { enabled: false };
}
const cachedWork = memo(60000, buildWork);

// Release checks, failure digest and news also come from the watcher box: first box that has it wins (the --watcher box when pinned).
async function buildWatch() {
  for (const b of WATCHER_BOXES) {
    try {
      const w = await getJSON(b.base + '/api/watch', STATE_TIMEOUT_MS);
      if (!isObj(w) || !w.enabled) continue;
      return { ...w, box: b.id };
    } catch {}
  }
  return { enabled: false };
}
const cachedWatch = memo(60000, buildWatch);

// Network totals and your fleet's share also come from the watcher box (its backend records them every 10 min; the --watcher box when pinned).
async function buildNetwork() {
  for (const b of WATCHER_BOXES) {
    try {
      const n = await getJSON(b.base + '/api/network', STATE_TIMEOUT_MS);
      if (!isObj(n) || !n.enabled) continue;
      return { ...n, box: b.id };
    } catch {}
  }
  return { enabled: false };
}
const cachedNetwork = memo(60000, buildNetwork);

// ---------- http (same guards as the per-box backend) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function serveStatic(pathname, res) {
  let p = pathname;
  try { p = decodeURIComponent(p); } catch { res.writeHead(400).end('bad path'); return; }
  if (p === '/' || p === '') p = '/index.html';
  if (p.includes('\\') || p.includes('\0')) { res.writeHead(403).end(); return; }
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
function sendJSON(res, code, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length, 'cache-control': 'no-store' }); res.end(b); }

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) { res.writeHead(421).end('bad host'); return; }
    if (req.headers.origin) {
      let oh = null; try { oh = new URL(req.headers.origin).hostname; } catch {}
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(oh)) { res.writeHead(403).end('cross-origin not allowed'); return; }
    }
    // A request another site's page triggers (an <img> or no-cors fetch sends no Origin) still carries
    // Sec-Fetch-Site in current browsers: refuse cross-site and same-site; same-origin, none and absent pass.
    const sfs = String(req.headers['sec-fetch-site'] || '');
    if (sfs === 'cross-site' || sfs === 'same-site') { res.writeHead(403).end('cross-site not allowed'); return; }
    if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
    let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end('bad url'); return; }
    if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, service: 'imd-monitor-hub', boxes: BOXES.map(boxMeta), web: path.basename(WEBROOT), time: new Date().toISOString() });
    if (url.pathname === '/api/state') return sendJSON(res, 200, await cachedState());
    if (url.pathname === '/api/work') return sendJSON(res, 200, await cachedWork());
    if (url.pathname === '/api/watch') return sendJSON(res, 200, await cachedWatch());
    if (url.pathname === '/api/network') return sendJSON(res, 200, await cachedNetwork());
    if (url.pathname === '/api/history') {
      const range = url.searchParams.get('range');
      return sendJSON(res, 200, await cachedHistory(['24h', '7d', '30d'].includes(range) ? range : '24h'));
    }
    return serveStatic(url.pathname, res);
  } catch (e) {
    try { if (!res.headersSent) sendJSON(res, 500, { error: 'internal', detail: String(e?.message || e) }); else res.end(); } catch {}
  }
});
server.on('error', (e) => { console.error('hub server error:', e?.message || e); process.exit(1); });
process.on('unhandledRejection', (e) => console.error('hub unhandled rejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('hub uncaught exception:', e?.message || e));

server.listen(PORT, HOST, () => console.log(`imd-monitor-hub listening on http://${HOST}:${PORT} (boxes: ${BOXES.map((b) => `${b.name}@${b.port}`).join(', ')}; web: ${WEBROOT})`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
