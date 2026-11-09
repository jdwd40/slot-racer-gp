# Automatic bay visits

After Pit is selected, the car takes the outside route, enters, queues and stops in its own bay, without manual braking. It refuels as before, then leaves when the player asks with a fresh Throttle press. If the merge or the exit is blocked, the car waits and then goes. This builds on [lane routing](pit-routing.md), [obligations](penalties.md), the [shared pit queue](pit-queue.md) and [automatic stop-and-go](auto-stop-go.md), and finishes the combined stop-and-go and fuel visit.

## Bay ownership

- `Car.bayHome` is the car's own bay for the whole race. It is the car's participant slot (`idx`), fixed when the `Race` is built: the player has bay 1 (the first down the pit lane), then Red Comet, Blue Arrow and Green Viper. `Car.bay` is separate and mutable: the bay the car currently holds or stands in. `Race.bayOwner(j)` answers who owns bay *j*. In practice only the player races, so the other three bays have no owner.
- Authority comes only from `bayHome`. `PitTraffic.updateBays` grants only the car's own bay. The player's manual capture (`tryBay`), the AI's stop, the automatic stop and both tows (road and pit lane) use only that bay. The old fallback to "the first free bay ahead" (`pickBay`) has been removed. If a car's own bay is occupied or reserved, the car **waits**. The AI and the player stop `AUTO.bayWait` (2.2 m) short of the bay, which is clear of the occupant's merge zone, so the occupant can always leave. A car never takes another team's bay.
- Colour is presentation only. `main.ts` paints each bay from `Race.bayOwner()` through `World.paintBays()`. That covers the bay lines (sides and a new back line), the crew, the pit-wall monitor and a pit board showing `BAY n`, the owner's race number (the one on the car) and its tag (`YOU`, `RED`, `BLUE`, `GREEN`). The player's board also has a border in the livery. All four liveries (Sunburst, Blaze, Frost, Violet) are supported, and bays are repainted whenever a race is built, so changing the car on the title screen repaints them. Unowned bays in practice are neutral grey with `–`. The rendering never decides who may use a bay.
- The same rule applies to AI cars, and it is keyed by participant slot, not by "human or AI". Four human participants later would each keep their own bay with no change.

## Driving

`Race.sgUpdate()` (the automatic pit controller) now drives fuel visits as well as stop-and-go visits. It runs for the player before each car step and sets `sgCtl` (the controller has the pedals) and `sgPhase` (what the HUD shows).

| Where | Phase | HUD chip / status |
| --- | --- | --- |
| Road, a fuel visit (`fuelReq` or `fuelDue`) routed to this entrance, within `AUTO.window` (40 m) and reachable | `entry`, or `queued` | **AUTO ENTRY** · "Auto entry — braking for your bay n" |
| Pit lane, stop-and-go owed | `entry`, `queued`, `serving` | As in [automatic stop-and-go](auto-stop-go.md) |
| Pit lane, fuel visit, own bay still ahead | `bay`, or `bayWait` while the bay is occupied, or `queued` | **AUTO PIT · BAY n** / **WAITING FOR BAY n** |
| Turning in, then refuelling before departure is available | `refuel` | **IN BAY n** · "REFUELLING n% · stay n s for the fuel stop to count" or "you can leave in n s" or the tow penalty |
| Departure available, Throttle still held since before | `release` | **RELEASE THROTTLE** · "release Throttle, then press it to leave". Touch Throttle reads `lift off` |
| Departure available | `ready` | **READY — THROTTLE TO LEAVE** · "press Throttle to leave". Touch Throttle reads `tap · leave` |
| Departure latched, merge not yet clear | `exit` | **WAITING FOR CLEAR EXIT** · "Waiting for clear exit — you leave as soon as it is safe" |
| Bay exit and the pit lane to the exit | `leaving` | **LEAVING PITS**, plus **WAITING FOR CLEAR EXIT** at the exit line |
| Past `PIT_OUT1` | none | "Out of the pits — you have control" |

- **Speed.** The target is the same as for the box (`sgTarget`). On the road it brakes at `AUTO.plan` to the pit limit by the entrance. In the pit lane it brakes at `AUTO.box` to rest at `Race.autoStopS()`, which is the box centre while a stop-and-go is owed, otherwise the centre of the car's own bay, or `AUTO.bayWait` short of it while the bay is occupied. The shared queue cap (`pitCap`) and the pit limiter apply on top. Throttle and Brake are ignored while `sgCtl` is set, so a held Throttle cannot overshoot. At rest within `AUTO.bayTol` (0.15 m) of the bay centre, the car turns in through `enterBay`, using the existing entry animation (0.45 s), refuel delay (0.4 s), refuel rate (0.2 tank/s), tank cap (1.0) and exit animation (0.4 s).
- **Too fast to take over.** A fuel visit, unlike a stop-and-go, is still entered. The pit limiter slows the car and the controller takes it in the pit lane. In practice the takeover test (braking of at most `AUTO.late`, 24 m/s², by the entrance) always passes below about 44 m/s.
- **Combined visit.** The stop-and-go is served first in the shared box (it lies before every bay). The controller then continues to the bay. Refuelling never changes `sgOwed`. A penalty-only visit has `pitFuel` false, is driven past the bays and never stops in one. The two debts still clear independently, as in [service obligations](penalties.md).
- **After the visit.** `serviced` is set when the car leaves the bay, the fuel request was cleared at the entrance, and a committed fuel stop clears after `SERVICE_READY` in the bay. So completing a fuel stop neither re-arms routing at the next switch nor clears another obligation (both are tested).

## Departure

- **Ready** means `Race.departBlock()` is null. The car must have stood in service for longer than `SERVICE_READY` (0.5 s, the time a committed fuel stop needs to count), and no tow penalty may be running. A full tank never leaves by itself.
- **A fresh press.** `Car.upPrev` is the Throttle seen in the bay. `enterBay` and a tow set it to "held", so a pedal held on arrival must be seen released before anything counts. A press is a rising edge in `service`. If it comes before departure is ready, it is refused with the reason ("Not yet — stay n s for the stop to count, then press Throttle" or "Not yet — tow penalty, n s left") and does not latch. Holding it through the ready moment then needs a release and another press. Keyboard and touch are the same action through `DrivingInput`. Pause, blur, a hidden tab and screen changes clear held input (`releaseDriving`), which the bay sees as a release. A key still physically down sends no new keydown, so it never departs by itself.
- **Latched.** One accepted press sets `exitReq`. Refuelling stops at that moment, for every car. The request is kept through release, pause and blur. The car stays in its bay ("Waiting for clear exit") until `PitTraffic` grants its merge under the existing [passage rules](pit-queue.md#bay-departures-and-passage-priority), then performs the exit animation once.
- **Leaving.** Back in the through lane the controller drives at the pit limit (`sgLeave`), waits at the exit line while the outside lane is blocked (`exitHold`), merges when it holds the exit, and hands back past `PIT_OUT1`, in the outside lane. If the car finishes the race in the pit lane (the timing line is between the bays and the exit), control ends there as before.

## Overrides, reverse and pause

- **Before the entrance** the existing rules apply. Defer (N) works where [penalties](penalties.md) allows it. Pit (P) cancels an optional stop and releases the controller on the road. Space takes a switch that is still ahead (an optional stop driven past on the override becomes a committed stop due next lap, which is then served automatically). With no switch left during a fuel takeover, Space is now refused ("No switch before the pit entrance — the car stops in your bay. P cancels an optional stop, N defers it if offered") instead of arming an override nothing can use.
- **Inside the pit geometry** the lane is single file. Space is refused as before, Defer and Pit do nothing, and the queue and exit rules decide who moves.
- **Reverse.** While the controller has the car, `reverseBlock()` returns `assist`, and in a bay it returns `mode`. Either refusal latches the current Brake press, so Brake held through the approach, the bay, the wait and the exit never reverses, even after the handover. A fresh press after the handover reverses as usual. A car that gets past its own bay by hand is not controlled, can reverse back, and is captured by its own bay when it is released there. Backing over the pit entrance with a fuel visit owed brings the car into the 40 m window, so it is taken over and driven in. This is the same rule as for a stop-and-go.
- Saved records, ghosts and championships are untouched. No storage keys or formats changed. `DRIVERS` gained `num` and `tag` (the race numbers 7, 11, 3 and 24 that were already painted on the cars).

## Evidence

**The build host has no GPU.** Browser runs used SwiftShader (ANGLE on Vulkan, software), and touch was Chromium CDP emulation. **They are diagnostics only. They say nothing about behaviour or smoothness on a real phone, tablet or GPU. No physical device was tested.** Every browser scenario was set up by scripted placement, so this is functional coverage, not play-testing. Setup: headless Chromium 156.0.8078.4, Linux 7.0.0-42-generic x64, 480×270 at Low unless a scenario sets its own size.

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm test`, `npm run build` | Pass on `64c86f8`: 427 tests in 15 files, of which `test/autoBay.test.ts` adds 46 |
| AI regression | 20 seeded all-AI races (5 circuits × 4 seeds, to the flag) on `1abddd9` and on this change. They match in every car's status, pit-stop count (140 in total), offences and finish time to 0.01 s. Final fuel is 0.001 to 0.002 lower, because refuelling now stops at the departure request instead of running on while the merge is granted. No bay was granted to any car but its owner, and no car stood still outside a bay or tow for more than 0.92 s (the same as the baseline) |
| `autobay` browser scenario (new) | 27 of 27 on `64c86f8`. Bay paint for all four liveries (number 7, tag `YOU`, rivals unchanged), with a screenshot of the Violet bay. Keyboard: P and W held into its own bay at the pit limit, never past it, no Brake. Release Throttle, then Ready, then one tap of W leaves with refuelling stopped at the tap, Leaving pits and the handover past the exit. A blocked bay merge shows Waiting for clear exit in the bay, and the request survives Esc and a window blur, then leaves with no second press. A key held across a blur never departs. A blocked pit exit waits at the line, then hands back. A combined visit goes box, then bay. Pause help text. Emulated touch at 844×390, 360×640 and 1024×768: finger held (`lift off`, Release Throttle, no departure), lifted (`tap · leave`), one tap leaves. Chip and status line stay on screen and clear of every pad control. No page errors |
| `reverse` | 8 of 9 on `eaf437a`. Its bay check reversed into bay 4, which is Green Viper's and now correctly never captured. It now recovers the player's own bay: 9 of 9 on `64c86f8` |
| `race` (13 laps, real keys) | 23 of 23 on `eaf437a`, with two automatic bay stops (pit entry, service and exit in order). The shared driver no longer brakes by hand while the controller drives, and it presses W afresh to leave |
| `touchrace` (13 laps on the emulated pad) | 7 of 7 on `eaf437a`, including its fuel stop |
| `tracks`, `controlled`, `routing`, `practice`, `championship`, `touch`, `responsive`, `service`, `queue`, `autosg` | 6, 17 (plus the existing n/a for a real window blur and tab switch), 16, 10, 9, 53, 71, 16, 12 and 16 passed on `eaf437a` (one bounded run of 41 minutes). Records, ghost and championship saves are covered by `practice` and `championship` |

`eaf437a` and `64c86f8` differ only in the pit-lane edge case below, its unit tests and the browser-check script.

`test/autoBay.test.ts` (46 tests) covers:

- **Ownership:** `bayHome` per slot and independent of `bay`, `bayOwner`, practice leaving rivals' bays unowned, every livery on the player's bay with the rivals unchanged, and reservations, AI stops and tows using only the car's own bay.
- **Every circuit × both lanes × {Throttle held, no pedal}**, rotating liveries: phases entry → bay → refuel, no Brake after the takeover, entry at or under the pit limit, never past its bay before turning in, never backwards. Own bay only, one stop, refuel rate within bounds, held Throttle never departs. One fresh press leaves with no fuel added after it. Leaving pits, then the handover within 0.3 m past `PIT_OUT1` in the outside lane, with no overlap or offence. Nothing owed or re-armed afterwards and every grant released.
- **Departure press:** held on arrival (needs release, then one press, one merge and one exit even after repeated presses), a press before ready (refused with its reason, then only a fresh press counts), a tow penalty (refused, then accepted after), a full tank (never leaves, never above 1.0), refuelling stopping at the request and the request surviving release while a lane car blocks the merge, keyboard and touch sources and a pause clearing a held key, and Brake held through service, wait and exit with no reverse until a fresh press after the handover.
- **Conflicts:** the player's own bay occupied (waits at `AUTO.bayWait`, no other bay, enters once it is free), an AI car's bay occupied, three simultaneous arrivals in either array order at 1/30, 1/60 and 1/144 s (each to its own bay, no overlap, offences or wrong-bay grants), adjacent departures at once (downstream first, never together, both leave), and a blocked pit exit (waits at the line, then merges and is handed back).
- **Obligations:** combined visit (box, then bay, each debt clearing only itself, no Brake), a stop-and-go not paid by refuelling, a penalty-only visit never stopping in a bay, the final-lap fuel stop classified at the flag, due next lap after an override (served automatically next lap, not re-armed after), Space refused with no switch left, Pit cancelling during the takeover, a manual stop beside another team's bay never captured but reversing back to its own bay captured.
- **Past the bay by hand:** a fuel visit beyond its bay's capture window is not controlled. Brake-hold reverse brings it back, and releasing captures its own bay. Just short of or at the centre, the controller still brings it in. This found and fixed an edge case on `eaf437a`: a car reversed back to just past the centre was retaken with its stop point behind it and would have stood still. The controller now only claims a car within `AUTO.bayTol` of the centre or short of it.
- **Frame rate:** the turn-in point is within `AUTO.bayTol` at 1/24, 1/60 and 1/144 s.

Older tests that encoded "any free bay" or a manual bay stop were updated. These are the obligations helper using the player's own bay, the combined-visit and dry-tank cases in `autoStopGo.test.ts`, the queue tests (four-car train with the player stopping in its bay, own-bay reservations, a fresh press to leave), and the reverse tests (recovery into the car's own bay, an occupied own bay, a missed entrance now taken over).

### Known limits

- No physical keyboard, phone or tablet was used. All touch input is emulated and the renderer is software.
- Scripted placement only. No full race was played by a person to an automatic bay visit. The `race` and `touchrace` scenarios do drive whole races with real key or touch events through the new flow.
- The waiting point short of an occupied bay assumes the occupant arrived first. A car could only reach another car's bay in a scripted set-up, because every grant, stop and tow uses the car's own bay.
