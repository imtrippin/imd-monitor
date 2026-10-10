// Headless-browser checks of the built page (web/dist) against synthetic fixtures served on loopback:
//   staleness: an old heartbeat, and the monitor going away for over 2 min ("last known");
//   range changes: a slow 7d answer never lands under 30d, and the 30d range never empties the 24 h throughput chart;
//   hidden tab: only a slow state poll while hidden, everything refreshed when visible again;
//   no horizontal overflow at 390 px.
// Run: (cd web && npm run build) && node tests/page/browser-test.mjs
// Playwright is not a dependency of this repo: it is resolved from web/ or from PLAYWRIGHT_FROM (any directory whose
// node_modules holds playwright). PLAYWRIGHT_CHANNEL picks the browser (default "chrome"; "" = bundled Chromium).
// Every request outside the fixture server is aborted.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'web/dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('build the page first: cd web && npm run build'); process.exit(2); }
let chromium;
for (const from of [process.env.PLAYWRIGHT_FROM, path.join(root, 'web')].filter(Boolean)) {
  try { ({ chromium } = createRequire(path.join(from, 'package.json'))('playwright')); break; } catch {}
}
if (!chromium) { console.error('playwright not found: set PLAYWRIGHT_FROM to a directory with node_modules/playwright'); process.exit(2); }
const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'chrome';

// ---------- synthetic fixtures (fictional seats, token 2/3, no real identifiers) ----------
const T0 = Date.now();
const iso = (t) => new Date(t).toISOString();
const naive = (t) => iso(t).slice(0, 19); // heartbeat stamps as older collectors write them (UTC, no zone)
function worker(seat, token, hbAgo) {
  return { seat, alias: seat, token, account: 'Codex · account 1', configured_runtime: 'codex', snapshot_age_s: 5,
    agent: { agent_id: '10' + token }, snapshot: { generated_utc: iso(T0 - 5000), runtime: 'codex', concurrency: 2, tools: [], profiles: [],
      service: { active: 'active', tasks_running: 0, last_heartbeat_utc: naive(T0 - hbAgo) }, jobs: { submitted_total: 48, submitted_today: 48, accepted_today: 40 },
      tokens: { today: { total: 1000 }, alltime: { total: 2000 } },
      allowance: { provider: 'codex', source: 'last_observed', observed_utc: iso(T0 - 60000), windows: [{ name: 'weekly', used_fraction: 0.2, resets_at: iso(T0 + 86400e3) }] } } };
}
const state = () => ({ hub: true, generated_utc: iso(T0), boxes: [{ id: 'box1', name: 'Box 1', note: '203.0.113.10', ok: true, host: { cpus: 4 },
  workers: [worker('seatx', '2', 30e3), worker('seaty', '3', 3 * 3600e3)] }] });
const nowS = Math.floor(T0 / 1000);
const pts24 = Array.from({ length: 49 }, (_, i) => [nowS - 24 * 3600 + i * 1800, i]); // 48 submissions over the last day
const history = {
  '24h': { hub: true, since: 24, series: { 'box1/seatx.jobs.submitted_total': pts24 }, boxes: { box1: { ok: true } } },
  '7d': { hub: true, since: 168, series: {}, boxes: { box1: { ok: false, error: 'fixture-7d' } } },
  '30d': { hub: true, since: 720, series: {}, boxes: { box1: { ok: false, error: 'fixture-30d' } } },
};
const ctl = { stateFail: false, delay7d: 0 };
const requests = [];
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname.startsWith('/api/')) {
    const name = u.pathname.slice(5); requests.push(name + (name === 'history' ? ':' + u.searchParams.get('range') : ''));
    if (name === 'state') return ctl.stateFail ? send(502, { error: 'fixture down' }) : send(200, state());
    if (name === 'history') { const r = u.searchParams.get('range'); return setTimeout(() => send(200, history[r] || {}), r === '7d' ? ctl.delay7d : 0); }
    if (name === 'watch' || name === 'work' || name === 'network') return send(200, { enabled: false });
    return send(404, {});
  }
  const f = path.join(dist, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(dist) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;

const checks = []; const errors = [];
const check = (name, ok, got) => { checks.push([name, !!ok]); console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  got: ' + JSON.stringify(got))); };
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/502|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route('**/*', (r) => (new URL(r.request().url()).host === new URL(base).host ? r.continue() : r.abort()));
  return { ctx, page };
}
const text = (page) => page.evaluate(() => document.body.innerText);
// fake-clock time in steps, letting the real fetches each step started finish in between
async function advance(page, ms, step = 30000) { for (let t = 0; t < ms; t += step) { await page.clock.runFor(Math.min(step, ms - t)); await sleep(150); } }

try {
  // ---------- staleness ----------
  {
    const { ctx, page } = await newPage();
    await page.clock.install({ time: T0 });
    await page.goto(base); await page.waitForSelector('table.agents tbody tr');
    const pills = () => page.locator('table.agents .pill').allInnerTexts().then((x) => x.map((s) => s.trim()).sort());
    let t; let p = await pills();
    check('fresh heartbeat Idle; 3 h old heartbeat on an active unit Stale heartbeat', p.join('|') === 'Idle|Stale heartbeat', p);
    ctl.stateFail = true;
    await advance(page, 60000, 10000);
    t = await text(page);
    check('under 2 min of failures: rows not yet last known', !/Last known/.test(t) && /disconnected/.test(t));
    await advance(page, 90000, 10000);
    t = await text(page);
    check('over 2 min of failures: rows marked Last known', (t.match(/Last known/g) || []).length >= 2, t.slice(0, 400));
    check('top bar says last known', /disconnected · last known/.test(t));
    p = await pills();
    check('no row still reads Idle or Working', p.length === 2 && p.every((x) => x === 'Last known'), p);
    ctl.stateFail = false;
    await advance(page, 20000, 10000);
    t = await text(page);
    p = await pills();
    check('recovery clears last known', !/Last known/.test(t) && p.join('|') === 'Idle|Stale heartbeat', p);
    await ctx.close();
  }

  // ---------- range changes and the 24 h source ----------
  {
    const { ctx, page } = await newPage();
    await page.goto(base + '#activity'); await page.waitForSelector('.panel h3');
    await sleep(500);
    const totalOf = async () => Number(((await text(page)).match(/([\d,]+) in total/) || [])[1]?.replace(/,/g, '') ?? NaN);
    const before = await totalOf();
    check('throughput chart counts the 24 h submissions', before > 40, before);
    await page.locator('nav.topnav button', { hasText: 'Agents' }).click();
    await page.locator('table.agents tbody tr').first().click(); await page.waitForSelector('.modal');
    ctl.delay7d = 1500; requests.length = 0;
    await page.locator('.modal .toggle button', { hasText: '7d' }).click();
    await sleep(100);
    await page.locator('.modal .toggle button', { hasText: '30d' }).click();
    await sleep(400);
    check('30d requested at once while 7d is still in flight', requests.includes('history:7d') && requests.includes('history:30d'), requests);
    await sleep(1800); // the slow 7d answer arrives now
    let t = await text(page);
    check('latest selection wins: 30d data shown, the late 7d answer dropped', /fixture-30d/.test(t) && !/fixture-7d/.test(t));
    await page.keyboard.press('Escape');
    await page.locator('nav.topnav button', { hasText: 'Activity' }).click(); await sleep(300);
    const after = await totalOf();
    check('30d in the record leaves the daily throughput chart intact', after === before, { before, after });
    await ctx.close();
  }

  // ---------- a tab opened in the background still loads its state once at start ----------
  {
    const { ctx, page } = await newPage();
    await page.addInitScript(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    });
    requests.length = 0;
    await page.goto(base);
    const rows = await page.waitForSelector('table.agents tbody tr', { timeout: 5000 }).then(() => true, () => false);
    check('opened hidden: state loaded once at start, not after the slow poll', rows && requests.filter((r) => r === 'state').length === 1, requests);
    await ctx.close();
  }

  // ---------- hidden tab ----------
  {
    const { ctx, page } = await newPage();
    await page.clock.install({ time: T0 });
    await page.goto(base); await page.waitForSelector('table.agents tbody tr'); await sleep(300);
    const setHidden = (h) => page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, h);
    await setHidden(true); await sleep(200);
    requests.length = 0;
    await advance(page, 600000, 30000);
    const n = (k) => requests.filter((r) => r.startsWith(k)).length;
    check('hidden 10 min: one slow state poll (about once a minute)', n('state') >= 8 && n('state') <= 11, n('state'));
    check('hidden: no history, work, watch or network polls', n('history') + n('work') + n('watch') + n('network') === 0, requests);
    requests.length = 0;
    await setHidden(false); await sleep(600);
    check('visible again: everything refreshed at once', ['state', 'history:24h', 'work', 'watch', 'network'].every((k) => requests.includes(k)), requests);
    await page.setViewportSize({ width: 390, height: 800 }); await sleep(300);
    check('no horizontal overflow at 390 px', !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log('console/page errors:', errors.length ? errors : 'none');
const failed = checks.filter(([, ok]) => !ok).length + errors.length;
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
