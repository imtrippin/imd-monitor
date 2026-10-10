#!/usr/bin/env bash
# Install the per-seat collector TIMERS. Run AS THE SEAT (ssh <seat-alias>), not root.
# Reads the world-readable units published by install-server.sh; uses the root-owned
# collector at /opt/imd-monitor/collectors. Writes only this seat's own <seat>.json.
# Never touches the worker service.  usage: install-collector.sh
set -euo pipefail
UNITS=/opt/imd-monitor/units
COLLECTOR=/opt/imd-monitor/collectors/seat-collector.py
[[ -f "$COLLECTOR" ]] || { echo "FATAL: $COLLECTOR missing — run install-server.sh (root) first"; exit 1; }
[[ -d "$UNITS" ]]      || { echo "FATAL: $UNITS missing — run install-server.sh (root) first"; exit 1; }

mkdir -p "$HOME/.config/systemd/user"
for u in imd-monitor-collect.service imd-monitor-collect.timer imd-monitor-allowance.service imd-monitor-allowance.timer; do
  install -m 0644 "$UNITS/$u" "$HOME/.config/systemd/user/$u"
done
systemctl --user daemon-reload
systemctl --user enable --now imd-monitor-collect.timer imd-monitor-allowance.timer
echo "note: the Claude allowance probe runs only for seats listed in /opt/imd-monitor/live-probe/"

# Prime immediately so the dashboard has data now (don't wait for the timers).
systemctl --user start imd-monitor-collect.service || true
systemctl --user start imd-monitor-allowance.service || true
sleep 4
echo "== timers =="; systemctl --user --no-pager list-timers 'imd-monitor-*' 2>/dev/null | head -n 5
mine="/var/lib/imd-monitor/incoming/$(id -un).json"
if [[ -f "$mine" ]]; then echo "wrote $mine ($(stat -c %s "$mine") bytes, mode $(stat -c %a "$mine"))";
else echo "WARN: $mine not written yet — check: systemctl --user status imd-monitor-collect.service"; fi
echo "collector install done for $(id -un)."
