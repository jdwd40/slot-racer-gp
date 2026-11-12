// The one question every traffic check asks about another car: is it out of traffic? (#74 review). A car out of traffic is
// still drawn and still in the race, but nothing that reads other cars' places may react to it: collisions, the AI's and the
// automatic pit controller's following, the shared pit queue and the stop-and-go box order, the squeeze priority queue,
// lane-change, merge and re-slot clearance, defensive driving, and who traps whom for the stopped-on-track rule. Kept in its
// own module (types only from race.ts) so the race core and the pit traffic both use exactly this predicate.
import type { Car } from './race';

/**
 * De-slotted or retired-and-parked (mode `off`), towed or waiting out of sight for its bay (mode `tow`), or held where it
 * stopped while its driver is away (`away`, #74). Each site still applies its own mode filter (road, pit lane, grid) on top.
 */
export function outOfTraffic(c: Car): boolean {
  return c.away || c.mode === 'off' || c.mode === 'tow';
}
