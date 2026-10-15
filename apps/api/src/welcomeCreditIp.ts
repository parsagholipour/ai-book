import { clientNetworkKey } from "./clientNetwork.js";

/**
 * The address the welcome grant's per-IP cap counts: the client's network
 * (`clientNetworkKey`), so an IPv6 signup is counted by its /64 rather than by
 * an address the device can rotate at will. The auth routes' per-address rate
 * limits count the same key.
 */
export function welcomeCreditIpKey(ip: string): string {
  return clientNetworkKey(ip);
}
