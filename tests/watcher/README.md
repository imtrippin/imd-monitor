# Watcher tests

Offline regression tests for `watch/imd_watch.py` (no network; synthetic fixtures). Run from the repo root with Python 3.8+:

    python3 tests/watcher/test_watch.py

Exit status 0 = every check passed; the first failing assertion exits non-zero.
