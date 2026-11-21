// Bay paint (#147: split out of src/world.ts with no Three.js, so the first chunk can work out who owns which bay before
// the 3D view has loaded; world.ts draws it and re-exports these).
import { DRIVERS, type Car, type DriverId, type Race } from './race';
import { t } from './i18n';

/**
 * How one service bay is drawn: its owner's colour, race number, pit-board tag and garage sign text, or a neutral unowned
 * bay (num null).
 */
export interface BayPaint { color: number; num: number | null; tag: string; sign: string; mine: boolean; }

/** Garage sign string ids for each driver slot's stock driver (slot 0 is the solo driver's: YOU). */
const STOCK_SIGNS = ['hud.you', 'garage.sign1', 'garage.sign2', 'garage.sign3'];
export const stockSign = (k: number): string => t(STOCK_SIGNS[k] ?? 'hud.you');

/**
 * Paint for every bay from the race's owners (Car.bayHome): the owner's colour and number, its tag (the local driver's
 * reads YOU) and its garage sign (YOU for the local driver, a stock rival's garage name, else its tag).
 */
export function bayPaints(race: Race, me: DriverId): BayPaint[] {
  return race.T.BAYS.map((_, j) => {
    const o = race.bayOwner(j);
    if (!o) return { color: 0, num: null, tag: '', sign: '', mine: false };
    const mine = o.id === me;
    const k = DRIVERS.findIndex((d) => d.name === o.name);
    const tag = (c: Car): string => (mine ? t('hud.you') : DRIVERS[k]?.tag ?? c.name.slice(0, 5).toUpperCase());
    const sign = mine ? t('hud.you') : k > 0 ? stockSign(k) : tag(o);
    return { color: o.color, num: o.num, tag: tag(o), sign, mine };
  });
}

