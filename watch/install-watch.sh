#!/usr/bin/env bash
# Install/update the read-only heavy-work watcher on ONE box. Run as root:
#   scp imd_watch.py imd-watch.service install-watch.sh watch.json <ops-alias>:watch-stage/
#   (watch.json = your fleet identifiers, see watch.example.json; it lands at /etc/imd-monitor/watch.json)
#   ssh <ops-alias> 'sudo bash ~/watch-stage/install-watch.sh ~/watch-stage'
# Never touches a worker. Data: /var/lib/imd-monitor/watch/*.jsonl (owned by imdmon).
set -euo pipefail
S="${1:?usage: install-watch.sh <stage-dir>}"
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
id imdmon >/dev/null 2>&1 || { echo "no imdmon user: install the monitor backend first (deploy/deploy.sh, install mode)"; exit 1; }
install -d -o root -g root -m 0755 /opt/imd-monitor/watch
install -o root -g root -m 0755 "$S/imd_watch.py" /opt/imd-monitor/watch/imd_watch.py
install -d -o imdmon -g imdmon -m 0750 /var/lib/imd-monitor/watch
install -o root -g root -m 0644 "$S/imd-watch.service" /etc/systemd/system/imd-watch.service
install -d -o root -g root -m 0755 /etc/imd-monitor
[[ -f "$S/watch.json" ]] && install -o root -g imdmon -m 0640 "$S/watch.json" /etc/imd-monitor/watch.json
[[ -f /etc/imd-monitor/watch.json ]] || { echo "missing /etc/imd-monitor/watch.json - stage watch.json next to imd_watch.py (see watch.example.json)"; exit 1; }
systemctl daemon-reload
systemctl enable imd-watch.service >/dev/null 2>&1
systemctl restart imd-watch.service
sleep 3
systemctl is-active imd-watch.service
md5sum /opt/imd-monitor/watch/imd_watch.py "$S/imd_watch.py" | cut -c1-12
