import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import {
  GenerationAttemptConflictError,
  GenerationQuotaExceededError,
  InsufficientCreditsError
} from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
import { classifyEditFailure, imageLimitReachedMessage } from "@book-maker/core/editFailure";
import {
  approvedPlanRecord,
  bearer,
  buildMobileApp,
  editablePages,
  generatedPages,
  jobRecord,
  mockAccessTokens,
  mockBilling,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * `BookEditOperation.error` is a reader-facing column: the serializer copies it
 * onto the mobile DTO and the app parses it. Every catch that fails a row whose
 * paid start never committed used to store `errorMessage(error)` — so an
 * internal fault's own words were shipped to the device.
 */

/** Verbatim shape of what `GenerationAttemptJobClaimError` says. */
const CLAIM_ERROR_MESSAGE =
  "Generation attempt attempt-2 may not claim generation job job-1: it is already attempt attempt-1's work. " +
  "A create() callback must enqueue its own job with this attemptId, never return one it found under a spent dedupeKey.";

const EDIT_START_FAILED = "That change couldn’t be started, so nothing was charged. Send it again to try once more.";

const spentSlot = {
  allowed: false,
  used: 3,
  limit: 3,
  periodKey: "2026-06",
  resetsAt: new Date("2026-07-01T00:00:00.000Z")
};

describe("classifyEditFailure", () => {
  it("keeps the sentence an answered conflict already owns", () => {
    expect(
      classifyEditFailure(new GenerationAttemptConflictError("That command has different settings."), "start")
    ).toEqual({ message: "That command has different settings.", internal: false });
  });

  /**
   * The free tier's illustrated-book limit has two claiming doors — plan
   * approval and the chat `add_image` Apply — and one reader spending one slot
   * may not be told two different things depending which one they walked
   * through. The HTTP door composes `sendImageLimitReached`; this rung used to
   * store `GenerationQuotaExceededError.message` instead, an internal sentence
   * with no count in it and nothing to do next.
   */
  it("gives the chat door the same illustrated-book sentence the HTTP door sends", () => {
    const failure = classifyEditFailure(new GenerationQuotaExceededError(spentSlot), "start");

    expect(failure).toEqual({
      message: "Free plans include 3 illustrated books a month. Upgrade for unlimited, or turn visuals off.",
      internal: false
    });
    expect(failure.message).toBe(imageLimitReachedMessage(3));
    expect(failure.message).not.toBe(new GenerationQuotaExceededError(spentSlot).message);
  });

  it("still says what to do next when the claim carries no usable count", () => {
    const failure = classifyEditFailure(
      new GenerationQuotaExceededError({ ...spentSlot, limit: Number.NaN }),
      "start"
    );

    expect(failure.internal).toBe(false);
    expect(failure.message).toMatch(/Upgrade for unlimited, or turn visuals off\.$/);
    expect(failure.message).not.toMatch(/\bnull\b|\bundefined\b|NaN/);
  });

  it("answers a credits refusal without repeating the shortfall the reply already names", () => {
    const failure = classifyEditFailure(
      new InsufficientCreditsError({ requiredCredits: 250, availableCredits: 10, reservedCredits: 0 }),
      "start"
    );

    expect(failure.internal).toBe(false);
    expect(failure.message).toBe("There weren’t enough credits for that change. Add credits, then send it again.");
    expect(failure.message).not.toMatch(/\d/);
  });

  it("never lets an internal fault's own words become reader copy", () => {
    for (const cause of [
      new Error(CLAIM_ERROR_MESSAGE),
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      new Error("Invalid `prisma.generationJob.create()` invocation: Unique constraint failed on (`dedupeKey`)"),
      { code: "P2024", message: "Timed out fetching a new connection from the connection pool." },
      "not an Error at all"
    ]) {
      expect(classifyEditFailure(cause, "start")).toEqual({ message: EDIT_START_FAILED, internal: true });
      const settled = classifyEditFailure(cause, "settlement");
      expect(settled.internal).toBe(true);
      // A settlement charged for the work, so its sentence may not claim
      // nothing was — the card reports the refund on its own.
      expect(settled.message).toBe("That change couldn’t be finished. Send it again to try once more.");
    }
  });
});

describe("a chat edit whose paid start never committed", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  const completeProject = () =>
    projectRecord({
      id: "project-1",
      status: "COMPLETE",
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord(),
      pages: generatedPages()
    });

  const openChat = async (app: Awaited<ReturnType<typeof buildMobileApp>>) => {
    const chat = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });
    expect(chat.statusCode).toBe(200);
    return chat.json();
  };

  it("tells the reader how to get unstuck and leaves the claim fault in the server log", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    state.pages = editablePages();
    mockPrisma.project.findFirst.mockResolvedValue(completeProject());
    vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({ id: "job-1", type: "APPLY_BOOK_EDIT" }));
    const app = await buildMobileApp();
    const proposal = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Replace rabbit with fly throughout the whole book." }
    });
    expect(proposal.statusCode).toBe(200);
    const proposalId = proposal.json().reply.metadata.editProposal.id as string;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockBilling.startGenerationAttempt.mockRejectedValueOnce(new Error(CLAIM_ERROR_MESSAGE));

    const applied = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/proposals/apply",
      headers: bearer("token-a"),
      payload: { proposalId, requestId: "req-apply-1" }
    });

    expect(applied.statusCode).toBe(500);
    // The row the app reads, and the wire it reads it over.
    const failed = state.bookEditOperations.find((operation) => operation.status === "FAILED");
    expect(failed?.error).toBe(EDIT_START_FAILED);
    const shipped = (await openChat(app)).operations.find(
      (operation: { status: string }) => operation.status === "failed"
    );
    expect(shipped.error).toBe(EDIT_START_FAILED);
    expect(shipped.error).not.toMatch(/dedupeKey|create\(\)|attemptId|attempt-\d/);
    // Lost nowhere: the cause is still readable, on the server.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Edit generation attempt could not start"), expect.any(Error));
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ message: CLAIM_ERROR_MESSAGE });
    logged.mockRestore();
    await app.close();
  });

  it("says the same about a plan revision that could not start", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        id: "project-1",
        status: "GENERATING",
        currentPlanId: "plan-1",
        currentPlan: approvedPlanRecord(),
        pages: []
      })
    );
    const app = await buildMobileApp();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockBilling.startGenerationAttempt.mockRejectedValueOnce(new Error(CLAIM_ERROR_MESSAGE));

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/chat/messages",
      headers: bearer("token-a"),
      payload: { message: "Change rabbit into a fly before writing starts." }
    });

    expect(response.statusCode).toBe(500);
    const failed = state.bookEditOperations.find((operation) => operation.status === "FAILED");
    expect(failed?.error).toBe(EDIT_START_FAILED);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("Plan revision attempt could not start"),
      expect.any(Error)
    );
    logged.mockRestore();
    await app.close();
  });
});
