import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { serializeProjectStatus as serializeProjectStatusFromFacade } from "./projectSerializers.js";
import { serializeProjectStatus } from "./projectStatusSerializers.js";
import { resetMobileHarness, statusRecord } from "./testing/mobileApiHarness.js";

beforeEach(resetMobileHarness);

describe("status serializer parity", () => {
  it("keeps representative lifecycle, recovery, quality, and numbering fields identical through the façade", () => {
    const exports = {
      pdf: {
        format: "pdf" as const,
        available: true,
        unlocked: true,
        creditsRequired: 0,
        downloadUrl: "/api/mobile/projects/project-1/export/pdf",
        filename: "Progress-Book.pdf",
        contentType: "application/pdf",
        revision: 3,
        byteSize: 1024,
        updatedAt: "2026-06-15T12:20:00.000Z"
      },
      epub: {
        format: "epub" as const,
        available: false,
        unlocked: true,
        creditsRequired: 0,
        downloadUrl: "/api/mobile/projects/project-1/export/epub",
        filename: "Progress-Book.epub",
        contentType: "application/epub+zip",
        revision: 3,
        byteSize: null,
        updatedAt: null
      }
    };
    const record = statusRecord({
      project: {
        id: "project-1",
        title: "Progress Book",
        status: "GENERATING",
        contentRevision: 3,
        pdfPageMap: {
          version: 2,
          totalPdfPages: 8,
          hasCoverPage: true,
          pages: [{ index: 1, startPdfPage: 3, endPdfPage: 4 }],
          contentRevision: 3,
          pdfDigest: "pdf-digest-a"
        },
        updatedAt: new Date("2026-06-15T12:30:00.000Z"),
        jobs: [
          { id: "job-audio", type: "GENERATE_AUDIOBOOK", status: "FAILED", error: "Derivative failure" },
          { id: "job-page", type: "GENERATE_PAGE", status: "FAILED", error: "Page timed out" }
        ],
        generationAttempts: [{
          id: "attempt-1",
          commandKey: "mobile:plan-approval:plan-1",
          status: "FAILED",
          quotedCredits: 776,
          refundPending: false,
          retryAttempt: null
        }]
      },
      progress: {
        pages: { complete: 3, target: 10 },
        images: 1,
        resumableFailedJobs: 1,
        resumableAttemptIds: ["attempt-1"],
        pipeline: [
          { key: "plan", label: "Plan", status: "done" },
          { key: "pages", label: "Pages", status: "active", detail: "3/10 pages" },
          { key: "images", label: "Images", status: "pending", detail: "1 images" },
          { key: "export", label: "Export", status: "pending" }
        ]
      }
    });

    const owned = serializeProjectStatus(record as never, exports);
    const facade = serializeProjectStatusFromFacade(record as never, exports);

    expect(serializeProjectStatusFromFacade).toBe(serializeProjectStatus);
    expect(facade).toEqual(owned);
    expect(Object.keys(owned).sort()).toEqual([
      "coverArtSource", "coverEnabled", "currentAction", "editProgress", "exports", "failureMessage", "generationProgress",
      "hasCoverPage", "illustrationsEnabled", "imageCount", "imagesEnabled", "pageProgress", "pdfPageNumbering", "planningProgress",
      "progressPercent", "projectId", "quality", "recoveryQuote", "retryAvailable", "status", "statusLabel", "steps",
      "updatedAt"
    ]);
    expect(owned).toMatchObject({
      projectId: "project-1",
      status: "generating",
      failureMessage: expect.stringContaining("while writing a page"),
      retryAvailable: true,
      recoveryQuote: { credits: 776, retryToken: expect.any(String) },
      pageProgress: { completed: 3, target: 10 },
      hasCoverPage: true,
      pdfPageNumbering: { hasCoverPage: true, contentRevision: 3, pdfDigest: "pdf-digest-a" }
    });
    expect(owned.failureMessage).not.toContain("Derivative failure");
  });
});
