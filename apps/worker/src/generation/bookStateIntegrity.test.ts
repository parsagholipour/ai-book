import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageMapIntegrityUnresolvedError, PRODUCTION_MAP_REPAIR_CYCLE_LIMIT } from "@book-maker/core";
import { StopRequestedError } from "../runtime/jobTypes.js";
import { PRODUCTION_MAP_INTEGRITY_ENV } from "./productionMapIntegrity.js";
import { prepareChapterSetups } from "./bookState.js";

const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn()
  },
  loadQualityContext: vi.fn(),
  critiquePageMap: vi.fn(),
  dedupePageBeats: vi.fn(),
  updateJobProgress: vi.fn()
}));

vi.mock("@book-maker/db", async () => ({
  prisma: mocks.prisma,
  Prisma: {},
  ...(await import("../testing/dbScopeMocks.js")).dbScopeMocks()
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  updateJobProgress: mocks.updateJobProgress
}));
vi.mock("./qualitySettings.js", () => ({
  loadQualityContext: mocks.loadQualityContext,
  applyPlanThinkingBoost: vi.fn()
}));
vi.mock("@book-maker/core", async () => {
  const actual = await vi.importActual<typeof import("@book-maker/core")>("@book-maker/core");
  return {
    ...actual,
    critiquePageMap: mocks.critiquePageMap,
    dedupePageBeats: mocks.dedupePageBeats
  };
});

function emptyPatch() {
  return { beatPatches: [], duplicatePurposeWarnings: [], missingEndingPressure: [], unscheduledPromises: [] };
}

function distinctPatch(pageIndexes: number[]) {
  return {
    beatPatches: pageIndexes.map((pageIndex) => ({
      pageIndex,
      purpose: `Name a distinct kiln${pageIndex} ledger assignment for the repaired page`,
      beat: `Show wharf${pageIndex} crate${pageIndex} tariff${pageIndex} clerk${pageIndex} barrel${pageIndex} skipper${pageIndex} tide${pageIndex} lantern${pageIndex} rope${pageIndex}.`,
      endingPressure: "Carry a concrete consequence into the next page."
    })),
    duplicatePurposeWarnings: [],
    missingEndingPressure: [],
    unscheduledPromises: []
  };
}

function pressurePage(pageIndex: number, chapterIndex: number) {
  return {
    pageIndex,
    chapterIndex,
    purpose: `Assign kiln${pageIndex} ledger${pageIndex} quay${pageIndex}`,
    beat:
      `Show wharf${pageIndex} crate${pageIndex} tariff${pageIndex} clerk${pageIndex} barrel${pageIndex} ` +
      `skipper${pageIndex} tide${pageIndex} signal${pageIndex} lantern${pageIndex} rope${pageIndex}.`,
    requiredContinuity: [],
    endingPressure: "Carry a concrete consequence into the next page."
  };
}

function thirtySparseCollisionBriefs() {
  const collisionCount = 30;
  const perChapter = 5;
  const briefs = Array.from({ length: collisionCount + 1 }, (_, offset) => {
    const chapterIndex = offset + 1;
    const start = offset * perChapter + 1;
    return {
      chapterIndex,
      title: `Chapter ${chapterIndex}`,
      summary: `Summary ${chapterIndex}.`,
      continuityFocus: [] as string[],
      pages: Array.from({ length: perChapter }, (_, pageOffset) => pressurePage(start + pageOffset, chapterIndex))
    };
  });
  const source = briefs[0]!.pages[1]!;
  for (const brief of briefs.slice(1)) {
    const last = brief.pages[perChapter - 1]!;
    last.purpose = source.purpose;
    last.beat = source.beat;
  }
  return briefs;
}

function genericChapterBrief(chapterIndex: number, startPage: number, pageCount: number) {
  return {
    chapterIndex,
    title: `Chapter ${chapterIndex}`,
    summary: "A generic production chapter.",
    continuityFocus: [] as string[],
    pages: Array.from({ length: pageCount }, (_, offset) => {
      const pageIndex = startPage + offset;
      return {
        pageIndex,
        chapterIndex,
        purpose: `Advance the chapter on page ${pageIndex}.`,
        beat: `Advance the chapter with a concrete, non-repetitive beat on page ${pageIndex}.`,
        requiredContinuity: [],
        endingPressure: "Leave a concrete reason for the next page to continue."
      };
    })
  };
}

function distinctChapterBrief(chapterIndex: number, startPage: number, pageCount: number) {
  return {
    chapterIndex,
    title: `Chapter ${chapterIndex}`,
    summary: `Distinct work for chapter ${chapterIndex}.`,
    continuityFocus: [] as string[],
    pages: Array.from({ length: pageCount }, (_, offset) => pressurePage(startPage + offset, chapterIndex))
  };
}

function sparseFivePageCollisionBriefs() {
  const brief = distinctChapterBrief(1, 1, 5);
  const source = brief.pages[1]!;
  brief.pages[4]!.purpose = source.purpose;
  brief.pages[4]!.beat = source.beat;
  return [brief];
}

function planForBriefs(briefs: ReturnType<typeof thirtySparseCollisionBriefs>) {
  const lastPage = Math.max(...briefs.flatMap((brief) => brief.pages.map((page) => page.pageIndex)));
  return {
    targetPages: lastPage,
    plan: {
      chapters: briefs.map((brief) => ({
        index: brief.chapterIndex,
        title: brief.title,
        summary: brief.summary,
        targetPages: brief.pages.length
      })),
      promises: ["A promise."]
    }
  };
}

function unfingerprintableBriefs() {
  const briefs = sparseFivePageCollisionBriefs();
  Object.defineProperty(briefs[0]!.pages[0]!, "purpose", {
    get() {
      throw new TypeError("a brief page the detector cannot fingerprint");
    }
  });
  return briefs;
}

describe("prepareChapterSetups production-map integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateJobProgress.mockReset();
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "balanced",
      enabled: () => false
    });
    mocks.dedupePageBeats.mockImplementation(async ({ findings }: { findings: Array<{ pageIndex: number }> }) =>
      distinctPatch(findings.map((finding) => finding.pageIndex))
    );
  });

  afterEach(() => {
    delete process.env[PRODUCTION_MAP_INTEGRITY_ENV];
  });

  const run = (
    briefs: unknown[],
    extra?: { strategy?: Record<string, unknown>; targetPages?: number; plan?: unknown }
  ) => {
    const derived = planForBriefs(briefs as ReturnType<typeof thirtySparseCollisionBriefs>);
    return prepareChapterSetups({
      input: { targetPages: extra?.targetPages ?? derived.targetPages } as never,
      plan: (extra?.plan ?? derived.plan) as never,
      providers: { text: { model: "test" } } as never,
      strategy: {
        createChapterBriefs: async () => briefs,
        generateChapterBrief: async () => {
          throw new Error("generateChapterBrief should not run on this path");
        },
        ...extra?.strategy
      } as never
    });
  };

  it("processes thirty sparse findings across several rewrite calls", async () => {
    const briefs = thirtySparseCollisionBriefs();
    await run(briefs);

    expect(mocks.dedupePageBeats).toHaveBeenCalledTimes(3);
    expect(mocks.dedupePageBeats.mock.calls.map((call) => call[0].findings.length)).toEqual([12, 12, 6]);
    expect(mocks.dedupePageBeats.mock.calls[0]?.[0].providerCallMetadata).toEqual({
      productionMapRepairCycle: 1,
      productionMapRepairBatch: 1,
      productionMapRepairFindingCount: 12,
      productionMapRepairKind: "sparse-page-patch"
    });
    expect(mocks.dedupePageBeats.mock.calls[0]?.[0].findings.length).toBeLessThanOrEqual(12);
  });

  it("regenerates a densely generic chapter instead of patching page by page", async () => {
    const chapterOne = distinctChapterBrief(1, 1, 4);
    const chapterTwo = genericChapterBrief(2, 5, 4);
    const regenerated = distinctChapterBrief(2, 5, 4);
    const generateChapterBrief = vi.fn(async ({ chapter }: { chapter: { index: number } }) => {
      if (chapter.index !== 2) {
        throw new Error(`unexpected chapter ${chapter.index}`);
      }
      return regenerated;
    });

    const setups = await run([chapterOne, chapterTwo], { strategy: { generateChapterBrief } });

    expect(generateChapterBrief).toHaveBeenCalledTimes(1);
    expect(mocks.dedupePageBeats).not.toHaveBeenCalled();
    expect(setups[0]?.brief).toEqual(chapterOne);
    expect(setups[1]?.brief).toEqual(regenerated);
  });

  it("fails two unsuccessful repair cycles before returning a dirty map", async () => {
    mocks.dedupePageBeats.mockResolvedValue(emptyPatch());
    const briefs = sparseFivePageCollisionBriefs();

    await expect(run(briefs)).rejects.toMatchObject({
      code: "PAGE_MAP_INTEGRITY_UNRESOLVED",
      cycleCount: PRODUCTION_MAP_REPAIR_CYCLE_LIMIT
    });
    expect(mocks.dedupePageBeats).toHaveBeenCalledTimes(2);
  });

  it("exits on a stop request during a later batch", async () => {
    const briefs = thirtySparseCollisionBriefs().slice(0, 14);
    const stop = new StopRequestedError();
    let calls = 0;
    mocks.dedupePageBeats.mockImplementation(async ({ findings }: { findings: Array<{ pageIndex: number }> }) => {
      calls += 1;
      if (calls >= 2) {
        throw stop;
      }
      return distinctPatch(findings.map((finding) => finding.pageIndex));
    });

    await expect(run(briefs)).rejects.toBe(stop);
    expect(mocks.dedupePageBeats).toHaveBeenCalledTimes(2);
  });

  it("still buys the repair when the progress line announcing it cannot be written", async () => {
    const briefs = sparseFivePageCollisionBriefs();
    mocks.updateJobProgress.mockImplementation(async (_id: unknown, update: { message?: string }) => {
      if (update.message?.startsWith("Repairing")) {
        throw new Error("no GenerationJob row left to write to");
      }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await run(briefs);

    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Production-map integrity progress message skipped"
    );
    expect(mocks.dedupePageBeats).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not degrade a failed integrity detector to a clean map", async () => {
    const briefs = unfingerprintableBriefs();

    await expect(run(briefs)).rejects.toThrow(/cannot fingerprint/);
    expect(mocks.dedupePageBeats).not.toHaveBeenCalled();
  });

  it("makes no dedup repair call for a clean map", async () => {
    const briefs = [distinctChapterBrief(1, 1, 4)];
    await run(briefs);

    expect(mocks.dedupePageBeats).not.toHaveBeenCalled();
  });

  it("enforces integrity even when the beatDedup quality flag is off", async () => {
    mocks.loadQualityContext.mockResolvedValue({
      settings: {},
      tier: "fast",
      enabled: () => false
    });
    const briefs = sparseFivePageCollisionBriefs();
    await run(briefs);
    expect(mocks.dedupePageBeats).toHaveBeenCalledTimes(1);
  });

  it("runs integrity on the per-chapter fan-out path", async () => {
    const briefs = sparseFivePageCollisionBriefs();
    const generateChapterBrief = vi.fn(async () => briefs[0]!);
    await prepareChapterSetups({
      input: { targetPages: 5 } as never,
      plan: {
        chapters: [{ index: 1, title: "One", summary: "Opening.", targetPages: 5 }],
        promises: []
      } as never,
      providers: { text: { model: "test" } } as never,
      strategy: { generateChapterBrief } as never
    });
    expect(generateChapterBrief).toHaveBeenCalledTimes(1);
    expect(mocks.dedupePageBeats).toHaveBeenCalledTimes(1);
  });

  it("rethrows a user stop instead of degrading a failed rewrite", async () => {
    const stop = new StopRequestedError();
    mocks.dedupePageBeats.mockRejectedValue(stop);
    await expect(run(sparseFivePageCollisionBriefs())).rejects.toBe(stop);
  });

  it("falls back to dense chapter regeneration when a sparse rewrite throws", async () => {
    mocks.dedupePageBeats.mockRejectedValue(new Error("provider down"));
    const regenerated = distinctChapterBrief(1, 1, 5);
    const generateChapterBrief = vi.fn(async () => regenerated);
    const setups = await run(sparseFivePageCollisionBriefs(), { strategy: { generateChapterBrief } });
    expect(generateChapterBrief).toHaveBeenCalledTimes(1);
    expect(setups[0]?.brief).toEqual(regenerated);
  });

  it("records would_block in shadow mode instead of throwing", async () => {
    process.env[PRODUCTION_MAP_INTEGRITY_ENV] = "shadow";
    mocks.dedupePageBeats.mockResolvedValue(emptyPatch());
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const briefs = sparseFivePageCollisionBriefs();

    const setups = await run(briefs);

    expect(setups[0]?.brief).toEqual(briefs[0]);
    expect(info.mock.calls.map((call) => String(call[0])).join("\n")).toContain("would_block");
    info.mockRestore();
  });
});

describe("PageMapIntegrityUnresolvedError", () => {
  it("is a typed integrity failure with finding structure", () => {
    expect(new PageMapIntegrityUnresolvedError(2, {
      version: "production-map-audit-v1",
      blocking: true,
      findings: [
        {
          code: "NEAR_DUPLICATE_BEAT",
          chapterIndexes: [1],
          pageIndexes: [5],
          evidence: "overlap"
        }
      ],
      chapterClassifications: [],
      sparseFindings: [],
      denseChapterIndexes: []
    })).toMatchObject({
      code: "PAGE_MAP_INTEGRITY_UNRESOLVED",
      cycleCount: 2,
      findingCodes: ["NEAR_DUPLICATE_BEAT"],
      affectedPageIndexes: [5],
      affectedChapterIndexes: [1]
    });
  });
});
