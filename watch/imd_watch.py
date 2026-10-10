#!/usr/bin/env python3
"""IMD heavy-work watcher: read-only, public API only, runs as `imdmon` on one box.

Why: non-oracle work goes to few seats. This records the
evidence needed to see why and when that changes:
  heavy.jsonl      every non-oracle job: nodes, who got each node, verdicts, and the scheduler's own
                   dispatchNote (e.g. "no contributor supports profile web@1 ...": unmet requirements)
  queue.jsonl      our seats' standing.queue whenever work is waiting (ready/eligible/blocked reasons)
  presence.jsonl   any of our seats not connected / not accepting / paused
  landscape.jsonl  hourly counts of advertised tools, profiles, versions, runtimes, concurrency
  failures.jsonl   each failed submission of ours, with its cause pattern (patterns.json) and how the
                   other seats on that node fared ("only us" vs a control-plane storm); since 2026-10-09 also
                   each submission of ours the verifier refused (pattern rejected:<code>, the verifier's reason),
                   taken from the submissions the job poll already fetches
  releases.jsonl   each new worker release: notes, checksum, the verifier's Foundry version and the
                   rule strings it added/removed (tarball read in memory, never written or run)
  news.jsonl       control-plane and launch-policy version changes, IMD's on-chain messages (self-txs of 0x200E) and
                   documented-API route changes (kind api-routes: imd.fun/docs every 6 h; api-routes.json = the known set)
  records-latest.json  the last /seats/records response (the backend reads this copy instead of fetching its own)
  payments.jsonl   each IMD reward payment into the NFT wallet (one line per payout tx, from PAYERS; with
                   payout_senders set, only txs one of those addresses sent; the rest go to payments-unattributed.jsonl)
  allocations.jsonl each launch-token allotment to the NFT wallet (one line per launch, from the earnings route)
  contract.jsonl   each CHANGE of a seat's contract-work standing (IMD docs, "How contract work is handed out": qualifies, missing, last turn,
                   good/bad in 30 days, recent results, probation), read from the standing responses the
                   presence and failures tasks already fetch (0 extra requests); contract-state.json = latest
Polite by design: ~1.6 requests/min, exponential backoff (2 -> 30 min) on errors or timeouts
(IMD's API has had DB shared-memory errors and timeouts under heavy load). Each task's next due time and
backoff persist in watch-schedule.json, so a restart runs only the tasks that are already due. Spec: docs/watch.md.
"""
import json, math, os, re, time, calendar, html, io, hashlib, tarfile, zlib, urllib.request, urllib.error, urllib.parse, http.client, collections
import xml.etree.ElementTree as ET

API = "https://api.imd.fun"
UA = "imd-watch/1 (read-only fleet monitor)"
OUT = os.environ.get("IMD_WATCH_DIR", "/var/lib/imd-monitor/watch")
CONFIG = os.environ.get("IMD_WATCH_CONFIG", "/etc/imd-monitor/watch.json")


def _fleet():
    """Fleet identifiers live outside the code (see watch.example.json): the token ids of our seats, which
    of them to probe for queue state (the expensive call: one seat per runtime), and the NFT wallet that
    IMD pays rewards into (optional; without it the payments task is disabled)."""
    with open(CONFIG, encoding="utf-8") as f:
        c = json.load(f)
    tokens = [str(t) for t in c.get("tokens") or []]
    probes = [str(t) for t in c.get("queue_probes") or tokens[:1]]
    wallet = c.get("wallet") or None
    if wallet and str(wallet).lower() == "0x" + "0" * 40:  # the example's placeholder means "no wallet"
        wallet = None
    # transfers that are not rewards (e.g. a refund of your own paid orders): never recorded as payments
    exclude = {str(h).lower() for h in c.get("payments_exclude") or []}
    # the EOAs that send IMD's payouts (they call the payer contract); empty or absent = every payer transfer counts
    senders = {str(a).lower() for a in c.get("payout_senders") or []}
    if not tokens or not set(probes) <= set(tokens) or (wallet and not re.fullmatch(r"0x[0-9a-fA-F]{40}", wallet)) \
            or not all(re.fullmatch(r"0x[0-9a-f]{64}", h) for h in exclude) \
            or not all(re.fullmatch(r"0x[0-9a-f]{40}", a) for a in senders):
        raise SystemExit(f"{CONFIG}: needs a non-empty 'tokens' list, 'queue_probes' drawn from it, an optional 0x wallet, optional 0x tx hashes in 'payments_exclude' and optional 0x addresses in 'payout_senders'")
    return tokens, probes, wallet, exclude, senders


OURS, QUEUE_PROBES, WALLET, PAYMENTS_EXCLUDE, PAYOUT_SENDERS = _fleet()
TERMINAL = {"completed", "cancelled", "blocked", "failed"}
RELEASES = "https://github.com/Identity-md/worker/releases"
COMMS = "0x200E710aCAA6A93bbc77146026328C40F1d60fB1"
ATOM = "{http://www.w3.org/2005/Atom}"
IMD_TOKEN = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7"  # the IMD ERC-20
PAYERS = {"0xd15fe25ed0dba12fe05e7029c88b10c25e8880e3"}  # lowercase; IMD's Disperse contract (staking/swaps are not payments)
# first match wins; tested against (reason, summary, turns) of our failed submission
PATTERNS = [("reads_mismatch", lambda r, s, t: re.search(r"could not materialize reads", s)),
            ("upload_500", lambda r, s, t: re.search(r"bundle upload failed", s)),
            ("turn_budget", lambda r, s, t: (t or 0) >= 60),
            ("no_changes", lambda r, s, t: re.search(r"produced no changes", s)),
            ("provider_auth", lambda r, s, t: re.search(r"unauthorized \(401\)|workspace routing discovery|Failed to authenticate|OAuth token revoked", s)),  # Claude Code 2.1.287+ words a revoked claude.ai login "Failed to authenticate" / "OAuth token revoked"  # the runtime's login is dead: every job fails at 0 turns until the seat logs in again
            ("provider_refusal", lambda r, s, t: re.search(r"flagged for possible cybersecurity risk", s)),  # the runtime's own safety filter refused the job (seen on Codex audit_* nodes)
            ("provider_capacity", lambda r, s, t: re.search(r"Selected model is at capacity", s)),  # the provider had no capacity for the run (0 turns; seen on Codex during big oracle waves)
            ("bundle_too_large", lambda r, s, t: re.search(r"bundle is \d+ bytes; the upload limit", s)),  # the export exceeded IMD's 8 MiB bundle cap (generated files or a repo that outgrew it)
            ("path_violation", lambda r, s, t: r == "path_violation" or re.search(r"outside the task's allowed paths", s)),
            ("missing_outputs", lambda r, s, t: re.search(r"required outputs are missing", s)),
            ("tests_failed", lambda r, s, t: r == "tests_failed"),
            ("internal_error", lambda r, s, t: r == "internal_error")]
RULE_WORDS = re.compile(r"must|never|only|always|fail|required|write|submit|revision|verifier|allowed|do not|don't", re.I)
FORGE_RE = re.compile(r'VERIFIER_FOUNDRY_VERSION\s*=\s*"([^"]+)"')
CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")  # C0 and C1 control characters
TAR_MEMBERS, TAR_MEMBER_CAP = 64, 20 << 20  # a worker release tarball: members read up to cli.js, bytes per member
SCHEDULE = "watch-schedule.json"
DOCS_URL = "https://imd.fun/docs/"  # every public route is documented there (/openapi.json covers paid requests only)
ROUTE_RE = re.compile(r"\b(GET|POST|PUT|DELETE|PATCH)\s+(/[A-Za-z0-9_:./?=&{}<>-]+)")
ROUTE_SKIP = re.compile(r"[A-Z]{3,}_[A-Z]+|JOB_ID|_ID\b")  # prose placeholders, not routes
JOBS_CHUNK = 20  # jobs fetched per jobs() pass: 2 reads each, so <= 40 detail+submission reads before other tasks get a turn
JOBS_TRIES = 5  # passes a pending job may fail (backoff 2..30 min, about an hour) before it is dropped
ATTRIBUTE_S = 900  # a standing failure matches our failed submission whose createdAt is within 15 min of its `at`
MAX_INT_DIGITS = 40  # longer JSON integer literals are refused like NaN (a float() of them overflows)
USAGE_KEYS = (("model", str), ("runtime", str), ("turns", int), ("inputTokens", int), ("outputTokens", int),
              ("cachedInputTokens", int), ("wallClockMs", int))


def clean(s):
    """Job text (failure summaries, dispatch notes) with control characters replaced by spaces: agents and the
    scheduler write it, and terminals and the operator's Claude session print it later."""
    return CTRL_RE.sub(" ", s) if isinstance(s, str) else s


def usage_of(sub):
    """A submission's reported usage, kept to the fields the page shows (strings cleaned and capped, counts as
    non-negative ints); None when the submission carries none. No request: it rides on reads already made."""
    u = sub.get("usage") if isinstance(sub, dict) else None
    if not isinstance(u, dict):
        return None
    out = {}
    for k, typ in USAGE_KEYS:
        v = u.get(k)
        if typ is str and isinstance(v, str) and v:
            out[k] = clean(v)[:60]
        # ints are range-checked without float(): math.isfinite(10**400) raises OverflowError
        elif typ is int and not isinstance(v, bool) and ((isinstance(v, int) and 0 <= v <= 2 ** 63)
                                                         or (isinstance(v, float) and math.isfinite(v) and v >= 0)):
            out[k] = int(v)
    return out or None


def _non_finite(c):
    raise ValueError(f"non-finite JSON number {c}")


def _finite_float(s):
    f = float(s)
    if not math.isfinite(f):  # e.g. 1e400 overflows to inf
        raise ValueError(f"non-finite JSON number {s[:40]}")
    return f


def _bounded_int(s):
    if len(s.lstrip("-")) > MAX_INT_DIGITS:  # checked on the literal, before int()/float() ever see it
        raise ValueError(f"oversized JSON integer {s[:40]}...")
    return int(s)


def loads(b):
    """json.loads that refuses NaN, Infinity, numbers that overflow a float (int(inf) raises OverflowError) and
    integer literals over MAX_INT_DIGITS digits (a later float() or math.isfinite() of them would overflow)."""
    return json.loads(b, parse_constant=_non_finite, parse_float=_finite_float, parse_int=_bounded_int)


def epoch(s):
    """An API timestamp (2026-01-01T12:00:00.123Z or with a +hh:mm offset; no zone = UTC) as epoch seconds,
    None when unparsable. Hand-rolled: datetime.fromisoformat before 3.11 refuses "Z" and most fractions."""
    m = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:?\d\d)?", s.strip()) if isinstance(s, str) else None
    if not m:
        return None
    try:
        t = calendar.timegm(time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S")) + float(m.group(2) or 0)
    except ValueError:
        return None
    z = m.group(3)
    if z and z != "Z":
        z = z.replace(":", "")
        t -= (1 if z[0] == "+" else -1) * (int(z[1:3]) * 3600 + int(z[3:5]) * 60)
    return t


def records_ok(rec):
    """A /seats/records body worth replacing records-latest.json with: a non-empty seats list whose every row is
    a dict with a tokenId and numeric accepted/attempts (an error object or [] must never pass as fresh totals)."""
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    seats = rec.get("seats") if isinstance(rec, dict) and not rec.get("error") else None
    return isinstance(seats, list) and bool(seats) and all(
        isinstance(r, dict) and r.get("tokenId") not in (None, "") and num(r.get("accepted")) and num(r.get("attempts"))
        for r in seats)


def attribute(f, subs, t, used=()):
    """Our failed submission behind standing failure f, as (submission, how). how = "id" (the row names the
    submission), "attempt" (the row's attempt number matches exactly one of ours), "time" (our failed submission
    on that node whose createdAt is nearest f.at, within ATTRIBUTE_S), or "unknown" with {} (nothing is borrowed
    from another attempt's usage or summary). `subs` are the node's submissions; `used` ids are skipped."""
    mine = [s for s in subs if (s.get("seat") or {}).get("tokenId") == t and id(s) not in used]
    sid = f.get("submissionId") or f.get("submission")
    if isinstance(sid, str) and sid:
        hit = [s for s in mine if s.get("id") == sid or s.get("submissionId") == sid]
        if len(hit) == 1:
            return hit[0], "id"
    failed = [s for s in mine if s.get("outcome") == "failed"]
    if isinstance(f.get("attempt"), int) and not isinstance(f.get("attempt"), bool):
        hit = [s for s in failed if s.get("attempt") == f["attempt"]]
        if len(hit) == 1:
            return hit[0], "attempt"
    at = epoch(f.get("at"))
    near = [(abs(epoch(s.get("createdAt")) - at), s) for s in failed if at is not None and epoch(s.get("createdAt")) is not None]
    near = [(d, s) for d, s in near if d <= ATTRIBUTE_S]
    if near:
        closest = min(d for d, _ in near)
        candidates = [s for d, s in near if d == closest]
        if len(candidates) == 1:
            return candidates[0], "time"
    return {}, "unknown"


def decimals(v):
    """A token's decimals (default 18), refused outside 0..36: 10 ** a huge value would stall the watcher."""
    d = int(v or 18)
    if not 0 <= d <= 36:
        raise ValueError(f"token decimals {d} out of range")
    return d


def get(path, timeout=25, cap=8 << 20):
    """JSON from IMD's API, refused past `cap` bytes."""
    req = urllib.request.Request(API + path, headers={"accept": "application/json", "user-agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(cap + 1)
    if len(data) > cap:
        raise ValueError(f"{path[:200]}: larger than {cap} bytes")
    return loads(data)


def fetch(url, cap=20 << 20, timeout=60):
    """Raw bytes from GitHub/blockscout, held in memory and refused past `cap`."""
    req = urllib.request.Request(url, headers={"user-agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        want = r.headers.get("content-length")
        data = r.read(cap + 1)
    if len(data) > cap:
        raise ValueError(f"{url}: larger than {cap} bytes")
    # a connection closed early returns a short body without raising; a short tarball must be retried, not recorded
    if want and want.isdigit() and int(want) <= cap and len(data) != int(want):
        raise ValueError(f"{url}: short read {len(data)} of {want} bytes")
    return data


def emit(name, rec):
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **rec}
    with open(os.path.join(OUT, name), "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")


def load(name, default):
    try:
        with open(os.path.join(OUT, name), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(name, obj):
    tmp = os.path.join(OUT, name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, os.path.join(OUT, name))


def pattern_of(reason, summary, turns):
    for name, test in PATTERNS:
        if test(reason, summary or "", turns):
            return name
    return f"other:{reason}"


# Contract-work standing (IMD docs, "How contract work is handed out"): the top-level `contract` section of
# /seats/:id/standing. Observed: `good` = accepted PREMIUM steps only (contract builds, tests,
# manifests, frontends, websites); audits, reviews, research, media and oracle never move it. `bad` = verifier
# rejections + every failure the plane stores as failureClass "machine" (failures such as no_changes, turn_budget, missing_outputs,
# clone_failed and the dead-login 401 all are; path_violation is "task", internal_error "unclear"). 2 bad of the last
# 3 = 24 h probation (lower priority, still gets overflow), a bad retry doubles it up to 7 days.
CONTRACT_KEYS = ("qualifies", "missing", "lastTurnAt", "good", "bad", "recent", "probationUntil", "retryDue", "probations")
NOT_CONTRACT = re.compile(r"^(oracle_assess|research_report|create_(image|video|audio)|panel|site_content_check|audit_|adversarial_review|review)")


def contract_count(node, role, failure_class):
    """Whether a failed submission counts toward contract standing: 'likely' = a premium step stored as a machine
    failure (the bad results observed were exactly these plus a verifier rejection), 'no' = not a premium step or an excluded
    class, None = a class we have not seen counted or excluded ("unclear", or a new one)."""
    if role not in ("implement", "tests", "integrate") or NOT_CONTRACT.match(node or ""):
        return "no"
    return {"machine": "likely", "task": "no", "infrastructure": "no", "capacity": "no", "login": "no", "safety": "no"}.get(failure_class)


def contract_events(prev, cur):
    """Notable changes between two contract sections (None = the section was absent). A plain good++ or a new
    lastTurnAt is logged but is not an event, so the first run and routine turns never light the News badge."""
    if cur is None:
        return ["section_missing"]
    if prev is None:
        return ["section_back"]
    ev = []
    pu, cu = prev.get("probationUntil"), cur.get("probationUntil")
    if not pu and cu:
        ev.append("probation_start")
    elif pu and cu and str(cu) > str(pu):
        ev.append("probation_extended")
    elif pu and not cu:
        ev.append("probation_cleared")
    if not prev.get("retryDue") and cur.get("retryDue"):
        ev.append("retry_due")
    if prev.get("qualifies") is True and cur.get("qualifies") is not True:
        ev.append("qualifies_lost")
    if prev.get("qualifies") is not True and cur.get("qualifies") is True:
        ev.append("qualifies_gained")
    if (prev.get("missing") or []) != (cur.get("missing") or []):
        ev.append("missing_changed")
    bads = lambda c: sum(1 for r in (c.get("recent") or []) if r == "bad")
    if (cur.get("bad") or 0) > (prev.get("bad") or 0) or bads(cur) > bads(prev):
        ev.append("bad_added")
    return ev


def notes_text(h):
    """Release notes HTML -> plain lines, the boilerplate "Install" section dropped."""
    h = re.sub(r"<h2>\s*Install\s*</h2>.*?(?=<h2>|$)", "", h, flags=re.S | re.I)
    h = re.sub(r"<li[^>]*>", "- ", h)
    h = re.sub(r"</(li|p|h\d|ul|ol)>|<br\s*/?>", "\n", h)
    t = html.unescape(re.sub(r"<[^>]+>", "", h))
    return "\n".join(l.strip() for l in t.splitlines() if l.strip())[:2000]


STR_RE = {'"': re.compile(r'"(?:[^"\\\n]|\\.)*"?', re.S), "'": re.compile(r"'(?:[^'\\\n]|\\.)*'?", re.S)}
TPL_RE = re.compile(r"(?:[^`\\$]|\\.|\$(?!\{))*", re.S)
NEXT_RE = re.compile(r"[\"'`{}/]")
REGEX_RE = re.compile(r"/(?:[^/\\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+/[a-z]*")
REGEX_AFTER = re.compile(r"(?:^|[(,=:\[!&|?{};+\-*%<>~^]|(?<![\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await))\s*$")


def js_strings(src):
    """Text of every JS string literal: quoted strings and template-literal runs between backticks or
    ${...} boundaries (nested templates tracked by brace depth). Regex literals are skipped when a `/`
    stands where an expression starts (the usual heuristic); it is the same for every release, so the
    diff between releases stays meaningful."""
    out, depth, i, n = [], [], 0, len(src)
    while i < n:
        m = NEXT_RE.search(src, i)
        if not m:
            break
        i, c = m.start(), m.group()
        if c in STR_RE:
            m = STR_RE[c].match(src, i)
            s = m.group()
            out.append(s[1:-1] if len(s) > 1 and s.endswith(c) else s[1:])
            i = m.end()
        elif c == "`" or (c == "}" and depth and depth[-1] == 0):
            if c == "}":
                depth.pop()
            m = TPL_RE.match(src, i + 1)
            out.append(m.group())
            i = m.end()
            if src.startswith("${", i):
                depth.append(0)
                i += 2
            else:
                i += 1
        elif c == "{":
            if depth:
                depth[-1] += 1
            i += 1
        elif c == "}":
            if depth:
                depth[-1] -= 1
            i += 1
        elif src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j + 1
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif REGEX_AFTER.search(src, max(0, i - 12), i) and (m := REGEX_RE.match(src, i)):
            i = m.end()
        else:
            i += 1
    return out


def rule_strings(src):
    rules = set()
    for s in js_strings(src):
        s = " ".join(s.split())
        if len(s) >= 60 and RULE_WORDS.search(s):
            rules.add(s)
    return sorted(rules)


def keep_newest(prefix, k=4):
    files = sorted((f for f in os.listdir(OUT) if f.startswith(prefix) and f.endswith(".json")),
                   key=lambda f: os.stat(os.path.join(OUT, f)).st_mtime_ns)
    for f in files[:-k]:
        os.remove(os.path.join(OUT, f))


class Watch:
    def __init__(self):
        self.seen = {}      # job id -> last updatedAt fetched (non-oracle only)
        self.done = set()   # job ids already recorded in a terminal state
        self.templates = {} # job id -> template, for jobs already fetched for heavy.jsonl (failures reuse it)
        self.due = collections.defaultdict(float)
        self.backoff = collections.defaultdict(int)  # per task

    def jobs(self):
        # only jobs that moved since the last good poll (minus 15 min of overlap), never further back than 6 h;
        # exclude=oracle keeps an oracle wave from pushing a non-oracle job out of the window.
        # A burst is worked off JOBS_CHUNK jobs per pass: the rest waits in jobs-state.json `pending` and the
        # next pass resumes it without re-listing, so the failure digest and presence never wait behind 500 jobs.
        start = time.time()
        st = load("jobs-state.json", {})
        st = st if isinstance(st, dict) else {}
        pending = [p for p in st.get("pending") or [] if isinstance(p, dict) and all(isinstance(p.get(k), str) for k in ("id", "updatedAt", "template"))]
        st["pending"] = pending
        if not pending:
            since = max(st.get("since") or "", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start - 6 * 3600)))
            lst, before = [], None
            for page in range(5):
                if page:
                    time.sleep(1)
                q = {"exclude": "oracle", "since": since, "limit": 100, **({"before": before} if before else {})}
                d = get("/jobs?" + urllib.parse.urlencode(q))
                lst += d["jobs"]
                if d.get("count") != 100 or not d["jobs"]:
                    break
                before = min(j["createdAt"] for j in d["jobs"])
            ids = set()
            for j in lst:
                if (j["template"] == "skill:oracle-assess" or j["id"] in self.done or j["id"] in ids
                        or self.seen.get(j["id"]) == j["updatedAt"]):
                    continue
                ids.add(j["id"])
                pending.append({"id": j["id"], "updatedAt": j["updatedAt"], "template": j["template"],
                                "createdAt": j.get("createdAt"), "objective": (j.get("objective") or "")[:160]})
            st["since"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start - 900))
            save("jobs-state.json", st)
        for j in pending[:JOBS_CHUNK]:
            st["pending"] = st["pending"][1:]
            if j["id"] in self.done or self.seen.get(j["id"]) == j.get("updatedAt"):
                save("jobs-state.json", st)
                continue
            tries = j.get("tries") if isinstance(j.get("tries"), int) and not isinstance(j.get("tries"), bool) else 0
            if tries >= JOBS_TRIES:  # a job that keeps failing (purged, malformed) is dropped; it must not wedge the queue
                emit("errors.jsonl", {"task": "jobs", "error": f"dropped job {j['id']} after {tries} failed reads", "retry_s": None})
                self.seen[j["id"]] = j["updatedAt"]  # a re-listing of the same version is skipped; a newer update is tried again
                save("jobs-state.json", st)
                continue
            # counted before the reads, so an error or a crash on this job counts as a try
            save("jobs-state.json", dict(st, pending=[dict(j, tries=tries + 1)] + st["pending"]))
            d = get(f"/jobs/{j['id']}")
            nodes = [{"key": n.get("key"), "role": n.get("role"), "state": n.get("state"), "attempt": n.get("attempt"),
                      "seat": (n.get("seat") or {}).get("tokenId"), "note": clean(n.get("dispatchNote")),
                      "verdict": (n.get("verdict") or {}).get("status"), "profile": (n.get("verdict") or {}).get("profile")}
                     for n in d.get("nodes", [])]
            time.sleep(1)
            # every attempt, not just each node's last seat: catches one of ours failing before another seat finishes
            subs = (get(f"/jobs/{j['id']}/submissions") or {}).get("submissions", [])
            attempts = [{"seat": (s.get("seat") or {}).get("tokenId"), "key": s.get("nodeKey"), "attempt": s.get("attempt"),
                         "outcome": s.get("outcome"), "accepted": s.get("accepted"), "verdict": (s.get("verdict") or {}).get("status"),
                         "failure": s.get("failureReason"), "at": s.get("createdAt"),
                         "failureClass": s.get("failureClass"), "usage": usage_of(s)} for s in subs]
            emit("heavy.jsonl", {"job": j["id"], "template": j["template"], "state": d.get("state"), "createdAt": j.get("createdAt"),
                                 "updatedAt": j["updatedAt"], "objective": (j.get("objective") or "")[:160],
                                 "ours": any(n["seat"] in OURS for n in nodes) or any(a["seat"] in OURS for a in attempts),
                                 "nodes": nodes, "attempts": attempts})
            self.rejections(j, subs, st)
            self.seen[j["id"]] = j["updatedAt"]
            self.templates[j["id"]] = j["template"]
            if d.get("state") in TERMINAL:
                self.done.add(j["id"])
            save("jobs-state.json", st)  # per job, so a crash mid-chunk resumes after the last recorded one
            time.sleep(1)

    def rejections(self, j, subs, st):
        """A submission of ours that completed and was then refused by the verifier (accepted false, verdict rejected) never
        reaches standing.recentFailures, so the failure digest missed it and the standing poll reported it up to 30 min
        later as a reason-less "bad result added" (2026-10-08/09). Recorded here from the submissions jobs() already
        fetched: no extra request. Each job:node:attempt:token once (jobs-state.json `rejected`), so a later update of the
        same job does not repeat it. The verifier's detail and the [FAIL ...] lines of the first failed check are the summary."""
        seen = st.get("rejected") if isinstance(st.get("rejected"), list) else []
        pats = None
        for s in subs:
            if not isinstance(s, dict):
                continue
            t = str((s.get("seat") or {}).get("tokenId") or "")
            v = s.get("verdict") if isinstance(s.get("verdict"), dict) else {}
            if t not in OURS or s.get("accepted") is not False or v.get("status") != "rejected":
                continue
            node = s.get("nodeKey")
            key = f"{j['id']}:{node}:{s.get('attempt')}:{t}"
            if key in seen:
                continue
            code = str(v.get("rejectionCode") or "unknown")
            fails = [c for c in (v.get("failedChecks") or []) if isinstance(c, dict)]
            out = str((fails[0].get("output") if fails else "") or "")
            fail_lines = " ".join(l.strip() for l in out.splitlines() if "FAIL" in l)[:300]
            summary = clean(" · ".join(x for x in (str(v.get("detail") or ""), fail_lines) if x))[:400]
            others = [o for o in subs if isinstance(o, dict) and o.get("nodeKey") == node
                      and str((o.get("seat") or {}).get("tokenId") or "") != t]
            usage = s.get("usage") if isinstance(s.get("usage"), dict) else {}
            emit("failures.jsonl", {"token": t, "job": j["id"], "node": node, "at": v.get("at") or s.get("createdAt"), "reason": code,
                                    "pattern": "rejected:" + code, "summary": summary or None, "turns": usage.get("turns"),
                                    "runtime": usage.get("runtime"), "attempt": s.get("attempt"), "template": j.get("template"),
                                    "attribution": "verdict", "failureClass": None, "role": s.get("role"), "usage": usage_of(s),
                                    "verdict": {"status": "rejected", "code": code, "verifier": v.get("verifierVersion"), "profile": v.get("profile")},
                                    # a verifier rejection on a premium step is a bad result by IMD's rule; the enum stays likely/no/None
                                    "contract": contract_count(node, s.get("role"), "machine"),
                                    "others": {"completed": sum(o.get("outcome") == "completed" for o in others),
                                               "failed": sum(o.get("outcome") == "failed" for o in others), "total": len(others),
                                               "accepted": sum(o.get("accepted") is True for o in others),
                                               "rejected": sum((o.get("verdict") or {}).get("status") == "rejected" if isinstance(o.get("verdict"), dict) else False for o in others)}})
            if pats is None:
                pats = load("patterns.json", {})
            ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            p = pats.setdefault("rejected:" + code, {"first_seen": ts, "last_seen": ts, "count": 0})
            p["last_seen"], p["count"] = ts, p["count"] + 1
            save("patterns.json", pats)
            seen.append(key)
            st["rejected"] = seen[-1000:]

    def queue(self):
        for t in QUEUE_PROBES:
            q = (get(f"/seats/{t}/standing").get("queue") or {})
            if q.get("ready") or q.get("eligible") or q.get("blocked"):
                emit("queue.jsonl", {"token": t, "queue": q})
            time.sleep(1)

    def presence(self):
        for t in OURS:
            s = get(f"/seats/{t}/standing?queue=0")
            self.contract_obs(t, s, "presence")
            p, st = s.get("presence") or {}, s.get("standing") or {}
            if not (p.get("connected") and p.get("acceptingWork")) or st.get("pausedUntil") or p.get("stale"):
                emit("presence.jsonl", {"token": t, "connected": p.get("connected"), "accepting": p.get("acceptingWork"),
                                        "stale": p.get("stale"), "pausedUntil": st.get("pausedUntil"),
                                        "recentFailures": (st.get("recentFailures") or [])[:3]})
            time.sleep(0.5)
        cs = load("contract-state.json", {})  # a full pass: the page's "read X ago"; an aborted pass leaves it, so staleness shows
        cs["read_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        save("contract-state.json", cs)

    def contract_obs(self, t, s, src):
        """Record seat t's contract section from a standing response, only when it changed (first sighting = baseline)."""
        st = load("contract-state.json", {})
        seats = st.setdefault("seats", {})
        sec = s.get("contract")
        cur = {k: sec.get(k) for k in CONTRACT_KEYS} if isinstance(sec, dict) else None  # None = unknown, never healthy
        old = seats.get(t)
        prev = old.get("contract") if isinstance(old, dict) else None
        if old is None or prev != cur:
            emit("contract.jsonl", {"token": t, "src": src, "at": s.get("at"), "server": (s.get("server") or {}).get("version"),
                                    "contract": cur, "baseline": old is None, "events": [] if old is None else contract_events(prev, cur),
                                    "prev": None if old is None or not isinstance(prev, dict) else
                                    {k: prev.get(k) for k in CONTRACT_KEYS if prev.get(k) != (cur or {}).get(k)}})
        seats[t] = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "at": s.get("at"), "src": src, "contract": cur}
        rules = sec.get("rules") if isinstance(sec, dict) else None
        if isinstance(rules, dict) and rules != st.get("rules"):
            if st.get("rules") is not None:  # the first sighting is not news; a changed threshold is
                emit("news.jsonl", {"kind": "contract-rules", "prev": st.get("rules"), "rules": rules})
            st["rules"] = rules
        st["server"] = (s.get("server") or {}).get("version") or st.get("server")
        save("contract-state.json", st)

    def landscape(self):
        ws = get("/workers?fields=tools,profiles,daemonVersion,runtimes,maxConcurrency")["workers"]
        c = lambda f: dict(collections.Counter(f(w) for w in ws).most_common(12))
        emit("landscape.jsonl", {
            "daemons": len(ws),
            "tools": dict(collections.Counter(t for w in ws for t in w.get("tools", [])).most_common(20)),
            "profiles": c(lambda w: ",".join(w.get("profiles", []))),
            "versions": c(lambda w: (w.get("daemonVersion") or "")[-8:]),
            "runtimes": c(lambda w: ",".join(r["id"] for r in w.get("runtimes", []))),
            "concurrency": c(lambda w: w.get("maxConcurrency")),
        })

    def failures(self):
        st = load("failures-state.json", None)
        first = st is None  # first run sweeps every standing once; restarts never re-sweep
        st = st or {"records": {}, "seen": []}
        seen, pats, subs_of, used = set(st["seen"]), load("patterns.json", {}), {}, set()
        rec = get("/seats/records")
        seats = rec.get("seats") if isinstance(rec, dict) and isinstance(rec.get("seats"), list) else []
        # the backend's verified-work view reads this copy while it is fresh: one request for both readers.
        # Only a well-formed body replaces it; an error object or [] keeps the last good copy (which then ages out).
        if records_ok(rec):
            save("records-latest.json", {"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seats": seats})
        else:
            emit("errors.jsonl", {"task": "failures", "error": f"/seats/records: unexpected shape {str(rec)[:200]}", "retry_s": None})
        counts = {str(s.get("tokenId")): s.get("failed") or 0 for s in seats if isinstance(s, dict)}
        for t in OURS:
            if t not in counts or (not first and counts[t] <= st["records"].get(t, 0)):
                continue
            time.sleep(0.5 if first else 1)
            s = get(f"/seats/{t}/standing?queue=0")
            self.contract_obs(t, s, "failures")  # the moment a failure landed: probation can start here
            recent = (s.get("standing") or {}).get("recentFailures") or []
            for f in sorted(recent, key=lambda f: f.get("at") or ""):
                job, node, key = f.get("jobId"), f.get("nodeKey"), f"{f.get('jobId')}:{f.get('nodeKey')}:{f.get('at')}"
                if key in seen:
                    continue
                if job not in subs_of:
                    time.sleep(1)
                    try:
                        subs_of[job] = (get(f"/jobs/{job}/submissions") or {}).get("submissions", [])
                    except urllib.error.HTTPError as e:  # purged job or jobId null: record it without submissions
                        if e.code >= 500:
                            raise
                        subs_of[job] = []
                subs = [s for s in subs_of[job] if s.get("nodeKey") == node]
                mine, how = attribute(f, subs, t, used)  # never the newest retry's cause for an older failure
                if mine:
                    used.add(id(mine))
                others = [s for s in subs if (s.get("seat") or {}).get("tokenId") != t]
                usage, reason, summary = mine.get("usage") or {}, f.get("reason") or mine.get("failureReason"), clean(mine.get("summary") or "")[:400]
                pat = pattern_of(reason, summary, usage.get("turns"))
                emit("failures.jsonl", {"token": t, "job": job, "node": node, "at": f.get("at"), "reason": reason, "pattern": pat,
                                        "summary": summary or None, "turns": usage.get("turns"), "runtime": usage.get("runtime"),
                                        "attempt": mine.get("attempt"), "template": self.templates.get(job), "attribution": how,
                                        "failureClass": mine.get("failureClass"), "role": mine.get("role"), "usage": usage_of(mine),
                                        "contract": contract_count(node, mine.get("role"), mine.get("failureClass")) if mine else None,
                                        "others": {"completed": sum(s.get("outcome") == "completed" for s in others),
                                                   "failed": sum(s.get("outcome") == "failed" for s in others), "total": len(others)}})
                ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                p = pats.setdefault(pat, {"first_seen": ts, "last_seen": ts, "count": 0})
                p["last_seen"], p["count"] = ts, p["count"] + 1
                save("patterns.json", pats)
                seen.add(key)
                st["seen"] = (st["seen"] + [key])[-1000:]
                save("failures-state.json", st)  # per failure, so an error mid-cycle never re-emits one
            st["records"][t] = counts[t]
        save("failures-state.json", st)

    def releases(self):
        st = load("releases-state.json", {"seen": []})
        try:
            feed = ET.fromstring(fetch(RELEASES + ".atom", cap=2 << 20))
        except ET.ParseError as e:
            raise ValueError(f"releases.atom: {e}")
        new = []
        for e in feed.findall(ATOM + "entry"):
            url = next((l.get("href") for l in e.findall(ATOM + "link") if l.get("rel") == "alternate"), "") or ""
            tag = url.split("/releases/tag/", 1)[1] if "/releases/tag/" in url else None
            if not tag or tag in st["seen"]:
                continue
            title = (e.findtext(ATOM + "title") or "").strip()
            m = re.search(r"\d+\.\d+\.\d+\+\w+", title)
            new.append({"tag": tag, "version": m.group() if m else title, "published": e.findtext(ATOM + "updated"),
                        "url": url, "notes": notes_text(e.findtext(ATOM + "content") or "")})
        for r in sorted(new, key=lambda r: r["published"] or ""):  # oldest first (the feed is not in date order)
            sha = want = src = None
            try:  # a missing asset (4xx) is permanent: record the release unverified, don't block newer ones
                time.sleep(1)
                sums = fetch(f"{RELEASES}/download/{r['tag']}/SHA256SUMS", cap=1 << 16).decode("utf-8", "replace")
                time.sleep(1)
                tgz = fetch(f"{RELEASES}/download/{r['tag']}/identitymd-worker.tgz")
                sha = hashlib.sha256(tgz).hexdigest()
                want = next((l.split()[0].lower() for l in sums.splitlines()
                             if len(l.split()) == 2 and l.split()[1].lstrip("*") == "identitymd-worker.tgz"), None)
            except urllib.error.HTTPError as e:
                if e.code >= 500:
                    raise
                emit("errors.jsonl", {"task": "releases", "error": f"{r['tag']}: {e}"[:300], "retry_s": None})
            rec = {**r, "sha256": sha, "verified": sha is not None and sha == want, "verifier_forge": None, "strings": None}
            if rec["verified"]:
                try:  # in memory only: never extracted to disk, never run; streamed, stopping at cli.js
                    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r|gz") as tf:
                        for k, m in enumerate(tf, 1):
                            if k > TAR_MEMBERS:
                                raise ValueError(f"no package/dist/cli.js in the first {TAR_MEMBERS} members")
                            if m.size > TAR_MEMBER_CAP:
                                raise ValueError(f"{m.name[:100]} is {m.size} bytes")
                            if m.name == "package/dist/cli.js":
                                if not m.isfile():
                                    raise ValueError("cli.js is not a regular file")
                                src = tf.extractfile(m).read().decode("utf-8", "replace")
                                break
                    if src is None:
                        raise ValueError("no package/dist/cli.js in the tarball")
                except (tarfile.TarError, KeyError, EOFError, zlib.error, OSError, ValueError) as e:  # permanent for this tag
                    emit("errors.jsonl", {"task": "releases", "error": f"{r['tag']}: {e!r}"[:300], "retry_s": None})
            if src is not None:
                forge, rules = FORGE_RE.search(src), rule_strings(src)
                own = f"strings-{r['version']}.json"
                older = sorted((f for f in os.listdir(OUT) if f.startswith("strings-") and f.endswith(".json") and f != own),
                               key=lambda f: os.stat(os.path.join(OUT, f)).st_mtime_ns)
                prev = load(older[-1], []) if older else []
                added, removed = sorted(set(rules) - set(prev)), sorted(set(prev) - set(rules))
                save(own, rules)
                save(f"release-diff-{r['version']}.json", {"version": r["version"], "prev": older[-1][8:-5] if older else None,
                                                           "added": added[:300], "removed": removed[:300]})
                keep_newest("strings-")
                keep_newest("release-diff-")
                rec["verifier_forge"] = forge.group(1) if forge else None
                rec["strings"] = {"added": len(added), "removed": len(removed),
                                  "added_sample": [s[:200] for s in added[:12]], "removed_sample": [s[:200] for s in removed[:12]]}
            emit("releases.jsonl", rec)
            st["seen"].append(r["tag"])
            save("releases-state.json", st)

    def news(self):
        st = load("news-state.json", {})
        v = get("/health").get("version")
        if v != st.get("health_version"):  # first run records the current version with prev null
            emit("news.jsonl", {"kind": "control-plane", "version": v, "prev": st.get("health_version")})
            st["health_version"] = v
            save("news-state.json", st)

    def launch_policies(self):
        d = get("/launch/policies")
        pols = d.get("policies") if isinstance(d, dict) else None
        if (not isinstance(pols, list) or not pols
                or not all(isinstance(p, dict) and isinstance(p.get("version"), int) for p in pols)):
            raise ValueError(f"/launch/policies: unexpected shape {str(pols)[:200]}")
        cur = max(pols, key=lambda p: p["version"])
        st = load("news-state.json", {})
        if cur["version"] != st.get("launch_policy_version"):  # first run records the current version with prev null
            note = ": ".join(str(cur[k]) for k in ("kind", "note") if cur.get(k))
            emit("news.jsonl", {"kind": "launch-policy", "version": cur["version"], "prev": st.get("launch_policy_version"),
                                "note": note[:300] or None})
            st.setdefault("launch_policy", cur)  # the whole object, the first time only
            st["launch_policy_version"] = cur["version"]
            save("news-state.json", st)

    def onchain(self):
        items = loads(fetch(f"https://eth.blockscout.com/api/v2/addresses/{COMMS}/transactions?filter=from",
                                 cap=8 << 20)).get("items") or []
        msgs = [i for i in items if ((i.get("to") or {}).get("hash") or "").lower() == COMMS.lower()]  # newest first
        st = load("news-state.json", {})
        first = "onchain_seen" not in st
        seen = set(st.get("onchain_seen") or [])
        new = [i for i in msgs if i.get("hash") not in seen][:5 if first else None]
        for i in reversed(new):
            raw = i.get("raw_input") or ""
            raw = raw[2:] if raw.startswith("0x") else raw  # not str.removeprefix: that is 3.9+, the README promises 3.8
            at = i.get("timestamp")
            emit("news.jsonl", {"kind": "onchain", "at": at[:19] + "Z" if at else None, "hash": i.get("hash"),
                                "text": bytes.fromhex(raw[:len(raw) // 2 * 2]).decode("utf-8", "replace")[:1500]})
        # the first run shows only the newest 5 but marks the whole page seen
        st["onchain_seen"] = ((st.get("onchain_seen") or []) + [i.get("hash") for i in msgs if i.get("hash") not in seen])[-1000:]
        save("news-state.json", st)

    def payments(self):
        st = load("payments-state.json", None)
        first = st is None  # first run pages back through the history; later runs stop once a page holds nothing new
        seen = set((st or {}).get("seen") or [])
        base = f"https://eth.blockscout.com/api/v2/addresses/{WALLET}/token-transfers?"
        items, params = {}, {}
        for page in range(12):
            if page:
                time.sleep(1)
            # next_page_params repeats filter/token, so merge rather than append twice
            q = urllib.parse.urlencode({"filter": "to", "token": IMD_TOKEN, **params})
            d = loads(fetch(base + q, cap=8 << 20))
            new_here = False
            for i in d.get("items") or []:
                tot = i.get("total") or {}
                if (((i.get("token") or {}).get("address_hash") or "").lower() != IMD_TOKEN.lower()
                        or ((i.get("from") or {}).get("hash") or "").lower() not in PAYERS or tot.get("value") is None
                        or not i.get("transaction_hash") or i["transaction_hash"].lower() in PAYMENTS_EXCLUDE):
                    continue  # another token, not a payer (staking, swaps), an NFT transfer, an excluded tx, or a malformed item
                items[(i.get("transaction_hash"), i.get("log_index"))] = i
                new_here = new_here or i.get("transaction_hash") not in seen
            params = d.get("next_page_params")
            # a payment's transfers can straddle a page, so keep going while this page still holds an unseen one
            if not params or not (first or new_here):
                break
        by_tx = collections.defaultdict(list)
        for (tx, _), i in items.items():
            if tx not in seen:
                by_tx[tx].append(i)
        for tx, its in sorted(by_tx.items(), key=lambda kv: int(kv[1][0].get("block_number") or 0)):  # oldest first
            at = its[0].get("timestamp")
            rec = {"at": at[:19] + "Z" if at else None, "hash": tx, "from": its[0]["from"]["hash"], "token": "IMD",
                   "amount": round(sum(int(i["total"]["value"]) for i in its) / 10 ** decimals(its[0]["total"].get("decimals")), 4),
                   "transfers": len(its), "block": its[0].get("block_number")}
            out = "payments.jsonl"
            if PAYOUT_SENDERS:  # anyone can call a Disperse contract: count the tx only if a known payout sender sent it
                if not re.fullmatch(r"0x[0-9a-fA-F]{64}", tx):
                    raise ValueError(f"payment tx hash {str(tx)[:80]!r}")
                time.sleep(1)
                t = loads(fetch(f"https://eth.blockscout.com/api/v2/transactions/{tx}", cap=1 << 20))
                sender = ((t.get("from") or {}).get("hash") or "").lower()
                if sender not in PAYOUT_SENDERS:
                    out, rec["sender"] = "payments-unattributed.jsonl", sender or None  # kept out of the payment totals
            emit(out, rec)
            seen.add(tx)
            save("payments-state.json", {"seen": sorted(seen)})  # per payment, like failures(): a crash mid-loop never re-emits
        if first and not by_tx:
            save("payments-state.json", {"seen": sorted(seen)})

    def allocations(self):
        st = load("allocations-state.json", None)
        first = st is None  # first run records the whole backlog
        seen = set((st or {}).get("seen") or [])
        rows, before = [], None
        for page in range(5):
            if page:
                time.sleep(1)
            d = get(f"/wallets/{WALLET}/earnings?" + urllib.parse.urlencode({"limit": 200, **({"before": before} if before else {})}))
            if (not isinstance(d, dict) or not isinstance(d.get("earnings"), list)
                    or not all(isinstance(r, dict) for r in d["earnings"])):
                raise ValueError(f"earnings: unexpected shape {str(d)[:200]}")
            rows += d["earnings"]
            before = d.get("next")
            if before is None:
                break
        new = {r["launchId"]: r for r in rows if r.get("launchId") and r["launchId"] not in seen}
        for r in sorted(new.values(), key=lambda r: r.get("at") or ""):  # oldest first
            tok = r.get("token") or {}
            if not isinstance(tok, dict) or not isinstance(r.get("amount"), (str, int)):  # int(None) is a TypeError run() doesn't catch
                raise ValueError(f"earnings row: unexpected shape {str(r)[:200]}")
            emit("allocations.jsonl", {"launchId": r["launchId"], "launchNumber": r.get("launchNumber"), "status": r.get("status"),
                                       "chainId": r.get("chainId"), "kind": r.get("kind"), "symbol": tok.get("symbol"),
                                       "name": tok.get("name"), "tokenAddress": tok.get("address"),
                                       "amount": round(int(r["amount"]) / 10 ** decimals(tok.get("decimals")), 4), "at": r.get("at")})
            seen.add(r["launchId"])
            save("allocations-state.json", {"seen": sorted(seen)})  # per row, like payments(): a crash mid-loop never re-emits
        if first and not new:
            save("allocations-state.json", {"seen": sorted(seen)})

    def api_routes(self):
        """The routes imd.fun/docs documents, diffed against the last visit: the first visit is the baseline (no news),
        later ones emit news kind api-routes with the routes added and removed. Four reads a day; a page with too
        few routes (an error page, a redesign) raises and is retried with backoff, never diffed."""
        page = fetch(DOCS_URL, cap=4 << 20, timeout=40).decode("utf-8", "replace")
        text = html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>", "", page, flags=re.S)))
        # the docs show example links with query strings (/launches?limit=1): the route is the path alone
        routes = sorted({f"{m} {p.split('?', 1)[0]}" for m, p in ROUTE_RE.findall(text) if not ROUTE_SKIP.search(p)})
        if len(routes) < 20:
            raise ValueError(f"imd.fun/docs: only {len(routes)} documented routes found; not diffing")
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        st = load("api-routes.json", None)
        if not isinstance(st, dict) or not isinstance(st.get("routes"), list):
            save("api-routes.json", {"baseline_at": ts, "checked_at": ts, "routes": routes})
            return
        known, cur = set(r for r in st["routes"] if isinstance(r, str)), set(routes)
        added, removed = sorted(cur - known), sorted(known - cur)
        if added or removed:
            emit("news.jsonl", {"kind": "api-routes", "added": added[:60], "removed": removed[:60], "count": len(routes)})
            st["changes"] = (st.get("changes") or [])[-49:] + [{"ts": ts, "added": added, "removed": removed}]
        st.update({"checked_at": ts, "routes": routes})
        save("api-routes.json", st)

    def run(self):
        os.makedirs(OUT, exist_ok=True)
        tasks = [(self.queue, 1800), (self.jobs, 300), (self.presence, 1800), (self.landscape, 3600),
                 (self.failures, 600), (self.releases, 900), (self.news, 900), (self.onchain, 1800),
                 (self.launch_policies, 3600), (self.api_routes, 21600)]
        if WALLET:
            tasks += [(self.payments, 1800), (self.allocations, 21600)]
        else:
            emit("errors.jsonl", {"task": "payments", "error": f"no wallet in {CONFIG}; payments and allocations tasks disabled", "retry_s": 0})
        self.load_schedule(tasks)
        while True:
            for fn, every in tasks:
                now = time.time()  # per task: a long task before this one must not leave it judged by a stale clock
                if now < self.due[fn.__name__]:
                    continue
                try:
                    fn()
                    self.due[fn.__name__] = now + every
                    self.backoff[fn.__name__] = 0
                except Exception as e:  # any surprise backs off; it never crash-loops the unit against the API (Ctrl-C and SystemExit still end it)
                    b = self.backoff[fn.__name__] = min(1800, max(120, self.backoff[fn.__name__] * 2))
                    self.due[fn.__name__] = now + b
                    emit("errors.jsonl", {"task": fn.__name__, "error": str(e)[:300], "retry_s": b})
                save(SCHEDULE, {f.__name__: {"due": self.due[f.__name__], "backoff": self.backoff[f.__name__]} for f, _ in tasks})
            time.sleep(5)

    def load_schedule(self, tasks):
        """Restore each task's due time and backoff from the last run. A due time in the future waits (capped at
        one interval or the 30 min backoff ceiling, whichever is longer); a missing or unreadable file runs every task now."""
        try:
            s = load(SCHEDULE, {})
        except ValueError:
            s = {}
        now = time.time()
        for fn, every in tasks:
            e = s.get(fn.__name__) if isinstance(s, dict) else None
            if not isinstance(e, dict):
                continue
            due, b = e.get("due"), e.get("backoff")
            if isinstance(due, (int, float)) and not isinstance(due, bool) and math.isfinite(due):
                self.due[fn.__name__] = min(float(due), now + max(every, 1800))
            if isinstance(b, int) and not isinstance(b, bool) and 0 <= b <= 1800:
                self.backoff[fn.__name__] = b


if __name__ == "__main__":
    Watch().run()
