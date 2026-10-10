#!/usr/bin/env bash
# Remove the per-seat collector TIMERS that install-collector.sh installed. Run AS THE SEAT, not root:
#   ssh <seat-alias> 'bash -s' < deploy/uninstall-collector.sh
# Never touches the worker service.  usage: uninstall-collector.sh
set -euo pipefail
systemctl --user disable --now imd-monitor-collect.timer imd-monitor-allowance.timer 2>/dev/null || true
systemctl --user stop imd-monitor-collect.service imd-monitor-allowance.service 2>/dev/null || true
for u in imd-monitor-collect.service imd-monitor-collect.timer imd-monitor-allowance.service imd-monitor-allowance.timer; do
  rm -f "$HOME/.config/systemd/user/$u"
done
systemctl --user daemon-reload
echo "collector timers removed for $(id -un)."
