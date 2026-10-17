import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { buildProjectStatus } from "../projectStatus.js";
import { resetDurationHistoryForTests } from "./generationEstimate.js";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  statusRecord,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

// The time-left estimate as the app receives it: inside `planningProgress` and
// `generationProgress` on GET …/status, seconds rather than a clock time, and
// under a key the payload's leak rules allow.

const NOW = new Date("2026-10-17T12:00:00.000Z");
const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

async function readStatus() {
  const app = await buildMobileApp();
  const response = await app.inject({
    method: "GET",
    url: "/api/mobile/projects/project-1/status",
    headers: bearer("token-a")
  });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.json().status;
}

function generatingBook(overrides: Record<string, unknown> = {}) {
  return statusRecord({
    project: {
      status: "GENERATING",
      targetPages: 60,
      mediaSettings: { modelTier: "fast", fullIllustrations: false, includeCover: false },
      jobs: [
        {
          id: "job-book",
          type: "GENERATE_BOOK",
          status: "ACTIVE",
          progress: 10,
          error: null,
          // Three of six chapters written: half of the book's own bar.
          steps: [{ key: "setup", label: "Setup", status: "active", phase: "compose", done: 3, total: 6, chapterIndex: 4 }]
        }
      ]
    },
    progress: { pages: { complete: 0, target: 60 } },
    ...overrides
  });
}

describe("the time-left estimate on the status payload", () => {
  beforeEach(() => {
    resetMobileHarness();
    resetDurationHistoryForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await teardownMobileHarness();
  });

  it("times a book run from its attempt, and keeps every internal out of the payload", async () => {
    vi.mocked(buildProjectStatus).mockResolvedValue(generatingBook());
    mockPrisma.generationAttempt.findFirst.mockResolvedValue({
      status: "ACTIVE",
      startedAt: secondsAgo(200),
      retryOfAttemptId: null
    });

    const status = await readStatus();

    // A 60-page Quick Draft text book: 500 s typical. At 57% (37 of the book's
    // own 80 points) after 200 s: schedule 300 s, pace 232 s — 266 s, up to 270.
    expect(status.generationProgress).toMatchObject({ percent: 57, estimatedSecondsLeft: 270 });
    expect(status.planningProgress).toBeNull();
    expect(JSON.stringify(status)).not.toMatch(/jobs|queue|tokens|cost|provider/);
    expect(JSON.stringify(status)).not.toMatch(/model/i);
  });

  it("times a plan from its job, against the plans that really ran", async () => {
    // Five recent Quick Draft plans that each took ten times the model.
    mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[]) =>
      strings.join("?").includes('FROM "GenerationAttempt"')
        ? Array.from({ length: 5 }, () => ({
            operation: "PLAN_GENERATION",
            tier: "fast",
            illustrated: true,
            pages: 12,
            seconds: 190.8
          }))
        : []
    );
    vi.mocked(buildProjectStatus).mockResolvedValue(
      statusRecord({
        project: {
          status: "PLANNING",
          mediaSettings: { modelTier: "fast" },
          jobs: [
            {
              id: "job-plan",
              type: "PLAN_BOOK",
              status: "ACTIVE",
              progress: 55,
              error: null,
              startedAt: secondsAgo(20),
              steps: [
                { key: "research", label: "Research", status: "done" },
                { key: "plan", label: "Create plan", status: "active" },
                { key: "save", label: "Save plan", status: "pending" }
              ]
            }
          ]
        }
      })
    );

    const status = await readStatus();

    // 190.8 s typical; at 55% after 20 s: schedule 171 s, pace 16 s — 94 s, up to 120.
    expect(status.planningProgress).toMatchObject({ percent: 55, estimatedSecondsLeft: 120 });
    expect(status.generationProgress).toBeNull();
    // The plan's job is never asked for by its attempt.
    expect(mockPrisma.generationAttempt.findFirst).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toMatch(/jobs|queue|tokens|cost|provider/);
    expect(JSON.stringify(status)).not.toMatch(/model/i);
  });

  it("says nothing for a book waiting in line, and reads nothing to find that out", async () => {
    vi.mocked(buildProjectStatus).mockResolvedValue(generatingBook({ waitingInLine: { booksAhead: 1 } }));

    const status = await readStatus();

    expect(status.waitingInLine).toEqual({ booksAhead: 1 });
    expect(status.generationProgress.estimatedSecondsLeft).toBeNull();
    expect(mockPrisma.generationAttempt.findFirst).not.toHaveBeenCalled();
  });

  it("says nothing for a paid retry, which resumes a run part-way", async () => {
    vi.mocked(buildProjectStatus).mockResolvedValue(generatingBook());
    mockPrisma.generationAttempt.findFirst.mockResolvedValue({
      status: "ACTIVE",
      startedAt: secondsAgo(20),
      retryOfAttemptId: "attempt-failed"
    });

    const status = await readStatus();

    expect(status.generationProgress.estimatedSecondsLeft).toBeNull();
  });

  it("serves the status with no estimate when the run's start cannot be read", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(buildProjectStatus).mockResolvedValue(generatingBook());
    mockPrisma.generationAttempt.findFirst.mockRejectedValue(new Error("connection reset"));

    const status = await readStatus();

    expect(status.generationProgress).toMatchObject({ percent: 57, estimatedSecondsLeft: null });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("says nothing once the book is finished", async () => {
    vi.mocked(buildProjectStatus).mockResolvedValue(statusRecord({ project: { status: "COMPLETE" } }));

    const status = await readStatus();

    expect(status.generationProgress).toMatchObject({ percent: 100, estimatedSecondsLeft: null });
    expect(mockPrisma.generationAttempt.findFirst).not.toHaveBeenCalled();
  });
});
