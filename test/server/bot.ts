// A headless driver: reads only what a client receives (the server's race snapshot) and answers with held controls and
// numbered actions, exactly like a remote player would. Uses the shared track geometry to pick safe corner speeds.
import { AI_GRIP, BRAKE, VMAX, type CarSnapshot, type RaceSnapshot } from '../../src/race';
import { trackFor } from '../../src/track';

const profiles = new Map<string, Float32Array>();
function profile(track: string, side: number): Float32Array {
  const k = `${track}:${side}`;
  let p = profiles.get(k);
  if (!p) { p = trackFor(track).buildProfile(side, AI_GRIP * 0.92, VMAX, BRAKE * 0.7); profiles.set(k, p); }
  return p;
}

export interface BotOut { up: boolean; down: boolean; pit: boolean; }

/** Pedals for car `id` from a snapshot; `pit` asks for a fuel stop once. `pace` < 1 drives slower. */
export function drive(snap: RaceSnapshot, id: string, pace = 1): BotOut {
  const c = snap.cars.find((x) => x.id === id) as CarSnapshot;
  if (!c || c.status !== 'running') return { up: false, down: false, pit: false };
  const T = trackFor(snap.track);
  if (c.mode === 'bayIn' || c.mode === 'service' || c.mode === 'bayOut') {
    // stay for the refuel, then a fresh press leaves
    return { up: c.sgPhase === 'ready' && c.fuel > 0.9, down: false, pit: false };
  }
  const side = (c.change ? c.change.to : c.laneSide) < 0 ? -1 : 1;
  const prof = profile(snap.track, side);
  const s = T.wrapS(c.u + Math.max(0, c.v) * 0.2);
  const target = prof[Math.min(prof.length - 1, Math.max(0, Math.round(s / T.PROFILE_STEP)))] * pace;
  return { up: c.v < target - 0.2, down: c.v > target + 2, pit: c.fuel < 0.42 && !c.pitReq && !c.fuelReq && c.fuelDue <= 0 && c.mode === 'race' };
}
