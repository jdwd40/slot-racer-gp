# Online room server (#22)

An authoritative server for private rooms of up to four human drivers, plus server-hosted solo, championship-round and practice sessions. The server owns one race simulation per room. Clients send held controls and numbered actions and receive the race state. The browser lobby and online race screens are described in [online-client.md](online-client.md). Accounts exist (username and password, no email). Awards and cloud statistics are not implemented.

**Status.** Production multiplayer is **active** on `https://slotrush.jdwd40.com`: the owner ran the [activation runbook](#production-activation-runbook-owner) below, and the deployed static client is built with `VITE_ONLINE=1`. Local verification is in the [evidence](online-evidence.md). The static client is deployed automatically by CI; the room server is upgraded by hand with the [release procedure](#release-procedure-owner). Green CI is not four-player browser or accelerated-hardware validation; that is #4.

## Architecture

- **One Node 22 process** (`server/`, bundled to `server-dist/main.mjs`). It serves HTTP `/api/*` and WebSocket `/ws` on `127.0.0.1:8787`. On the production host, Nginx proxies both on `slotrush.jdwd40.com`, so the page and the server share an origin and there is no CORS.
- **Rooms share one thread and one tick loop.** `RoomManager` runs `pump(now)` on every room every 10 ms. The timer runs only while at least one room exists (no idle wakeups). Rooms and races are timed from their own wall timestamps, so restarting it after an idle period catches nothing up. Rooms share no mutable state: each race has its own `Track` context, seeded RNG, inputs and events. The host has one vCPU, so there are **no worker threads**. A fault in one room aborts only that room's race (no result is produced) and closes the room.
- **The mutable-track hazard from #21 is fixed.**
  - `trackFor()` contexts are deep-frozen and shared read-only. `BAYS` is frozen.
  - `fuelRate()` no longer defaults to the displayed track's length.
  - The server builds races only with `trackById()`, which rejects unknown ids instead of falling back to circuit 1.
  - The server never calls `setTrack()`.
  - Three existing tests had been pushing lane switches into the shared circuit-1 context. That change leaked into every later race in the same test file. They now use a private copy (`addSwitch` in `test/helpers.ts`).
- **The race core gained two things.** These are additive, and the browser game's behaviour is unchanged:
  - `RaceOpts.runOn: 'live'`: once every human is terminal, the AI field keeps stepping normally. There is no 240 s synchronous run-out (which measured 330 ms of blocked event loop). The server runs this run-on at 8 steps per tick.
  - `Race.retire(id)`: DNF `retired`, or DQ `deadline` if a service breach is latched, so leaving never escapes a DQ. Since rules `race-core-2026.11.2` (#44) the retired car also leaves the track; see *Disconnects, grace and retirement*.
  - Since rules `race-core-2026.11.3` (#69) a human car stopped on the racing lane for 3 s of simulation time (not held by the pit queue, the squeeze or automatic control, and not trapped behind a car ahead) is moved back to its own bay: [stopped-on-track recovery](auto-bay.md#stopped-on-track-recovery). The server's race core owns the count and the recovery.
  - Since rules `race-core-2026.11.4` (#74) a car whose driver is **away** (link down, see *Disconnects, grace and retirement*) is exempt from that rule: it is held where it stopped, out of traffic, until the driver is back or the hold expires. The server decides away and passes it to the race core in the step input (`Input.away`).
- **Shared protocol and client.** `src/net/protocol.ts` holds the message types, limits and validator. `src/net/client.ts` is a client that takes either the browser `WebSocket` or the `ws` package. The headless test clients, the smoke check and the browser's online session (`src/net/session.ts`) use it.

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
- **Away (#74, rules `race-core-2026.11.4`).** An in-race seat is *away* while its connection is gone (the reconnect hold below), or while it has a connection but no `ctl` has arrived for more than `LINK_AWAY_MS` (1500 ms, `server/room.ts`). The second case is the usual mobile drop: the socket dies silently and the server only notices at its next ping (25 s) or when the client's 4 s watchdog reconnects. 1500 ms is above `SLOTRUSH_INPUT_TIMEOUT_MS` (1000 ms) with a margin for a browser throttling its timers in the background, so a live client that is briefly slow is not taken for a lost one. Away ends with the resume, or with the first `ctl` on a live socket.
  - The server decides it from its own clock, never a client. `Room.inputs()` sends an away seat's step input as neutral pedals plus `away: true`, so it is as deterministic and replayable as the pedals. The control clock (`ctlAt`) starts with the race, since nothing is sent in the lobby.
  - **The hold window applies to a silent socket too.** A seat whose socket is still open but which has sent no `ctl` for longer than `SLOTRUSH_RECONNECT_GRACE_S` ends, while its car is still racing, exactly like a closed one whose grace ran out: the server closes the socket (4000 `no controls`; a live page then reconnects and is told its seat expired) and drops the seat, so the car retires (DNF `retired`, DQ with a latched breach) and parks. It is logged as `room.grace_expired` with `silent: true`. Without this a half-open link could keep a car held for as long as the socket stayed open. A finished (or already retired) car is left alone: it affects nobody, and a finished driver whose tab is hidden (browsers throttle a hidden tab's timers to about once a minute after 5 min) must still get the result and the rematch.
  - **A server stall is not a client's silence.** Controls that arrive while the server's event loop is blocked (GC, overload) are only read after the next pump, so a long stall would otherwise make every seat away at once. When a room's pump comes more than `PUMP_STALL_MS` (250 ms; it is normally pumped every 10 ms) after the previous one, the excess is not counted against any connected seat's control clock. Silence that had built up before the stall still counts, and a stall long enough to abort the race (`SLOTRUSH_OVERLOAD_ABORT_MS`) still does.
  - In the race core an away car stays in traffic while it is still moving: neutral pedals, it bumps and can be bumped, and its stopped count is held at 0. Once it has stopped (slower than `STALL.stopV`, 1 m/s) on the racing lane it is **held**, unless automatic pit control is driving it (`sgCtl`: the controller takes it on into the pits when its turn comes, so the queue behind it moves as before). A held car is out of traffic for every check that reads other cars, through one predicate (`outOfTraffic()`, `src/traffic.ts`): collisions, the AI's following and defending, automatic pit control's following, the shared pit queue, box order and bay reservations (a held car is not pit traffic), the squeeze priority queue (it is taken out while held and put back at its physical place if it rejoins inside the squeeze), lane-change, merge and re-slot clearance, and who traps whom for the stopped-on-track rule. Others drive through its spot, as through a parked car. It stands on its brakes whoever would drive it (its driver, automatic stop-and-go control, or the AI that drives a finished car). It gains nothing: its place on the lap, lap validity, fuel and every debt and deadline run on unchanged. A service deadline is not exempt: carried over its last chance it breaches as before. In the pit lane, a bay or a service nothing changes.
  - When the driver is back, a held car rejoins traffic, and only then gets its pedals back, as soon as no car in traffic is really inside it (less than a car length of slot apart; bumper-to-bumper contact is not inside) and no car closing from behind, on its lane or changing lanes into it, could fail to stop short of it: clear slot more than `rel × 0.5 s + rel² / (2 × BRAKE) + 1 m` (`AWAY_REJOIN`, `BRAKE` = 30 m/s²). That wait for closing cars is capped at 2 s after the driver is back. It rejoins with the re-slot contact grace (`graceT = PEN.grace`, 1.5 s), so a contact in that time is judged against neither car. So it can never be driven through anything and contact is judged normally afterwards. The grace does not stop it shoving the car ahead, but since rules `race-core-2026.11.5` (#76) the shoved car is protected as when a connected driver shoves it: it is not blamed for its own contact with the next car (no offence, no voided lap), so the return never gets anyone else penalised either. A car inside it is in traffic and not trapped by it, so it drives on or (a stopped human car) is recovered by its own three-second count; two held cars inside each other ignore each other and rejoin together, and the ordinary collision step then separates them in their order on the slot. A stop after the return gets a fresh three seconds.
  - Snapshots carry `away: true` for a held car (absent otherwise; additive and optional, so protocol 2 is unchanged). Every client draws it dimmed.
- **Grace.** A seat is held for `SLOTRUSH_RECONNECT_GRACE_S`: 20 s by default, bounded to 5–120 s. During the grace the car is neutral, coasts to a stop in its lane and is held there out of traffic (away, above), so it neither blocks the lane nor is moved to the pits. A `resume` with the private token returns the same seat with the car where it stopped. (From #69 until #74 a disconnected car had no immunity: 3 s after it stopped it was moved back to its bay with the lap voided, which the banner's "your car is held" did not say.)
  - Lap progress, service debts, penalties and eligibility are race state, so a resume never resets them.
  - Control and action numbering continues: a replayed sequence number is refused.
  - A newer connection supersedes the old one, which is closed with code 4001.
- **Expiry.** In a race, the car is retired (DNF `retired`, or DQ `deadline` with a latched breach) and the seat can no longer be resumed (`expired`). Outside a race, the seat is freed. Leaving a race on purpose retires the car the same way.
- **A retired car leaves the track** (rules `race-core-2026.11.2`, #44). Before, nobody drove it but the AI that drives a finished car's cool-down lap took it over, so it kept circulating at about 10 m/s for the rest of the race.
  - Nobody drives it: both pedals are released and it coasts to a stop in its lane (under 3 s from top speed). It is still a car on the slot while it rolls, so contact with it is real, but it is never judged as an offence.
  - Once it is at rest, or at the latest `RETIRE_COAST_MAX` (4 s) after retiring whatever its speed (a car held against it from behind on full throttle could otherwise keep it rolling for ever), it is parked in its own bay: mode `off` (as for a de-slot) with `off` placing it in the bay, `v` 0. Collisions, the AI's following, pit traffic, lane-change and merge clearance and the squeeze queue all ignore an `off` car, so the cars behind drive through the spot where it stopped. It stays parked through the run-on and the end of the race.
  - In its bay, on the grid (retired during the countdown) or under tow it is parked at once. De-slotted, it is parked when it lands instead of being put back on the slot.
  - The classification is unchanged: DNF `retired` (or DQ `deadline`), ordered among the DNFs by the distance it had covered (`u` is kept).
  - Snapshots show it as such (`mode: 'off'`, `v: 0`, `off` in the bay). The browser mirror draws it parked in the bay; the wire format is unchanged.
- **Slow sockets.** A socket with more than `SLOTRUSH_SEND_BUFFER_MAX` (256 KB) queued is closed (4008) and goes into its grace period. A slow client never buffers without limit. The state stream is held to the wall-clock snapshot rate in every phase (see *Snapshot rate*), so a link that keeps up with ordinary racing also keeps up with the AI run-on and a catch-up (#49).

## Protocol v2

The protocol is JSON text over WebSocket at `/ws`. The first client message must be `{ "t": "hello", "v": 2, "proto": "slotrush" }`. Anything else first gets `hello_required`. A different version gets `nack protocol` and is closed with code 4002. A missing hello is closed after 5 s.

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
| `state` | `tick` (server simulation steps), `now` (server ms), `lagMs`, `ev` (the events since the last state) and the race snapshot as a keyframe or a delta (see *State messages*). It is sent `SLOTRUSH_SNAPSHOT_HZ` times a second of wall time (see *Snapshot rate*), and at once on a resume. Each car can carry the optional #69 fields `stallT`, `stallHold` and `stallSvc`, and the events can include `{ type: 'recover', car }` (see below) |
| `result` | The race's result envelope, broadcast once when the race closes. A resume into `results` gets the same envelope again, after `joined` and `state`, so a driver whose link dropped at the finish still receives it |
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
- **Room creation allowance (#52).** The room cap is small and an idle lobby lives for 30 minutes, so without a limit one client address could take every room with a few `create` messages. Only **creating** is limited; joining and resuming are not (beyond the failed-join limit above).
  - A room is charged, when it is created, to its creator's **client address** and, if signed in, **account**. It stays charged to them until it **closes** (left empty, idle, lifetime, fault or shutdown), whoever hosts it by then. Host transfer, the creator leaving it to others, disconnecting, resuming, new sockets, and signing in, out or as another account change nothing, so none of them frees or resets the allowance. A create that fails (cap, `overloaded`, bad settings, a bad name) is not charged.
  - **Open rooms:** at most `SLOTRUSH_ROOMS_PER_IP` (3) per address and `SLOTRUSH_ROOMS_PER_ACCOUNT` (2) per account. Refused with `nack` `unavailable` (the room-cap code: the browser says there is no room free right now and to try again in a minute) and a `detail` naming the limit.
  - **New rooms:** at most `SLOTRUSH_ROOM_CREATES` (20) per address and per account in any `SLOTRUSH_ROOM_CREATE_WINDOW_S` (600 s) sliding window, so a fast burst and slow create/leave churn are both bounded. Refused with `nack` `rate` (the browser says too many attempts, wait and try again) and a `detail` with the wait in seconds.
  - **Why per address and per account.** Guests have no identity of their own (every new socket is a new guest), so the address is what bounds them. The account limit bounds a signed-in player who also has other addresses. 3 of 6 rooms per address means one address never holds the whole service, while a household behind one NAT address still runs a multiplayer room that everyone joins plus two solo or practice sessions. If the owner raises `SLOTRUSH_ROOM_CAP`, keep `SLOTRUSH_ROOMS_PER_IP` below it.
  - Diagnostics from one address: `server:smoke` creates one solo room per run, and its race finishes about 20 s after it leaves, so at most 3 runs in that time succeed. `scripts/load-check.mjs` needs `SLOTRUSH_ROOMS_PER_IP` at least `--rooms` (and `SLOTRUSH_MAX_CONNECTIONS_PER_IP` at least rooms × humans) for that run.
  - The address is the one the connection limit uses (next item): a forwarded header from anything but the local Nginx is ignored, so rotating it does not escape the limit. Bookkeeping is per open room plus at most 10,000 recent-create windows, which expire. No protocol change: both codes already exist and the client is unchanged. Tests: `test/server/roomquota.test.ts`.
- **Origin and connections.** The `Origin` header must exactly match `SLOTRUSH_ALLOWED_ORIGINS` for WebSocket upgrades (otherwise 403 before the upgrade) and for `/api` POSTs. The path must be `/ws` (otherwise 404). Connections are capped in total and per client address (otherwise 503). The client address is `X-Real-IP` only when the TCP peer is loopback (Nginx).
- **Ordering.** Server ticks and server timestamps order everything. Over one connection (TCP), messages arrive in order. Across reconnects, the per-seat sequence numbers reject anything stale. All members of a room receive the same serialized bytes for every broadcast, so every client sees identical decisions (tested).

**Stopped-on-track recovery on the wire (#69).** #69 added these within protocol 1, as backward-compatible additions; since v2 they travel like every other dynamic field (*State messages*):

- Each `CarSnapshot` gained three optional fields: `stallT`, the seconds counted towards recovery (0 when no countdown runs); `stallHold`, recovered and waiting for its bay; and `stallSvc`, in its bay after a recovery, where no fuel is added. The mirror copies them only when present, and a snapshot without them reads as no countdown.
- The recovery is one ordinary race event in `state.ev`, `{ type: 'recover', car: <driver id> }`, with the driver's `msg.stallRecovered` message alongside. A client that does not know the event type ignores it.
- No message type, field of a client message or message loop was added, and the snapshot rate and its cap are unchanged.
- The browser gates online play on `protocol` only; the rules are compared only by the deploy smoke check, between the server and its build. Under protocol 1 a tab with a bundle from before #69 could race on a #69 server without the countdown or `recover` toast. Since v2 every bundle before #67 is refused (see *Mixed versions*), so a tab racing on a v2 server always knows these fields. A future rules change within one protocol has the same caveat: reload such tabs after a rules upgrade.

### State messages

Since v2 (#67) a `state` does not carry the whole `Race.snapshot()`. That was about 70 fields per car as plain JSON, about 5 KB a message and 97 KB/s per player at 20 Hz, with WebSocket compression off on purpose (Nginx strips `Sec-WebSocket-Extensions`, and neither end negotiates permessage-deflate; that stays so). The encoding is `src/net/snapwire.ts`, shared by the server and every client:

```json
{"t":"state","tick":3,"now":1762862400000,"lagMs":0,"ev":[],"key":1,
 "static":{"race":"<raceId>","cars":[{"id":"<participant>","slot":0,"control":"human","name":"Ann","color":16763930,"num":7,"bay":0}, …]},
 "snap":{"v":1,"track":"circuit-1","laps":13,"practice":false,"phase":"countdown","t":0.05,"raceTime":0, …,
         "cars":[{"status":"running","mode":"grid","u":19.1,"v":0,"d":-0.5, …,"fuel":1,"lapStartT":0, …,"upPrev":false}, …]}}
{"t":"state","tick":600,"now":1762862409950,"lagMs":0,"ev":[],"base":597,
 "snap":{"t":10,"raceTime":4.933,"cars":[{"u":110.681,"v":23.052,"x":55.166,"y":60.712,"h":1.817,"wobble":0.282,"fuel":0.941,"hiU":110.681},
                                        {"u":108.363,"v":11.37,"y":58.284,"hiU":108.363}]}}
```

(Abridged; `…` marks omitted fields and cars.)

- **Static fields** (`CAR_STATIC`: `id`, `slot`, `control`, `name`, `color`, `num`, `bay`) never change during a race. They go once per race, in `static` with the race id: in the first state of the race and in every resume state. Both are keyframes. `snap.cars` lists the cars in the order of `static.cars`, by position.
- **Every other field** is listed in `RACE_FIELDS` (race level) or `CAR_DYNAMIC` (per car) with its wire precision. The table is checked against the snapshot type at compile time, so a new snapshot field does not build until it is listed, and adding one is one line there (plus `CAR_FIELDS` in `src/net/mirror.ts` for the mirror to copy it).
- **Keyframe** (`key: 1`): every dynamic field of every car and every race-level field. **Delta** (`base`: the tick of the state broadcast just before it): only the fields whose encoded value changed since then, `{}` for an unchanged car, nothing for an unchanged race-level field. Objects (`change`, `off`, `pit`, `final`, `lastSeq`) are compared by value and sent whole when they change. An optional field that was present and is now absent is listed in that car's `"-"` array, so present → absent → present round-trips exactly.
- **Precision.** Fields that change almost every step are rounded to 3 decimals on the wire: race `t` and `raceTime` (1 ms); per car `u`, `v`, `d`, `laneSide`, `x`, `y`, `z`, `h`, `roll`, `pitch`, `yawOff`, `wobble`, `hiU`, every number inside `off`, `throttle`, `brake` and `fuel`: 1 mm, 1 mm/s, 1 mrad, 0.1% of a pedal or the tank. Everything else, including lap times, the #69 fields (`stallT`, the stopped-on-track countdown, like the other timers; `stallHold`; `stallSvc`), `lapStartT`, penalties, timers and service state, is sent exactly: those change a few times a lap, so rounding would save nothing, and the HUD shows the server's own lap times. A rounded value is within half a unit of its last decimal; `-0` is sent as `0`.
- **Rounding never reaches the race.** The encoder rounds a copy of the snapshot after the step. The simulation, the result envelope, its digest and `RULES_VERSION` are unchanged: the same seed and inputs give the same result digest as before v2 (pinned in `test/server/snapwire.test.ts`).
- **Keyframes** go out at least every `KEYFRAME_MS` (1 s) of race wall time, measured on the same scaled clock as the snapshot slots. Whatever a client lost, it is whole again within a second.
- **Same bytes for everyone.** The room keeps one encoder per race, whose baseline is the last broadcast state. Every member gets the same bytes, and each delta applies to the state they all hold.
- **Resume.** `Room.stateMsg` sends the last broadcast state (at most one snapshot slot old, at the same tick) as a keyframe with `static`. The broadcasts that follow are deltas from that same state, so the resumed socket decodes them at once and gets the same bytes as everyone else from then on. Its events are the ones already sent; the next broadcast carries every event since.
- **Cars appearing or retiring.** The race core never adds or removes a car during a race: a retired, DQ or DNF car stays in the list, and its new `status`, `mode` and `off` travel as ordinary changed fields. If the car list ever did change, the encoder would send a keyframe with a new `static`.
- **Decoding** (`SnapDecoder`, one per connection in `OnlineClient`) rebuilds the full `RaceSnapshot`, rounded as above, so `received`, `latest`, `onMessage`, waiters, `applySnapshot` and `mirrorRace` see the same shape as in v1. A delta whose `base` is not the last decoded state, or anything before the static fields, cannot be decoded. It is dropped whole (counted in `rx.undecodable`), never half-applied, until the next keyframe. Over one ordered connection that does not happen: a new socket starts from its resume state.
- **Size**, a 4-human race on `circuit-1` at 20 Hz in the in-process harness (production `Room`, bots driving, 13 laps, about 229 s): v1 (main at `1b2f865`, with the #69 fields) averaged **5,134 bytes** a state message (about 100 KB/s). v2 averages **612 bytes** (−88%, about 12 KB/s): keyframes about 4.3 KB once a second (the race's first one, with `static`, 4.3 KB), deltas about 420 bytes. Before #69 the same race measured 4,950 → 603 bytes. Asserted under 1.5 KB in `test/server/snapwire.test.ts`.

Bump `PROTOCOL_VERSION` on any incompatible change. History: 1, the first online protocol; 2, `state` as keyframes and deltas with the static car fields once per race (#67). The browser enables online play only when `/api/health` reports exactly its protocol version. The rollout smoke check compares the server's protocol and rules with the build's `server-dist/protocol.json` (written by `npm run build:server` from `src/net/protocol.ts`), checks that the previous protocol's hello is refused, and that a race streams a keyframe with `static` and then deltas. `RULES_VERSION` (`race-core-2026.11.5`) is recorded in every envelope. Bump it whenever a simulation change could change a result. History: `race-core-2026.11.1` first online rules; `race-core-2026.11.2` retired cars leave the track (#44); `race-core-2026.11.3` a human car stopped on the racing lane for 3 s is moved back to its own bay (#69); `race-core-2026.11.4` a car whose driver is away (disconnected, or no controls for 1.5 s) is held where it stopped, out of traffic, and exempt from that rule (#74); `race-core-2026.11.5` a car shoved by a car with contact grace (an away car's rejoin, a re-slot or a pit exit) is not blamed for its own contact with the car ahead: no offence and no voided lap, as when a connected driver shoves it (#76). Personal bests are stored per rules version (`personal_bests` key, [career.md](career.md)), so a bump starts a new set of personal bests for races on the room server (multiplayer and every other online mode); laps set under an older version are kept apart.

**Mixed versions.** A page and a server of different protocols never race together:

- **An old page against a newer server** (a browser with a cached v1 bundle). Its health check sees another protocol and keeps online play off. A page that passed the check before the upgrade has its hello refused (`nack protocol`, close 4002). A v1 page then says *This page is out of date for the game server. Reload the page to update.*; a resume after the restart is refused the same way and its seat expires. It is never sent a v2 state. From v2 on, the page itself says *A new version of Slot Rush is available. Reload to play online.* with a **Reload** button: on the title screen when `/api/health` reports a newer protocol, after a create, join or resume whose hello is refused with `protocol`, and when a reconnect is refused that way (session end `outdated`, no retry loop).
- **A new page against an older server** (the static client is released before the server is upgraded): the health check sees an older protocol and the page offers local play only until the server is upgraded. Reloading would not help, so it shows the ordinary *Online play is unavailable* note.

## Timing and overload policy

- Race time advances in fixed `STEP` (1/60 s) steps owed by elapsed wall time. A tick runs at most `SLOTRUSH_MAX_CATCHUP_STEPS` (6) steps.
- Time not yet simulated is a **backlog, never dropped**. Later ticks catch it up, up to 6× real time, and every car is stepped alike, so a stall delays the race for everyone equally and stays fair. `lagMs` is reported in every `state`.
- If the backlog exceeds `SLOTRUSH_OVERLOAD_ABORT_MS` (5 s), the race is **aborted**. Its envelope has `outcome: "aborted"`, `abortReason: "overload"` and `classification: null`. No race time is skipped and no result is invented. Room lifetime expiry, server shutdown (SIGTERM) and room faults use the same aborted envelope.
- New rooms are refused (`overloaded`) while the decayed recent-load signal (`tickLoadMs`, see *Tick statistics*) exceeds 50 ms, and (`unavailable`) at the room cap.
- Once every human is terminal, the AI run-on goes at 8 steps per tick. Nobody is waiting on it in real time.

### Tick statistics

`/api/health` reports what the tick loop costs (#54). Every figure is in milliseconds.

- **What is timed.** `ticks` is the work of one tick: `RoomManager.tick()` pumping every room once (simulation steps, snapshots, broadcasts, finishes and result hand-off), measured with the monotonic clock. `tickLag` is the tick timer's lateness: how much later than 10 ms after the previous timer tick this one started. That is event-loop delay as the tick loop sees it, including about 1 ms of timer granularity. It is not counted across a stopped timer (no rooms), so an idle period is never lag.
- **Windows.** Each has `recent` and `total`. `recent` is a rolling window of six 10 s slots of wall time: a sample stays in it for at least 50 s and at most 60 s (`windowS: 60`). `total` covers every sample since the process started and is never reset, so one reader (monitoring, a load check) cannot reset another's view. Neither is reset when the last room closes. `recent` empties on its own once 60 s pass with no ticks.
- **Fields.** `count`, `maxMs` (the exact largest sample, never decayed or sampled), `p50Ms`, `p95Ms`, `p99Ms`, `meanMs` and `sumMs`. `totalBuckets` lists the non-empty histogram buckets of `total` as `[upperMs, count]`.
- **Precision and cost.** Each window is a fixed histogram of 256 log buckets (8 per doubling, 1 µs to about 71 minutes). A percentile is reported as its bucket's upper bound, capped at the exact max. So it is never below the true value and at most about 9% above it. Memory is fixed at about 14 KiB per statistic, whatever the uptime. Recording a tick costs one `Math.log2` and a few array writes. Building the report costs a few thousand additions per health request.
- **Interval reports.** Subtract two readings' `totalBuckets`, `count` and `sumMs` to get an interval's exact sample count, mean and percentiles (`scripts/tick-report.mjs`). Its max is the largest `recent.maxMs` read during the interval. With readings less than 50 s apart, those windows cover every tick in between, so a spike between two polls is in the next report. They can also cover up to 60 s before the first reading.
- **`tickMaxMs` is not a peak.** It keeps its historical name and meaning: the largest tick, decayed by 2% a tick (a 20 ms tick reads 0.36 ms after 2 s of normal ticks). Admission uses it (above), and `tickLoadMs` reports the same value. Use `ticks.recent.maxMs` for the worst tick.
- `cpuUserMs` and `cpuSystemMs` are the process's cumulative CPU time (`process.cpuUsage()`). Two readings give its CPU share over the interval.

### Snapshot rate

Ordinary `state` broadcasts follow **wall time, not simulation progress** (#49). Before, one went out every `60 / SLOTRUSH_SNAPSHOT_HZ` steps, so the 8-steps-per-tick run-on sent 264 a second per client (about 1.2 MB/s) instead of 20, and a catch-up multiplied the rate the same way. On a modeled 256 KiB/s link that closed every finisher with 4008 slow while they waited for the classification.

- Wall time since the race started (scaled by `SLOTRUSH_TIME_SCALE`, which is 1 in production) is cut into slots of `1000 / SLOTRUSH_SNAPSHOT_HZ` ms. At most one state goes out per slot, after the tick's steps, with the latest snapshot. The events of every step since the last state travel with it, in order, so coalescing loses or repeats none. A slot in which the race did not advance sends nothing.
- **Bound:** in any wall interval of W ms a socket gets at most `floor(W × Hz / 1000) + 1` ordinary states, during racing, catch-up and run-on alike, at every supported rate (5–60). On top of that come, once each: the state at the race start, the final state flushed in the same tick as the classification (so the `result` never waits for a slot), and the state sent to a resuming socket alone.
- The race never depends on publication, so results, envelopes and the event stream are unchanged; `RULES_VERSION` stays. The browser draws run-on cars at the newest state 20 times a second; each is about 0.67 s of race (8× speed), beyond the interpolation's 2-unit snap distance, so they step rather than slide, which they did not do before at 264 a second.
- Measured on the issue's fixture (production `RoomManager`, 10 ms ticks, Node 26 on the build host, 256 KiB/s modeled drain; 2 or 3 humans finished by `Race.finishCar`, AI racing on), before → after: run-on states per client in any 1 s 267 → 21, run-on traffic 1,210–1,215 → 92 KiB/s per client, peak queued 257–260 KiB (closed 4008 slow) → 9.5 KiB (no close), every client received the result 0 → 1 time; mean tick cost in the run-on 0.31–0.52 → 0.20–0.36 ms. A 3 s stall's catch-up: 80 → 21 states in the next second. The final classification and the full event stream were identical before and after.
- At 60 Hz the ordinary stream alone was about 245 KiB/s per client in v1 (v2 states are about 8 times smaller, see *State messages*) (276 KiB/s in the run-on, whose snapshots are slightly larger), so a 256 KiB/s link is marginal at that setting whatever the phase; it stayed connected over the measured run-on with up to 161 KiB queued.
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

- `POST /api/auth/register` (`{ username, password, displayName? }`) and `/api/auth/login` (`{ username, password }`). `POST /api/auth/logout`. `GET /api/auth/me`. `GET`/`POST /api/profile` (`{ displayName }`). Driver profiles, name rules, session-expiry answers, rate limits, client-side clean-up and backup/restore: [accounts.md](accounts.md) (#24). `GET /api/profile/stats` (read-only career: points, podiums, verified bests, recent results) and the `awards` server message: [career.md](career.md) (#25).
- Usernames are 3–20 characters (`A-Z a-z 0-9 _ -`), stored lower-case, and unique without regard to case. Passwords are 10–128 characters. **No email or other contact detail is collected**, and no table has such a column (tested).
- **Hashing.** The `argon2` package, Argon2id with m=19 MiB, t=2, p=1 (the OWASP minimum profile). Hashes run one at a time, with at most 16 queued (beyond that the reply is 503 `busy`), so a login flood cannot exhaust memory or stall races. Unknown users cost the same hash work as known ones.
- **Sessions.** `express-session` with a PostgreSQL store (`server/sessionStore.ts`, table `sessions`, expired rows pruned every 15 minutes).
  - Cookie: `srsid`, HttpOnly, `SameSite=Strict`, `Secure` in production, 30 days.
  - A new session ID is issued on every sign-in. A sign-in whose old session cannot be removed or whose new session cannot be stored answers `503 unavailable` and sets no cookie for it ([accounts.md](accounts.md#sign-in-when-the-session-store-fails), #51).
  - POSTs need an allowed `Origin` and `application/json`, with a body of at most 4 KB.
  - The WebSocket upgrade reads the same session, so a signed-in seat records its `accountId`.
  - A signed-in socket stays bound to that session ID and is signed in only while the session lives. Logout, a new sign-in (which replaces the session ID), expiry and the owner's password reset all end it. The server then sends `bye` `expired` (detail `session`) and closes the socket with 4003.
    - Logout and sign-in end the session's sockets at once.
    - `create`, `join` and `resume` from a signed-in socket re-check the session first. A dead session gets `nack` `expired`, so it can never make an account seat. If the check itself fails, the reply is `unavailable`.
    - Every 10 s the server re-checks all signed-in sockets. That catches a reset run from the admin process, or an expiry, while a socket sits in a seat. The seat then waits out its grace like any dropped link, and only the same account can resume it.
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
| `SLOTRUSH_ROOMS_PER_IP`, `SLOTRUSH_ROOMS_PER_ACCOUNT` | 3, 2 | 1–50. Open rooms one address / one account may have created (#52) |
| `SLOTRUSH_ROOM_CREATES`, `SLOTRUSH_ROOM_CREATE_WINDOW_S` | 20, 600 | 1–1000, 10–86400. Rooms created per address and per account in any window |
| `SLOTRUSH_RECONNECT_GRACE_S` | 20 | 5–120 |
| `SLOTRUSH_INPUT_TIMEOUT_MS` | 1000 | 250–5000 |
| `SLOTRUSH_SNAPSHOT_HZ` | 20 | 5–60 |
| `SLOTRUSH_MAX_CATCHUP_STEPS`, `SLOTRUSH_OVERLOAD_ABORT_MS` | 6, 5000 | |
| `SLOTRUSH_MSG_RATE`, `SLOTRUSH_MSG_BURST`, `SLOTRUSH_SEND_BUFFER_MAX` | 40, 60, 256 KB | |
| `SLOTRUSH_LOBBY_IDLE_S`, `SLOTRUSH_RESULTS_IDLE_S`, `SLOTRUSH_ROOM_MAX_S` | 1800, 600, 10800 | |
| `DATABASE_URL`, `SLOTRUSH_DB_POOL_MAX` | Unset (guests only, results in memory), 3 | |
| `SLOTRUSH_SESSION_SECRET` | | Required with `DATABASE_URL`, at least 32 characters |
| `SLOTRUSH_COOKIE_SECURE` | 1 in production | |
| `SLOTRUSH_CAREER_POINTS` | `10,6,4` | Career points for 1st, 2nd, 3rd… (1–8 integers, 0–1000); the stored scoring version follows from them ([career.md](career.md)) |
| `SLOTRUSH_SPOOL_DIR` | Unset (memory queue) | Absolute path for results the database cannot take yet. **Required in production with `DATABASE_URL`**; the unit's `StateDirectory` provides `/var/lib/slotrush-server` |
| `SLOTRUSH_TIME_SCALE` | 1 | Tests only. **Refused in production** |

**Logs** are JSON lines on stdout and stderr (journald under systemd). Reconnect tokens, passwords, cookies and session IDs are never passed to the logger. `redact()` also strips any field with a secret-looking name. Tests assert that no token or password appears in a log line.

## Local commands

```bash
npm ci
npm run build:server && npm run server      # room server on 127.0.0.1:8787 (no DATABASE_URL: guests only)
npm run dev                                 # game on :5173; /api and /ws are proxied to :8787 (vite.config.ts)
VITE_ONLINE=1 npm run dev                   # the same with the online gate enabled (it probes /api/health)
npm run server:smoke -- http://127.0.0.1:8787                  # health, protocol, origin, hello, solo race, leave
node scripts/load-check.mjs http://127.0.0.1:8787 --rooms 6 --humans 4 --seconds 60 --pid <pid>   # resource sample (one address: raise SLOTRUSH_MAX_CONNECTIONS_PER_IP to 24 and SLOTRUSH_ROOMS_PER_IP to 6 for that run)
node scripts/load-check.mjs http://127.0.0.1:8787 --rooms 6 --humans 2 --ai-fill --drive --until-results --seconds 300 --pid <pid>   # the same through a whole race: human finishes, AI run-on, classification
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
- **At the cap, 6 rooms × 4 humans racing for 60 s** (24 sockets, 20 state messages a second each): RSS peak 98.7 MB, heap 16 MB, **9.1% of one core**, worst tick 2.1 ms, about 84 KB/s per client (about 2 MB/s, or 16 Mbit/s, in total). That was protocol v1; v2 states are about 8 times smaller (*State messages*).
- **Tick percentiles (#54).** Same setup, rebuilt at `bda6285` (Node 26.7.0, PostgreSQL 18, 4-vCPU shared build host, production mode, `--max-old-space-size=96`). `ticks` are the tick work, `lag` the tick timer's lateness. The polled decayed `tickMaxMs` (the old `worstTickMs`) is shown for comparison.

  | Workload | Duration | Ticks | p50 / p95 / p99 / max (ms) | Lag p99 / max (ms) | CPU | RSS peak | Old `worstTickMs` |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 6 × 4 humans, throttle rhythm, 24 clients | 60 s | 5,853 | 0.66 / 1.22 / 1.72 / 4.7 | 1.4 / 24.2 | 9.5% | 99 MB | 2.6 |
  | 6 × 4 humans, bot drivers to the finish, 24 clients (6 completed results stored) | 237 s | 23,119 | 0.66 / 1.12 / 1.45 / 9.9 | 1.4 / 14.8 | 9.7% | 119 MB | 4.8 |
  | 6 × (2 humans + 2 AI): first human finishes, the other retires, the finisher watches the AI run-on and classification (6 results) | 204 s | 19,856 | 0.61 / 1.12 / 1.58 / 5.2 | 1.4 / 12.3 | 8.5% | 127 MB | 5.2 |

  Commands: `scripts/load-check.mjs` with `--rooms 6 --humans 4 --seconds 60`, then `--drive --until-results`, then `--humans 2 --ai-fill --drive --pace 1.15 --retire-on-finish --until-results` (`--pid`, server with `SLOTRUSH_ROOMS_PER_IP=6`, `SLOTRUSH_MAX_CONNECTIONS_PER_IP=24`, `SLOTRUSH_ROOM_CREATES=1000`). Percentiles are bucket upper bounds (at most ~9% high). The maxima are exact but may include up to 60 s before each run (setup, or the previous run's departures). RSS start was 86, 101 and 112 MB: the three ran in one process. The bot drives a little slower than the AI, so the third run uses `--pace 1.15` so that a human finishes first. **These are diagnostics from a shared build host, not a certification of the production VPS or of browser hardware** (that is #4).
- **What this supports:** the cap of 6 rooms and 24 humans fits under the 150 MB RSS target and the 256 MB limit with headroom. Even if the shared vCPU is three times slower than the build host, 6 racing rooms need about 30% of a core against a 60% quota. Bandwidth is the first constraint to watch. Lower `SLOTRUSH_SNAPSHOT_HZ` to 15 or 10 to cut it proportionally, or raise the cap only after measuring on the host.
- **Hashing:** each Argon2id hash uses 19 MiB. Hashes run one at a time, with `UV_THREADPOOL_SIZE=2`.

## Production design

- **Host:** the existing site host (Node 22, PostgreSQL 17, Nginx), which is shared with other sites. Only this site's files and units are added. No other site, the shared Nginx `http {}` config, DNS or the restricted static deploy identity is touched.
- **Service:** `slotrush-server.service` ([unit](../deploy/server/slotrush-server.service)), running as the unprivileged system user `slotrush-server`.
  - It runs from `/srv/slotrush-server/current`, a symlink to `/srv/slotrush-server/releases/<name>`, with the configuration in `/etc/slotrush-server/env` (`root:slotrush-server` 0640).
  - It restarts on failure, uses the resource limits above, and is sandboxed (`ProtectSystem=strict`, no capabilities, no new privileges, private `/tmp`).
- **Nginx:** [`deploy/nginx/slotrush.jdwd40.com.online.conf`](../deploy/nginx/slotrush.jdwd40.com.online.conf) is the current static site plus `location = /ws` (WebSocket upgrade, Origin passed through, 75 s read timeout against the server's 25 s pings) and `location /api/` (8 KB bodies, no-store). The site file sets its own gzip for static assets ([deployment.md](deployment.md#dns-nginx-and-tls)); both `/ws` and `/api/` have `gzip off` and strip the headers that would let the upstream compress. The upstream is loopback port 8787. The static-only file remains the rollback target.
- **Database:** a dedicated PostgreSQL 17 database `slotrush`, owned by a dedicated login role `slotrush` (no superuser, createdb or createrole, connection limit 6). Migrations run explicitly with `admin.mjs migrate`. The service refuses to start (exit 78) on a schema it does not match. This is the rollout compatibility check, along with the protocol check below.
- **Database outages (#48).** A database restart, failover or dropped connection does not stop the service or touch the rooms, which live in memory.
  - Connections that die (idle in the pool, checked out, or with a query in flight) are discarded and replaced on the next query. Each idle one is logged once as `db.connection_lost` (warn) with the error code and message only: never `DATABASE_URL`, the role or its password ([`server/db.ts`](../server/db.ts)).
  - Races in progress carry on: the same room, seats, cars, race clock and held controls, with snapshots at the usual rate.
  - A race that finishes during the outage is spooled to `SLOTRUSH_SPOOL_DIR` and its awards show `pending` ([career.md](career.md)). The spool retries (2 s, doubling to 60 s) and stores it once the database is back. Storage is idempotent by race id, so a retry never adds a second result or a second career award.
  - Requests that need the database fail meanwhile without detail (a session cookie that cannot be read: `503 unavailable`, [accounts.md](accounts.md#flows); sign-in or sign-up: `500 internal`). Guest play and room traffic do not touch the database, and session re-checks that fail end nobody's sign-in.
  - `/api/health` probes the database on every call: `503` with `"ok":false,"db":"down"` during the outage (so new online sessions are not offered), and `200` with `"db":"ok"` as soon as it answers again. `racing` keeps counting the races that carry on, and `pendingResults` counts results still waiting for storage.
  - Tested: `test/server/dbpool.test.ts` (a pool in a child process against a wire peer that drops its connections) and `test/server/dbrestart.db.test.ts` (the server process through a TCP proxy that cuts PostgreSQL mid-race, then restores it).
- **CI:** the new `server` job uses a throwaway `postgres:17` service container and **no secrets**:
  - runs the database tests on PostgreSQL 17, including the mid-race database outage
  - builds and packs the release with the locked production dependencies
  - starts the packed release in production mode against a migrated database and runs the smoke check
  - uploads `slotrush-server-<sha>` (tarball and SHA-256) for 30 days

  The static `deploy` job needs both `check` and `server` (#55): if this job fails, is cancelled or is skipped, the static client for that commit is not deployed ([deployment.md](deployment.md#ci-artifact-chain)). **No CI job deploys the server.**
- **Client gate:** the deployed static build sets `VITE_ONLINE=1`. It still enables nothing until `/api/health` answers `ok` with the client's exact protocol version. A build without `VITE_ONLINE` keeps online play off and never requests `/api` or `/ws` (tested in the browser); that is the client rollback. The bundle contains no secret: the endpoint is the page's own origin.

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

4. **Configuration.** Copy `deploy/server/slotrush-server.env.example` to `/etc/slotrush-server/env` (`root:slotrush-server`, mode 0640). Set `DATABASE_URL` and `SLOTRUSH_SESSION_SECRET` (`openssl rand -base64 48`), and keep `SLOTRUSH_ALLOWED_ORIGINS=https://slotrush.jdwd40.com`, `SLOTRUSH_SPOOL_DIR=/var/lib/slotrush-server/spool` and `SLOTRUSH_CAREER_POINTS=10,6,4`. Do not paste these values anywhere else.

5. **Install the release** (root-owned and read-only to the service):

   ```bash
   sudo tar -C /srv/slotrush-server/releases -xzf slotrush-server-<rev>.tar.gz
   sudo chown -R root:root /srv/slotrush-server/releases/slotrush-server-<rev>
   sudo ln -sfn releases/slotrush-server-<rev> /srv/slotrush-server/current.new && sudo mv -T /srv/slotrush-server/current.new /srv/slotrush-server/current
   ```

6. **Migrate**, then check the schema. On an existing database, back it up first ([accounts.md](accounts.md#backup-and-restore)); release #24 adds `002_driver_profiles`, release #25 adds `003_career_awards_bests` ([career.md](career.md#production-activation-owner)):

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

11. **Client.** Only after step 10 passes, enable online play in the deployed client. Set `VITE_ONLINE: '1'` on the `npm run build` step in `.github/workflows/ci.yml`; that is a public build flag, not a secret. Then push to `main`. That build still offers online play only while the health check passes; until then the title shows local play only. Then run the post-activation checks in [online-client.md](online-client.md#after-activation-owner).

12. **Account recovery:** `sudo -u slotrush-server sh -c 'set -a; . /etc/slotrush-server/env; set +a; cd /srv/slotrush-server/current; node server-dist/admin.mjs reset-password <username>'`. Type the new password on stdin, or send empty input (`< /dev/null`) to generate one, which is printed once.

**Upgrades.**

- Install a new release beside the old one (step 5 with the new name), run `migrate` (migrations are additive), switch `current`, and run `sudo systemctl restart slotrush-server`.
- A restart aborts races in progress. They get aborted envelopes, never results. Restart when `/api/health` shows `racing: 0` if possible.
- Re-run steps 8 and 10.
- If the protocol version changed, deploy the matching static client in the same window. Until then, the health check keeps an older client's online play off (*Mixed versions*).

### Release procedure (owner)

A release is one commit on `main`. Two boundaries:

- **Automatic (CI):** the static client. A push to `main` deploys the checked static artifact only after both the `check` and `server` jobs succeeded for that commit. The deploy job verifies the public `REVISION` and every built file and rolls itself back if verification fails ([deployment.md](deployment.md#ci-artifact-chain)).
- **Manual (owner):** the room server and its database. CI only builds, tests, smoke-checks and packages `slotrush-server-<sha>`. Nothing installs it, migrates the database or restarts the service except the owner, with *Upgrades* above.

Before declaring a release ready:

1. **CI for the exact commit.** `gh run list -R jdwd40/slot-racer-gp --branch main --commit <sha>` then `gh run view <run id> -R jdwd40/slot-racer-gp`. All three jobs (`check`, `server`, `deploy`) must be green; a skipped `deploy` means the static client was not released.
2. **Compatibility of client, server and database.** The client and server of one commit are built from the same `src/net/protocol.ts` (`PROTOCOL_VERSION`, `RULES_VERSION`) and `server/migrations.ts` (`SCHEMA_VERSION`, the last migration id). Against the server version that is live (`version` from `/api/version`), check what changed:

   ```bash
   git diff --stat <live server version> <sha> -- server/ src/
   ```

   The server bundle includes shared client code (`src/net/protocol.ts` and the race core: `src/race.ts`, `track.ts`, `timing.ts`, `records.ts`, `pit.ts` and what they import), so diff all of `src/`, not only `src/net/`. A change confined to UI files the server never imports can be confirmed with `npm run build:server` on both commits and comparing `server-dist/` bundles.

   - Nothing under `server/`, `src/net/` or the shared race core changed: the live server may stay. Its `protocol`, `rules` and `schema` must still equal this commit's.
   - Server code changed: upgrade it from this commit's `slotrush-server-<sha>` artifact (*Upgrades*). Its `server-dist/VERSION` must be `<sha>`, and `server-dist/protocol.json` must hold this commit's protocol and rules.
   - `PROTOCOL_VERSION` changed: the new static client offers local play only until the server is upgraded, and older open pages lose online play after it (they are refused, never desynced, see *Mixed versions*); upgrade the server in the same window. Races in progress are aborted by the restart anyway.
   - `RULES_VERSION` changed: results and personal bests start a new rules set ([career.md](career.md)); upgrade the server so online races use the new rules.
   - A new migration: back up the database and run `migrate` before restarting. A server refuses to start on a schema it does not match (exit 78).
3. **Public verification** (read-only, from any machine with the release checked out):

   ```bash
   curl -fsS https://slotrush.jdwd40.com/REVISION        # must be the full <sha>
   curl -fsS https://slotrush.jdwd40.com/api/version     # server version, protocol, rules, schema
   curl -fsS https://slotrush.jdwd40.com/api/health      # "ok":true, "db":"ok", pendingResults 0, unsavedResults 0
   node scripts/server-smoke.mjs https://slotrush.jdwd40.com --origin https://slotrush.jdwd40.com --expect server-dist/protocol.json
   ```

   Run the smoke check after `npm run build:server` at `<sha>`, so `--expect` is this commit's protocol and rules. Every line must be `PASS`. `/api/version` `schema` must be this commit's `SCHEMA_VERSION`, and `protocol` the value in `<sha>`'s `src/net/protocol.ts`. Then open the site on a desktop browser: **Online** must appear under the title buttons.
4. **Record** in the PR, issue or release note: the static `REVISION`; the CI run id; the server `version`, `protocol`, `rules` and `schema`; `db`, `pendingResults` and `unsavedResults`; the commands, their UTC time and results; and what was not checked. For example, a read-only check on 11 November 2026 found `REVISION` and server `version` both `1297f72fc9b1fcb0e9701598f1e012f1e38f1e07`, protocol 1, rules `race-core-2026.11.2`, schema `003_career_awards_bests`, `db` ok, no pending or unsaved results.

**What green CI does not prove.** CI runs type checks, unit and headless tests, PostgreSQL 17 tests, the builds and a smoke check of the packaged server against a throwaway database. It does not run a four-player game in real browsers, phones or tablets, and it does not measure frame time on accelerated hardware. Those are the final integrated validation in #4 ([validation.md](validation.md#remaining-hardware-validation)). Declaring or tagging 1.0 also requires the hardening fixes #48–#55 to be merged and released, and #4 to be completed. If no suitable browser or device is available, the hardware and frame-time items stay explicitly outstanding and 1.0 is not declared on CI alone.

### Rollback

- **Server release:** point `current` back at the previous release directory (`ln -sfn releases/<previous> current.new && mv -T current.new current`), then `sudo systemctl restart slotrush-server`, then re-run step 8. Migrations are additive and the old release ignores newer tables. A release before #25 stores results without scoring them: races finished while it runs never earn career points, even after upgrading again (a stored race is never re-scored), so prefer rolling forward. If a migration ever must be reverted, restore the database from the backup taken before step 6 (`pg_dump -Fc slotrush > slotrush-<ts>.dump`).
- **Turn online play off entirely:** restore the backed-up static-only Nginx site file, run `nginx -t`, and reload Nginx. `/api` and `/ws` then return 404, the client's health check fails, and online play stays off. Then run `sudo systemctl disable --now slotrush-server`. The static game is unaffected throughout.
- **Client:** remove `VITE_ONLINE` from the build and push, or roll back the static release with the existing receiver (`deployment.md`). Local saves (records, ghosts and championships) are never touched by the server or by either rollback.
- **Revoke database access:** `ALTER ROLE slotrush NOLOGIN`. Remove the service user and `/etc/slotrush-server` only after the service is disabled.
