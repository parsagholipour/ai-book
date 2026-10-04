import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { generationRecoveryQuote } from "./generationRetryQuote.js";
import {
  bearer, buildMobileApp, jobRecord, mockAccessTokens, mockBilling, mockPrisma,
  projectRecord, resetMobileHarness, state, teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const sourceAttempt = {
  id: "attempt-rebuild", userId: "user-a", commandKey: "mobile:edit-command:original:rebuild",
  requestFingerprint: "rebuild", status: "FAILED", operation: "BOOK_REPLAN" as const,
  quotedCredits: 776, projectId: "project-copy", refundPending: false
};
const originalPayload = {
  operationId: "operation-rebuild", sourceProjectId: "original", sourcePlanId: "original-plan",
  request: "Make a shorter version", editInstruction: "Rebuild as three pages", targetPages: 3,
  characterContext: "Keep the original cast", billingLedgerEntryId: "refunded-ledger"
};

function retry(app: Awaited<ReturnType<typeof buildMobileApp>>, requestId = "rebuild-retry-0001") {
  return app.inject({
    method: "POST", url: "/api/mobile/projects/project-copy/resume", headers: bearer("token-a"),
    payload: { requestId, retryToken: generationRecoveryQuote(sourceAttempt).retryToken }
  });
}
function installFailedRebuild() {
  mockAccessTokens({ "token-a": "user-a" });
  mockPrisma.project.findFirst.mockResolvedValue(projectRecord({
    id: "project-copy", status: "FAILED", currentPlanId: null, currentPlan: null, targetPages: 3
  }));
  mockPrisma.page.findMany.mockResolvedValue([]);
  mockPrisma.generationJob.findMany.mockImplementation(async ({ where }: { where: { status?: string } }) =>
    where.status === "FAILED" ? [jobRecord({
      id: "job-rebuild-failed", projectId: "project-copy", type: "REPLAN_BOOK", status: "FAILED",
      attemptId: sourceAttempt.id, payload: originalPayload
    })] : [{ id: "job-rebuild-retry", status: "QUEUED" }]
  );
  mockPrisma.generationAttempt.findMany.mockResolvedValue([sourceAttempt]);
  vi.mocked(enqueueGenerationJob).mockResolvedValue(jobRecord({
    id: "job-rebuild-retry", projectId: "project-copy", type: "REPLAN_BOOK"
  }));
  mockPrisma.bookEditOperation.updateMany.mockResolvedValue({ count: 1 });
}

describe("retrying a rebuild before its target plan exists", () => {
  beforeEach(() => { resetMobileHarness(); installFailedRebuild(); });
  afterEach(teardownMobileHarness);

  it("reuses the source plan and transfers the operation to one newly paid job", async () => {
    const app = await buildMobileApp();
    try {
      expect((await retry(app)).statusCode).toBe(202);
      expect(mockBilling.reserveCredits).toHaveBeenCalledWith(expect.objectContaining({
        operation: "BOOK_REPLAN", amountCredits: 776, projectId: "project-copy"
      }));
      expect(enqueueGenerationJob).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-copy", type: "REPLAN_BOOK", dispatch: false,
        payload: { ...originalPayload, billingLedgerEntryId: "ledger-BOOK_REPLAN" }
      }));
      expect(mockPrisma.bookEditOperation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "operation-rebuild", kind: "BOOK_REPLAN", generationJobId: "job-rebuild-failed",
          status: { in: ["FAILED", "CANCELED"] }, structuralLeaseCompletedAt: null,
          project: { userId: "user-a" }
        },
        data: expect.objectContaining({
          status: "QUEUED", generationJobId: "job-rebuild-retry", ledgerEntryId: "ledger-BOOK_REPLAN",
          creditsCharged: 776, error: null, structuralLeaseToken: null, structuralLeaseExpiresAt: null
        })
      });
      expect(state.generationAttempts[0]).toMatchObject({ editOperationId: "operation-rebuild" });
      expect(mockPrisma.project.updateMany.mock.invocationCallOrder[0])
        .toBeLessThan(mockPrisma.bookEditOperation.updateMany.mock.invocationCallOrder[0]!);
      expect(dispatchGenerationJob).toHaveBeenCalledWith("job-rebuild-retry");

      // A second tap, even with another request id, replays the same paid attempt.
      expect((await retry(app, "rebuild-retry-0002")).statusCode).toBe(202);
      expect(mockBilling.reserveCredits).toHaveBeenCalledTimes(1);
      expect(enqueueGenerationJob).toHaveBeenCalledTimes(1);
      expect(mockPrisma.bookEditOperation.updateMany).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  it("refuses a retry when the original operation has moved on", async () => {
    mockPrisma.bookEditOperation.updateMany.mockResolvedValue({ count: 0 });
    const app = await buildMobileApp();
    try {
      const response = await retry(app);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("GENERATION_COMMAND_CONFLICT");
      expect(dispatchGenerationJob).not.toHaveBeenCalled();
      expect(state.generationAttempts).toHaveLength(0);
    } finally { await app.close(); }
  });
});
