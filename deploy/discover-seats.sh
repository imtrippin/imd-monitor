#!/usr/bin/env bash
# Discover the IMD worker seats on ONE box and print them as one JSON document on stdout.
# Read-only: it reads files, never starts, stops, pairs or reconfigures a worker.
# Seat homes are 0750, so run it as root on the box, e.g. from the workstation:
#   ssh <admin-alias> 'sudo bash -s' < deploy/discover-seats.sh > setup/<box-id>.json
# then feed the file to deploy/make-config.py --discovery setup/<box-id>.json.
# A seat = a user listed in /etc/passwd, named like ^[a-z_][a-z0-9_-]{0,31}$, with
# /home/<user>/.identitymd/config.json. From that file only tokenId, wallet and maxConcurrency are read;
# the device keys and every other field are never printed. Each seat file is read only when it is a
# regular file (not a symlink) of at most 1 MiB.
# Output: {"host", "generated_utc", "seats": [{"user", "tokenId", "wallet", "runtime", "concurrency",
#          "tools", "worker", "unit"}]}   (setup/*.json is git-ignored: it carries token ids and a wallet)
# Env: IMD_DISCOVER_ROOT  filesystem root to search (default /; for tests)
#      IMD_PYTHON         python interpreter (default: python3, else python)
set -euo pipefail

PY="${IMD_PYTHON:-}"
if [[ -z "$PY" ]]; then
  for p in python3 python; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import json' </dev/null >/dev/null 2>&1; then PY="$p"; break; fi
  done
fi
[[ -n "$PY" ]] || { echo "discover-seats: python3 not found" >&2; exit 1; }

IFS= read -r -d '' PROG <<'PYEOF' || true
import datetime, glob, json, os, re, shlex, socket, stat, sys

root = os.environ.get("IMD_DISCOVER_ROOT") or "/"
MAX_BYTES = 1 << 20  # 1 MiB: no seat file the monitor reads is anywhere near this
SEAT_NAME = re.compile(r"[a-z_][a-z0-9_-]{0,31}")

def read_bytes(path):
    """The file's bytes, or None unless it is a regular file of at most MAX_BYTES. The seat owns these
    files and this runs as root: the last path component is not followed when it is a symlink (O_NOFOLLOW
    where the platform has it), and O_NONBLOCK keeps a FIFO from hanging the open."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_BYTES:
            return None
        chunks, total = [], 0
        while total <= MAX_BYTES:
            b = os.read(fd, 65536)
            if not b:
                break
            chunks.append(b); total += len(b)
        return b"".join(chunks) if total <= MAX_BYTES else None
    except OSError:
        return None
    finally:
        os.close(fd)

def load(path):
    data = read_bytes(path)
    if data is None:
        return None
    try:
        return json.loads(data.decode("utf-8-sig"))
    except ValueError:
        return None

def passwd_users():
    """User names in <root>/etc/passwd (the seats are local users made by add-seat.sh)."""
    data = read_bytes(os.path.join(root, "etc", "passwd"))
    if data is None:
        return set()
    return {line.split(":", 1)[0] for line in data.decode("utf-8", "replace").splitlines() if ":" in line}

def unit_args(path):
    """runtime and concurrency from the unit's ExecStart (None when absent)."""
    data = read_bytes(path)
    if data is None:
        return None, None
    try:
        lines = data.decode("utf-8").splitlines()
    except ValueError:
        return None, None
    for line in lines:
        if not line.strip().startswith("ExecStart="):
            continue
        try:
            args = shlex.split(line.split("=", 1)[1])
        except ValueError:
            return None, None
        runtime = concurrency = None
        for i, a in enumerate(args):
            nxt = args[i + 1] if i + 1 < len(args) else None
            if a == "--runtime":
                runtime = nxt
            elif a.startswith("--runtime="):
                runtime = a.split("=", 1)[1]
            elif a == "--concurrency":
                concurrency = nxt
            elif a.startswith("--concurrency="):
                concurrency = a.split("=", 1)[1]
        try:
            concurrency = int(concurrency) if concurrency is not None else None
        except ValueError:
            concurrency = None
        return runtime, concurrency
    return None, None

seats = []
users = passwd_users()
cfg_paths = sorted(glob.glob(os.path.join(root, "home", "*", ".identitymd", "config.json")))
# a worker set up under root (one global install, /root/.identitymd) is a layout the monitor does not support:
# say so plainly instead of "no seat found". Only the file's existence is checked; it is never opened.
if not cfg_paths and os.path.lexists(os.path.join(root, "root", ".identitymd", "config.json")):
    print("discover-seats: unsupported layout: the IMD worker on this box runs as root (/root/.identitymd), "
          "not as one Linux user per seat. The monitor expects each seat to be its own user with "
          "/home/<seat>/.identitymd and the systemd user unit identitymd-worker; it cannot monitor this box "
          "as it is set up. Nothing was changed.", file=sys.stderr)
    sys.exit(3)
for cfg_path in cfg_paths:
    home = os.path.dirname(os.path.dirname(cfg_path))
    user = os.path.basename(home)
    # the name becomes an ssh login on the workstation (deploy.sh): only plain passwd user names pass
    if not SEAT_NAME.fullmatch(user) or user not in users:
        print(f"discover-seats: {user!r}: not a passwd user with a plain name, skipped", file=sys.stderr)
        continue
    cfg = load(cfg_path)
    if not isinstance(cfg, dict):
        print(f"discover-seats: {user}: config.json unreadable, skipped", file=sys.stderr)
        continue
    # Pick the listed keys explicitly; the rest of config.json (device keys included) is never touched.
    token = cfg.get("tokenId")
    wallet = cfg.get("wallet")
    max_conc = cfg.get("maxConcurrency")
    unit = os.path.join(home, ".config", "systemd", "user", "identitymd-worker.service")
    has_unit = os.path.isfile(unit)
    runtime, concurrency = unit_args(unit) if has_unit else (None, None)
    if concurrency is None and isinstance(max_conc, int) and not isinstance(max_conc, bool):
        concurrency = max_conc
    tools = load(os.path.join(home, ".identitymd", "tools.json"))
    tool_ids = [t["id"] for t in tools if isinstance(t, dict) and isinstance(t.get("id"), str)] if isinstance(tools, list) else []
    build = load(os.path.join(home, ".local", "lib", "node_modules", "@identitymd", "worker", "build.json"))
    worker = build.get("daemonVersion") if isinstance(build, dict) else None
    seats.append({
        "user": user,
        "tokenId": str(token) if token is not None else None,
        "wallet": wallet if isinstance(wallet, str) else None,
        "runtime": runtime,
        "concurrency": concurrency,
        "tools": tool_ids,
        "worker": worker if isinstance(worker, str) else None,
        "unit": has_unit,
    })

seats.sort(key=lambda s: s["user"])
if not seats:
    print(f"discover-seats: no seat found (no {os.path.join(root, 'home', '*', '.identitymd', 'config.json')}); "
          "run it as root on a worker box", file=sys.stderr)
for s in seats:
    if s["tokenId"] is None:
        print(f"discover-seats: {s['user']}: no tokenId (not paired yet)", file=sys.stderr)
print(json.dumps({
    "host": socket.gethostname(),
    "generated_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "seats": seats,
}, indent=2))
PYEOF

"$PY" -c "$PROG" </dev/null
