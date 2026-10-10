# Hub tests

Offline regression tests for `windows/hub.js`, evaluated in a VM with fetch, timers, files, sockets and toasts stubbed (no listener, no network, no toast shown). From the monitor root:

    node tests/hub/test-hub.js

Exits non-zero when a case fails.
