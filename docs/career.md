# Career points, personal bests and race history (#25)

Each signed-in account keeps verified career points, podium counts, personal-best laps and recent results, computed by
the server from its own finalized races and readable from any device after sign-in. Builds on the room server (#22,
[online-server.md](online-server.md)), the browser lobbies (#23) and accounts (#24, [accounts.md](accounts.md)).
Evidence: [career-evidence.md](career-evidence.md).

## Scoring policy

| Classified result | Career points |
| --- | --- |
| 1st | **10** |
| 2nd | **6** |
| 3rd | **4** |
| 4th or lower, DQ, DNF | 0 |
| Practice session, aborted or unclassified race | nothing for anyone (no ledger entry) |

- Configurable with `SLOTRUSH_CAREER_POINTS` (default `10,6,4`). The **scoring version** is derived from the numbers
  (`career-1:10-6-4`) and stored with every award and every stored result, so a later retune never recalculates past
  earnings: a race is scored once, when it is stored, under the version in force then. Totals add up every version.
- **Separate from the local championship**, which still scores 10/6/4/2 on this device (`CHAMP_POINTS` in
  `src/records.ts`, unchanged, tested). Local championships and their saves are never read or rewritten.
- **Classification first, points second.** The race core classifies only once every car is terminal, after penalties
  (time penalties, unserved stop-and-go, unserved fuel stop, latched service breach, retirement). A car disqualified on
  its final lap is `dq` with no position, and the cars behind it move up before any points are computed. A provisional
  order on the road is never used.
- **Who is credited:** a human participant whose seat was bound to an account when the race started (the frozen roster
  in the result envelope). AI and guest finishers keep their real positions but credit nobody; an account behind them
  scores from its real position (P3 behind an AI and a guest earns 4).
- **Eligible modes:** connected **solo** (one human, three AI), connected **championship** rounds and online
  **multiplayer**. All are run and classified by the server.

## What can never create points or verified bests

- Offline/local races, local championships, practice, browser result screens, `localStorage` (including an edited or
  imported one), client messages and estimated times. The protocol has no client message that carries a result,
  position, points or lap (tested); the HTTP API has no write endpoint for them (`/api/profile/stats` is `GET` only,
  any other method is `405`; unknown fields on `/api/profile` are `400`).
- A sign-in after the race, a rename, a refresh, a reconnect or another device: the result belongs to the account id in
  the roster frozen at the start (#24), and storage is keyed by race id.
- No local times are uploaded. Local leaderboards, ghosts and championships stay on the device exactly as before; the
  `personal_bests.source` column accepts only `verified`, so an unverified time cannot be stored there by mistake.

## Personal bests

- The fastest **valid** lap per account × circuit × **circuit layout version** (a hash of the circuit definition) ×
  mode (`solo`, `championship`, `multiplayer`, `practice`) × rules version. A changed circuit or rules version starts a
  new best; the old one is kept and shown as "older layout".
- Laps come from the server's own lap events. The race core's invalidation rules decide validity (all three sectors in
  order, no pit-lane entry, no reversing, no collision, no de-slot/tow, a flying lap); an invalid lap never qualifies.
  Laps under 1 s are ignored as a defence in depth.
- **The final race lap counts.** The server records the lap event before the finish is classified (verified: every
  finisher's lap 13 is in the envelope). The same audit found the browser's local lap handler dropped the final lap from
  local race leaderboards because it checked `!p.finished` after the step that classified the finish; that guard is
  removed (the race core never emits a lap after the finish).
- **Monotonic:** `INSERT … ON CONFLICT … DO UPDATE … WHERE EXCLUDED.lap_ms < personal_bests.lap_ms`. A slower,
  equal, duplicate or concurrently committed slower lap can never replace a faster one (tested with concurrent stores).
- Stored metadata: lap number, race id, livery, time set. Best whole-race times are not shown (not needed for this
  release).
- Only races that ran to their end count (`completed`, or a practice session `ended`); laps of an aborted race (server
  shutdown, overload) are dropped with the race.

## Storage, idempotency and pending sync

Migration `003_career_awards_bests` (additive; existing accounts, profiles, sessions and results are untouched and
results stored before it are not scored retroactively):

| Table | Key | Purpose |
| --- | --- | --- |
| `race_results` + `scoring_version` | `race_id` | the immutable server envelope, now with the scoring version it was scored under |
| `career_awards` | `(race_id, participant_id, scoring_version)`, also unique `(race_id, account_id, scoring_version)` | the award ledger: one immutable row per credited participant (position, status, points, mode, championship round, track + version, rules version, field size, humans, driver name at the time, livery, finish time) |
| `personal_bests` | `(account_id, track_id, track_version, mode, rules_version)` | verified fastest lap |

- **One transaction per race** (`PgResultSink.consume`): insert the result (`ON CONFLICT (race_id) DO NOTHING`); only if
  this transaction inserted it, write its ledger rows and best-lap updates; commit. A duplicate delivery (same digest)
  is a no-op, a different envelope for a stored race is refused (`ResultConflict`). Concurrent consumers of one race
  serialize on the primary key, so exactly one writes awards (tested with 8 concurrent deliveries and a restarted sink).
- **Totals are summed from the ledger** (`server/stats.ts`), never kept as a counter, so they cannot drift from it, and
  recovery is reproducible: the ledger can always be re-derived from the stored envelope with the same pure function
  (`computeAwards`). Ledger rows and results are immutable (update triggers).
- **Durable queue** (`server/spool.ts`): if storage fails (database down, timeout), the envelope is written to
  `SLOTRUSH_SPOOL_DIR/<raceId>.json` (fsync, then rename) before the room is told `pending`. It is retried with back-off
  and drained at every start. A spool file whose digest does not match (edited on disk) is set aside as `.bad`, never
  stored. Because storage is idempotent by race id, a retry after a commit whose reply was lost cannot award twice.
  Health reports `pendingResults`. Without a spool directory (development) the queue is in memory and that is logged;
  production refuses to start without one.
- **What players see:** every member of the room receives the same `awards` message (the rows computed from the
  envelope, without account ids) with `sync` = `saving` → `saved`, or `pending` (shown as **"Pending sync: the result is
  safe on the server and will be added to accounts once storage is back. It is never counted twice."**) → `saved` once
  the queue stores it; `failed` only for a conflicting result. A reconnecting client gets the result and the awards
  replayed.

## Profile view

Account screen (signed in): driver name, total career points, wins/seconds/thirds, races, verified personal bests by
circuit and mode (with lap number and date, older layouts marked), and the ten most recent results (date, mode,
championship round, circuit, position/field or DQ/DNF, points). Read from `GET /api/profile/stats` for the session's
account only; an answer for a different account than the tab shows (another tab switched the cookie) is dropped.
A rename changes only `profiles.display_name`: the ledger keys on the account id, so history and attribution stay.

## Browser flows

- **Online menu:** Multiplayer (create/join), Connected solo, and, when signed in, **Connected championship** (round N of
  4 on the local championship calendar circuit; the server refuses any other circuit for that round). Progress is kept
  per account in account-scoped storage (`srgp.acct.<id>.cchamp`, cleared on sign-out/switch); it only labels rounds,
  each round's points come from that race alone.
- **Online results:** a Career points block with each credited driver's points and the sync state; guests are told to
  sign in; AI/guest rows are explained.
- **Local races and championships:** when the server offers accounts, the result screen says local races stay on the
  device and verified points need a connected server-run race. Offline play is unchanged.

## Production activation (owner)

Nothing here was run against production; no host, DNS, Nginx, systemd unit or provider was touched. It ships inside the
room server release and is activated by the [runbook](online-server.md#production-activation-runbook-owner) with these
additions:

1. Before migrating: `pg_dump` backup ([accounts.md](accounts.md#backup-and-restore)).
2. Install the updated unit file (it adds `StateDirectory=slotrush-server`, which creates `/var/lib/slotrush-server`
   owned by the service user, mode 0700, writable under `ProtectSystem=strict`): `sudo cp …/deploy/server/slotrush-server.service /etc/systemd/system/ && sudo systemctl daemon-reload`.
3. Add to `/etc/slotrush-server/env`: `SLOTRUSH_SPOOL_DIR=/var/lib/slotrush-server/spool` and
   `SLOTRUSH_CAREER_POINTS=10,6,4`. (Without the spool variable the production service refuses to start.)
4. Step 6 applies `003_career_awards_bests`; `admin status` must list it.
5. Step 8: `/api/health` must show `"career":true,"scoring":"career-1:10-6-4","pendingResults":0,"db":"ok"`.
6. After the client is enabled: sign in on a phone and a desktop browser, race one connected solo race to the finish,
   check the points and podium count on both browsers' account screens, rename, and check the history stays.
7. Watch `pendingResults` in health and `result.spooled` / `result.retry_stored` in the journal. Spool files are small
   JSON (a few KB per race); the directory should be empty in normal operation.

**Resource impact:** one extra transaction of a few rows per race and one read per profile view; no extra process,
thread or timer beyond a single retry timer while something is queued. The measured limits in
[online-server.md](online-server.md#resource-limits) (6-room cap, under 100 MB RSS at the cap) are unchanged in kind;
see [career-evidence.md](career-evidence.md) for the measurement of this build.
