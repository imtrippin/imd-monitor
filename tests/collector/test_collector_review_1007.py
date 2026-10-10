#!/usr/bin/env python3
"""Offline regression tests for collectors/seat-collector.py (review 2026-10-07 items 5, 6, 7, 8, 17, 18).

The collector runs its collection at import time, so the functions under test are extracted from the source
with ast and executed in a namespace with a fixed clock and stubbed journalctl/glob. Synthetic fixtures only
(seat "seatx", host "synthetic-host"); no network, no real journal. Exit status is non-zero on any failure.
Run: python3 tests/collector/test_collector_review_1007.py   (from the monitor root, Python 3.9+)
"""
import ast, datetime, json, os, re, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, "collectors", "seat-collector.py")
UTC = datetime.timezone.utc
NOW = datetime.datetime(2026, 10, 7, 12, tzinfo=UTC)

FUNCS = {"_n", "_valid", "scan_claude", "scan_codex", "parse_utc", "fold_journal", "fresh_journal_state", "journal_entries",
         "read_journal", "to_int", "since_s", "carry_forward", "iso", "codex_allowance", "service_uptime"}
CONSTS = {"LINE", "JOB_RE", "RL_RE", "RC_RE", "HB_RE", "RT_RE", "PROFILES_RE", "TOOLS_RE", "CONC_RE", "STAMP_RE",
          "MAX_TOKENS", "CODEX_KEYS", "TOKEN_SCAN_VERSION"}


def load():
    tree = ast.parse(open(SOURCE, encoding="utf-8").read())
    body = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in FUNCS
            or isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in CONSTS for t in n.targets)]
    import math
    ns = {"re": re, "json": json, "datetime": datetime, "os": os, "math": math, "UTC": UTC, "NOW": NOW,
          "TODAY": "2026-10-07", "YESTERDAY": "2026-10-06"}
    exec(compile(ast.Module(body=body, type_ignores=[]), SOURCE, "exec"), ns)
    missing = (FUNCS | CONSTS) - set(ns)
    if missing:
        raise SystemExit("not found in the collector: %s" % sorted(missing))
    return ns


ns = load()
failures = []


def check(name, actual, expected):
    ok = actual == expected
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "\n  actual:   %r\n  expected: %r" % (actual, expected)))
    if not ok:
        failures.append(name)


tmp = tempfile.mkdtemp(prefix="collector-test-")


def fixture(rel, rows=None, raw=None):
    path = os.path.join(tmp, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(raw if raw is not None else "".join(json.dumps(r) + "\n" for r in rows))
    return path.replace("\\", "/")


def codex(total=None, last=None, ts="2026-10-07T12:00:00Z"):
    info = {}
    if total is not None: info["total_token_usage"] = total
    if last is not None: info["last_token_usage"] = last
    row = {"type": "event_msg", "payload": {"type": "token_count", "info": info}}
    if ts: row["timestamp"] = ts
    return row


def u(i, c, o):
    return {"input_tokens": i, "cached_input_tokens": c, "output_tokens": o}


def day(un, ca, out):
    return {"uncached_input": un, "cached_input": ca, "output": out}


# ---------- #6 Codex tokens by event day ----------
check("TOKEN_SCAN_VERSION bumped to 3", ns["TOKEN_SCAN_VERSION"], 3)
f = fixture("sessions/2026/10/06/rollout-midnight.jsonl", [codex(u(100, 20, 10), ts="2026-10-06T23:59:59Z"),
                                                          codex(u(150, 30, 15), ts="2026-10-07T00:00:01Z")])
check("#6 session crossing UTC midnight splits by event day", ns["scan_codex"](f),
      {"2026-10-06": day(80, 20, 10), "2026-10-07": day(40, 10, 5)})
f = fixture("sessions/2026/10/01/rollout-resumed.jsonl", [codex(u(100, 0, 10), ts="2026-10-01T10:00:00Z"),
                                                         codex(u(300, 0, 30), ts="2026-10-07T09:00:00.123Z")])
check("#6 resumed rollout counts later usage on its own day", ns["scan_codex"](f),
      {"2026-10-01": day(100, 0, 10), "2026-10-07": day(200, 0, 20)})
f = fixture("sessions/2026/10/07/rollout-repeat.jsonl", [codex(u(100, 20, 10)), codex(u(200, 30, 20)), codex(u(200, 30, 20))])
check("#6 repeated cumulative totals count once", ns["scan_codex"](f), {"2026-10-07": day(170, 30, 20)})
f = fixture("sessions/2026/10/07/rollout-epoch.jsonl", [codex(u(1000, 200, 100)), codex(u(100, 20, 10)), codex(u(150, 30, 15))])
check("#6 a decrease starts a new epoch counted from that line", ns["scan_codex"](f), {"2026-10-07": day(920, 230, 115)})
f = fixture("sessions/2026/10/06/rollout-last.jsonl", [codex(last=u(100, 20, 10), ts="2026-10-06T23:00:00Z"),
                                                      codex(last=u(50, 10, 5), ts="2026-10-07T01:00:00Z")])
check("#6 last_token_usage-only lines count on their own day", ns["scan_codex"](f),
      {"2026-10-06": day(80, 20, 10), "2026-10-07": day(40, 10, 5)})
f = fixture("sessions/2026/10/07/rollout-mixed.jsonl", [codex(u(100, 20, 10)), codex(last=u(50, 10, 5)), codex(u(150, 30, 15))])
check("#6 a last-only line is not counted again by the next total", ns["scan_codex"](f), {"2026-10-07": day(120, 30, 15)})
f = fixture("sessions/2026/10/07/rollout-last-first.jsonl", [codex(last=u(50, 10, 5)), codex(u(50, 10, 5)), codex(u(80, 10, 9))])
check("#6 last-only usage before the file's first total is not counted twice", ns["scan_codex"](f), {"2026-10-07": day(70, 10, 9)})
f = fixture("sessions/2026/10/05/rollout-nots.jsonl", [codex(u(100, 20, 10), ts=None)])
check("#6 an event without a timestamp falls back to the folder date", ns["scan_codex"](f), {"2026-10-05": day(80, 20, 10)})
f = fixture("sessions/2026/10/06/rollout-offset.jsonl", [codex(u(10, 0, 1), ts="2026-10-07T01:30:00+0200")])
check("#6 an offset-bearing event stamp is converted to its UTC day", ns["scan_codex"](f), {"2026-10-06": day(10, 0, 1)})

# ---------- Claude rule unchanged ----------
def claude(mid, usage, ts="2026-10-07T12:00:00Z"):
    return {"timestamp": ts, "message": {"id": mid, "usage": usage}}
f = fixture("claude-repeats.jsonl", [claude("m1", {"input_tokens": 100, "output_tokens": 3}),
                                    claude("m1", {"input_tokens": 100, "output_tokens": 20}),
                                    claude("m1", {"input_tokens": 100, "output_tokens": 20})])
check("Claude counts once per message id (max per field)", ns["scan_claude"](f),
      {"2026-10-07": {"uncached_input": 100, "output": 20}})

# ---------- #17 bounded numbers ----------
f = fixture("claude-overflow.jsonl", raw=json.dumps(claude("ok", {"input_tokens": 100, "output_tokens": 10})) + "\n"
            + '{"timestamp":"2026-10-07T12:00:01Z","message":{"id":"bad","usage":{"input_tokens":1e400,"output_tokens":5}}}\n'
            + '{"timestamp":"2026-10-07T12:00:02Z","message":{"id":"big","usage":{"input_tokens":1' + "0" * 400 + '}}}\n'
            + json.dumps(claude("ok2", {"input_tokens": 1, "output_tokens": 1})) + "\n")
try:
    got = ns["scan_claude"](f)
except Exception as e:
    got = {"exception": type(e).__name__}
check("#17 Claude: inf and a 400-digit integer do not discard good totals", got,
      {"2026-10-07": {"uncached_input": 101, "output": 16}})
f = fixture("sessions/2026/10/07/rollout-overflow.jsonl", raw=json.dumps(codex(u(100, 20, 10))) + "\n"
            + '{"timestamp":"2026-10-07T12:00:01Z","payload":{"type":"token_count","info":{"total_token_usage":'
              '{"input_tokens":1e400,"cached_input_tokens":20,"output_tokens":10}}}}\n'
            + json.dumps(codex(u(150, 30, 15), ts="2026-10-07T12:00:02Z")) + "\n")
try:
    got = ns["scan_codex"](f)
except Exception as e:
    got = {"exception": type(e).__name__}
check("#17 Codex: an inf field keeps its previous value (no raise, no false epoch)", got, {"2026-10-07": day(120, 30, 15)})
check("#17 _n bounds", [ns["_n"](x) for x in (float("inf"), float("nan"), 10 ** 400, -1, True, "5", 7.9, 42)],
      [0, 0, 0, 0, 0, 0, 7, 42])

# ---------- #7 timestamps ----------
check("#7 parse_utc +0200", ns["parse_utc"]("2026-10-07T14:00:00+0200"), datetime.datetime(2026, 10, 7, 12, tzinfo=UTC))
check("#7 parse_utc -05:00 with fraction", ns["parse_utc"]("2026-10-07T07:00:00.5-05:00"),
      datetime.datetime(2026, 10, 7, 12, tzinfo=UTC))
st = ns["fresh_journal_state"]()
ns["fold_journal"]("2026-10-07T14:00:00+0200 synthetic-host node[123]: 2026-10-07T12:00:00Z alive seatx · idle · 1 submitted"
                   " · fleet 1 online, 1 enrolled\n", st)
check("#7 heartbeat on a UTC+02 box is converted to UTC", st["hb"][0], "2026-10-07T12:00:00")
check("#7 uptime from the monotonic clock", ns["service_uptime"]({"ActiveEnterTimestampMonotonic": "1000000000",
      "ActiveEnterTimestamp": "Wed 2026-10-07 13:00:00 CEST"}, 4600.0, NOW), (3600, "2026-10-07T11:00:00Z"))
check("#7 a local zone name is not guessed", ns["service_uptime"]({"ActiveEnterTimestampMonotonic": "0",
      "ActiveEnterTimestamp": "Wed 2026-10-07 13:00:00 CEST"}, None, NOW), (None, None))
check("#7 printed stamp in UTC is still accepted", ns["service_uptime"]({"ActiveEnterTimestamp": "Wed 2026-10-07 11:00:00 UTC"},
      None, NOW), (3600, "2026-10-07T11:00:00Z"))

# ---------- #18 journal cursor ----------
def jentry(cursor, rt_s, msg, pid="123"):
    return json.dumps({"__CURSOR": cursor, "__REALTIME_TIMESTAMP": str(int(rt_s * 1e6)), "_HOSTNAME": "synthetic-host",
                       "SYSLOG_IDENTIFIER": "node", "_PID": pid, "MESSAGE": msg})

T12 = NOW.timestamp()
SUB = "2026-10-07T12:00:00Z submitted review for aabbccdd"
SUB2 = "2026-10-07T12:00:00Z submitted tests for eeff0011"


class Journal:
    """Stub journalctl: entries in order; --cursor X answers from X inclusive, an unknown X answers nothing."""
    def __init__(self, rows):
        self.rows = rows; self.calls = []
    def __call__(self, *a):
        self.calls.append(a)
        if a and a[0] == "--cursor":
            ids = [json.loads(r)["__CURSOR"] for r in self.rows]
            return "\n".join(self.rows[ids.index(a[1]):]) + "\n" if a[1] in ids else ""
        return "\n".join(self.rows) + "\n"


def run(st, rows):
    ns["jctl"] = Journal(rows)
    ns["read_journal"](st)
    return st

st = run(ns["fresh_journal_state"](), [jentry("c1", T12, SUB)])
st = run(st, [jentry("c1", T12, SUB)])
check("#18 valid cursor: the saved entry is not folded again", st["submitted_total"], 1)
st = run(st, [jentry("c1", T12, SUB), jentry("c2", T12, SUB2)])
check("#18 valid cursor: a new entry in the same second is folded", st["submitted_total"], 2)

st = run(ns["fresh_journal_state"](), [jentry("c1", T12 + 0.000001, SUB)])
st = run(st, [jentry("c1", T12 + 0.000001, SUB), jentry("c3", T12 + 0.000001, SUB2)])
check("#18 same-microsecond new entry after a valid cursor", st["submitted_total"], 2)
# cursor vacuumed away: full read; c1/c3 still retained (same cursors) plus a genuinely new same-microsecond c4
st["cursor"] = "gone"
st = run(st, [jentry("c1", T12 + 0.000001, SUB), jentry("c3", T12 + 0.000001, SUB2),
              jentry("c4", T12 + 0.000001, "2026-10-07T12:00:00Z accepted review 99887766")])
check("#18 lost cursor: replay not double-counted, same-microsecond new entry kept",
      (st["submitted_total"], st["accepted_total"], st["cursor"]), (2, 1, "c4"))
st = run(st, [])
check("#18 journalctl failure keeps the folded state", (st["submitted_total"], st["cursor"]), (2, "c4"))
old = {"cursor": "c1", "last_ts": "2026-10-07T12:00:00", "accepted_total": 5, "submitted_total": 9, "days": {},
       "runtime": None, "profiles": [], "tools": [], "concurrency": None, "hb": None}
old.pop("last_ts"); old["last_rt"] = 0; old["last_cursors"] = []
st = run(old, [jentry("c1", T12, SUB), jentry("c2", T12 + 1, SUB2)])
check("#18 migrated cache with a valid cursor keeps its counts", st["submitted_total"], 10)
st = run(ns["fresh_journal_state"](), [jentry("c1", T12, "2026-10-07T12:00:00Z working: hi\nx node[1]: 2026-10-07T12:00:00Z "
                                               "submitted review for aabbccdd")])
check("#18 a multi-line message cannot forge a counted line", st["submitted_total"], 0)

# ---------- #5 allowance event time ----------
ns["HOME"] = "synthetic-home"
reset = int((NOW + datetime.timedelta(hours=1)).timestamp())
rl = {"plan_type": "pro", "primary": {"window_minutes": 300, "used_percent": 50, "resets_at": reset}}
fa = fixture("al/rollout-a.jsonl", [{"timestamp": "2026-10-07T09:00:00Z", "payload": {"rate_limits": rl}},
                                    {"timestamp": "2026-10-07T12:00:00Z", "payload": {"type": "progress"}}])
os.utime(fa, (T12, T12))
rl2 = {"plan_type": "pro", "primary": {"window_minutes": 300, "used_percent": 70, "resets_at": reset}}
fb = fixture("al/rollout-b.jsonl", [{"timestamp": "2026-10-07T10:30:00Z", "payload": {"rate_limits": rl2}}])
os.utime(fb, (T12 - 5400, T12 - 5400))
ns["glob"] = type("G", (), {"glob": staticmethod(lambda *a, **k: [fa])})
got = ns["codex_allowance"]()
check("#5 observed_utc is the event time, not the file mtime", (got["observed_utc"], got["source"]),
      ("2026-10-07T09:00:00Z", "last_observed"))
ns["glob"] = type("G", (), {"glob": staticmethod(lambda *a, **k: [fa, fb])})
got = ns["codex_allowance"]()
check("#5 newest event wins over a file touched later", (got["observed_utc"], got["windows"][0]["used_fraction"]),
      ("2026-10-07T10:30:00Z", 0.7))
fc = fixture("al/rollout-c.jsonl", [{"payload": {"rate_limits": rl}}])
os.utime(fc, (T12 - 60, T12 - 60))
ns["glob"] = type("G", (), {"glob": staticmethod(lambda *a, **k: [fc])})
got = ns["codex_allowance"]()
check("#5 no timestamped event -> mtime_fallback", (got["observed_utc"], got["source"]), ("2026-10-07T11:59:00Z", "mtime_fallback"))
fd = fixture("al/rollout-d.jsonl", [{"timestamp": "2026-10-07T11:00:00Z", "payload": {"rate_limits":
             {"primary": {"window_minutes": 300, "resets_at": reset}}}}])
ns["glob"] = type("G", (), {"glob": staticmethod(lambda *a, **k: [fd])})
check("#5/#8 a window without used_percent is not reported as 0 %", ns["codex_allowance"](), None)

# ---------- #8 carry-forward per window ----------
prev = {"provider": "claude", "source": "live", "observed_utc": "2026-10-07T06:00:00Z", "windows": [
    {"name": "five_hour", "resets_at": "2026-10-07T11:00:00Z", "used_fraction": 1},
    {"name": "seven_day", "resets_at": "2026-10-09T12:00:00Z", "used_fraction": 0.2}]}
check("#8 expired short window dropped, weekly kept with original observed_utc", ns["carry_forward"](prev),
      dict(prev, windows=[prev["windows"][1]]))
check("#8 every window expired -> no reading", ns["carry_forward"](dict(prev, windows=prev["windows"][:1])), None)
check("#8 a window inside the 60 s grace is kept", len(ns["carry_forward"](dict(prev, windows=[
      {"name": "five_hour", "resets_at": "2026-10-07T11:59:30Z", "used_fraction": 1}]))["windows"]), 1)

# ---------- smoke: the whole collector runs and emits valid JSON (no journal/systemd here -> empty fields) ----------
home = os.path.join(tmp, "home")
sess = os.path.join(home, ".codex", "sessions", "2026", "10", "07")
os.makedirs(sess)
with open(os.path.join(sess, "rollout-x.jsonl"), "w", encoding="utf-8") as fh:
    fh.write(json.dumps(codex(u(100, 20, 10), ts=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))) + "\n")
env = dict(os.environ, HOME=home, USERPROFILE=home)
r = subprocess.run([sys.executable, "-I", SOURCE], capture_output=True, text=True, env=env, timeout=60)
try:
    out = json.loads(r.stdout)
    check("smoke: collector runs, codex tokens today counted",
          (out["runtime"], out["tokens"]["today"]["uncached_input"]), ("codex", 80))
except ValueError:
    check("smoke: collector output is JSON", r.stdout[:200] + r.stderr[-500:], "<json>")

print("\n%d failure(s)" % len(failures))
sys.exit(1 if failures else 0)
