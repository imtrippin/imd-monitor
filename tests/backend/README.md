# Backend tests

Offline regression tests for `server/index.js` (temp config, temp SQLite, temp watch_dir, stubbed fetch; no network). From the monitor root:

    node --experimental-sqlite tests/backend/test-backend.js

Exits non-zero when a case fails.
