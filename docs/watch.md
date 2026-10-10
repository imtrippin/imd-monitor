# Watch: release checks, failure digest, news

Why: some changes on IMD's side need a check on yours, and nothing announces them. A worker release can
move the Foundry version the verifier expects (a constant `VERIFIER_FOUNDRY_VERSION` baked into every
worker build and used by `imd doctor`) while your seats still run the old one. A seat's failure reason is
public in `/seats/<token>/standing` → `standing.recentFailures[]` and in the job's `/submissions`, but only
if someone looks. The watcher ties those changes to checks, read-only, on the public API, inside a gentle
budget. The whole watcher costs `api.imd.fun` about 100–130 requests an hour for 25 seats: the presence pass
(one standing per token every 30 min) and the 5-min job poll are most of it; the failure digest adds about two
reads per failure; the queue probe (2 seats, every 30 min, research log only) and the 6-hourly checks are noise.
The backend's verified-work view reads the watcher's `records-latest.json` copy of `/seats/records` instead of
fetching its own, so that route is read once per 10 min per box, not twice.

Everything here is produced on the watcher box by the watcher (`watch/imd_watch.py`, user `imdmon`,
`ProtectHome=yes`, writable only under `/var/lib/imd-monitor/watch`), exposed by the per-box backend
as `/api/watch` (the watcher box only; others answer `{enabled:false}`), merged by the hub and shown on
the page. The collector adds one field per seat (`toolchain`).

## Files written by the watcher (`/var/lib/imd-monitor/watch/`)

All JSONL lines carry `"ts"` = observation time (UTC ISO, `YYYY-MM-DDTHH:MM:SSZ`), added by `emit()`.

### `failures.jsonl` — one line per failed or verifier-rejected submission of yours

```json
{"ts":"2026-01-01T12:00:00Z","token":"1001","job":"00000000-0000-0000-0000-000000000000","node":"manifest",
 "at":"2026-01-01T11:30:00.000Z","reason":"runtime_error","pattern":"no_changes",
 "summary":"the task produced no changes; the agent's last message was: …","turns":7,"runtime":"claude",
 "attempt":2,"template":"shape:chain","attribution":"time","failureClass":"machine","role":"integrate","contract":"likely",
 "others":{"completed":6,"failed":1,"total":7}}
```

- Discovery: every 600 s `GET /seats/records`; per token in `watch.json`, when `failed` is higher than the
  saved count, `GET /seats/<token>/standing?queue=0` once and take `standing.recentFailures[]`
  (`{at, reason, jobId, nodeKey}`). For each entry not yet seen (key `job:node:at`),
  `GET /jobs/<jobId>/submissions` once. Sleep ≥ 1 s between detail fetches.
- Attribution (`attribution`): which of your submissions on that node the failure is about. A job can hold
  several failed retries of yours, so the newest one is never assumed. In order: `id` = the standing row
  names a submission (`submissionId`) and exactly one of yours has that id; `attempt` = the row carries an
  `attempt` number and exactly one of your failed submissions has it; `time` = your failed submission
  (`seat.tokenId == token`, `nodeKey == node`, `outcome == "failed"`) whose `createdAt` is nearest the
  row's `at`, within 15 minutes (`ATTRIBUTE_S`); a submission already matched in the same pass is not
  reused. Otherwise `unknown`: `reason` comes from the standing row only and `summary`, `turns`,
  `runtime`, `attempt`, `failureClass`, `role`, `usage` and `contract` are null, so another attempt's
  diagnostics are never borrowed. No extra request: it uses the submissions already fetched.
- `summary` is the attributed submission's `summary` cut to 400 chars; `turns` = `usage.turns`; `runtime` from
  `usage.runtime`; `attempt`, `failureClass` and `role` from the submission; `template` from `GET /jobs/<id>`
  only if already fetched for heavy.jsonl (do not add a call for it; null is fine). `contract`: see
  [Contract-work standing](#contract-work-standing).
- **Verifier rejections** (added 2026-10-09): a submission of yours that `completed` and was then refused by
  the verifier (`accepted: false`, `verdict.status: "rejected"`) never appears in `standing.recentFailures`,
  so the discovery above misses it and the standing poll reported it up to 30 min later as a reason-less
  `bad_added`. The job poll records it instead, from the submissions it already fetches (no extra request):
  one line per such submission with `pattern` `rejected:<rejectionCode>` (`rejected:tests_failed`,
  `rejected:analysis_failed`, …), `reason` = the code, `at` = `verdict.at`, `attribution: "verdict"`,
  `summary` = `verdict.detail` plus the `[FAIL …]` lines of the first failed check (cut to 400),
  `verdict: {status, code, verifier, profile}`, `failureClass: null`, `contract` = `likely` for a premium step
  (a rejection always counts there) and `others` extended with `accepted` / `rejected` counts. Each
  `job:node:attempt:token` is recorded once (`jobs-state.json` `rejected`, last 1000 keys), so a later update
  of the job does not repeat it; `patterns.json` counts the pattern like any other.
- `others` counts the OTHER seats' submissions for the same job + node: `completed`, `failed`, `total`.
  It lets the page say "only us" vs "everyone" (a control-plane storm fails every seat).
- First run (no state file): sweep the standing of every token in `watch.json` once (0.5 s apart), record
  every recent failure it finds (submissions fetched 1 s apart), then save state. Restarts never re-sweep.
- State: `failures-state.json` = `{"records":{"<token>":<failed count>},"seen":[…≤1000 keys, oldest
  dropped…]}`, written after each failure and after each cycle.
- `records-latest.json` (the backend's copy of the same `/seats/records` read) is replaced only by a
  well-formed body: a dict whose `seats` is a non-empty list of dicts, each with a `tokenId` and numeric
  `accepted` and `attempts`. An error object, an empty list or a bad row leaves the previous file in
  place (its `fetched_at` keeps ageing, so the backend's age rule takes over) and writes one
  `errors.jsonl` line (`task: failures`, `retry_s: null`).

Pattern (first match wins; test `reason`, `summary`, `turns`):

| pattern | rule |
|---|---|
| `reads_mismatch` | summary matches /could not materialize reads/ |
| `upload_500` | summary matches /bundle upload failed/ |
| `turn_budget` | `turns` ≥ 60 |
| `no_changes` | summary matches /produced no changes/ |
| `provider_auth` | summary matches /unauthorized (401)/, /workspace routing discovery/ (Codex) or /Failed to authenticate/, /OAuth token revoked/ (Claude Code 2.1.287+): the runtime's login is dead, every job fails at 0 turns until the seat logs in again |
| `provider_refusal` | summary matches /flagged for possible cybersecurity risk/ (the runtime's own safety filter refused the task) |
| `provider_capacity` | summary matches /Selected model is at capacity/ (the provider had no capacity for the run; 0 turns) |
| `bundle_too_large` | summary matches /bundle is N bytes; the upload limit/ (the export exceeded IMD's 8 MiB cap) |
| `path_violation` | reason == `path_violation` or summary matches /outside the task's allowed paths/ |
| `missing_outputs` | summary matches /required outputs are missing/ |
| `tests_failed` | reason == `tests_failed` |
| `internal_error` | reason == `internal_error` |
| `other:<reason>` | anything else (so an unknown reason is visible as its own pattern) |

`patterns.json` = `{"<pattern>":{"first_seen":ts,"last_seen":ts,"count":n}}`, updated per failure.
The page flags a pattern whose `first_seen` is within 7 days as new.

### `heavy.jsonl` — the job poll, in bounded chunks

- Every 300 s `GET /jobs?exclude=oracle&since=<last good poll − 15 min, at most 6 h back>` (≤ 5 pages of
  100, 1 s apart). Each job whose `updatedAt` changed since it was last recorded (and that is not yet
  recorded in a terminal state) is queued; then `GET /jobs/<id>` and `GET /jobs/<id>/submissions`, 1 s
  apart, one `heavy.jsonl` line per job.
- A pass works off at most `JOBS_CHUNK` = 20 queued jobs (≤ 40 detail + submission reads, about 40 s of
  pacing). The rest stays in `jobs-state.json` = `{"since":…, "pending":[{"id","updatedAt","template",
  "createdAt","objective"}…]}`, saved after every job; the next pass resumes it WITHOUT listing again, and
  lists only once the queue is empty. A 500-job burst therefore takes about 25 passes (~2 h) instead of
  one 17-minute pass that starves the failure digest and presence checks. The request rate does not
  change; only the order does.
- A queued job carries a `tries` count, raised before its reads. A job whose reads failed on
  `JOBS_TRIES` = 5 passes (purged, malformed; with backoff about an hour) is dropped with one
  `errors.jsonl` line (`task: jobs`) so it cannot block the queue; a later update of it is queued again.
- `run()` reads the clock before each task (not once per pass), so a slow task never leaves the next
  one's due time judged or set from a stale clock.

### `releases.jsonl` — one line per new worker release

```json
{"ts":"…","tag":"worker-v0.1.0-<commit>","version":"0.1.0+<commit8>","published":"2026-01-01T03:00:00Z",
 "url":"https://github.com/Identity-md/worker/releases/tag/worker-v0.1.0-<commit>",
 "notes":"What changed since worker-v0.1.0-<previous commit>\n- …",
 "sha256":"<64 hex>","verified":true,"verifier_forge":"1.8.3",
 "strings":{"added":3,"removed":1,"added_sample":["…"],"removed_sample":["…"]}}
```

- Source: `https://github.com/Identity-md/worker/releases.atom` every 900 s (a web feed, NOT the
  GitHub REST API, whose unauthenticated limit is 60/h per IP and is shared with the workers on
  the box). Entry → `tag` from the alternate link (`/releases/tag/<tag>`), `version` from the title
  (`Worker 0.1.0+<commit8>`), `published` from `<updated>`, `notes` = the HTML content with tags
  stripped and entities decoded, ≤ 2000 chars, the "Install" section dropped.
- For each unseen tag, oldest first: download
  `https://github.com/Identity-md/worker/releases/download/<tag>/SHA256SUMS` and
  `…/identitymd-worker.tgz` (size cap 20 MB, in memory, never written to disk, never executed),
  `verified` = the tgz's SHA-256 equals the SHA256SUMS line for `identitymd-worker.tgz`. If not
  verified, record the release with `verifier_forge: null`, `strings: null` and stop there.
- From `package/dist/cli.js` inside the tgz (tarfile over gzip, in memory):
  `verifier_forge` = regex `VERIFIER_FOUNDRY_VERSION\s*=\s*"([^"]+)"` (null if absent).
  Rule strings = every JS string literal (`"…"`, `'…'`, and template-literal text between backticks
  or `${…}` boundaries) whose collapsed-whitespace form is ≥ 60 chars and contains one of
  `must|never|only|always|fail|required|write|submit|revision|verifier|allowed|do not|don't`
  (case-insensitive). Sorted unique. Saved as `strings-<version>.json` (keep the newest 4 files).
  `strings.added/removed` = set difference vs the previous release's file; samples are up to 12
  strings each, cut to 200 chars. The full lists go to `release-diff-<version>.json`
  (≤ 300 each side; keep the newest 4 files).
- First run: process every entry in the feed, oldest first, so the diff chain exists.
- State: `releases-state.json` = `{"seen":["<tag>",…]}`.

### `news.jsonl`

- `{"ts":…,"kind":"control-plane","version":"<new>","prev":"<old>"}` when
  `GET /health` → `version` changes (checked every 900 s; first run records the current version with
  `prev: null`). State: `news-state.json` `{"health_version":…,"onchain_seen":[…],"launch_policy_version":…}`.
- `{"ts":…,"kind":"api-routes","added":["GET /x",…],"removed":[…],"count":<routes documented>}` when the set of
  routes documented on `https://imd.fun/docs/` changes (`METHOD /path` tokens in the page text, query strings dropped,
  scripts stripped, prose placeholders skipped; read every 21600 s, 4 reads a day; a page with fewer than 20 routes is an error page and is
  retried with backoff, never diffed). State: `api-routes.json` `{baseline_at, checked_at, routes[], changes[]}`;
  the first read is the baseline and emits nothing. IMD's `/openapi.json` covers the paid-request routes only.
- `{"ts":…,"kind":"launch-policy","version":<v>,"prev":<old v or null>,"note":"<kind: note, ≤300 chars, or null>"}`
  when the highest `version` in `GET /launch/policies` → `policies[]` changes (checked every 3600 s;
  first run records the current version with `prev: null` and keeps the whole policy object once in
  `news-state.json` as `launch_policy`).
- `{"ts":…,"kind":"onchain","at":"2026-01-01T00:00:00Z","hash":"0x<tx hash>","text":"…≤1500…"}` for
  each new self-transaction of the IMD comms address, every 1800 s:
  `https://eth.blockscout.com/api/v2/addresses/0x200E710aCAA6A93bbc77146026328C40F1d60fB1/transactions?filter=from`,
  keep items whose `to.hash` equals that address (case-insensitive), `text` = `raw_input` hex
  decoded as UTF-8 (replace errors). First run records the newest 5.
- `{"ts":…,"kind":"contract-rules","prev":{…},"rules":{…}}` when the `rules` object of a seat's
  contract section changes (see [Contract-work standing](#contract-work-standing)).

### `payments.jsonl` — one line per IMD reward payment into the NFT wallet

```json
{"ts":"2026-01-01T12:00:00Z","at":"2026-01-01T03:00:00Z","hash":"0x<64 hex>",
 "from":"0xd15fE25eD0Dba12fE05e7029C88b10C25e8880E3","token":"IMD","amount":12.3456,"transfers":5,"block":12345678}
```

- Source, every 1800 s: `https://eth.blockscout.com/api/v2/addresses/<wallet>/token-transfers?filter=to&token=0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7`
  (`<wallet>` = the NFT wallet from `/etc/imd-monitor/watch.json`, which also lists the seat token ids; the IMD token contract). Blockscout answers 403 to urllib's default user-agent, so
  the watcher's `UA` header is required. Items are ERC-20 transfers with `token.address_hash`,
  `from.hash`, `transaction_hash`, `timestamp`, `block_number`, `total.value`, `total.decimals`
  (an NFT transfer has no `total.value`: skip such items).
- A payment = every item whose `from.hash` (case-insensitive) is in `PAYERS`, currently only IMD's
  Disperse contract `0xd15fe25ed0dba12fe05e7029c88b10c25e8880e3` (the wallet also receives IMD from
  the staking contract and from swaps; those are not payments). Group by `transaction_hash`:
  `amount` = Σ value / 10^decimals rounded to 4 dp, `transfers` = item count, `at` = the timestamp
  normalised to `YYYY-MM-DDTHH:MM:SSZ`, `block`.
- Paging (`next_page_params` → merge its keys into the query): the first run follows up to 12 pages;
  later runs read page 1 and continue only while the current page holds a transfer of an unseen payment
  (a payment's transfers can straddle a page), 12 pages max. Emit after paging so a payment is recorded
  with all its transfers.
- State: `payments-state.json` = `{"seen":[hashes]}`, written after each emitted payment.
- `payments_exclude` in `watch.json`: tx hashes from the payer that are not rewards (for example a refund
  of your own paid orders). They are skipped before grouping and never recorded.
- A new payer can be added to `PAYERS` without touching anything else.
- Without a `wallet` in `watch.json` the payments and allocations tasks are disabled (one `errors.jsonl`
  line says so at start).

### Allocations

Launch tokens allotted to the NFT wallet on IMD's launch reward snapshots. They are a separate thing
from IMD payments and are never summed with them.

- Source, every 21600 s (6 h): `GET https://api.imd.fun/wallets/<wallet>/earnings?limit=200`, following
  `next` as `before=<next>` while it is non-null, ≤ 5 pages, 1 s apart. Rows:
  `{launchId, launchNumber, status, chainId, kind, token{address,name,symbol,decimals}, amount (wei string), at}`.
  A response without an `earnings` list, or a row without a usable `token`/`amount`, is an error
  (`errors.jsonl`, backoff), never a guess.
- `allocations.jsonl`: one line per `launchId` not yet seen, oldest first by `at`:

```json
{"ts":"2026-01-01T12:00:00Z","launchId":"<launch id>","launchNumber":1,"status":"<status>","chainId":11155111,
 "kind":"<kind>","symbol":"TKN","name":"Token","tokenAddress":"0x<40 hex>","amount":1234.5678,"at":"2026-01-01T03:00:00Z"}
```

  `amount` = the wei string / 10^`decimals` (18 when absent), rounded to 4 dp. The first run records the
  whole backlog.
- State: `allocations-state.json` = `{"seen":[launchIds]}`, written after each emitted line (and once on a
  first run that found nothing).

Backoff: the per-task backoff (2 → 30 min) applies to every task; a failure in one task never blocks the
others. GitHub and blockscout errors are logged to `errors.jsonl` like the rest.

## Collector field (`collectors/seat-collector.py`, every seat, every 30 s)

```json
"toolchain": {"forge": "1.8.3", "verifier_forge": "1.8.3"}
```

- `forge`: first `\d+\.\d+\.\d+` in `~/.foundry/bin/forge --version` (timeout 10 s); null if missing.
- `verifier_forge`: regex `VERIFIER_FOUNDRY_VERSION\s*=\s*"([^"]+)"` over
  `~/.local/lib/node_modules/@identitymd/worker/dist/cli.js`; null if absent.
- Both cached in `<seat>.cache.json` under `"toolchain"` keyed by the file's `[size, int(mtime)]`, so
  a 30 s run neither spawns forge nor reads the 1 MB cli.js unless either file changed.

## Backend `/api/watch` (`server/index.js`)

`{enabled:false}` when the watch dir does not exist (every box but the watcher box). Otherwise, cached 60 s:

```json
{"enabled":true,"generated_utc":"…",
 "failures":{"since_days":7,
   "items":[ …failures.jsonl lines with at ≥ now-7d, newest first, ≤ 100… ],
   "by_pattern":{"no_changes":{"count_7d":1,"count_24h":0,"last_at":"…","first_seen":"…"}},
   "patterns":{ …patterns.json… }},
 "releases":[ …last 6 lines of releases.jsonl, newest first… ],
 "news":[ …last 20 lines of news.jsonl, newest first… ],
 "payments":[ …last 200 payments, one per hash, newest first by at… ],
 "payments_total":{"amount":12.3456,"count":1,"first_at":"2026-01-01T03:00:00Z","last_at":"2026-01-01T03:00:00Z"},
 "allocations":[ …last 200 allocations, one per launchId, newest first by at… ],
 "allocations_total":{"count":1,"launches_by_chain":{"11155111":1},"latest_at":"2026-01-01T03:00:00Z"},
 "contract":{ …see Contract-work standing… },
 "contract_changes":[ …last 200 lines of contract.jsonl, newest first… ]}
```

`payments_total` sums every line of the file, one per hash (not only the 200 returned); `amount` to 4 dp;
with no file: `{"amount":0,"count":0,"first_at":null,"last_at":null}`.

`allocations_total` counts every line of the file, one per `launchId` (the last line wins);
`launches_by_chain` is keyed by `chainId` as a string (`"unknown"` when absent); with no file:
`{"count":0,"launches_by_chain":{},"latest_at":null}`.

`first_seen` in `by_pattern` comes from `patterns.json`. Missing files → empty arrays/objects, still
`enabled:true`. Read files whole (they stay small: a few lines a day).

## Hub (`windows/hub.js`)

`/api/watch` → ask boxes in order, return the first `enabled` answer plus `box: <id>`; memo 60 s;
`{enabled:false}` if none. Same guards as the other routes.

## Page (`web/src/App.jsx`, `styles.css`)

The page has a top bar with views carried in the URL hash, so the launcher's plain URL opens the everyday
view: **Agents** (`/`: KPIs, provider accounts, servers, agent table), **Activity** (`#activity`: payments,
launch allocations, tasks per hour, verified work), **Network** (`#network`, see `docs/network-tab.md`) and
**News** (`#news`: the panel below, with a badge = the new-item count until Mark seen).
The attention strip shows on every view. The News view's main panel, **Since last check**, is fed by
`api/watch` polled every 5 min plus `toolchain` from `api/state`. It shows:

1. **Toolchain** — from every worker's `snapshot.toolchain`: "forge X on N agents · verifier Y" when all
   match; otherwise list the agents whose `forge` ≠ `verifier_forge` (or is null).
2. **Failures by cause, 7 days** — rows: pattern, 24 h, 7 d, last, a `new` chip when `first_seen` is
   within 7 days; below it the newest 8 failures: time, agent (alias by token), node, pattern,
   summary (cut ~140 chars, full on hover/expander), and "others: 6 completed · 1 failed" or "only us"
   when others.failed == 0 and others.completed > 0, "everyone" when others.completed == 0 and
   others.failed > 0.
3. **Worker releases** — newest 3: version, published (local time), first 3 note lines, verifier
   forge, "+N / −M rule strings" with the samples in an expander; unverified releases say so.
4. **News** — newest 6 of `news`: control-plane version changes and on-chain messages (text cut ~200
   chars, expander for full).

"Mark seen" stores the current time in `localStorage['imd-watch-seen']` (try/catch, per-viewer
convenience only). Items newer than it get a `new` dot and the panel head says "N new since <time>";
with nothing stored, everything within 7 days counts as new. The panel says the watcher is not available
when `enabled` is false; it never guesses.

`attentions()` gains: `warn` when any agent's forge ≠ verifier forge (a live condition, always shown);
one `warn` line when a failure pattern was first seen after the viewer's Mark-seen time; one `warn`
line for the worker releases recorded after it (count + newest). Never marked = the last 7 days.
Clicking Mark seen clears both lines at once (the seen time lives in App state and localStorage).

Failures and bad results are never only a row on the News tab (added 2026-10-09 after three verifier
rejections went unnoticed there):

- one `bad` line per **bad contract result** (`contract_changes` event `bad_added`) recorded after the
  mark: the agent, the time, what a bad result is, and that one more means 24 h at lower priority;
- one line for **every failed job on our seats** since the mark (`items` after the mark): count, the
  patterns, the agents; `bad` when the watcher marked any item `contract: "likely"` (a premium step
  stored as a machine failure; the legacy spelling `"yes"` counts too), `warn` otherwise, and the text
  says "standing impact unknown" when an item carries neither `likely` nor `no`. Both are events: Mark
  seen clears them, a newer item brings them back;
- one `bad` line, live, for every seat with a `bad` among its **newest two** counted results that is
  not on probation (results are newest first and only those two survive the next result, so the next
  bad one is 2 of 3 = 24 h probation). It stays, dismissible for a day, until the bad result ages out
  of the newest two; a bad only in the oldest position is no longer a next-result risk.

Whenever the strip holds a `bad` line it turns red (`has-bad`: red border and tint, a "Needs your
attention" header, bold text on the bad lines).

### Payments panel (Activity view)

The **Activity** view starts with a **Payments received** panel above the throughput chart (page
head "Activity" / "Payments received, tasks per hour, and IMD's public verdicts."):

- four tiles: total IMD received (`payments_total.amount`), number of payments, the last payment
  (amount and local date), and "Per agent, last payment": `amount / transfers` when the payout sent one
  transfer per agent; for a single aggregated transfer, an estimate (`amount` ÷ the number of agents on the
  dashboard, shown with "≈" and labelled as such);
- a table, newest first: date (local), amount (4 dp, "IMD"), transfers ("N (one per agent)" or
  "1 (aggregated)"), per agent (`—` for an aggregated transfer, whose per-agent share is not on chain),
  and a note = the first line of the `news` item whose text contains the payment's hash
  (case-insensitive), else the nearest on-chain message within 12 h prefixed "same day:", else "—"; the
  hash cell links to `https://etherscan.io/tx/<hash>`;
- honest empty states: "No payments recorded yet" when `payments` is empty, and "not available" when
  `enabled` is false.

A payment counts as new for the News badge and "N new since" exactly like the other watch items
(`ts` / `at` after the viewer's Mark-seen time), and the attention strip gets one line
"IMD payment received: X IMD on <date>" for payments after the mark, cleared by Mark seen.

### Launch allocations panel (Activity view)

After Payments received: tiles = launches (count, latest date), Sepolia vs other chains (from
`launches_by_chain`; 11155111 = Sepolia), newest allocation (amount, symbol, local date); a table of the
newest 10: date, launch number, kind, token symbol, amount, chain, status. The attention strip gets one
`warn` line "Launch allocation on chain <id>: <symbol> <amount>" for an allocation on a chain other than
Sepolia recorded after the viewer's mark.

## Contract-work standing

IMD's control plane rotates premium steps (contract builds, tests, manifests, frontends, websites)
among qualifying machines and puts a machine with 2 bad of its last 3 counted results on 24 h probation
(IMD's contract-work rules). Each seat's standing route carries a top-level `contract` section. The watcher
reads it from the standing responses `presence()` (every 30 min, all seats) and `failures()` (when a seat's
failed count rose) already fetch, so this adds **0 requests**.

- `contract.jsonl`: one line per CHANGE of a seat's section (`qualifies`, `missing`, `lastTurnAt`, `good`,
  `bad`, `recent`, `probationUntil`, `retryDue`, `probations`), with `prev` = the old values of the changed
  fields, `baseline: true` on the first sighting, and `events` = the notable changes (`probation_start`,
  `probation_extended`, `probation_cleared`, `retry_due`, `qualifies_lost`, `qualifies_gained`,
  `missing_changed`, `bad_added`, `section_missing`, `section_back`). A routine turn or a good result is
  logged with `events: []` and never lights the badge. A changed `rules` object is a `contract-rules` news line.
- `contract-state.json`: the latest section per seat, `read_at` (stamped only after a full presence pass, so
  an aborted pass shows as staleness), `server`, `rules`.
- `failures.jsonl` lines carry the server's `failureClass`, the submission `role` and `contract`
  (`likely` = a premium step stored as a machine failure, which counts as bad; `no`; or null = unknown class).
- Backend `/api/watch`: `contract` = `{read_at, server, rules, stale (> 2 h), seats[], summary}` with
  ONE definition of `in_rotation` (qualifies and not on probation) and `alert` (unknown, not qualifying,
  probation, retry due, missing); no state file or section = `null`/`unknown`, never healthy.
  `contract_changes` = the last 200 lines, newest first.
- Hub: a toast when the set of alerting seats changes (key persisted in `.toast-state.json`) and one for each
  new `bad_added` event; `notifyAttention` also flags a reconnect storm (`jobs.reconnects_today >= 100`).
- Page: a Contract work block in the agent record (three result marks, good/bad, probation), live
  attention lines (not cleared by Mark seen), and a
  "Contract standing" section on the News tab whose notable changes count toward the badge.
- Collector: `jobs.reconnects_today` from the journal's `reconnecting in` lines.

## Hardening notes

- `watch-schedule.json` keeps every task's next due time and backoff across restarts, so a restart
  does not fire every task at once.
- `payout_senders` (optional, `watch.json`): a non-empty list means a payer transfer counts as a
  payment only when the transaction's sender is in it (one extra blockscout call per new transaction);
  others are written to `payments-unattributed.jsonl` and never summed. Empty = every transfer from a
  payer counts.
- Bodies from the public API are capped at 8 MiB and parsed with NaN/Infinity, floats that overflow and
  integer literals over 40 digits rejected (a later float() of those raises OverflowError); release
  tarballs are read as a stream with member caps; failure summaries and dispatch notes have control
  characters stripped; `run()` catches every exception with the same backoff.

