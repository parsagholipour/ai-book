import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), findAttempt: vi.fn() }));

vi.mock("@book-maker/db", () => ({
  prisma: { $queryRaw: mocks.queryRaw, generationAttempt: { findFirst: mocks.findAttempt } }
}));

import {
  loadEstimateInputs,
  modelSeconds,
  pageBucket,
  resetDurationHistoryForTests,
  roundSecondsLeft,
  secondsLeft,
  statusSecondsLeft,
  typicalSeconds,
  type DurationSample,
  type EstimateInputs
} from "./generationEstimate.js";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const secondsAgo = (seconds: number) => new Date(NOW - seconds * 1000);

/** A status read with only what the estimate looks at. */
function statusOf(overrides: {
  status: string;
  jobs?: Array<Record<string, unknown>>;
  mediaSettings?: Record<string, unknown>;
  targetPages?: number;
  waitingInLine?: { booksAhead: number } | null;
}) {
  return {
    waitingInLine: overrides.waitingInLine ?? null,
    project: {
      id: "project-1",
      status: overrides.status,
      targetPages: overrides.targetPages ?? 12,
      mediaSettings: overrides.mediaSettings ?? {},
      jobs: overrides.jobs ?? []
    }
  } as never;
}

const fastTextBook = { modelTier: "fast", fullIllustrations: false };

function inputs(overrides: Partial<EstimateInputs> = {}): EstimateInputs {
  return { now: NOW, history: [], bookRunStartedAt: null, ...overrides };
}

function runs(count: number, sample: Omit<DurationSample, "seconds">, seconds: number): DurationSample[] {
  return Array.from({ length: count }, () => ({ ...sample, seconds }));
}

beforeEach(() => {
  vi.resetAllMocks();
  resetDurationHistoryForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the compiled model", () => {
  it("prices a run by tier, pictures and length, the way dev measured them", () => {
    // A 10-page illustrated picture book: ~70 s on Quick Draft, ~100 s on Balanced.
    expect(modelSeconds("FULL_BOOK_GENERATION", { tier: "fast", illustrated: true, pages: 10 })).toBeCloseTo(72);
    expect(modelSeconds("FULL_BOOK_GENERATION", { tier: "balanced", illustrated: true, pages: 10 })).toBeCloseTo(93.6);
    // A 30-page novel in 4–5 minutes; a 60-page book in 8–11.
    expect(modelSeconds("FULL_BOOK_GENERATION", { tier: "balanced", illustrated: false, pages: 30 })).toBeCloseTo(299);
    expect(modelSeconds("FULL_BOOK_GENERATION", { tier: "fast", illustrated: false, pages: 60 })).toBeCloseTo(500);
    // A plan in 16–40 s, a revision a little faster.
    expect(modelSeconds("PLAN_GENERATION", { tier: "fast", illustrated: false, pages: 30 })).toBeCloseTo(20.7);
    expect(modelSeconds("PLAN_GENERATION", { tier: "balanced", illustrated: false, pages: 30 })).toBeCloseTo(46);
    expect(modelSeconds("PLAN_REVISION", { tier: "balanced", illustrated: false, pages: 30 })).toBeCloseTo(32.2);
  });

  it("buckets lengths at 12, 40 and 80 pages", () => {
    expect([1, 12, 13, 40, 41, 80, 81, 300].map(pageBucket)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
});

describe("a typical run", () => {
  const book = { tier: "fast" as const, illustrated: true, pages: 10 };

  it("is the compiled model when there is no history, or too little of it", () => {
    expect(typicalSeconds("FULL_BOOK_GENERATION", book, [])).toBeCloseTo(72);
    const four = runs(4, { operation: "FULL_BOOK_GENERATION", ...book }, 720);
    expect(typicalSeconds("FULL_BOOK_GENERATION", book, four)).toBeCloseTo(72);
  });

  it("scales the model by how the same bucket really ran, and by this book's own length inside it", () => {
    // Five 10-page runs that took twice the model.
    const history = runs(5, { operation: "FULL_BOOK_GENERATION", ...book }, 144);
    expect(typicalSeconds("FULL_BOOK_GENERATION", book, history)).toBeCloseTo(144);
    // An 8-page book in the same bucket is twice its own, shorter, model.
    expect(typicalSeconds("FULL_BOOK_GENERATION", { ...book, pages: 8 }, history)).toBeCloseTo(2 * 62.4);
  });

  it("takes the median, so one stalled run does not move it", () => {
    const history = [
      ...runs(4, { operation: "FULL_BOOK_GENERATION", ...book }, 144),
      { operation: "FULL_BOOK_GENERATION" as const, ...book, seconds: 7_200 }
    ];
    expect(typicalSeconds("FULL_BOOK_GENERATION", book, history)).toBeCloseTo(144);
  });

  it("widens by dropping the length bucket, then the pictures, then the tier", () => {
    const exact = runs(4, { operation: "FULL_BOOK_GENERATION", ...book }, 3 * 72);
    // Same tier and pictures, 60 pages (model 500 × 1.2): ran at 1.5× the model.
    const longer = runs(5, { operation: "FULL_BOOK_GENERATION", ...book, pages: 60 }, 1.5 * 600);
    expect(typicalSeconds("FULL_BOOK_GENERATION", book, [...exact, ...longer])).toBeCloseTo(1.5 * 72);

    // Same tier, text-only 30-page runs (model 230) at 4× the model.
    const textOnly = runs(5, { operation: "FULL_BOOK_GENERATION", tier: "fast", illustrated: false, pages: 30 }, 4 * 230);
    expect(typicalSeconds("FULL_BOOK_GENERATION", book, [...exact, ...textOnly])).toBeCloseTo(4 * 72);

    // Only other tiers: Balanced 30-page runs (model 299) at half the model.
    const balanced = runs(5, { operation: "FULL_BOOK_GENERATION", tier: "balanced", illustrated: false, pages: 30 }, 0.5 * 299);
    expect(typicalSeconds("FULL_BOOK_GENERATION", book, [...exact, ...balanced])).toBeCloseTo(0.5 * 72);
  });

  it("never pools another operation's runs", () => {
    const plans = runs(9, { operation: "PLAN_GENERATION", ...book }, 900);
    expect(typicalSeconds("FULL_BOOK_GENERATION", book, plans)).toBeCloseTo(72);
  });
});

describe("seconds left", () => {
  it("follows the schedule until a fifth of the bar is behind the run", () => {
    expect(secondsLeft({ typicalSeconds: 300, elapsedSeconds: 60, fraction: 0.1 })).toBe(240);
  });

  it("blends the schedule with the pace once a fifth of the bar is done", () => {
    // Schedule 200 s, pace 100 s.
    expect(secondsLeft({ typicalSeconds: 300, elapsedSeconds: 100, fraction: 0.5 })).toBe(150);
  });

  it("takes the pace alone once the schedule has run out", () => {
    // 400 s for 80% leaves 100 s at that pace, rounded up to 120.
    expect(secondsLeft({ typicalSeconds: 300, elapsedSeconds: 400, fraction: 0.8 })).toBe(120);
  });

  it("never says less than 20 s while the work runs, nor more than three typical runs", () => {
    expect(secondsLeft({ typicalSeconds: 300, elapsedSeconds: 290, fraction: 0.95 })).toBe(30);
    expect(secondsLeft({ typicalSeconds: 100, elapsedSeconds: 150, fraction: 0.2 })).toBe(300);
  });

  it("says nothing once a run has overrun its schedule before a fifth of its bar", () => {
    expect(secondsLeft({ typicalSeconds: 300, elapsedSeconds: 400, fraction: 0.1 })).toBeNull();
  });

  it("reads a start stamped a moment ahead of this clock as just begun", () => {
    expect(secondsLeft({ typicalSeconds: 300, elapsedSeconds: -5, fraction: 0 })).toBe(300);
  });

  it("refuses inputs that are not numbers", () => {
    expect(secondsLeft({ typicalSeconds: 0, elapsedSeconds: 10, fraction: 0.5 })).toBeNull();
    expect(secondsLeft({ typicalSeconds: 300, elapsedSeconds: Number.NaN, fraction: 0.5 })).toBeNull();
    expect(secondsLeft({ typicalSeconds: 300, elapsedSeconds: 10, fraction: Number.NaN })).toBeNull();
  });

  it("rounds up to 30 s under ten minutes and to the minute above, so it changes at most twice a minute", () => {
    expect([1, 30, 31, 599, 600, 601, 659, 661].map(roundSecondsLeft)).toEqual([30, 30, 60, 600, 600, 660, 660, 720]);
    // Ten seconds of a run that keeps its pace move nothing.
    const at = (elapsed: number) => secondsLeft({ typicalSeconds: 600, elapsedSeconds: elapsed, fraction: 0.1 });
    expect(at(100)).toBe(at(110));
  });
});

describe("the status's estimates", () => {
  const planning = (job: Record<string, unknown>, mediaSettings: Record<string, unknown> = {}) =>
    statusOf({ status: "PLANNING", mediaSettings, jobs: [{ id: "job-plan", type: "PLAN_BOOK", ...job }] });

  it("times an active plan from its job's start", () => {
    const status = planning({ status: "ACTIVE", startedAt: secondsAgo(5) }, { modelTier: "balanced" });
    // Balanced, 12 pages: 42.4 s typical, so 37.4 s on the schedule at 10% — up to the next 30 s.
    expect(statusSecondsLeft(status, { planning: 10, generation: null }, inputs())).toEqual({
      planning: 60,
      generation: null
    });
  });

  it("times a plan revision against revisions", () => {
    const status = statusOf({
      status: "PLANNING",
      jobs: [{ id: "job-revise", type: "REVISE_PLAN", status: "ACTIVE", startedAt: secondsAgo(2) }]
    });
    const slowRevisions = runs(5, { operation: "PLAN_REVISION", tier: "balanced", illustrated: true, pages: 12 }, 10 * 29.68);
    expect(statusSecondsLeft(status, { planning: 10, generation: null }, inputs({ history: slowRevisions })).planning).toBe(300);
  });

  it("times a book run from its attempt's start, measuring the bar from where the book's share begins", () => {
    const status = statusOf({ status: "GENERATING", mediaSettings: fastTextBook, targetPages: 60 });
    const started = inputs({ bookRunStartedAt: secondsAgo(100) });
    // 500 s typical. 28% is 10% of the book's own bar: the schedule alone.
    expect(statusSecondsLeft(status, { planning: null, generation: 28 }, started).generation).toBe(420);
    // 60% is half of it: schedule 400 s and pace 100 s.
    expect(statusSecondsLeft(status, { planning: null, generation: 60 }, started).generation).toBe(270);
  });

  it("is null whenever a number would be a guess", () => {
    const none = { planning: null, generation: null };
    const generating = statusOf({ status: "GENERATING", mediaSettings: fastTextBook });
    const running = inputs({ bookRunStartedAt: secondsAgo(30) });
    // No inputs read at all.
    expect(statusSecondsLeft(generating, { planning: null, generation: 40 }, null)).toEqual(none);
    // Waiting in line behind other books.
    expect(
      statusSecondsLeft(
        statusOf({ status: "GENERATING", waitingInLine: { booksAhead: 2 } }),
        { planning: null, generation: 20 },
        running
      )
    ).toEqual(none);
    // A book run with no first run to time (queued, a paid retry, or none at all).
    expect(statusSecondsLeft(generating, { planning: null, generation: 40 }, inputs())).toEqual(none);
    // A plan still queued, or one with no start stamped.
    expect(statusSecondsLeft(planning({ status: "QUEUED", startedAt: null }), { planning: 0, generation: null }, running)).toEqual(none);
    expect(statusSecondsLeft(planning({ status: "ACTIVE" }), { planning: 30, generation: null }, running)).toEqual(none);
    // Finished, stopped, failed, or an edit rather than a run.
    for (const settled of ["PLAN_READY", "COMPLETE", "REVIEW_REQUIRED", "FAILED", "DRAFT", "EDITING"]) {
      expect(statusSecondsLeft(statusOf({ status: settled }), { planning: 100, generation: 100 }, running)).toEqual(none);
    }
  });
});

describe("the inputs it reads", () => {
  const historyRow = {
    operation: "FULL_BOOK_GENERATION",
    tier: "fast",
    illustrated: false,
    pages: 60,
    seconds: 1_000
  };

  it("reads nothing for a book that is not being planned or written, or is waiting in line", async () => {
    await expect(loadEstimateInputs(statusOf({ status: "COMPLETE" }), NOW)).resolves.toBeNull();
    await expect(
      loadEstimateInputs(statusOf({ status: "GENERATING", waitingInLine: { booksAhead: 0 } }), NOW)
    ).resolves.toBeNull();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.findAttempt).not.toHaveBeenCalled();
  });

  it("reads the history for a plan, and the run's attempt only for a book", async () => {
    mocks.queryRaw.mockResolvedValue([historyRow]);
    const planningInputs = await loadEstimateInputs(statusOf({ status: "PLANNING" }), NOW);
    expect(planningInputs).toEqual({
      now: NOW,
      history: [{ operation: "FULL_BOOK_GENERATION", tier: "fast", illustrated: false, pages: 60, seconds: 1_000 }],
      bookRunStartedAt: null
    });
    expect(mocks.findAttempt).not.toHaveBeenCalled();

    const started = secondsAgo(90);
    mocks.findAttempt.mockResolvedValue({ status: "ACTIVE", startedAt: started, retryOfAttemptId: null });
    const bookInputs = await loadEstimateInputs(statusOf({ status: "GENERATING" }), NOW);
    expect(bookInputs?.bookRunStartedAt).toEqual(started);
    expect(mocks.findAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "project-1", operation: "FULL_BOOK_GENERATION", status: { in: ["QUEUED", "ACTIVE"] } }
      })
    );
  });

  it("times no queued run and no paid retry", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    mocks.findAttempt.mockResolvedValueOnce({ status: "QUEUED", startedAt: null, retryOfAttemptId: null });
    mocks.findAttempt.mockResolvedValueOnce({ status: "ACTIVE", startedAt: secondsAgo(10), retryOfAttemptId: "attempt-0" });
    mocks.findAttempt.mockResolvedValueOnce(null);
    for (let read = 0; read < 3; read += 1) {
      expect((await loadEstimateInputs(statusOf({ status: "GENERATING" }), NOW))?.bookRunStartedAt).toBeNull();
    }
  });

  it("answers a failed attempt read with no clock, never a failed status", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.findAttempt.mockRejectedValue(new Error("connection reset"));
    await expect(loadEstimateInputs(statusOf({ status: "GENERATING" }), NOW)).resolves.toMatchObject({ bookRunStartedAt: null });
    expect(logged).toHaveBeenCalledOnce();
  });

  it("drops rows it cannot read as a run", async () => {
    mocks.queryRaw.mockResolvedValue([
      historyRow,
      { ...historyRow, operation: "AUDIOBOOK_GENERATION" },
      { ...historyRow, tier: "turbo" },
      { ...historyRow, seconds: 0 },
      { ...historyRow, pages: 0 }
    ]);
    const read = await loadEstimateInputs(statusOf({ status: "PLANNING" }), NOW);
    expect(read?.history).toHaveLength(1);
  });

  it("reads the history once per ten minutes, and once for callers that ask together", async () => {
    mocks.queryRaw.mockResolvedValue([historyRow]);
    const planningStatus = statusOf({ status: "PLANNING" });
    await Promise.all([loadEstimateInputs(planningStatus, NOW), loadEstimateInputs(planningStatus, NOW)]);
    await loadEstimateInputs(planningStatus, NOW + 9 * 60_000);
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    // The window is the last 30 days.
    expect(mocks.queryRaw.mock.calls[0]).toContainEqual(new Date(NOW - 30 * 24 * 60 * 60_000));
    await loadEstimateInputs(planningStatus, NOW + 10 * 60_000);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("falls back to the compiled model on a failed history read, and asks again a minute later", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.queryRaw.mockRejectedValueOnce(new Error("statement timeout"));
    const planningStatus = statusOf({ status: "PLANNING" });
    await expect(loadEstimateInputs(planningStatus, NOW)).resolves.toMatchObject({ history: [] });
    expect(logged).toHaveBeenCalledOnce();
    await loadEstimateInputs(planningStatus, NOW + 30_000);
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    mocks.queryRaw.mockResolvedValue([historyRow]);
    await expect(loadEstimateInputs(planningStatus, NOW + 60_000)).resolves.toMatchObject({ history: [expect.anything()] });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });
});
