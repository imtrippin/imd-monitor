# Setting up the IMD Worker Monitor: runbook for a coding agent

An operator has asked you (Claude Code, Codex or another coding agent) to install this monitor for
their own fleet of IdentityMD (IMD) worker seats. Read `README.md` first; it describes the system.
This file is the procedure. Follow it in order and stop where it says to ask.

**Supported layouts.** Boxes: Linux with systemd, one Linux user per seat running the worker as
the systemd user unit `identitymd-worker`. Workstation: Windows gets the managed launcher and
Desktop shortcuts; on macOS or Linux the operator opens the SSH tunnels and runs the hub by hand
(step 7). If a box does not match (no systemd, seats not one Linux user each), stop and tell the
operator before changing anything on it.

**Works with:** Linux/systemd boxes whose seats are separate Linux users, reached over SSH; a
Windows workstation for the launcher. Not workers on a Mac or a Windows desktop, and not the
root-on-a-VPS layout (the worker running as root from `/root/.identitymd`): discovery exits non-zero
with an "unsupported layout" message there. Report it to the operator; do not move or reconfigure the
worker to make it fit.

## 1. What this is, and the rules

The monitor is **observe-only**: per-seat collector timers, one backend per box (user `imdmon`,
`127.0.0.1:8787`), an optional watcher on one box, and a hub on the workstation that merges the
boxes into one page. Nothing in it controls a worker, and nothing you do may either.

- Never start, stop, restart, pair, unlink, update or reconfigure a worker (`identitymd-worker`
  user units, the `imd` CLI). Never edit `~/.identitymd/tools.json` or `~/.identitymd/tools.env`.
- Never read, print or copy `~/.identitymd/config.json` or any key: it holds the device's private
  key. Use `deploy/discover-seats.sh`, which prints only the user, tokenId, wallet, runtime,
  concurrency, tools, worker version and whether the worker unit exists, per seat.
- Never commit the real config files: `deploy/config-*.json`, `windows/boxes.json`,
  `watch/watch.json` and the discovery output in `setup/`. They are fleet-specific.
- Never reboot a box, change its packages, firewall or users, or enable linger, without the
  operator's explicit go.
- Ask before running any command that is not in this runbook.
- Placeholders below: `<admin-alias>` is the `~/.ssh/config` alias of a box's admin user (the one
  with passwordless sudo), `<id>` a short box id such as `box1`, `<seat>` a seat's Linux user.

## 2. Inputs to collect from the operator first

Ask for all of these in one message, then wait:

- [ ] For each box: the admin alias and a short id (`box1`, `box2`, ...). Defaults when the operator
      gives nothing else: display name `Box N` from the id, an empty note (it is display only, for
      example the IP). Report the defaults you used in step 8.
- [ ] Do the seat users accept the same SSH key as the admin user (so `<seat>@<admin-alias>`
      logs in)? If not, the SSH alias of every seat user.
- [ ] Which one box runs the watcher.
- [ ] The account label for each provider account (for example `Claude · account 1`,
      `Codex · account 1`) and which seats share one. Seats on one account, on any box, must get
      the exact same string.
- [ ] Do they want reward payments tracked? It is off unless they say so. The answer becomes
      `--payments` in step 4, the same value on every box: `OFF` (the default; no wallet is
      written), `discovered` (the NFT holder wallet the seats report; the generator refuses when
      the seats report none or disagree) or the wallet address itself. With a wallet, the watcher
      queries blockscout for transfers into it.
- [ ] Local tunnel ports, if `18787` and up are taken. Default: one per box from `18787`, skipping
      `18790` (the hub): `18787, 18788, 18789, 18791, ...`. Every port must be in `1..65535`, and the
      generator refuses the hub's `18790` and a port another box already uses.
- [ ] The backend port on the boxes, only if `8787` is taken there (`--remote-port`; it goes into
      both the box config and `windows/boxes.json`).
- [ ] Display names and notes contain no quote characters (`"` or `'`), and names no `=`:
      the generator refuses them (they go on the launcher's command line to the hub).
- [ ] For each Claude account: which one seat runs the allowance probe. The probe is a real
      provider request (a one-line `claude -p`, about four an hour) that spends a little of that
      account's allowance. Only listed seats probe; when the operator names no seat, no probe runs
      and the Claude account tile shows no allowance (say so in step 8). Codex allowance is read
      from local files and needs no probe.

## 3. Prerequisite checks

Run these per box and report each result. Stop and tell the operator about any failure.

| Check | Command | Pass |
|---|---|---|
| admin SSH | `ssh -o BatchMode=yes <admin-alias> 'id -un'` | prints the admin user, no prompt |
| sudo | `ssh -o BatchMode=yes <admin-alias> 'sudo -n true && echo ok'` | `ok` |
| Node | `ssh -o BatchMode=yes <admin-alias> '/usr/bin/node --version'` | `v22.5.0` or newer |
| Python | `ssh -o BatchMode=yes <admin-alias> 'python3 --version'` | `3.8` or newer |
| curl, systemd | `ssh -o BatchMode=yes <admin-alias> 'command -v curl systemctl journalctl'` | three paths |
| persistent journal | `ssh -o BatchMode=yes <admin-alias> 'test -d /var/log/journal && echo persistent'` | `persistent` |
| linger, per seat | `ssh -o BatchMode=yes <admin-alias> "if test -f /var/lib/systemd/linger/<seat>; then echo Linger=yes; else echo Linger=no; fi"` | `Linger=yes` |
| seat SSH, per seat | `ssh -o BatchMode=yes <seat>@<admin-alias> 'id -un'` (or the seat's own alias) | prints `<seat>` |

Run the linger and seat checks after discovery (step 4) gives you the seat names. If linger is off,
ask the operator before running `ssh <admin-alias> 'sudo loginctl enable-linger <seat>'`.

On the workstation: `node --version` and `npm --version` must both answer, and Python `3.8` or
newer must run `deploy/make-config.py` (`python --version`, `python3 --version` or `py -3 --version`
on Windows); deploys need a POSIX
shell (Git Bash on Windows). In Git Bash, if the keys live in the Windows ssh-agent, export
`IMD_SSH=/c/Windows/System32/OpenSSH/ssh.exe` and `IMD_SCP=/c/Windows/System32/OpenSSH/scp.exe`
for every `deploy.sh` run, and use that `ssh.exe` for the commands in this file too.

## 4. Discovery and config generation

Run this step for EVERY box before step 6 (the watcher needs every token). Per box, from the
repo root (`python3` is `python` or `py -3` on Windows):

```bash
mkdir -p setup
ssh -o BatchMode=yes <admin-alias> 'sudo bash -s' < deploy/discover-seats.sh > setup/<id>.json
```

Check that `setup/<id>.json` lists the seats you expected. Then generate the config, one call per
box (`--watcher` only on the watcher box; `--account` once per runtime on that box):

```bash
python3 deploy/make-config.py --box-id <id> --name "Box 1" --note "<note>" \
  --ssh-host <admin-alias> --local-port 18787 --remote-port 8787 \
  --discovery setup/<id>.json \
  --account "claude=Claude · account 1" --account "codex=Codex · account 1" \
  --payments OFF [--watcher] --dry-run
```

`--payments` takes the operator's answer from step 2: `OFF`, `discovered` or the wallet address.
Run it with `--dry-run` first and show the operator the output; then run it again without
`--dry-run`. It writes `deploy/config-<id>.json`, merges the box into `windows/boxes.json` and its
tokens into `watch/watch.json`, and prints what it wrote. It writes a wallet into
`watch/watch.json` only when `--payments` names one (an address, or `discovered`), never a zero
address, and prints the wallet it chose. When `watch/watch.json` already holds a different wallet
than this run would write, it prints both and refuses if `--payments` was left out or is
`discovered`; only an address or an explicit `--payments OFF` replaces it: stop and ask the
operator which one. An address that differs from the seats' own
wallet is used with a warning: show it to the operator. `--remote-port` is written into both the box
config's `port` and the box's `RemotePort`; a `--force` run without it keeps the port already in
`deploy/config-<id>.json`. It refuses to overwrite an existing
`deploy/config-<id>.json` unless you add `--force`; with `--force` it keeps the alias and account of
every seat already in that file, numbers only new seats, and keeps every other setting in the file
(`history_days`, `heavy_since`, `heavy_baseline`, `watch_dir`, `watch_config`, hand-added keys); only
the workers list is rebuilt from discovery, and an option given on the command line still wins. Give each box its own `--local-port`:
the generator refuses a port outside `1..65535`, the hub's 18790, another box's port and a name or
note with a quote character (or a name with `=`), with exit code 2 and nothing written. If two seats of the same runtime on one box use
different accounts, set their `account` fields in `deploy/config-<id>.json` by hand. A line
`warning: seat ... skipped` means a seat without a token or without a worker unit: report it to the
operator and add it by hand only with their answer.

**The operator reviews the generated files before anything is deployed.** Ask them to confirm
`deploy/config-<id>.json` (seat, alias, token, runtime, account), `windows/boxes.json` and
`watch/watch.json` (every token on every box, the wallet).

## 5. Build and deploy, per box

Once, on the workstation: `cd web && npm ci && npm run build && cd ..`

**Choose the Claude probe seat BEFORE deploying.** The collector runs the Claude allowance probe
only for seats listed in `/opt/imd-monitor/live-probe/`; `install-server.sh` creates that
directory empty (and keeps an existing one), and `install-collector.sh` starts the first allowance
run right away. So, for a box with the operator's chosen probe seat from step 2, list it before
running `deploy.sh` for that box:

```bash
ssh <admin-alias> 'sudo mkdir -p /opt/imd-monitor/live-probe && sudo touch /opt/imd-monitor/live-probe/<seat>'
```

Each listed seat makes a real provider request about every 15 minutes. Without a listed seat no
probe runs and that Claude account shows no allowance. A seat listed later starts probing at its
next 5-minute allowance run; no restart is needed.

Then per box, from the repo root (add `IMD_SEATS="<seat-alias> ..."` if the seat users do not
accept `<seat>@<admin-alias>`):

```bash
IMD_OPS=<admin-alias> IMD_CFG=config-<id>.json bash deploy/deploy.sh --build
```

Verify, and report each result:

- The script ends with `health (port <port>):` followed by `{"ok":true,...,"workers":N,...}`, where
  N is the number of seats in the config, and an `incoming:` listing.
- `ssh <admin-alias> 'curl -s http://127.0.0.1:<port>/api/health'` answers the same. `<port>` is the `port` in `deploy/config-<id>.json`: 8787 unless `--remote-port` was given.
- `ssh <admin-alias> 'systemctl is-active imd-monitor.service'` prints `active`.
- Within a minute `ssh <admin-alias> 'sudo ls -l /var/lib/imd-monitor/incoming'` shows a
  `<seat>.json` for every seat. A missing one: run, as that seat,
  `ssh <seat>@<admin-alias> 'systemctl --user status imd-monitor-collect.service'` and report it.

- `ssh <admin-alias> 'ls /opt/imd-monitor/live-probe'` lists exactly the probe seats the operator
  chose for this box (nothing when they chose none).

## 6. The watcher, on one box

After that box's backend is installed (the script needs the `imdmon` user):

```bash
ssh <admin-alias> 'mkdir -p ~/watch-stage'
scp watch/imd_watch.py watch/imd-watch.service watch/install-watch.sh watch/watch.json <admin-alias>:watch-stage/   # Windows: /c/Windows/System32/OpenSSH/scp.exe
ssh <admin-alias> 'sudo bash ~/watch-stage/install-watch.sh ~/watch-stage'
```

The script ends by printing `active` and two matching md5 prefixes. Check again with
`ssh <admin-alias> 'systemctl is-active imd-watch.service'`.

After about ten minutes, `ssh <admin-alias> 'sudo ls -l /var/lib/imd-monitor/watch'` should show
`landscape.jsonl`, `releases.jsonl`, `news.jsonl` and several `*-state.json` files.
`heavy.jsonl`, `queue.jsonl`, `failures.jsonl` and `payments.jsonl` appear only when there is
something to record. Read `errors.jsonl` if it exists: without a wallet it holds one line saying
payments are disabled (expected); repeated other errors mean a task is backing off.
`ssh <admin-alias> 'curl -s http://127.0.0.1:<port>/api/watch'` (the box's configured port) should no longer answer
`{"enabled":false}`.

## 7. The workstation

`windows/boxes.json` was written in step 4. On Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File windows\install-shortcut.ps1
```

This creates the **IMD Worker Monitor** and **Stop IMD Worker Monitor** Desktop shortcuts. Add
`-Visible` for a console window instead of the silent launcher, `-AtLogon` to also start it at
sign-in (ask the operator). A box whose `SshHost` has no literal `Host` line in `~/.ssh/config`
itself is skipped (aliases that come only from an `Include` file or a wildcard pattern are not
recognised). Open the first shortcut; the page is at `http://127.0.0.1:18790/` (the launcher's
`-HubPort` moves it). Problems land in `windows\launcher.log` and `windows\logs\`.

On macOS or Linux, open one tunnel per box by hand (its `LocalPort` from `windows/boxes.json`;
the line below is box 1, repeat it per box), then run the hub with one `--box` per box:

```bash
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:18787:127.0.0.1:8787 <admin-alias> &
node windows/hub.js --box box1=18787="Box 1" --box box2=18788="Box 2"
```

Verify without a browser: `curl -s http://127.0.0.1:18790/api/health` lists every box, and
`curl -s http://127.0.0.1:18790/api/state` carries every seat under its box. The operator checks the
Agents view in the browser. The Network and News views need the watcher.

## 8. Final report to the operator

End with a short report, nothing invented:

- Per box: what was installed (backend, collector timers on which seats, watcher or not, probe
  seat or "no probe"), and the results of the step 5 and step 6 checks.
- Payments tracking: off, or the wallet it tracks.
- The workstation: shortcuts created or hub command used, the page URL, whether every box answered.
- What was not done or not verified, and why (a failed check, a missing answer, a step the operator
  declined), and what is left for them to do.
- A reminder that `deploy/config-*.json`, `windows/boxes.json`, `watch/watch.json` and `setup/`
  are fleet-specific and must not be committed or shared, and that screenshots need redacting.
- A reminder that loopback is not isolation: every local user on a box, agent jobs included, can
  read that box's dashboard data, and every local user on the workstation can read the hub.

## 9. Later

**Add a box.** Steps 3 to 5 for it, with a new `--box-id` and `--local-port`. `make-config.py`
adds its tokens to `watch/watch.json`; re-run the three commands of step 6 on the watcher box so
the watcher sees them. Then use Stop IMD Worker Monitor and open the monitor again: the hub reads
its box list at start.

**Add a seat.** Run discovery and `make-config.py ... --force` again for that box, with the same
`--payments` as before (existing seats keep their `account` and `alias`, and the file's other
settings are kept), have the operator review the diff, then push the config and install the new seat's timers:

```bash
IMD_OPS=<admin-alias> IMD_CFG=config-<id>.json bash deploy/deploy.sh --config
ssh <seat>@<admin-alias> 'bash -s' < deploy/install-collector.sh
```

Re-run step 6 on the watcher box for the new token.

**Update** (after the operator has pulled new code), per box:

```bash
IMD_OPS=<admin-alias> IMD_CFG=config-<id>.json bash deploy/deploy.sh --build --update
```

It keeps the config and history and restarts only the monitor backend. Re-run step 6 to update the
watcher. A bad update: `ssh <admin-alias> 'sudo bash ~/imd-monitor-stage/deploy/rollback.sh'`.

**Uninstall** (destructive: confirm with the operator first). Per seat, then per box:

```bash
ssh <seat>@<admin-alias> 'bash -s' < deploy/uninstall-collector.sh
ssh <admin-alias> 'sudo bash ~/imd-monitor-stage/deploy/uninstall.sh'
```

`uninstall.sh --purge` also deletes the history, watcher data, config and the `imdmon` user. On
Windows, use Stop IMD Worker Monitor and delete the two Desktop shortcuts (and the Startup one, if
`-AtLogon` was used).
