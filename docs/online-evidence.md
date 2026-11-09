# Online room server: evidence (#22)

Design, rules and runbook: [online-server.md](online-server.md). **Local proof and production activation are reported separately, and production activation has not happened.**

## Production activation: not done

- No production or tailnet host, DNS, Nginx, systemd unit, database or third-party service was touched or contacted. No account was created with any provider.
- No CI run was observed: this environment has no GitHub access, so the new `server` job has not run on GitHub yet.
- The deployed static client builds without `VITE_ONLINE`, so online play is off and it never requests `/api` or `/ws` (browser-checked below).
- **Activation requirement:** the owner runs the [activation runbook](online-server.md#production-activation-runbook-owner) on the site host. Production multiplayer stays unavailable until the host gate (step 8) and the public gate (step 10, `scripts/server-smoke.mjs https://slotrush.jdwd40.com`) both pass.

## Local environment

- **Build host:** Linux x86_64, 4 cores, no GPU.
- **Node:** v26.7.0 (default). The checks were repeated on Node **v22.23.4** (the production major version, run from the `node-linux-x64` npm binary).
- **PostgreSQL:** **18.6**, a private cluster from `scripts/local-pg.mjs` under `.local-pg/` on port 55471, with a dedicated non-superuser role and database as in production. PostgreSQL 17 (the production version) was not available locally, so the CI job runs the same database tests on a `postgres:17` service container. The migrations use no 18-only syntax.
- **Browser:** Chromium 156 headless with **SwiftShader** software rendering. **Browser results are diagnostics only:** they show logic and wiring, not smooth play. No physical phone, tablet, second machine or GPU was used. Real multi-device online play was not tested. The headless clients are scripted simulations over loopback, not people on real networks.

## Commands and results

| Check | Result |
| --- | --- |
| `npm run typecheck` | Clean |
| `npm test` (Node 26 and Node 22) | 20 files: 495 passed, 6 skipped (the database file, which needs a database) |
| `npm run test:db` (PostgreSQL 18.6, Node 26 and Node 22) | 6/6 pass |
| `npm run build` | OK. The default bundle contains no `/api/health` reference and no server secret names. The `VITE_ONLINE=1` bundle contains the health probe only |
| `npm run build:server`, `npm run pack:server` | OK. Release tarball about 0.78 MB, with 3.5 MB of runtime packages. The release loads `argon2`, `ws`, `pg` and `express-session` with no build step |
| `python3 -m unittest discover -s deploy -p 'test_*.py'` | 17 tests OK. The static deploy tooling is unchanged |
| `server-smoke.mjs` against the packed release (production mode, PostgreSQL attached, Node 26 and Node 22) | All 9 checks pass: health, build protocol/rules match, foreign origin 403, protocol mismatch refused, hello, solo room, race state streams, leave |
| The CI smoke step script, run locally against local PostgreSQL | Passes. The aborted envelope of the in-progress race is stored on SIGTERM |
| Unmigrated schema | The service refuses to start (exit 78, `db.schema_outdated`). Production without `SLOTRUSH_ALLOWED_ORIGINS` refuses to start |

### Test coverage against the acceptance criteria

The files are `test/server/room.test.ts` (in-process, manual clock), `ws.test.ts` (real sockets, headless `OnlineClient`s), `protocol.test.ts` and `db.test.ts`.

| Criterion | Evidence |
| --- | --- |
| 1. Rooms of 2–4, fifth refused, AI fill, solo/AI, readiness, roster lock | Tested:<br>- Distinct slots, numbers, bays and colours for 4 humans<br>- A fifth gets `full` with the roster byte-identical (in-process and over sockets)<br>- AI fill is listed as AI<br>- Solo and championship are one human plus 3 AI and cannot be joined<br>- Readiness is visible, only the host starts, everyone must be ready and connected<br>- Joins after start get `started` |
| 2. Stable IDs, distinct numbers/bays/colours, visible livery resolution, names not identity | Tested:<br>- Room and participant IDs survive a rematch, and the race ID changes<br>- A duplicate livery request shows `liveryRequested`<br>- Same names are separate seats<br>- A twin's token cannot resume another seat<br>- An account seat needs the same account |
| 3. Create, join, leave, start, rematch, host transfer, empty close, creator disconnect, no replacement | Tested:<br>- Host leave and disconnect transfer to the earliest-joined connected participant<br>- The last one out closes and forgets the room (code freed)<br>- A creator disconnect mid-race keeps race time running, then retires the car at grace expiry<br>- Join and resume of the started seat are refused<br>- Rematch is host only |
| 4. Server-authoritative simulation; distinct modes | The server runs `Race` with no renderer. The protocol has no position, lap time, winner or points message; such messages are rejected as `malformed` (tested). Envelopes are tagged `multiplayer`, `solo`, `championship` (with `{ id, round }`) and `practice` (`ended`, valid laps only). |
| 5. 2-, 3- and 4-human races; scenario race; one immutable envelope | Over WebSockets, a 2-, a 3- and a 4-human race on three different circuits ran **at the same time** to `completed`. Every client of a room received the identical decisive event stream (laps, offences, service, finish, DQ, final), identical final snapshots and one envelope with the same digest, matching the stored copy.<br><br>A scenario race had two humans given a stop-and-go due on the same approach, 30 m and 37 m short of the entrance (seeded on the server by the test, as the race-core tests do). Both were taken over automatically and served one at a time through the shared box, with B `queued`. Bots made fuel stops in their own bays. The first human past the last pit entrance on the final lap was given a stop-and-go it could no longer serve and was DQ `stopGo` at the flag. All clients agreed and there was exactly one stored envelope.<br><br>The envelope is deep-frozen. Re-consuming it is a `duplicate`, a different digest for the same race is a `ResultConflict`, and the database rejects any UPDATE (tested on PostgreSQL). |
| 6. Concurrent different-circuit rooms independent; bounded resources | A circuit-2 room and a circuit-4 room run together give byte-identical classifications and lap times to each run alone (fixed seed). Shared tracks are deep-frozen and mutation throws. `setTrack` never reaches a race. Tested: the room cap, idle lobby/results closure, the room lifetime abort, shutdown aborts, and slow-socket drop at the send-buffer cap. There are no worker threads. |
| 7. Versioned protocol and rejections | Tested:<br>- Protocol mismatch closes with 4002; `hello` is required first and only once<br>- Malformed, unknown-field, wrong-type, binary and 513–1024-byte messages are refused; frames over 1024 bytes close with 1009<br>- Duplicate, out-of-order and oversized-jump sequence numbers are refused<br>- A foreign `driver` is `forbidden`; host-only messages are `forbidden` from others<br>- Origin check (403, missing and foreign), path check (404)<br>- A flood gets `nack rate`, then close 1008<br>- Commands before joining get `not_in_room`<br>- The token appears only in the owner's `joined`, never in room/state broadcasts or any log line |
| 8. Disconnect, input timeout, grace, reconnect, expiry | Tested:<br>- A dropped link with Throttle held: the car's throttle reaches 0 within 0.3 s while another held car keeps full throttle<br>- A silent client is neutralized after the input timeout<br>- An abrupt socket loss neutralizes at once; resuming over a new socket returns the same car, continues the sequence numbering (a replay is `duplicate`), and keeps laps, stop-and-go debt, offences and time penalties<br>- After the grace: `expired`, car DNF `retired`<br>- Leaving with a latched breach is DQ, not DNF |
| 9. Ordering and overload | Server ticks and timestamps are in every `state`. A 1.5 s stall is caught up without losing race time (race time equals wall time afterwards). A stall over the limit aborts with `outcome: aborted`, `classification: null`. New rooms are refused under load. |
| 10. Accounts, hashing, sessions, admin reset, PostgreSQL, secrets | Tested on PostgreSQL:<br>- Argon2id `m=19456,t=2,p=1` hashes; usernames unique without regard to case<br>- HttpOnly, SameSite=Strict cookie; a new session ID on login; logout<br>- Cross-origin, non-JSON, oversized, extra-field (`email`) and weak inputs refused<br>- No email/phone/contact column anywhere<br>- `admin reset-password` sets the password from stdin or generates it (shown once), signs out all of that account's sessions, and refuses unknown users and weak passwords<br>- Migrations apply once, are checksummed, and a changed one is refused<br>- Health is 503 until migrated<br>- A signed-in seat's envelope carries its `accountId`<br><br>Secrets live only in the server env file. No awards are implemented. |
| 11. Local commands, health, dependencies, deployment design, limits | See [online-server.md](online-server.md): local commands, dependency versions, configuration, the systemd unit (unprivileged user, `MemoryMax=256M`, `CPUQuota=60%`), the Nginx `/api` and `/ws` template, compatibility checks, the runbook and rollback. Measurements are below. |
| 12. Static build and secret-free deploy unchanged; online off by default; CI without secrets | The static `check`/`deploy` jobs are unchanged. The new `server` job uses only a throwaway database container, and deploy does not depend on it. Browser checks are below. |
| 13. typecheck, test, build, browser checks; saves preserved | Above and below. The `practice` and `championship` scenarios load fixture saves and confirm they are preserved. The server never reads or writes browser storage. |
| 14. Local versus production | This file. Production is not activated. |

## Resource measurements

The release was packed and run in production mode with PostgreSQL, `--max-old-space-size=96 --max-semi-space-size=2` and `UV_THREADPOOL_SIZE=2`. The per-address connection cap was raised only so that one loopback address could open 24 sockets. Load: `scripts/load-check.mjs`, with 6 rooms (the configured cap) × 4 human sockets each, all racing for 60 s, 20 state messages a second per socket. These figures are from the build host, not the production host: diagnostics only.

| Node | Idle RSS | Peak RSS (VmHWM) | Heap | CPU (one core) | Worst tick | Per client |
| --- | --- | --- | --- | --- | --- | --- |
| 26.7.0 | 75–84 MB | 98.7 MB | 16 MB | 9.1% | 2.1 ms | 20 msg/s, 84 KB/s |
| 22.23.4 | 84 MB | 99.5 MB | 13 MB | 9.2% | 4.3 ms | 20 msg/s, 84 KB/s |

This is under the 150 MB RSS target and well inside `MemoryMax=256M`. The CPU figure is far below the 60% quota even if the shared vCPU is several times slower. Total egress at the cap is about 2 MB/s. Bandwidth is the limit to watch: lower `SLOTRUSH_SNAPSHOT_HZ` to reduce it. The figures were not measured on the production host, and systemd limits were not exercised: no root access and no host access by design.

Single race step: about 37 µs for 4 cars on the build host. A synchronous `runOut()` of the old kind measured 334 ms, which is why the server uses the new live run-on.

## Browser checks (diagnostics only)

Chromium 156 headless, SwiftShader, 480×270, Low preset, `scripts/browser-check.mjs`.

| Scenario | Build | Result | Notes |
| --- | --- | --- | --- |
| `online` | Default (`dist/`) | 3 pass, 1 n/a | Online `off`. No request to `/api` or `/ws` in 1.5 s after load. The round trip is n/a because this build does not enable online play |
| `online` | `VITE_ONLINE=1` (`dist-online/`) via `vite preview` same-origin proxy and a local server | 5/5 pass | Health and protocol gate `available`. Only `/api/health` was requested. A page-origin WebSocket did hello, then a solo room (private token received), then server state with 4 cars (human plus 3 AI on circuit-2), then leave. The first run failed 2 checks: the 4 s probe budget expired while SwiftShader starved the page's main thread (the response had arrived in 12 ms). The probe now starts after `load` with a 10 s budget, and the run passes |
| `tracks` | Default | 6/6 pass | All circuits draw: the shared-track freeze does not affect rendering |
| `practice` | Default | 10/10 pass | PB lap, ghost saved, loaded and replayed. Fixture saves preserved |
| `championship` | Default | 9/9 pass | Rounds stored once from the final result. Fixture championship continued |
| `localslot` | Default | 11/11 pass | Local driver in slot 2 |
| `race` | Default | See below | Full 13-lap race on real keys |

RACE_RESULT_PLACEHOLDER

Not run: `controlled`, `routing`, `touch`, `responsive`, `touchrace`, `reverse`, `service`, `queue` and `autosg`/`autobay`. This change does not touch input, HUD, layout or service rules. The race-core suite (unchanged, all passing) and the new server tests cover the shared-track and run-on changes. The build host's time limit also applies.

Not available here: physical phones and tablets, real touch, a GPU, two or more real devices on real networks, the production host, and PostgreSQL 17 locally. CI covers PostgreSQL 17, but that run was not observed.
