# Online lobbies and races in the browser (#23)

Up to four people race in one private room from their own browsers, on desktop or touch devices, against the authoritative room server from [#22](online-server.md). Evidence: [online-client-evidence.md](online-client-evidence.md).

**Status.** Live in production: the deployed static build sets `VITE_ONLINE=1` (activated with the [runbook](online-server.md#production-activation-runbook-owner)), and still offers online play only while `/api/health` answers `ok` with its exact protocol version. Each release is checked with the [release procedure](online-server.md#release-procedure-owner). The [checks below](#after-activation-owner) are the owner's physical-device checks; green CI does not replace them or the final validation in #4.

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
| `protocol` (or a health-check mismatch) | A newer server: a new version is available, Reload. An older server (#80): online play is temporarily unavailable, Retry |
| `unavailable`, `overloaded`, `rate` | Busy / too many attempts: try again in a minute |
| no connection | Could not reach the game server. Local play still works |

- **Safe text.** Driver names and room codes from other people go into the page only as escaped text (`escHtml`) or `textContent`. That covers the lobby, standings, the HUD standings and results. Bay boards draw names on a canvas. The checks join with a name containing an `<img onerror>` tag and confirm that it renders as text and does not run.
- **Layout.** It uses the existing card, button and safe-area styles. Every control on the online menu and lobby is at least 40 px tall, and the main buttons 44 px. It was checked at 360×740 and 390×844 portrait, 844×390 landscape, 1024×768 and 820×1180 tablet, and 1280×720 desktop.

## Online race client

- **No local simulation.** The browser keeps a *mirror* `Race` (`src/net/mirror.ts`). Every authoritative snapshot overwrites it, so the HUD, lane and pit arrows, bay glow, service prompts, touch-pad cues, camera, marker and audio read the same fields and methods as offline.
  - A unit test runs a server race and compares the mirror's answers with the server's every 3 steps: approach number, Defer availability, pit route, due state, departure block, box busy, bay and order.
  - The snapshot gained seven view fields to make this exact: `hiU`, `squeezeHold`, `pitHold`, `towSvc`, `pitFuel`, `serviced`, `upPrev`. The change is additive and needs no protocol bump.
  - #69 added `stallT` and `stallHold` the same way, so the stopped-on-track countdown on the HUD is the server's count, refreshed with every snapshot. There is no client timer. The `recover` event shows "<name> stopped on track — moved to the pits" to the other drivers ([stopped-on-track recovery](auto-bay.md#stopped-on-track-recovery)).
  - Since protocol v2 (#67) the same test feeds the mirror through the wire encoding (keyframes, deltas, rounding) and the answers are still exact.
- **Wire format (#67).** Snapshots arrive as keyframes and deltas with the static car fields once per race ([online-server.md](online-server.md#state-messages)). `OnlineClient` decodes them (`SnapDecoder` in `src/net/snapwire.ts`, one per connection) before anything else sees them, so `NetSession`, `applySnapshot`, `mirrorRace`, `SnapBuffer` and the bots read a full `RaceSnapshot` as before. The continuously changing floats (positions, angles, speed, distance, pedals, fuel, race clock) are rounded to 3 decimals on the wire (a tank with any fuel left never arrives as `0`, #79); everything else, lap times included, is exact. A state that cannot be decoded (a delta without its base) is dropped whole and the next keyframe, within 1 s, recovers; a resume starts from a keyframe with the static fields. A round trip of a whole recorded race checks the decoded stream against the full snapshots and the mirrors against each other (`test/server/snapwire.test.ts`).
- **Corrections never replay anything.** A snapshot replaces state; nothing is re-derived. Completed laps, pit visits, penalties and results are whatever the server says. Snapshots with a tick not newer than the last are dropped whole. One-shot events (toasts, sounds, flashes) arrive once, in the state message that first carries them. A resume's catch-up state has no events, so nothing replays after a reconnect. It is the room's last broadcast state, so its tick may equal the newest one this page already had, which is then dropped as not newer.
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
- **Connection states.** A banner shows **Connecting**, **Reconnecting… your car is held where it stopped for up to N s**, **Your car has retired** and **The game server is catching up** (`lagMs` > 500).
  - **What "held" means (#74).** While this browser is reconnecting, the server treats its driver as away (it also does so while the socket is open but no controls have arrived for 1.5 s, the half-open case before the watchdog notices). The car coasts to a stop on its lane and is held there, out of traffic and exempt from the stopped-on-track rule, so it is not moved to the pits. On a resume within the grace period the driver carries on from where the car stopped, with no lap lost or voided by the outage; a stop after that gets the usual three-second warning from the start. The page never decides any of this: away is a server input, and the client only draws what the snapshots say. A held car (`away: true` in its snapshot, mirrored as `Car.away`) is drawn dimmed on every client, including its own driver's once it is back, until it no longer overlaps another car and rejoins traffic. If the grace runs out the car retires as before.
  - **A de-slot before the hold (#83).** Only a car that has stopped on the racing lane is held. While it is still moving it is a normal car under the normal grip rule, so a car that loses its link at racing speed just before a corner can still de-slot, and that de-slot voids the lap as any de-slot does. On a half-open link the server also keeps the last held pedals for up to 1 s (`inputTimeoutMs`) before going neutral, so a page that froze on full Throttle keeps it for that second, just as a connected driver keeping the key down would. The car then tumbles (`mode` `off`, not drawn as held), is put back 1.6 m behind where it left, and is held there for the rest of the outage. A closed socket goes neutral at once. See *A de-slot during the coast* in [auto-bay.md](auto-bay.md).
  - **On the menu cards (#64).** On the online menu, the lobby and the final standings no car is on track, so a dropped link says **Connection lost. Reconnecting… your seat is held for up to N s.** (`net.reconnectingLobby`). Races and the pending card keep the car wording. These cards fill a phone screen, and the banner used to float at the race HUD's height over the room heading and **Copy code**. There it now sits at the top edge and the card is pushed down by the banner's measured height (it wraps to more lines on a narrow phone), so the card, which scrolls inside itself when short of room, never runs under it. The per-screen choice is `src/net/banner.ts`; the browser check's `netbanner` scenario checks the layout at 640×400, 360×640, 844×390 and 1280×800.
  - On an unexpected close, the session resumes the same seat with its private token, with backoff, until the grace period plus 3 s has passed. The car, obligations, laps and results are the server's, so the same car carries on.
  - **Dead sockets without a close (#42).** A socket can die silently (half-open TCP behind a proxy, a sleeping phone, a Wi-Fi change, a NAT timeout): the server terminates it after a missed keepalive pong, but no close reaches the browser. So the client keeps its own keepalive while any socket is open, in the lobby, race and results:
    - An app-level `{t:'ping', id}` goes out every 5 s; the server answers `pong` (added without a protocol change). The 250 ms `ctl` heartbeat still runs only while racing.
    - Every received message counts as traffic. After **4 s** of silence in a race (snapshots come at 20 Hz) or **12 s** otherwise, the client closes the socket and takes the same path as a close: **Reconnecting…** and the resume loop above. The dead socket's late close, if it ever comes, is ignored, so only one reconnect loop runs.
    - A reconnect attempt's socket uses the 12 s window until the server has answered its `resume` (or `join`/`create`), even though the room it remembers is racing (#43). No snapshots flow before that answer, and a signed-in resume waits on a database check that can take longer than 4 s, so the race window would cut off every attempt.
    - While reconnecting, the lobby shows this seat as Reconnecting and Not ready, and Ready / Start wait for the resume.
    - The page's own suspension is not counted against the socket. A keepalive tick that runs more than 3 s late (a backgrounded tab's throttled timers, a frozen iOS page, a stalled machine), or the page becoming visible again, restarts the silence window and sends a ping at once. A socket that is really dead is then caught one window later and resumed as usual.
  - After expiry the browser says the seat expired and forgets it. A resume refused after a dropped link (`expired`, `not_found`) shows *You were disconnected from room CODE* on the online menu, and adds *Your car was retired from that race* when the car was still racing. A join with the code is then refused by the server (`started`), so an expired seat can never come back as a new driver.
  - **Outdated page (#67).** When `/api/health` reports a newer protocol than this page's, the title says *A new version of Slot Rush is available. Reload to play online.* (`net.outdated`) with a **Reload** button, instead of hiding online play. The same notice replaces the online menu when a create, join or resume is refused with `protocol`, and when a reconnect is refused that way because the server was upgraded mid-session (the session ends `outdated` after one attempt). Tests: `test/outdated.test.ts`.
  - **Older server (#80).** When the server speaks an *older* protocol (it was rolled back after a protocol bump, or the static client was released before the server was upgraded), reloading would not help: the title says *Online play is temporarily unavailable — try again shortly.* (`net.behind`) with a **Retry** button (`#o-retry`) that re-probes `/api/health` and, once the server matches again, shows **Online** as usual without a page reload. While the title shows this notice it also re-probes on its own every 45 s (`RECHECK_MS`), at most 20 times per visit (`RECHECK_MAX`), one probe at a time, and stops when the title is left or the answer changes; a re-check that still says older does not redraw the title. A refused hello (create, join, resume) or a refused reconnect (session end `outdated`) does not tell the page the server's protocol, so the page re-probes `/api/health` to decide: only a server reporting a *newer* protocol gives the Reload notice; an older one, a failing probe or a matching one (the server changed again meanwhile) gives the Retry notice. The page never says *a new version is available* when the server is older. Client only: no protocol or server change. Tests: `test/outdated.test.ts` (fake timers for the re-check).
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
| `src/net/snapwire.ts` | Snapshot wire format (#67): field tables with precision, `SnapEncoder` (server), `SnapDecoder` (client) |
| `test/server/snapwire.test.ts` | Whole-race round trip, mirror agreement, sizes, keyframe and resume recovery, pinned result digest, protocol version |
| `test/outdated.test.ts` | Outdated page: newer health protocol, refused hello, refused reconnect, notice and Reload button; older server (#80): Retry notice, Retry recovers, refused hello/reconnect re-probes health, bounded title re-check |
| `src/net/client.ts` | Protocol client. It ignores a replaced socket's late close or messages, which could otherwise reject a reconnect's request, and runs the keepalive ping and receive watchdog |
| `src/main.ts` | Online menu, lobby, race wiring, race menu, pending and final standings, banner |
| `src/input.ts` | `DrivingInput.onChange`, so online pedals are sent without waiting for a frame |
| `test/server/netsession.test.ts` | Mirror equivalence, interpolation, a 4-browser-module race over real WebSockets, fifth refused, reconnect, reload, expiry, duplicate result, rematch, connected solo, release |
| `src/net/banner.ts` | The banner's per-screen wording and whether the card makes room for it (no DOM) |
| `test/netbanner.test.ts` | Reconnecting wording per screen: seat on the menu cards, car in races |
| `src/net/netwait.ts` | `NetWaitGuard`: the pending card's 30 s no-news timeout, lost-contact and room-closed views (no DOM) |
| `test/watchdog.test.ts` | Keepalive and watchdog with fake timers and a socket that goes silent without closing: lobby and race thresholds, resume, slow resume from a race, expiry, timers cleared, own suspension, the pending card's timeout over a real session |
| `test/history.test.ts` | Message history policy (#50): nothing recorded by default or by `NetSession`, opt-in cap, overflow, clamp and reset, over 20,001 four-car snapshots and three rematches |
| `test/netwait.test.ts` | `NetWaitGuard` with a fake session and clock: timeout, resume, refusal, result in time, no doubled reconnect, suspension |
| `scripts/online-check.mjs`, `scripts/qa-server.ts` | Browser checks with independent contexts against the real server code (test tooling only) |

## Server capacity and configuration

The client adds no server setting. The configured limits from [online-server.md](online-server.md#resource-limits) are unchanged: `SLOTRUSH_ROOM_CAP=6` rooms of at most 4 humans, 20 snapshots/s, `MemoryMax=256M`, `CPUQuota=60%`. Those were measured at about 99 MB RSS and 9% of a core with 24 racing sockets. Each browser receives about 12 KB/s while racing since protocol v2 (about 84–97 KB/s before, #67). The 100 ms interpolation delay covers one lost or late snapshot at 20 Hz. If the owner lowers `SLOTRUSH_SNAPSHOT_HZ` to 10 for bandwidth, the client still works, but cars will hold more often, so raise `NET_DELAY_MS` in `src/main.ts` to 200 at the same time.

## After activation (owner)

After step 11 of the [runbook](online-server.md#production-activation-runbook-owner) (the `VITE_ONLINE: '1'` build is deployed):

1. Open `https://slotrush.jdwd40.com/` on a desktop browser. **Online** must appear under the title buttons within a few seconds. If it says online play is unavailable, check `curl -fsS https://slotrush.jdwd40.com/api/health`.
2. Create a room, then join it from a phone using the code (or the Share link). Check that both show each other's name, number and colour, then Ready → Start.
3. Drive a lap on both. On the phone, switch to another app for a few seconds and come back. The race menu must be showing, the car must have coasted, and the race must have kept running on the desktop.
4. Turn on the phone's flight mode for 5 s, then off. The banner must show *Reconnecting* and then disappear, with the same car. On the racing lane the car must still be where it stopped (drawn dimmed on the other device while away), not in its bay.
5. **Stopped on track (#69).** On a straight away from the pits, one driver lifts off and stays stopped. That driver must see `MOVE YOUR CAR · PITS IN 3`, then 2, then 1, with the status line, and no driving control may be covered. Then the car must vanish from the lane and appear in its own bay with "Stopped on track — moved to pits", while the other device shows "<name> stopped on track — moved to the pits" and the car in that bay. A car stopped right behind it must not get a countdown until the first one is gone. Then, with Throttle still held from before, the recovered car must not leave; release it and press again once Ready, and it must leave only when the pit lane is clear. Repeat once on the phone (touch pad) and once on the desktop (keyboard). Then once more with the stopped phone put in flight mode for 2 s mid-countdown (#74): while the phone is offline its car is held where it stopped (dimmed on the desktop) and the countdown is cancelled, not continued. Back online, the banner disappears and, if the car is still stopped, the countdown starts again from 3; the recovery comes a full 3 s after the phone is back, never sooner.
6. Finish (or Leave) and confirm that both show the same Final standings, with the recovered driver classified like any other.

Real phone and tablet play has not been tested by this work (see the evidence). These steps are the first physical-device check.

**Rollback** is unchanged: remove `VITE_ONLINE` from the build (the title shows local play only), and/or follow the server rollback in the runbook. After a server rollback across a protocol bump, pages on the newer bundle show *Online play is temporarily unavailable — try again shortly.* with **Retry**, and recover by themselves once the server and static site agree again (*Older server (#80)* above).
