import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requireMobileAuth: vi.fn(),
  hitAuthenticatedLimit: vi.fn(),
  sendCharacterWriteError: vi.fn()
}));

vi.mock("./httpErrors.js", () => ({
  requireMobileAuth: dependencies.requireMobileAuth,
  hitAuthenticatedLimit: dependencies.hitAuthenticatedLimit
}));
vi.mock("./characterWriteConflicts.js", () => ({
  sendCharacterWriteError: dependencies.sendCharacterWriteError
}));

import type { FastifyReply, FastifyRequest } from "fastify";
import type { InMemoryRateLimiter } from "../rateLimit.js";
import type { MobileAuthContext } from "../requestAuth.js";
import { characterRetryTransactionOptions } from "./characterWriteBudget.js";
import { characterWriteLane } from "./characterWriteLane.js";

const request = {} as FastifyRequest;
const reply = {} as FastifyReply;
const limiter = {} as InMemoryRateLimiter;
const auth = {
  user: {
    id: "user-a",
    email: "reader@example.com",
    displayName: "Reader",
    status: "ACTIVE",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    legalAcceptanceRequired: false
  },
  sessionId: "session-a"
} satisfies MobileAuthContext;

describe("characterWriteLane", () => {
  beforeEach(() => {
    dependencies.requireMobileAuth.mockReset().mockResolvedValue(auth);
    dependencies.hitAuthenticatedLimit.mockReset().mockReturnValue(true);
    dependencies.sendCharacterWriteError.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts a timed lane before authentication and exposes the same clock to every budget reading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const order: string[] = [];
    dependencies.requireMobileAuth.mockImplementation(async () => {
      order.push("auth");
      vi.setSystemTime(6_000);
      return auth;
    });
    dependencies.hitAuthenticatedLimit.mockImplementation(() => {
      order.push("limit");
      return true;
    });

    const route = characterWriteLane<{ ok: true }>({
      limiter,
      actionKey: "character-write",
      timingRequired: true,
      handler: async (_request, _reply, { elapsedMs, transactionOptions }) => {
        order.push("handler");
        expect(elapsedMs()).toBe(5_000);
        expect(transactionOptions()).toEqual(characterRetryTransactionOptions(5_000));
        vi.setSystemTime(10_000);
        expect(elapsedMs()).toBe(9_000);
        expect(transactionOptions()).toEqual(characterRetryTransactionOptions(9_000));
        return { ok: true };
      }
    });

    await expect(route(request, reply)).resolves.toEqual({ ok: true });
    expect(order).toEqual(["auth", "limit", "handler"]);
    expect(dependencies.hitAuthenticatedLimit).toHaveBeenCalledWith(
      limiter,
      request,
      reply,
      "user-a",
      "character-write"
    );
  });

  it("does not create a client-budget clock for an untimed write", async () => {
    const now = vi.spyOn(Date, "now");
    const route = characterWriteLane<{ created: string }>({
      limiter,
      actionKey: "character-write",
      timingRequired: false,
      handler: async (_request, _reply, context) => {
        expect(context).toEqual({ auth });
        return { created: "char-1" };
      }
    });

    await expect(route(request, reply)).resolves.toEqual({ created: "char-1" });
    expect(now).not.toHaveBeenCalled();
  });

  it("stops before the route body when authentication or the account-keyed limit refuses", async () => {
    const handler = vi.fn(async () => ({ ok: true as const }));
    const route = characterWriteLane({
      limiter,
      actionKey: "character-delete",
      timingRequired: true,
      handler
    });

    dependencies.requireMobileAuth.mockResolvedValueOnce(null);
    await expect(route(request, reply)).resolves.toBeUndefined();
    expect(dependencies.hitAuthenticatedLimit).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    dependencies.hitAuthenticatedLimit.mockReturnValueOnce(false);
    await expect(route(request, reply)).resolves.toBeUndefined();
    expect(dependencies.hitAuthenticatedLimit).toHaveBeenLastCalledWith(
      limiter,
      request,
      reply,
      "user-a",
      "character-delete"
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("translates recognized failures and rethrows unknown ones unchanged", async () => {
    const recognized = new Error("recognized");
    const unknown = new Error("unknown");
    const route = characterWriteLane({
      limiter,
      actionKey: "character-write",
      timingRequired: false,
      handler: async () => {
        throw recognized;
      }
    });

    dependencies.sendCharacterWriteError.mockReturnValueOnce(true);
    await expect(route(request, reply)).resolves.toBeUndefined();
    expect(dependencies.sendCharacterWriteError).toHaveBeenLastCalledWith(reply, recognized);

    const unknownRoute = characterWriteLane({
      limiter,
      actionKey: "character-write",
      timingRequired: false,
      handler: async () => {
        throw unknown;
      }
    });
    await expect(unknownRoute(request, reply)).rejects.toBe(unknown);
    expect(dependencies.sendCharacterWriteError).toHaveBeenLastCalledWith(reply, unknown);
  });
});
