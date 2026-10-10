"""Summarize the heavy-work watcher (Git Bash):  python monitor/watch/summarize.py [hours=24]
Reads /var/lib/imd-monitor/watch/*.jsonl over ssh (read-only)."""
import collections, json, os, shutil, subprocess, sys, time

SSH = shutil.which("ssh") or sys.exit("ssh not found on PATH")
OPS = os.environ.get("IMD_OPS") or sys.exit("set IMD_OPS to the ~/.ssh/config alias of the box that runs the watcher")
hours = float(sys.argv[1]) if len(sys.argv) > 1 else 24
since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - hours * 3600))


def load(name):
    out = subprocess.run([SSH, "-o", "BatchMode=yes", OPS, f"sudo cat /var/lib/imd-monitor/watch/{name} 2>/dev/null"],
                         capture_output=True).stdout.decode("utf-8", "replace")
    return [r for r in (json.loads(l) for l in out.splitlines() if l.strip()) if r["ts"] >= since]


heavy = load("heavy.jsonl")
latest = {}
for r in heavy:
    latest[r["job"]] = r  # last observation per job wins
print(f"== last {hours:g} h (since {since}) ==")
print(f"heavy jobs seen: {len(latest)} | touching our seats: {sum(r['ours'] for r in latest.values())}")
by_skill = collections.defaultdict(collections.Counter)
notes = collections.Counter()
for r in latest.values():
    for n in r["nodes"]:
        by_skill[n["key"] and n["key"].rstrip("_0123456789")][n["seat"] or "-"] += 1
        if n.get("note"):
            notes[n["note"]] += 1
for k, c in sorted(by_skill.items(), key=lambda kv: -sum(kv[1].values())):
    print(f"  {k:24s} " + ", ".join(f"{s}:{n}" for s, n in c.most_common(6)))
print("scheduler dispatch notes (unmet requirements):", dict(notes) or "none")
q = load("queue.jsonl")
print(f"queue observations (work waiting): {len(q)}")
for r in q[-8:]:
    print("  ", r["ts"], r["token"], json.dumps(r["queue"])[:200])
p = load("presence.jsonl")
print(f"presence problems: {len(p)}", ", ".join(f"{r['ts'][11:16]} {r['token']}" for r in p[-10:]))
land = load("landscape.jsonl")
if land:
    a, b = land[0], land[-1]
    print(f"landscape: daemons {a['daemons']} -> {b['daemons']} | browser tool {a['tools'].get('browser', 0)} -> {b['tools'].get('browser', 0)}"
          f" | web@1 {a['profiles'].get('none,foundry,web@1', 0)} -> {b['profiles'].get('none,foundry,web@1', 0)}")
e = load("errors.jsonl")
ec = collections.Counter((r.get("task"), (r.get("error") or "")[:60]) for r in e)
print(f"watcher errors in window: {len(e)}", "; ".join(f"{n}x {t}: {m}" for (t, m), n in ec.most_common(4)))
