import { isIPv6 } from "node:net";

/**
 * The network a client address belongs to, which for IPv6 is the /64 rather
 * than the address. One home or phone is handed a whole /64 and picks a fresh
 * address in it at will (privacy extensions rotate it daily, and nothing stops
 * a script choosing a new one per request), so anything counted per full IPv6
 * address — the welcome grant's per-IP cap, the auth routes' per-address rate
 * limits — counted nothing. IPv4, including an IPv4-mapped IPv6 address, is
 * the address itself, so a hash stored before the /64 change still matches.
 */
export function clientNetworkKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) {
    return mapped[1];
  }
  if (!isIPv6(ip)) {
    return ip;
  }
  const hextets = expandIpv6(ip);
  return hextets ? `${hextets.slice(0, 4).join(":")}::/64` : ip;
}

function expandIpv6(ip: string): string[] | null {
  let address = ip.split("%")[0] ?? ip;
  // An embedded IPv4 tail (64:ff9b::192.0.2.1) is two hextets.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    address = `${address.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) =>
    (Number.parseInt(part, 16) || 0).toString(16)
  );
}
