# Network tab

A view that shows the network's overall job statistics next to your fleet's share.

## What it shows (`#network`)

- **KPIs:** your share of the last 24 h (what your agents submitted ÷ the network's `acceptedLastDay`), your lifetime share (your accepted ÷ everyone's accepted, with the seat share for contrast), agents online (connected / enrolled, yours beside it), tasks in flight network-wide and yours.
- **Network throughput chart:** IMD's `GET /steps/hourly` (accepted steps per hour, last 24 h) as grey columns with your fleet's submissions in the same hour as blue columns; the tooltip gives the hourly share.
- **Share over time:** a rolling 24 h share line computed from totals the backend records every 10 min (your growth ÷ the network's growth since the point about a day earlier). The first point appears about a day after the backend update.
- **Tiles:** network verdicts all time, your fleet's verdicts all time (with accepted per seat vs the network average), oracle request counts and publication counts.
- **Standing:** your seats ranked among all seats by lifetime accepted work, with the network's top five for scale.
- **Landscape:** runtimes, concurrency and the most-advertised tools across connected daemons (from the watcher's hourly `/workers` read), with your counts beside each.

## Where the data comes from

The watcher box's backend (`server/index.js`, `networkState()`), served as `GET /api/network` and passed through by the hub (`windows/hub.js`, `cachedNetwork()`, 60 s memo).

| Source | Cadence | Notes |
| --- | --- | --- |
| `GET /seats/records` | every 10 min | already made by `/api/work`; shared cache |
| `GET /health` | every 5 min | `connectedDaemons`, `activeEnrollments`, `acceptedLastDay`, `workingNow`, pending queues |
| `GET /steps/hourly` | every 10 min | `{until, hours, accepted:[…]}`, oldest first |
| `GET /oracle/counts`, `GET /publications/counts` | hourly | small counters |
| `landscape.jsonl` | file read | the watcher's hourly `/workers?fields=` summary |

About 20 requests an hour in total (be gentle with the shared public API). An error keeps the last good reading and spaces out retries by the same TTL.

The fleet's token list comes from `/etc/imd-monitor/watch.json` (`tokens`; another path via the backend config key `watch_config`; without the file, the box's own workers), so the share covers every seat on every box, not just the watcher box's own.

## Recording

`network_totals(ts, accepted, attempts, seats, connected, fleet_accepted, fleet_attempts)` in the backend's SQLite file, one row per fresh records read (every 10 min), kept 90 days. `/api/network.history` returns the last 7 days as `[ts, accepted, fleet_accepted, connected, seats]`; the page derives the rolling share from it.

## Caveats

- "Submitted by you" (your collectors' counters) and "accepted network-wide" (IMD's verdict count) are not the same unit, so the 24 h KPI is approximate. The rolling chart uses accepted on both sides.
- Oracle work arrives in bursts; most hours are near zero for everyone.
- The per-box pages show the tab only after `deploy.sh --update`; the hub serves the local build immediately.
