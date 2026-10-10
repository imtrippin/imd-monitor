#!/usr/bin/env python3
"""Offline regression tests for watch/imd_watch.py. No network: get/fetch/sleep are replaced with synthetic
adapters; every identifier is fictional (token "2", wallet 0x...01). Exit status non-zero on the first failure."""
import ast, importlib.util, json, os, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "watch", "imd_watch.py")
TMP = tempfile.mkdtemp(prefix="imd-watch-test-")
OUT = os.path.join(TMP, "out")
os.makedirs(OUT)
CFG = os.path.join(TMP, "watch.json")
with open(CFG, "w", encoding="utf-8") as f:
    json.dump({"tokens": ["2", "3"], "queue_probes": ["2"], "wallet": "0x" + "0" * 39 + "1"}, f)
os.environ["IMD_WATCH_DIR"], os.environ["IMD_WATCH_CONFIG"] = OUT, CFG
spec = importlib.util.spec_from_file_location("imd_watch", SRC)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
SLEPT = []
m.time.sleep = lambda s: SLEPT.append(s)


def reset():
    shutil.rmtree(OUT)
    os.makedirs(OUT)
    del SLEPT[:]


def lines(name):
    p = os.path.join(OUT, name)
    return [json.loads(l) for l in open(p, encoding="utf-8")] if os.path.exists(p) else []


def state(name):
    with open(os.path.join(OUT, name), encoding="utf-8") as f:
        return json.load(f)


# --- #20: Python 3.8 floor -------------------------------------------------------------------------------
src = open(SRC, encoding="utf-8").read()
ast.parse(src, feature_version=(3, 8))
for name in (".removeprefix(", ".removesuffix(", "import zoneinfo", "math.lcm(", ".randbytes("):
    assert name not in src, f"3.9+ only: {name}"
reset()
m.fetch = lambda url, cap=0, timeout=0: json.dumps({"items": [
    {"to": {"hash": m.COMMS}, "hash": "0xaa", "raw_input": "0x48656c6c6f", "timestamp": "2026-01-01T00:00:00.000000Z"},
    {"to": {"hash": m.COMMS}, "hash": "0xbb", "raw_input": "576f726c64", "timestamp": None}]}).encode()
m.Watch().onchain()
assert sorted(n["text"] for n in lines("news.jsonl")) == ["Hello", "World"], lines("news.jsonl")
print("ok  #20 no 3.9+ calls; on-chain 0x prefix stripped by slicing")

# --- #17: oversized integers ------------------------------------------------------------------------------
for bad in ["NaN", "Infinity", "-Infinity", "1e400", "1" * 41, "-" + "9" * 41]:
    try:
        m.loads('{"n":' + bad + '}')
    except ValueError:
        continue
    raise AssertionError(f"accepted {bad[:20]}")
assert m.loads('{"n":' + "9" * 40 + '}')["n"] == int("9" * 40)
assert m.loads('{"a":-12,"b":1.5,"c":0}') == {"a": -12, "b": 1.5, "c": 0}
assert m.usage_of({"usage": {"outputTokens": 10 ** 400, "turns": 3}}) == {"turns": 3}  # dropped, no OverflowError
assert m.usage_of({"usage": {"turns": True, "outputTokens": -1}}) is None
assert m.usage_of({"usage": {"turns": float("inf"), "model": ""}}) is None
u = m.usage_of({"usage": {"model": "model-x\x01y", "runtime": "claude", "turns": 34.0, "outputTokens": 12345,
                          "cachedInputTokens": -5, "wallClockMs": 660000, "inputTokens": True, "extra": 1}})
assert u == {"model": "model-x y", "runtime": "claude", "turns": 34, "outputTokens": 12345, "wallClockMs": 660000}, u
print("ok  #17 >40-digit integers refused like NaN; usage_of drops huge ints without OverflowError")

# --- #3: failure attribution ------------------------------------------------------------------------------
reset()
SUBS = [
    {"id": "s1", "seat": {"tokenId": "2"}, "nodeKey": "manifest", "outcome": "failed", "createdAt": "2026-10-07T10:00:00Z",
     "summary": "the task produced no changes", "attempt": 1, "usage": {"turns": 5, "outputTokens": 100}},
    {"id": "s2", "seat": {"tokenId": "2"}, "nodeKey": "manifest", "outcome": "failed", "createdAt": "2026-10-07T11:00:00.250Z",
     "summary": "Selected model is at capacity", "attempt": 2, "usage": {"turns": 0, "outputTokens": 0}},
    {"id": "s3", "seat": {"tokenId": "9"}, "nodeKey": "manifest", "outcome": "completed", "createdAt": "2026-10-07T11:30:00Z"},
]
RECENT = [
    {"jobId": "job-a", "nodeKey": "manifest", "at": "2026-10-07T10:01:00Z", "reason": "runtime_error"},
    {"jobId": "job-a", "nodeKey": "manifest", "at": "2026-10-07T13:01:00+02:00", "reason": "runtime_error"},  # = 11:01Z
    {"jobId": "job-a", "nodeKey": "manifest", "at": "2026-10-07T16:00:00Z", "reason": "runtime_error"},     # nothing near
]
REC = {"seats": [{"tokenId": "2", "failed": 3, "accepted": 10, "attempts": 13}]}


def fake_get(route, **kw):
    if route == "/seats/records":
        return REC
    if "/standing" in route:
        return {"standing": {"recentFailures": RECENT}, "contract": {"qualifies": True, "missing": []}}
    if route.endswith("/submissions"):
        return {"submissions": SUBS}
    raise AssertionError("unexpected request " + route)


m.get = fake_get
m.Watch().failures()
rows = {r["at"]: r for r in lines("failures.jsonl")}
assert len(rows) == 3, rows
a, b, c = rows["2026-10-07T10:01:00Z"], rows["2026-10-07T13:01:00+02:00"], rows["2026-10-07T16:00:00Z"]
assert (a["attempt"], a["attribution"], a["pattern"], a["turns"]) == (1, "time", "no_changes", 5), a
assert (b["attempt"], b["attribution"], b["pattern"], b["turns"]) == (2, "time", "provider_capacity", 0), b
assert c["attribution"] == "unknown" and c["attempt"] is None and c["usage"] is None and c["turns"] is None, c
assert c["summary"] is None and c["contract"] is None and c["pattern"] == "other:runtime_error", c
assert a["others"] == {"completed": 1, "failed": 0, "total": 1}, a
# a stable id or attempt number on the standing row wins over time
hit, how = m.attribute({"submissionId": "s1", "at": "2026-10-07T11:00:00Z"}, SUBS, "2")
assert (hit["id"], how) == ("s1", "id")
hit, how = m.attribute({"attempt": 2, "at": "2026-10-07T10:00:00Z"}, SUBS, "2")
assert (hit["id"], how) == ("s2", "attempt")
# 15-minute tolerance: 14:59 away matches, 15:01 does not; another seat's submission never matches
assert m.attribute({"at": "2026-10-07T10:14:59Z"}, SUBS, "2")[1] == "time"
assert m.attribute({"at": "2026-10-07T09:44:59Z"}, SUBS, "2") == ({}, "unknown")
assert m.attribute({"at": "2026-10-07T11:30:00Z"}, SUBS, "9") == ({}, "unknown")  # seat 9 completed, not failed
# two failures near one submission: the second does not borrow the already attributed one
hit, _ = m.attribute({"at": "2026-10-07T10:02:00Z"}, SUBS, "2", used={id(SUBS[0])})
assert hit == {}, hit
assert m.epoch("2026-10-07T13:01:00+02:00") == m.epoch("2026-10-07T11:01:00Z") and m.epoch("garbage") is None
print("ok  #3 failures attributed by id / attempt / nearest time within 15 min, else 'unknown' with nothing borrowed")

# --- #16: records-latest.json only from a well-formed body -------------------------------------------------
reset()
good = json.dumps(REC["seats"])
for body in [{"error": "temporary failure"}, {"seats": []}, {"seats": [{"wrong": True}]},
             {"seats": [{"tokenId": "2", "accepted": "10", "attempts": 13}]}, ["not", "a", "dict"],
             {"seats": [{"tokenId": "2", "accepted": True, "attempts": 13}]}]:
    assert not m.records_ok(body), body
assert m.records_ok(REC)
RECENT[:] = []
m.Watch().failures()
first = state("records-latest.json")
assert json.dumps(first["seats"]) == good
for i, bad in enumerate([{"error": "temporary failure"}, {"seats": []}, {"seats": [{"wrong": True}]}], 1):
    m.get = lambda route, _b=bad, **kw: _b if route == "/seats/records" else fake_get(route)
    m.Watch().failures()
    assert state("records-latest.json") == first, "a bad body replaced the last good copy"
    errs = [e for e in lines("errors.jsonl") if e["task"] == "failures"]
    assert len(errs) == i and "/seats/records: unexpected shape" in errs[-1]["error"], errs
m.get = fake_get
print("ok  #16 error object / empty list / bad rows keep the previous records-latest.json and log errors.jsonl")

# --- #2: bounded, resumable jobs() ------------------------------------------------------------------------
reset()
CALLS = []
TOTAL = 480  # four full pages and a short fifth: the listing ends after page five


def burst_get(route, **kw):
    CALLS.append(route)
    if route.startswith("/jobs?"):
        page = sum(1 for c in CALLS if c.startswith("/jobs?")) - 1
        n = max(0, min(100, TOTAL - page * 100))
        return {"count": n, "jobs": [{"id": "job-%03d" % (page * 100 + k), "template": "shape:chain",
                                      "updatedAt": "2026-10-07T12:00:00Z", "createdAt": "2026-10-07T11:00:00Z"}
                                     for k in range(n)]}
    if route.endswith("/submissions"):
        return {"submissions": []}
    return {"state": "running", "nodes": []}


m.get = burst_get
w = m.Watch()
w.jobs()
lists = [c for c in CALLS if c.startswith("/jobs?")]
reads = [c for c in CALLS if not c.startswith("/jobs?")]
assert len(lists) == 5 and len(reads) == 2 * m.JOBS_CHUNK <= 40, (len(lists), len(reads))
assert sum(SLEPT) <= 4 + 2 * m.JOBS_CHUNK, sum(SLEPT)
st = state("jobs-state.json")
assert len(st["pending"]) == TOTAL - m.JOBS_CHUNK and st["since"], len(st["pending"])
assert all(set(p) >= {"id", "updatedAt", "template"} for p in st["pending"])
passes = 1
while state("jobs-state.json")["pending"]:
    del CALLS[:]
    del SLEPT[:]
    m.Watch().jobs() if passes == 3 else w.jobs()  # pass 3 = a restart: the remainder comes from the file, not memory
    passes += 1
    assert not any(c.startswith("/jobs?") for c in CALLS), "a resumed pass must not re-list"
    assert len(CALLS) <= 40 and sum(SLEPT) <= 2 * m.JOBS_CHUNK, (len(CALLS), sum(SLEPT))
assert passes == TOTAL // m.JOBS_CHUNK, passes
heavy = lines("heavy.jsonl")
assert len(heavy) == TOTAL and len({h["job"] for h in heavy}) == TOTAL, len(heavy)
assert all(h["template"] == "shape:chain" and h["createdAt"] == "2026-10-07T11:00:00Z" for h in heavy)
del CALLS[:]
TOTAL = 3
w.jobs()  # drained: lists again from the saved since, and unchanged jobs are skipped
assert [c for c in CALLS if c.startswith("/jobs?")] and "since=" in CALLS[0], CALLS
assert len(lines("heavy.jsonl")) == 480, "an unchanged job was fetched again"
# an error mid-chunk keeps the unprocessed job pending
reset()
TOTAL, CALLS[:] = 5, []
boom = {"n": 0}


def flaky_get(route, **kw):
    if route.startswith("/jobs/job-002") and not route.endswith("submissions"):
        boom["n"] += 1
        raise OSError("timed out")
    return burst_get(route)


m.get = flaky_get
try:
    m.Watch().jobs()
    raise AssertionError("the error must reach run()'s backoff")
except OSError:
    pass
assert [p["id"] for p in state("jobs-state.json")["pending"]] == ["job-002", "job-003", "job-004"]
# a job that fails on every pass (purged, malformed) is dropped after JOBS_TRIES and never wedges the queue
w = m.Watch()
for _ in range(m.JOBS_TRIES + 2):
    try:
        w.jobs()
    except OSError:
        pass
assert state("jobs-state.json")["pending"] == [], state("jobs-state.json")
assert boom["n"] == m.JOBS_TRIES, boom
assert {r["job"] for r in lines("heavy.jsonl")} >= {"job-003", "job-004"}
assert any("dropped job job-002" in e["error"] for e in lines("errors.jsonl"))
print("ok  #2 jobs() reads <= 40 details per pass, persists the remainder and resumes without re-listing")

# --- verifier rejections of our completed work become failures.jsonl records (2026-10-09) -----------------
reset()
RJOB = {"id": "job-r1", "template": "shape:chain", "updatedAt": "2026-10-09T19:08:00Z", "createdAt": "2026-10-09T18:50:00Z"}
RSUBS = [
    {"id": "r1", "seat": {"tokenId": "2"}, "nodeKey": "token_logo", "role": "implement", "attempt": 2, "outcome": "completed",
     "accepted": False, "createdAt": "2026-10-09T19:07:30Z", "summary": "Created the logos.", "usage": {"turns": 7, "runtime": "codex", "model": "m"},
     "verdict": {"status": "rejected", "rejectionCode": "tests_failed", "detail": "test failed with exit code 1", "verifierVersion": "0.1.0+abc",
                 "profile": "foundry", "at": "2026-10-09T19:07:37Z",
                 "failedChecks": [{"name": "test", "exitCode": 1, "output": "Ran 11 tests\n[PASS] test_A()\n[FAIL: vm.readFileBinary: failed to open file] test_B()\nSuite result: FAILED"}]}},
    {"id": "r2", "seat": {"tokenId": "9"}, "nodeKey": "token_logo", "role": "implement", "attempt": 3, "outcome": "completed",
     "accepted": True, "createdAt": "2026-10-09T19:17:00Z", "verdict": {"status": "accepted"}},
    {"id": "r3", "seat": {"tokenId": "2"}, "nodeKey": "audit_math", "role": "review", "attempt": 1, "outcome": "completed",
     "accepted": False, "createdAt": "2026-10-09T19:20:00Z", "verdict": {"status": "rejected", "rejectionCode": "analysis_failed", "detail": "x"}},
    {"id": "r4", "seat": {"tokenId": "2"}, "nodeKey": "manifest", "role": "integrate", "attempt": 1, "outcome": "failed",
     "accepted": False, "createdAt": "2026-10-09T19:21:00Z", "failureReason": "runtime_error"},  # a failure, not a verdict: the digest's job
]


def rej_get(route, **kw):
    if route.startswith("/jobs?"):
        return {"count": 1, "jobs": [RJOB]}
    if route.endswith("/submissions"):
        return {"submissions": RSUBS}
    return {"state": "running", "nodes": []}


m.get = rej_get
w = m.Watch()
w.jobs()
rows = {x["node"]: x for x in lines("failures.jsonl")}
assert set(rows) == {"token_logo", "audit_math"}, rows
a = rows["token_logo"]
assert (a["pattern"], a["reason"], a["attribution"], a["attempt"], a["contract"]) == ("rejected:tests_failed", "tests_failed", "verdict", 2, "likely"), a
assert a["at"] == "2026-10-09T19:07:37Z" and a["turns"] == 7 and a["runtime"] == "codex" and a["template"] == "shape:chain", a
assert "exit code 1" in a["summary"] and "[FAIL: vm.readFileBinary" in a["summary"] and "[PASS]" not in a["summary"], a["summary"]
assert a["others"] == {"completed": 1, "failed": 0, "total": 1, "accepted": 1, "rejected": 0}, a["others"]
assert a["verdict"] == {"status": "rejected", "code": "tests_failed", "verifier": "0.1.0+abc", "profile": "foundry"}, a["verdict"]
assert rows["audit_math"]["contract"] == "no" and rows["audit_math"]["pattern"] == "rejected:analysis_failed"
pats = state("patterns.json")
assert pats["rejected:tests_failed"]["count"] == 1 and pats["rejected:analysis_failed"]["count"] == 1, pats
RJOB["updatedAt"] = "2026-10-09T19:30:00Z"  # the job moved again: the same verdicts are not recorded twice
w.jobs()
assert len(lines("failures.jsonl")) == 2, lines("failures.jsonl")
RJOB["updatedAt"] = "2026-10-09T19:40:00Z"  # a restart reads the seen keys from jobs-state.json
m.Watch().jobs()
assert len(lines("failures.jsonl")) == 2 and len(state("jobs-state.json")["rejected"]) == 2
print("ok  verifier rejections of our completed work are recorded once each as rejected:<code> with the verifier's reason")

# --- #2: run() recomputes now per task --------------------------------------------------------------------
reset()
CLOCK = [1000000.0]
STARTED = {}


class Stop(BaseException):
    pass


class Fake(m.Watch):
    pass


def make(name, cost):
    def fn(self):
        STARTED[name] = CLOCK[0]
        CLOCK[0] += cost
    fn.__name__ = name
    return fn


for name in ("queue", "jobs", "presence", "landscape", "failures", "releases", "news", "onchain",
             "launch_policies", "api_routes", "payments", "allocations"):
    setattr(Fake, name, make(name, 1000 if name == "jobs" else 1))
real_time, real_sleep = m.time.time, m.time.sleep
m.time.time = lambda: CLOCK[0]


def loop_sleep(s):
    if s == 5:
        raise Stop()


m.time.sleep = loop_sleep
fw = Fake()
try:
    fw.run()
except Stop:
    pass
m.time.time, m.time.sleep = real_time, real_sleep
assert STARTED["failures"] >= STARTED["jobs"] + 1000, STARTED  # failures ran after the slow jobs task
assert fw.due["failures"] == STARTED["failures"] + 600, (fw.due["failures"], STARTED["failures"])
assert fw.due["jobs"] == STARTED["jobs"] + 300
print("ok  #2 run() judges and schedules each task by the clock at its own start")

shutil.rmtree(TMP, ignore_errors=True)
print("watcher tests: all passed")
