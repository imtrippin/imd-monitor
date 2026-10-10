#!/usr/bin/env python3
"""windows/launcher.ps1 refuses an SshHost or Id that starts with '-' (ssh would read it as an option such as
-F or -V) and puts '--' before the ssh destination. Runs a copy of the launcher in a temporary tree with a
synthetic boxes.json; the launcher stops at validation (or at "no boxes to open", since the aliases are not in
~/.ssh/config), so no ssh, tunnel or hub is ever started. Windows only (PowerShell); elsewhere it skips.

Run: python tests/page/test-launcher-hosts.py
"""
import json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / "windows" / "launcher.ps1"
PS = shutil.which("powershell") or shutil.which("pwsh")
if os.name != "nt" or not PS:
    print("skip: needs Windows PowerShell")
    sys.exit(0)

fails = []


def check(name, ok, got=""):
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f"  got: {got!r}"))
    if not ok:
        fails.append(name)


def run(boxes):
    with tempfile.TemporaryDirectory(prefix="launcher-test-") as d:
        win = Path(d) / "windows"; dist = Path(d) / "web" / "dist"
        win.mkdir(); dist.mkdir(parents=True)
        shutil.copy(LAUNCHER, win / "launcher.ps1")
        (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
        (win / "boxes.json").write_text(json.dumps(boxes), encoding="utf-8")
        p = subprocess.run([PS, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(win / "launcher.ps1")],
                           capture_output=True, text=True, timeout=120)
        return p.returncode, p.stdout + p.stderr


def box(**kw):
    b = {"Id": "box1", "Name": "Box 1", "Note": "203.0.113.10", "LocalPort": 18787, "RemotePort": 8787, "SshHost": "fixture-alias-not-in-ssh-config"}
    b.update(kw)
    return [b]


for host in ("-F", "-V", "-oProxyCommand=x"):
    code, out = run(box(SshHost=host))
    check(f"SshHost {host!r} refused at validation", code != 0 and "may not start with '-'" in out, out[-300:])
code, out = run(box(Id="-V"))
check("Id '-V' refused at validation", code != 0 and "may not start with '-'" in out, out[-300:])
code, out = run(box())
check("a plain alias passes validation (stops later: no such Host line)", "may not start with" not in out and "no boxes to open" in out, out[-300:])
src = LAUNCHER.read_text(encoding="utf-8")
check("ssh gets '--' before the destination", re.search(r"'-L',\$fwd,'--',\$b\.SshHost\)", src) is not None)

print(f"\n{len(fails)} FAILED" if fails else "\nall passed")
sys.exit(1 if fails else 0)
