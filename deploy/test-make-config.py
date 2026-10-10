#!/usr/bin/env python3
"""Tests for deploy/discover-seats.sh and deploy/make-config.py (stdlib unittest, temp-dir fixtures only).

  python deploy/test-make-config.py

The discovery tests need bash (Git Bash on Windows); they are skipped when none is found.
Set IMD_TEST_BASH to pick a bash binary explicitly.
"""
import json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DISCOVER = HERE / "discover-seats.sh"
MAKE = HERE / "make-config.py"
SECRET = "SECRET-DO-NOT-PRINT"
WALLET = "0x" + "ab" * 20


def find_bash():
    if os.environ.get("IMD_TEST_BASH"):
        return os.environ["IMD_TEST_BASH"]
    if os.name == "nt":  # System32\bash.exe is WSL, not a usable bash for these paths
        for p in (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"):
            if os.path.exists(p):
                return p
        return None
    return shutil.which("bash")


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")


UNIT = """[Service]
Environment="IDENTITYMD_HOME=/home/seat-a/.identitymd"
ExecStart="/usr/bin/node" "/home/seat-a/.local/lib/node_modules/@identitymd/worker/dist/cli.js" "start" "--runtime" "codex" "--concurrency" "4" "--auto-update"
"""


def make_fixture(root):
    home = root / "home"
    write(home / "seat-a" / ".identitymd" / "config.json", {
        "deviceKey": "DEVKEY-" + SECRET, "devicePrivateKey": SECRET, "inference": {"note": SECRET},
        "maxConcurrency": 2, "server": "wss://example.invalid", "skillsOptOut": [], "tokenId": "1001",
        "wallet": WALLET})
    write(home / "seat-a" / ".config" / "systemd" / "user" / "identitymd-worker.service", UNIT)
    write(home / "seat-a" / ".identitymd" / "tools.json", [{"id": "browser", "command": "/x"}, {"id": "image"}])
    write(home / "seat-a" / ".local" / "lib" / "node_modules" / "@identitymd" / "worker" / "build.json",
          {"daemonVersion": "0.1.0+abc", "sourceCommit": "abc"})
    write(home / "seat-b" / ".identitymd" / "config.json", {
        "deviceKey": SECRET, "devicePrivateKey": SECRET, "maxConcurrency": 3, "tokenId": 1002, "wallet": WALLET})
    write(home / "plainuser" / ".bashrc", "# not a seat\n")
    write(root / "etc" / "passwd", "root:x:0:0:root:/root:/bin/bash\n"
          "seat-a:x:1001:1001::/home/seat-a:/bin/bash\nseat-b:x:1002:1002::/home/seat-b:/bin/bash\n")


@unittest.skipUnless(find_bash(), "no bash found")
class DiscoverSeats(unittest.TestCase):
    def run_discover(self, root):
        env = dict(os.environ, IMD_DISCOVER_ROOT=str(root), IMD_PYTHON=sys.executable)
        return subprocess.run([find_bash(), str(DISCOVER)], env=env, capture_output=True, text=True,
                              encoding="utf-8", timeout=60)

    def test_fields_and_no_secret(self):
        with tempfile.TemporaryDirectory() as d:
            make_fixture(Path(d))
            r = self.run_discover(d)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertNotIn("SECRET", r.stdout + r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(set(out), {"host", "generated_utc", "seats"})
            self.assertEqual([s["user"] for s in out["seats"]], ["seat-a", "seat-b"])
            a, b = out["seats"]
            self.assertEqual(a, {"user": "seat-a", "tokenId": "1001", "wallet": WALLET, "runtime": "codex",
                                 "concurrency": 4, "tools": ["browser", "image"], "worker": "0.1.0+abc",
                                 "unit": True})
            self.assertEqual(b, {"user": "seat-b", "tokenId": "1002", "wallet": WALLET, "runtime": None,
                                 "concurrency": 3, "tools": [], "worker": None, "unit": False})

    def test_skips_unlisted_and_unsafe_names(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            make_fixture(root)
            # a home with no passwd entry, and one whose name would read as an ssh option
            write(root / "home" / "ghost" / ".identitymd" / "config.json", {"tokenId": "1003", "wallet": WALLET})
            write(root / "home" / "-oProxyCommand=x" / ".identitymd" / "config.json", {"tokenId": "1004"})
            with open(root / "etc" / "passwd", "a", encoding="utf-8") as f:
                f.write("-oProxyCommand=x:x:1004:1004::/home/-oProxyCommand=x:/bin/bash\n")
            r = self.run_discover(d)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual([s["user"] for s in json.loads(r.stdout)["seats"]], ["seat-a", "seat-b"])
            self.assertIn("'ghost': not a passwd user", r.stderr)
            self.assertIn("'-oProxyCommand=x': not a passwd user", r.stderr)

    def test_oversized_file_is_not_parsed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            make_fixture(root)
            write(root / "home" / "seat-a" / ".identitymd" / "tools.json",
                  json.dumps([{"id": "big", "pad": "x" * (1 << 20)}]))
            r = self.run_discover(d)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout)["seats"][0]["tools"], [])

    @unittest.skipUnless(hasattr(os, "O_NOFOLLOW"), "no O_NOFOLLOW on this platform")
    def test_symlinked_config_is_not_followed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            make_fixture(root)
            cfg = root / "home" / "seat-b" / ".identitymd" / "config.json"
            cfg.unlink()
            cfg.symlink_to(root / "home" / "seat-a" / ".identitymd" / "config.json")
            r = self.run_discover(d)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual([s["user"] for s in json.loads(r.stdout)["seats"]], ["seat-a"])
            self.assertIn("seat-b: config.json unreadable", r.stderr)

    def test_root_worker_layout_is_refused_as_unsupported(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            write(root / "etc" / "passwd", "root:x:0:0:root:/root:/bin/bash\n")
            write(root / "root" / ".identitymd" / "config.json", {"tokenId": "1001", "devicePrivateKey": SECRET})
            write(root / "root" / ".config" / "systemd" / "user" / "identitymd-worker.service", UNIT)
            r = self.run_discover(d)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("unsupported layout", r.stderr)
            self.assertIn("one Linux user per seat", r.stderr)
            self.assertNotIn("SECRET", r.stdout + r.stderr)
            self.assertEqual(r.stdout.strip(), "")

    def test_no_seats_is_empty_list(self):
        with tempfile.TemporaryDirectory() as d:
            r = self.run_discover(d)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout)["seats"], [])
            self.assertIn("no seat found", r.stderr)


def discovery(*seats):
    return {"host": "h", "generated_utc": "2026-01-01T00:00:00Z", "seats": [
        {"user": u, "tokenId": t, "wallet": WALLET, "runtime": rt, "concurrency": 4, "tools": [],
         "worker": None, "unit": True} for u, t, rt in seats]}


class MakeConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for rel in ("deploy/config.example.json", "windows/boxes.example.json", "watch/watch.example.json"):
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(REPO / rel, self.root / rel)

    def tearDown(self):
        self.tmp.cleanup()

    def make(self, box, port, disc, *extra):
        f = self.root / f"disc-{box}.json"
        write(f, disc)
        return subprocess.run([sys.executable, str(MAKE), "--box-id", box, "--ssh-host", f"monitor-{box}",
                               "--local-port", str(port), "--discovery", str(f), "--repo-root", str(self.root),
                               *extra], capture_output=True, text=True, encoding="utf-8", timeout=60)

    def read(self, rel):
        return json.loads((self.root / rel).read_text(encoding="utf-8"))

    def test_two_boxes_end_to_end(self):
        r = self.make("box1", 18787, discovery(("seat", "1001", "claude"), ("seat2", "1002", "codex")),
                      "--name", "Box 1", "--watcher", "--account", "codex=Codex · team", "--payments", "discovered")
        self.assertEqual(r.returncode, 0, r.stderr)
        c1 = self.read("deploy/config-box1.json")
        self.assertEqual([(w["seat"], w["alias"], w["token"], w["runtime"], w["account"]) for w in c1["workers"]],
                         [("seat", "Worker 01", 1001, "claude", "Claude · account 1"),
                          ("seat2", "Worker 02", 1002, "codex", "Codex · team")])
        self.assertEqual(c1["port"], 8787)
        self.assertIn("watch_dir", c1)
        self.assertIn("watch_config", c1)
        self.assertFalse(any(k.startswith("_comment") for k in c1))

        r = self.make("box2", 18788, discovery(("seat3", "1003", "codex"), ("seat2dup", "1002", "codex")),
                      "--payments", "discovered")
        self.assertEqual(r.returncode, 0, r.stderr)
        c2 = self.read("deploy/config-box2.json")
        self.assertEqual([w["alias"] for w in c2["workers"]], ["Worker 03", "Worker 04"])
        self.assertNotIn("watch_dir", c2)

        boxes = self.read("windows/boxes.json")
        self.assertEqual([(b["Id"], b["Name"], b["LocalPort"], b["RemotePort"], b["SshHost"]) for b in boxes],
                         [("box1", "Box 1", 18787, 8787, "monitor-box1"), ("box2", "box2", 18788, 8787, "monitor-box2")])

        watch = self.read("watch/watch.json")
        self.assertEqual(watch["tokens"], ["1001", "1002", "1003"])
        self.assertEqual(watch["queue_probes"], ["1001", "1002"])   # one probe per runtime
        self.assertEqual(watch["wallet"], WALLET)
        self.assertEqual(watch["payments_exclude"], [])

        # Rerun box1 with --force and a new name: the boxes.json entry is replaced, not duplicated.
        r = self.make("box1", 18787, discovery(("seat", "1001", "claude")), "--name", "First", "--force",
                      "--payments", WALLET)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([(b["Id"], b["Name"]) for b in self.read("windows/boxes.json")],
                         [("box1", "First"), ("box2", "box2")])
        self.assertEqual(self.read("deploy/config-box1.json")["workers"][0]["alias"], "Worker 01")   # a kept seat keeps its alias

    def test_existing_watch_json_is_merged(self):
        write(self.root / "watch" / "watch.json", {"tokens": ["900"], "queue_probes": ["900"],
                                                   "wallet": "0x" + "cd" * 20, "payments_exclude": ["0x1"]})
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex"), ("seat2", "900", "codex")),
                      "--payments", "0x" + "cd" * 20)
        self.assertEqual(r.returncode, 0, r.stderr)
        watch = self.read("watch/watch.json")
        self.assertEqual(watch["tokens"], ["900", "1001"])
        self.assertEqual(watch["queue_probes"], ["900"])
        self.assertEqual(watch["wallet"], "0x" + "cd" * 20)
        self.assertEqual(watch["payments_exclude"], ["0x1"])

    def test_refuses_overwrite_without_force(self):
        write(self.root / "deploy" / "config-box1.json", {"workers": []})
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--force", r.stderr)
        self.assertEqual(self.read("deploy/config-box1.json"), {"workers": []})

    def test_dry_run_writes_nothing(self):
        disc = discovery(("seat", "1001", "codex"))
        write(self.root / "disc-box1.json", disc)
        before = sorted(p.relative_to(self.root) for p in self.root.rglob("*"))
        r = self.make("box1", 18787, disc, "--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("would write", r.stdout)
        self.assertIn('"Worker 01"', r.stdout)
        after = sorted(p.relative_to(self.root) for p in self.root.rglob("*"))
        self.assertEqual(before, after)

    def test_skips_unpaired_and_unit_less_seats(self):
        disc = discovery(("seat", "1001", "codex"))
        disc["seats"] += [{"user": "fresh", "tokenId": None, "runtime": "codex"},
                          {"user": "nounit", "tokenId": "1009", "runtime": None}]
        r = self.make("box1", 18787, disc)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([w["seat"] for w in self.read("deploy/config-box1.json")["workers"]], ["seat"])
        self.assertIn("'fresh' skipped", r.stderr)
        self.assertEqual(self.read("watch/watch.json")["tokens"], ["1001"])

    def test_force_keeps_existing_aliases_and_numbers_new_seats(self):
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex"), ("seat2", "1002", "codex")))
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.make("box2", 18788, discovery(("seat6", "1006", "codex")))
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex"), ("seat2", "1002", "codex"), ("seat3", "1003", "claude")), "--force")
        self.assertEqual(r.returncode, 0, r.stderr)
        ws = {w["seat"]: w for w in self.read("deploy/config-box1.json")["workers"]}
        self.assertEqual((ws["seat"]["alias"], ws["seat2"]["alias"]), ("Worker 01", "Worker 02"))
        self.assertEqual(ws["seat3"]["alias"], "Worker 04")   # after box2's Worker 03
        self.assertEqual(self.read("watch/watch.json")["tokens"], ["1001", "1002", "1006", "1003"])

    def test_force_keeps_settings_discovery_does_not_derive(self):
        baseline = [{"seat": "1001", "key": "fixture/step/1", "accepted": True, "job": "fixture-job"}]
        write(self.root / "deploy" / "config-box1.json", {
            "port": 8787, "history_days": 7, "heavy_since": "2026-01-01", "heavy_baseline": baseline,
            "watch_dir": "/srv/fixture/watch", "watch_config": "/srv/fixture/watch.json", "extra_setting": {"x": 1},
            "workers": [{"seat": "seat", "alias": "Worker 01", "token": 1001, "runtime": "codex", "account": "Codex · team"}]})
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex"), ("seat2", "1002", "codex")), "--force")
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.read("deploy/config-box1.json")
        self.assertEqual((c["history_days"], c["heavy_since"], c["heavy_baseline"], c["extra_setting"]),
                         (7, "2026-01-01", baseline, {"x": 1}))
        self.assertEqual((c["watch_dir"], c["watch_config"]), ("/srv/fixture/watch", "/srv/fixture/watch.json"))
        self.assertEqual([(w["seat"], w["alias"], w["account"]) for w in c["workers"]],
                         [("seat", "Worker 01", "Codex · team"), ("seat2", "Worker 02", "Codex · account 1")])
        # --watcher fills only missing watcher paths; explicit options still win over the file
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--force", "--watcher", "--remote-port", "8788")
        self.assertEqual(r.returncode, 0, r.stderr)
        c = self.read("deploy/config-box1.json")
        self.assertEqual((c["watch_dir"], c["watch_config"], c["port"], c["history_days"]),
                         ("/srv/fixture/watch", "/srv/fixture/watch.json", 8788, 7))
        self.assertEqual([w["seat"] for w in c["workers"]], ["seat"])   # workers come from discovery

    def test_leading_dash_host_or_box_id_refused(self):
        disc = discovery(("seat", "1001", "codex"))
        for extra in (("--ssh-host=-F",), ("--ssh-host=-V",), ("--box-id=-V",)):
            r = self.make("box1", 18787, disc, *extra)
            self.assertEqual(r.returncode, 2, extra)
            self.assertIn("may not start with '-'", r.stderr, extra)
        self.assertFalse((self.root / "deploy" / "config-box1.json").exists())
        self.assertFalse((self.root / "windows" / "boxes.json").exists())

    def test_payments_off_by_default(self):
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("wallet", self.read("watch/watch.json"))
        self.assertIn("payments tracking off", r.stdout)
        # OFF also removes the example's zero placeholder from an existing watch.json
        write(self.root / "watch" / "watch.json", {"tokens": [], "queue_probes": [], "wallet": "0x" + "0" * 40})
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--force")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("wallet", self.read("watch/watch.json"))

    def test_payments_address_wins_and_zero_refused(self):
        other = "0x" + "cd" * 20
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--payments", other)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("watch/watch.json")["wallet"], other)
        self.assertIn("differs from the wallet the seats report", r.stderr)
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--payments", "0x" + "0" * 40, "--force")
        self.assertEqual(r.returncode, 2)
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--payments", "maybe", "--force")
        self.assertEqual(r.returncode, 2)

    def test_payments_discovered_needs_one_reported_wallet(self):
        disc = discovery(("seat", "1001", "codex"))
        for s in disc["seats"]:
            s["wallet"] = None
        r = self.make("box1", 18787, disc, "--payments", "discovered")
        self.assertEqual(r.returncode, 2)
        self.assertIn("report no wallet", r.stderr)
        self.assertFalse((self.root / "deploy" / "config-box1.json").exists())
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--payments", "discovered")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("watch/watch.json")["wallet"], WALLET)
        self.assertIn(f"wallet for the payments tracker: {WALLET} (reported by the seats)", r.stdout)

    def test_existing_wallet_is_never_changed_silently(self):
        held = "0x" + "cd" * 20
        write(self.root / "watch" / "watch.json", {"tokens": ["900"], "queue_probes": ["900"], "wallet": held})
        for extra in ((), ("--payments", "discovered")):   # default OFF, and a discovered wallet that differs
            r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), *extra)
            self.assertEqual(r.returncode, 2, extra)
            self.assertIn(held, r.stderr)
            self.assertIn(f"--payments {held} to keep it", r.stderr)
            self.assertFalse((self.root / "deploy" / "config-box1.json").exists())
            self.assertEqual(self.read("watch/watch.json")["wallet"], held)
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--payments", held)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("watch/watch.json")["wallet"], held)
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--payments", "OFF", "--force")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"held wallet {held}", r.stderr)
        self.assertNotIn("wallet", self.read("watch/watch.json"))

    def test_remote_port_in_both_files(self):
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--remote-port", "9898")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("deploy/config-box1.json")["port"], 9898)
        self.assertEqual(self.read("windows/boxes.json")[0]["RemotePort"], 9898)
        # a --force re-run without --remote-port keeps the file's port, in both files
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--force")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("deploy/config-box1.json")["port"], 9898)
        self.assertEqual(self.read("windows/boxes.json")[0]["RemotePort"], 9898)
        # a different --remote-port changes both and says so
        r = self.make("box1", 18787, discovery(("seat", "1001", "codex")), "--force", "--remote-port", "8787")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("had port 9898", r.stderr)
        self.assertEqual(self.read("deploy/config-box1.json")["port"], 8787)
        self.assertEqual(self.read("windows/boxes.json")[0]["RemotePort"], 8787)

    def test_invalid_ports_and_quoted_names_refused(self):
        disc = discovery(("seat", "1001", "codex"))
        for extra in (("--remote-port", "70000"), ("--remote-port", "0"), ("--name", "Lab's box"),
                      ("--note", 'say "hi"'), ("--name", "a=b"), ("--ssh-host", "-oProxyCommand=x")):
            r = self.make("box1", 18787, disc, *extra)
            self.assertEqual(r.returncode, 2, extra)
            self.assertFalse((self.root / "deploy" / "config-box1.json").exists(), extra)
        self.assertIn("contains a quote", self.make("box1", 18787, disc, "--name", "Lab's box").stderr)
        for bad in ("70000", "0", "x"):
            self.assertEqual(self.make("box1", bad, disc).returncode, 2, bad)
        self.assertFalse((self.root / "windows" / "boxes.json").exists())

    def test_hub_and_duplicate_local_ports_refused(self):
        disc = discovery(("seat", "1001", "claude"), ("seat2", "1002", "codex"), ("seat3", "1003", "codex"))
        r = self.make("box1", 18790, disc)
        self.assertEqual(r.returncode, 2)
        self.assertIn("hub's default port", r.stderr)
        self.assertFalse((self.root / "deploy" / "config-box1.json").exists())
        self.assertFalse((self.root / "windows" / "boxes.json").exists())
        r = self.make("box1", 18787, disc)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("watch/watch.json")["queue_probes"], ["1001", "1002"])   # one probe per runtime
        r = self.make("box2", 18787, discovery(("seat6", "1006", "codex")))
        self.assertEqual(r.returncode, 2)
        self.assertIn("box 'box1'", r.stderr)
        self.assertFalse((self.root / "deploy" / "config-box2.json").exists())
        r = self.make("box2", 18787, discovery(("seat6", "1006", "codex")), "--allow-port-reuse")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("--allow-port-reuse", r.stderr)

    def test_rejects_unsafe_seat_user(self):
        for bad in ("-oProxyCommand=x", "Seat", "seat a", "a" * 33, ""):
            r = self.make("box1", 18787, discovery(("seat", "1001", "codex"), (bad, "1002", "codex")))
            self.assertNotEqual(r.returncode, 0, bad)
            self.assertIn("not a plain user name", r.stderr)
            self.assertFalse((self.root / "deploy" / "config-box1.json").exists())

    def test_disagreeing_wallets_need_an_address(self):
        other = "0x" + "cd" * 20
        disc = discovery(("seat", "1001", "codex"), ("seat2", "1002", "codex"))
        disc["seats"][1]["wallet"] = other
        r = self.make("box1", 18787, disc, "--payments", "discovered")
        self.assertEqual(r.returncode, 2)
        self.assertIn("2 different wallets", r.stderr)
        self.assertFalse((self.root / "watch" / "watch.json").exists())
        r = self.make("box1", 18787, disc, "--payments", other)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read("watch/watch.json")["wallet"], other)
        self.assertIn(f"wallet for the payments tracker: {other} (from --payments)", r.stdout)

    def test_malformed_seat_wallet_is_ignored(self):
        disc = discovery(("seat", "1001", "codex"), ("seat2", "1002", "codex"))
        disc["seats"][1]["wallet"] = "0xnot-a-wallet"
        r = self.make("box1", 18787, disc, "--payments", "discovered")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("malformed wallet", r.stderr)
        self.assertEqual(self.read("watch/watch.json")["wallet"], WALLET)
        self.assertIn(f"wallet for the payments tracker: {WALLET} (reported by the seats)", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
