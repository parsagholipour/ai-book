import { BlockList, isIP } from "node:net";

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3]
] as const) nonPublic.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]
] as const) nonPublic.addSubnet(address, prefix, "ipv6");

/** Offline lookup: no reader IP is sent to a third party, and only country is retained. */
export async function lookupSignupCountry(clientIp: string): Promise<string | null> {
  const ip = clientIp.replace(/^::ffff:/i, "");
  const version = isIP(ip);
  if (!version || nonPublic.check(ip, version === 4 ? "ipv4" : "ipv6")) return null;
  // Load the bundled database only when the first public signup needs it.
  const { default: geoip } = await import("geoip-lite");
  const country = geoip.lookup(ip)?.country;
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}
