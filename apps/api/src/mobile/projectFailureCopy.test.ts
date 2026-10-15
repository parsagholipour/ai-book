import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { EDIT_ADHERENCE_FAILED } from "@book-maker/core/editFailure";
import { buildProjectStatus } from "../projectStatus.js";
import {
  attemptChargeReturned,
  FAILURE_CREDITS_RETURNED,
  failureMessageForJob,
  readerFacingJobError
} from "./projectFailureCopy.js";
import {
  bearer,
  buildMobileApp,
  mockAccessTokens,
  mockPrisma,
  resetMobileHarness,
  statusRecord,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const PROVIDER_ERROR =
  'DeepSeek request failed: 429 Too Many Requests {"error":{"message":"Rate limit reached for deepseek-chat in organization org-abc","type":"requests"}} at /app/node_modules/openai/core.js:412';

function failedBook(error: string, attemptId: string | null = "attempt-1") {
  return statusRecord({
    project: {
      id: "project-1",
      status: "FAILED",
      jobs: [
        {
          id: "job-page",
          type: "GENERATE_PAGE",
          status: "FAILED",
          error,
          attemptId,
          progress: 0,
          steps: [],
          payload: { pageId: "page-1" }
        }
      ]
    }
  });
}

async function readFailure(record: unknown): Promise<string | null> {
  mockAccessTokens({ "token-a": "user-a" });
  mockPrisma.project.findFirst.mockResolvedValue({ id: "project-1" });
  vi.mocked(buildProjectStatus).mockResolvedValue(record as never);
  const app = await buildMobileApp();
  const response = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/status", headers: bearer("token-a") });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.json().status.failureMessage;
}

function refundedAttempt(overrides: Record<string, unknown> = {}) {
  return {
    status: "FAILED",
    refundPending: false,
    ledgerEntry: { status: "SETTLED", amountCredits: -500, reversedByEntry: { amountCredits: 500 } },
    ...overrides
  };
}

describe("failure copy", () => {
  it("never ships a provider's raw error text", () => {
    const message = failureMessageForJob("GENERATE_PAGE", PROVIDER_ERROR);
    expect(message).toBe("We hit a problem while writing a page.");
    expect(message).not.toMatch(/429|DeepSeek|deepseek|org-|node_modules/);
  });

  it("keeps a sentence written for the reader, and does not repeat its credits line", () => {
    expect(readerFacingJobError(`  ${EDIT_ADHERENCE_FAILED}  `)).toBe(EDIT_ADHERENCE_FAILED);
    expect(failureMessageForJob("APPLY_BOOK_EDIT", EDIT_ADHERENCE_FAILED, { creditsReturned: true })).toBe(
      `We hit a problem while editing your book: ${EDIT_ADHERENCE_FAILED}`
    );
    expect(failureMessageForJob("IMPORT_BOOK", "No readable pages were found in that manuscript.")).toBe(
      "We hit a problem while importing your book: No readable pages were found in that manuscript."
    );
  });

  it("says the credits came back only when it is told they did", () => {
    expect(failureMessageForJob("GENERATE_BOOK", PROVIDER_ERROR, { creditsReturned: true })).toBe(
      `We hit a problem while starting book generation. ${FAILURE_CREDITS_RETURNED}`
    );
    expect(failureMessageForJob("GENERATE_BOOK", null)).toBe("We hit a problem while starting book generation.");
  });

  it("reads a refund only off a whole reversal or a release", () => {
    expect(attemptChargeReturned(refundedAttempt())).toBe(true);
    expect(attemptChargeReturned(refundedAttempt({ ledgerEntry: { status: "REFUNDED", amountCredits: -40, reversedByEntry: null } }))).toBe(true);
    expect(attemptChargeReturned(refundedAttempt({ ledgerEntry: { status: "SETTLED", amountCredits: -500, reversedByEntry: { amountCredits: 200 } } }))).toBe(false);
    expect(attemptChargeReturned(refundedAttempt({ refundPending: true }))).toBe(false);
    expect(attemptChargeReturned(refundedAttempt({ status: "ACTIVE" }))).toBe(false);
    expect(attemptChargeReturned(refundedAttempt({ ledgerEntry: null }))).toBe(false);
    expect(attemptChargeReturned(refundedAttempt({ ledgerEntry: { status: "SETTLED", amountCredits: 0, reversedByEntry: null } }))).toBe(false);
    expect(attemptChargeReturned(null)).toBe(false);
  });
});

describe("GET /api/mobile/projects/:id/status failure message", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("hides the worker's error and says the credits came back when the ledger shows it", async () => {
    mockPrisma.generationAttempt.findUnique.mockResolvedValue(refundedAttempt());

    const message = await readFailure(failedBook(PROVIDER_ERROR));

    expect(message).toBe(`We hit a problem while writing a page. ${FAILURE_CREDITS_RETURNED}`);
    expect(mockPrisma.generationAttempt.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "attempt-1" } }));
  });

  it("makes no claim about credits while the refund is pending or partial", async () => {
    mockPrisma.generationAttempt.findUnique.mockResolvedValue(refundedAttempt({ refundPending: true }));
    expect(await readFailure(failedBook(PROVIDER_ERROR))).toBe("We hit a problem while writing a page.");

    mockPrisma.generationAttempt.findUnique.mockResolvedValue(
      refundedAttempt({ ledgerEntry: { status: "SETTLED", amountCredits: -500, reversedByEntry: { amountCredits: 100 } } })
    );
    expect(await readFailure(failedBook(PROVIDER_ERROR))).toBe("We hit a problem while writing a page.");
  });

  it("makes no claim for an attempt-less row or a refund read that fails", async () => {
    expect(await readFailure(failedBook(PROVIDER_ERROR, null))).toBe("We hit a problem while writing a page.");
    expect(mockPrisma.generationAttempt.findUnique).not.toHaveBeenCalled();

    mockPrisma.generationAttempt.findUnique.mockRejectedValue(new Error("pool timeout"));
    expect(await readFailure(failedBook(PROVIDER_ERROR))).toBe("We hit a problem while writing a page.");
  });
});
