# Online room server (#22)

An authoritative server for private rooms of up to four human drivers, plus server-hosted solo, championship-round and practice sessions. The server owns one race simulation per room. Clients send held controls and numbered actions and receive the race state. The browser lobby and race screens are a later task. Accounts exist (username and password, no email). Awards and cloud statistics are not implemented.

**Status.** Everything is built and verified locally ([evidence](online-evidence.md)). Production multiplayer is **not active**. Nothing was installed on any host. The deployed static client keeps online play off. The owner activates it with the [runbook](#production-activation-runbook-owner) below. It stays unavailable until the real endpoint passes the health and connection checks.

## Architecture

- **One Node 22 process** (`server/`, bundled to `server-dist/main.mjs`). It serves HTTP `/api/*` and WebSocket `/ws` on `127.0.0.1:8787`. On the production host, Nginx proxies both on `slotrush.jdwd40.com`, so the page and the server share an origin and there is no CORS.
- **Rooms share one thread and one tick loop.** `RoomManager` runs `pump(now)` on every room every 10 ms. Rooms share no mutable state: each race has its own `Track` context, seeded RNG, inputs and events. The host has one vCPU, so there are **no worker threads**. A fault in one room aborts only that room's race (no result is produced) and closes the room.
- **The mutable-track hazard from #21 is fixed.**
  - `trackFor()` contexts are deep-frozen and shared read-only. `BAYS` is frozen.
  - `fuelRate()` no longer defaults to the displayed track's length.
  - The server builds races only with `trackById()`, which rejects unknown ids instead of falling back to circuit 1.
  - The server never calls `setTrack()`.
  - Three existing tests had been pushing lane switches into the shared circuit-1 context. That change leaked into every later race in the same test file. They now use a private copy (`addSwitch` in `test/helpers.ts`).
- **The race core gained two things.** These are additive, and the browser game's behaviour is unchanged:
  - `RaceOpts.runOn: 'live'`: once every human is terminal, the AI field keeps stepping normally. There is no 240 s synchronous run-out (which measured 330 ms of blocked event loop). The server runs this run-on at 8 steps per tick.
  - `Race.retire(id)`: DNF `retired`, or DQ `deadline` if a service breach is latched, so leaving never escapes a DQ.
- **Shared protocol and client.** `src/net/protocol.ts` holds the message types, limits and validator. `src/net/client.ts` is a client that takes either the browser `WebSocket` or the `ws` package. The headless test clients and the smoke check use it, and so will the browser lobby.

## Rooms, seats and races

| Mode | Humans | AI | Joinable by code | Envelope `mode` |
| --- | --- | --- | --- | --- |
| `multiplayer` | 2–4 (start needs 2) | Optional `aiFill` setting. AI cars are listed in the roster as AI and named "… (AI)" | Yes | `multiplayer` |
| `solo` | 1 | Always 3 | No | `solo`. For later signed-in solo points |
| `championship` | 1 | Always 3 | No | `championship`, plus `championship: { id, round }` |
| `practice` | 1 | None | No | `practice`. Laps only, with validity, for personal bests |

- **Stable IDs.**
  - The room has a UUID `id` and a 6-character `code` from an alphabet without 0/O/1/I/L. The code is case-insensitive and is shareable but not secret.
  - Each participant has an `id` that lasts for the life of the room, across rematches.
  - Each race has a new UUID `raceId`.
  - A participant's race driver ID is their participant ID.
- **Seats.** A join takes the lowest free slot. The slot fixes the car's grid place, race number (7, 11, 3, 24) and own bay (#21). A fifth human gets `full` and nothing changes.
- **Liveries.** The palette has eight distinct colours. A request for a taken livery gets the next free colour, and the room snapshot shows both the colour given and `liveryRequested`, so nobody is silently recoloured. AI cars take colours no human has.
- **Names are not identity.** Names are cleaned of control and bidi characters, limited to 16 characters, and duplicates are allowed. A seat is resumed only with its private token. A signed-in seat also needs the same account, and an account can hold only one seat per room.
- **Readiness and start.**
  - Every participant's `ready` flag is public.
  - Only the host starts the race. The start needs the mode's minimum humans, every other driver ready, and everyone connected.
  - A settings change by the host clears everyone else's ready flag.
  - Starting locks the roster: joins are then refused with `started`, so no late replacement can take a car. The race's own lights countdown follows.
- **Leaving.**
  - In the lobby or results, the seat is freed at once.
  - In a race, the car retires at once. The seat stays reserved (`left`) until the race ends and is then freed.
  - Leaving revokes the reconnect token.
- **Host control is deterministic.** The host keeps control while present and, outside a race, connected. Otherwise control passes to the earliest-joined connected participant, then to the earliest-joined participant still holding a seat. During a race the host has no powers the race depends on, so a host disconnect never pauses or freezes it.
- **Empty rooms close and are forgotten.** The code is released.
- **Results and rematch.** When the race closes, the room moves to `results` and every member receives the envelope. The host may then call `rematch`, which returns to the lobby with the same room and participant IDs; a new race gets a new `raceId`.
- **Authority.** The server simulates everything: positions, collisions, lanes, fuel, pit queues, service, reverse, penalties, lap validity, finish and DQ. The protocol has no message that carries a position, lap time, winner or points, so the validator refuses any such message as `malformed`.

### Disconnects, grace and retirement

- **Controls are neutralized promptly.**
  - When a connection closes, that seat's held controls are neutral from the next step.
  - A connected client must refresh its held controls (the client heartbeat is 250 ms). Controls not refreshed for `SLOTRUSH_INPUT_TIMEOUT_MS` (1000 ms) are neutralized.
  - The server pings every 25 s and terminates a peer that misses a pong.
- **Grace.** A seat is held for `SLOTRUSH_RECONNECT_GRACE_S`: 20 s by default, bounded to 5–120 s. During the grace the car is neutral and coasts to a stop in its lane. Other drivers should avoid it, as with any stopped car. A `resume` with the private token returns the same seat.
  - Lap progress, service debts, penalties and eligibility are race state, so a resume never resets them.
  - Control and action numbering continues: a replayed sequence number is refused.
  - A newer connection supersedes the old one, which is closed with code 4001.
- **Expiry.** In a race, the car is retired (DNF `retired`, or DQ `deadline` with a latched breach) and the seat can no longer be resumed (`expired`). Outside a race, the seat is freed.
- **Slow sockets.** A socket with more than `SLOTRUSH_SEND_BUFFER_MAX` (256 KB) queued is closed (4008) and goes into its grace period. A slow client never buffers without limit.

## Protocol v1

The protocol is JSON text over WebSocket at `/ws`. The first client message must be `{ "t": "hello", "v": 1, "proto": "slotrush" }`. Anything else first gets `hello_required`. A different version gets `nack protocol` and is closed with code 4002. A missing hello is closed after 5 s.

| Client → server | Fields | Notes |
| --- | --- | --- |
| `create` | `name`, `mode`, `settings: { track?, aiFill? }`, `livery?`, `championship?: { id, round }` | Replies `joined` (private) |
| `join` | `code`, `name`, `livery?` | Multiplayer lobbies only |
| `resume` | `room` (id), `participant`, `token` | Same seat within the grace |
| `ready` / `livery` / `settings` / `start` / `rematch` / `leave` | as named | `settings`, `start` and `rematch` are host only |
| `ctl` | `seq`, `up`, `down`, `driver?` | Held pedals. `seq` strictly increases per seat |
| `act` | `seq`, `type: lane \| pit \| defer`, `driver?` | One-shot action, numbered per seat. Answered with `ack` (queued) or `nack` |
| `ping` | `id` | Answered with `pong`, which carries the server time |

| Server → client | Notes |
| --- | --- |
| `welcome` | Server build, rules version and server time |
| `joined` | Public room, `you`, the **private reconnect token** (only here, only to that socket), current `ctlSeq`/`actSeq` |
| `room` | Public room snapshot on every change (`rev` increases). It never contains a token |
| `state` | `tick` (server simulation steps), `now` (server ms), `lagMs`, the race snapshot and the events since the last state. It is sent `SLOTRUSH_SNAPSHOT_HZ` times a second, and at once on a resume |
| `result` | The race's result envelope, sent once |
| `ack` / `nack` | `nack` carries `ref` (message type), `code` and optional `seq`/`detail` |
| `bye` | `left`, `closed`, `shutdown`, `superseded` and so on, then the socket closes |

**Validation.**

- Messages are limited to 512 bytes; 513–1024 bytes gets `too_large`, and frames over 1024 bytes close the socket with 1009.
- Strings are limited to 64 characters.
- The message type must be known, with exactly its fields and their types. Unknown fields, binary frames, non-integer or non-positive sequence numbers and unknown action types are `malformed`.
- Semantic checks:
  - `duplicate`: `seq` equals the last accepted value.
  - `out_of_order`: `seq` is lower.
  - `malformed`: a jump of more than 1024.
  - `forbidden`: a `driver` other than the sender's own seat, a host-only message from a non-host, or a wrong token or account on resume.
  - `not_in_room`: a command before joining.
  - `bad_state`: wrong room state, for example an action outside a race.
- **Rates.** Each socket has a token bucket (`SLOTRUSH_MSG_RATE` 40/s, burst `SLOTRUSH_MSG_BURST` 60). Excess messages get `nack rate`. After more than 3 one-second strikes the socket is closed with 1008. Failed joins and resumes are limited to 20 per minute per client address, and so are failed sign-ins, so room codes cannot be guessed by brute force.
- **Origin and connections.** The `Origin` header must exactly match `SLOTRUSH_ALLOWED_ORIGINS` for WebSocket upgrades (otherwise 403 before the upgrade) and for `/api` POSTs. The path must be `/ws` (otherwise 404). Connections are capped in total and per client address (otherwise 503). The client address is `X-Real-IP` only when the TCP peer is loopback (Nginx).
- **Ordering.** Server ticks and server timestamps order everything. Over one connection (TCP), messages arrive in order. Across reconnects, the per-seat sequence numbers reject anything stale. All members of a room receive the same serialized bytes for every broadcast, so every client sees identical decisions (tested).

Bump `PROTOCOL_VERSION` on any incompatible change. The browser enables online play only when `/api/health` reports exactly its protocol version. The rollout smoke check compares the server's protocol and rules with the build's `server-dist/protocol.json`. `RULES_VERSION` (`race-core-2026.11.1`) is recorded in every envelope. Bump it whenever a simulation change could change a result.

## Timing and overload policy

- Race time advances in fixed `STEP` (1/60 s) steps owed by elapsed wall time. A tick runs at most `SLOTRUSH_MAX_CATCHUP_STEPS` (6) steps.
- Time not yet simulated is a **backlog, never dropped**. Later ticks catch it up, up to 6× real time, and every car is stepped alike, so a stall delays the race for everyone equally and stays fair. `lagMs` is reported in every `state`.
- If the backlog exceeds `SLOTRUSH_OVERLOAD_ABORT_MS` (5 s), the race is **aborted**. Its envelope has `outcome: "aborted"`, `abortReason: "overload"` and `classification: null`. No race time is skipped and no result is invented. Room lifetime expiry, server shutdown (SIGTERM) and room faults use the same aborted envelope.
- New rooms are refused (`overloaded`) while the worst recent tick exceeds 50 ms, and (`unavailable`) at the room cap.
- Once every human is terminal, the AI run-on goes at 8 steps per tick. Nobody is waiting on it in real time.
- The finish window is 90 s with two or more humans and 120 s for solo. The race time limit is 1200 s. Both bound every race.

## Result envelope

`server/envelope.ts` is built once per race, deep-frozen, and sent to every member and to the result sink:

```text
schema, raceId, roomId, mode, championship, outcome (completed | aborted | ended), abortReason,
track { id, version (hash of the circuit definition) }, rules { version, protocol }, settings,
participants [{ id, control, slot, num, bay, name, livery, accountId|null }],
classification (race.final rows: terminal only; null unless completed),
laps [{ driver, lap, time, valid, raceT }],
times { roomCreatedAt, startedAt, greenAt, finishedAt, raceTimeS, ticks }, digest (SHA-256 of the rest)
```

The sink consumes by `raceId` and is idempotent. In PostgreSQL that is `race_results` with `INSERT … ON CONFLICT DO NOTHING`:

- The same envelope again is `duplicate`.
- A different digest for a stored race is refused (`ResultConflict`).
- A trigger makes stored rows immutable.

No account awards are computed.

## Accounts and sessions

- `POST /api/auth/register` and `/api/auth/login` take `{ username, password }`. `POST /api/auth/logout`. `GET /api/auth/me`.
- Usernames are 3–20 characters (`A-Z a-z 0-9 _ -`), stored lower-case, and unique without regard to case. Passwords are 10–128 characters. **No email or other contact detail is collected**, and no table has such a column (tested).
- **Hashing.** The `argon2` package, Argon2id with m=19 MiB, t=2, p=1 (the OWASP minimum profile). Hashes run one at a time, with at most 16 queued (beyond that the reply is 503 `busy`), so a login flood cannot exhaust memory or stall races. Unknown users cost the same hash work as known ones.
- **Sessions.** `express-session` with a PostgreSQL store (`server/sessionStore.ts`, table `sessions`, expired rows pruned every 15 minutes).
  - Cookie: `srsid`, HttpOnly, `SameSite=Strict`, `Secure` in production, 30 days.
  - A new session ID is issued on every sign-in.
  - POSTs need an allowed `Origin` and `application/json`, with a body of at most 4 KB.
  - The WebSocket upgrade reads the same session, so a signed-in seat records its `accountId`.
- **Recovery** is owner-run on the host, with no email: `node server-dist/admin.mjs reset-password <username>`.
  - It reads the new password from stdin. With empty stdin, it generates a 20-character password and prints it once.
  - It sets the new Argon2id hash and deletes every session of that account in one transaction.
  - The command has no network access path. It is tested.

## Configuration

Settings come from environment variables: the systemd `EnvironmentFile`, never the repository or a `VITE_` variable. Every value is validated and bounded. See [`deploy/server/slotrush-server.env.example`](../deploy/server/slotrush-server.env.example) for the full list with production values.

| Variable | Default | Bounds / notes |
| --- | --- | --- |
| `SLOTRUSH_HOST`, `SLOTRUSH_PORT` | `127.0.0.1`, `8787` | Loopback only |
| `SLOTRUSH_ALLOWED_ORIGINS` | Local Vite ports in development | **Required in production**. Exact origins |
| `SLOTRUSH_ROOM_CAP` | 6 | 1–50 |
| `SLOTRUSH_MAX_CONNECTIONS`, `…_PER_IP` | 48, 8 | |
| `SLOTRUSH_RECONNECT_GRACE_S` | 20 | 5–120 |
| `SLOTRUSH_INPUT_TIMEOUT_MS` | 1000 | 250–5000 |
| `SLOTRUSH_SNAPSHOT_HZ` | 20 | 5–60 |
| `SLOTRUSH_MAX_CATCHUP_STEPS`, `SLOTRUSH_OVERLOAD_ABORT_MS` | 6, 5000 | |
| `SLOTRUSH_MSG_RATE`, `SLOTRUSH_MSG_BURST`, `SLOTRUSH_SEND_BUFFER_MAX` | 40, 60, 256 KB | |
| `SLOTRUSH_LOBBY_IDLE_S`, `SLOTRUSH_RESULTS_IDLE_S`, `SLOTRUSH_ROOM_MAX_S` | 1800, 600, 10800 | |
| `DATABASE_URL`, `SLOTRUSH_DB_POOL_MAX` | Unset (guests only, results in memory), 3 | |
| `SLOTRUSH_SESSION_SECRET` | | Required with `DATABASE_URL`, at least 32 characters |
| `SLOTRUSH_COOKIE_SECURE` | 1 in production | |
| `SLOTRUSH_TIME_SCALE` | 1 | Tests only. **Refused in production** |

**Logs** are JSON lines on stdout and stderr (journald under systemd). Reconnect tokens, passwords, cookies and session IDs are never passed to the logger. `redact()` also strips any field with a secret-looking name. Tests assert that no token or password appears in a log line.

## Local commands

```bash
npm ci
npm run build:server && npm run server      # room server on 127.0.0.1:8787 (no DATABASE_URL: guests only)
npm run dev                                 # game on :5173; /api and /ws are proxied to :8787 (vite.config.ts)
VITE_ONLINE=1 npm run dev                   # the same with the online gate enabled (it probes /api/health)
npm run server:smoke -- http://127.0.0.1:8787                  # health, protocol, origin, hello, solo race, leave
node scripts/load-check.mjs http://127.0.0.1:8787 --rooms 6 --humans 4 --seconds 60 --pid <pid>   # resource sample (raise SLOTRUSH_MAX_CONNECTIONS_PER_IP for one-address load)
npm test                                    # includes room, protocol and WebSocket tests; DB tests skip without a database
npm run test:db                             # starts a private PostgreSQL under .local-pg/ (port 55471) and runs the DB tests
node scripts/local-pg.mjs start|stop|env    # that local cluster on its own
npm run pack:server                         # server-bundle/slotrush-server-<rev>.tar.gz (+ .sha256)
node scripts/browser-check.mjs online       # browser gate check (diagnostics only)
```

With a database (local): `DATABASE_URL=$(node scripts/local-pg.mjs env) SLOTRUSH_SESSION_SECRET=$(openssl rand -base64 48) node server-dist/admin.mjs migrate`, then start the server with the same variables.

## Dependencies

Runtime dependencies are pinned exactly in `package.json` and locked in `package-lock.json`:

| Package | Version | Use |
| --- | --- | --- |
| `ws` | 8.22.2 | WebSocket server (and the headless test and smoke clients) |
| `pg` | 8.23.1 | PostgreSQL client and pool |
| `express-session` | 1.19.0 | Sessions (with the project's own PostgreSQL store) |
| `argon2` | 0.45.2 | Argon2id hashing. It ships linux-x64 glibc prebuilds, so the host builds nothing |

Dev dependencies: `esbuild` 0.28.2 (server bundle), `@types/ws` 8.18.2, `@types/pg` 8.23.1, `@types/express-session` 1.19.0, `@types/node` 22.20.5. `three` moved to dev dependencies. Vite bundles it, so it is not a runtime package and stays out of the server release.

## Resource limits

The production unit runs Node with `--max-old-space-size=96`, `MemoryMax=256M` (with `MemoryHigh=200M`), `CPUQuota=60%`, `TasksMax=48` and `SLOTRUSH_ROOM_CAP=6`. Locally measured on the packed release in production mode, with PostgreSQL attached and the same Node flags, on the build host. These are diagnostics, not the production host.

- **Idle:** RSS 75–84 MB, heap about 13 MB.
- **At the cap, 6 rooms × 4 humans racing for 60 s** (24 sockets, 20 state messages a second each): RSS peak 98.7 MB, heap 16 MB, **9.1% of one core**, worst tick 2.1 ms, about 84 KB/s per client (about 2 MB/s, or 16 Mbit/s, in total).
- **What this supports:** the cap of 6 rooms and 24 humans fits under the 150 MB RSS target and the 256 MB limit with headroom. Even if the shared vCPU is three times slower than the build host, 6 racing rooms need about 30% of a core against a 60% quota. Bandwidth is the first constraint to watch. Lower `SLOTRUSH_SNAPSHOT_HZ` to 15 or 10 to cut it proportionally, or raise the cap only after measuring on the host.
- **Hashing:** each Argon2id hash uses 19 MiB. Hashes run one at a time, with `UV_THREADPOOL_SIZE=2`.

## Production design

- **Host:** the existing site host (Node 22, PostgreSQL 17, Nginx), which is shared with other sites. Only this site's files and units are added. No other site, the shared Nginx `http {}` config, DNS or the restricted static deploy identity is touched.
- **Service:** `slotrush-server.service` ([unit](../deploy/server/slotrush-server.service)), running as the unprivileged system user `slotrush-server`.
  - It runs from `/srv/slotrush-server/current`, a symlink to `/srv/slotrush-server/releases/<name>`, with the configuration in `/etc/slotrush-server/env` (`root:slotrush-server` 0640).
  - It restarts on failure, uses the resource limits above, and is sandboxed (`ProtectSystem=strict`, no capabilities, no new privileges, private `/tmp`).
- **Nginx:** [`deploy/nginx/slotrush.jdwd40.com.online.conf`](../deploy/nginx/slotrush.jdwd40.com.online.conf) is the current static site plus `location = /ws` (WebSocket upgrade, Origin passed through, 75 s read timeout against the server's 25 s pings) and `location /api/` (8 KB bodies, no-store). The upstream is loopback port 8787. The static-only file remains the rollback target.
- **Database:** a dedicated PostgreSQL 17 database `slotrush`, owned by a dedicated login role `slotrush` (no superuser, createdb or createrole, connection limit 6). Migrations run explicitly with `admin.mjs migrate`. The service refuses to start (exit 78) on a schema it does not match. This is the rollout compatibility check, along with the protocol check below.
- **CI:** the new `server` job uses a throwaway `postgres:17` service container and **no secrets**:
  - runs the database tests on PostgreSQL 17
  - builds and packs the release with the locked production dependencies
  - starts the packed release in production mode against a migrated database and runs the smoke check
  - uploads `slotrush-server-<sha>` (tarball and SHA-256) for 30 days

  The existing static `check` and `deploy` jobs are unchanged and do not depend on it. **No CI job deploys the server.**
- **Client gate:** the deployed static build has no `VITE_ONLINE`, so online play is off and the page never requests `/api` or `/ws` (tested in the browser). An online-enabled build (`VITE_ONLINE=1`) still enables nothing until `/api/health` answers `ok` with the client's exact protocol version. The bundle contains no secret: the endpoint is the page's own origin.

### Production activation runbook (owner)

These steps run as an administrator on the site host (`ssh app-vps`). None of them were run for this issue. Keep a terminal open on the host, and back up each file before replacing it in `/etc/nginx/config-backups/slotrush-<UTC timestamp>/`, as in [deployment.md](deployment.md).

1. **Release.** Download the `slotrush-server-<sha>` artifact from a green `main` CI run (or run `npm ci && npm run build:server && npm run pack:server` on a linux-x64 machine with Node 22). Copy it to the host and verify it there:

   ```bash
   sha256sum -c slotrush-server-<rev>.tar.gz.sha256
   node --version    # must be v22.12 or later
   ```

2. **User and directories** (once):

   ```bash
   sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin slotrush-server
   sudo install -d -o root -g root -m 0755 /srv/slotrush-server /srv/slotrush-server/releases
   sudo install -d -o root -g slotrush-server -m 0750 /etc/slotrush-server
   ```

3. **Database and role** (once, as the `postgres` superuser). Generate the password with `openssl rand -hex 24`:

   ```sql
   CREATE ROLE slotrush LOGIN PASSWORD '<db password>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 6;
   CREATE DATABASE slotrush OWNER slotrush ENCODING 'UTF8' TEMPLATE template0;
   REVOKE ALL ON DATABASE slotrush FROM PUBLIC;
   ```

   Confirm that `pg_hba.conf` already allows `scram-sha-256` from 127.0.0.1 for this role. Do not widen it.

4. **Configuration.** Copy `deploy/server/slotrush-server.env.example` to `/etc/slotrush-server/env` (`root:slotrush-server`, mode 0640). Set `DATABASE_URL` and `SLOTRUSH_SESSION_SECRET` (`openssl rand -base64 48`), and keep `SLOTRUSH_ALLOWED_ORIGINS=https://slotrush.jdwd40.com`. Do not paste these values anywhere else.

5. **Install the release** (root-owned and read-only to the service):

   ```bash
   sudo tar -C /srv/slotrush-server/releases -xzf slotrush-server-<rev>.tar.gz
   sudo chown -R root:root /srv/slotrush-server/releases/slotrush-server-<rev>
   sudo ln -sfn releases/slotrush-server-<rev> /srv/slotrush-server/current.new && sudo mv -T /srv/slotrush-server/current.new /srv/slotrush-server/current
   ```

6. **Migrate**, then check the schema:

   ```bash
   cd /srv/slotrush-server/current
   sudo -u slotrush-server sh -c 'set -a; . /etc/slotrush-server/env; set +a; node server-dist/admin.mjs migrate && node server-dist/admin.mjs status'
   ```

7. **Service:**

   ```bash
   sudo cp /srv/slotrush-server/current/deploy/server/slotrush-server.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now slotrush-server
   systemctl status slotrush-server
   journalctl -u slotrush-server -n 50
   ```

   If `/usr/bin/node` is not the Node 22 binary (check with `command -v node`), adjust `ExecStart` first.

8. **Local gate on the host, before Nginx:**

   ```bash
   curl -fsS http://127.0.0.1:8787/api/health
   cd /srv/slotrush-server/current && node scripts/server-smoke.mjs http://127.0.0.1:8787 --origin https://slotrush.jdwd40.com --expect server-dist/protocol.json
   ```

   Every line must be `PASS`. Check the memory use with `systemctl show slotrush-server -p MemoryCurrent`.

9. **Nginx** (only after step 8 passes). Back up `/etc/nginx/sites-available/slotrush.jdwd40.com`. Copy `deploy/nginx/slotrush.jdwd40.com.online.conf` over it. Then run `sudo nginx -t && sudo systemctl reload nginx`. If `nginx -t` fails, restore the backup and do not reload.

10. **Public gate.** Run `node scripts/server-smoke.mjs https://slotrush.jdwd40.com --origin https://slotrush.jdwd40.com --expect server-dist/protocol.json` from any machine with the release. It must pass over real TLS through Nginx.

11. **Client.** Only after step 10 passes, enable online play in the deployed client. Set `VITE_ONLINE: '1'` on the `npm run build` step in `.github/workflows/ci.yml`; that is a public build flag, not a secret. Then push to `main`. That build still enables online play only while the health check passes. The browser lobby is the follow-up task, so until it lands this flag has no visible effect.

12. **Account recovery:** `sudo -u slotrush-server sh -c 'set -a; . /etc/slotrush-server/env; set +a; cd /srv/slotrush-server/current; node server-dist/admin.mjs reset-password <username>'`. Type the new password on stdin, or send empty input (`< /dev/null`) to generate one, which is printed once.

**Upgrades.**

- Install a new release beside the old one (step 5 with the new name), run `migrate` (migrations are additive), switch `current`, and run `sudo systemctl restart slotrush-server`.
- A restart aborts races in progress. They get aborted envelopes, never results. Restart when `/api/health` shows `racing: 0` if possible.
- Re-run steps 8 and 10.
- If the protocol version changed, deploy the matching static client in the same window. Until then, the health check keeps an older client's online play off.

### Rollback

- **Server release:** point `current` back at the previous release directory (`ln -sfn releases/<previous> current.new && mv -T current.new current`), then `sudo systemctl restart slotrush-server`, then re-run step 8. Migrations are additive and the old release ignores newer tables. If a migration ever must be reverted, restore the database from the backup taken before step 6 (`pg_dump -Fc slotrush > slotrush-<ts>.dump`).
- **Turn online play off entirely:** restore the backed-up static-only Nginx site file, run `nginx -t`, and reload Nginx. `/api` and `/ws` then return 404, the client's health check fails, and online play stays off. Then run `sudo systemctl disable --now slotrush-server`. The static game is unaffected throughout.
- **Client:** remove `VITE_ONLINE` from the build and push, or roll back the static release with the existing receiver (`deployment.md`). Local saves (records, ghosts and championships) are never touched by the server or by either rollback.
- **Revoke database access:** `ALTER ROLE slotrush NOLOGIN`. Remove the service user and `/etc/slotrush-server` only after the service is disabled.
