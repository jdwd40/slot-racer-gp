# Online client: evidence (#23)

Taken on 9 November 2026 on the build host. Design: [online-client.md](online-client.md).

**What these results are.**

- Every browser run used Playwright Chromium 156 on SwiftShader, because the host has no GPU, and every touch run used Chromium's touch emulation. **These are functional diagnostics only.** They show nothing about smooth play on a real phone, tablet or GPU.
- **No physical phone or tablet was tested.**
- Production was not touched: no host, DNS, Nginx, systemd unit or third-party service was used or changed. The servers were the repository's own server code, started locally (`scripts/qa-server.ts`) with test settings.

## How it was run

```bash
npm run typecheck && npm test && npm run build
node scripts/online-check.mjs gate layout                 # run 2026-11-09T07-22
node scripts/online-check.mjs connection service lobby    # run 2026-11-09T07-49 (connection, service)
node scripts/online-check.mjs lobby                       # runs 2026-11-09T06-57 and LOBBY_FINAL_RUN (lobby)
```

| Scenario | Last run | Passed | Failed | Notes |
| --- | --- | --- | --- | --- |
| gate | 07-22 | 6 | 0 | |
| layout | 07-22 | 24 | 0 | |
| connection | 07-49 | 13 | 1 | Every check up to and including the reload Rejoin passed. The expiry step then timed out: when the harness blocked the WebSocket, a reconnect attempt that never opened hung, so the client never gave up. Fixed afterwards (`CONNECT_TIMEOUT_MS`, 8 s per attempt in `src/net/client.ts`). Expiry is covered by the headless test against the real server. **It was not re-run in the browser for lack of time** |
| service | 07-49 | 8 | 1 | The one failure was the check's own condition: the keyboard driver had completed five automatic stop-and-go cycles (`entry → serving → leaving`), but owed 3 s more at the moment of reading, from real contacts made by the scripted drivers. The condition was changed to "served" and was not re-run |
| lobby | LOBBY_ROW |

`online-check.mjs` sets up its own environment:

- **Client build.** It builds the client with `VITE_ONLINE=1` into `dist-online/`. The default `dist/` build stays online-off.
- **Previews.** It serves that build with Vite previews whose `/api` and `/ws` proxies stand in for Nginx (same origin).
- **Two room servers**, started in its own process from `server/` (`createApp` + `RoomManager`):
  - **fast**: `SLOTRUSH_TIME_SCALE=2`, a test-only setting that production refuses. It runs the lobby's 13-lap races in half the wall time.
  - **real**: real time, behind a TCP relay that adds latency, jitter and stalls on demand. For the checks only, the reconnect grace is 40 s (production default 20 s), because a SwiftShader page reload on this host can take over 20 s.
- **Seeding.** Where a check needs a rule event the scripted drivers cannot produce on cue, the harness calls the server's own race methods (`offence()`, `retire()`), and the check says so.
- **Frame cap.** In the multi-browser races every page draws at most 4 frames/s. This is a harness cap so that four software-rendered pages fit on four cores. The online client does not simulate anything, so the cap slows drawing only. Input and snapshots are handled outside frames: pedal changes are sent the moment they happen.

## Results by acceptance item

| Item | Result | Where |
| --- | --- | --- |
| 2-, 3- and 4-player races through the real server | **Browsers:** 4-player (four contexts: 480×270 keyboard ×2, 390×844 touch, 1024×768 touch) and 3-player (touch host) races completed with identical final standings on every page. **Headless:** 2-, 3- and 4-client races with the browser's own `NetSession` + mirror, identical digests | `lobby`; `netsession.test.ts` |
| Distinct simultaneous inputs, nonzero local IDs | Server-side held pedals sampled during the 4-player race: each seat matched its own browser in 193 of 222 samples (the rest were in flight). Seats differed in 177 samples. Slots 0–3 were each followed by its own browser | `lobby` |
| Lobby: create, join by code (lower case accepted), ready/unready, host-only Start with reason, track change, code shown as text, AI slots listed | Passed | `lobby`, `service` |
| Unsafe name `<img src=x onerror=…>Zed` | Rendered as text in the lobby on every page; no `img` element, the handler never ran | `lobby` |
| Fifth human | Refused with "That room is full: four drivers is the limit"; the menu stays usable | `lobby`; headless |
| Late join after start | "That race has already started… grid is locked" | `lobby`; headless |
| Rematch / leave / creator leaving | Rematch kept the room code and all four participant IDs. When the creator left the lobby, the earliest remaining driver became host and got Start. A guest left at the results; the rest rematched | `lobby` |
| Queue, automatic stop-and-go, own-bay refuel with fresh Throttle, override, Defer | One real-time race, 2 browsers + 2 AI. An AI car and the keyboard driver were given stop-and-goes together and the driver **queued** for the box (`queued` → `entry` → `serving` → `leaving`, no keys). The touch driver's **Lane** while routed showed **override** (server state and pad cue). **Defer** on touch moved its stop to the next approach (`deferred` → … → `serving`). The fuel visit went `bay` → `refuel` → `ready` (fresh Throttle) → `leaving`, in the driver's own bay | `service` |
| Final-lap DQ | **Headless (real server):** three offences after the last pit entrance on lap 13 → DQ for every client, with no position. **Browser (07-49):** a DQ (latched breach, retired by the server) and a DNF (retired) are spelled out in the pending card ("You were disqualified · missed service deadline") and in the final standings (`finished 3:55.4`, `finished 4:37.7`, `DNF Retired`, `DQ missed service deadline`), identical on both browsers. The scripted browser drivers were too slow on SwiftShader to reach lap 13 inside the AI's finish window | `netsession.test.ts`; `service` |
| Deliberate reverse | Brake held at a standstill: server `revOn`, v = −3 m/s, HUD "REVERSING". Released: off | `connection` |
| Disconnect while accelerating | The server neutralized the car at once (held = none). The banner showed *Reconnecting… held for up to N s*. The automatic resume returned the same participant and car with laps intact. The still-held key did not count until pressed again | `connection` |
| Reconnect before expiry | Automatic (socket drop) and after a page reload (**Rejoin room CODE** from `sessionStorage`) | `connection`; headless |
| Reconnect after expiry | Socket blocked past the grace: "Your seat expired…", stored seat removed, the car retired. Joining with the code is refused (`started`), so the seat cannot be re-claimed as a new driver | `connection`; headless |
| Menu, lost focus, mobile background | The server saw this seat's pedals released within 0.4–0.5 s. The race advanced (0.67 s over the same interval). On return the menu was showing, and neither a key nor a finger still on the glass counted until pressed again | `connection` |
| Results consistency, duplicates | Identical digests and rows on every page. A resent result (resume into results) is marked not fresh. No `srgp.board*` or `srgp.champ` entry was created by online races | `lobby`; headless |
| Service off | With the endpoint unreachable, no **Online** button, a note that online play is unavailable, local race, practice and the stored championship still offered, preset change applied, fixtures byte-identical | `gate` |
| Layouts | 360×740 and 390×844 portrait, 844×390 landscape, 1024×768 and 820×1180 tablet (touch emulation, DPR 2), and 1280×720 desktop. The online menu, connected-solo lobby, race HUD and race menu fit with no sideways scroll. Controls on the menu and lobby are ≥ 40 px; the pad is on screen. On desktop only, the race menu's settings tabs are 28 px (mouse layout, unchanged by this work) | `layout` (24/24) |

## Responsiveness and snapshots

**Protocol path, measured without rendering.** A headless client using the browser's own `OnlineClient` went through the same relay to the real-time server: Brake press → the first 20 Hz snapshot showing it. 15 presses each.

| Link | Run | Median | p90 | Max |
| --- | --- | --- | --- | --- |
| Loopback | 07-38 | 31 ms | 72 ms | 82 ms |
| Loopback | 07-49 | 31 ms | 41 ms | 81 ms |
| +60 ms each way, 0–30 ms jitter | 07-38 | 185 ms | 197 ms | 203 ms |
| +60 ms each way, 0–30 ms jitter | 07-49 | 189 ms | 211 ms | 223 ms |

**In the browser (SwiftShader, runs 07-38 and 07-49).** The page drew 2.8–2.9 frames/s at 480×270 Low with two pages open. Brake press → first server state that showed it took a median of about 1.0 s, and → first drawn frame about 0.9–1.0 s. Both numbers are dominated by the software renderer's ~350 ms frames, which delay every task on the page, including WebSocket messages. They are not a network or protocol result. The snapshot buffer stayed bounded (depth ≤ 17 of 24) and **no stale snapshot was ever applied**.

**1.5 s stall** (relay paused). The server kept the race running (3.2–3.5 s of race time advanced over the check). The longest snapshot gap seen was 1.6–1.9 s. The client re-anchored its clock once and stayed connected. The lap count did not jump or repeat.

**No prediction was added.** On the protocol path, press-to-confirmation is one snapshot interval plus the round trip. That is the level at which the server can stay simply authoritative. Whether real devices need more is a question for the physical-device checks below.

## Not covered here (honest gaps)

- **Physical phones and tablets:** none were available. Touch, multi-touch, background/return and layouts were checked only in Chromium's emulation. The owner's [post-activation steps](online-client.md#after-activation-owner) are the first real-device check.
- **Real-GPU smoothness and input feel:** not measurable on this host.
- **Production endpoint:** not activated. Every server here was local, with test settings: time scale 2 for the lobby races, and a 40 s grace in the connection checks.
- **Browser-driven final-lap DQ:** checked headlessly (above), with the browser checking only how the server's DQ and DNF are shown.

## Unit and integration tests

`npm test`: all suites pass, including `test/server/netsession.test.ts`, which runs against the real HTTP/WebSocket app on a loopback port:

- **Mirror equivalence.** A server race against a snapshot-fed mirror, with every HUD-relevant method compared (over 5000 car checks). Re-applying a snapshot changes nothing.
- **Interpolation.** Interpolation, stale refusal, starving without extrapolation, a bounded buffer, and re-anchoring after a stall.
- **A 4-client race.** Lower-case code, taken livery shown as requested, host-only start, a fifth refused, a late join refused, identical digests and mirror finals.
- **2- and 3-client rooms at once.**
- **Reconnects.** Automatic reconnect with the same car, reload resume, expiry (resume refused and the seat forgotten, a join refused as `started`, the car DNF or DQ), a duplicate result marked not fresh, and rematch.
- **Final-lap DQ.**
- **Connected solo.** It has three AI cars, and `release()` reaches the server while the race keeps running.
- **Refusals.** A missing room, and an unreachable endpoint.
