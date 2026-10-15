import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter, clientNetworkRateLimitKey, rateLimitKey } from "./rateLimit.js";

function requestFrom(ip: string): FastifyRequest {
  return { ip } as FastifyRequest;
}

describe("client network rate limit key", () => {
  it("puts two IPv6 addresses in one /64 in one bucket, and a neighbouring /64 in another", () => {
    const first = clientNetworkRateLimitKey(requestFrom("2001:db8:abcd:12:1111:2222:3333:4444"), "signin");
    const rotated = clientNetworkRateLimitKey(requestFrom("2001:0db8:abcd:0012::9"), "signin");
    const neighbour = clientNetworkRateLimitKey(requestFrom("2001:db8:abcd:13::1"), "signin");

    expect(first).toBe(rotated);
    expect(first).not.toBe(neighbour);
    // The address-keyed limits still see two callers where this sees one.
    expect(rateLimitKey(requestFrom("2001:db8:abcd:12::1"), "x")).not.toBe(
      rateLimitKey(requestFrom("2001:db8:abcd:12::2"), "x")
    );
  });

  it("keys IPv4 by the full address, mapped or not", () => {
    const client = clientNetworkRateLimitKey(requestFrom("203.0.113.10"), "signin");

    expect(clientNetworkRateLimitKey(requestFrom("::ffff:203.0.113.10"), "signin")).toBe(client);
    expect(clientNetworkRateLimitKey(requestFrom("203.0.113.11"), "signin")).not.toBe(client);
  });

  it("keeps the route label apart, and names a missing address", () => {
    expect(clientNetworkRateLimitKey(requestFrom("203.0.113.10"), "signin")).not.toBe(
      clientNetworkRateLimitKey(requestFrom("203.0.113.10"), "signup")
    );
    expect(clientNetworkRateLimitKey(requestFrom(""), "signin")).toBe("network:unknown:signin");
  });

  it("refuses a /64 that rotates addresses once the shared bucket is spent", () => {
    const limiter = new InMemoryRateLimiter({ maxAttempts: 2, windowMs: 60_000 });
    const hit = (ip: string) => limiter.hit(clientNetworkRateLimitKey(requestFrom(ip), "signin"), 0);

    expect(hit("2001:db8:abcd:12::1").allowed).toBe(true);
    expect(hit("2001:db8:abcd:12::2").allowed).toBe(true);
    expect(hit("2001:db8:abcd:12::3")).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(hit("2001:db8:abcd:13::1").allowed).toBe(true);
    expect(hit("203.0.113.10").allowed).toBe(true);
  });
});
