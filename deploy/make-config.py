#!/usr/bin/env python3
"""Turn one box's discovery output (deploy/discover-seats.sh) into the monitor's local config files.

Writes or merges, relative to --repo-root:
  deploy/config-<box-id>.json   the box config: config.example.json's base keys + one workers[] entry per seat
  windows/boxes.json            one entry for this box (an entry with the same Id is replaced)
  watch/watch.json              every token id of this box merged into tokens (order kept, no duplicates)
All three are git-ignored. Nothing is sent anywhere and no box is touched.

  python deploy/make-config.py --box-id box1 --name "Box 1" --ssh-host <admin-alias> --local-port 18787
      --discovery setup/box1.json [--account "codex=Codex · account 1"] [--payments OFF|discovered|0x...]
      [--watcher] [--force] [--dry-run]

Every check runs before anything is written: a refusal (exit 2) leaves all three files as they were.
"""
import argparse, glob, json, os, re, sys
from pathlib import Path

ZERO = "0x" + "0" * 40
DEFAULT_LABELS = {"claude": "Claude · account 1", "codex": "Codex · account 1"}
BASE_KEYS = ("port", "incoming_dir", "db_path", "web_root", "history_days")
WATCH_KEYS = ("watch_dir", "watch_config")
SEAT_NAME = r"[a-z_][a-z0-9_-]{0,31}"   # deploy.sh logs in as the seat: a plain user name, never an ssh option
WALLET_RE = r"0x[0-9a-fA-F]{40}"
PLAIN_NAME = r"[A-Za-z0-9_.-]+"         # what launcher.ps1 accepts for Id and SshHost
HUB_PORT = 18790                        # launcher.ps1's default -HubPort


def refuse(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(2)


def port(text):
    try:
        n = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a number")
    if not 1 <= n <= 65535:
        raise argparse.ArgumentTypeError(f"{n} is outside 1..65535")
    return n


def load(path):
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def parse_args(argv):
    p = argparse.ArgumentParser(description="Write the monitor config files for one box from its discovery output.")
    p.add_argument("--box-id", required=True, help="box id, e.g. box1 (file deploy/config-<id>.json)")
    p.add_argument("--name", help="display name (default: the box id)")
    p.add_argument("--note", default="", help="display-only note shown with the box")
    p.add_argument("--ssh-host", required=True, help="~/.ssh/config alias of the box admin")
    p.add_argument("--local-port", type=port, required=True, help="loopback port of this box's tunnel")
    p.add_argument("--remote-port", type=port, help="backend port on the box, written to both the box config's "
                   "'port' and boxes.json's RemotePort (default: the port already in deploy/config-<id>.json, else 8787)")
    p.add_argument("--allow-port-reuse", action="store_true",
                   help=f"accept a --local-port equal to the hub's {HUB_PORT} or to another box's LocalPort")
    p.add_argument("--discovery", required=True, help="JSON file printed by deploy/discover-seats.sh")
    p.add_argument("--account", action="append", default=[], metavar="RUNTIME=LABEL",
                   help="account label for a runtime (repeatable); seats sharing an account need the same label")
    p.add_argument("--alias-prefix", default="Worker", help="worker alias prefix (default 'Worker')")
    p.add_argument("--watcher", action="store_true", help="this box runs the watcher: add watch_dir/watch_config")
    p.add_argument("--payments", default=None, metavar="OFF|discovered|0xADDRESS",
                   help="payments tracking: OFF (default; writes no wallet), 'discovered' (the wallet the seats "
                        "report) or the NFT holder wallet to track")
    p.add_argument("--repo-root", default=str(Path(__file__).resolve().parent.parent))
    p.add_argument("--force", action="store_true", help="overwrite an existing deploy/config-<id>.json")
    p.add_argument("--dry-run", action="store_true", help="print what would be written, write nothing")
    a = p.parse_args(argv)
    # a leading '-' would reach ssh (and the hub) as an option such as -F or -V: refused here as in the launcher
    if not re.fullmatch(PLAIN_NAME, a.box_id) or a.box_id.startswith("-"):
        p.error("--box-id may contain only letters, digits, '.', '_' and '-', and may not start with '-'")
    if not re.fullmatch(PLAIN_NAME, a.ssh_host) or a.ssh_host.startswith("-"):
        p.error("--ssh-host may contain only letters, digits, '.', '_' and '-', and may not start with '-' "
                "(the launcher refuses anything else)")
    # Name and Note travel in the hub's --box argument on the launcher's command line: quotes are refused
    # there to keep that line simple, and '=' in Name because the hub splits the argument on '='
    for flag, text, bad in (("--name", a.name, "\"'="), ("--note", a.note, "\"'")):
        if text and any(c in text for c in bad):
            p.error(f"{flag} {text!r} contains a quote" + (" or '='" if "=" in bad else "") + "; "
                    "--name and --note may not contain \" or ', nor --name '=' "
                    "(for example Lab box rather than \"Lab's box\")")
    labels = dict(DEFAULT_LABELS)
    a.explicit = set()
    for item in a.account:
        rt, sep, label = item.partition("=")
        if not sep or not rt.strip() or not label.strip():
            p.error(f"--account needs RUNTIME=LABEL, got {item!r}")
        labels[rt.strip()] = label.strip()
        a.explicit.add(rt.strip())
    a.labels = labels
    a.payments_explicit = a.payments is not None
    mode = (a.payments or "off").lower()
    if mode in ("off", "discovered"):
        a.payments = mode
    elif not re.fullmatch(WALLET_RE, a.payments):
        p.error("--payments must be OFF, discovered or a 0x address of 40 hex digits")
    elif a.payments.lower() == ZERO:
        p.error("--payments must not be the zero address (use --payments OFF for no payments tracking)")
    return a


def next_alias_number(deploy_dir, target, keep=()):
    """Highest number at the end of any worker alias in deploy/config*.json (example and target excluded),
    or in the target's aliases that are kept, + 1."""
    high = 0
    for alias in keep:
        m = re.search(r"(\d+)\s*$", str(alias or ""))
        if m:
            high = max(high, int(m.group(1)))
    for path in sorted(glob.glob(os.path.join(deploy_dir, "config*.json"))):
        if os.path.basename(path) == "config.example.json" or os.path.abspath(path) == os.path.abspath(target):
            continue
        try:
            workers = load(path).get("workers") or []
        except (OSError, ValueError, AttributeError):
            print(f"warning: {path}: unreadable, ignored for alias numbering", file=sys.stderr)
            continue
        for w in workers:
            m = re.search(r"(\d+)\s*$", str(w.get("alias") or ""))
            if m:
                high = max(high, int(m.group(1)))
    return high + 1


def build_config(a, root, seats, target):
    example = load(root / "deploy" / "config.example.json")
    cfg = {k: example[k] for k in BASE_KEYS if k in example}
    # a re-run (--force) keeps the alias and the account of every seat already in the file; only new seats
    # get new numbers, and an --account given on this command line still wins for its runtime
    existing, old_port = {}, None
    if target.exists():
        try:
            old = load(target)
            existing = {w.get("seat"): w for w in (old.get("workers") or []) if isinstance(w, dict) and w.get("seat")}
            old_port = old.get("port")
            # every setting that discovery does not derive (retention, heavy_baseline/heavy_since, watcher paths,
            # anything hand-added) survives the re-run; workers are rebuilt below, port is settled below
            cfg.update({k: v for k, v in old.items() if k not in ("workers", "port")})
        except (OSError, ValueError, AttributeError):
            print(f"warning: {target}: unreadable, its aliases, port and settings are not kept", file=sys.stderr)
    # one backend port in both files: the box config's 'port' (where the backend listens) and boxes.json's
    # RemotePort (where the tunnel points). Without --remote-port a re-run keeps the port already in the file.
    if a.remote_port is None:
        a.remote_port = old_port if isinstance(old_port, int) and 1 <= old_port <= 65535 else int(example.get("port", 8787))
    elif old_port is not None and old_port != a.remote_port:
        print(f"note: {target.name} had port {old_port}; now {a.remote_port} in it and in boxes.json's RemotePort. "
              "An installed box keeps its old port until deploy.sh --config pushes this file", file=sys.stderr)
    cfg["port"] = a.remote_port
    kept = [existing[s["user"]].get("alias") for s in seats if s["user"] in existing]
    n = next_alias_number(root / "deploy", target, kept)
    workers = []
    for s in seats:
        old = existing.get(s["user"]) or {}
        alias = old.get("alias") if old.get("alias") else f"{a.alias_prefix} {n:02d}"
        if not old.get("alias"):
            n += 1
        account = a.labels.get(s["runtime"], s["runtime"]) if (s["runtime"] in a.explicit or not old.get("account")) else old["account"]
        workers.append({
            "seat": s["user"],
            "alias": alias,
            "token": int(s["tokenId"]),
            "runtime": s["runtime"],
            "account": account,
        })
    cfg["workers"] = workers
    if a.watcher:
        for k in WATCH_KEYS:  # only fills what the file does not set already (a custom path is kept)
            if cfg.get(k) is None:
                cfg[k] = example.get(k)
    return cfg


def box_line(entry):
    return "{ " + json.dumps(entry, ensure_ascii=True)[1:-1] + " }"


def build_boxes(a, root):
    path = root / "windows" / "boxes.json"
    boxes = load(path) if path.exists() else []
    if not isinstance(boxes, list):
        raise SystemExit(f"{path}: expected a JSON list")
    entry = {"Id": a.box_id, "Name": a.name or a.box_id, "Note": a.note, "LocalPort": a.local_port,
             "RemotePort": a.remote_port, "SshHost": a.ssh_host}
    clashes = ["the hub's default port (launcher -HubPort)"] if a.local_port == HUB_PORT else []
    clashes += [f"box {b.get('Id')!r}'s LocalPort" for b in boxes if b.get("Id") != a.box_id and b.get("LocalPort") == a.local_port]
    for what in clashes:
        if not a.allow_port_reuse:
            refuse(f"--local-port {a.local_port} is {what}; pick another (or pass --allow-port-reuse)")
        print(f"warning: LocalPort {a.local_port} is {what} (--allow-port-reuse)", file=sys.stderr)
    merged = [entry if b.get("Id") == a.box_id else b for b in boxes]
    if not any(b.get("Id") == a.box_id for b in boxes):
        merged.append(entry)
    return "[\n" + ",\n".join("  " + box_line(b) for b in merged) + "\n]\n"


def build_watch(root, seats, payments, explicit):
    path = root / "watch" / "watch.json"
    if path.exists():
        watch = load(path)
    else:
        watch = dict(load(root / "watch" / "watch.example.json"))
        watch.update(tokens=[], queue_probes=[], payments_exclude=[])
        watch.pop("wallet", None)
    tokens = [str(t) for t in watch.get("tokens") or []]
    for s in seats:
        if s["tokenId"] not in tokens:
            tokens.append(s["tokenId"])
    watch["tokens"] = tokens
    if not watch.get("queue_probes") and tokens:  # one probe per runtime: the queue call is the expensive one
        probes, seen = [], set()
        for s in seats:
            if s["runtime"] not in seen:
                seen.add(s["runtime"]); probes.append(s["tokenId"])
        watch["queue_probes"] = probes or [tokens[0]]
    reported = {}
    for s in seats:
        w = s.get("wallet")
        if not w or str(w).lower() == ZERO:
            continue
        if not isinstance(w, str) or not re.fullmatch(WALLET_RE, w):
            print(f"warning: seat {s['user']!r} reports a malformed wallet {w!r}; ignored", file=sys.stderr)
            continue
        reported.setdefault(w.lower(), w)
    wallets = sorted(reported.values(), key=str.lower)
    # payments tracking is opt-in: OFF (the default) writes no wallet, 'discovered' takes the one wallet the
    # seats report, an address is used as given
    if payments == "off":
        wallet, source = None, "--payments OFF" if explicit else "the default"
    elif payments == "discovered":
        if not wallets:
            refuse("--payments discovered: the seats report no wallet; pass the NFT holder wallet as --payments 0x...")
        if len(wallets) > 1:
            refuse(f"--payments discovered: the seats report {len(wallets)} different wallets ({', '.join(wallets)}); "
                   "pass the NFT holder wallet to track as --payments 0x...")
        wallet, source = wallets[0], "reported by the seats"
    else:
        if wallets and payments.lower() not in reported:
            print(f"warning: --payments {payments} differs from the wallet the seats report ({', '.join(wallets)}); "
                  "using --payments", file=sys.stderr)
        wallet, source = payments, "from --payments"
    current = str(watch.get("wallet") or "")
    if current.lower() == ZERO:  # the example's placeholder: never leave it in, the watcher would poll it
        current = ""
    if current and current.lower() != str(wallet or "").lower():
        # never replace or drop a wallet already in watch.json silently: only an explicit OFF or address may
        if not explicit or payments == "discovered":
            refuse(f"watch.json holds wallet {current}; this run would "
                   + (f"use {wallet} ({source})" if wallet else "turn payments tracking off") + ". "
                   f"Pass --payments {current} to keep it, --payments 0x... for another wallet or --payments OFF to turn tracking off")
        print(f"warning: watch.json held wallet {current}; replaced by "
              + (wallet if wallet else "none (payments tracking off)"), file=sys.stderr)
    if wallet:
        watch["wallet"] = wallet
        print(f"wallet for the payments tracker: {wallet} ({source}); check that it is the NFT holder")
    else:
        watch.pop("wallet", None)
        print(f"wallet for the payments tracker: none (payments tracking off, {source}; "
              "--payments discovered or --payments 0x... turns it on)")
    return json.dumps(watch, indent=2, ensure_ascii=False) + "\n"


def usable_seats(discovery):
    seats = []
    for s in discovery.get("seats") or []:
        if not isinstance(s.get("user"), str) or not re.fullmatch(SEAT_NAME, s["user"]):
            raise SystemExit(f"seat user {s.get('user')!r} is not a plain user name ({SEAT_NAME}); refusing the discovery file")
        if not s.get("tokenId") or s.get("runtime") not in ("claude", "codex"):
            print(f"warning: seat {s.get('user')!r} skipped (tokenId {s.get('tokenId')!r}, runtime "
                  f"{s.get('runtime')!r}; needs a paired seat with an installed worker unit)", file=sys.stderr)
            continue
        if not str(s["tokenId"]).isdigit():
            raise SystemExit(f"seat {s.get('user')!r}: tokenId {s['tokenId']!r} is not a number")
        seats.append(dict(s, tokenId=str(s["tokenId"])))
    return seats


def main(argv=None):
    a = parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # labels carry non-ASCII; a Windows console defaults to cp1252
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    root = Path(a.repo_root).resolve()
    seats = usable_seats(load(a.discovery))
    if not seats:
        raise SystemExit(f"{a.discovery}: no usable seats")
    target = root / "deploy" / f"config-{a.box_id}.json"
    if target.exists() and not a.force:
        raise SystemExit(f"{target} exists; pass --force to overwrite it")
    outputs = [
        (target, json.dumps(build_config(a, root, seats, target), indent=2, ensure_ascii=False) + "\n"),
        (root / "windows" / "boxes.json", build_boxes(a, root)),
        (root / "watch" / "watch.json", build_watch(root, seats, a.payments, a.payments_explicit)),
    ]
    for path, text in outputs:
        if a.dry_run:
            print(f"would write {path}:\n{text}")
        else:
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
