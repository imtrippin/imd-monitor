#!/usr/bin/env bash
# Local orchestrator (run from a POSIX shell: Git Bash on Windows, or Linux/macOS). Deploys ONLY the monitor:
#   - stages the tree to <admin-alias>:~/imd-monitor-stage
#   - installs/updates the backend as root via the box admin alias (needs passwordless sudo)
#   - installs the collector timers as each seat user
# Never signals, restarts, or reconfigures a worker.
#   usage: IMD_OPS=<admin-alias> [IMD_SEATS="<seat-alias> ..."] [IMD_CFG=config-boxN.json] deploy.sh [--build] [--update] [--config]
#   IMD_OPS   ~/.ssh/config alias of the box admin (required)
#   IMD_SEATS ssh destinations of the seat users; when unset, every workers[].seat in the config is used as
#             <seat>@$IMD_OPS (same host and key settings as the admin alias, different login user)
#   IMD_CFG   file in deploy/ to stage as the box config (default config.json, copied from config.example.json)
#   IMD_SSH / IMD_SCP  ssh/scp binaries (default: the ones on PATH, else Windows OpenSSH if present). In Git Bash,
#             when your keys live in the Windows ssh-agent, set them to /c/Windows/System32/OpenSSH/ssh.exe and scp.exe
#   --config  push deploy/$IMD_CFG to /etc/imd-monitor/config.json (backup kept) and restart the monitor
#             backend only; neither install nor --update ever rewrites an existing config.
# Requirements: every seat user accepts your key over ssh (step 4 logs in as each seat), and each seat has
# lingering enabled (loginctl enable-linger <seat>) so its user timers run without a login session.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPS="${IMD_OPS:?set IMD_OPS to the ~/.ssh/config alias of the box admin, e.g. IMD_OPS=<admin-alias> bash deploy/deploy.sh --build}"
CFG="${IMD_CFG:-config.json}"
[[ -f "$ROOT/deploy/$CFG" ]] || { echo "FATAL: deploy/$CFG not found (copy deploy/config.example.json and fill it in)"; exit 1; }
WINSSH=/c/Windows/System32/OpenSSH
SSH="${IMD_SSH:-$(command -v ssh || true)}"; [[ -n "$SSH" || ! -x "$WINSSH/ssh.exe" ]] || SSH="$WINSSH/ssh.exe"
SCP="${IMD_SCP:-$(command -v scp || true)}"; [[ -n "$SCP" || ! -x "$WINSSH/scp.exe" ]] || SCP="$WINSSH/scp.exe"
[[ -n "$SSH" && -n "$SCP" ]] || { echo "FATAL: ssh/scp not found (set IMD_SSH and IMD_SCP)"; exit 1; }
SSHOPTS=(-o BatchMode=yes -o ConnectTimeout=12)
# workers[].seat from the JSON on stdin, one per line
config_seats() {
  if command -v node >/dev/null 2>&1; then
    node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const w of c.workers||[])if(w.seat)console.log(w.seat)'
  else
    python3 -c 'import json,sys;[print(w["seat"]) for w in json.load(sys.stdin).get("workers",[]) if w.get("seat")]'
  fi
}
# A seat name becomes an ssh login (and, from IMD_SEATS, a destination): only plain user names and host
# aliases pass, so nothing from a box's discovery output can reach ssh as an option (a leading '-').
SEAT_RE='^[a-z_][a-z0-9_-]{0,31}$'
HOST_RE='^[A-Za-z0-9_][A-Za-z0-9._-]*$'
if [[ -n "${IMD_SEATS:-}" ]]; then
  read -ra SEATS <<< "$IMD_SEATS"
  for d in "${SEATS[@]}"; do   # <seat-alias> or <seat>@<host>
    if [[ "$d" == *@* ]]; then u="${d%%@*}"; h="${d#*@}"; else u=""; h="$d"; fi
    if { [[ "$d" == *@* ]] && [[ ! "$u" =~ $SEAT_RE ]]; } || [[ ! "$h" =~ $HOST_RE ]]; then
      echo "FATAL: IMD_SEATS entry '$d' is not <seat-alias> or <seat>@<host> with a plain name"; exit 1
    fi
  done
else
  SEATS=()
  while read -r s; do
    [[ -n "$s" ]] || continue
    [[ "$s" =~ $SEAT_RE ]] || { echo "FATAL: workers[].seat '$s' in deploy/$CFG is not a plain user name ($SEAT_RE)"; exit 1; }
    SEATS+=("$s@$OPS")
  done < <(config_seats < "$ROOT/deploy/$CFG" | tr -d '\r')
fi
MODE=install
BUILD=0
for a in "$@"; do case "$a" in --build) BUILD=1;; --update) MODE=update;; --config) MODE=config;; esac; done

echo "== 0. web build =="
if [[ $BUILD -eq 1 || ! -f "$ROOT/web/dist/index.html" ]]; then
  ( cd "$ROOT/web" && npm run build )
fi
[[ -f "$ROOT/web/dist/index.html" ]] || { echo "FATAL: web/dist not built"; exit 1; }

echo "== 1. stage locally =="
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/server" "$STAGE/web/dist" "$STAGE/collectors" "$STAGE/deploy/units"
cp -a "$ROOT/server/." "$STAGE/server/"
cp -a "$ROOT/web/dist/." "$STAGE/web/dist/"
cp -a "$ROOT/collectors/." "$STAGE/collectors/"
cp -a "$ROOT/deploy/units/." "$STAGE/deploy/units/"
cp -a "$ROOT/deploy/install-server.sh" "$ROOT/deploy/install-collector.sh" \
      "$ROOT/deploy/update.sh" "$ROOT/deploy/rollback.sh" "$ROOT/deploy/uninstall.sh" "$STAGE/deploy/"
cp -a "$ROOT/deploy/$CFG" "$STAGE/deploy/config.json"
[[ -f "$ROOT/README.md" ]] && cp -a "$ROOT/README.md" "$STAGE/README.md" || true
# strip node_modules/dev files defensively
rm -rf "$STAGE/server/node_modules" "$STAGE/web/node_modules" 2>/dev/null || true

echo "== 2. push to $OPS:~/imd-monitor-stage =="
"$SSH" "${SSHOPTS[@]}" -- "$OPS" 'rm -rf ~/imd-monitor-stage && mkdir -p ~/imd-monitor-stage'
"$SCP" "${SSHOPTS[@]}" -r "$STAGE"/* "$OPS":imd-monitor-stage/ >/dev/null
echo "  staged."

echo "== 3. backend as root ($MODE) =="
if [[ "$MODE" == config ]]; then
  "$SSH" "${SSHOPTS[@]}" -- "$OPS" 'set -e; ts=$(date -u +%Y%m%d-%H%M%S); \
    [[ -f /etc/imd-monitor/config.json ]] && sudo cp -p /etc/imd-monitor/config.json /etc/imd-monitor/config.json.bak-$ts; \
    sudo install -m 0640 -o root -g imdmon ~/imd-monitor-stage/deploy/config.json /etc/imd-monitor/config.json; \
    sudo systemctl restart imd-monitor.service; sleep 2; systemctl is-active imd-monitor.service; \
    sudo md5sum /etc/imd-monitor/config.json ~/imd-monitor-stage/deploy/config.json | cut -c1-12,34-'
elif [[ "$MODE" == update ]]; then
  "$SSH" "${SSHOPTS[@]}" -- "$OPS" 'sudo bash ~/imd-monitor-stage/deploy/update.sh ~/imd-monitor-stage'
else
  "$SSH" "${SSHOPTS[@]}" -- "$OPS" 'sudo bash ~/imd-monitor-stage/deploy/install-server.sh ~/imd-monitor-stage'
fi

if [[ "$MODE" != config ]]; then
echo "== 4. collector timers per seat =="
[[ ${#SEATS[@]} -gt 0 ]] || echo "  (no seats: set IMD_SEATS or list workers[].seat in deploy/$CFG)"
for s in "${SEATS[@]}"; do
  echo "  -- $s --"
  "$SSH" "${SSHOPTS[@]}" -- "$s" 'bash -s' < "$ROOT/deploy/install-collector.sh"
done
fi

echo "== 5. verify =="
"$SSH" "${SSHOPTS[@]}" -- "$OPS" 'p=$(sudo python3 -c "import json;print(json.load(open(\"/etc/imd-monitor/config.json\"))[\"port\"])" 2>/dev/null || echo 8787); \
  echo "health (port $p):"; curl -fsS -m 6 "http://127.0.0.1:$p/api/health"; echo; echo incoming:; sudo ls -l /var/lib/imd-monitor/incoming 2>/dev/null'
cat <<TIP

Done. To view the dashboard from Windows: list this box in windows/boxes.json (copy boxes.example.json), then run
  powershell -NoProfile -ExecutionPolicy Bypass -File "$ROOT/windows/install-shortcut.ps1"
and open the "IMD Worker Monitor" shortcut. It tunnels to every box in boxes.json and serves one page
from the local hub at http://127.0.0.1:18790/ (launcher.ps1 -HubPort changes the port).
TIP
