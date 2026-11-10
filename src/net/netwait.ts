// The "Classification pending" (netwait) screen's safety net (#43). That screen only changes when a state or result message
// arrives, so a connection that died without a close (or a room that vanished on the server) could leave it waiting forever.
// This is the decision logic only, with no DOM: main.ts renders the view it reports, and tests drive it with fake timers.
// It never runs a reconnect of its own: it asks the session to resume through the same drop path as the client's watchdog.
import { KEEPALIVE_TICK_MS, SUSPEND_GAP_MS } from './client';
import type { Conn, EndReason } from './session';

/** No new state or result for this long while the screen shows: the link is treated as dead and the seat resumed. */
export const NETWAIT_TIMEOUT_MS = 30000;

/** `waiting`: the normal card. `lost`: reconnecting after a dead link. `closed`: the resume was refused, so no result will come. */
export type NetWaitView = 'waiting' | 'lost' | 'closed';

export interface NetWaitDeps {
  conn(): Conn;
  /** ask the session to resume (NetSession.reconnectNow, which does nothing if a reconnect is already under way) */
  reconnect(): void;
  render(view: NetWaitView): void;
  now?: () => number;
}

export class NetWaitGuard {
  view: NetWaitView = 'waiting';
  /** time counted towards the timeout since the last news, excluding time this page was suspended */
  quietMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private readonly now: () => number;

  constructor(private deps: NetWaitDeps) { this.now = deps.now ?? (() => Date.now()); }

  get active(): boolean { return this.timer !== null; }

  /** The screen opened: a fresh 30 s window. A reconnect already under way shows as lost contact at once. */
  start(): void {
    this.stop();
    this.quietMs = 0;
    this.lastTickAt = this.now();
    this.view = this.deps.conn() === 'reconnecting' ? 'lost' : 'waiting';
    // Time is counted in ticks rather than with one 30 s timeout so that this page's own suspension is left out, the same
    // way the client's keepalive does it: a tick that runs more than SUSPEND_GAP_MS late (a background tab's throttled
    // timers, a frozen phone page) adds nothing, and wake() on visibility return restarts the tick clock. A hidden tab
    // therefore never times out by itself; on return it gets the rest of its window, and the watchdog checks the socket.
    this.timer = setInterval(() => this.tick(), KEEPALIVE_TICK_MS);
    this.deps.render(this.view);
  }

  /** The screen was left (a result, leave, menu, session end): no timer remains. */
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** A state or result message arrived: the window starts again. */
  news(): void { this.quietMs = 0; }

  /** This page is running again after being hidden: the time it was away is not counted. */
  wake(): void { this.lastTickAt = this.now(); }

  /** The session's connection changed. */
  conn(c: Conn): void {
    if (!this.active || this.view === 'closed') return;
    if (c === 'reconnecting' && this.view !== 'lost') { this.view = 'lost'; this.deps.render(this.view); }
    else if (c === 'connected' && this.view === 'lost') {
      // resumed: the normal card again, and a full window for the server to send the next state
      this.quietMs = 0; this.lastTickAt = this.now();
      this.view = 'waiting'; this.deps.render(this.view);
    }
  }

  /**
   * The session ended while the screen showed. A refused resume (`expired`, which also covers `not_found`) means the room
   * closed before results were sent: returns true and shows that, and the caller keeps the screen instead of the menu.
   */
  ended(why: EndReason): boolean {
    if (!this.active) return false;
    this.stop();
    if (why !== 'expired') return false;
    this.view = 'closed';
    this.deps.render(this.view);
    return true;
  }

  private tick(): void {
    const now = this.now();
    const dt = now - this.lastTickAt;
    this.lastTickAt = now;
    // a reconnect under way owns the link: nothing is counted until it is answered, so no second one is started
    if (this.view !== 'waiting' || this.deps.conn() !== 'connected' || dt > SUSPEND_GAP_MS) return;
    this.quietMs += dt;
    if (this.quietMs < NETWAIT_TIMEOUT_MS) return;
    this.view = 'lost';
    this.deps.render(this.view);
    this.deps.reconnect();
  }
}
