import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());
vi.mock("../queue.js", async () => (await import("./testing/mobileApiMocks.js")).queueModuleMock());
vi.mock("../projectStatus.js", async () => (await import("./testing/mobileApiMocks.js")).projectStatusModuleMock());

import { isImportedManuscript, loadConfig } from "@book-maker/core";
import {
  serializeProjectDetail as serializeProjectDetailFromFacade,
  serializeProjectSummary as serializeProjectSummaryFromFacade
} from "./projectSerializers.js";
import {
  projectSourceFromMediaSettings,
  serializeProjectDetail,
  serializeProjectSummary
} from "./projectSummarySerializers.js";
import {
  approvedPlanRecord,
  mockPrisma,
  projectRecord,
  resetMobileHarness
} from "./testing/mobileApiHarness.js";

beforeEach(resetMobileHarness);

/**
 * `mediaSettings.mobile.import` records that a book is a manuscript the reader
 * brought in. Two things read it: the label the app shows on the book, and
 * whether the generation pipeline is allowed to rewrite the author's own
 * opening sentence (`isImportedManuscript`, packages/core/.../schemas/mediaSettings.ts).
 * They were two character-identical expressions in two workspaces.
 */
describe("projectSourceFromMediaSettings", () => {
  const cases: Array<{ label: string; mediaSettings: unknown }> = [
    { label: "an imported manuscript", mediaSettings: { mobile: { import: { importId: "imp_1", format: "docx" } } } },
    { label: "a generated book", mediaSettings: { mobile: { bookType: "custom" } } },
    { label: "an empty import record", mediaSettings: { mobile: { import: {} } } },
    { label: "a non-object import", mediaSettings: { mobile: { import: "imp_1" } } },
    { label: "a non-object mobile", mediaSettings: { mobile: "imported" } },
    { label: "no mobile record at all", mediaSettings: { includeCover: true } },
    { label: "null mediaSettings", mediaSettings: null },
    { label: "undefined mediaSettings", mediaSettings: undefined }
  ];

  it("labels the book with core's imported-manuscript predicate, not a copy of it", () => {
    for (const { label, mediaSettings } of cases) {
      expect(projectSourceFromMediaSettings(mediaSettings), label).toBe(
        isImportedManuscript(mediaSettings) ? "imported" : "generated"
      );
    }
  });

  it("still answers the two labels the app renders", () => {
    expect(projectSourceFromMediaSettings({ mobile: { import: { importId: "imp_1" } } })).toBe("imported");
    expect(projectSourceFromMediaSettings({ mobile: { import: {} } })).toBe("generated");
    expect(projectSourceFromMediaSettings({})).toBe("generated");
  });
});

describe("summary/detail serializer parity", () => {
  const summaryKeys = [
    "authorName", "bookType", "coverArtSource", "coverEnabled", "coverImage", "createdAt", "currentAction", "exports",
    "hasPlan", "id", "illustrationsEnabled", "imageCount", "imagesEnabled", "lengthPreset", "pageCount", "progressPercent",
    "promptPreview", "qualityPreset", "revisedFrom", "source", "status", "statusLabel", "subtitle", "targetPages",
    "title", "updatedAt"
  ];

  it("keeps the compatibility façade and owning summary seam byte-for-byte equivalent", async () => {
    const record = projectRecord({
      id: "project-summary",
      title: "Imported Field Notes",
      status: "GENERATING",
      contentRevision: 4,
      currentPlanId: "plan-1",
      _count: { pages: 3, images: 2, jobs: 1 },
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "business",
        finalReview: true,
        toneProfile: "neutral",
        mobile: {
          bookType: "lead_magnet",
          lengthPreset: "short",
          qualityPreset: "balanced",
          import: { importId: "import-1", format: "docx" },
          revisionSource: "project_chat_book_replan",
          revisionOfProjectId: "project-original",
          revisionRequest: " Tighten the examples ",
          revisionTargetLanguage: "en"
        }
      }
    });
    const appConfig = loadConfig();

    const owned = await serializeProjectSummary(record as never, appConfig, "user-a");
    const facade = await serializeProjectSummaryFromFacade(record as never, appConfig, "user-a");

    expect(serializeProjectSummaryFromFacade).toBe(serializeProjectSummary);
    expect(facade).toEqual(owned);
    expect(Object.keys(owned).sort()).toEqual(summaryKeys);
    expect(owned).toMatchObject({
      id: "project-summary",
      source: "imported",
      revisedFrom: { projectId: "project-original", request: "Tighten the examples", targetLanguage: "en" },
      status: "generating",
      progressPercent: 35,
      hasPlan: true,
      pageCount: 3,
      imageCount: 2
    });
  });

  it("keeps detail composition, page artifacts, plan data, and quality loading in parity", async () => {
    mockPrisma.generationJob.findFirst.mockResolvedValue({
      qualityReport: { state: "review_recommended", score: 91, issues: [], affectedPageIndexes: [1] }
    });
    const record = projectRecord({
      id: "project-detail",
      title: "Detailed Guide",
      status: "COMPLETE",
      contentRevision: 2,
      currentPlanId: "plan-1",
      currentPlan: approvedPlanRecord({ projectId: "project-detail" }),
      pages: [{
        id: "page-1",
        projectId: "project-detail",
        index: 1,
        title: "Start here",
        markdown: "## Start here\n\nShip the smallest useful version.",
        summary: "Start with a useful result.",
        status: "COMPLETED",
        imageFailureReason: null,
        images: [{
          id: "image-1",
          projectId: "project-detail",
          pageId: "page-1",
          type: "ILLUSTRATION",
          path: "/assets/images/project-detail/page-1.webp",
          metadata: { mimeType: "image/webp", provider: "hidden" }
        }]
      }],
      _count: { pages: 1, images: 1, jobs: 1 }
    });
    const appConfig = loadConfig();

    const owned = await serializeProjectDetail(record as never, appConfig, "user-a");
    const facade = await serializeProjectDetailFromFacade(record as never, appConfig, "user-a");

    expect(serializeProjectDetailFromFacade).toBe(serializeProjectDetail);
    expect(facade).toEqual(owned);
    expect(Object.keys(owned).sort()).toEqual([...summaryKeys, "language", "pages", "plan", "prompt", "quality"].sort());
    expect(Object.keys(owned.pages[0]!).sort()).toEqual([
      "id", "image", "imageFailed", "index", "previewText", "status", "summary", "title"
    ]);
    expect(owned.pages[0]).toMatchObject({
      status: "completed",
      imageFailed: false,
      image: { role: "page_visual", contentType: "image/webp" }
    });
    expect(mockPrisma.generationJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownsQualityVerdict: true }) })
    );
  });
});
