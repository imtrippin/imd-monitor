#!/usr/bin/env bash
# Install/refresh the MONITOR BACKEND only. Run as root (via `ssh <admin-alias> 'sudo bash ...'`).
# Touches nothing owned by the workers and never signals a worker service.
#   usage: install-server.sh <staging-dir>
set -euo pipefail
STAGE="${1:?usage: install-server.sh <staging-dir>}"
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
PORT="$(python3 -c 'import json;print(json.load(open("'"$STAGE"'/deploy/config.json"))["port"])' 2>/dev/null || echo 8787)"

echo "== 0. node + node:sqlite =="
node --experimental-sqlite -e 'require("node:sqlite")' 2>/dev/null || { echo "FATAL: node:sqlite unavailable (need Node >=22.5)"; node -v; exit 1; }
echo "  node $(node -v) with node:sqlite OK"

echo "== 1. imdmon system account (no login, no sudo) =="
id imdmon &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin --comment "IMD monitor" imdmon
echo "  $(id imdmon)"

echo "== 2. code -> /opt/imd-monitor (root-owned; keep .prev for rollback) =="
install -d -m 0755 /opt/imd-monitor
for d in server collectors; do
  if [[ -d "/opt/imd-monitor/$d" ]]; then rm -rf "/opt/imd-monitor/$d.prev"; cp -a "/opt/imd-monitor/$d" "/opt/imd-monitor/$d.prev"; fi
done
rm -rf /opt/imd-monitor/server /opt/imd-monitor/collectors
install -d -m 0755 /opt/imd-monitor/server /opt/imd-monitor/server/public /opt/imd-monitor/collectors
cp -a "$STAGE/server/." /opt/imd-monitor/server/
cp -a "$STAGE/web/dist/." /opt/imd-monitor/server/public/
cp -a "$STAGE/collectors/." /opt/imd-monitor/collectors/
cp -f "$STAGE/README.md" /opt/imd-monitor/README.md 2>/dev/null || true
chown -R root:root /opt/imd-monitor
chmod -R a+rX,go-w /opt/imd-monitor
chmod 0755 /opt/imd-monitor/collectors/seat-collector.py
# publish per-seat user units world-readable so each seat can install its timers
install -d -m 0755 /opt/imd-monitor/units
for u in imd-monitor-collect.service imd-monitor-collect.timer imd-monitor-allowance.service imd-monitor-allowance.timer; do
  install -m 0644 "$STAGE/deploy/units/$u" "/opt/imd-monitor/units/$u"
done
# empty root-owned working directory for the Claude allowance probe (the collector skips the probe without it)
install -d -m 0755 -o root -g root /opt/imd-monitor/probe-cwd
# the Claude allowance probe is a real model call and opt-in: it runs only for seats listed here, so the
# directory starts empty (an existing one is kept as is). The operator runs
# `touch /opt/imd-monitor/live-probe/<seat>` for each seat that may probe.
[[ -d /opt/imd-monitor/live-probe ]] || install -d -m 0755 -o root -g root /opt/imd-monitor/live-probe

echo "== 3. config -> /etc/imd-monitor (root:imdmon 0640) =="
install -d -m 0755 /etc/imd-monitor
if [[ -f /etc/imd-monitor/config.json ]]; then echo "  keeping existing config.json";
else install -m 0640 -o root -g imdmon "$STAGE/deploy/config.json" /etc/imd-monitor/config.json; fi

echo "== 4. state dirs =="
install -d -m 0755 /var/lib/imd-monitor
# sticky drop dir (1733): seats create their own <seat>.json, cannot list the dir and cannot replace or
# delete another seat's file. A file whose name is known is still readable by any local user (exports are
# 0644), and any local user can pre-create a file under another seat's name.
install -d -m 1733 /var/lib/imd-monitor/incoming
chown root:root /var/lib/imd-monitor/incoming
install -d -o imdmon -g imdmon -m 0750 /var/lib/imd-monitor/db

echo "== 5. backend service =="
install -m 0644 "$STAGE/deploy/units/imd-monitor.service" /etc/systemd/system/imd-monitor.service
systemctl daemon-reload
systemctl enable --now imd-monitor.service
sleep 2
systemctl is-active imd-monitor.service && echo "  service active" || { journalctl -u imd-monitor.service -n 20 --no-pager; exit 1; }
echo "== health =="
curl -fsS -m 6 "http://127.0.0.1:$PORT/api/health" && echo || echo "  (health not ready yet; check: journalctl -u imd-monitor -n 30)"
echo "server install done."
