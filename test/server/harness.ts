// In-process room harness: a manual wall clock, in-memory peers and the real RoomManager. Whole races run in well under a
// second of test time, with the same code path the WebSocket layer drives.
import type { RaceSnapshot } from '../../src/race';
import type { PublicRoom, ServerMsg } from '../../src/net/protocol';
import { testConfig, type Config } from '../../server/config';
import { memoryLogger } from '../../server/log';
import { MemoryResultSink } from '../../server/results';
import { RoomManager } from '../../server/rooms';
import type { Peer } from '../../server/room';
import { drive } from './bot';

export class FakePeer implements Peer {
  msgs: ServerMsg[] = [];
  raw: string[] = [];
  closed: { code: number; reason: string } | null = null;
  bufferedAmount = 0;
  send(d: string): void { if (this.closed) throw new Error('closed'); this.raw.push(d); this.msgs.push(JSON.parse(d) as ServerMsg); }
  close(code: number, reason: string): void { if (!this.closed) this.closed = { code, reason }; }
  of<K extends ServerMsg['t']>(t: K): Extract<ServerMsg, { t: K }>[] { return this.msgs.filter((m): m is Extract<ServerMsg, { t: K }> => m.t === t); }
  lastRoom(): PublicRoom { return this.of('room').at(-1)?.room ?? this.of('joined').at(-1)!.room; }
  lastSnap(): RaceSnapshot | null { return (this.of('state').at(-1)?.snap as RaceSnapshot) ?? null; }
}

export function harness(over: Partial<Config> = {}, seed = 7) {
  let now = Date.UTC(2026, 10, 9, 12, 0, 0);
  const cfg = testConfig(over);
  const log = memoryLogger();
  const sink = new MemoryResultSink();
  const mgr = new RoomManager({ cfg, log, sink, now: () => now, seed: () => seed });
  return {
    mgr, cfg, log, sink,
    get now() { return now; },
    /** advance wall time in ticks of `tickMs`, pumping every room each tick; `each` runs before every tick */
    advance(ms: number, tickMs = 50, each?: () => void, stop?: () => boolean) { for (let t = 0; t < ms; t += tickMs) { if (stop?.()) return; each?.(); now += tickMs; mgr.tick(); } },
    set(ms: number) { now = ms; },
  };
}

/** Per-peer bot state: numbered held controls and actions from that peer's own snapshots. */
export class BotClient {
  ctl = 0; act = 0; pace: number;
  constructor(public peer: FakePeer, public id: string, pace = 1) { this.pace = pace; }
  controls(): { up: boolean; down: boolean; pit: boolean } | null {
    const s = this.peer.lastSnap();
    return s ? drive(s, this.id, this.pace) : null;
  }
}
