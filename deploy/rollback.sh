#!/usr/bin/env bash
# Roll the MONITOR BACKEND back to the previous code (.prev). Keeps config + history DB.
# Run as root (via `ssh <admin-alias> 'sudo bash ...'`).  usage: rollback.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
PORT="$(python3 -c 'import json;print(json.load(open("/etc/imd-monitor/config.json"))["port"])' 2>/dev/null || echo 8787)"
[[ -d /opt/imd-monitor/server.prev ]] || { echo "no server.prev to roll back to"; exit 1; }

echo "== restore .prev =="
for d in server collectors; do
  if [[ -d "/opt/imd-monitor/$d.prev" ]]; then
    rm -rf "/opt/imd-monitor/$d.rollback-tmp"
    cp -a "/opt/imd-monitor/$d" "/opt/imd-monitor/$d.rollback-tmp" 2>/dev/null || true
    rm -rf "/opt/imd-monitor/$d"
    mv "/opt/imd-monitor/$d.prev" "/opt/imd-monitor/$d"
    mv "/opt/imd-monitor/$d.rollback-tmp" "/opt/imd-monitor/$d.prev" 2>/dev/null || true
  fi
done
chown -R root:root /opt/imd-monitor
chmod -R a+rX,go-w /opt/imd-monitor
chmod 0755 /opt/imd-monitor/collectors/seat-collector.py 2>/dev/null || true

systemctl daemon-reload
systemctl restart imd-monitor.service
sleep 2
systemctl is-active imd-monitor.service && echo "  service active" || { journalctl -u imd-monitor.service -n 20 --no-pager; exit 1; }
curl -fsS -m 6 "http://127.0.0.1:$PORT/api/health" && echo || echo "  (health not ready yet)"
echo "rollback done."
