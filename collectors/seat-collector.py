#!/usr/bin/env python3
"""IMD monitor — per-seat collector. Runs UNDER a worker seat's own identity
(one Linux user per seat) because it reads that user's journal, session logs, and (for the
Claude allowance) makes one lightweight `claude -p` probe. Emits ONE sanitized
JSON object to stdout (or --out <file>). Contains NO secrets: only operational
metrics, percentages, counts, and timestamps.

Usage: seat-collector.py [--with-allowance] [--out /path/file.json]
  --with-allowance  also collect the plan allowance (Claude: a small model
                    probe, only on seats listed in /opt/imd-monitor/live-probe/;
                    Codex: parse the latest rollout log). Costs a little
                    Claude quota, so the slow timer sets it and the fast one omits it.
                    Codex seats also read the account's free rate-limit resets here,
                    at most every RESETS_EVERY_S (read-only; see codex_reset_credits).

With --out, a cache file next to the export (<seat>.cache.json, mode 0600) keeps the journal cursor
plus the folded counts, and per-transcript token totals keyed by size+mtime, so each run
reads only the journal entries and transcript files that are new (a full rescan costs seconds of
CPU per run). The drop dir is shared by every local user, so the cache and the previous export are
used only when they are regular files owned by this user (opened without following a symlink), and
both are written through a fresh mkstemp file plus os.replace.
"""
import argparse, datetime, getpass, glob, json, math, os, queue, re, socket, stat, subprocess, sys, tempfile, threading, time, warnings
warnings.filterwarnings("ignore")

HOME = os.path.expanduser("~")
UNIT = "identitymd-worker"
UTC = datetime.timezone.utc
NOW = datetime.datetime.now(UTC)
TODAY = NOW.strftime("%Y-%m-%d")
YESTERDAY = (NOW - datetime.timedelta(days=1)).strftime("%Y-%m-%d")

def note(msg):
    """One line on stderr, which the user unit sends to its journal."""
    print(f"seat-collector: {msg}", file=sys.stderr)

def sh(args, timeout=30):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""

def jctl(*extra):
    # JSON output: every entry carries its own cursor and a UTC epoch stamp (no local-timezone text to misread);
    # --all keeps long or non-printable messages instead of nulling them, as the old short-iso output printed them
    return sh(["/usr/bin/journalctl", "--user", "-u", UNIT, "--no-pager", "-q", "--all", "-o", "json",
               "--output-fields=MESSAGE,SYSLOG_IDENTIFIER,_PID,_HOSTNAME"] + list(extra))

def systemctl(*a):
    return sh(["/usr/bin/systemctl", "--user"] + list(a)).strip()

def iso(ts):
    try:
        return datetime.datetime.fromtimestamp(int(ts), UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None

STAMP_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(Z|[+-]\d{2}:?\d{2})?$")

def parse_utc(stamp):
    """Aware UTC datetime from an ISO-like stamp, honouring an explicit offset (Z, +0200, -05:00); a stamp
    without an offset is taken as UTC. None when it does not parse."""
    m = STAMP_RE.match(stamp.strip()) if isinstance(stamp, str) else None
    if not m:
        return None
    try:
        dt = datetime.datetime(*(int(x) for x in m.groups()[:6]), tzinfo=UTC)
    except ValueError:
        return None
    off = m.group(7)
    if off and off != "Z":
        sign = -1 if off[0] == "-" else 1
        dt -= sign * datetime.timedelta(hours=int(off[1:3]), minutes=int(off[-2:]))
    return dt

ap = argparse.ArgumentParser()
ap.add_argument("--with-allowance", action="store_true")
ap.add_argument("--out")
args = ap.parse_args()

# resolve --out (dir -> <dir>/<user>.json) up front so we can carry forward prior allowance
out = args.out
if out and (out.endswith("/") or os.path.isdir(out)):
    out = os.path.join(out, getpass.getuser() + ".json")

def load_own_json(path):
    """JSON from path, or None. Another local user can pre-create any name in the shared drop dir, so the
    file is opened without following a symlink and without blocking on a FIFO, and is used only when it is
    a regular file owned by this user."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError as e:
        note(f"ignoring {path}: {e.strerror}")
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
            note(f"ignoring {path}: not a regular file owned by this user")
            return None
        with os.fdopen(fd, encoding="utf-8") as fh:
            fd = None   # the file object owns and closes it now
            return json.load(fh)
    except Exception:
        return None
    finally:
        if fd is not None:
            os.close(fd)

def write_atomic(path, data, mode):
    """Write data to a fresh mkstemp file next to path, set its mode, then os.replace it onto path. Raises
    OSError (e.g. EPERM when another user owns path in the sticky drop dir); the temp file is removed then."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

# ---------- cache (next to the export): journal cursor + counts, per-file token totals ----------
cache_path = os.path.splitext(out)[0] + ".cache.json" if out else None
cache = load_own_json(cache_path) if cache_path else None
if not isinstance(cache, dict):
    cache = {}

# ---------- journal: ONE incremental read ----------
# journal_entries() rebuilds each JSON entry as a short-iso style line "<UTC stamp> <host> node[pid]: <ISO Z stamp>
# <message>", with continuation lines of a multi-line message indented as short-iso prints them. Every
# pattern is anchored to the start of a line (re.M) and to the message right after the worker's own stamp, so
# text inside an agent's "  working: ..." progress line (which the worker prints with its whitespace collapsed
# to single spaces) can no longer match. The pid allows 7 digits because systemd raises pid_max to 4194304.
LINE = r"^\S+ \S+ node\[\d{1,7}\]: "
# "accepted <kind> <8-hex id> ..." and "submitted <kind> for <8-hex id>". Anchoring on the id counts every job
# kind (review, tests, ... were missed before). Days come from the worker's own UTC stamp.
JOB_RE = re.compile(LINE + r"(\d{4}-\d{2}-\d{2})T\S+ (accepted|submitted) \S+ (?:for )?[0-9a-f]{8}\b", re.M)
# A real pause: the worker prints this when the runtime's rate_limit event is REJECTED, releases the lease and
# pauses new work for five minutes. "rate limit cleared" is the non-rejected event (informational) and is not
# counted. This one IS a "working:" progress line, so an agent message with exactly this text would still count.
RL_RE = re.compile(LINE + r"(\d{4}-\d{2}-\d{2})T\S+ +working: rate limited; allowing a short recovery window", re.M)
# A reconnect to api.imd.fun (after "server closed", "Max payload size exceeded", a network blip). The worker never
# restarts for these, so NRestarts stays 0 even during thousands of reconnects. Counted per day as a storm detector.
RC_RE = re.compile(LINE + r"(\d{4}-\d{2}-\d{2})T\S+ reconnecting in ", re.M)
# The liveness line; the stamp captured is the journal's own (the first on the line), as before.
HB_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T[\d:]+(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\S* \S+ node\[\d{1,7}\]: \S+ alive \S+ · (idle|\d{1,6} tasks? running) · (\d{1,9}) submitted"
    r" · fleet (\d{1,6}) online, (\d{1,6}) enrolled", re.M)
RT_RE = re.compile(LINE + r"\S+ runtimes: [^\n]*\(using (claude|codex), as asked\)", re.M)
PROFILES_RE = re.compile(LINE + r"\S+ execution profiles: ([a-z0-9@, ]+)", re.M)
TOOLS_RE = re.compile(LINE + r"\S+ tools advertised: ([a-z0-9_, -]+)", re.M)
# The ExecStart read below is the main source; this is only the fallback. "(?! )" skips progress lines.
CONC_RE = re.compile(LINE + r"\S+ (?! )[^\n]*?--concurrency[ =](\d{1,6})\b", re.M)

def to_int(x):
    try:
        return int(x)
    except (TypeError, ValueError):
        return None

def fresh_journal_state():
    # last_rt = realtime (epoch microseconds) of the newest folded entry, last_cursors = the cursors folded at
    # exactly that microsecond: the fallback filter when the saved cursor is gone from the journal
    return {"cursor": None, "last_rt": 0, "last_cursors": [], "accepted_total": 0, "submitted_total": 0, "days": {},
            "runtime": None, "profiles": [], "tools": [], "concurrency": None, "hb": None}

def fold_journal(text, st):
    """Fold journal text into st: cumulative + per-day job counts and last-seen facts. The LAST start
    wins for runtime/profiles/tools (a seat's runtime can be flipped, a tool registered or removed)."""
    for day, verb in JOB_RE.findall(text):
        st[verb + "_total"] += 1
        st["days"].setdefault(day, {"accepted": 0, "submitted": 0, "ratelimit": 0})[verb] += 1
    for day in RL_RE.findall(text):
        st["days"].setdefault(day, {"accepted": 0, "submitted": 0, "ratelimit": 0})["ratelimit"] += 1
    for day in RC_RE.findall(text):
        d = st["days"].setdefault(day, {"accepted": 0, "submitted": 0, "ratelimit": 0})
        d["reconnects"] = d.get("reconnects", 0) + 1
    rt = RT_RE.findall(text)
    if rt:
        st["runtime"] = rt[-1]
    starts = list(PROFILES_RE.finditer(text))
    if starts:
        st["profiles"] = [x.strip() for x in starts[-1].group(1).split(",") if x.strip()]
        tl = TOOLS_RE.search(text, starts[-1].start())
        st["tools"] = [x.strip() for x in tl.group(1).split(",") if x.strip()] if tl else []
    cm = CONC_RE.findall(text)
    if cm:
        st["concurrency"] = to_int(cm[-1])
    hbs = HB_RE.findall(text)
    if hbs:
        hb = list(hbs[-1])
        dt = parse_utc(hb[0])   # an offset-bearing stamp (a non-UTC box) is converted; the page appends Z itself
        hb[0] = dt.strftime("%Y-%m-%dT%H:%M:%S") if dt else None
        st["hb"] = hb
    for day in [d for d in st["days"] if d < YESTERDAY]:
        del st["days"][day]

def journal_entries(raw):
    """[(cursor, realtime_us, line)] from `journalctl -o json` output; unusable entries are skipped."""
    out = []
    for row in raw.splitlines():
        try:
            o = json.loads(row)
            cur, rt, msg = o.get("__CURSOR"), str(o.get("__REALTIME_TIMESTAMP", "")), o.get("MESSAGE")
            if not isinstance(cur, str) or not cur or not rt.isdigit() or len(rt) > 19:
                continue
            if isinstance(msg, list):   # --all prints a message with non-printable bytes as a byte array
                msg = bytes(b for b in msg if isinstance(b, int) and 0 <= b < 256).decode("utf-8", "replace")
            if not isinstance(msg, str):
                continue
            stamp = datetime.datetime.fromtimestamp(int(rt) / 1e6, UTC).strftime("%Y-%m-%dT%H:%M:%S+0000")
            host = re.sub(r"\s", "_", str(o.get("_HOSTNAME") or "-"))
            ident = re.sub(r"\s", "_", str(o.get("SYSLOG_IDENTIFIER") or "-"))
            pid = o.get("_PID")
            head = f"{stamp} {host} {ident}[{pid}]:" if isinstance(pid, str) and pid.isdigit() else f"{stamp} {host} {ident}:"
            # continuation lines are indented (as short-iso prints them) so they can never match a line pattern
            out.append((cur, int(rt), head + " " + msg.replace("\n", "\n ")))
        except Exception:
            continue
    return out

def read_journal(st):
    """Fold only the entries after the saved cursor. --cursor is inclusive, so a cursor still in the journal comes
    back as the first entry and is skipped. When it is gone (vacuumed or rotated away), the whole retained journal
    is read and only entries newer than the last folded one are folded (same-microsecond entries are told apart by
    their cursors), so a replay is never counted twice and a genuinely new same-second entry is never dropped.
    Without a saved cursor, or with a pre-cursor-tracking cache, the counts are rebuilt from the retained journal."""
    cur = st.get("cursor")
    entries = journal_entries(jctl("--cursor", cur)) if cur else []
    if cur and entries and entries[0][0] == cur:
        new = entries[1:]
    else:
        entries = journal_entries(jctl())
        if not entries:
            return   # journalctl failed or the journal is empty: keep what was folded
        if cur and st.get("last_rt"):
            seen = set(st.get("last_cursors") or [])
            new = [e for e in entries if e[1] > st["last_rt"] or (e[1] == st["last_rt"] and e[0] not in seen)]
        else:
            st.clear()
            st.update(fresh_journal_state())
            new = entries
    fold_journal("\n".join(e[2] for e in new) + "\n", st)
    st["cursor"] = entries[-1][0]
    if new:
        top = max(e[1] for e in new)
        if top > st.get("last_rt", 0):
            st["last_rt"], st["last_cursors"] = top, []
        if top == st["last_rt"]:
            st["last_cursors"] = (list(st.get("last_cursors") or []) + [e[0] for e in new if e[1] == top])[-50:]

jst = cache.get("journal")
if not isinstance(jst, dict) or set(fresh_journal_state()) - set(jst) - {"last_rt", "last_cursors"}:
    jst = fresh_journal_state()
jst.pop("last_ts", None)   # replaced by last_rt/last_cursors; an older cache keeps its cursor and counts
jst.setdefault("last_rt", 0); jst.setdefault("last_cursors", [])
read_journal(jst)
cache["journal"] = jst

runtime = jst["runtime"] or ("codex" if os.path.isdir(f"{HOME}/.codex/sessions") else "claude")
profiles, tools = jst["profiles"], jst["tools"]

worker_version = None
try:
    bj = glob.glob(f"{HOME}/.local/lib/node_modules/@identitymd/worker/build.json")
    if bj:
        worker_version = json.load(open(bj[0])).get("daemonVersion")
except Exception:
    pass

# ---------- toolchain: this seat's forge vs the Foundry the verifier expects (cached per file size+mtime) ----------
# The worker build carries VERIFIER_FOUNDRY_VERSION (used by `imd doctor`); a seat whose forge differs builds,
# formats and tests with another release than the verifier. Neither file changes between runs, so forge is spawned and the 1 MB cli.js read
# only when a file's size or mtime moved.
FORGE = f"{HOME}/.foundry/bin/forge"
WORKER_CLI = f"{HOME}/.local/lib/node_modules/@identitymd/worker/dist/cli.js"

def forge_version(path):
    m = re.search(r"\d+\.\d+\.\d+", sh([path, "--version"], timeout=10))
    return m.group(0) if m else None

def verifier_forge_version(path):
    m = re.search(r'VERIFIER_FOUNDRY_VERSION\s*=\s*"([^"]+)"', open(path, encoding="utf-8", errors="ignore").read())
    return m.group(1) if m else None

def cached_by_file(tc, key, path, read):
    """tc[key] = [[size, int(mtime)], value]; read(path) runs only when that signature changed. No file -> None."""
    try:
        s = os.stat(path); sig = [s.st_size, int(s.st_mtime)]
    except OSError:
        tc.pop(key, None)
        return None
    ent = tc.get(key)
    if isinstance(ent, list) and len(ent) == 2 and ent[0] == sig:
        return ent[1]
    try:
        value = read(path)
    except Exception:
        value = None
    if value is None:
        tc.pop(key, None)   # a timed-out or empty read is not cached: the next run tries again
    else:
        tc[key] = [sig, value]
    return value

tc = cache.get("toolchain") if isinstance(cache.get("toolchain"), dict) else {}
toolchain = {"forge": cached_by_file(tc, "forge", FORGE, forge_version),
             "verifier_forge": cached_by_file(tc, "verifier_forge", WORKER_CLI, verifier_forge_version)}
cache["toolchain"] = tc

concurrency = jst["concurrency"]
exec_start = sh(["/usr/bin/systemctl", "--user", "show", UNIT, "-p", "ExecStart"])
cm = re.search(r"--concurrency[ =](\d{1,6})\b", exec_start)
if cm:
    concurrency = to_int(cm.group(1))

# ---------- service state ----------
show = sh(["/usr/bin/systemctl", "--user", "show", UNIT, "-p", "NRestarts", "-p", "ActiveEnterTimestampMonotonic",
           "-p", "ActiveEnterTimestamp", "-p", "MainPID"])
props = dict(re.findall(r"(\w+)=(.*)", show))

def service_uptime(props, mono_now_s, now):
    """(uptime_s, started_utc). Primary: ActiveEnterTimestampMonotonic (microseconds on CLOCK_MONOTONIC) against
    the same clock now, which no timezone can skew. Fallback: the printed ActiveEnterTimestamp, only when it says
    UTC or carries a numeric offset ("Mon 2026-01-01 00:00:00 UTC"); a local zone name is not guessed."""
    mono = str(props.get("ActiveEnterTimestampMonotonic", "")).strip()
    if mono.isdigit() and int(mono) > 0 and mono_now_s is not None and mono_now_s * 1e6 >= int(mono):
        up = mono_now_s - int(mono) / 1e6
        return int(up), (now - datetime.timedelta(seconds=up)).strftime("%Y-%m-%dT%H:%M:%SZ")
    parts = str(props.get("ActiveEnterTimestamp", "")).split()
    if len(parts) >= 4:
        zone = "Z" if parts[3] in ("UTC", "GMT") else parts[3]
        start = parse_utc(parts[1] + "T" + parts[2] + zone) if re.match(r"Z$|[+-]\d{2}:?\d{2}$", zone) else None
        if start:
            return int((now - start).total_seconds()), start.strftime("%Y-%m-%dT%H:%M:%SZ")
    return None, None

try:
    _mono_now = time.clock_gettime(time.CLOCK_MONOTONIC)   # the clock systemd's *Monotonic properties use
except Exception:
    _mono_now = None
uptime_s, start_iso = service_uptime(props, _mono_now, NOW)

# ---------- last heartbeat: idle / running / fleet ----------
tasks_running = None; fleet_online = fleet_enrolled = None; last_hb = None
if jst["hb"]:
    try:
        last_hb, state, _sub, fleet_online, fleet_enrolled = jst["hb"]
        fleet_online = to_int(fleet_online); fleet_enrolled = to_int(fleet_enrolled)
        tasks_running = 0 if state == "idle" else to_int(str(state).split()[0])
    except (TypeError, ValueError, IndexError):
        tasks_running = fleet_online = fleet_enrolled = last_hb = None

# ---------- job counts (total + today) ----------
_today = jst["days"].get(TODAY, {})
jobs = {
    "accepted_total": jst["accepted_total"],
    "submitted_total": jst["submitted_total"],
    "accepted_today": _today.get("accepted", 0),
    "submitted_today": _today.get("submitted", 0),
    "ratelimit_today": _today.get("ratelimit", 0),
    "reconnects_today": _today.get("reconnects", 0),
}

# ---------- token usage from session logs (a finished transcript never changes: cache per file) ----------
TOKEN_SCAN_VERSION = 3   # part of the per-file cache signature: bump when a scan changes so cached totals are recomputed


MAX_TOKENS = 10 ** 15   # far above any real counter; a larger value is malformed, not usage

def _valid(v):
    """A finite number in 0..MAX_TOKENS. Checked before int(), so 1e400 (inf) or a 400-digit integer can no
    longer raise and discard the rest of the file."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    if isinstance(v, float) and not math.isfinite(v):
        return False
    return 0 <= v <= MAX_TOKENS

def _n(v):
    """A token count, or 0 for anything that is not _valid."""
    return int(v) if _valid(v) else 0


def scan_claude(f):
    """Per-day token usage of one Claude Code transcript. Claude Code writes one JSONL line per content block
    and repeats the same message.usage on each of them, so usage counts ONCE per message id (the largest value
    seen per field, in case an early line carries a partial count)."""
    per_id = {}   # message id -> [day, {tag: n}]
    n = 0
    for line in open(f, encoding="utf-8", errors="ignore"):
        if '"usage"' not in line: continue
        try:   # one malformed line is skipped on its own; it never discards the file's other usage
            o = json.loads(line)
            m = o.get("message") if isinstance(o, dict) else None
            u = m.get("usage") if isinstance(m, dict) else None
            if not isinstance(u, dict): continue
            n += 1
            ts = o.get("timestamp") if isinstance(o.get("timestamp"), str) else ""
            day = ts[:10] if re.match(r"\d{4}-\d{2}-\d{2}", ts) else TODAY
            mid = m.get("id") if isinstance(m.get("id"), str) and m.get("id") else "line-%d" % n
            ent = per_id.setdefault(mid, [day, {}])
            for k, tag in (("input_tokens", "uncached_input"), ("output_tokens", "output"),
                           ("cache_read_input_tokens", "cached_input"), ("cache_creation_input_tokens", "cache_write")):
                if k in u: ent[1][tag] = max(ent[1].get(tag, 0), _n(u.get(k)))
        except Exception:
            continue
    days = {}
    for day, tags in per_id.values():
        dd = days.setdefault(day, {})
        for tag, v in tags.items(): dd[tag] = dd.get(tag, 0) + v
    return days

CODEX_KEYS = ("input_tokens", "cached_input_tokens", "output_tokens")

def scan_codex(f):
    """Per-day token usage of one Codex rollout. Every token_count event carries the session's CUMULATIVE
    total_token_usage (plus the per-turn last_token_usage), so usage is the positive DELTA of that total between
    events, attributed to the UTC day of the event itself (a session running past midnight, or resumed days later,
    counts on the day the tokens were used; the previous total carries across midnight). A total lower than the
    previous one starts a new epoch, counted from that line in full. An event with only last_token_usage counts on
    its own day, and the next total's delta excludes it so it is not counted twice. The folder date is only the
    fallback for an event without a timestamp. Codex's input_tokens include cached_input_tokens."""
    dm = re.search(r"/(\d{4})/(\d{2})/(\d{2})/", f)
    folder_day = "%s-%s-%s" % dm.groups() if dm else TODAY
    days = {}; prev = None; extra = dict.fromkeys(CODEX_KEYS, 0)
    def add(day, vals):
        dd = days.setdefault(day, dict.fromkeys(CODEX_KEYS, 0))
        for k in CODEX_KEYS: dd[k] += vals[k]
    for line in open(f, encoding="utf-8", errors="ignore"):
        if "token_count" not in line: continue
        try:   # per-line isolation: a malformed line is skipped, the rest of the file still counts
            o = json.loads(line)
            p = o.get("payload") if isinstance(o, dict) else None
            if not isinstance(p, dict) or p.get("type") != "token_count": continue
            info = p.get("info") if isinstance(p.get("info"), dict) else {}
            t = info.get("total_token_usage"); l = info.get("last_token_usage")
            dt = parse_utc(o.get("timestamp"))
            day = dt.strftime("%Y-%m-%d") if dt else folder_day
            if isinstance(t, dict):
                # a field missing from a partial total, or malformed, keeps its previous value rather than reading
                # as a reset (which would start a false epoch and count the session again)
                cur = {k: (int(t[k]) if _valid(t.get(k)) else (prev or {}).get(k, 0)) for k in CODEX_KEYS}
                if prev is None:   # first total of the file: everything since zero, minus last-only usage already counted
                    add(day, {k: max(cur[k] - extra[k], 0) for k in CODEX_KEYS})
                elif any(cur[k] < prev[k] for k in CODEX_KEYS):
                    add(day, cur)   # a new epoch: everything since its zero
                else:
                    add(day, {k: max(cur[k] - prev[k] - extra[k], 0) for k in CODEX_KEYS})
                prev = cur; extra = dict.fromkeys(CODEX_KEYS, 0)
            elif isinstance(l, dict):
                vals = {k: _n(l.get(k)) for k in CODEX_KEYS}
                add(day, vals)
                for k in CODEX_KEYS: extra[k] += vals[k]
        except Exception:
            continue
    return {day: {"uncached_input": max(d["input_tokens"] - d["cached_input_tokens"], 0),
                  "cached_input": d["cached_input_tokens"], "output": d["output_tokens"]}
            for day, d in days.items() if any(d.values())}

# The allowance probe runs in PROBE_CWD; its project dir is skipped so its tokens are never counted (it passes
# --no-session-persistence, so normally nothing is written there).
PROBE_CWD = "/opt/imd-monitor/probe-cwd"
PROBE_PROJECT = re.sub(r"[^A-Za-z0-9]", "-", PROBE_CWD)   # "-opt-imd-monitor-probe-cwd"
if runtime == "claude":
    files, scan = [f for f in glob.glob(f"{HOME}/.claude/projects/*/*.jsonl")
                   if os.path.basename(os.path.dirname(f)) != PROBE_PROJECT], scan_claude
else:
    files, scan = glob.glob(f"{HOME}/.codex/sessions/**/rollout-*.jsonl", recursive=True), scan_codex
old_files = cache.get("files") if isinstance(cache.get("files"), dict) else {}
new_files = {}
by_day = {}
for f in files:
    try:
        s = os.stat(f); sig = [s.st_size, int(s.st_mtime), TOKEN_SCAN_VERSION]
        ent = old_files.get(f)
        days = ent[1] if isinstance(ent, list) and ent[0] == sig else scan(f)
        new_files[f] = [sig, days]
        for day, tags in days.items():
            for k, v in tags.items():
                by_day.setdefault(day, {}).setdefault(k, 0); by_day[day][k] += v
    except Exception: pass
cache["files"] = new_files   # files that disappeared drop out of the cache and the totals
def tot(days):
    o = {"uncached_input": 0, "output": 0, "cached_input": 0, "cache_write": 0}
    for d in days:
        for k, v in by_day.get(d, {}).items(): o[k] = o.get(k, 0) + v
    o["total"] = sum(o.values())
    return o

# ---------- allowance (optional) ----------
def probe_cwd_problem(path):
    """Why path is not a safe working directory for the probe, or None. Claude Code reads CLAUDE.md and
    settings from the working directory and its parents, so the directory must be empty and it and every
    parent must be a real (non-symlink) directory owned by root that no one else can write."""
    p = path
    while True:
        try:
            st = os.lstat(p)
        except OSError as e:
            return f"{p}: {e.strerror}"
        if not stat.S_ISDIR(st.st_mode):
            return f"{p} is not a directory"
        if st.st_uid != 0 or st.st_mode & 0o022:
            return f"{p} is not root-owned or is group/other-writable"
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
    try:
        if os.listdir(path):
            return f"{path} is not empty"
    except OSError as e:
        return f"{path}: {e.strerror}"
    return None

# Every tool is off (--tools "" plus an explicit deny list), no MCP server loads, one turn, nothing is saved.
PROBE_DENY = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit"]

def claude_allowance():
    why = probe_cwd_problem(PROBE_CWD)
    if why:
        note(f"allowance probe skipped: {why}")
        return None
    try:
        out = subprocess.run([f"{HOME}/.local/bin/claude", "-p", "Reply with exactly: OK",
                              "--model", CLAUDE_PROBE_MODEL,  # the cheapest model: the reading is the account's, not the model's
                              "--output-format", "stream-json", "--verbose",
                              "--max-turns", "1", "--tools", "", "--disallowedTools", *PROBE_DENY,
                              "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                              "--no-session-persistence"],
                             capture_output=True, text=True, timeout=90, cwd=PROBE_CWD).stdout
    except Exception:
        out = ""
    windows = []
    for line in out.splitlines():
        line = line.strip()
        if "unifiedWindows" not in line: continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        def find(x):
            if isinstance(x, dict):
                if "unifiedWindows" in x: return x["unifiedWindows"]
                for v in x.values():
                    r = find(v)
                    if r: return r
            elif isinstance(x, list):
                for v in x:
                    r = find(v)
                    if r: return r
            return None
        uw = find(o)
        if uw:
            for name, w in uw.items():
                windows.append({"name": name,
                                "window_minutes": 300 if name == "five_hour" else (10080 if name == "seven_day" else None),
                                "used_fraction": w.get("utilization"),
                                "resets_at": iso(w.get("resetsAt"))})
            break
    if not windows: return None
    return {"provider": "claude", "plan": None, "source": "live",   # the stream reports no plan
            "windows": windows, "observed_utc": NOW.strftime("%Y-%m-%dT%H:%M:%SZ")}

def codex_allowance():
    """The newest rate_limits reading across recent rollouts, timed by the event line's own timestamp. A file's
    mtime moves with every later progress line, so it is used only for a reading whose line has no timestamp,
    and then marked source "mtime_fallback". Files are visited newest-mtime first; a file whose mtime is older
    than the best event already found cannot hold a newer one, so the walk stops there."""
    files = sorted(glob.glob(f"{HOME}/.codex/sessions/**/rollout-*.jsonl", recursive=True),
                   key=os.path.getmtime, reverse=True)
    def find_rl(x):
        if isinstance(x, dict):
            if "rate_limits" in x and isinstance(x["rate_limits"], dict):
                return x["rate_limits"]
            for v in x.values():
                r = find_rl(v)
                if r: return r
        elif isinstance(x, list):
            for v in x:
                r = find_rl(v)
                if r: return r
        return None
    cands = []   # (observed datetime, rate_limits object, timed by the file mtime?)
    for f in files[:10]:
        try:
            mtime = datetime.datetime.fromtimestamp(os.path.getmtime(f), UTC)
        except OSError:
            continue
        if cands and mtime < max(c[0] for c in cands):
            break
        best = None
        try:
            for line in open(f, encoding="utf-8", errors="ignore"):
                line = line.strip()
                if '"rate_limits"' not in line or not line.startswith("{"): continue
                try:
                    o = json.loads(line)
                    r = find_rl(o)
                except Exception:
                    continue
                if not r: continue
                at = parse_utc(o.get("timestamp")) if isinstance(o, dict) else None
                if best is None or (at or mtime) >= best[0]:
                    best = (at or mtime, r, at is None)
        except Exception: pass
        if best: cands.append(best)
    for at, obj, fallback in sorted(cands, key=lambda c: c[0], reverse=True):
        windows = []
        for key in ("primary", "secondary"):
            w = obj.get(key)
            if not isinstance(w, dict): continue
            # a window whose reset is already in the past is a stale session (e.g. a seat that ran Codex weeks
            # ago and was just flipped back): report nothing rather than an old percentage
            if isinstance(w.get("resets_at"), (int, float)) and w["resets_at"] < NOW.timestamp() - 60: continue
            up = w.get("used_percent")
            # a window without a usable percentage was not observed: never report it as 0 % used
            if isinstance(up, bool) or not isinstance(up, (int, float)) or not math.isfinite(up): continue
            wm = w.get("window_minutes")
            windows.append({"name": ("weekly" if wm == 10080 else ("five_hour" if wm == 300 else f"{wm}min")),
                            "window_minutes": wm,
                            "used_fraction": up / 100.0,
                            "resets_at": iso(w.get("resets_at"))})
        if windows:
            return {"provider": "codex", "plan": obj.get("plan_type"),
                    "source": "mtime_fallback" if fallback else "last_observed",
                    "windows": windows, "observed_utc": at.strftime("%Y-%m-%dT%H:%M:%SZ")}
    return None

RESETS_EVERY_S = 12 * 3600   # twice a day
RESETS_RETRY_S = 3600        # after a failed read, retry hourly rather than every 5 minutes
# Seat logins have died soon after this read ran more often. Suspected refresh-token
# reuse (app-server and the worker's codex processes refreshing the same stored token concurrently), so the
# app-server read is OFF until that is understood; the last reading is carried forward unchanged.
RESETS_DISABLED = True
AUTH_ERROR_RE = re.compile(r"401|unauthori[sz]ed|not logged in|login|auth", re.I)

def codex_reset_credits():
    """Free rate-limit resets on this seat's ChatGPT account, read through the Codex CLI's own
    app-server, which uses its stored login (no token is read here). Sends ONLY initialize and
    account/rateLimits/read. The app-server also has account/rateLimitResetCredit/consume, which
    SPENDS a reset: never send it.
    Returns (data, error): data is the credits reading or None; error is the app-server's error text when
    the read failed (a dead login answers with a 401-style error, which the dashboard flags)."""
    allowed = {"initialize", "initialized", "account/rateLimits/read"}
    try:
        p = subprocess.Popen([f"{HOME}/.local/bin/codex", "app-server"], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    except Exception as e:
        return None, f"app-server did not start: {type(e).__name__}"
    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(l) for l in p.stdout], daemon=True).start()
    deadline = time.time() + 30
    def send(msg):
        if msg["method"] not in allowed:
            raise ValueError(msg["method"])
        p.stdin.write(json.dumps(msg) + "\n"); p.stdin.flush()
    def reply(msg_id):
        while True:
            left = deadline - time.time()
            if left <= 0: return None
            try:
                m = json.loads(lines.get(timeout=left))
            except queue.Empty:
                return None
            except Exception:
                continue
            if isinstance(m, dict) and m.get("id") == msg_id: return m
    def err_text(m):
        e = (m or {}).get("error")
        if isinstance(e, dict): return str(e.get("message") or e.get("code") or e)[:200]
        return str(e)[:200] if e else None
    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "imd-monitor", "version": "1"}}})
        r1 = reply(1)
        if not (r1 or {}).get("result"): return None, err_text(r1) or "no reply to initialize"
        send({"method": "initialized"})
        send({"id": 2, "method": "account/rateLimits/read"})
        r2 = reply(2)
        res = (r2 or {}).get("result")
        if not isinstance(res, dict): return None, err_text(r2) or "no reply to account/rateLimits/read"
        rc = res.get("rateLimitResetCredits")
        if not isinstance(rc, dict): return None, "reply carried no rateLimitResetCredits"
        items = [{"title": c.get("title"), "status": c.get("status"), "type": c.get("resetType"),
                  "granted_utc": iso(c.get("grantedAt")), "expires_utc": iso(c.get("expiresAt"))}
                 for c in (rc.get("credits") or []) if isinstance(c, dict)]
        return {"available": int(rc.get("availableCount") or 0), "credits": items}, None
    except Exception as e:
        return None, f"{type(e).__name__}"
    finally:
        p.kill()

prev = load_own_json(out) if out else None
if not isinstance(prev, dict):
    prev = {}
def since_s(stamp):
    try:
        return (NOW - datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)).total_seconds()
    except Exception:
        return None

# The Claude probe is a real model call and the allowance is account-wide, so it is opt-in: only the
# seats listed in PROBE_DIR (the operator touches PROBE_DIR/<seat>) run it, at most every ~15 min (the 5-min
# timer tick that lands at 15 min since the last live reading). No PROBE_DIR = no seat probes. Other Claude
# seats report no allowance of their own; the dashboard shows the account's reading for them.
PROBE_DIR = "/opt/imd-monitor/live-probe"
CLAUDE_PROBE_EVERY_S = 15 * 60 - 30
# the probe's model: rate_limit_info reports the account's windows whatever model answers, so use the cheapest
CLAUDE_PROBE_MODEL = "claude-haiku-4-5-20251001"
probe_entry = os.path.join(PROBE_DIR, getpass.getuser())
probe_seat = runtime != "claude" or os.path.exists(probe_entry)
# an unlisted Claude seat says why once (on the first allowance run after the reason changes), not every 5 min;
# the reason is remembered in the cache, so a run without --out (no cache) says it every time
if args.with_allowance and runtime == "claude":
    skip = None if probe_seat else (f"{probe_entry} does not exist" if os.path.isdir(PROBE_DIR)
                                    else f"{PROBE_DIR} does not exist")
    if skip and skip != cache.get("probe_skip"):
        note(f"allowance probe off (opt-in): {skip}")
    cache["probe_skip"] = skip
# the prior allowance counts only if it belongs to this runtime's provider: after a runtime flip a stale Claude
# five_hour/seven_day series must not be reported as Codex headroom
prev_al = prev.get("allowance") if isinstance(prev.get("allowance"), dict) and prev["allowance"].get("provider") == runtime else None
allowance = None
if args.with_allowance and probe_seat:
    try:
        if runtime == "claude":
            live_age = since_s(prev_al.get("observed_utc")) if prev_al and prev_al.get("source") == "live" else None
            if live_age is None or live_age >= CLAUDE_PROBE_EVERY_S:
                allowance = claude_allowance()
        else:
            allowance = codex_allowance()
    except Exception:
        allowance = None
# fast runs (and skipped or failed probes) keep the last known allowance so it doesn't blink out every 30s, but
# window by window: a window whose reset has passed (60 s grace) is dropped, the others are kept with the ORIGINAL
# observed_utc, and nothing is replaced by an invented 0 %; with no window left the reading is dropped
def carry_forward(al):
    if not isinstance(al, dict):
        return None
    ws = [w for w in (al.get("windows") or []) if isinstance(w, dict)
          and not (w.get("resets_at") and (since_s(w.get("resets_at")) or 0) > 60)]
    return dict(al, windows=ws) if ws else None
if allowance is None and probe_seat:
    allowance = carry_forward(prev_al)

# free rate-limit resets (Codex only): only the slow timer reads them, and only when due; every run
# carries the last reading forward so it doesn't blink out between reads
reset_credits = None
if runtime == "codex":
    prev_rc = prev.get("reset_credits") if isinstance(prev.get("reset_credits"), dict) else None
    def age(key):
        return since_s((prev_rc or {}).get(key))
    ok_age, try_age = age("observed_utc"), age("attempted_utc")
    due = try_age is None or (try_age >= RESETS_RETRY_S and (ok_age is None or ok_age >= RESETS_EVERY_S))
    reset_credits = prev_rc
    if RESETS_DISABLED and prev_rc and (prev_rc.get("auth_error") or prev_rc.get("error")):
        reset_credits = dict(prev_rc, auth_error=None, error=None)   # the disabled read's verdicts were unreliable
    if args.with_allowance and due and not RESETS_DISABLED:
        stamp = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
        fresh, err = codex_reset_credits()
        if fresh:
            reset_credits = dict(fresh, observed_utc=stamp, attempted_utc=stamp, error=None, auth_error=None)
        else:
            # a failed read keeps the old numbers but records why; an auth-style error means every job on
            # this seat will fail at 0 turns until `codex login --device-auth` is redone
            reset_credits = dict(prev_rc or {}, attempted_utc=stamp, error=err,
                                 auth_error=(stamp if err and AUTH_ERROR_RE.search(err) else None))

result = {
    "seat": getpass.getuser(),
    "host": socket.gethostname(),
    "runtime": runtime,
    "worker_version": worker_version,
    "concurrency": concurrency,
    "profiles": profiles,
    "tools": tools,
    "toolchain": toolchain,
    "generated_utc": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "service": {
        "active": systemctl("is-active", UNIT), "enabled": systemctl("is-enabled", UNIT),
        "restarts": int(props.get("NRestarts", "0") or 0), "main_pid": int(props.get("MainPID", "0") or 0),
        "uptime_s": uptime_s, "started_utc": start_iso,
        "tasks_running": tasks_running, "fleet_online": fleet_online, "fleet_enrolled": fleet_enrolled,
        "last_heartbeat_utc": last_hb,
    },
    "jobs": jobs,
    "tokens": {"today": tot([TODAY]), "alltime": tot(by_day.keys()), "days_tracked": len(by_day)},
    "allowance": allowance,
    "reset_credits": reset_credits,
}
text = json.dumps(result)
if out:
    try:
        write_atomic(out, text, 0o644)
    except OSError as e:
        note(f"export not written to {out}: {e.strerror}")
        sys.exit(1)
    # the cache is written last: if anything above failed, the old cursor stays and nothing is counted twice
    try:
        write_atomic(cache_path, json.dumps(cache, separators=(",", ":")), 0o600)
    except Exception as e:
        note(f"cache not saved to {cache_path}: {getattr(e, 'strerror', None) or e}")
else:
    print(text)
