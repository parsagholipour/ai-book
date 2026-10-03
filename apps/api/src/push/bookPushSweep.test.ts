import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sweep against a small in-memory stand-in for the four tables it reads,
 * so "only one sweep says how a book ended" is a claim about the row the claim
 * deletes, not about call arguments.
 */
type Row = Record<string, any>;

const db = vi.hoisted(() => {
  const tables = { projects: [] as Row[], states: [] as Row[], devices: [] as Row[], jobs: [] as Row[] };
  const hasLiveDevice = (userId: string) => tables.devices.some((device) => device.userId === userId && device.live);
  const prisma = {
    project: {
      findMany: async ({ where }: Row) =>
        tables.projects
          .filter((project) => project.status === where.status && hasLiveDevice(project.userId))
          .map((project) => ({ id: project.id })),
      findUnique: async ({ where }: Row) => {
        const project = tables.projects.find((candidate) => candidate.id === where.id);
        return project ? { id: project.id, userId: project.userId, title: project.title, status: project.status } : null;
      }
    },
    projectPushState: {
      findMany: async () => tables.states.map((state) => ({ ...state })),
      createMany: async ({ data }: Row) => {
        const [row] = data as Row[];
        if (tables.states.some((state) => state.projectId === row!.projectId)) return { count: 0 };
        tables.states.push({ version: 0, createdAt: new Date(), ...row });
        return { count: 1 };
      },
      updateMany: async ({ where, data }: Row) => {
        const state = tables.states.find((candidate) => candidate.projectId === where.projectId && candidate.version === where.version);
        if (!state) return { count: 0 };
        Object.assign(state, {
          percent: data.percent,
          detail: data.detail,
          lastSentAt: data.lastSentAt,
          changedAt: data.changedAt,
          version: state.version + data.version.increment
        });
        return { count: 1 };
      },
      deleteMany: async ({ where }: Row) => {
        const before = tables.states.length;
        tables.states = tables.states.filter((state) => !(state.projectId === where.projectId && state.version === where.version));
        return { count: before - tables.states.length };
      }
    },
    pushDevice: {
      findMany: async ({ where }: Row) =>
        tables.devices
          .filter((device) => device.userId === where.userId && device.live)
          .map((device) => ({ token: device.token, platform: device.platform })),
      deleteMany: async ({ where }: Row) => {
        const before = tables.devices.length;
        tables.devices = tables.devices.filter((device) => device.token !== where.token);
        return { count: before - tables.devices.length };
      }
    },
    generationJob: {
      findFirst: async ({ where }: Row) =>
        tables.jobs
          .filter((job) => job.projectId === where.projectId && where.status.in.includes(job.status))
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0] ?? null
    }
  };
  return { tables, prisma };
});

vi.mock("@book-maker/db", () => ({ prisma: db.prisma }));

import { STOPPED_JOB_ERROR } from "@book-maker/core";
import type { BookPushMessage, PushTarget } from "./bookPushMessages.js";
import {
  DETAIL_REFRESH_MS,
  PROGRESS_HEARTBEAT_MS,
  PROGRESS_STALL_MS,
  progressPushDue,
  runBookPushSweep,
  settledBookPushKind,
  type FollowedBook
} from "./bookPushSweep.js";
import { livePushDeviceWhere } from "./pushDevices.js";
import type { PushSendResult } from "./pushSender.js";

const START = new Date("2026-10-03T09:00:00.000Z");

let clock: Date;
let statuses: Map<string, { status: string; progressPercent: number; currentAction: string }>;
let sent: Array<{ target: PushTarget; message: BookPushMessage }>;
let outcomes: Map<string, PushSendResult>;

function at(ms: number): void {
  clock = new Date(START.getTime() + ms);
}

function book(id: string, status = "GENERATING", userId = "user-a"): void {
  db.tables.projects.push({ id, userId, title: `Book ${id}`, status });
}

function setStatus(id: string, status: string): void {
  db.tables.projects.find((project) => project.id === id)!.status = status;
}

function progress(id: string, progressPercent: number, currentAction = "Writing chapter 1"): void {
  statuses.set(id, { status: "generating", progressPercent, currentAction });
}

function sweep() {
  return runBookPushSweep({
    sender: {
      send: async (target, message) => {
        sent.push({ target, message });
        return outcomes.get(target.token) ?? "sent";
      }
    },
    loadStatus: async (projectId) => statuses.get(projectId) ?? null,
    log: { info: vi.fn(), warn: vi.fn() },
    now: () => clock
  });
}

function kinds(): string[] {
  return sent.map(({ message }) => message.kind);
}

beforeEach(() => {
  db.tables.projects = [];
  db.tables.states = [];
  db.tables.devices = [{ token: "phone-a", platform: "ANDROID", userId: "user-a", live: true }];
  db.tables.jobs = [];
  statuses = new Map();
  sent = [];
  outcomes = new Map();
  at(0);
});

describe("progressPushDue", () => {
  const last: FollowedBook = {
    projectId: "p",
    percent: 40,
    detail: "Writing chapter 2",
    version: 3,
    lastSentAt: START,
    changedAt: START
  };

  it("sends the first time, then once the bar has moved two points", () => {
    expect(progressPushDue(null, { percent: 20, detail: null }, START)).toBe(true);
    expect(progressPushDue(last, { percent: 41, detail: "Writing chapter 2" }, new Date(START.getTime() + 15_000))).toBe(false);
    expect(progressPushDue(last, { percent: 42, detail: "Writing chapter 2" }, new Date(START.getTime() + 15_000))).toBe(true);
  });

  it("refreshes a changed phrase at most once a minute, and everything every five", () => {
    const changed = { percent: 40, detail: "Writing chapter 3" };
    expect(progressPushDue(last, changed, new Date(START.getTime() + DETAIL_REFRESH_MS - 1))).toBe(false);
    expect(progressPushDue(last, changed, new Date(START.getTime() + DETAIL_REFRESH_MS))).toBe(true);
    const same = { percent: 40, detail: "Writing chapter 2" };
    expect(progressPushDue(last, same, new Date(START.getTime() + PROGRESS_HEARTBEAT_MS - 1))).toBe(false);
    expect(progressPushDue(last, same, new Date(START.getTime() + PROGRESS_HEARTBEAT_MS))).toBe(true);
  });

  it("stops keeping a frozen bar alive, and wakes for the next real change", () => {
    const stalled = new Date(START.getTime() + PROGRESS_STALL_MS);
    const kept = { ...last, lastSentAt: new Date(stalled.getTime() - PROGRESS_HEARTBEAT_MS) };
    expect(progressPushDue(kept, { percent: 40, detail: "Writing chapter 2" }, stalled)).toBe(false);
    expect(progressPushDue(kept, { percent: 42, detail: "Writing chapter 2" }, stalled)).toBe(true);
  });
});

describe("settledBookPushKind", () => {
  it("announces a finished book whatever its verdict, a failure only when the owner did not stop it", () => {
    expect(settledBookPushKind("COMPLETE", false)).toBe("book_ready");
    expect(settledBookPushKind("REVIEW_REQUIRED", false)).toBe("book_ready");
    expect(settledBookPushKind("FAILED", false)).toBe("book_failed");
    expect(settledBookPushKind("FAILED", true)).toBe("book_clear");
    expect(settledBookPushKind("PLAN_READY", false)).toBe("book_clear");
  });
});

describe("livePushDeviceWhere", () => {
  it("reaches a device only through a session that could still be refreshed, of an active account", () => {
    expect(livePushDeviceWhere(START)).toEqual({
      session: { revokedAt: null, refreshTokenExpiresAt: { gt: START } },
      user: { status: "ACTIVE", disabledAt: null }
    });
  });
});

describe("book push sweep", () => {
  it("follows a generating book with throttled progress, then says once that it is ready", async () => {
    book("p1");
    progress("p1", 20, "Preparing your book");
    await sweep();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({ kind: "book_progress", percent: 20, body: "Preparing your book", sentAt: START.getTime() });
    expect(sent[0]!.target).toEqual({ token: "phone-a", platform: "ANDROID" });

    at(15_000);
    progress("p1", 21, "Preparing your book");
    await sweep();
    expect(sent).toHaveLength(1);

    at(30_000);
    progress("p1", 24, "Preparing your book");
    await sweep();
    expect(sent.map(({ message }) => message.percent)).toEqual([20, 24]);
    expect(db.tables.states[0]).toMatchObject({ percent: 24, version: 1 });

    at(45_000);
    setStatus("p1", "COMPLETE");
    await sweep();
    expect(kinds()).toEqual(["book_progress", "book_progress", "book_ready"]);
    expect(sent[2]!.message).toMatchObject({ body: "“Book p1” is ready to read.", sentAt: START.getTime() + 45_000 });
    expect(db.tables.states).toEqual([]);

    at(60_000);
    await sweep();
    expect(sent).toHaveLength(3);
  });

  it("records when the bar last changed, not when it was last refreshed", async () => {
    book("p1");
    progress("p1", 30, "Writing chapter 1");
    await sweep();
    at(PROGRESS_HEARTBEAT_MS);
    await sweep();
    expect(sent).toHaveLength(2);
    expect(db.tables.states[0]).toMatchObject({ lastSentAt: clock, changedAt: START });

    at(PROGRESS_HEARTBEAT_MS + 15_000);
    progress("p1", 33, "Writing chapter 1");
    await sweep();
    expect(db.tables.states[0]).toMatchObject({ percent: 33, changedAt: clock });
  });

  it("never moves the bar backwards", async () => {
    book("p1");
    progress("p1", 60);
    await sweep();
    at(PROGRESS_HEARTBEAT_MS);
    progress("p1", 35);
    await sweep();
    expect(sent.map(({ message }) => message.percent)).toEqual([60, 60]);
  });

  it("tells a finished book under review that it is ready to look over", async () => {
    book("p1");
    progress("p1", 90);
    await sweep();
    setStatus("p1", "REVIEW_REQUIRED");
    at(15_000);
    await sweep();
    expect(sent[1]!.message).toMatchObject({ kind: "book_ready", body: "“Book p1” is finished. Open it to look it over." });
  });

  it("alerts a real failure, and only clears the notification when the owner stopped the book", async () => {
    book("failed");
    book("stopped");
    progress("failed", 40);
    progress("stopped", 40);
    await sweep();

    setStatus("failed", "FAILED");
    setStatus("stopped", "FAILED");
    db.tables.jobs.push(
      { projectId: "failed", status: "FAILED", error: "Provider timed out", updatedAt: new Date(START.getTime() + 1000) },
      { projectId: "stopped", status: "CANCELED", error: STOPPED_JOB_ERROR, updatedAt: new Date(START.getTime() + 2000) },
      { projectId: "stopped", status: "FAILED", error: "older failure", updatedAt: new Date(START.getTime() - 1000) }
    );
    at(15_000);
    await sweep();

    const ended = new Map(sent.slice(2).map(({ message }) => [message.projectId, message.kind]));
    expect(ended).toEqual(new Map([["failed", "book_failed"], ["stopped", "book_clear"]]));
  });

  it("does not read the status of a book whose owner has nowhere to be told", async () => {
    db.tables.devices = [{ token: "phone-a", platform: "ANDROID", userId: "user-a", live: false }];
    book("p1");
    const loadStatus = vi.fn(async () => ({ status: "generating", progressPercent: 30, currentAction: "Writing" }));
    await runBookPushSweep({
      sender: { send: vi.fn() },
      loadStatus,
      log: { info: vi.fn(), warn: vi.fn() },
      now: () => clock
    });
    expect(loadStatus).not.toHaveBeenCalled();
    expect(db.tables.states).toEqual([]);
  });

  it("sends to every live device of the owner and forgets a token FCM says is dead", async () => {
    db.tables.devices.push(
      { token: "phone-b", platform: "IOS", userId: "user-a", live: true },
      { token: "old-phone", platform: "ANDROID", userId: "user-a", live: true },
      { token: "someone-else", platform: "ANDROID", userId: "user-b", live: true }
    );
    outcomes.set("old-phone", "unregistered");
    book("p1");
    progress("p1", 30);

    const result = await sweep();

    expect(sent.map(({ target }) => target.token).sort()).toEqual(["old-phone", "phone-a", "phone-b"]);
    expect(result).toMatchObject({ progress: 1, unregistered: 1 });
    expect(db.tables.devices.map((device) => device.token)).not.toContain("old-phone");
  });

  it("lets only one of two overlapping sweeps say how a book ended", async () => {
    book("p1");
    progress("p1", 50);
    await sweep();
    setStatus("p1", "COMPLETE");
    at(15_000);

    await Promise.all([sweep(), sweep()]);

    expect(kinds().filter((kind) => kind === "book_ready")).toHaveLength(1);
  });

  it("keeps following the other books when one cannot be read", async () => {
    book("broken");
    book("fine");
    progress("fine", 30);
    const log = { info: vi.fn(), warn: vi.fn() };
    await runBookPushSweep({
      sender: { send: async (target, message) => (sent.push({ target, message }), "sent") },
      loadStatus: async (projectId) => {
        if (projectId === "broken") throw new Error("database went away");
        return statuses.get(projectId) ?? null;
      },
      log,
      now: () => clock
    });

    expect(sent.map(({ message }) => message.projectId)).toEqual(["fine"]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "push.book_sweep_failed", projectId: "broken" }), expect.any(String));
  });
});
