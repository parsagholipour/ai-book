import type { FastifyReply, FastifyRequest } from "fastify";

export type RateLimitConfig = {
  maxAttempts: number;
  windowMs: number;
};

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly config: RateLimitConfig;
  private hitsSinceSweep = 0;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  get maxAttempts(): number {
    return this.config.maxAttempts;
  }

  /**
   * `maxAttempts` overrides the configured ceiling for this hit only — how
   * subscriber tiers get more headroom out of the same bucket. Counting is
   * unchanged, so a caller alternating ceilings still shares one window.
   */
  hit(
    key: string,
    now = Date.now(),
    maxAttempts = this.config.maxAttempts
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    // Expired buckets were only ever overwritten, never removed, so a spray of
    // unique keys (rotating IPs, invented emails) grew the map without bound.
    // Swept amortized rather than per hit: a full scan every 1024 hits is
    // nothing, and between sweeps the map holds at most one window's strays.
    this.hitsSinceSweep += 1;
    if (this.hitsSinceSweep >= 1024) {
      this.hitsSinceSweep = 0;
      for (const [staleKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) {
          this.buckets.delete(staleKey);
        }
      }
    }

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.config.windowMs });
      return { allowed: true };
    }

    existing.count += 1;
    if (existing.count <= maxAttempts) {
      return { allowed: true };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    };
  }
}

export function rateLimitKey(request: FastifyRequest, ...parts: string[]): string {
  return [request.ip || "unknown", ...parts].join(":");
}

/**
 * A key with no IP in it, for limits whose identity is the account itself.
 *
 * The per-user limits used to ride on `rateLimitKey`, whose IP prefix handed a
 * fresh bucket to every address — and mobile carrier NAT rotates addresses for
 * free, so an authenticated caller could sidestep the very limits that are
 * about *them*. The IP-prefixed key remains right where the caller has no
 * identity yet (sign-in and sign-up).
 */
export function identityRateLimitKey(...parts: string[]): string {
  return ["identity", ...parts].join(":");
}

export function sendRateLimitError(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  reply.header("Retry-After", String(retryAfterSeconds));
  return reply.code(429).send({
    error: {
      code: "RATE_LIMITED",
      message: "Too many attempts. Try again soon."
    }
  });
}
