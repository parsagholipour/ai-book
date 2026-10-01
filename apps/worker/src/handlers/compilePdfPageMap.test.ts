import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ append: vi.fn(async () => "2026-10-01T00:00:00.000Z") }));
vi.mock("../providers/runLogging.js", () => ({ createRunLogger: () => ({ append: mocks.append }) }));

import { BOOK_PDF_COVER_NUMBERING_KIND, BOOK_PDF_PAGE_MAP_VERSION, type BookPdfPageMap } from "@book-maker/core";
import type { RawWorkerJob } from "../runtime/jobPayloads.js";
import { PDF_PAGE_MAP_FALLBACK_EVENT, pdfPageMapAfterCompileRender } from "./compilePdfPageMap.js";

const job = { id: "1", name: "compile-export", data: { projectId: "p1", generationJobId: "g1" } } as unknown as RawWorkerJob;

describe("pdfPageMapAfterCompileRender", () => {
  afterEach(() => {
    mocks.append.mockClear();
    vi.restoreAllMocks();
  });

  it("persists a measured map and logs nothing", async () => {
    const pageMap: BookPdfPageMap = {
      version: BOOK_PDF_PAGE_MAP_VERSION, totalPdfPages: 3, hasCoverPage: true,
      pages: [{ index: 1, startPdfPage: 2, endPdfPage: 3 }]
    };
    await expect(pdfPageMapAfterCompileRender(job, { pageMap }, { planned: true, hasCoverPage: true })).resolves.toBe(pageMap);
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("records a planned render that could not be measured, with the pages it lost", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persisted = await pdfPageMapAfterCompileRender(
      job,
      { pageMapFailure: { reason: "unanchored-pages", pageIndexes: [20] } },
      { planned: true, hasCoverPage: true }
    );

    expect(persisted).toEqual({ kind: BOOK_PDF_COVER_NUMBERING_KIND, version: BOOK_PDF_PAGE_MAP_VERSION, hasCoverPage: true, pages: [] });
    expect(mocks.append).toHaveBeenCalledWith(PDF_PAGE_MAP_FALLBACK_EVENT, {
      reason: "unanchored-pages", pageIndexes: [20], hasCoverPage: true
    });
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      warning: "pdf_page_map_fallback", projectId: "p1", generationJobId: "g1", pageIndexes: [20]
    }));
  });

  it("records the designed fallback of a render with no anchor plan without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await pdfPageMapAfterCompileRender(job, {}, { planned: false, hasCoverPage: false });

    expect(mocks.append).toHaveBeenCalledWith(PDF_PAGE_MAP_FALLBACK_EVENT, {
      reason: "unplanned-render", pageIndexes: [], hasCoverPage: false
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
