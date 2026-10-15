import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { grantProjectEntitlement, reserveCredits } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../queue.js";
import { generationRecoveryQuote } from "./generationRetryQuote.js";
import {
  bearer,
  buildMobileApp,
  jobRecord,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

/**
 * A confirmed paid retry re-charges exactly its source attempt's stored price —
 * the `credits` the retry quote showed — and grants nothing beside it, because
 * every finished book downloads free (2026-10-15). An attempt charged before
 * then stored a price with the 150-credit export unlock inside it; its retry
 * keeps that price rather than meeting the attempt conflict a re-priced retry
 * would (`startGenerationAttempt` refuses a retry priced apart from its
 * source). Split from plansResume.test.ts at its size budget.
 */

/** A whole-book quote as an approval stored it before the unlock was retired. */
const LEGACY_QUOTE = {
  totalCredits: 926,
  lineItems: [
    { code: "FULL_BOOK_GENERATION", label: "Full book generation", quantity: 20, unitCredits: 8, credits: 510 },
    { code: "IMAGE_GENERATION", label: "Interior image generation", quantity: 5, unitCredits: 45, credits: 225 },
    { code: "IMAGE_GENERATION", label: "Cover image generation", quantity: 1, unitCredits: 45, credits: 45 },
    { code: "PREMIUM_REVIEW", label: "Premium review", quantity: 0, unitCredits: 200, credits: 0 },
    { code: "EXPORT_UNLOCK", label: "PDF/EPUB export unlock", quantity: 1, unitCredits: 150, credits: 150 }
  ],
  assumptions: { estimatedInteriorImages: 5, includesCover: true, includesExportUnlock: true, includesPremiumReview: false }
};

describe("mobile generation resume after the export unlock was retired", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  it.each([
    { operation: "FULL_BOOK_GENERATION", type: "GENERATE_PAGE", quotedCredits: 926, legacy: true },
    { operation: "BOOK_REPLAN", type: "REPLAN_BOOK", quotedCredits: 926, legacy: true },
    { operation: "BOOK_REPLAN", type: "GENERATE_PAGE", quotedCredits: 926, legacy: true },
    { operation: "FULL_BOOK_GENERATION", type: "GENERATE_PAGE", quotedCredits: 776, legacy: false },
    { operation: "BOOK_REPLAN", type: "REPLAN_BOOK", quotedCredits: 776, legacy: false },
    { operation: "PAGE_REGENERATION", type: "GENERATE_PAGE", quotedCredits: 776, legacy: false }
  ] as const)(
    "retries $type under $operation at its stored $quotedCredits and grants nothing (charged before the change: $legacy)",
    async ({ operation, type, quotedCredits, legacy }) => {
      mockAccessTokens({ "token-a": "user-a" });
      const sourceAttempt = {
        id: "attempt-source",
        userId: "user-a",
        commandKey: "mobile:plan-approval:plan-1",
        requestFingerprint: "source-fingerprint",
        status: "FAILED",
        operation,
        quotedCredits,
        projectId: "project-1",
        refundPending: false,
        ledgerEntryId: "source-charge"
      };
      mockPrisma.creditLedgerEntry.findUnique.mockResolvedValue({
        metadata: { creditEstimate: legacy ? LEGACY_QUOTE : { ...LEGACY_QUOTE, totalCredits: 776 } }
      });
      mockPrisma.project.findFirst.mockResolvedValue(
        projectRecord({
          id: "project-1",
          currentPlanId: "plan-1",
          currentPlan: { id: "plan-1", createdAt: new Date("2026-06-15T12:00:00.000Z") }
        })
      );
      const failedJobsRead = mockPrisma.generationJob.findMany
        .mockResolvedValueOnce([
          jobRecord({
            id: "job-failed-page",
            projectId: "project-1",
            type,
            status: "FAILED",
            attemptId: sourceAttempt.id,
            payload: {
              operationId: "operation-rebuild",
              pageId: "page-1",
              planId: "plan-1",
              billingLedgerEntryId: "refunded-ledger"
            }
          })
        ]);
      // The books-in-progress read: a page retry puts the book back in the long
      // lane, while a replan stages its plan in the interactive one and asks nothing.
      if (type !== "REPLAN_BOOK") failedJobsRead.mockResolvedValueOnce([]);
      failedJobsRead.mockResolvedValueOnce([{ id: "job-paid-retry", status: "QUEUED" }]);
      mockPrisma.page.findMany.mockResolvedValueOnce([{ id: "page-1" }]);
      mockPrisma.generationAttempt.findMany.mockResolvedValueOnce([sourceAttempt]);
      vi.mocked(enqueueGenerationJob).mockResolvedValueOnce(jobRecord({ id: "job-paid-retry", type }));
      mockPrisma.bookEditOperation.updateMany.mockResolvedValueOnce({ count: 1 });
      const app = await buildMobileApp();

      // The price the app showed before the reader confirmed.
      const quote = generationRecoveryQuote(sourceAttempt);
      expect(quote.credits).toBe(quotedCredits);
      const response = await app.inject({
        method: "POST",
        url: "/api/mobile/projects/project-1/resume",
        headers: bearer("token-a"),
        payload: { requestId: "generation-retry-0001", retryToken: quote.retryToken }
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ resumedActions: 1, currentAction: "Picking up your book generation." });
      expect(reserveCredits).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ operation, amountCredits: quotedCredits })
      );
      expect(enqueueGenerationJob).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: expect.stringContaining("attempt-mobile-generation-retry-attempt-source"),
          payload: expect.objectContaining({
            pageId: "page-1",
            billingLedgerEntryId: `ledger-${operation}`
          })
        })
      );
      // No export entitlement for any package, old or new: the file is free.
      expect(grantProjectEntitlement).not.toHaveBeenCalled();
      await app.close();
    }
  );
});
