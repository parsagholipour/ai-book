import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { startGenerationAttempt } from "@book-maker/db/billing";
import { enqueueGenerationJob } from "../queue.js";
import { pageMarkdownCountsAsIllustrated } from "./addImageOperations.js";
import { chatStageForProject, editChangesAvailable } from "./projectChat.js";
import { studioDraftStatus } from "./projectStatusSerializers.js";
import {
  approvedPlanRecord,
  appliedEditOperationRecord,
  bearer,
  buildMobileApp,
  buildOperatorApp,
  mockAccessTokens,
  mockPrisma,
  projectRecord,
  resetMobileHarness,
  teardownMobileHarness
} from "./testing/mobileApiHarness.js";

const STUDIO = {
  finalReview: false,
  fullIllustrations: false,
  coverArtSource: "design",
  mobile: { studio: { layout: "flow", kind: "story", createdAt: "2026-09-29T00:00:00.000Z" } }
};
const IMPORTED = { finalReview: false, mobile: { import: { importId: "imp_1", fileName: "book.docx" } } };
/** A generated book its owner took over: the generation settings stay, the Studio record joins them. */
const TAKEN_OVER = {
  finalReview: true,
  fullIllustrations: true,
  coverArtSource: "ai",
  mobile: { studio: { layout: "flow", kind: "story", createdAt: "2026-09-30T00:00:00.000Z", origin: "takeover" } }
};

beforeEach(() => {
  resetMobileHarness();
  mockAccessTokens({ "token-a": "user-a" });
});
afterEach(teardownMobileHarness);

describe("generation routes refuse an author's book", () => {
  for (const [label, mediaSettings] of [
    ["a Studio book", STUDIO],
    ["an imported book", IMPORTED],
    ["a taken-over book", TAKEN_OVER]
  ] as const) {
    it(`answers 409 AUTHOR_MANUSCRIPT to plan, revise and approve on ${label}`, async () => {
      const project = projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1", mediaSettings });
      mockPrisma.project.findFirst.mockResolvedValue(project);
      mockPrisma.planVersion.findFirst.mockResolvedValue({ ...approvedPlanRecord(), project });
      const app = await buildMobileApp();

      const responses = [
        await app.inject({ method: "POST", url: "/api/mobile/projects/project-1/plan", headers: bearer("token-a"), payload: {} }),
        await app.inject({
          method: "POST",
          url: "/api/mobile/plans/plan-1/revise",
          headers: bearer("token-a"),
          payload: { message: "Make it longer and add a dragon." }
        }),
        await app.inject({ method: "POST", url: "/api/mobile/plans/plan-1/approve", headers: bearer("token-a"), payload: {} })
      ];

      for (const response of responses) {
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toEqual({
          code: "AUTHOR_MANUSCRIPT",
          message: "This book is written by you — open it in the Writing Studio."
        });
      }
      expect(startGenerationAttempt).not.toHaveBeenCalled();
      expect(enqueueGenerationJob).not.toHaveBeenCalled();
    });

    it(`closes the operator plan, plan-message, approve and page-retry routes on ${label}`, async () => {
      const project = projectRecord({ id: "project-1", status: "COMPLETE", currentPlanId: "plan-1", mediaSettings });
      mockPrisma.project.findFirst.mockResolvedValue(project);
      mockPrisma.planVersion.findFirst.mockResolvedValue({ ...approvedPlanRecord({ status: "DRAFT" }), project });
      mockPrisma.page.findUnique.mockResolvedValue({ id: "page-1", projectId: "project-1", index: 1, status: "FAILED_QA", revision: 1 });
      const app = await buildOperatorApp();

      const responses = [
        await app.inject({ method: "POST", url: "/api/projects/project-1/plan" }),
        await app.inject({ method: "POST", url: "/api/plans/plan-1/messages", payload: { message: "Add a chapter about dragons." } }),
        await app.inject({ method: "POST", url: "/api/plans/plan-1/approve" }),
        await app.inject({ method: "POST", url: "/api/projects/project-1/pages/page-1/retry" })
      ];

      for (const response of responses) {
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: "AUTHOR_MANUSCRIPT" });
      }
      expect(enqueueGenerationJob).not.toHaveBeenCalled();
    });
  }

  it("never puts an author's book in the approved-plan chat stage, even while a publish compiles", () => {
    const approved = { ...approvedPlanRecord(), inputSnapshot: null, messages: [] } as never;
    expect(chatStageForProject("EDITING", approved, STUDIO)).toBe("other");
    expect(chatStageForProject("EDITING", approved, IMPORTED)).toBe("other");
    expect(chatStageForProject("DRAFT", null, STUDIO)).toBe("other");
    expect(chatStageForProject("COMPLETE", approved, STUDIO)).toBe("complete");
    expect(chatStageForProject("EDITING", approved, { mobile: { bookType: "custom" } })).toBe("approved_plan");
  });
});

describe("what an author's own pictures do not count as", () => {
  it("does not count an upload as an illustrated page, and still counts a drawn picture beside it", () => {
    const upload = "![Harbour](/assets/images/project-1/upload-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jpg)";
    const drawn = "![Harbour](/assets/images/project-1/studio-image-abc.jpg)";
    const foreign = "![Harbour](/assets/images/project-2/studio-image-abc.jpg)";

    expect(pageMarkdownCountsAsIllustrated(`${upload}\n\nText.`, "project-1")).toBe(false);
    expect(pageMarkdownCountsAsIllustrated(`${upload}\n\n${drawn}`, "project-1")).toBe(true);
    expect(pageMarkdownCountsAsIllustrated(foreign, "project-1")).toBe(false);
  });
});

describe("sealed edits and the review card", () => {
  it("hides See changes for a structural edit a publish sealed, and keeps a snapshot-backed one", () => {
    const structural = {
      structuralApplication: {
        action: "insert",
        appliedAt: "2026-09-01T10:00:00.000Z",
        pageOrderBefore: [{ pageId: "page-1", index: 1, chapterId: null }],
        insertedPageIds: ["page-9"],
        previousTargetPages: 1
      }
    };
    const sealed = { sealedAt: "2026-09-02T10:00:00.000Z" };
    const row = (classifier: Record<string, unknown>, snapshots: number) =>
      appliedEditOperationRecord({ kind: "RESTRUCTURE_PAGES", classifier, _count: { snapshots, archivedSnapshots: 0 } }) as never;

    expect(editChangesAvailable(row(structural, 0))).toBe(true);
    expect(editChangesAvailable(row({ ...structural, ...sealed }, 0))).toBe(false);
    expect(editChangesAvailable(row(sealed, 2))).toBe(true);
  });
});

describe("a Studio book's status copy", () => {
  it("reads Writing · N words with progress toward the goal", () => {
    expect(studioDraftStatus(3200, null)).toEqual({
      statusLabel: "Writing · 3,200 words",
      currentAction: "Keep writing, then publish when you're ready.",
      progressPercent: 0
    });
    expect(studioDraftStatus(1, 4).statusLabel).toBe("Writing · 1 word");
    expect(studioDraftStatus(30_000, 50_000).progressPercent).toBe(60);
    expect(studioDraftStatus(80_000, 50_000).progressPercent).toBe(100);
  });
});

describe("the readable book payload", () => {
  it("names each page's chapter beside the fields the reader's locator already reads", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(
      projectRecord({
        status: "COMPLETE",
        pages: [
          { id: "page-1", index: 1, chapterId: "chapter-a", title: "One", markdown: "First.", revision: 2 },
          { id: "page-2", index: 2, chapterId: null, title: "Two", markdown: "Second.", revision: 1 }
        ]
      })
    );
    const app = await buildMobileApp();

    const response = await app.inject({ method: "GET", url: "/api/mobile/projects/project-1/book", headers: bearer("token-a") });

    expect(response.statusCode).toBe(200);
    expect(response.json().book.pages).toEqual([
      { id: "page-1", index: 1, chapterId: "chapter-a", title: "One", markdown: "First.", revision: 2 },
      { id: "page-2", index: 2, chapterId: null, title: "Two", markdown: "Second.", revision: 1 }
    ]);
    expect(mockPrisma.project.findFirst.mock.calls[0]![0].select.pages.select).toMatchObject({ chapterId: true });
  });
});
