import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedObject, testObjectStore } from "./testing/objectStorage.js";

type Row = Record<string, any>;

/**
 * The tables an account action touches, as arrays, so "taken down", "put back"
 * and "nothing was written" are claims about rows.
 */
const db = vi.hoisted(() => {
  const state = {
    user: null as Row | null,
    shares: [] as Row[],
    actions: [] as Row[],
    openJobs: [] as Array<{ projectId: string | null }>,
    lockSql: [] as string[]
  };
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "in" in value ? (value.in as unknown[]).includes(row[key]) : row[key] === value
    );
  const client: Row = {
    state,
    $queryRaw: vi.fn(async (strings: readonly string[]) => {
      state.lockSql.push(strings.join("?").replace(/\s+/g, " ").trim());
      return state.user ? [{ status: state.user.status, sharingDisabledAt: state.user.sharingDisabledAt }] : [];
    }),
    user: {
      update: vi.fn(async ({ data }: Row) => Object.assign(state.user!, data)),
      upsert: vi.fn(async () => ({ id: "local-admin" }))
    },
    mobileSession: { updateMany: vi.fn(async () => ({ count: 2 })) },
    bookShare: {
      findMany: vi.fn(async ({ where, select }: Row) =>
        state.shares.filter((share) => matches(share, where)).map((share) => (select?.projectId ? { projectId: share.projectId } : { id: share.id }))
      ),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const hit = state.shares.filter((share) => matches(share, where));
        hit.forEach((share) => Object.assign(share, data));
        return { count: hit.length };
      }),
      count: vi.fn(async ({ where }: Row) => state.shares.filter((share) => matches(share, where)).length)
    },
    accountModerationAction: {
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `action-${state.actions.length + 1}`, ...data };
        state.actions.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async ({ where, data }: Row) => Object.assign(state.actions.find((row) => row.id === where.id)!, data)),
      findMany: vi.fn(async () => [...state.actions].reverse())
    },
    generationJob: { findMany: vi.fn(async () => state.openJobs) }
  };
  client.$transaction = vi.fn(async (operation: (tx: Row) => Promise<unknown>) => operation(client));
  return client;
});
const queue = vi.hoisted(() => ({ stopProjectGenerationJobs: vi.fn(async (_projectId: string) => ({ stoppedJobs: 1 })) }));

vi.mock("@book-maker/db", () => ({ prisma: db }));
vi.mock("./queue.js", () => queue);

import Fastify from "fastify";
import { registerAuth } from "./auth.js";
import {
  ACCOUNT_SHARE_TAKEDOWN_REASON,
  AccountModerationRefusedError,
  moderateAccount,
  type AccountModerationActionName
} from "./accountModeration.js";
import { loadAccountModeration } from "./accountModerationView.js";
import { adminAccountRoutes } from "./routes/adminAccounts.js";

const log = { info: vi.fn(), warn: vi.fn() };
const NOW = new Date("2026-10-13T12:00:00.000Z");

function act(action: AccountModerationActionName, reason = "Shared sexual content involving a minor.") {
  return moderateAccount({ userId: "user-1", action, reason, operatorUserId: "local-admin", log, now: NOW });
}

function share(id: string, status: string, takedownReason: string | null = null): Row {
  return { id, projectId: `book-${id}`, userId: "user-1", status, takedownReason };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.state.user = { id: "user-1", status: "ACTIVE", sharingDisabledAt: null };
  db.state.shares = [
    share("live", "ACTIVE"),
    share("revoked", "REVOKED"),
    share("operator-down", "TAKEN_DOWN", "Contains another author's text.")
  ];
  db.state.actions = [];
  db.state.openJobs = [];
  db.state.lockSql = [];
  queue.stopProjectGenerationJobs.mockImplementation(async () => ({ stoppedJobs: 1 }));
});

afterEach(() => vi.restoreAllMocks());

describe("suspending an account", () => {
  it("revokes every session, takes the live shares down, stops its books, and records who, when and why", async () => {
    db.state.openJobs = [{ projectId: "book-a" }, { projectId: "book-b" }];
    seedObject("books/book-live/share-previews/digest-2.pdf", "preview slice");

    const outcome = await act("suspend");

    expect(db.state.lockSql).toEqual(['SELECT "status"::text AS "status", "sharingDisabledAt" FROM "User" WHERE "id" = ? FOR NO KEY UPDATE']);
    expect(db.state.user).toMatchObject({ status: "SUSPENDED", sharingDisabledAt: null });
    expect(db.mobileSession.updateMany).toHaveBeenCalledWith({ where: { userId: "user-1", revokedAt: null }, data: { revokedAt: NOW } });
    expect(db.state.shares.map((row: Row) => [row.id, row.status, row.takedownReason])).toEqual([
      ["live", "TAKEN_DOWN", ACCOUNT_SHARE_TAKEDOWN_REASON],
      ["revoked", "REVOKED", null],
      ["operator-down", "TAKEN_DOWN", "Contains another author's text."]
    ]);
    expect(await testObjectStore.get("books/book-live/share-previews/digest-2.pdf")).toBeNull();
    expect(queue.stopProjectGenerationJobs.mock.calls.map(([projectId]) => projectId)).toEqual(["book-a", "book-b"]);
    expect(db.generationJob.findMany).toHaveBeenCalledWith({
      where: { status: { in: ["QUEUED", "ACTIVE"] }, project: { userId: "user-1" } },
      select: { projectId: true },
      distinct: ["projectId"]
    });
    expect(outcome).toMatchObject({
      status: "SUSPENDED",
      effects: { sessionsRevoked: 2, sharesTakenDown: ["live"], sharesRestored: [], projectsStopped: 2, jobsStopped: 2, stopFailures: 0 }
    });
    expect(db.state.actions).toEqual([
      expect.objectContaining({
        userId: "user-1",
        action: "SUSPEND",
        reason: "Shared sexual content involving a minor.",
        operatorUserId: "local-admin",
        createdAt: NOW,
        effects: expect.objectContaining({ sessionsRevoked: 2, projectsStopped: 2 })
      })
    ]);
  });

  it("is still a suspension when a book cannot be stopped: the failure is counted and logged", async () => {
    db.state.openJobs = [{ projectId: "book-a" }, { projectId: "book-b" }];
    queue.stopProjectGenerationJobs.mockRejectedValueOnce(new Error("P2028 transaction timeout"));

    const outcome = await act("suspend");

    expect(db.state.user!.status).toBe("SUSPENDED");
    expect(outcome.effects).toMatchObject({ projectsStopped: 1, stopFailures: 1 });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "account.suspend_stop_failed", projectId: "book-a" }), expect.any(String));
  });

  it("refuses the console's own account, a deleted one and a second suspension, writing nothing", async () => {
    await expect(moderateAccount({ userId: "local-admin", action: "suspend", reason: "x", operatorUserId: null, log })).rejects.toMatchObject({
      code: "OPERATOR_ACCOUNT"
    });
    expect(db.$transaction).not.toHaveBeenCalled();

    db.state.user = { id: "user-1", status: "DISABLED", sharingDisabledAt: null };
    await expect(act("suspend")).rejects.toMatchObject({ code: "ACCOUNT_DELETED" });

    db.state.user = { id: "user-1", status: "SUSPENDED", sharingDisabledAt: null };
    await expect(act("suspend")).rejects.toBeInstanceOf(AccountModerationRefusedError);

    db.state.user = null;
    await expect(act("suspend")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });

    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.mobileSession.updateMany).not.toHaveBeenCalled();
    expect(db.state.actions).toEqual([]);
    expect(queue.stopProjectGenerationJobs).not.toHaveBeenCalled();
  });
});

describe("lifting an account action", () => {
  it("puts the account's taken-down shares back as stopped, never live, and leaves an operator's own take-down alone", async () => {
    await act("suspend");
    const outcome = await act("unsuspend", "Mistaken report.");

    expect(db.state.user!.status).toBe("ACTIVE");
    expect(outcome.effects).toMatchObject({ sharesRestored: ["live"], sessionsRevoked: 0, projectsStopped: 0 });
    expect(db.state.shares.map((row: Row) => [row.id, row.status, row.takedownReason])).toEqual([
      ["live", "REVOKED", null],
      ["revoked", "REVOKED", null],
      ["operator-down", "TAKEN_DOWN", "Contains another author's text."]
    ]);
    expect(db.state.actions.map((row: Row) => [row.action, row.reason])).toEqual([
      ["SUSPEND", "Shared sexual content involving a minor."],
      ["UNSUSPEND", "Mistaken report."]
    ]);
  });

  it("keeps the shares down while the other account action still holds", async () => {
    await act("disable_sharing");
    await act("suspend");

    expect((await act("unsuspend")).effects.sharesRestored).toEqual([]);
    expect(db.state.shares[0]).toMatchObject({ status: "TAKEN_DOWN" });
    expect((await act("enable_sharing")).effects.sharesRestored).toEqual(["live"]);
  });
});

describe("turning sharing off", () => {
  it("takes the live shares down without touching sessions or books, and refuses to do it twice", async () => {
    db.state.openJobs = [{ projectId: "book-a" }];

    const outcome = await act("disable_sharing");

    expect(db.state.user).toMatchObject({ status: "ACTIVE", sharingDisabledAt: NOW });
    expect(outcome.effects).toMatchObject({ sharesTakenDown: ["live"], sessionsRevoked: 0, projectsStopped: 0 });
    expect(db.mobileSession.updateMany).not.toHaveBeenCalled();
    expect(queue.stopProjectGenerationJobs).not.toHaveBeenCalled();
    await expect(act("disable_sharing")).rejects.toMatchObject({ code: "SHARING_ALREADY_DISABLED" });
  });

  it("does not put shares back for a suspended account when sharing is turned on again", async () => {
    await act("suspend");
    await act("disable_sharing");

    expect((await act("enable_sharing")).effects.sharesRestored).toEqual([]);
    await expect(act("enable_sharing")).rejects.toMatchObject({ code: "SHARING_NOT_DISABLED" });
  });
});

describe("the inspector's view", () => {
  it("reports both switches, the live shares and the actions newest first", async () => {
    await act("disable_sharing");

    const view = await loadAccountModeration({ id: "user-1", status: "ACTIVE", sharingDisabledAt: NOW });

    expect(view).toMatchObject({ suspended: false, sharingDisabled: true, sharingDisabledAt: NOW.toISOString(), liveShares: 0 });
    expect(view.actions).toEqual([
      expect.objectContaining({ action: "disable_sharing", reason: "Shared sexual content involving a minor.", createdAt: NOW.toISOString() })
    ]);
  });
});

describe("POST /api/admin/users/:id/moderation", () => {
  async function buildApp() {
    const app = Fastify();
    // Password auth off, as in local development: the hook is what makes the operator.
    await registerAuth(app, { WEB_PASSWORD: "" } as never);
    await app.register(adminAccountRoutes);
    return app;
  }

  it("asks for a reason, answers each refusal with its own code, and acts", async () => {
    const app = await buildApp();
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/admin/users/user-1/moderation", payload });

    const bare = await post({ action: "suspend" });
    const unknown = await post({ action: "ban", reason: "x" });
    const done = await post({ action: "suspend", reason: "  Spam accounts.  " });
    const twice = await post({ action: "suspend", reason: "Again." });

    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe("REASON_REQUIRED");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe("VALIDATION_ERROR");
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "SUSPENDED", effects: { sharesTakenDown: ["live"] } });
    expect(db.state.actions[0]).toMatchObject({ reason: "Spam accounts.", operatorUserId: "local-admin" });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toEqual({ error: { code: "ALREADY_SUSPENDED", message: "This account is already suspended." } });
    await app.close();
  });
});
