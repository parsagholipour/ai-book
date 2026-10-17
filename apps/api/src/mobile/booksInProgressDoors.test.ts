import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  getImageQuota,
  hasActiveSubscriptionEntitlement,
  reserveCredits,
  startGenerationAttempt
} from "@book-maker/db/billing";
import { enqueueGenerationJob } from "../queue.js";
import {
  booksInProgressMessage,
  booksInProgressRefusal,
  proposalStartsLongLaneWork,
  startsLongLaneWork
} from "./booksInProgress.js";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * One account's share of the long lane (`booksInProgress.ts`): every door that
 * starts long-lane work refuses past the limit, and refuses before it reads a
 * quota, reserves a credit, starts an attempt or enqueues a job.
 */

type OpenRow = { projectId: string; type: string; payload: Record<string, unknown> };

/** The open rows the books-in-progress read sees; every other job read answers as the harness does. */
function openLongLaneWork(rows: OpenRow[]) {
  const fallback = mockPrisma.generationJob.findMany.getMockImplementation();
  mockPrisma.generationJob.findMany.mockImplementation(async (args: { where?: { project?: { userId?: string }; projectId?: { notIn?: string[] } } }) => {
    if (args?.where?.project?.userId) {
      const excluded = args.where.projectId?.notIn ?? [];
      return rows.filter((row) => !excluded.includes(row.projectId));
    }
    return fallback ? fallback(args) : [];
  });
}

function expectNothingStarted() {
  expect(vi.mocked(getImageQuota)).not.toHaveBeenCalled();
  expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
  expect(vi.mocked(startGenerationAttempt)).not.toHaveBeenCalled();
  expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();
}

const OTHER_BOOK_RUNNING: OpenRow = { projectId: "project-other", type: "GENERATE_BOOK", payload: { planId: "plan-x" } };

function draftPlan() {
  const project = projectRecord({ id: "project-1", status: "PLAN_READY", currentPlanId: "plan-1" });
  mockPrisma.planVersion.findFirst.mockResolvedValue({
    id: "plan-1",
    projectId: "project-1",
    status: "DRAFT",
    inputSnapshot: null,
    project
  });
}

describe("the books-in-progress limit", () => {
  beforeEach(() => {
    resetMobileHarness();
    mockAccessTokens({ "token-a": "user-a" });
  });
  afterEach(teardownMobileHarness);

  it("counts books with long-lane work, never interactive work and never the book being started", async () => {
    openLongLaneWork([
      // A short recompile of an edited book runs in the interactive lane.
      { projectId: "project-edit", type: "COMPILE_EXPORT", payload: { skipFinalReview: true, exportPublicationProjectStatus: "EDITING" } },
      { projectId: "project-1", type: "GENERATE_BOOK", payload: {} }
    ]);
    await expect(booksInProgressRefusal("user-a", { exceptProjectIds: ["project-1"] })).resolves.toBeNull();

    openLongLaneWork([OTHER_BOOK_RUNNING, { ...OTHER_BOOK_RUNNING, type: "GENERATE_PAGE" }]);
    // Two rows of one book are one book.
    await expect(booksInProgressRefusal("user-a")).resolves.toEqual({ limit: 1, inProgress: 1 });
  });

  it("still counts a book whose pictures or compile are all it has left, though they left the long lane", async () => {
    openLongLaneWork([{ projectId: "project-drawing", type: "GENERATE_IMAGE", payload: { planId: "plan-x", pageId: "page-1" } }]);
    await expect(booksInProgressRefusal("user-a")).resolves.toEqual({ limit: 1, inProgress: 1 });
    openLongLaneWork([
      { projectId: "project-typesetting", type: "COMPILE_EXPORT", payload: { exportPublicationProjectStatus: "GENERATING" } }
    ]);
    await expect(booksInProgressRefusal("user-a")).resolves.toEqual({ limit: 1, inProgress: 1 });
    expect(startsLongLaneWork([{ type: "GENERATE_IMAGE", payload: { planId: "plan-x", pageId: "page-1" } }])).toBe(true);
  });

  it("gives a paid plan three books, and counts an unreadable plan as paid", async () => {
    const books = ["a", "b", "c"].map((id) => ({ projectId: `project-${id}`, type: "GENERATE_AUDIOBOOK", payload: {} }));
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
    openLongLaneWork(books.slice(0, 2));
    await expect(booksInProgressRefusal("user-a")).resolves.toBeNull();
    openLongLaneWork(books);
    await expect(booksInProgressRefusal("user-a")).resolves.toEqual({ limit: 3, inProgress: 3 });

    vi.mocked(hasActiveSubscriptionEntitlement).mockRejectedValue(new Error("pool exhausted"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    openLongLaneWork(books.slice(0, 1));
    await expect(booksInProgressRefusal("user-a")).resolves.toBeNull();
    errors.mockRestore();
  });

  it("owns one sentence per limit", () => {
    expect(booksInProgressMessage({ limit: 1, inProgress: 1 })).toBe(
      "You already have a book being made. You can start this one as soon as it's finished — free accounts make one book at a time."
    );
    expect(booksInProgressMessage({ limit: 3, inProgress: 3 })).toBe(
      "You already have 3 books being made. You can start this one as soon as one of them is finished."
    );
  });

  it("knows which retries and chat cards start long-lane work", () => {
    expect(startsLongLaneWork([{ type: "GENERATE_PAGE", payload: {} }])).toBe(true);
    expect(startsLongLaneWork([{ type: "REPLAN_BOOK", payload: {} }, { type: "PLAN_BOOK", payload: {} }])).toBe(false);
    expect(proposalStartsLongLaneWork({ intent: { kind: "continue_book" } })).toBe(true);
    expect(proposalStartsLongLaneWork({ intent: { kind: "book_replan" } })).toBe(true);
    expect(proposalStartsLongLaneWork({ intent: { kind: "restructure_pages" } })).toBe(false);
    // A text edit is held to the limit exactly when the lane map would send its payload long.
    const pages = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
    expect(proposalStartsLongLaneWork({ intent: { kind: "page_rewrite" }, affectedPageIndexes: pages(40), credits: 400 })).toBe(false);
    expect(proposalStartsLongLaneWork({ intent: { kind: "page_rewrite" }, affectedPageIndexes: pages(41), credits: 410 })).toBe(true);
    expect(proposalStartsLongLaneWork({ intent: { kind: "chapter_regenerate" }, affectedPageIndexes: pages(60), credits: 600 })).toBe(true);
    expect(proposalStartsLongLaneWork({ intent: { kind: "local_patch" }, affectedPageIndexes: pages(200), credits: 900 })).toBe(true);
    // A local patch quoted at nothing is a verified find/replace: code, interactive at any length.
    expect(proposalStartsLongLaneWork({ intent: { kind: "local_patch" }, affectedPageIndexes: pages(200), credits: 0 })).toBe(false);
    expect(proposalStartsLongLaneWork({ intent: { kind: "move_image" }, affectedPageIndexes: pages(200), credits: 0 })).toBe(false);
  });

  it("refuses a plan approval before the image slot, the charge or the job", async () => {
    openLongLaneWork([OTHER_BOOK_RUNNING]);
    draftPlan();
    const app = await buildMobileApp();

    const response = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      error: {
        code: "BOOKS_IN_PROGRESS_LIMIT",
        message: booksInProgressMessage({ limit: 1, inProgress: 1 }),
        booksInProgress: { limit: 1, inProgress: 1 }
      }
    });
    expectNothingStarted();
    await app.close();
  });

  it("still answers the replay of a plan already approved and paid for", async () => {
    openLongLaneWork([OTHER_BOOK_RUNNING]);
    draftPlan();
    const approved = await mockPrisma.planVersion.findFirst();
    mockPrisma.planVersion.findFirst.mockResolvedValue({ ...approved, status: "APPROVED" });
    const app = await buildMobileApp();

    const response = await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a") });

    expect(response.json().error?.code).not.toBe("BOOKS_IN_PROGRESS_LIMIT");
    await app.close();
  });

  it("refuses a narration before the charge", async () => {
    // Narration is a plan perk, so only a paying account reaches this limit,
    // and a plan's share of the long lane is three books.
    vi.mocked(hasActiveSubscriptionEntitlement).mockResolvedValue(true);
    openLongLaneWork(["a", "b", "c"].map((id) => ({ ...OTHER_BOOK_RUNNING, projectId: `project-other-${id}` })));
    mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1", status: "COMPLETE", contentRevision: 3 });
    mockPrisma.audiobook.findUnique.mockResolvedValue(null);
    mockPrisma.page.findMany.mockResolvedValue(Array.from({ length: 4 }, () => ({ markdown: "word ".repeat(200) })));
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/audiobook",
      headers: bearer("token-a"),
      payload: { voice: "Zephyr" }
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("BOOKS_IN_PROGRESS_LIMIT");
    expectNothingStarted();
    await app.close();
  });

  it("refuses a continuation's Apply before the Apply row or the charge, and lets the same card run once the other book is done", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "COMPLETE",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: generatedPages()
      })
    );
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-continue", type: "CONTINUE_BOOK" }));
    const app = await buildMobileApp();
    const proposal = (
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/messages",
        headers: bearer("token-a"),
        payload: { message: "Continue the story and add 2 more chapters" }
      })
    ).json();
    const proposalId = proposal.reply.metadata.editProposal.id;
    const writesBefore = mockPrisma.projectChatMessage.create.mock.calls.length;

    openLongLaneWork([OTHER_BOOK_RUNNING]);
    const refused = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId }
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("BOOKS_IN_PROGRESS_LIMIT");
    // No "Apply" row: the card is still the reader's to apply.
    expect(mockPrisma.projectChatMessage.create.mock.calls.length).toBe(writesBefore);
    expect(vi.mocked(reserveCredits)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueGenerationJob)).not.toHaveBeenCalled();

    openLongLaneWork([]);
    const applied = (
      await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/chat/proposals/apply",
        headers: bearer("token-a"),
        payload: { proposalId }
      })
    ).json();
    expect(applied.operation).toMatchObject({ kind: "continue_book" });
    expect(vi.mocked(reserveCredits)).toHaveBeenCalled();
    await app.close();
  });
});
