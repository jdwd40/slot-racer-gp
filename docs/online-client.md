# Online lobbies and races in the browser (#23)

Up to four people race in one private room from their own browsers, on desktop or touch devices, against the authoritative room server from [#22](online-server.md). Evidence: [online-client-evidence.md](online-client-evidence.md).

**Status.** Built and checked locally against the real server code. Production is **not** switched on. The deployed static build has no `VITE_ONLINE`, so it shows local play only and never calls `/api` or `/ws`. The owner turns it on with the [runbook](online-server.md#production-activation-runbook-owner), then runs the [checks below](#after-activation-owner).

## Three ways to race

The title screen names them separately:

| Mode | Where it runs | Rivals | Results |
| --- | --- | --- | --- |
| **Local** (Start Race, Practice, Championship) | This device, offline | Three local AI cars | Local leaderboards, ghosts and championship in `localStorage`, as before |
| **Connected solo** (Online → Start connected solo) | The server (`mode: solo`) | Three server AI cars | Server result envelope. This is the path later account results will use |
| **Multiplayer room** (Online → Create room / Join room) | The server (`mode: multiplayer`) | 2–4 humans, plus AI in empty places if the host turns that on | Server result envelope, the same for every member |

**Online** appears on the title only after the same-origin `/api/health` check passes with this client's protocol version (`src/online.ts`). If the check fails, the title says online play is unavailable and local play works as usual. A build without `VITE_ONLINE=1` never runs the check.

## Lobby

- **Online menu.** Driver name (1–16 characters), colour (the server's eight liveries), **Create room** (track = the circuit chosen on the title, optional AI fill), **Join room** by 6-character code, and **Start connected solo**. A link ending `#room=CODE` fills in the code.
- **Room screen.**
  - The code is shown as text, with **Copy code** and, where the browser has it, **Share**.
  - It shows the track (the host can change it), the AI setting, and every driver's race number, colour, name and state: You, Host, Ready / Not ready, Reconnecting, Left. A colour that was asked for but already taken is shown as such.
  - Configured AI cars are listed as AI, with their numbers.
- **Permissions come from the server.** Only the host sees **Start** (and settings). Guests get **Ready** / **Not ready**. A refused start says why. When the creator leaves, the server passes hosting on and the new host gets Start.
- **Refusals are explained, and never leave the app stuck.** The online menu stays usable after each:

| Server code | Shown |
| --- | --- |
| `full` | That room is full: four drivers is the limit |
| `not_found` | No open room has that code |
| `started` | That race has already started and its grid is locked |
| `expired` | That seat has expired and cannot be taken back |
| `protocol` (or a health-check mismatch) | This page is out of date for the game server: reload |
| `unavailable`, `overloaded`, `rate` | Busy / too many attempts: try again in a minute |
| no connection | Could not reach the game server. Local play still works |

- **Safe text.** Driver names and room codes from other people go into the page only as escaped text (`escHtml`) or `textContent`. That covers the lobby, standings, the HUD standings and results. Bay boards draw names on a canvas. The checks join with a name containing an `<img onerror>` tag and confirm that it renders as text and does not run.
- **Layout.** It uses the existing card, button and safe-area styles. Every control on the online menu and lobby is at least 40 px tall, and the main buttons 44 px. It was checked at 360×740 and 390×844 portrait, 844×390 landscape, 1024×768 and 820×1180 tablet, and 1280×720 desktop.

## Online race client

- **No local simulation.** The browser keeps a *mirror* `Race` (`src/net/mirror.ts`). Every authoritative snapshot overwrites it, so the HUD, lane and pit arrows, bay glow, service prompts, touch-pad cues, camera, marker and audio read the same fields and methods as offline.
  - A unit test runs a server race and compares the mirror's answers with the server's every 3 steps: approach number, Defer availability, pit route, due state, departure block, box busy, bay and order.
  - The snapshot gained seven view fields to make this exact: `hiU`, `squeezeHold`, `pitHold`, `towSvc`, `pitFuel`, `serviced`, `upPrev`. The change is additive and needs no protocol bump.
- **Corrections never replay anything.** A snapshot replaces state; nothing is re-derived. Completed laps, pit visits, penalties and results are whatever the server says. Snapshots with a tick not newer than the last are dropped whole. One-shot events (toasts, sounds, flashes) arrive once, in the state message that first carries them. A resume's catch-up state has no events, so nothing replays after a reconnect.
- **Interpolation and buffering.** `SnapBuffer` keeps at most 24 snapshots.
  - Cars are drawn 100 ms (two snapshot intervals at 20 Hz) behind the newest one, interpolated between the two that bracket that time.
  - When the buffer runs dry, cars hold their last placement and never extrapolate.
  - The clock offset follows the fastest recent arrival. After a stall over 600 ms it re-anchors instead of drawing seconds behind.
  - No client prediction was added. The measured press-to-confirmation time on the protocol path is about 31 ms on loopback and 185 ms with 60 ms added each way plus jitter (see the evidence). That leaves the server simply authoritative.
- **Message history (#50).** The client keeps no history of decoded server messages by default. Before #50 it kept up to 20,000 complete messages for tests only: about 60–80 MB of Node heap at four cars after ~15 minutes, still held after a rematch.
  - Every mode keeps `rx` (total and per-type counts, plus `dropped`) and `latest`, the newest message of each protocol type. That is one message per type, however long the session runs.
  - Tests and diagnostics opt in with `new OnlineClient(...).recordHistory(cap?)`. The browser (`NetSession`) never does. `received` then keeps the newest `cap` messages and drops the oldest one at a time, counting each in `rx.dropped`. The default cap is `HISTORY_DEFAULT_CAP` = 4,000, about 3.3 min of 20 Hz snapshots and ~17 MB of heap. Any request is clamped to `HISTORY_MAX` = 8,000 (~35 MB). The longest test race over real sockets uses about 2,250. Tests that read the whole history assert `rx.dropped === 0`.
  - Lifecycle: the recorded history is never cleared by a reconnect or a rematch. `clearHistory()` empties it, and `recordHistory(HISTORY_OFF)` stops recording and clears it.
  - Measured with forced GC on Node 26 (an in-process benchmark with the issue's reproduction: a seeded four-human race, 20,001 state messages through the socket path, then three rematch cycles of 2,000 snapshots each). Before: +25.5 MiB at 6,000 snapshots, +50.4 MiB at 12,000, +62.8 MiB at 20,001, and +66.9 to +79.3 MiB across the rematches. After, default mode: +0.7 MiB at every point, the same as with the array cleared. After, opt-in at the default cap: +17.3 MiB flat from 6,000 snapshots on. These are Node heap figures, not browser or phone measurements.
- **Input.** The shared keyboard and touch layer (`DrivingInput`, `TouchPad`) is unchanged: multi-touch holds, pointer cancellation and fresh presses after a release.
  - Online, a change of held Throttle or Brake is sent at once, with a 250 ms heartbeat while racing. Taps (Lane, Pit, Defer) are numbered actions for this seat only.
  - Brake priority, deliberate reverse, automatic stop-and-go and bay service, and fresh Throttle after service are all applied by the server's race core, the same code that runs offline.
  - The browser sends only its own seat's controls, and the server refuses any other seat (`forbidden`). Nothing from another participant ever enters `DrivingInput`.
- **Local seat.** `localId` is the server participant ID, so the slot may be 0–3. Camera, marker, HUD ("YOU"), audio emphasis, personal messages, lane arrows, own-bay paint and service prompts all follow it. Other cars show their server name, number and colour.
- **Server clock.** The countdown lights, race time and phase come from the snapshot.
- **The shared race is never paused.**
  - Opening the race menu, losing focus or the page becoming hidden (a phone sent to the background) releases this browser's holds and sends neutral controls at once. The race carries on.
  - Returning restores no key or finger: whatever is still down needs a fresh press. The same applies after a reconnect.
  - The menu offers **Resume** and **Leave race (retire)**. R (restart) does nothing online.
- **Connection states.** A banner shows **Connecting**, **Reconnecting… your car is held for up to N s**, **Your car has retired** and **The game server is catching up** (`lagMs` > 500).
  - On an unexpected close, the session resumes the same seat with its private token, with backoff, until the grace period plus 3 s has passed. The car, obligations, laps and results are the server's, so the same car carries on.
  - **Dead sockets without a close (#42).** A socket can die silently (half-open TCP behind a proxy, a sleeping phone, a Wi-Fi change, a NAT timeout): the server terminates it after a missed keepalive pong, but no close reaches the browser. So the client keeps its own keepalive while any socket is open, in the lobby, race and results:
    - An app-level `{t:'ping', id}` goes out every 5 s; the server answers `pong` (protocol v1, no change). The 250 ms `ctl` heartbeat still runs only while racing.
    - Every received message counts as traffic. After **4 s** of silence in a race (snapshots come at 20 Hz) or **12 s** otherwise, the client closes the socket and takes the same path as a close: **Reconnecting…** and the resume loop above. The dead socket's late close, if it ever comes, is ignored, so only one reconnect loop runs.
    - A reconnect attempt's socket uses the 12 s window until the server has answered its `resume` (or `join`/`create`), even though the room it remembers is racing (#43). No snapshots flow before that answer, and a signed-in resume waits on a database check that can take longer than 4 s, so the race window would cut off every attempt.
    - While reconnecting, the lobby shows this seat as Reconnecting and Not ready, and Ready / Start wait for the resume.
    - The page's own suspension is not counted against the socket. A keepalive tick that runs more than 3 s late (a backgrounded tab's throttled timers, a frozen iOS page, a stalled machine), or the page becoming visible again, restarts the silence window and sends a ping at once. A socket that is really dead is then caught one window later and resumed as usual.
  - After expiry the browser says the seat expired and forgets it. A resume refused after a dropped link (`expired`, `not_found`) shows *You were disconnected from room CODE* on the online menu, and adds *Your car was retired from that race* when the car was still racing. A join with the code is then refused by the server (`started`), so an expired seat can never come back as a new driver.
  - **Reload.** The seat (room, participant, token, code) is kept in `sessionStorage` for this tab only, so after a reload the title offers **Rejoin room CODE** within the grace period. The token never goes into a URL, log or the page.
- **Results.**
  - When this driver is done and others are still racing, a **Classification pending** card lists each car as finished (time), still racing (lap) or DQ / DNF. It gives no positions and no estimated times. **Watch the race** returns to the live view.
  - **No news on the pending card (#43).** The card only changes when a `state` or `result` arrives. If neither has come for **30 s** while it shows, it says *Lost contact with the room server, reconnecting…* and asks the session to resume through the same drop path as the watchdog (`NetSession.reconnectNow()`). A reconnect already under way (the watchdog usually gets there first) shows the same line and is never doubled. A successful resume puts the card back and starts a new 30 s window. A refused resume (`expired`, `not_found`) replaces the card with *The room closed before results were sent* and **Back to menu**. The timer stops whenever the card is left (result, leave, menu, session end). Time this page was suspended is not counted: a 1 s tick that runs more than 3 s late adds nothing, and a return from hidden restarts the tick clock, as with the keepalive. The logic is `src/net/netwait.ts`.
  - When the server's result envelope arrives, every member shows the same **Final standings**: positions only for classified finishers, with DQ (and reason) and DNF (and reason) spelled out. An aborted race says that nobody gets a result.
  - The host gets **Rematch**. Others see that they are waiting for the host.
  - One driver finishing never stops the others: the server's finish window decides.
- **Records stay apart.**
  - Online laps never enter local leaderboards, ghosts or championships, and online results create no local record or points of any kind.
  - Result envelopes are recognised by `raceId`. A repeat, for example the resend after a resume into results, is marked not fresh, so it plays no fanfare and changes nothing. Reopening the results screen only redraws it.
  - Account points are not implemented, and when they are they must be awarded by the server per `raceId`, never by the client.

## Files

| File | Role |
| --- | --- |
| `src/net/session.ts` | `NetSession`: create, join, resume, reconnection, seat storage, result de-duplication, commands |
| `src/net/mirror.ts` | `mirrorRace`, `applySnapshot`, `localEvent`, `SnapBuffer` |
| `src/net/client.ts` | Protocol client. It ignores a replaced socket's late close or messages, which could otherwise reject a reconnect's request, and runs the keepalive ping and receive watchdog |
| `src/main.ts` | Online menu, lobby, race wiring, race menu, pending and final standings, banner |
| `src/input.ts` | `DrivingInput.onChange`, so online pedals are sent without waiting for a frame |
| `test/server/netsession.test.ts` | Mirror equivalence, interpolation, a 4-browser-module race over real WebSockets, fifth refused, reconnect, reload, expiry, duplicate result, rematch, connected solo, release |
| `src/net/netwait.ts` | `NetWaitGuard`: the pending card's 30 s no-news timeout, lost-contact and room-closed views (no DOM) |
| `test/watchdog.test.ts` | Keepalive and watchdog with fake timers and a socket that goes silent without closing: lobby and race thresholds, resume, slow resume from a race, expiry, timers cleared, own suspension, the pending card's timeout over a real session |
| `test/history.test.ts` | Message history policy (#50): nothing recorded by default or by `NetSession`, opt-in cap, overflow, clamp and reset, over 20,001 four-car snapshots and three rematches |
| `test/netwait.test.ts` | `NetWaitGuard` with a fake session and clock: timeout, resume, refusal, result in time, no doubled reconnect, suspension |
| `scripts/online-check.mjs`, `scripts/qa-server.ts` | Browser checks with independent contexts against the real server code (test tooling only) |

## Server capacity and configuration

The client adds no server setting. The configured limits from [online-server.md](online-server.md#resource-limits) are unchanged: `SLOTRUSH_ROOM_CAP=6` rooms of at most 4 humans, 20 snapshots/s, `MemoryMax=256M`, `CPUQuota=60%`. Those were measured at about 99 MB RSS and 9% of a core with 24 racing sockets. Each browser receives about 84 KB/s while racing. The 100 ms interpolation delay covers one lost or late snapshot at 20 Hz. If the owner lowers `SLOTRUSH_SNAPSHOT_HZ` to 10 for bandwidth, the client still works, but cars will hold more often, so raise `NET_DELAY_MS` in `src/main.ts` to 200 at the same time.

## After activation (owner)

After step 11 of the [runbook](online-server.md#production-activation-runbook-owner) (the `VITE_ONLINE: '1'` build is deployed):

1. Open `https://slotrush.jdwd40.com/` on a desktop browser. **Online** must appear under the title buttons within a few seconds. If it says online play is unavailable, check `curl -fsS https://slotrush.jdwd40.com/api/health`.
2. Create a room, then join it from a phone using the code (or the Share link). Check that both show each other's name, number and colour, then Ready → Start.
3. Drive a lap on both. On the phone, switch to another app for a few seconds and come back. The race menu must be showing, the car must have coasted, and the race must have kept running on the desktop.
4. Turn on the phone's flight mode for 5 s, then off. The banner must show *Reconnecting* and then disappear, with the same car.
5. Finish (or Leave) and confirm that both show the same Final standings.

Real phone and tablet play has not been tested by this work (see the evidence). These steps are the first physical-device check.

**Rollback** is unchanged: remove `VITE_ONLINE` from the build (the title shows local play only), and/or follow the server rollback in the runbook.
