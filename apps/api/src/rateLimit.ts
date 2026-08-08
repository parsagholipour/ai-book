import type { FastifyReply, FastifyRequest } from "fastify";

export type RateLimitConfig = {
  maxAttempts: number;
  windowMs: number;
};

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly config: RateLimitConfig;

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

export function sendRateLimitError(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  reply.header("Retry-After", String(retryAfterSeconds));
  return reply.code(429).send({
    error: {
      code: "RATE_LIMITED",
      message: "Too many attempts. Try again soon."
    }
  });
}
