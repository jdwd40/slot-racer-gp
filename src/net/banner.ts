// The online connection banner's per-screen choices (#64), kept free of the DOM so tests can pin them down.
// On a race the banner floats over the track below the HUD and speaks of the car the server is holding. On the menu cards
// (online menu, lobby, final standings) there is no car on track yet or any more, and a floating banner at the HUD's height
// sat over the card's room heading and Copy code button: there it talks about the seat, and the card makes room for it.

/** Screens that are a menu card rather than a race: the banner never covers them, and a dropped link holds a seat, not a car. */
const CARD_SCREENS: ReadonlySet<string> = new Set(['online', 'lobby', 'netres']);

/** Whether the banner sits above a menu card on this screen (the card is pushed down below it instead of covered). */
export function bannerOnCard(screen: string): boolean { return CARD_SCREENS.has(screen); }

/** Which reconnecting text this screen shows: the seat wording on the menu cards, the unchanged car wording everywhere else. */
export function reconnectTextId(screen: string): 'net.reconnecting' | 'net.reconnectingLobby' {
  return bannerOnCard(screen) ? 'net.reconnectingLobby' : 'net.reconnecting';
}
