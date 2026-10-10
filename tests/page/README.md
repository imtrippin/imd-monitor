# Page tests

Offline checks of the dashboard page (`web/src/App.jsx`) and the workstation launcher. Synthetic data only
(fictional seats, tokens 2 and 3, 203.0.113.x); nothing leaves the machine. Each script exits non-zero on failure.

- `node tests/page/logic-test.mjs` — pure page logic: snapshot/heartbeat freshness, "last known", the shared
  allowance rule (R-ALLOWANCE), heavy-step results (R-RESULT), browser-side contract staleness. Needs `npm ci` in `web/`.
- `node tests/page/browser-test.mjs` — the built page in headless Chrome against a loopback fixture server:
  staleness, monitor loss over 2 min, range changes (latest wins, the 24 h chart survives 30d), hidden-tab polling,
  390 px overflow. Build first (`cd web && npm run build`); set `PLAYWRIGHT_FROM` to a directory whose
  `node_modules` holds Playwright, `PLAYWRIGHT_CHANNEL=""` for its bundled Chromium.
- `python tests/page/test-launcher-hosts.py` — `windows/launcher.ps1` refuses an `SshHost`/`Id` starting with `-`
  and passes `--` before the ssh destination (Windows PowerShell; skips elsewhere; starts no ssh or hub).

`deploy/test-make-config.py` covers `make-config.py` (including `--force` keeping settings and leading-dash hosts)
and `discover-seats.sh` (including the unsupported root layout).
