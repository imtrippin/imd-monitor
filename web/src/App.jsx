import React, { useEffect, useMemo, useRef, useState } from 'react';

/* ---------- defensive coercion: box payloads are data, never trusted for shape ---------- */
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x) => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : null);
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);

/* ---------- format helpers (never invent data; null -> unavailable) ---------- */
const fmtInt = (n) => (num(n) == null ? '—' : Number(n).toLocaleString('en-US'));
const fmtBytes = (b) => {
  if (num(b) == null) return '—';
  const g = b / 1e9; if (g >= 1) return g.toFixed(g >= 10 ? 0 : 1) + ' GB';
  return (b / 1e6).toFixed(0) + ' MB';
};
const fmtTok = (n) => {
  if (num(n) == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};
const pct = (frac) => (num(frac) == null ? null : Math.max(0, Math.min(100, frac * 100)));
const fmtPct = (frac) => (num(frac) == null ? '—' : (frac * 100).toFixed(frac * 100 < 10 ? 1 : 0));
function localTime(iso) { if (!str(iso)) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function ago(sec) { sec = num(sec); if (sec == null) return 'unknown'; if (sec < 60) return Math.round(sec) + 's ago'; if (sec < 3600) return Math.round(sec / 60) + 'm ago'; return Math.round(sec / 3600) + 'h ago'; }
function uptime(sec) { sec = num(sec); if (sec == null) return '—'; const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return (d ? d + 'd ' : '') + h + 'h ' + m + 'm'; }
function resetIn(iso) { if (!str(iso)) return null; const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000); if (isNaN(s)) return null; if (s <= 0) return 'due'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : (h ? `${h}h ${m}m` : `${m}m`); }
const windowLabel = (w) => (w.name === 'five_hour' ? 'Five-hour' : w.name === 'seven_day' || w.name === 'weekly' ? 'Weekly' : `${num(w.window_minutes) ? Math.round(w.window_minutes / 60) + 'h' : (str(w.name) || '?')}`);
const nowSec = () => Math.floor(Date.now() / 1000);
const toEpoch = (iso) => { const t = str(iso) ? Math.floor(new Date(iso).getTime() / 1000) : NaN; return isNaN(t) ? null : t; };
const severity = (frac) => (num(frac) == null ? '' : frac >= 0.9 ? 'bad' : frac >= 0.7 ? 'warn' : 'ok');
const runtimeName = (rt) => (rt === 'claude' ? 'Claude Code' : rt === 'codex' ? 'Codex' : rt || '?');

/* ---------- state normalisation: the local hub (many boxes) or one box's own backend ---------- */
// received_s: when the page got this response (browser clock), so a snapshot's age keeps growing after it
function normalizeState(raw, received_s = nowSec()) {
  const boxes = raw.hub ? arr(raw.boxes).filter(obj)
    : [{ id: 'local', name: 'This box', note: null, ok: true, host: raw.host, workers: raw.workers, generated_utc: raw.generated_utc }];
  const workers = [];
  for (const b of boxes) if (b.ok) for (const w of arr(b.workers)) if (obj(w) && str(w.seat)) workers.push({ ...w, key: b.id + ':' + w.seat, box: b, received_s });
  return { generated_utc: raw.generated_utc, hub: !!raw.hub, boxes, workers };
}
function normalizeHist(raw) {
  if (!obj(raw)) return { series: {} };
  if (raw.hub) return { ...raw, series: obj(raw.series) || {} };
  const series = {}; for (const [k, v] of Object.entries(raw.series || {})) series['local/' + k] = v;
  return { ...raw, series };
}
const hkey = (w, kind, metric) => `${w.box.id}/${w.seat}.${kind}.${metric}`;
const hostKey = (b, metric) => `${b.id}/_host.host.${metric}`;

/* ---------- worker facts ---------- */
const snapOf = (wk) => obj(wk.snapshot);
const aliasOf = (wk) => str(wk.alias) || str(wk.seat) || '?';
const agentIdOf = (wk) => str(wk.agent?.agent_id);
const runtimeOf = (wk) => str(snapOf(wk)?.runtime) || str(wk.configured_runtime) || '?';
const toolsOf = (wk) => arr(snapOf(wk)?.tools).map(str).filter(Boolean);
const runningOf = (wk) => num(snapOf(wk)?.service?.tasks_running);
const concOf = (wk) => num(snapOf(wk)?.concurrency);
// a stamp without a zone (older collectors) is UTC; one with Z or an offset is taken as written
const utcIso = (s) => (str(s) ? (/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : s + 'Z') : null);
// the snapshot's age now: what the backend reported when the page fetched it plus the time since that fetch
// (box and browser clocks are never mixed); without the reported age, the snapshot's own time
function snapAgeOf(wk) {
  const a = num(wk.snapshot_age_s), rcv = num(wk.received_s);
  if (a != null) return a + (rcv != null ? Math.max(0, nowSec() - rcv) : 0);
  const g = toEpoch(snapOf(wk)?.generated_utc); return g == null ? null : Math.max(0, nowSec() - g);
}
// the last worker heartbeat's age: heartbeat -> snapshot on the box's clock, plus the snapshot's age
function heartbeatAgeOf(wk) {
  const snap = snapOf(wk); const hb = toEpoch(utcIso(snap?.service?.last_heartbeat_utc)); if (hb == null) return null;
  const g = toEpoch(snap?.generated_utc); const age = snapAgeOf(wk);
  return g != null && age != null ? Math.max(0, g - hb) + age : Math.max(0, nowSec() - hb);
}
const STALE_SNAPSHOT_S = 180, STALE_HEARTBEAT_S = 600;
// lost = the page has not reached /api/state for over 2 min: every row is only the last thing it knew
function statusOf(wk, lost = false) {
  const snap = snapOf(wk); const s = snap?.service;
  if (!snap) return { cls: 'stale', text: 'No data', rank: 0 };
  if (lost) return { cls: 'stale', text: 'Last known', rank: 1 };
  if (s?.active !== 'active') return { cls: 'down', text: 'Stopped', rank: 0 };
  const age = snapAgeOf(wk);
  if (age != null && age > STALE_SNAPSHOT_S) return { cls: 'stale', text: 'Stale', rank: 1 };
  // an active unit whose worker stopped logging heartbeats is not healthy, whatever its last heartbeat said
  const hba = heartbeatAgeOf(wk);
  if (hba != null && hba > STALE_HEARTBEAT_S) return { cls: 'stale', text: 'Stale heartbeat', rank: 1 };
  if ((runningOf(wk) || 0) > 0) return { cls: 'working', text: 'Working', rank: 3 };
  return { cls: 'idle', text: 'Idle', rank: 2 };
}
const needsAttention = (wk, lost = false) => ['down', 'stale'].includes(statusOf(wk, lost).cls);

/* ---------- error boundary: one bad payload must not blank the whole page ---------- */
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { console.error('render error in', this.props.label, err); }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }); }
  render() {
    if (!this.state.err) return this.props.children;
    return <div className="panel pad unreach">Couldn’t render {this.props.label || 'this section'}: <code>{String(this.state.err?.message || this.state.err)}</code>. The rest of the page keeps updating.</div>;
  }
}

/* ---------- agent avatar: a small line-drawn robot, varied by token ---------- */
function Avatar({ seed, size = 30 }) {
  const n = Number(seed) || 0; const eyes = n % 3; const mouth = Math.floor(n / 3) % 3;
  const s = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' };
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" aria-hidden="true" width={size - 6} height={size - 6}>
        <rect x="7" y="8.5" width="18" height="16.5" rx="3" {...s} />
        <path d="M16 8.5V5" {...s} /><circle cx="16" cy="4.2" r="1.3" fill="currentColor" />
        <path d="M5 16.5h2M25 16.5h2" {...s} />
        {eyes === 0 && <><circle cx="12.6" cy="15" r="1.4" fill="currentColor" /><circle cx="19.4" cy="15" r="1.4" fill="currentColor" /></>}
        {eyes === 1 && <path d="M11.2 15h2.8M18 15h2.8" {...s} />}
        {eyes === 2 && <><rect x="11.2" y="13.6" width="2.8" height="2.8" rx=".6" fill="currentColor" /><rect x="18" y="13.6" width="2.8" height="2.8" rx=".6" fill="currentColor" /></>}
        {mouth === 0 && <path d="M12.6 20.2q3.4 2.4 6.8 0" {...s} />}
        {mouth === 1 && <path d="M12.8 20.8h6.4" {...s} />}
        {mouth === 2 && <path d="M12.4 20.9l1.9-1.3 1.8 1.3 1.8-1.3 1.9 1.3" {...s} />}
      </svg>
    </span>
  );
}
function Pill({ st, detail }) { return <span className={'pill ' + st.cls}><span className="dot" />{st.text}{detail ? <span className="pill-detail">{detail}</span> : null}</span>; }
function Slots({ running, conc }) {
  if (num(conc) == null) return <span className="muted">—</span>;
  const r = Math.min(num(running) || 0, conc);
  return (
    <span className="slots" title={`${num(running) ?? '?'} of ${conc} task slots busy`}>
      <span className="slot-num">{num(running) ?? '—'} / {conc}</span>
      <span className="slot-boxes" aria-hidden="true">{Array.from({ length: conc }, (_, i) => <i key={i} className={i < r ? 'on' : ''} />)}</span>
    </span>
  );
}

/* ---------- tiny inline SVG line chart (detail view; no dependency) ---------- */
function LineChart({ series: raw, height = 200, yMax = 1, yFmt = (v) => Math.round(v * 100) + '%', empty }) {
  const W = 1000, H = height, padL = 44, padR = 12, padT = 12, padB = 22;
  const series = raw.map((s) => ({ ...s, points: arr(s.points).filter((p) => Array.isArray(p) && num(p[0]) != null && num(p[1]) != null) }));
  const all = series.flatMap((s) => s.points);
  if (!all.length) return <div className="empty">{empty || 'No history collected yet — snapshots build over time.'}</div>;
  let t0 = Infinity, t1 = -Infinity;
  for (const p of all) { if (p[0] < t0) t0 = p[0]; if (p[0] > t1) t1 = p[0]; }
  if (!(t1 > t0)) t1 = t0 + 1;
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (v) => padT + (1 - Math.min(v, yMax) / yMax) * (H - padT - padB);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="time series">
      {[0, 0.25, 0.5, 0.75, 1].map((g, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(g * yMax)} y2={y(g * yMax)} stroke={i === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <text x={4} y={y(g * yMax) + 4} fontSize="11" fill="var(--muted)">{yFmt(g * yMax)}</text>
        </g>
      ))}
      {series.map((s, si) => {
        const pts = s.points.slice().sort((a, b) => a[0] - b[0]);
        const spac = pts.length > 2 ? Math.max(60, medianSpacing(pts) * 3) : Infinity;
        const segs = []; let seg = [];
        for (let i = 0; i < pts.length; i++) { if (i && pts[i][0] - pts[i - 1][0] > spac) { segs.push(seg); seg = []; } seg.push(pts[i]); }
        if (seg.length) segs.push(seg);
        return segs.map((g, gi) => <polyline key={si + '-' + gi} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
          points={g.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')} />);
      })}
    </svg>
  );
}
function medianSpacing(pts) { const d = []; for (let i = 1; i < pts.length; i++) d.push(pts[i][0] - pts[i - 1][0]); d.sort((a, b) => a - b); return d[Math.floor(d.length / 2)] || 60; }

/* ---------- sparkline for box tiles (single series: de-emphasis line, accent end dot) ---------- */
function Sparkline({ points, max = 1 }) {
  const pts = arr(points).filter((p) => Array.isArray(p) && num(p[0]) != null && num(p[1]) != null).slice(-96);
  if (pts.length < 3) return <div className="spark empty-spark">collecting…</div>;
  const W = 160, H = 34, t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
  const x = (t) => 2 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 8), y = (v) => 3 + (1 - Math.min(v, max) / max) * (H - 6);
  const last = pts[pts.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke="var(--spark)" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" points={pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')} />
      <circle cx={x(last[0])} cy={y(last[1])} r="3" fill="var(--accent)" stroke="var(--surface)" strokeWidth="1.5" />
    </svg>
  );
}

/* ---------- tasks per hour (fleet): single series columns + per-box split in the tooltip ---------- */
function hourlyTasks(hist, workers, hours = 24) {
  const end = Math.floor(nowSec() / 3600) * 3600; const start = end - (hours - 1) * 3600;
  const rows = Array.from({ length: hours }, (_, i) => ({ t: start + i * 3600, total: 0, byBox: {} }));
  if (!hist) return rows;
  for (const w of workers) {
    const pts = arr(hist.series?.[hkey(w, 'jobs', 'submitted_total')]).filter((p) => Array.isArray(p) && num(p[0]) != null && num(p[1]) != null).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < pts.length; i++) {
      const dt = pts[i][0] - pts[i - 1][0]; if (dt > 3600) continue;
      const d = pts[i][1] - pts[i - 1][1]; if (!(d > 0)) continue; // counter reset or no change
      const h = Math.floor(pts[i][0] / 3600) * 3600; const idx = (h - start) / 3600;
      if (idx < 0 || idx >= hours) continue;
      rows[idx].total += d; rows[idx].byBox[w.box.name] = (rows[idx].byBox[w.box.name] || 0) + d;
    }
  }
  for (const r of rows) { r.total = Math.round(r.total); for (const k of Object.keys(r.byBox)) r.byBox[k] = Math.round(r.byBox[k]); }
  return rows;
}
function niceMax(v) { if (v <= 0) return 10; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; }
const hourLabel = (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: 'numeric' });
function TasksChart({ rows, boxes }) {
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const W = 1000, H = 190, padL = 44, padR = 8, padT = 10, padB = 24;
  const max = niceMax(Math.max(...rows.map((r) => r.total), 1));
  const band = (W - padL - padR) / rows.length; const bw = Math.min(24, band - 6);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const ticks = [0, max / 2, max];
  const total = rows.reduce((a, r) => a + r.total, 0);
  const peak = rows.reduce((m, r) => (r.total > m.total ? r : m), rows[0] || { total: 0, t: 0 });
  const hv = hover != null ? rows[hover] : null;
  return (
    <div className="panel pad">
      <div className="panel-head">
        <div><div className="eyebrow">Fleet throughput</div><h3>Tasks per hour</h3>
          <div className="muted small">Results submitted by all {fmtInt(boxes.reduce((a, b) => a + (b.ok ? arr(b.workers).length : 0), 0))} agents, last 24 hours (local time). {fmtInt(total)} in total; peak {fmtInt(peak.total)} at {hourLabel(peak.t)}. The network issues oracle work in batches, so empty hours mean no work was sent, not a fault.</div></div>
        <button className="btn ghost" onClick={() => setTable((v) => !v)}>{table ? 'Show chart' : 'Show table'}</button>
      </div>
      {!table ? (
        <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label={`Tasks per hour, last 24 hours, peak ${peak.total}`}>
            {ticks.map((v, i) => (
              <g key={i}>
                <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={i === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <text x={4} y={y(v) + 4} fontSize="11" fill="var(--muted)" className="tnum">{fmtInt(v)}</text>
              </g>
            ))}
            {rows.map((r, i) => {
              const x = padL + i * band + (band - bw) / 2; const top = y(r.total); const h = Math.max(0, y(0) - top); const rad = Math.min(4, h);
              return (
                <g key={r.t} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${hourLabel(r.t)}: ${r.total} tasks`}>
                  <rect x={padL + i * band} y={padT} width={band} height={H - padT - padB} fill="transparent" />
                  {h > 0 && <path d={`M${x},${y(0)} v${-(h - rad)} q0,${-rad} ${rad},${-rad} h${bw - 2 * rad} q${rad},0 ${rad},${rad} v${h - rad} z`} fill={hover === i ? 'var(--accent-strong)' : 'var(--accent)'} />}
                  {i % 3 === 0 && <text x={padL + i * band + band / 2} y={H - 6} fontSize="11" fill="var(--muted)" textAnchor="middle">{hourLabel(r.t)}</text>}
                </g>
              );
            })}
          </svg>
          {hv && (
            <div className="tip" style={{ left: `${Math.min(88, Math.max(8, ((hover + 0.5) / rows.length) * 100))}%` }}>
              <b>{hourLabel(hv.t)} – {hourLabel(hv.t + 3600)}</b>
              <div className="tip-row"><span>All agents</span><b className="tnum">{fmtInt(hv.total)}</b></div>
              {Object.entries(hv.byBox).sort().map(([k, v]) => <div className="tip-row" key={k}><span>{k}</span><span className="tnum">{fmtInt(v)}</span></div>)}
            </div>
          )}
        </div>
      ) : (
        <div className="table-scroll"><table className="mini-table"><thead><tr><th>Hour</th><th className="r">All</th>{boxes.map((b) => <th key={b.id} className="r">{b.name}</th>)}</tr></thead>
          <tbody>{rows.slice().reverse().map((r) => <tr key={r.t}><td>{hourLabel(r.t)}</td><td className="r tnum">{fmtInt(r.total)}</td>{boxes.map((b) => <td key={b.id} className="r tnum">{fmtInt(r.byBox[b.name] || 0)}</td>)}</tr>)}</tbody></table></div>
      )}
    </div>
  );
}

/* ---------- accounts: each provider account's allowance shown once ---------- */
// R-ALLOWANCE (shared with server/index.js and windows/hub.js): an account's reading is the seat export with the
// newest allowance.observed_utc; on a tie, the higher used fraction. It keeps its own observed_utc and source.
const usedMax = (al) => Math.max(-1, ...arr(al?.windows).filter(obj).map((w) => num(w.used_fraction) ?? -1));
const newerReading = (al, t, cur, curT) => !cur || t > curT || (t === curT && usedMax(al) > usedMax(cur));
function accountsOf(workers) {
  const m = new Map();
  for (const w of workers) {
    const al = obj(snapOf(w)?.allowance); const label = str(w.account) || runtimeName(runtimeOf(w));
    const cur = m.get(label) || { label, provider: str(al?.provider) || runtimeOf(w), seats: [], al: null, alWorker: null, obs: -1, rc: null, rcObs: -1 };
    cur.seats.push(w);
    const t = toEpoch(al?.observed_utc) ?? -1;
    if (al && newerReading(al, t, cur.al, cur.obs)) { cur.al = al; cur.alWorker = w; cur.obs = t; }
    // free resets are account-wide too: keep the freshest successful reading from any of its seats
    const rc = obj(snapOf(w)?.reset_credits); const rt = toEpoch(rc?.observed_utc) ?? -1;
    if (rc && num(rc.available) != null && rt >= cur.rcObs) { cur.rc = rc; cur.rcObs = rt; }
    m.set(label, cur);
  }
  return [...m.values()];
}
function AccountTile({ acct }) {
  const windows = arr(acct.al?.windows).filter(obj);
  return (
    <div className="tile">
      <div className="tile-top"><span className="tile-label">{acct.label}</span><span className="chip">{acct.seats.length} agent{acct.seats.length !== 1 ? 's' : ''}</span></div>
      {windows.length ? windows.map((w, i) => (
        <div className="allow" key={str(w.name) || i}>
          <div className="allow-top"><span>{windowLabel(w)}</span><b className={'sev-' + severity(w.used_fraction)}>{fmtPct(w.used_fraction)}%</b></div>
          <div className={'meter ' + severity(w.used_fraction)}><span style={{ width: (pct(w.used_fraction) ?? 0) + '%' }} /></div>
          <div className="muted small">{str(w.resets_at) ? `resets in ${resetIn(w.resets_at)} · ${localTime(w.resets_at)}` : 'reset time not reported'}</div>
          {(w.name === 'seven_day' || w.name === 'weekly') && <Forecast fc={obj(acct.al?.forecast)} />}
        </div>
      )) : <div className="muted small">Allowance not reported yet.</div>}
      {acct.rc && <ResetCredits rc={acct.rc} />}
      <div className="muted small tile-foot">{acct.al ?`${acct.al.source === 'live' ? 'live' : acct.al.source === 'mtime_fallback' ? 'last observed (file time)' : 'last observed'} · ${ago(nowSec() - (toEpoch(acct.al.observed_utc) ?? nowSec()))}` : 'no reading'}</div>
    </div>
  );
}

// Run-out forecast for the weekly window, computed by the box backend from the last 24 h of its history:
// pace per day, hours to 100% and whether that lands before the window's reset.
function Forecast({ fc }) {
  if (!fc || num(fc.pace_per_day) == null) return null;
  if (num(fc.hours_to_100) == null) return <div className="muted small">flat over the last {fmtInt(fc.based_on_hours)} h</div>;
  const h = Math.round(fc.hours_to_100);
  const when = h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
  return <div className={'small ' + (fc.before_reset ? 'sev-bad' : 'muted')}>
    +{Math.round(fc.pace_per_day * 100)} pts/day over the last {fmtInt(fc.based_on_hours)} h · 100% in about {when}{fc.before_reset ? ', before the reset' : ', after the reset'}
  </div>;
}

// Codex free rate-limit resets, read by the collector (never spent by it); the last successful reading is carried forward
function ResetCredits({ rc }) {
  const n = num(rc.available) ?? 0;
  const next = arr(rc.credits).filter((c) => obj(c) && c.status === 'available' && toEpoch(c.expires_utc) != null)
    .sort((a, b) => toEpoch(a.expires_utc) - toEpoch(b.expires_utc))[0];
  const checked = `checked ${ago(nowSec() - (toEpoch(rc.observed_utc) ?? nowSec()))}`;
  return (
    <div className="allow">
      <div className="allow-top"><span>Free resets</span><b>{fmtInt(n)}</b></div>
      <div className="muted small">{next ? `${n > 1 ? 'next ' : ''}expires in ${resetIn(next.expires_utc)} · ${localTime(next.expires_utc)} · ${checked}` : `${n ? 'no expiry reported' : 'none available'} · ${checked}`}</div>
    </div>
  );
}

/* ---------- boxes ---------- */
function BoxTile({ box, count, hist }) {
  const h = box.ok ? obj(box.host) : null;
  if (!box.ok) {
    const hint = box.kind === 'refused' ? 'SSH tunnel down — rerun the launcher.' : box.kind === 'timeout' ? 'Monitor slow to answer.' : 'Unexpected response.';
    return <div className="tile down-tile"><div className="tile-top"><span className="tile-label">{box.name}</span><Pill st={{ cls: 'down', text: 'Unreachable' }} /></div><div className="muted small">{box.note || ''}</div><div className="small">{hint} Its workers may still be running.{str(box.last_ok_utc) ? ` Last seen ${localTime(box.last_ok_utc)}.` : ''}</div></div>;
  }
  const gb = (b) => (num(b) == null ? '—' : (b / 1e9).toFixed(1));
  return (
    <div className="tile">
      <div className="tile-top"><span className="tile-label">{box.name}</span><span className="mono muted small">{box.note || ''}</span></div>
      <div className="box-stats">
        <div><span className="muted small">Agents</span><b>{count}</b></div>
        <div><span className="muted small">CPU</span><b>{num(h?.cpu) != null ? Math.round(h.cpu * 100) + '%' : '—'}</b></div>
        <div><span className="muted small">Load</span><b>{num(arr(h?.load)[0]) != null ? h.load[0].toFixed(1) : '—'}<small>/{num(h?.cpus) || '?'}</small></b></div>
        <div><span className="muted small">Memory</span><b>{gb(h?.mem_used)}<small>/{gb(h?.mem_total)} GB</small></b></div>
      </div>
      <div className="muted small">CPU, last 24 h</div>
      <Sparkline points={hist?.series?.[hostKey(box, 'cpu')]} max={1} />
      <div className="muted small tile-foot">disk {fmtBytes(h?.disk_free)} free · up {uptime(h?.uptime_s)}</div>
    </div>
  );
}

/* ---------- verified work by category (IMD's public records + our heavy-work watcher) ---------- */
const CAT_ORDER = [['oracle', 'Oracle'], ['other', 'Other advanced'], ['frontend', 'Frontend & website'], ['contract', 'Smart contract'], ['review', 'Security & review'], ['research', 'Research']];
const VERDICTS = ['attempts', 'accepted', 'rejected', 'failed', 'pending'];
function normalizeWork(raw) {
  if (!obj(raw) || !raw.enabled) return null;
  const records = obj(raw.records) || {};
  let network = obj(raw.network);
  if (!network) { // a per-box page gets every seat's record: sum them here
    network = { seats: 0, attempts: 0, accepted: 0, rejected: 0, failed: 0, pending: 0 };
    for (const r of Object.values(records)) if (obj(r)) { network.seats++; for (const k of VERDICTS) network[k] += num(r[k]) || 0; }
  }
  return { box: str(raw.box), records, network, heavy: obj(raw.heavy) || {}, heavy_recent: obj(raw.heavy_recent) || {}, records_at: str(raw.records_at), records_error: str(raw.records_error), heavy_since: str(raw.heavy_since) };
}
// sums over the given tokens (one for an agent, all of ours for the fleet); oracle = verified totals minus heavy
function workFor(tokens, work) {
  const rows = Object.fromEntries(CAT_ORDER.map(([k]) => [k, { attempts: 0, jobs: 0, accepted: 0, rejected: 0, failed: 0, pending: 0 }]));
  const tot = { attempts: 0, accepted: 0, rejected: 0, failed: 0, pending: 0 };
  let seen = 0;
  for (const t of tokens) {
    const rec = obj(work?.records?.[t]); const hv = obj(work?.heavy?.[t]) || {};
    const hsum = { attempts: 0, accepted: 0, rejected: 0, failed: 0, pending: 0 };
    for (const [c, x] of Object.entries(hv)) {
      const r = rows[c] || rows.other; if (!obj(x)) continue;
      r.jobs += num(x.jobs) || 0; for (const k of VERDICTS) { r[k] += num(x[k]) || 0; hsum[k] += num(x[k]) || 0; }
    }
    if (rec) { seen++; for (const k of VERDICTS) { tot[k] += num(rec[k]) || 0; rows.oracle[k] += Math.max(0, (num(rec[k]) || 0) - hsum[k]); } }
  }
  rows.oracle.jobs = null; // the public totals count attempts, not distinct oracle jobs
  const judged = tot.accepted + tot.rejected + tot.failed;
  return { rows, tot, seen, rate: judged ? tot.accepted / judged : null };
}
function WorkCategories({ rows }) {
  return (
    <div className="cat-list">
      {CAT_ORDER.map(([k, label]) => { const r = rows[k]; const zero = !r.attempts; return (
        <div className={'cat-row' + (zero ? ' zero' : '')} key={k}>
          <span className={'cat-chip ' + (k === 'oracle' ? 'oracle' : 'other')}>{label}</span>
          <span className="muted small">{r.jobs != null ? `${fmtInt(r.jobs)} job${r.jobs !== 1 ? 's' : ''}` : ''}</span>
          <span className="cat-num">{fmtInt(r.attempts)}</span>
          <span className="muted small cat-acc">{fmtInt(r.accepted)} accepted</span>
        </div>); })}
    </div>
  );
}
function VerdictTiles({ w }) {
  return (
    <div className="verdicts">
      <div><span className="kpi-label">Accepted</span><b>{fmtInt(w.tot.accepted)}</b></div>
      <div><span className="kpi-label">Rejected</span><b>{fmtInt(w.tot.rejected)}</b></div>
      <div><span className="kpi-label">Failed</span><b className={w.tot.failed ? 'sev-warn' : ''}>{fmtInt(w.tot.failed)}</b></div>
      <div><span className="kpi-label">Pending</span><b>{fmtInt(w.tot.pending)}</b></div>
      <div><span className="kpi-label">Accepted of judged</span><b>{w.rate != null ? (w.rate * 100).toFixed(1) + '%' : '—'}</b></div>
    </div>
  );
}
function workNote(work, where) {
  if (!work) return 'Verified results are not available (no reachable box runs the heavy-work watcher).';
  return `IMD's public verdicts, refreshed every 10 min${work.records_at ? ` (last ${ago(nowSec() - (toEpoch(work.records_at) ?? nowSec()))})` : ''}${work.records_error ? ` · last refresh failed: ${work.records_error}` : ''}. Non-oracle work is split out from the heavy-work watcher on ${where}, tracked since ${work.heavy_since || 'the watcher started'}; the public totals count attempts, not distinct oracle jobs.`;
}
function VerifiedPanel({ workers, work, where }) {
  if (!work) return null;
  const w = workFor(workers.map((x) => str(x.token)).filter(Boolean), work);
  const net = work.network; const share = net && net.accepted ? w.tot.accepted / net.accepted : null;
  return (
    <div className="panel pad">
      <div className="panel-head"><div><div className="eyebrow">Verified work</div><h3>Work by category</h3>
        <div className="muted small">All {w.seen} agents, all time.{share != null ? ` ${(share * 100).toFixed(1)}% of everything accepted network-wide (${fmtInt(net.seats)} seats).` : ''}</div></div></div>
      <VerdictTiles w={w} />
      <WorkCategories rows={w.rows} />
      <div className="muted small" style={{ marginTop: 10 }}>{workNote(work, where)}</div>
    </div>
  );
}

/* ---------- since last check: the watcher's digest (failures, releases, news) + each seat's toolchain ---------- */
// the box a watcher payload came from: the hub tags /api/work, /api/watch and /api/network with that box's id;
// a box's own page only ever shows itself
function watcherBox(src, state) {
  if (state && !state.hub) return 'this box';
  const b = arr(state?.boxes).find((x) => obj(x) && str(src?.box) && str(x.id) === src.box);
  return str(b?.name) || 'the watcher box';
}
function normalizeWatch(raw) {
  if (!obj(raw) || !raw.enabled) return null;
  const f = obj(raw.failures) || {};
  return { box: str(raw.box), generated_utc: str(raw.generated_utc), items: arr(f.items).filter(obj), by_pattern: obj(f.by_pattern) || {}, patterns: obj(f.patterns) || {},
    releases: arr(raw.releases).filter(obj), news: arr(raw.news).filter(obj),
    payments: arr(raw.payments).filter(obj), payments_total: obj(raw.payments_total) || {},
    allocations: arr(raw.allocations).filter(obj), allocations_total: obj(raw.allocations_total) || {},
    contract: obj(raw.contract), contract_changes: arr(raw.contract_changes).filter(obj) };
}
// contract-work standing (IMD's contract-work rules): the watcher keeps each seat's `contract` section and the backend
// derives in_rotation/alert once (server/index.js contractState). Absent = unknown, shown as such, never as healthy.
const contractOf = (watch, w) => arr(watch?.contract?.seats).filter(obj).find((s) => str(s.token) === str(w.token)) || null;
const CONTRACT_STALE_S = 2 * 3600; // the backend's contractState uses the same 2 h
// the watcher payload's time-dependent flags, recomputed in the browser: a retained payload ages too (the backend's
// stale:false was true when it answered), and with the monitor unreachable (lost) no seat's standing is known
function freshWatch(watch, lost) {
  const c = watch?.contract; if (!obj(c)) return watch;
  const t = toEpoch(c.read_at); const stale = !!c.stale || t == null || nowSec() - t > CONTRACT_STALE_S;
  if (stale === !!c.stale && !lost) return watch;
  return { ...watch, contract: { ...c, stale, lost: !!lost, seats: arr(c.seats).map((s) => (obj(s) ? { ...s, unknown: !!s.unknown || stale || !!lost } : s)) } };
}
const onProbation = (s) => !!str(s?.probationUntil) && (toEpoch(s.probationUntil) ?? 0) > nowSec();
const EVENT_TEXT = { probation_start: 'probation started', probation_extended: 'probation extended', probation_cleared: 'probation cleared', retry_due: 'retry due',
  qualifies_lost: 'no longer qualifies', qualifies_gained: 'qualifies again', missing_changed: 'missing capabilities changed', bad_added: 'bad result added',
  section_missing: 'standing section missing', section_back: 'standing section back' };
const notableChange = (c) => obj(c) && !c.baseline && arr(c.events).length > 0;
function ContractMarks({ s }) {
  const recent = arr(s?.recent).map(str).slice(-3);
  const marks = [...recent, ...Array(Math.max(0, 3 - recent.length)).fill('')];
  return <span className="marks" title={recent.length ? `last ${recent.length} counted premium result${recent.length !== 1 ? 's' : ''}: ${recent.join(', ')}` : 'no counted premium result yet'}>{marks.map((m, i) => <i key={i} className={m === 'good' ? 'ok' : m === 'bad' ? 'bad' : ''} />)}</span>;
}
function contractChip(s) {
  if (!s) return null;
  if (s.unknown) return <span className="chip">?</span>;
  if (onProbation(s)) return <span className="chip sev-bad">probation</span>;
  if (s.retryDue) return <span className="chip sev-warn">retry</span>;
  if (s.qualifies === false) return <span className="chip sev-bad">not qualifying</span>;
  return null;
}
// agents whose forge differs from the verifier's (or is missing); seats that don't report a toolchain yet are counted apart
function toolchainCheck(workers) {
  const tc = (w) => obj(snapOf(w)?.toolchain);
  const rep = workers.filter(tc);
  const off = rep.filter((w) => !str(tc(w).forge) || str(tc(w).forge) !== str(tc(w).verifier_forge));
  return { rep, off, missing: workers.length - rep.length, tc };
}
const WEEK = 7 * 86400;
const within = (iso, sec) => { const t = toEpoch(iso); return t != null && nowSec() - t <= sec; };
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
// outbound links only to the hosts they belong on (parsed: the real host is compared and '..' is resolved first)
const parseHttps = (u) => { try { const p = new URL(str(u) || ''); return p.protocol === 'https:' ? p : null; } catch { return null; } };
const releaseUrl = (u) => { const p = parseHttps(u); return p && p.host === 'github.com' && p.pathname.startsWith('/Identity-md/worker/releases/') ? p.href : null; };
const explorerUrl = (wk) => {
  const p = parseHttps(wk.agent?.explorer);
  if (p && p.host === 'explorer.imd.fun') return p.href;
  const t = str(wk.token);
  return /^\d+$/.test(t || '') ? `https://explorer.imd.fun/agents/${t}` : 'https://explorer.imd.fun/';
};
function othersText(o) {
  if (!obj(o)) return '';
  const c = num(o.completed) || 0, f = num(o.failed) || 0;
  if (!num(o.total)) return 'no other seats';
  if (f === 0 && c > 0) return 'only us';
  if (c === 0 && f > 0) return 'everyone';
  return `others: ${c} completed · ${f} failed`;
}
// new = the watcher recorded it (ts) or it happened (at/published) after the viewer's Mark-seen time (never marked =
// the last 7 days): polls lag events by up to 30 min. Shared by the panel and the News tab's badge.
const watchWhen = (x) => Math.max(toEpoch(x.ts) ?? 0, toEpoch(x.at) ?? 0, toEpoch(x.published) ?? 0);
const watchSince = (seen) => toEpoch(seen) ?? nowSec() - WEEK;
// allocations are judged by `at` only: the watcher's first run records the whole backlog with ts = now, and a
// reward snapshot from days ago is not news
// a reported wall clock in ms as people read it: 42 s, 11 min, 1h 05m
const durText = (ms) => { const sec = Math.round((num(ms) ?? 0) / 1000); if (sec < 60) return `${sec} s`; if (sec < 3600) return `${Math.round(sec / 60)} min`; return `${Math.floor(sec / 3600)}h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}m`; };
// what a submission reported about itself (watcher usage_of): model, turns, wall clock, output tokens
const usageText = (u, turns) => {
  u = obj(u) || {}; const parts = [];
  if (str(u.model)) parts.push(u.model);
  const t = num(u.turns) ?? num(turns); if (t != null) parts.push(`${fmtInt(t)} turns`);
  if (num(u.wallClockMs) != null) parts.push(durText(u.wallClockMs));
  if (num(u.outputTokens) != null) parts.push(`${fmtInt(u.outputTokens)} out`);
  return parts.join(' · ');
};
// one news line per kind (watcher news.jsonl): control plane, launch policy, contract rules, API docs, on-chain message
function NewsBody({ n, dot }) {
  const k = str(n.kind);
  if (k === 'control-plane') return <div className="small">{dot(n)}<span className="tnum">{localTime(n.ts)}</span> · control plane <span className="mono">{str(n.version) || '?'}</span>{str(n.prev) ? <span className="muted"> (was <span className="mono">{n.prev}</span>)</span> : ''}</div>;
  if (k === 'launch-policy') return <div className="small">{dot(n)}<span className="tnum">{localTime(n.ts)}</span> · launch policy <span className="mono">v{num(n.version) != null ? n.version : '?'}</span>{num(n.prev) != null ? <span className="muted"> (was v{n.prev})</span> : ''}{str(n.note) ? <span className="muted"> · {cut(n.note, 160)}</span> : ''}</div>;
  if (k === 'contract-rules') return <div className="small">{dot(n)}<span className="tnum">{localTime(n.ts)}</span> · contract-work rules changed <span className="muted">(the Contract standing section follows the new rules)</span></div>;
  if (k === 'api-routes') {
    const added = arr(n.added).map(str).filter(Boolean), removed = arr(n.removed).map(str).filter(Boolean);
    const what = [added.length ? `+${added.length} route${added.length !== 1 ? 's' : ''}` : '', removed.length ? `−${removed.length} removed` : ''].filter(Boolean).join(', ') || 'changed';
    return (<><div className="small">{dot(n)}<span className="tnum">{localTime(n.ts)}</span> · API docs: {what} <span className="muted">({fmtInt(n.count)} documented on imd.fun/docs)</span></div>
      {(added.length || removed.length) ? <details className="watch-more"><summary className="muted small">routes</summary>
        {added.map((r, j) => <div className="mono small" key={'a' + j}>+ {r}</div>)}{removed.map((r, j) => <div className="mono small muted" key={'r' + j}>− {r}</div>)}</details> : null}</>);
  }
  return (<><div className="small">{dot(n)}<span className="tnum">{localTime(n.at || n.ts)}</span> · on-chain message <span className="mono muted">{cut(str(n.hash), 12)}</span></div>
    {(str(n.text) || '').length > 200 ? <details className="watch-more"><summary className="muted small">{cut(n.text, 200)}</summary><div className="small watch-text">{n.text}</div></details> : <div className="muted small watch-text">{str(n.text) || '—'}</div>}</>);
}
const watchNewCount = (watch, seen) => (watch ? [...watch.items, ...watch.releases, ...watch.news, ...watch.payments].filter((x) => watchWhen(x) > watchSince(seen)).length
  + watch.allocations.filter((a) => (toEpoch(a.at) ?? 0) > watchSince(seen)).length
  + watch.contract_changes.filter((c) => notableChange(c) && (toEpoch(c.ts) ?? 0) > watchSince(seen)).length : 0);
// `seen` (the viewer's Mark-seen time) lives in App so the attention strip and the tab badge go quiet on the same click
function WatchPanel({ watch, workers, seen, setSeen, where }) {
  const since = watchSince(seen);
  const isNew = (x) => watchWhen(x) > since;
  function markSeen() { const t = new Date().toISOString(); try { localStorage.setItem('imd-watch-seen', t); } catch {} setSeen(t); }
  const dot = (x) => (isNew(x) ? <span className="new-dot" title="new since last check" /> : null);
  const alias = Object.fromEntries(workers.map((w) => [str(w.token), aliasOf(w)]));
  const tk = toolchainCheck(workers);
  const byVer = {}; for (const w of tk.rep) { const v = str(tk.tc(w).forge) || '—'; byVer[v] = (byVer[v] || 0) + 1; }
  const verifiers = [...new Set(tk.rep.map((w) => str(tk.tc(w).verifier_forge)).filter(Boolean))];
  const newCount = watchNewCount(watch, seen);
  const pats = watch ? Object.entries(watch.by_pattern).filter(([, p]) => obj(p)).sort((a, b) => (num(b[1].count_7d) || 0) - (num(a[1].count_7d) || 0)) : [];
  const na = <div className="muted small">— not available (no reachable box runs the watcher)</div>;
  const title = watch ? `${newCount} new ${seen ? 'since ' + localTime(seen) : 'in the last 7 days'}` : 'Watcher not available';
  return (
    <div className="panel pad watch">
      <div className="panel-head">
        <div><div className="eyebrow">Since last check</div><h3>{title}</h3>
          <div className="muted small">{watch ? `The watcher on ${where}, read-only on IMD's public API${watch.generated_utc ? ` · ${ago(nowSec() - (toEpoch(watch.generated_utc) ?? nowSec()))}` : ''}.` : 'Failures, releases and news: not available (no reachable box runs the watcher).'}</div></div>
        {watch && <button className="btn ghost" onClick={markSeen}>Mark seen</button>}
      </div>

      <h3 className="sec">Toolchain</h3>
      {!tk.rep.length ? <div className="muted small">Not reported by any agent yet.</div>
        : !tk.off.length ? <div className="small">{Object.entries(byVer).map(([v, n]) => `forge ${v} on ${n} agent${n !== 1 ? 's' : ''}`).join(', ')} · verifier {verifiers.join(', ') || '—'}</div>
        : <div className="small sev-warn">{tk.off.length} agent{tk.off.length !== 1 ? 's' : ''} off the verifier's forge: {tk.off.map((w) => `${aliasOf(w)} (forge ${str(tk.tc(w).forge) || '—'}, verifier ${str(tk.tc(w).verifier_forge) || '—'})`).join(', ')}</div>}
      {tk.rep.length > 0 && tk.missing > 0 && <div className="muted small">{tk.missing} agent{tk.missing !== 1 ? 's' : ''} not reporting a toolchain.</div>}

      <h3 className="sec">Failures by cause <span className="muted small">· 7 days</span></h3>
      {!watch ? na : !pats.length ? <div className="muted small">No failures in the last 7 days.</div> : (<>
        <div className="table-scroll"><table className="mini-table"><thead><tr><th>Pattern</th><th className="r">24 h</th><th className="r">7 d</th><th>Last</th></tr></thead>
          <tbody>{pats.map(([k, p]) => <tr key={k}><td className="mono">{k}{within(p.first_seen, WEEK) && <> <span className="chip sev-warn">new</span></>}</td><td className="r tnum">{fmtInt(p.count_24h)}</td><td className="r tnum">{fmtInt(p.count_7d)}</td><td>{localTime(p.last_at)}</td></tr>)}</tbody></table></div>
        <div className="watch-list">{watch.items.slice(0, 8).map((x, i) => (
          <div className="watch-item" key={i}>
            <div className="small">{dot(x)}<span className="tnum">{localTime(x.at)}</span> · <b>{alias[str(x.token)] || `NFT #${str(x.token) || '?'}`}</b> · <span className="mono">{str(x.node) || '?'}</span> · <span className="chip">{str(x.pattern) || '?'}</span> <span className="muted">{othersText(x.others)}</span>{usageText(x.usage, x.turns) ? <span className="muted"> · {usageText(x.usage, x.turns)}</span> : null}</div>
            <div className="muted small" title={str(x.summary) || ''}>{cut(str(x.summary), 140) || '—'}</div>
          </div>))}</div>
      </>)}

      <h3 className="sec">Contract standing <span className="muted small">· premium-step rotation and probation</span></h3>
      {!watch ? na : !watch.contract ? <div className="muted small">Not reported (watcher or backend not updated yet).</div> : (() => {
        const c = watch.contract; const sm = obj(c.summary) || {}; const chg = watch.contract_changes.filter(notableChange).slice(0, 8);
        return (<>
          {c.lost && <div className="small sev-warn">The monitor is unreachable: the standing below is the last known, and every seat's is unknown until it answers again.</div>}
          <div className="small">{c.stale ? <span className="sev-warn">Standing not read for {uptime(nowSec() - (toEpoch(c.read_at) ?? 0))} (the watcher on {where}).</span>
            : <>{fmtInt(sm.in_rotation)} of {fmtInt(sm.tokens)} in rotation · probation {fmtInt(sm.probation)} · retry due {fmtInt(sm.retry_due)} · not qualifying {fmtInt(sm.not_qualifying)} · unknown {fmtInt(sm.unknown)} · read {ago(nowSec() - (toEpoch(c.read_at) ?? nowSec()))}, server {str(c.server) || '—'}</>}</div>
          {!chg.length ? <div className="muted small">No standing change worth noting yet (routine turns and good results are logged, not listed).</div>
            : <div className="watch-list">{chg.map((x, i) => (
              <div className="watch-item" key={i}><div className="small">{dot(x)}<span className="tnum">{localTime(x.ts)}</span> · <b>{alias[str(x.token)] || `NFT #${str(x.token) || '?'}`}</b> · {arr(x.events).map((e) => EVENT_TEXT[str(e)] || str(e)).join(', ')}{obj(x.contract) && <span className="muted"> · good {fmtInt(x.contract.good)} bad {fmtInt(x.contract.bad)}{str(x.contract.probationUntil) ? ` · probation until ${localTime(x.contract.probationUntil)}` : ''}</span>}</div></div>))}</div>}
          <div className="muted small">2 bad of the last 3 counted results = 24 h at lower priority for premium steps (overflow work still comes); a bad retry doubles the wait, up to 7 days. Bad = a verifier rejection or a worker-side failure IMD classes as "machine". Oracle, audit and media work never counts.</div>
        </>); })()}

      <h3 className="sec">Worker releases</h3>
      {!watch ? na : !watch.releases.length ? <div className="muted small">No releases recorded yet.</div> : <div className="watch-list">{watch.releases.slice(0, 3).map((r, i) => {
        const s = obj(r.strings); const lines = (str(r.notes) || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3);
        return (
          <div className="watch-item" key={str(r.tag) || i}>
            <div className="small">{dot(r)}<b className="mono">{releaseUrl(r.url) ? <a href={releaseUrl(r.url)} target="_blank" rel="noreferrer">{str(r.version) || str(r.tag) || '?'}</a> : (str(r.version) || str(r.tag) || '?')}</b> · {localTime(r.published)} · {r.verified === true ? `verifier forge ${str(r.verifier_forge) || '—'}` : <span className="sev-warn">SHA-256 not verified; not inspected</span>}</div>
            {lines.map((l, j) => <div className="muted small" key={j}>{cut(l, 200)}</div>)}
            {s && <details className="watch-more"><summary className="small">+{fmtInt(s.added)} / −{fmtInt(s.removed)} rule strings</summary>
              {arr(s.added_sample).map(str).filter(Boolean).map((t, j) => <div className="mono small" key={'a' + j}>+ {t}</div>)}
              {arr(s.removed_sample).map(str).filter(Boolean).map((t, j) => <div className="mono small muted" key={'r' + j}>− {t}</div>)}
            </details>}
          </div>); })}</div>}

      <h3 className="sec">News</h3>
      {!watch ? na : !watch.news.length ? <div className="muted small">Nothing recorded yet.</div> : <div className="watch-list">{watch.news.slice(0, 6).map((n, i) => (
        <div className="watch-item" key={i}><NewsBody n={n} dot={dot} /></div>))}</div>}
    </div>
  );
}

/* ---------- payments received: the watcher records IMD sent to the NFT wallet by IMD's Disperse contract ---------- */
const fmtImd = (n) => (num(n) == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }));
// IMD's Disperse payout usually sends one transfer per active agent, so amount/transfers is the per-agent figure.
// A single aggregated transfer carries no per-agent information: the tile estimates it from today's
// seat count and says so; historical rows show "—" rather than a number nobody can stand behind.
const perTransfer = (p) => (num(p?.amount) != null && num(p?.transfers) > 1 ? p.amount / p.transfers : null);
const perAgent = (p, seats) => (num(p?.amount) == null ? null : num(p?.transfers) > 1 ? p.amount / p.transfers : (num(seats) > 0 ? p.amount / seats : null));
const perAgentBasis = (p, seats) => (num(p?.transfers) > 1 ? `${fmtInt(p.transfers)} transfers, one per agent` : (num(seats) > 0 ? `≈ one aggregated transfer ÷ ${fmtInt(seats)} seats today` : 'one aggregated transfer'));
const transfersText = (n) => (num(n) == null ? '—' : n === 1 ? '1 (aggregated)' : `${fmtInt(n)} (one per agent)`);
// the note is the first line of a watched on-chain message that names the payment's tx; none -> "—", never a guess
function paymentNote(p, news) {
  const h = (str(p.hash) || '').toLowerCase(); if (!h) return null;
  const first = (x) => (str(x.text) || '').split('\n').map((l) => l.trim()).find(Boolean) || null;
  const n = news.find((x) => (str(x.text) || '').toLowerCase().includes(h));
  if (n) return first(n);
  // the payer does not always link the tx: fall back to an on-chain note within 12 h, marked as such
  const at = toEpoch(p.at); if (at == null) return null;
  const near = news.filter((x) => str(x.kind) === 'onchain' && toEpoch(x.at) != null && Math.abs(toEpoch(x.at) - at) <= 12 * 3600)
    .sort((a, b) => Math.abs(toEpoch(a.at) - at) - Math.abs(toEpoch(b.at) - at))[0];
  return near ? `same day: ${first(near)}` : null;
}
function PaymentsPanel({ watch, seats, where }) {
  const pays = watch ? watch.payments : []; const tot = watch ? watch.payments_total : {}; const last = pays[0];
  return (
    <div className="panel pad">
      <div className="panel-head"><div><div className="eyebrow">Payments received</div><h3>IMD paid to the NFT wallet</h3>
        <div className="muted small">{watch ? `Transfers from IMD's Disperse contract, read by the watcher on ${where} from public blockscout data every 30 min${watch.generated_utc ? ` · ${ago(nowSec() - (toEpoch(watch.generated_utc) ?? nowSec()))}` : ''}.` : watch === undefined ? 'Loading…' : 'Payments: not available (no reachable box runs the watcher).'}</div></div></div>
      {watch === undefined ? null : !watch ? <div className="muted small">— not available (no reachable box runs the watcher)</div> : !pays.length ? <div className="muted small">No payments recorded yet.</div> : (<>
        <div className="verdicts four">
          <div><span className="kpi-label">Total received</span><b>{fmtImd(tot.amount)} IMD</b>{str(tot.first_at) && <span className="muted small">since {localTime(tot.first_at)}</span>}</div>
          <div><span className="kpi-label">Payments</span><b>{fmtInt(tot.count)}</b></div>
          <div><span className="kpi-label">Last payment</span><b>{fmtImd(last.amount)} IMD</b><span className="muted small">{localTime(last.at)}</span></div>
          <div><span className="kpi-label">Per agent, last payment</span><b>{num(last.transfers) > 1 ? '' : '≈ '}{fmtImd(perAgent(last, seats))} IMD</b><span className="muted small">{perAgentBasis(last, seats)}</span></div>
        </div>
        <div className="table-scroll"><table className="mini-table"><thead><tr><th>Date</th><th className="r">Amount</th><th className="r">Transfers</th><th className="r">Per agent</th><th>Note</th><th>Tx</th></tr></thead>
          <tbody>{pays.map((p, i) => { const note = paymentNote(p, watch.news); const h = str(p.hash) || ''; return (
            <tr key={h || i}>
              <td className="tnum">{localTime(p.at)}</td>
              <td className="r tnum">{fmtImd(p.amount)} IMD</td>
              <td className="r tnum">{transfersText(p.transfers)}</td>
              <td className="r tnum" title={num(p.transfers) > 1 ? 'one transfer per agent' : 'one aggregated transfer: the per-agent share is not on chain'}>{num(p.transfers) > 1 ? fmtImd(perTransfer(p)) : '—'}</td>
              <td className="muted" title={note || ''}>{note ? cut(note, 120) : '—'}</td>
              <td className="mono">{/^0x[0-9a-f]{64}$/i.test(h) ? <a href={`https://etherscan.io/tx/${h}`} target="_blank" rel="noreferrer">{cut(h, 12)}</a> : (h ? cut(h, 12) : '—')}</td>
            </tr>); })}</tbody></table></div>
      </>)}
    </div>
  );
}

/* ---------- launch allocations: the watcher reads the NFT wallet's public earnings route (launch reward snapshots) ---------- */
const SEPOLIA = '11155111';
const fmtAmt = (n) => (num(n) == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 }));
function AllocationsPanel({ watch }) {
  const al = watch ? watch.allocations : []; const tot = watch ? watch.allocations_total : {}; const last = al[0];
  const byChain = Object.entries(obj(tot.launches_by_chain) || {}).filter(([, n]) => num(n) != null);
  const sep = byChain.filter(([c]) => c === SEPOLIA).reduce((a, [, n]) => a + n, 0);
  const other = byChain.filter(([c]) => c !== SEPOLIA).reduce((a, [, n]) => a + n, 0);
  return (
    <div className="panel pad">
      <div className="panel-head"><div><div className="eyebrow">Launch allocations</div><h3>Launch tokens allotted to the NFT wallet</h3>
        <div className="muted small">{watch ? `Launch tokens allotted to the NFT wallet on IMD's reward snapshots, read from the public earnings route every 6 h. These are test-network tokens unless a chain other than Sepolia appears; never summed with IMD payments.` : watch === undefined ? 'Loading…' : 'Launch allocations: not available (no reachable box runs the watcher).'}</div></div></div>
      {watch === undefined ? null : !watch ? <div className="muted small">— not available (no reachable box runs the watcher)</div> : !al.length ? <div className="muted small">No launch allocations recorded yet.</div> : (<>
        <div className="verdicts three">
          <div><span className="kpi-label">Launches</span><b>{fmtInt(num(tot.count) ?? al.length)}</b>{str(tot.latest_at) && <span className="muted small">latest {localTime(tot.latest_at)}</span>}</div>
          <div><span className="kpi-label">Sepolia · other chains</span><b>{byChain.length ? `${fmtInt(sep)} · ${fmtInt(other)}` : '—'}</b>{other > 0 && <span className="small sev-warn">{byChain.filter(([c]) => c !== SEPOLIA).map(([c]) => `chain ${c}`).join(', ')}</span>}</div>
          <div><span className="kpi-label">Newest allocation</span><b>{fmtAmt(last.amount)} {str(last.symbol) || '?'}</b><span className="muted small">{localTime(last.at)}</span></div>
        </div>
        <div className="table-scroll"><table className="mini-table"><thead><tr><th>Date</th><th className="r">Launch</th><th>Kind</th><th>Token</th><th className="r">Amount</th><th>Chain</th><th>Status</th></tr></thead>
          <tbody>{al.slice(0, 10).map((a, i) => { const c = str(a.chainId); return (
            <tr key={str(a.launchId) || i}>
              <td className="tnum">{localTime(a.at)}</td>
              <td className="r tnum" title={str(a.launchId) || ''}>{str(a.launchNumber) ? '#' + a.launchNumber : '—'}</td>
              <td>{str(a.kind) || '—'}</td>
              <td title={[str(a.name), str(a.tokenAddress)].filter(Boolean).join(' · ')}>{str(a.symbol) || '—'}</td>
              <td className="r tnum">{fmtAmt(a.amount)}</td>
              <td className={c && c !== SEPOLIA ? 'sev-warn' : 'muted'}>{c === SEPOLIA ? 'Sepolia' : c || '—'}</td>
              <td className="muted">{str(a.status) || '—'}</td>
            </tr>); })}</tbody></table></div>
      </>)}
    </div>
  );
}

// a heavy step's result: the backend's classifyAttempt label (R-RESULT, the same one its totals use); rows from an
// older backend without it fall back to the old inline reading. Completed without a verdict is not accepted yet.
function heavyResult(a) {
  const r = str(a.result);
  const failed = () => `failed${str(a.failure) ? ' · ' + a.failure : ''}`;
  if (r) return r === 'submitted' ? 'submitted · awaiting verdict' : r === 'failed' ? failed() : r;
  return a.accepted === true ? 'accepted' : str(a.verdict) === 'rejected' ? 'rejected' : str(a.outcome) === 'failed' ? failed() : str(a.outcome) || 'pending';
}

/* ---------- agent record (modal) ---------- */
function AgentRecord({ wk, acct, state, hist, work, watch, range, setRange, onClose, lost }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const snap = snapOf(wk);
  // the allowance is account-wide: show the account's reading (R-ALLOWANCE, the same one as its tile) and that seat's
  // series; a seat's own older reading would contradict the tile after a reset
  const al = obj(acct?.al) || obj(snap?.allowance); const alw = acct?.al ? (acct.alWorker || wk) : wk; const ownAl = alw === wk;
  const windows = arr(al?.windows).filter(obj);
  const jobs = obj(snap?.jobs) || {}; const tokAll = obj(snap?.tokens?.alltime) || {}; const tokToday = obj(snap?.tokens?.today) || {};
  const box = wk.box; const h = obj(box.host); const st = statusOf(wk, lost);
  const hb = hist?.boxes?.[box.id];
  // no history yet = the selected range is still loading (a 24h answer is never shown under 7d or 30d)
  const histNote = !hist ? `Loading ${range} history…` : hb && hb.ok === false ? `History for ${box.name} ${hb.stale ? 'is stale' : 'is unavailable'} (${str(hb.error) || 'error'}).` : null;
  const explorer = explorerUrl(wk);
  const sharers = arr(wk.shares_account_with).map(str).filter(Boolean);
  const kv = (k, v) => <div className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Agent ${agentIdOf(wk) || aliasOf(wk)}`}>
        <div className="modal-head">
          <div><div className="eyebrow">Identity.md / agent record</div><h2>Agent #{agentIdOf(wk) || '—'}</h2></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <Boundary label={`${aliasOf(wk)} record`} resetKey={state.generated_utc}>
          <div className="record-id">
            <Avatar seed={wk.token} size={52} />
            <div><Pill st={st} detail={st.cls === 'working' ? ` ${runningOf(wk)}/${concOf(wk)}` : null} /><div className="muted small" style={{ marginTop: 6 }}>{aliasOf(wk)} · NFT #{str(wk.token) || '?'} · {box.name}</div></div>
            <a className="btn" href={explorer} target="_blank" rel="noreferrer">Official record ↗</a>
          </div>
          <div className="kpis three">
            <div className="kpi"><span className="kpi-label">Tasks today</span><span className="kpi-value">{fmtInt(jobs.accepted_today)}</span><span className="kpi-sub">{fmtInt(jobs.submitted_today)} submitted</span></div>
            <div className="kpi"><span className="kpi-label">Submitted, all time</span><span className="kpi-value">{fmtInt(jobs.submitted_total)}</span><span className="kpi-sub">verdicts live on the explorer</span></div>
            <div className="kpi"><span className="kpi-label">Tokens today</span><span className="kpi-value">{fmtTok(tokToday.total)}</span><span className="kpi-sub">{fmtTok(tokAll.total)} all time</span></div>
          </div>

          {work && (() => { const w = workFor([str(wk.token)], work); return (<>
            <h3 className="sec">Verified work <span className="muted small">· IMD's public record for NFT #{str(wk.token) || '?'}</span></h3>
            {w.seen ? <><VerdictTiles w={w} /><WorkCategories rows={w.rows} /></> : <div className="muted small">No public record for this token yet.</div>}
            <div className="muted small" style={{ marginTop: 8 }}>{workNote(work, watcherBox(work, state))}</div>
            {(() => { const rs = arr(work.heavy_recent?.[str(wk.token)]).filter(obj); return rs.length ? (<>
              <div className="small" style={{ marginTop: 10 }}>Recent heavy steps <span className="muted">· the submissions the watcher saw from this seat, with the model and time each reported</span></div>
              <div className="table-scroll"><table className="mini-table"><thead><tr><th>When</th><th>Step</th><th>Result</th><th className="hide-sm">Model</th><th className="r">Turns</th><th className="r">Time</th></tr></thead>
                <tbody>{rs.slice(0, 8).map((a, i) => { const u = obj(a.usage) || {}; return (<tr key={i}><td className="tnum">{localTime(a.at)}</td><td className="mono">{str(a.key) || '?'}</td>
                  <td>{heavyResult(a)}</td>
                  <td className="mono hide-sm">{str(u.model) || '—'}</td><td className="r tnum">{num(u.turns) != null ? fmtInt(u.turns) : '—'}</td><td className="r tnum">{num(u.wallClockMs) != null ? durText(u.wallClockMs) : '—'}</td></tr>); })}</tbody></table></div>
            </>) : null; })()}
          </>); })()}

          {(() => { const cs = contractOf(watch, wk); return (<>
            <h3 className="sec">Contract work <span className="muted small">· premium steps (contract builds, tests, manifests, frontends, websites), last 30 days</span></h3>
            {!cs ? <div className="muted small">{watch ? `Not reported (the watcher on ${watcherBox(watch, state)} has not read this seat's contract standing).` : 'Not reported (no reachable box runs the watcher).'}</div> : (
              <div className="two-col">
                <div>
                  {kv('Qualifies', cs.unknown ? 'unknown' : cs.qualifies === true ? 'yes' : `no${arr(cs.missing).length ? ' (missing ' + arr(cs.missing).map(str).join(', ') + ')' : ''}`)}
                  {kv('Last turn', str(cs.lastTurnAt) ? `${localTime(cs.lastTurnAt)} (${ago(nowSec() - (toEpoch(cs.lastTurnAt) ?? nowSec()))})` : 'never (goes first among equally ranked machines)')}
                  {kv('Good / bad', `${fmtInt(cs.good)} / ${fmtInt(cs.bad)}`)}
                </div>
                <div>
                  {kv('Last results', <><ContractMarks s={cs} /> {arr(cs.recent).map(str).join(', ') || 'none counted yet'}</>)}
                  {kv('Probation', onProbation(cs) ? `until ${localTime(cs.probationUntil)}${cs.retryDue ? ' · retry due' : ''}` : cs.retryDue ? 'retry due: the next premium result decides' : `none${num(cs.probations) ? ` (${fmtInt(cs.probations)} so far)` : ''}`)}
                  {kv('Read', `${str(cs.at) ? localTime(cs.at) : '—'} · server ${str(watch?.contract?.server) || '—'}`)}
                </div>
              </div>)}
            <div className="muted small" style={{ marginBottom: 4 }}>2 bad of the last 3 counted results = 24 h at lower priority for premium steps (overflow work still comes); a bad retry doubles the wait, up to 7 days. Bad = a verifier rejection or a worker-side failure IMD classes as "machine". Oracle, audit and media work never counts.</div>
          </>); })()}
          <h3 className="sec">Allowance <span className="muted small">· {str(wk.account) || 'provider account'}{sharers.length ? `, shared with ${sharers.length} other agent${sharers.length !== 1 ? 's' : ''}` : ''}{!ownAl && al ? ` · read on ${aliasOf(alw)}` : ''}</span></h3>
          <div className="allow-grid">{windows.length ? windows.map((w, i) => (
            <div className="allow" key={str(w.name) || i}>
              <div className="allow-top"><span>{windowLabel(w)}</span><b className={'sev-' + severity(w.used_fraction)}>{fmtPct(w.used_fraction)}%</b></div>
              <div className={'meter ' + severity(w.used_fraction)}><span style={{ width: (pct(w.used_fraction) ?? 0) + '%' }} /></div>
              <div className="muted small">{str(w.resets_at) ? `resets in ${resetIn(w.resets_at)}` : 'reset time not reported'}</div>
            </div>)) : <div className="muted small">Not reported for this runtime yet.</div>}</div>
          <div className="panel-head" style={{ marginTop: 14 }}>
            <div className="legend">
              {arr(hist?.series?.[hkey(alw, 'allowance', 'five_hour')]).length > 0 && <span><i style={{ background: 'var(--series-1)' }} />Five-hour</span>}
              {(arr(hist?.series?.[hkey(alw, 'allowance', 'seven_day')]).length > 0 || arr(hist?.series?.[hkey(alw, 'allowance', 'weekly')]).length > 0) && <span><i style={{ background: 'var(--series-2)' }} />Weekly</span>}
            </div>
            <div className="toggle">{['24h', '7d', '30d'].map((r) => <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}</div>
          </div>
          <LineChart empty={histNote} series={[
            { color: 'var(--series-1)', points: hist?.series?.[hkey(alw, 'allowance', 'five_hour')] || [] },
            { color: 'var(--series-2)', points: hist?.series?.[hkey(alw, 'allowance', 'seven_day')] || hist?.series?.[hkey(alw, 'allowance', 'weekly')] || [] },
          ]} />

          <div className="two-col">
            <div>
              <h3 className="sec">Worker configuration</h3>
              {kv('Runtime', `${runtimeName(runtimeOf(wk))}${str(snap?.runtime_version) ? ' ' + snap.runtime_version : ''}`)}
              {kv('Worker build', str(snap?.worker_version) || '—')}
              {kv('Active tasks / capacity', `${runningOf(wk) ?? '—'} / ${concOf(wk) ?? '—'}`)}
              {kv('Tools advertised', toolsOf(wk).length ? toolsOf(wk).join(', ') : 'none')}
              {kv('Execution profiles', arr(snap?.profiles).map(str).filter(Boolean).join(', ') || '—')}
              {kv('Service uptime', `${uptime(snap?.service?.uptime_s)} · ${num(snap?.service?.restarts) ?? 0} restarts`)}
              {kv('Last heartbeat', snap?.service?.last_heartbeat_utc ? `${localTime(utcIso(snap.service.last_heartbeat_utc))} (${ago(heartbeatAgeOf(wk))})` : '—')}
              {kv('Snapshot', ago(snapAgeOf(wk)))}
            </div>
            <div>
              <h3 className="sec">Tokens</h3>
              {kv('Cached input', fmtInt(tokAll.cached_input))}
              {kv('Uncached input', fmtInt(tokAll.uncached_input))}
              {kv('Output (incl. reasoning)', fmtInt(tokAll.output))}
              {kv('Cache writes', fmtInt(tokAll.cache_write))}
              <h3 className="sec">Server · {box.name}</h3>
              <LineChart height={120} yMax={num(h?.mem_total) || 1} yFmt={(v) => (v / 1e9).toFixed(1) + 'G'} empty={histNote}
                series={[{ color: 'var(--series-1)', points: hist?.series?.[hostKey(box, 'mem_used')] || [] }]} />
              {kv('Memory', `${fmtBytes(h?.mem_used)} of ${fmtBytes(h?.mem_total)} (shared by the box)`)}
              {kv('Load (1m)', `${num(arr(h?.load)[0]) != null ? h.load[0].toFixed(2) : '—'} · ${num(h?.cpus) || '?'} vCPU`)}
            </div>
          </div>
          {num(jobs.reconnects_today) >= 100 && <div className="note">{fmtInt(jobs.reconnects_today)} reconnects to api.imd.fun today (a storm: the worker drops and re-opens its socket, e.g. after an oversized frame; no restart, so the restart counter stays 0).</div>}
          {num(jobs.ratelimit_today) > 0 && <div className="note">{fmtInt(jobs.ratelimit_today)} runtime rate-limit pause{jobs.ratelimit_today !== 1 ? 's' : ''} today (the provider rejected a run; the worker released the job and paused new work for five minutes).</div>}
          <details className="diag-box"><summary>Diagnostics</summary>
            <div className="diag">state {state.generated_utc}{state.hub ? ' (hub)' : ''}{'\n'}box {box.name}{box.note ? ' · ' + box.note : ''} · box state {str(box.generated_utc) || '—'}{'\n'}allowance {al ? `${str(al.provider) || '?'} · ${str(al.source) || '?'} · observed ${str(al.observed_utc) || '?'}` : 'none'}{'\n'}snapshot {str(snap?.generated_utc) || '—'} (age {ago(snapAgeOf(wk))}){'\n'}agent api {wk.agent?.unavailable ? 'unavailable — ' + str(wk.agent.unavailable) : (wk.agent?.stale ? 'stale cache' : 'ok')}</div>
          </details>
        </Boundary>
      </div>
    </div>
  );
}

/* ---------- fleet-level attention (seat-level issues live in the "Needs attention" tab) ---------- */
function attentions(state, watch, seen) {
  const out = [];
  for (const b of state.boxes) if (!b.ok) out.push({ sev: 'bad', key: 'box-down:' + str(b.id), event: false, text: `${b.name}: monitor unreachable (${str(b.error) || 'error'}) — ${b.kind === 'refused' ? 'SSH tunnel down; rerun the launcher' : 'backend slow or erroring'}. Its agents are not listed.` });
  const versions = new Set(state.workers.map((w) => str(snapOf(w)?.worker_version)).filter(Boolean));
  if (versions.size > 1) out.push({ sev: 'warn', key: 'builds:' + [...versions].sort().join(','), event: false, text: `Agents run different worker builds (${[...versions].join(', ')}) — auto-update may be mid-roll.` });
  const bad = state.workers.filter((w) => needsAttention(w)); // not point-free: filter's index would land in `lost`
  if (bad.length) out.push({ sev: 'bad', key: 'attn:' + bad.map(aliasOf).join(','), event: false, text: `${bad.length} agent${bad.length !== 1 ? 's' : ''} need${bad.length === 1 ? 's' : ''} attention: ${bad.map(aliasOf).join(', ')}.` });
  for (const b of state.boxes) {
    const h = b.ok ? obj(b.host) : null; if (!h) continue;
    if (num(h.mem_available) != null && num(h.mem_total) && h.mem_available / h.mem_total < 0.1) out.push({ sev: 'warn', key: 'mem:' + str(b.id), event: false, text: `${b.name}: under 10% memory available.` });
    if (num(h.disk_free) != null && num(h.disk_total) && h.disk_free / h.disk_total < 0.1) out.push({ sev: 'warn', key: 'disk:' + str(b.id), event: false, text: `${b.name}: under 10% disk free.` });
  }
  const off = toolchainCheck(state.workers).off;
  if (off.length) out.push({ sev: 'warn', key: 'forge:' + off.map(aliasOf).join(','), event: false, text: `${off.length} agent${off.length !== 1 ? 's' : ''} run${off.length === 1 ? 's' : ''} a forge that differs from the verifier's: ${off.map(aliasOf).join(', ')}.` });
  // a Codex login that no longer authenticates (the collector's read failed with a 401-style error): every job that
  // seat takes fails at 0 turns until `codex login --device-auth` is redone
  const dead = state.workers.filter((w) => str(snapOf(w)?.reset_credits?.auth_error));
  if (dead.length) out.push({ sev: 'bad', key: 'login:' + dead.map(aliasOf).join(','), event: false, text: `Codex login dead on ${dead.map(aliasOf).join(', ')} (${str(snapOf(dead[0])?.reset_credits?.error) || '401'}): each job it takes fails until the seat logs in again (codex login --device-auth).` });
  // weekly allowance projected to run out before its reset: one line per provider account
  // lines that are information rather than something to fix right now are hidden for 24 h after Mark seen,
  // so they come back once a day while the condition lasts (seat problems and dead logins never hide)
  const snoozed = (toEpoch(seen) ?? 0) > nowSec() - 86400;
  for (const a of accountsOf(state.workers)) {
    const fc = obj(a.al?.forecast); if (!fc?.before_reset || num(fc.hours_to_100) == null) continue;
    const h = Math.round(fc.hours_to_100);
    if (snoozed && h > 24) continue;
    const hint = str(a.al?.provider) === 'claude' ? ' (or until a free reset is pressed on claude.ai)' : '';
    out.push({ sev: h <= 24 ? 'bad' : 'warn', key: 'forecast:' + a.label, event: false, text: `${a.label}: weekly allowance runs out in about ${h < 48 ? h + ' h' : Math.round(h / 24) + ' days'} at the last-24 h pace, before its reset. Its ${a.seats.length} agent${a.seats.length !== 1 ? 's' : ''} would pause until the reset${hint}.` });
  }
  // contract-work standing: live state, so it stays until the condition clears (Mark seen does not hide it)
  const cw = watch?.contract;
  const alias = Object.fromEntries(state.workers.map((w) => [str(w.token), aliasOf(w)]));
  const name = (s) => alias[str(s.token)] || `NFT #${str(s.token)}`;
  if (cw) {
    const seats = arr(cw.seats).filter(obj);
    const prob = seats.filter(onProbation);
    if (prob.length) out.push({ sev: 'bad', key: 'probation:' + prob.map((s) => str(s.token)).join(','), event: false, text: `${prob.length} agent${prob.length !== 1 ? 's' : ''} on contract-work probation (lower priority for premium steps): ${prob.map((s) => `${name(s)} until ${localTime(s.probationUntil)}`).join(', ')}.` });
    const retry = seats.filter((s) => s.retryDue && !onProbation(s));
    if (retry.length) out.push({ sev: 'warn', key: 'retry:' + retry.map((s) => str(s.token)).join(','), event: false, text: `Contract-work retry due on ${retry.map(name).join(', ')}: the next premium result decides (good clears the probation, bad doubles the wait).` });
    const nq = seats.filter((s) => s.qualifies === false);
    if (nq.length) out.push({ sev: 'bad', key: 'nq:' + nq.map((s) => str(s.token)).join(','), event: false, text: `Not qualifying for contract work: ${nq.map((s) => `${name(s)}${arr(s.missing).length ? ' (missing ' + arr(s.missing).map(str).join(', ') + ')' : ''}`).join(', ')}.` });
    // results are newest first and only the newest two survive the next result, so a bad among those two means the next
    // bad result is 2 of 3 = 24 h probation. A live condition, so it stays (dismissible for a day) until the bad result
    // ages out of the newest two. (2026-10-09: three verifier rejections sat unseen as rows on the News tab; a bad result
    // must never be only that.)
    const oneBad = seats.filter((s) => !s.unknown && !onProbation(s) && arr(s.recent).slice(0, 2).map(str).includes('bad'));
    if (oneBad.length) out.push({ sev: 'bad', key: 'onebad:' + oneBad.map((s) => str(s.token)).join(','), event: false, text: `${oneBad.length} agent${oneBad.length !== 1 ? 's' : ''} one bad result from contract-work probation (2 bad of the last 3 = 24 h at lower priority): ${oneBad.map((s) => `${name(s)} (${arr(s.recent).map(str).join('/')})`).join(', ')}. The next counted premium result decides.` });
    // stale standing is IMD's problem, not the operator's: Mark seen after the last successful read hides it for
    // that episode; it returns only if a later successful read goes stale again
    if (cw.stale) {
      if (!((toEpoch(seen) ?? 0) > (toEpoch(cw.read_at) ?? 0))) {
        const re = obj(cw.read_errors);
        const why = re && num(re.count) > 0 ? ` IMD's API answered "${str(re.last_error) || 'error'}" to the watcher's reads (${fmtInt(re.count)} in 3 h, last ${localTime(re.last_ts)}), so this is on IMD's side; the figures return when it recovers.` : '';
        out.push({ sev: 'warn', key: 'stale:' + str(cw.read_at), event: false, text: `Contract standing not read for ${uptime(nowSec() - (toEpoch(cw.read_at) ?? 0))} (the watcher on ${watcherBox(watch, state)}): the rotation figures are unknown.${why}` });
      }
    } else if (!snoozed && !cw.lost) { // lost: the page itself is cut off, which the top bar already says
      const unk = seats.filter((s) => s.unknown); if (unk.length) out.push({ sev: 'warn', key: 'unknown:' + unk.map((s) => str(s.token)).join(','), event: false, text: `Contract standing unknown for ${unk.map(name).join(', ')} (no contract section in the last standing read).` });
    }
  }
  // watch items only until the viewer clicks Mark seen (never marked = the last 7 days); one line each, not one per release
  const since = toEpoch(seen) ?? nowSec() - WEEK;
  const fresh = (x) => Math.max(toEpoch(x.ts) ?? 0, toEpoch(x.published) ?? 0) > since;
  const np = Object.entries(watch?.patterns || {}).filter(([, p]) => obj(p) && (toEpoch(p.first_seen) ?? 0) > since).map(([k]) => k);
  if (np.length) out.push({ sev: 'warn', key: 'patterns:' + np.join(','), event: true, text: `New failure pattern${np.length !== 1 ? 's' : ''} since your last check: ${np.join(', ')} — details on the News tab.` });
  // a bad contract result (a verifier rejection, or a run that failed the way a broken machine does) and every failed job
  // on our seats: one red line each until Mark seen, so they are never only a row on the News tab
  for (const c of arr(watch?.contract_changes).filter(notableChange).filter((c) => arr(c.events).map(str).includes('bad_added') && (toEpoch(c.ts) ?? 0) > since))
    out.push({ sev: 'bad', key: 'bad:' + str(c.token) + ':' + str(c.ts), event: true, text: `${name(c)}: BAD contract result at ${localTime(c.at || c.ts)} (the verifier rejected its work, or its run failed the way a broken machine does). Its current standing and its newest two results decide any probation. Details on the News tab.` });
  const failed = arr(watch?.items).filter(obj).filter((x) => Math.max(toEpoch(x.ts) ?? 0, toEpoch(x.at) ?? 0) > since);
  if (failed.length) {
    // the watcher's `contract` field is its reading of the standing impact: 'likely' (a premium step stored as a machine
    // failure), 'no', or null when it could not tell; 'yes' is the legacy spelling of 'likely'
    const who = [...new Set(failed.map(name))], pats = [...new Set(failed.map((x) => str(x.pattern) || '?'))];
    const counts = failed.some((x) => ['likely', 'yes'].includes(str(x.contract))), unknown = failed.some((x) => !['likely', 'yes', 'no'].includes(str(x.contract)));
    const newest = failed.map((x) => toEpoch(x.ts) ?? 0).reduce((a, b) => Math.max(a, b), 0);
    out.push({ sev: counts ? 'bad' : 'warn', key: 'failed:' + newest, event: true, text: `${failed.length} failed job${failed.length !== 1 ? 's' : ''} on your seats since your last check (${pats.join(', ')}) on ${who.join(', ')}${counts ? ' — at least one likely counts toward contract standing' : unknown ? ' — standing impact unknown for at least one of them' : ' — these do not count toward contract standing'}. Details on the News tab.` });
  }
  const rel = arr(watch?.releases).filter(obj).filter(fresh);
  if (rel.length) out.push({ sev: 'warn', key: 'releases:' + str(rel[0].version || rel[0].tag), event: true, text: `${rel.length} worker release${rel.length !== 1 ? 's' : ''} since your last check (newest ${str(rel[0].version) || str(rel[0].tag) || '?'}) — the notes are on the News tab.` });
  // payments: one line each (they are few), good news rather than a warning; recorded (ts) or paid (at) after the mark
  for (const p of arr(watch?.payments).filter(obj).filter((p) => watchWhen(p) > since)) out.push({ sev: 'ok', key: 'payment:' + str(p.hash), event: true, text: `IMD payment received: ${fmtImd(p.amount)} IMD on ${localTime(p.at)}.` });
  // launch allocations: Sepolia ones are test tokens and stay quiet; any other chain gets one warn line each
  for (const a of arr(watch?.allocations).filter(obj).filter((a) => str(a.chainId) && str(a.chainId) !== SEPOLIA && watchWhen(a) > since)) out.push({ sev: 'warn', key: 'alloc:' + str(a.launchId), event: true, text: `Launch allocation on chain ${str(a.chainId)}: ${str(a.symbol) || '?'} ${fmtAmt(a.amount)}` });
  return out;
}

/* ---------- network: IMD's overall job stats next to our fleet's share (the watcher box's /api/network; docs/network-tab.md) ---------- */
function normalizeNetwork(raw) {
  if (!obj(raw) || !raw.enabled) return null;
  return { box: str(raw.box), generated_utc: str(raw.generated_utc), records_at: str(raw.records_at), records_error: str(raw.records_error),
    health: obj(raw.health) || {}, hourly: obj(raw.hourly) || {}, counts: obj(raw.counts) || {}, network: obj(raw.network) || {}, fleet: obj(raw.fleet) || {},
    ranks: obj(raw.ranks) || {}, landscape: obj(raw.landscape),
    history: arr(raw.history).filter((x) => Array.isArray(x) && num(x[0]) != null && num(x[1]) != null && num(x[2]) != null) };
}
const ratio = (a, b) => (num(a) != null && num(b) > 0 ? a / b : null);
const fmtShare = (f, d = 1) => (f == null ? '—' : (f * 100).toFixed(d) + '%');
function niceShare(v) { for (const m of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1]) if (m >= v) return m; return 1; }
// rolling 24 h share from the recorded totals: our growth over the network's growth since the point about a day earlier
function shareSeries(history) {
  const out = []; let j = 0;
  for (let i = 0; i < history.length; i++) {
    const [t, net, fleet] = history[i];
    while (j < i && history[j][0] < t - 86400) j++;
    const base = history[j]; if (!base || t - base[0] < 20 * 3600) continue;
    const dn = net - base[1], df = fleet - base[2];
    if (dn > 0 && df >= 0) out.push([t, df / dn]);
  }
  return out;
}
function NetworkHourlyChart({ net, rows }) {
  const [hover, setHover] = useState(null);
  const acc = arr(net.hourly?.accepted).map((v) => num(v) || 0);
  if (!acc.length) return <div className="panel pad"><div className="eyebrow">Network throughput</div><div className="empty">The network's hourly totals are not available{str(net.hourly?.error) ? ` (${net.hourly.error})` : ''}.</div></div>;
  const n = acc.length; const ours = rows.slice(-n).map((r) => r.total); while (ours.length < n) ours.unshift(0);
  const end = Math.floor(nowSec() / 3600) * 3600; const hours = Array.from({ length: n }, (_, i) => end - (n - 1 - i) * 3600);
  const W = 1000, H = 200, padL = 56, padR = 8, padT = 10, padB = 24;
  const max = niceMax(Math.max(...acc, 1)); const band = (W - padL - padR) / n; const bw = Math.min(26, band - 6);
  const y = (v) => padT + (1 - Math.min(v, max) / max) * (H - padT - padB);
  const totalNet = acc.reduce((a, b) => a + b, 0), totalOurs = ours.reduce((a, b) => a + b, 0);
  const hv = hover != null ? { t: hours[hover], net: acc[hover], ours: ours[hover] } : null;
  return (
    <div className="panel pad">
      <div className="panel-head"><div><div className="eyebrow">Network throughput</div><h3>Accepted steps per hour: network vs. our fleet</h3>
        <div className="muted small">Grey: everything the network accepted in each of the last {n} hours (IMD's public hourly route). Blue: what our agents submitted in the same hour. {fmtInt(totalNet)} network-wide, {fmtInt(totalOurs)} ours{ratio(totalOurs, totalNet) != null ? ` (${fmtShare(ratio(totalOurs, totalNet))})` : ''}. Work arrives in bursts, so most hours are near zero for everyone.</div></div></div>
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Accepted steps per hour, network and our fleet">
          {[0, max / 2, max].map((v, i) => (<g key={i}><line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={i === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth="1" vectorEffect="non-scaling-stroke" /><text x={4} y={y(v) + 4} fontSize="11" fill="var(--muted)" className="tnum">{fmtInt(v)}</text></g>))}
          {hours.map((t, i) => { const x = padL + i * band + (band - bw) / 2; const hn = Math.max(0, y(0) - y(acc[i])), ho = Math.max(0, y(0) - y(ours[i])); return (
            <g key={t} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${hourLabel(t)}: network ${acc[i]}, ours ${ours[i]}`}>
              <rect x={padL + i * band} y={padT} width={band} height={H - padT - padB} fill="transparent" />
              {hn > 0 && <rect x={x} y={y(acc[i])} width={bw} height={hn} fill="var(--spark)" opacity={hover === i ? 0.9 : 0.6} />}
              {ho > 0 && <rect x={x + bw * 0.25} y={y(ours[i])} width={bw * 0.5} height={ho} fill={hover === i ? 'var(--accent-strong)' : 'var(--accent)'} />}
              {i % 3 === 0 && <text x={padL + i * band + band / 2} y={H - 6} fontSize="11" fill="var(--muted)" textAnchor="middle">{hourLabel(t)}</text>}
            </g>); })}
        </svg>
        {hv && (<div className="tip" style={{ left: `${Math.min(88, Math.max(8, ((hover + 0.5) / n) * 100))}%` }}>
          <b>{hourLabel(hv.t)} – {hourLabel(hv.t + 3600)}</b>
          <div className="tip-row"><span>Network</span><b className="tnum">{fmtInt(hv.net)}</b></div>
          <div className="tip-row"><span>Our fleet</span><span className="tnum">{fmtInt(hv.ours)}</span></div>
          <div className="tip-row"><span>Share</span><span className="tnum">{fmtShare(ratio(hv.ours, hv.net))}</span></div>
        </div>)}
      </div>
    </div>
  );
}
const judgedBad = (x) => ratio((num(x.rejected) || 0) + (num(x.failed) || 0), (num(x.accepted) || 0) + (num(x.rejected) || 0) + (num(x.failed) || 0));
function NetworkView({ net, rows, workers, online, busy, where }) {
  if (net === undefined) return <div className="empty">Loading…</div>;
  if (!net) return <div className="panel pad">Network stats are not available: they come from the monitor on the box that runs the watcher, which needs the update that adds them (deploy.sh --update).</div>;
  const h = net.health, nw = net.network, fl = net.fleet;
  const ours24 = rows.reduce((a, r) => a + r.total, 0);
  const shareAll = ratio(fl.accepted, nw.accepted), seatShare = ratio(fl.seats, nw.seats);
  const series = shareSeries(net.history);
  // once a day of recorded totals exists, the 24 h KPI uses accepted on both sides (the rolling chart's last point);
  // before that it is our submissions over the network's accepted count, which runs a little low
  const rolling = series.length ? series[series.length - 1][1] : null;
  const share24 = rolling ?? ratio(ours24, h.acceptedLastDay);
  const yMax = niceShare(Math.max(0.05, ...series.map((x) => x[1])));
  const oursRanked = arr(net.ranks?.ours).filter(obj).filter((r) => num(r.rank) != null).sort((a, b) => a.rank - b.rank);
  const topAll = arr(net.ranks?.top).filter(obj); const top = topAll.slice(0, 5);
  const ls = net.landscape; const tokens = new Set(arr(fl.tokens).map(String));
  const ourTools = {}; for (const w of workers) for (const t of toolsOf(w)) ourTools[t] = (ourTools[t] || 0) + 1;
  const ourRt = {}; for (const w of workers) ourRt[runtimeOf(w)] = (ourRt[runtimeOf(w)] || 0) + 1;
  const ourConc = {}; for (const w of workers) { const c = concOf(w); if (c != null) ourConc[c] = (ourConc[c] || 0) + 1; }
  const pubs = obj(net.counts?.publications) || {}, orc = obj(net.counts?.oracle) || {}, by = obj(orc.byStatus) || {};
  const rt = Object.entries(obj(ls?.runtimes) || {}).sort((a, b) => b[1] - a[1]);
  const cc = Object.entries(obj(ls?.concurrency) || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
  const tl = Object.entries(obj(ls?.tools) || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const nrows = Math.max(rt.length, cc.length, tl.length);
  return (<>
    <div className="kpis">
      <div className="kpi hi"><span className="kpi-label">Our share, last 24 h</span><span className="kpi-value">{fmtShare(share24)}</span><span className="kpi-sub">{rolling != null ? `accepted on both sides, from recorded totals · ${fmtInt(h.acceptedLastDay)} accepted network-wide` : `${fmtInt(ours24)} submitted by us · ${fmtInt(h.acceptedLastDay)} accepted network-wide (estimate until a day of totals exists)`}</span></div>
      <div className="kpi"><span className="kpi-label">Our share, all time</span><span className="kpi-value">{fmtShare(shareAll)}</span><span className="kpi-sub">{fmtInt(fl.accepted)} of {fmtInt(nw.accepted)} accepted · {fmtInt(fl.seats)} of {fmtInt(nw.seats)} seats ({fmtShare(seatShare)})</span></div>
      <div className="kpi"><span className="kpi-label">Agents online</span><span className="kpi-value">{fmtInt(h.connectedDaemons)}<small>/{fmtInt(h.activeEnrollments)}</small></span><span className="kpi-sub">connected / enrolled · ours {online} of {workers.length}</span></div>
      <div className="kpi"><span className="kpi-label">Working now</span><span className="kpi-value">{fmtInt(h.workingNow)}</span><span className="kpi-sub">network tasks in flight · ours {busy}{num(h.pendingVerification) ? ` · ${fmtInt(h.pendingVerification)} awaiting verification` : ''}</span></div>
    </div>
    <Boundary label="network throughput" resetKey={net.generated_utc}><NetworkHourlyChart net={net} rows={rows} /></Boundary>
    <div className="spacer" />
    <div className="panel pad">
      <div className="panel-head"><div><div className="eyebrow">Share over time</div><h3>Our share of accepted work, rolling 24 h</h3>
        <div className="muted small">From the totals the monitor on {where} records every 10 min: for each point, our growth over the network's growth since the point a day earlier. The lifetime share moves slowly; this shows the current pace.</div></div></div>
      <LineChart series={[{ color: 'var(--accent)', points: series }]} yMax={yMax} empty="Collecting — the first point appears about 24 h after the monitor update that started recording." />
    </div>
    <div className="spacer" />
    <div className="tiles">
      <div className="tile"><div className="tile-top"><span className="tile-label">Network verdicts, all time</span></div><div className="box-stats">
        <div><span className="muted small">Accepted</span><b>{fmtInt(nw.accepted)}</b></div><div><span className="muted small">Rejected</span><b>{fmtInt(nw.rejected)}</b></div><div><span className="muted small">Failed</span><b>{fmtInt(nw.failed)}</b></div><div><span className="muted small">Pending</span><b>{fmtInt(nw.pending)}</b></div></div>
        <div className="muted small tile-foot">{fmtInt(nw.seats)} seats with records · rejected + failed = {fmtShare(judgedBad(nw))} of judged · refreshed every 10 min{str(net.records_at) ? ` (${ago(nowSec() - (toEpoch(net.records_at) ?? nowSec()))})` : ''}</div></div>
      <div className="tile"><div className="tile-top"><span className="tile-label">Our fleet, all time</span></div><div className="box-stats">
        <div><span className="muted small">Accepted</span><b>{fmtInt(fl.accepted)}</b></div><div><span className="muted small">Rejected</span><b>{fmtInt(fl.rejected)}</b></div><div><span className="muted small">Failed</span><b>{fmtInt(fl.failed)}</b></div><div><span className="muted small">Pending</span><b>{fmtInt(fl.pending)}</b></div></div>
        <div className="muted small tile-foot">rejected + failed = {fmtShare(judgedBad(fl))} of judged{num(fl.seats) && num(fl.accepted) ? ` · ${fmtInt(Math.round(fl.accepted / fl.seats))} accepted per seat vs ${fmtInt(Math.round((num(nw.accepted) || 0) / Math.max(1, num(nw.seats) || 1)))} network average` : ''}</div></div>
      <div className="tile"><div className="tile-top"><span className="tile-label">Oracle & publications</span></div><div className="box-stats">
        <div><span className="muted small">Oracle requests</span><b>{fmtInt(orc.total)}</b></div><div><span className="muted small">Attested</span><b>{fmtInt(by.attested)}</b></div><div><span className="muted small">Published</span><b>{fmtInt(pubs.all)}</b></div><div><span className="muted small">Contracts</span><b>{fmtInt(pubs.contracts)}</b></div></div>
        <div className="muted small tile-foot">published: {fmtInt(pubs.tokens)} tokens · {fmtInt(pubs.sites)} sites · {fmtInt(pubs.research)} research · {fmtInt(pubs.audits)} audits · counts refreshed hourly</div></div>
    </div>
    <div className="spacer" />
    <div className="panel pad">
      <div className="panel-head"><div><div className="eyebrow">Standing</div><h3>Our seats among all {fmtInt(nw.seats)}</h3><div className="muted small">Rank by accepted work, all time, from IMD's public per-seat records. The network's top five are shown for scale.</div></div></div>
      <div className="table-scroll"><table className="mini-table"><thead><tr><th className="r">Rank</th><th>Seat</th><th className="r">Accepted</th><th className="r">Share of network</th></tr></thead>
        <tbody>
          {top.map((r, i) => <tr key={'top' + r.token} className={tokens.has(String(r.token)) ? '' : 'muted'}><td className="r tnum">{fmtInt(i + 1)}</td><td>NFT #{r.token}{tokens.has(String(r.token)) ? ' · ours' : ''}</td><td className="r tnum">{fmtInt(r.accepted)}</td><td className="r tnum">{fmtShare(ratio(r.accepted, nw.accepted), 2)}</td></tr>)}
          {top.length ? <tr><td colSpan={4} className="muted small">…</td></tr> : null}
          {oursRanked.map((r) => <tr key={r.token}><td className="r tnum">{fmtInt(r.rank)}</td><td>NFT #{r.token} · ours</td><td className="r tnum">{fmtInt(r.accepted)}</td><td className="r tnum">{fmtShare(ratio(r.accepted, nw.accepted), 2)}</td></tr>)}
          {!oursRanked.length && <tr><td colSpan={4} className="empty">{str(net.records_error) ? `Records unavailable: ${net.records_error}` : 'No records yet.'}</td></tr>}
        </tbody></table></div>
    </div>
    {ls && (<><div className="spacer" />
    <div className="panel pad">
      <div className="panel-head"><div><div className="eyebrow">Landscape</div><h3>What the {fmtInt(ls.daemons)} connected daemons run</h3><div className="muted small">From the watcher's hourly read of IMD's public worker list{str(ls.ts) ? ` (${localTime(ls.ts)})` : ''}; our count beside each figure.</div></div></div>
      <div className="table-scroll"><table className="mini-table"><thead><tr><th>Runtime</th><th className="r">Network</th><th className="r">Ours</th><th>Concurrency</th><th className="r">Network</th><th className="r">Ours</th><th>Tool</th><th className="r">Network</th><th className="r">Ours</th></tr></thead>
        <tbody>{Array.from({ length: nrows }, (_, i) => <tr key={i}>
          <td>{rt[i] ? runtimeName(rt[i][0]) : ''}</td><td className="r tnum">{rt[i] ? fmtInt(rt[i][1]) : ''}</td><td className="r tnum">{rt[i] ? fmtInt(ourRt[rt[i][0]] || 0) : ''}</td>
          <td>{cc[i] ? `${cc[i][0]} slot${cc[i][0] === '1' ? '' : 's'}` : ''}</td><td className="r tnum">{cc[i] ? fmtInt(cc[i][1]) : ''}</td><td className="r tnum">{cc[i] ? fmtInt(ourConc[cc[i][0]] || 0) : ''}</td>
          <td>{tl[i] ? tl[i][0] : ''}</td><td className="r tnum">{tl[i] ? fmtInt(tl[i][1]) : ''}</td><td className="r tnum">{tl[i] ? fmtInt(ourTools[tl[i][0]] || 0) : ''}</td></tr>)}</tbody></table></div>
    </div></>)}
    <div className="muted small" style={{ marginTop: 10 }}>Sources: IMD's public health, hourly steps, per-seat records, oracle and publication counts, read by the monitor on {where} on a slow cadence (about 20 requests an hour). "Submitted by us" counts results our agents uploaded, while the network figure counts accepted verdicts, so the 24 h share is approximate; the rolling chart uses accepted on both sides once a day of totals exists.</div>
  </>);
}

/* ---------- main ---------- */
// History feeds the sparklines, the throughput chart and the agent record. The backend buckets it
// (24h = 5 min, 7d = 30 min, 30d = 2 h), so polling faster than this re-downloads the same points.
const HIST_POLL_MS = { '24h': 120000, '7d': 300000, '30d': 600000 };
const STATE_POLL_MS = 10000, HIDDEN_STATE_POLL_MS = 60000; // a hidden tab keeps one slow state poll (the hub's state toasts ride on it)
const STATE_LOST_MS = 120000; // /api/state failing this long: the rows are only the last known
const SORTS = { active: 'Active first', today: 'Most tasks today', token: 'NFT number', agent: 'Agent number' };
const VIEWS = [['agents', 'Agents'], ['activity', 'Activity'], ['network', 'Network'], ['news', 'News']];
export default function App() {
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [hist24, setHist24] = useState(null); // always 24 h: the throughput chart and sparklines, whatever the record shows
  const [histRange, setHistRange] = useState(null); // {range, hist}: the agent record's 7d/30d choice
  const [work, setWork] = useState(null);
  const [watchRaw, setWatch] = useState(undefined); // undefined = not loaded yet, null = not available
  const [network, setNetwork] = useState(undefined); // same convention; the watcher box's /api/network
  const [watchSeen, setWatchSeen] = useState(() => { try { return localStorage.getItem('imd-watch-seen'); } catch { return null; } });
  // per-notice dismissals from the attention strip's x: {key: epochSeconds}. A live condition (probation, a dead login,
  // a forecast ...) comes back after 24 h while it lasts; an event (a payment, a release ...) stays dismissed until its
  // key changes. Kept in localStorage for 7 days.
  const [dismissed, setDismissed] = useState(() => { try { const d = JSON.parse(localStorage.getItem('imd-attn-dismissed') || '{}'); const cut = nowSec() - 7 * 86400; return Object.fromEntries(Object.entries(obj(d) || {}).filter(([, v]) => num(v) > cut)); } catch { return {}; } });
  function dismiss(key) { const next = { ...dismissed, [key]: nowSec() }; setDismissed(next); try { localStorage.setItem('imd-attn-dismissed', JSON.stringify(next)); } catch {} }
  // top-bar views (imd.fyi-style): the URL hash carries the view, so a plain launcher URL opens Agents
  const [view, setViewState] = useState(() => (VIEWS.some(([k]) => k === location.hash.slice(1)) ? location.hash.slice(1) : 'agents'));
  const setView = (v) => { setViewState(v); try { history.replaceState(null, '', v === 'agents' ? location.pathname : '#' + v); } catch {} };
  useEffect(() => { const h = () => { const v = location.hash.slice(1); setViewState(VIEWS.some(([k]) => k === v) ? v : 'agents'); }; window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  const [range, setRangeState] = useState('24h');
  const rangeRef = useRef('24h'); // the latest selection: a history answer for any other range is dropped
  const setRange = (r) => { rangeRef.current = r; setRangeState(r); };
  const [hidden, setHidden] = useState(() => !!document.hidden);
  useEffect(() => { const v = () => setHidden(!!document.hidden); document.addEventListener('visibilitychange', v); return () => document.removeEventListener('visibilitychange', v); }, []);
  const [openKey, setOpenKey] = useState(null);
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [rtFilter, setRtFilter] = useState('all');
  const [boxFilter, setBoxFilter] = useState('all');
  const [sort, setSort] = useState('active');
  const [lastOk, setLastOk] = useState(null);
  const [tick, setTick] = useState(0);
  const [dark, setDark] = useState(() => {
    const t = document.documentElement.dataset.theme;
    if (t) return t === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const inflight = useRef({ state: false }); // never stack polls on a slow hub (history: one flag per range)
  // the look: 'classic' (the house style) or 'github' (Primer palettes, type and shapes); saved beside the theme
  const [skin, setSkinState] = useState(() => (document.documentElement.dataset.skin === 'github' ? 'github' : 'classic'));
  function setSkin(next) {
    if (next === 'github') document.documentElement.dataset.skin = 'github'; else delete document.documentElement.dataset.skin;
    try { localStorage.setItem('imd-skin', next); } catch {}
    setSkinState(next);
  }

  function toggleTheme() {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('imd-theme', next); } catch {}
    setDark(!dark);
  }
  // load() is captured once by the interval below, so it must not read React state
  async function load() {
    if (inflight.current.state) return;
    inflight.current.state = true;
    try {
      const r = await fetch('api/state', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('state ' + r.status);
      setState(normalizeState(await r.json(), nowSec())); setErr(null); setLastOk(new Date());
    } catch (e) { setErr(String(e.message || e)); }
    finally { inflight.current.state = false; }
  }
  // one request per range at a time; a newer selection never waits behind an older range's request, and an answer
  // for a range that is no longer selected is dropped (an in-flight request for the same range is still the right one)
  async function fetchHist(rg, install) {
    const k = 'hist:' + rg;
    if (inflight.current[k]) return;
    inflight.current[k] = true;
    try { const r = await fetch('api/history?range=' + rg); if (r.ok) install(normalizeHist(await r.json())); } catch {}
    finally { inflight.current[k] = false; }
  }
  const loadHist24 = () => fetchHist('24h', setHist24);
  const loadHist = (rg) => fetchHist(rg, (h) => { if (rangeRef.current === rg) setHistRange({ range: rg, hist: h }); });
  // verified work: the source refreshes public records every 10 min, so 5 min polling is plenty
  async function loadWork() { try { const r = await fetch('api/work'); if (r.ok) setWork(normalizeWork(await r.json())); } catch {} }
  // watcher digest: same 5 min cadence; an older backend without the route (404 or the SPA page) reads as not available
  async function loadWatch() { try { const r = await fetch('api/watch'); setWatch(r.ok ? normalizeWatch(await r.json()) : null); } catch { setWatch((w) => (w === undefined ? null : w)); } }
  // a hidden tab stops everything but one slow state poll; becoming visible re-runs these effects, which refresh at once
  // !state: a tab opened in the background still loads once at start instead of waiting a minute
  useEffect(() => { if (!hidden || !state) load(); const t = setInterval(load, hidden ? HIDDEN_STATE_POLL_MS : STATE_POLL_MS); return () => clearInterval(t); }, [hidden]);
  useEffect(() => { if (hidden) return; loadWork(); const t = setInterval(loadWork, 300000); return () => clearInterval(t); }, [hidden]);
  useEffect(() => { if (hidden) return; loadWatch(); const t = setInterval(loadWatch, 300000); return () => clearInterval(t); }, [hidden]);
  // network totals: the source refreshes every 5–10 min; same 5 min cadence as the watcher digest
  async function loadNetwork() { try { const r = await fetch('api/network'); setNetwork(r.ok ? normalizeNetwork(await r.json()) : null); } catch { setNetwork((n) => (n === undefined ? null : n)); } }
  useEffect(() => { if (hidden) return; loadNetwork(); const t = setInterval(loadNetwork, 300000); return () => clearInterval(t); }, [hidden]);
  useEffect(() => { if (hidden) return; loadHist24(); const t = setInterval(loadHist24, HIST_POLL_MS['24h']); return () => clearInterval(t); }, [hidden]);
  // 7d/30d only while a record is open on that range (24h comes from the always-on source above)
  useEffect(() => { if (hidden || range === '24h' || !openKey) return; loadHist(range); const t = setInterval(() => loadHist(range), HIST_POLL_MS[range] || 120000); return () => clearInterval(t); }, [range, hidden, openKey]);
  useEffect(() => { if (hidden) return; setTick((x) => x + 1); const t = setInterval(() => setTick((x) => x + 1), 5000); return () => clearInterval(t); }, [hidden]); // ages, "updated Xs ago"

  const workers = state?.workers || [];
  const boxes = state?.boxes || [];
  // the page's own link to the monitor: failing for over 2 min turns every retained row into "last known"
  const lost = !!err && lastOk != null && Date.now() - lastOk.getTime() > STATE_LOST_MS;
  const watch = useMemo(() => freshWatch(watchRaw, lost), [watchRaw, lost, tick]);
  // tick is a dependency: statuses age with the clock, not only with new responses
  const counts = useMemo(() => ({
    all: workers.length,
    working: workers.filter((w) => statusOf(w, lost).cls === 'working').length,
    idle: workers.filter((w) => statusOf(w, lost).cls === 'idle').length,
    attention: workers.filter((w) => needsAttention(w, lost)).length,
  }), [workers, lost, tick]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, '');
    let list = workers.filter((w) => {
      const st = statusOf(w, lost).cls;
      if (tab === 'working' && st !== 'working') return false;
      if (tab === 'idle' && st !== 'idle') return false;
      if (tab === 'attention' && !needsAttention(w, lost)) return false;
      if (rtFilter !== 'all' && runtimeOf(w) !== rtFilter) return false;
      if (boxFilter !== 'all' && w.box.id !== boxFilter) return false;
      if (needle && ![aliasOf(w), str(w.token), agentIdOf(w), w.box.name, str(w.account)].some((s) => (s || '').toLowerCase().includes(needle))) return false;
      return true;
    });
    const by = {
      active: (a, b) => statusOf(b, lost).rank - statusOf(a, lost).rank || (runningOf(b) || 0) - (runningOf(a) || 0) || Number(a.token) - Number(b.token),
      today: (a, b) => (num(snapOf(b)?.jobs?.accepted_today) || 0) - (num(snapOf(a)?.jobs?.accepted_today) || 0),
      token: (a, b) => Number(a.token) - Number(b.token),
      agent: (a, b) => Number(agentIdOf(a) || 0) - Number(agentIdOf(b) || 0),
    }[sort];
    return list.slice().sort(by);
  }, [workers, tab, q, rtFilter, boxFilter, sort, lost, tick]);

  const online = workers.filter((w) => ['working', 'idle'].includes(statusOf(w, lost).cls)).length;
  const busy = workers.reduce((a, w) => a + (runningOf(w) || 0), 0);
  const slots = workers.reduce((a, w) => a + (concOf(w) || 0), 0);
  const tasksToday = workers.reduce((a, w) => a + (num(snapOf(w)?.jobs?.accepted_today) || 0), 0);
  const submittedToday = workers.reduce((a, w) => a + (num(snapOf(w)?.jobs?.submitted_today) || 0), 0);
  const tokensToday = workers.reduce((a, w) => a + (num(snapOf(w)?.tokens?.today?.total) || 0), 0);
  const fleetOnline = workers.map((w) => num(snapOf(w)?.service?.fleet_online)).find((x) => x != null);
  const hiddenWorkers = boxes.filter((b) => !b.ok).reduce((n, b) => n + arr(b.last_workers).length, 0);
  const rows = useMemo(() => hourlyTasks(hist24, workers), [hist24, workers]);
  const modalHist = range === '24h' ? hist24 : (histRange?.range === range ? histRange.hist : null);
  const accounts = useMemo(() => accountsOf(workers), [workers]);
  const open = workers.find((w) => w.key === openKey) || null;
  const updatedAgo = lastOk ? Math.max(0, Math.round((Date.now() - lastOk.getTime()) / 1000)) : null;
  void tick;

  return (
    <div>
      <div className="topbar"><div className="topbar-inner">
        <div className="brand"><div className="logo">I:</div><b>IdentityMD</b><span>/ worker monitor</span></div>
        <nav className="topnav" aria-label="Views">{VIEWS.map(([k, label]) => {
          const n = k === 'news' ? watchNewCount(watch, watchSeen) : 0;
          return <button key={k} className={view === k ? 'on' : ''} aria-current={view === k ? 'page' : undefined} onClick={() => setView(k)}>{label}{n > 0 && <span className="count">{n}</span>}</button>;
        })}</nav>
        <div className="topbar-right">
          <div className="conn"><span className={'dot ' + (err ? 'down' : state ? '' : 'stale')} />{err ? (lost ? `disconnected · last known ${ago(updatedAgo)}` : 'disconnected') : state ? `Updated ${updatedAgo != null ? ago(updatedAgo) : ''}` : 'connecting…'}</div>
          <select className="skin-select" value={skin} onChange={(e) => setSkin(e.target.value)} aria-label="Look" title="Switch the look"><option value="classic">Classic</option><option value="github">GitHub</option></select>
          <button className="icon-btn" onClick={() => { load(); loadHist24(); loadWatch(); loadWork(); loadNetwork(); if (range !== '24h' && openKey) loadHist(range); }} title="Refresh now" aria-label="Refresh now">↻</button>
          <button className="icon-btn" onClick={toggleTheme} title={dark ? 'Switch to light' : 'Switch to dark'} aria-label="Toggle light or dark theme">{dark ? '☀' : '☾'}</button>
        </div>
      </div></div>

      <div className="wrap">
        <div className="page-head">
          {view === 'agents' && <><div className="eyebrow">◇ Agent directory</div><h1>Your agents</h1>
            <p className="muted">{state ? `${workers.length} agents on ${boxes.length} box${boxes.length !== 1 ? 'es' : ''}${fleetOnline != null ? ` · ${fmtInt(fleetOnline)} agents online across the network` : ''}` : 'Loading…'}{hiddenWorkers ? ` · ${hiddenWorkers} more on an unreachable box` : ''}</p></>}
          {view === 'activity' && <><div className="eyebrow">◇ Activity</div><h1>Activity</h1>
            <p className="muted">Payments received, tasks per hour, and IMD's public verdicts.</p></>}
          {view === 'network' && <><div className="eyebrow">◇ Network</div><h1>The network and our share</h1>
            <p className="muted">IMD's public totals next to our fleet's: throughput, share, standing, and what the other daemons run.</p></>}
          {view === 'news' && <><div className="eyebrow">◇ Since last check</div><h1>Failures, releases & news</h1>
            <p className="muted">What changed on IMD's side and on ours: failure causes, worker release notes, toolchain, and announcements.</p></>}
        </div>

        {err && !state && <div className="panel pad unreach">Can’t reach the monitor at <code>/api/state</code> ({err}). Is the launcher window still open?</div>}
        {!state && !err && <div className="empty">Loading…</div>}

        {state && (<>
          {(() => { const items = attentions(state, watch, watchSeen).filter((a) => { const t = num(dismissed[a.key]); return !(t && (a.event || nowSec() - t < 86400)); }); return items.length ? (
            <div className={'attention-strip' + (items.some((a) => a.sev === 'bad') ? ' has-bad' : '')}>{items.some((a) => a.sev === 'bad') && <div className="attention-head">⚠ Needs your attention</div>}{items.map((a) => <div className={'item ' + a.sev} key={a.key}><span className={'sev ' + a.sev} /><span className="txt">{a.text}</span><button className="x" onClick={() => dismiss(a.key)} title={a.event ? 'Dismiss' : 'Dismiss for a day'} aria-label="Dismiss this notice">✕</button></div>)}</div>) : null; })()}
          {view === 'agents' && (<>
          <div className="kpis">
            <div className="kpi hi"><span className="kpi-label">Agents online</span><span className="kpi-value">{online}<small>/{workers.length + hiddenWorkers}</small></span><span className="kpi-sub">service active, heartbeat under 10 min</span></div>
            <div className="kpi"><span className="kpi-label">Working now</span><span className="kpi-value">{counts.working}</span><span className="kpi-sub">{busy} of {slots} task slots busy</span></div>
            <div className="kpi"><span className="kpi-label">Tasks today</span><span className="kpi-value">{fmtInt(tasksToday)}</span><span className="kpi-sub">{fmtInt(submittedToday)} submitted · UTC day</span></div>
            <div className="kpi"><span className="kpi-label">Tokens today</span><span className="kpi-value">{fmtTok(tokensToday)}</span><span className="kpi-sub">all agents, cached input included</span></div>
          </div>

          <div className="section-head"><div className="eyebrow">Provider accounts</div><span className="muted small">Agents on one account share one allowance; it is shown once.</span></div>
          <div className="tiles">{accounts.map((a) => <AccountTile key={a.label} acct={a} />)}</div>

          <div className="section-head"><div className="eyebrow">Servers</div></div>
          <div className="tiles">{boxes.map((b) => <Boundary key={b.id} label={b.name} resetKey={state.generated_utc}><BoxTile box={b} hist={hist24} count={workers.filter((w) => w.box.id === b.id).length} /></Boundary>)}</div>

          <div className="spacer" />
          <div className="panel directory">
            <div className="tabs" role="tablist">
              {[['all', 'All agents'], ['working', 'Working'], ['idle', 'Idle'], ['attention', 'Needs attention']].map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}<span className="count">{counts[k]}</span></button>
              ))}
            </div>
            <div className="filters">
              <label className="search"><span aria-hidden="true">⌕</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agent, NFT or box" aria-label="Search agents" />{q && <button className="clear" onClick={() => setQ('')} aria-label="Clear search">✕</button>}</label>
              <div className="selects">
                <select value={rtFilter} onChange={(e) => setRtFilter(e.target.value)} aria-label="Runtime"><option value="all">All runtimes</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
                <select value={boxFilter} onChange={(e) => setBoxFilter(e.target.value)} aria-label="Box"><option value="all">All boxes</option>{boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
                <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">{Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </div>
            </div>
            <div className="table-scroll">
              <table className="agents">
                <thead><tr>
                  <th>Agent</th><th>Status</th><th>Runtime</th><th className="hide-md">Tools</th><th>Tasks / slots</th>
                  <th className="r">Today</th><th className="r hide-md" title="Accepted by IMD's verifier, all time (public record)">Verified</th><th className="hide-sm">Box</th><th className="hide-sm">Heartbeat</th><th aria-label="Open" />
                </tr></thead>
                <tbody>
                  {shown.map((w) => {
                    const st = statusOf(w, lost); const snap = snapOf(w); const tools = toolsOf(w);
                    return (
                      <tr key={w.key} onClick={() => setOpenKey(w.key)} tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpenKey(w.key))}>
                        <td><div className="agent-cell"><Avatar seed={w.token} /><div><b>Agent #{agentIdOf(w) || '—'}</b><small className="mono">NFT #{str(w.token) || '?'} · {aliasOf(w)}</small></div></div></td>
                        <td><Pill st={st} /></td>
                        <td><span className={'rt ' + runtimeOf(w)}><i />{runtimeName(runtimeOf(w))}</span></td>
                        <td className="hide-md">{tools.length ? tools.map((t) => <span key={t} className="chip tool">{t}</span>) : <span className="muted">—</span>}</td>
                        <td><Slots running={runningOf(w)} conc={concOf(w)} /></td>
                        <td className="r tnum">{fmtInt(snap?.jobs?.accepted_today)}</td>
                        <td className="r tnum hide-md">{fmtInt(work?.records?.[str(w.token)]?.accepted)}</td>
                        <td className="hide-sm">{w.box.name}</td>
                        <td className="hide-sm muted">{snap ? ago(heartbeatAgeOf(w)) : '—'}</td>
                        <td className="go" aria-hidden="true">↗</td>
                      </tr>
                    );
                  })}
                  {!shown.length && <tr><td colSpan={10} className="empty">No agents match.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="table-foot muted small">{shown.length} of {workers.length} agents{boxes.some((b) => !b.ok) ? ' · agents on an unreachable box are not listed' : ''}</div>
          </div>
          </>)}

          {view === 'activity' && (<>
            <Boundary label="payments received" resetKey={state.generated_utc}><PaymentsPanel watch={watch} seats={workers.length} where={watcherBox(watch, state)} /></Boundary>
            <div className="spacer" />
            <Boundary label="launch allocations" resetKey={state.generated_utc}><AllocationsPanel watch={watch} /></Boundary>
            <div className="spacer" />
            <Boundary label="throughput chart" resetKey={state.generated_utc}><TasksChart rows={rows} boxes={boxes} /></Boundary>
            {work && <><div className="spacer" /><Boundary label="verified work" resetKey={state.generated_utc}><VerifiedPanel workers={workers} work={work} where={watcherBox(work, state)} /></Boundary></>}
          </>)}
          {view === 'network' && <Boundary label="network" resetKey={state.generated_utc}><NetworkView net={network} rows={rows} workers={workers} online={online} busy={busy} where={watcherBox(network, state)} /></Boundary>}
          {view === 'news' && (watch === undefined ? <div className="empty">Loading…</div>
            : <Boundary label="since last check" resetKey={state.generated_utc}><WatchPanel watch={watch} workers={workers} seen={watchSeen} setSeen={setWatchSeen} where={watcherBox(watch, state)} /></Boundary>)}

          <div className="footer">
            <span>Local dashboard · loopback only · read-only telemetry from our own seats.</span>
            <span>Verified verdicts & reputation: <a href="https://explorer.imd.fun" target="_blank" rel="noreferrer">explorer.imd.fun</a></span>
          </div>
        </>)}
      </div>
      {open && <AgentRecord wk={open} acct={accounts.find((a) => a.seats.includes(open))} state={state} hist={modalHist} work={work} watch={watch} range={range} setRange={setRange} onClose={() => setOpenKey(null)} lost={lost} />}
    </div>
  );
}
