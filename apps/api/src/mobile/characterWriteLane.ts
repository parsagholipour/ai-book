import type { FastifyReply, FastifyRequest } from "fastify";
import type { InMemoryRateLimiter } from "../rateLimit.js";
import type { MobileAuthContext } from "../requestAuth.js";
import { hitAuthenticatedLimit, requireMobileAuth } from "./httpErrors.js";
import {
  characterRetryTransactionOptions,
  type CharacterTransactionOptions
} from "./characterWriteBudget.js";
import { sendCharacterWriteError } from "./characterWriteConflicts.js";

/** The authenticated portion shared by every character prose write. */
type CharacterWriteLaneContext = {
  auth: MobileAuthContext;
};

/**
 * Access to the one wall-clock budget shared by a timed route's reads and
 * transaction attempts.
 *
 * Both readings are functions because DELETE can ask again after its first
 * attempt and portrait-liveness check. They always measure from immediately
 * before authentication, never from when the route body happens to ask.
 */
export type TimedCharacterWriteLaneContext = CharacterWriteLaneContext & {
  elapsedMs: () => number;
  transactionOptions: () => CharacterTransactionOptions | null;
};

type CharacterWriteLaneHandler<Result, Context extends CharacterWriteLaneContext> = (
  request: FastifyRequest,
  reply: FastifyReply,
  context: Context
) => Promise<Result>;

type CharacterWriteLaneBaseOptions = {
  /** The configured bucket for this write kind. */
  limiter: InMemoryRateLimiter;
  /** The account-keyed action component of that bucket. */
  actionKey: string;
};

export type TimedCharacterWriteLaneOptions<Result> = CharacterWriteLaneBaseOptions & {
  timingRequired: true;
  handler: CharacterWriteLaneHandler<Result, TimedCharacterWriteLaneContext>;
};

export type UntimedCharacterWriteLaneOptions<Result> = CharacterWriteLaneBaseOptions & {
  timingRequired: false;
  handler: CharacterWriteLaneHandler<Result, CharacterWriteLaneContext>;
};

type CharacterWriteRouteHandler<Result> = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<Result | undefined>;

/**
 * The narrow lifecycle common to POST, PATCH, and DELETE character writes.
 *
 * Everything after authentication and the account-keyed limit remains in the
 * route body. The wrapper owns only the lane clock, auth/limit guards, and the
 * shared error translation; unknown failures retain their stack and reach
 * Fastify's error handling.
 */
export function characterWriteLane<Result>(
  options: TimedCharacterWriteLaneOptions<Result>
): CharacterWriteRouteHandler<Result>;
export function characterWriteLane<Result>(
  options: UntimedCharacterWriteLaneOptions<Result>
): CharacterWriteRouteHandler<Result>;
export function characterWriteLane<Result>(
  options: TimedCharacterWriteLaneOptions<Result> | UntimedCharacterWriteLaneOptions<Result>
): CharacterWriteRouteHandler<Result> {
  return async (request, reply) => {
    // This is deliberately the first request-time operation. Authentication
    // reads MobileSession through the same pressured pool as the route body,
    // and charging it from anywhere later can put the 503 past the app's
    // receive timeout.
    const laneStartedAt = options.timingRequired ? Date.now() : null;
    try {
      const auth = await requireMobileAuth(request, reply);
      if (!auth) {
        return;
      }
      if (!hitAuthenticatedLimit(options.limiter, reply, auth.user.id, options.actionKey)) {
        return;
      }
      if (options.timingRequired) {
        if (laneStartedAt === null) {
          throw new Error("A timed character write lane has no start time.");
        }
        const elapsedMs = () => Date.now() - laneStartedAt;
        return await options.handler(request, reply, {
          auth,
          elapsedMs,
          transactionOptions: () => characterRetryTransactionOptions(elapsedMs())
        });
      }
      return await options.handler(request, reply, { auth });
    } catch (error) {
      if (sendCharacterWriteError(reply, error)) {
        return;
      }
      throw error;
    }
  };
}
