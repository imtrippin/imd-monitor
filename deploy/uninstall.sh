#!/usr/bin/env bash
# Remove the MONITOR BACKEND (and the watcher, if installed). Run as root. Does NOT touch workers.
#   usage: uninstall.sh [--purge]   (--purge also deletes history DB, watcher data, config, and imdmon user)
# Per-seat timers must be removed as each seat, e.g. from the workstation:
#   ssh <seat-alias> 'bash -s' < deploy/uninstall-collector.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
PURGE="${1:-}"

systemctl disable --now imd-monitor.service 2>/dev/null || true
rm -f /etc/systemd/system/imd-monitor.service
systemctl disable --now imd-watch.service 2>/dev/null || true
rm -f /etc/systemd/system/imd-watch.service
systemctl daemon-reload
rm -rf /opt/imd-monitor
if [[ "$PURGE" == "--purge" ]]; then
  rm -rf /var/lib/imd-monitor /etc/imd-monitor
  userdel imdmon 2>/dev/null || true
  echo "purged: code, state, config, imdmon user."
else
  echo "removed code + services. Kept /var/lib/imd-monitor (history) and /etc/imd-monitor (config)."
  echo "Re-run with --purge to delete those too."
fi
echo "NOTE: run deploy/uninstall-collector.sh as each seat to remove its timers (see header)."
