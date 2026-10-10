#!/usr/bin/env bash
# Update the MONITOR BACKEND to freshly staged code, keeping config + history DB.
# Run as root (via `ssh <admin-alias> 'sudo bash ...'`).  usage: update.sh <staging-dir>
set -euo pipefail
STAGE="${1:?usage: update.sh <staging-dir>}"
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
PORT="$(python3 -c 'import json;print(json.load(open("'"$STAGE"'/deploy/config.json"))["port"])' 2>/dev/null || echo 8787)"

echo "== back up current code -> .prev =="
for d in server collectors; do
  if [[ -d "/opt/imd-monitor/$d" ]]; then rm -rf "/opt/imd-monitor/$d.prev"; cp -a "/opt/imd-monitor/$d" "/opt/imd-monitor/$d.prev"; fi
done

echo "== swap in new code (config + /var/lib untouched) =="
rm -rf /opt/imd-monitor/server /opt/imd-monitor/collectors
install -d -m 0755 /opt/imd-monitor/server /opt/imd-monitor/server/public /opt/imd-monitor/collectors
cp -a "$STAGE/server/." /opt/imd-monitor/server/
cp -a "$STAGE/web/dist/." /opt/imd-monitor/server/public/
cp -a "$STAGE/collectors/." /opt/imd-monitor/collectors/
cp -f "$STAGE/README.md" /opt/imd-monitor/README.md 2>/dev/null || true
chown -R root:root /opt/imd-monitor
chmod -R a+rX,go-w /opt/imd-monitor
chmod 0755 /opt/imd-monitor/collectors/seat-collector.py

echo "== the Claude probe's empty root-owned working directory (install-server.sh makes it on first install) =="
install -d -m 0755 -o root -g root /opt/imd-monitor/probe-cwd

echo "== refresh unit files if changed =="
# per-seat user units (install-collector.sh copies them from here when deploy.sh re-runs it per seat)
install -d -m 0755 /opt/imd-monitor/units
for u in imd-monitor-collect.service imd-monitor-collect.timer imd-monitor-allowance.service imd-monitor-allowance.timer; do
  install -m 0644 "$STAGE/deploy/units/$u" "/opt/imd-monitor/units/$u"
done
install -m 0644 "$STAGE/deploy/units/imd-monitor.service" /etc/systemd/system/imd-monitor.service
systemctl daemon-reload
systemctl restart imd-monitor.service
sleep 2
systemctl is-active imd-monitor.service && echo "  service active" || { journalctl -u imd-monitor.service -n 20 --no-pager; exit 1; }
curl -fsS -m 6 "http://127.0.0.1:$PORT/api/health" && echo || echo "  (health not ready yet)"
echo "update done. (collector timers on each seat pick up new collector code automatically; deploy.sh --update also re-installs their units.)"
