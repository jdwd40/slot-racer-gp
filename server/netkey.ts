// The key every per-address limit and quota is charged to (#97): connections per address, open rooms and room creates per
// address, failed joins and sign-ins, registrations.
//
// One home or VPS on IPv6 normally holds a whole /64 (2^64 addresses) and can rotate its source address within it at will,
// so for IPv6 the limit is per /64, not per address. IPv4 stays per address, and an IPv4-mapped IPv6 address
// (::ffff:a.b.c.d, which is what a dual-stack socket reports for an IPv4 peer) is that IPv4 address. Every spelling of one
// address (upper or lower case, `::` or written out, leading zeros, a zone id) gives the same key. Anything that is not an
// IP address is its own key, unchanged: this never throws, and limitKey(limitKey(a)) === limitKey(a).
//
// Logs keep the full address; only limits use this.
import { isIPv4, isIPv6 } from 'node:net';

/** The eight 16-bit groups of a valid IPv6 address (no zone id), with an embedded dotted IPv4 tail expanded. */
function groups(a: string): number[] {
  const words = (part: string): number[] => {
    if (part === '') return [];
    const out: number[] = [];
    for (const w of part.split(':')) {
      if (w.includes('.')) { const b = w.split('.').map(Number); out.push((b[0] << 8) | b[1], (b[2] << 8) | b[3]); }
      else out.push(parseInt(w, 16));
    }
    return out;
  };
  const gap = a.indexOf('::');
  if (gap < 0) return words(a);
  const head = words(a.slice(0, gap)), tail = words(a.slice(gap + 2));
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** The per-address limit key for a client address: an IPv6 /64 prefix, an IPv4 address, or the input itself. */
export function limitKey(addr: string): string {
  if (typeof addr !== 'string') return String(addr);
  const s = addr.trim();
  if (isIPv4(s)) return s;
  let v6 = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  const zone = v6.indexOf('%');
  if (zone >= 0) v6 = v6.slice(0, zone);
  if (!isIPv6(v6)) return addr;
  const g = groups(v6);
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return addr;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}
