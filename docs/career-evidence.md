# Career points and personal bests: evidence (#25)

Taken on 9 November 2026 on the build host (Node 26 locally; the release targets Node 22.12+, CI runs Node from
`.nvmrc`). Design: [career.md](career.md). Branch `ship/25` from `d460505` (latest `main`, which contains the reviewed
baseline `525b55b` and the dependencies #17, #22, #23, #24).

**What these results are.**

- Browser runs used Playwright Chromium 156 on **SwiftShader** (the host has no GPU) and Chromium **touch emulation**:
  **functional diagnostics only**, not evidence of smooth play on a physical phone, tablet or desktop GPU. **No physical
  device was tested.**
- **Production was not touched**: no host, DNS, Nginx, systemd unit, database or third-party service was used or
  changed, and no provider account was created. Everything ran against the private PostgreSQL 18 cluster under
  `.local-pg/` (no 18-only syntax; CI runs the same database tests on `postgres:17`).
- Where a scenario needs an event a script cannot produce on cue (a stop-and-go given at a precise point, a finish),
  the test sets it on the **server's** authoritative race state, and says so. Points are always computed by the
  unmodified scoring and storage code from the server's own classification.

## Commands and results

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | **536 passed**, 23 skipped (the three database files without `SLOTRUSH_TEST_DATABASE_URL`), 27 files |
| `npm run build` | pass (static build; online off by default, unchanged gate) |
| `npm run test:db` (`db`, `profiles`, new `career` DB files, local PostgreSQL) | **23 passed**, 0 failed |
| `npm run build:server && npm run pack:server`; packed release in `NODE_ENV=production` with the migrated local database | without `SLOTRUSH_SPOOL_DIR`: refuses to start (exit 1, message names the variable). With it: `admin migrate` applied `001`, `002`, `003_career_awards_bests`; `admin status` current; all 9 `server-smoke.mjs` checks PASS; health `{"career":true,"db":"ok","schema":"003_career_awards_bests","scoring":"career-1:10-6-4","pendingResults":0,"rssMb":75,"heapMb":11}` (78 MB with a solo race running); `GET /api/profile/stats` without a cookie 401, `POST` 405 |
| `SLOTRUSH_TEST_DATABASE_URL=… node scripts/online-check.mjs career` (SwiftShader, diagnostics) | **13 passed, 0 failed**, 203 s (run `2026-11-09T13-51-49`) |
| Regression, existing browser scenarios: `node scripts/browser-check.mjs online` (default build gate) | 3 passed, 1 n/a: online off by default, **no request to `/api` or `/ws`** |
| `node scripts/online-check.mjs gate` (online build, service down) | 6 passed, 0 failed |
| `online-check.mjs accounts` (#24 scenario, with the career UI present) | first run: 12 passed, then **failed on a `page.reload` timeout** (60 s) when a fourth software-rendered page re-probed health, a load-sensitive step the script already documents; **re-run: 25 passed, 0 failed**, 613 s. Recorded as a flaky harness step, not a product failure |

## Results by acceptance item

| # | Item | Evidence |
| --- | --- | --- |
| 1 | 10/6/4/0; DQ/DNF/practice/aborted 0; penalties and unserved stops before awards; AI/guests no credit; local 10/6/4/2 | `career.test.ts`: 1st–4th → 10/6/4/0; DQ and DNF → 0; practice and aborted → ineligible, no ledger; AI and guest rows keep P1/P2 with no credit while the account behind them scores 4 for P3; `CHAMP_POINTS` still `[10,6,4,2]` and a local 4th still scores 2. **Final-lap unserved stop on the real room and race core:** four account seats; the car leading on the road past the last pit entrance of its final lap is given a stop-and-go it can no longer serve; it is classified `dq`/`stopGo` with no position, the remaining finishers are 1..3 and receive 10/6/4, the DQ row 0. DB test: the same on stored ledger rows |
| 2 | Authoritative session result, account bound at start; offline clearly unverified; anonymous/client/localStorage cannot award | Awards come only from `computeAwards(envelope)` inside the result sink; the envelope's `accountId`s are the roster frozen at the start (#24). No client message or HTTP endpoint carries points, positions or laps (`career.test.ts`: `result`/`awards`/`points`/`pb` client messages and extra fields are `malformed`; DB test: `/api/profile/stats` writes → 405, extra fields on `/api/profile` → 400, unknown write paths → 404, a forged `result` over the socket → `malformed` and nothing changes). Guest finishers get `credit: false`. Local results/championship screens show "Local race: saved on this device only. Verified account points and personal bests need a connected server-run race" when the server offers accounts; the online menu states the rule. Local play is unchanged |
| 3 | Atomic, idempotent; reload/reconnect/duplicate/concurrent/restart; storage failure → pending, durable, once | DB test: 8 concurrent deliveries of one race → exactly 1 `stored`, 7 `duplicate`; a restarted sink → `duplicate`; ledger and results immutable (update triggers). Reconnect after the race replays the same result and awards; the ledger is unchanged. **Storage failure:** a connected solo race finishes with the database path down → every client gets `sync: pending`, the envelope is in the spool directory, health `pendingResults: 1`, totals unchanged; the server is stopped and started (new sink, new manager) → the spool is drained, totals rise by exactly the race's points, the spool is empty; a second restart plus a re-delivery → `duplicate`, totals unchanged, one ledger row. `career.test.ts`: a spool file edited on disk (positions swapped) fails its digest and is set aside, never stored; a room shows `saving → pending → saved`. **Bug found and fixed:** a duplicate delivery asked the pool for a second connection while holding the first, so concurrent retries could exhaust the pool (3 in production) and deadlock; the digest check now uses the same connection |
| 4 | Valid authoritative laps incl. final lap; compatible circuit/mode/rules; monotonic; invalidation kept; local data intact | Room test: every finisher's lap 13 is in the envelope. `laps.test.ts`: the final lap's event is emitted in the same step as the finish (so the car reads `finished` when it is handled) and no lap event follows the finish; the browser's `!p.finished` guard that dropped that lap from local race boards is removed. DB test: final lap 7.9 s becomes the PB; slower 8.5 s, invalid 6.0 s, duplicate and concurrent slower/faster deliveries leave the fastest (7.1 s); practice and solo are separate rows; a guest's 5.0 s lap is nobody's; a best on an older layout version is kept apart and marked not current. Validity is the race core's `lapValid`/sectors flag, unchanged (existing reverse, pit, collision, de-slot tests still pass). No local time is synced; `personal_bests.source` only accepts `verified` |
| 5 | Profile: name, points, podiums, PBs by circuit and mode, recent results; second browser; rename; switching | DB test: stats for the winner of the four-account race are identical from a second login; a rename changes only `displayName`; another account's stats contain only its own race. Unit test: the browser drops a stats answer for a different account than the tab shows (cookie switched in another tab). Browser `career`: see below |
| 6 | Authorization; migrations preserve data; scoring/rules versions stored | DB tests above; migration `003` on a `002` database with an account, profile, session and a stored result: all kept, the old result has `scoring_version NULL` and no awards (never scored retroactively); health 503 until migrated. Every ledger row stores `scoring_version` (`career-1:10-6-4`) and `rules_version`; the result row stores the scoring version; a retune (`makeScoring([12,8,5])`) has a different version |
| 7 | Integrated four-player race: service queues, pit/stop-and-go service, override + final-lap DQ, identical awards | DB test over real WebSockets with four signed-in accounts (time ×20): two cars given a stop-and-go on the same approach queue for the box (`sgPhase: queued` seen), both served; fuel stops in own bays; a final-lap stop-and-go the leader can no longer serve → DQ; **all four clients' final `awards` messages are byte-identical, `sync: saved`, and match the stored ledger and each account's totals**. *Override:* the race core test `autoStopGo.test.ts` ("repeated lane overrides skip the stop twice: the first uses the deferral, the second disqualifies at the flag") covers an override leading to a final-lap DQ; in the integrated race the DQ comes from a stop given past the last pit entrance (as in the #22 WebSocket test), not from a driver's lane override, because a scripted client cannot time an override reliably |
| 8 | Local PostgreSQL, accounts, admin reset; runbook; limits; static deploy without secrets; online off by default | Local cluster and packed release above; `db.test.ts` admin reset (stdin and generated password, sessions revoked) still passes. Runbook additions: [career.md § Production activation](career.md#production-activation-owner) and [online-server.md](online-server.md#production-activation-runbook-owner) (migration 003, `StateDirectory=slotrush-server`, `SLOTRUSH_SPOOL_DIR`, `SLOTRUSH_CAREER_POINTS`, health fields). Unit limits unchanged (`MemoryMax=256M`, `CPUQuota=60%`, room cap 6); career adds one small transaction per race and no new process; measured RSS 75–78 MB. CI: the database step runs the new file on the existing throwaway `postgres:17`; the smoke step gets a temporary `SLOTRUSH_SPOOL_DIR` under `runner.temp` (no secret). The static `check`/`deploy` jobs are unchanged; the client gate is unchanged |

## Browser scenario (`online-check.mjs career`)

Two browser contexts against the repository's server code with the local database (`scripts/qa-server.ts`, schema
`t_browser`, time ×2): desktop A (laptop 960×540) and phone B (390×844, touch emulation). The QA server routes results
through the real `DurableSink` with a switch on the storage path. **Seeded on the server:** the three AI cars retire and
A's car is placed just past the line on its final lap with a valid lap in progress; the race core's own lap counting
then emits the final lap and the finish. Everything after that (classification, awards, storage, UI) is unmodified.

| Check | Result |
| --- | --- |
| New account: profile shows 0 points, no races, no bests | pass |
| Online menu (signed in): connected championship round offered; verified-points rule stated | pass |
| Seeded finish classified as finished on lap 13 | pass |
| Storage down at the finish: "You finished P1", +10, **"⏳ Pending sync: …never counted twice."** | pass |
| Storage back (queue drained): the same screen shows "✓ Saved to driver accounts."; ledger 0 → 1 row | pass |
| A second drain adds nothing | pass |
| Profile: 10 points, 1 win, 1 race, verified solo best `0:08.400 lap 13`, one recent result | pass |
| Second browser (phone) after sign-in: identical tiles, bests and history | pass |
| Phone portrait profile with career fits the width, no sideways scroll | pass |
| Rename on the phone: career and history unchanged, new name shown | pass |
| Sign out and create another account on the phone: 0 points, no rows (nothing leaks or transfers) | pass |
| No page errors (both pages) | pass |

Screenshots: `.qa/online-check/2026-11-09T13-51-49-461Z/career-*.png` (not committed; `.qa/` is git-ignored).

## Not verified

- Physical phones, tablets and GPUs; iOS Safari.
- A real production database outage, the real systemd `StateDirectory` and a real host restart (simulated with a
  switched storage path and process-level restarts of the app, manager and sink against the same spool directory).
- A full 13-lap four-human browser race with awards (the four-human race with awards runs headless over WebSockets; the
  browser scenario seeds the finish of a connected solo race).
