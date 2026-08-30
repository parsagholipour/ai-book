import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { PRE_EDIT_PROJECT_STATUS } from "@book-maker/core";
import { reserveCredits } from "@book-maker/db/billing";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { generationRecoveryQuote } from "./generationRetryQuote.js";
import {
  bearer,
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  state,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

describe("mobile page rewrite retries", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it("advertises a fresh paid retry quote for a refunded failed page rewrite", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    mockPrisma.project.findFirst.mockResolvedValue(projectRecord({ id: "project-1", status: "COMPLETE" }));
    state.bookEditOperations.push(failedPageRewriteOperationRecord());
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/mobile/projects/project-1/chat",
      headers: bearer("token-a")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().operations).toEqual([
      expect.objectContaining({
        id: "operation-failed-rewrite",
        kind: "page_rewrite",
        status: "failed",
        retryAvailable: true,
        retryState: "available",
        recoveryQuote: expect.objectContaining({ credits: 80, requiresConfirmation: true })
      })
    ]);
    await app.close();
  });

  it("requeues the original page rewrite as one newly charged confirmed attempt", async () => {
    mockAccessTokens({ "token-a": "user-a" });
    const failed = failedPageRewriteOperationRecord();
    state.bookEditOperations.push(failed);
    mockPrisma.project.findFirst.mockResolvedValue({
      id: "project-1",
      currentPlanId: "plan-1",
      status: "COMPLETE"
    });
    vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(
      jobRecord({ id: "job-paid-page-retry", type: "APPLY_BOOK_EDIT" })
    );
    const app = await buildMobileApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/mobile/projects/project-1/operations/operation-failed-rewrite/retry",
      headers: bearer("token-a"),
      payload: {
        requestId: "retry-page-rewrite-0001",
        retryToken: generationRecoveryQuote(failed.generationAttempts[0]).retryToken
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation).toMatchObject({
      id: "operation-failed-rewrite",
      status: "queued",
      retryAvailable: false
    });
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "PAGE_REGENERATION", amountCredits: 80 })
    );
    expect(enqueueGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY_BOOK_EDIT",
        dispatch: false,
        attemptId: expect.stringContaining("attempt-mobile-page-rewrite-retry-attempt-failed-rewrite"),
        payload: expect.objectContaining({
          operationId: "operation-failed-rewrite",
          retryOfGenerationJobId: "job-failed-rewrite",
          request: "Add a sharing section to the ending.",
          editInstruction: "Add a closing section explaining why readers should share the book.",
          billingLedgerEntryId: "ledger-PAGE_REGENERATION",
          [PRE_EDIT_PROJECT_STATUS]: "COMPLETE"
        })
      })
    );
    expect(failed).toMatchObject({
      status: "QUEUED",
      generationJobId: "job-paid-page-retry",
      adherenceAudit: null,
      retryRequestId: "retry-page-rewrite-0001"
    });
    expect(dispatchGenerationJob).toHaveBeenCalledWith("job-paid-page-retry");
    await app.close();
  });
});

function failedPageRewriteOperationRecord() {
  return {
    id: "operation-failed-rewrite",
    projectId: "project-1",
    userMessageId: "chat-user-1",
    assistantMessageId: "chat-assistant-1",
    generationJobId: "job-failed-rewrite",
    ledgerEntryId: "ledger-PAGE_REGENERATION",
    ledgerEntry: { id: "ledger-PAGE_REGENERATION", status: "REFUNDED", entryType: "REFUND" },
    kind: "PAGE_REWRITE",
    status: "FAILED",
    requestId: "page-rewrite-original-request",
    automaticRetryCount: 0,
    automaticRetryLimit: 2,
    nextRetryAt: null,
    lastRetryAt: null,
    lastRetryReason: null,
    retryRequestId: null,
    request: "Add a sharing section to the ending.",
    editInstruction: "Add a closing section explaining why readers should share the book.",
    classifier: { kind: "page_rewrite" },
    adherenceAudit: { satisfied: false, attempts: 3 },
    affectedPageIndexes: [8],
    creditsCharged: 80,
    error: "The rewritten page did not satisfy the edit request.",
    generationJob: {
      id: "job-failed-rewrite",
      type: "APPLY_BOOK_EDIT",
      status: "FAILED",
      payload: {
        planId: "plan-1",
        operationId: "operation-failed-rewrite",
        request: "Add a sharing section to the ending.",
        editInstruction: "Add a closing section explaining why readers should share the book.",
        affectedPageIndexes: [8],
        intentKind: "page_rewrite",
        billingLedgerEntryId: "ledger-PAGE_REGENERATION",
        [PRE_EDIT_PROJECT_STATUS]: "COMPLETE"
      },
      startedAt: new Date("2026-08-30T21:42:53.000Z"),
      updatedAt: new Date("2026-08-30T21:45:00.000Z")
    },
    generationAttempts: [
      {
        id: "attempt-failed-rewrite",
        commandKey: "mobile:edit-operation:operation-failed-rewrite",
        status: "FAILED",
        operation: "PAGE_REGENERATION" as const,
        quotedCredits: 80,
        refundPending: false,
        retryOfAttemptId: null,
        createdAt: new Date("2026-08-30T21:42:53.000Z")
      }
    ],
    createdAt: new Date("2026-08-30T21:42:53.000Z"),
    updatedAt: new Date("2026-08-30T21:45:00.000Z"),
    appliedAt: null
  };
}
