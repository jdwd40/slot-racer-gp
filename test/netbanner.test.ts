// The reconnect banner's wording and placement per screen (#64): menu cards speak of the held seat and make room for the
// banner; races keep the car wording. The layout itself (no overlap with the room code or Copy code) is the browser check's
// `netbanner` scenario.
import { describe, it, expect } from 'vitest';
import { bannerOnCard, reconnectTextId } from '../src/net/banner';
import { t } from '../src/i18n';

describe('reconnect banner per screen', () => {
  it('the lobby, online menu and final standings say the seat is held, with the grace period', () => {
    for (const s of ['lobby', 'online', 'netres']) {
      expect(reconnectTextId(s)).toBe('net.reconnectingLobby');
      expect(bannerOnCard(s)).toBe(true);
      expect(t(reconnectTextId(s), { n: 20 })).toBe('Connection lost. Reconnecting… your seat is held for up to 20 s.');
    }
  });

  it('a race and the pending card keep the car wording, and the banner floats below the HUD', () => {
    for (const s of ['race', 'netwait', 'pause', 'results', 'title']) {
      expect(reconnectTextId(s)).toBe('net.reconnecting');
      expect(bannerOnCard(s)).toBe(false);
    }
    expect(t(reconnectTextId('race'), { n: 20 })).toBe('Connection lost. Reconnecting… your car is held where it stopped for up to 20 s.');
  });

  it('the race wording says what the server does (#74): the car is held where it stopped, for the room\'s grace period', () => {
    // the server holds an away driver's car on the spot, out of traffic, and never recovers it to the pits meanwhile
    expect(t('net.reconnecting', { n: 30 })).toBe('Connection lost. Reconnecting… your car is held where it stopped for up to 30 s.');
    expect(t('net.reconnecting', { n: 20 })).toContain('held where it stopped');
    // the lobby wording is unchanged: no car on track there
    expect(t('net.reconnectingLobby', { n: 20 })).not.toContain('car');
  });

  it('the seat wording follows the room\'s grace period like the race wording does', () => {
    expect(t('net.reconnectingLobby', { n: 30 })).toBe('Connection lost. Reconnecting… your seat is held for up to 30 s.');
  });
});
