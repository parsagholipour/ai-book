import { describe, expect, it } from "vitest";
import type { ChapterBrief } from "../schemas/book.js";
import { MAX_BEAT_DEDUP_FINDINGS, findDuplicatePageBeats } from "./pageBeatDedup.js";
import { mergePageMapCriticPatch } from "./pageMapCritic.js";
import {
  PRODUCTION_MAP_DENSE_CORRUPTION_THRESHOLD,
  auditProductionMap,
  chunkFindingsForRewriteCalls,
  classifyChapterCorruption,
  groupSparseFindingsByChapter,
  productionMapContractFromRanges,
  sparseRewriteFindingsFromAudit
} from "./productionMapAudit.js";
import { mechanicsPage } from "./testing/generatedChapterBriefFixtures.js";
import {
  beat,
  blockadeBeat,
  blockadePurpose,
  distinctBriefs,
  saturatedBriefs,
  sparseFivePageCollisionBriefs
} from "./testing/pageBeatDedupFixtures.js";

function contractFor(briefs: ChapterBrief[], targetPages?: number) {
  const pages = briefs.flatMap((brief) => brief.pages);
  const last = targetPages ?? Math.max(...pages.map((page) => page.pageIndex), 0);
  return productionMapContractFromRanges(
    last,
    briefs.map((brief) => {
      const indexes = brief.pages.map((page) => page.pageIndex);
      return {
        chapterIndex: brief.chapterIndex,
        startPage: Math.min(...indexes),
        endPage: Math.max(...indexes)
      };
    })
  );
}

describe("classifyChapterCorruption", () => {
  it("treats 25% as the dense threshold and 20% as sparse", () => {
    expect(PRODUCTION_MAP_DENSE_CORRUPTION_THRESHOLD).toBe(0.25);
    expect(
      classifyChapterCorruption({
        chapterIndex: 1,
        pageCount: 4,
        affectedPageIndexes: [2],
        coverageValid: true
      }).classification
    ).toBe("dense");
    expect(
      classifyChapterCorruption({
        chapterIndex: 1,
        pageCount: 5,
        affectedPageIndexes: [2],
        coverageValid: true
      }).classification
    ).toBe("sparse");
  });

  it("regenerates when the unrewritable opening page is affected", () => {
    expect(
      classifyChapterCorruption({
        chapterIndex: 1,
        pageCount: 10,
        affectedPageIndexes: [1],
        coverageValid: true
      }).classification
    ).toBe("dense");
  });

  it("regenerates when coverage is invalid even with no assignment collisions", () => {
    expect(
      classifyChapterCorruption({
        chapterIndex: 1,
        pageCount: 5,
        affectedPageIndexes: [],
        coverageValid: false
      }).classification
    ).toBe("dense");
  });
});

describe("auditProductionMap", () => {
  it("returns more than twelve findings when the map contains them, with evidence past the rewrite cap", async () => {
    const briefs = saturatedBriefs();
    const audit = await auditProductionMap(briefs, contractFor(briefs, 16));
    const nearDuplicates = audit.findings.filter((finding) => finding.code === "NEAR_DUPLICATE_BEAT");

    expect(nearDuplicates.length).toBeGreaterThan(MAX_BEAT_DEDUP_FINDINGS);
    const thirteenth = nearDuplicates[MAX_BEAT_DEDUP_FINDINGS];
    expect(thirteenth?.pageIndexes[0]).toBe(15);
    expect(thirteenth?.evidence.length).toBeGreaterThan(0);
    expect(thirteenth?.beatFinding).toMatchObject({
      pageIndex: 15,
      duplicateOfPageIndex: 2
    });
    expect(audit.chapterClassifications.find((entry) => entry.chapterIndex === 1)?.classification).toBe("dense");
  });

  it("keeps detection independent of the per-call rewrite slot cap", async () => {
    const briefs = saturatedBriefs();
    const uncapped = await findDuplicatePageBeats(briefs, { rewriteSlotLimit: 0 });
    const defaultCapped = await findDuplicatePageBeats(briefs);
    expect(uncapped.length).toBe(defaultCapped.length);
    expect(uncapped.length).toBeGreaterThan(MAX_BEAT_DEDUP_FINDINGS);
    expect(uncapped[MAX_BEAT_DEDUP_FINDINGS]).toMatchObject({
      pageIndex: 15,
      duplicateOfPageIndex: 2
    });
  });

  it("groups sparse findings deterministically by chapter then page", async () => {
    const briefs: ChapterBrief[] = [
      {
        chapterIndex: 1,
        title: "One",
        summary: "Opening.",
        continuityFocus: [],
        pages: [
          beat(1, 1, "Open inside the July crisis", "A telegram reaches Berlin while the fleet is already coaling."),
          beat(2, 1, blockadePurpose, blockadeBeat),
          beat(3, 1, "Follow one U-boat patrol", "A single submarine crew hunts a convoy through fog off the Irish coast."),
          beat(4, 1, "Show the turnip winter", "Rationing collapses into the turnip winter of 1916-17 in German cities."),
          beat(5, 1, blockadePurpose, blockadeBeat)
        ]
      },
      {
        chapterIndex: 2,
        title: "Two",
        summary: "Home fronts.",
        continuityFocus: [],
        pages: [
          beat(6, 2, "Trace one family's ration book through a single week", "A Hamburg widow queues before dawn for turnips."),
          beat(7, 2, "Count what the neutral shipping lines lost", "Norwegian masters lay their steamers up in port."),
          beat(8, 2, "Name the ore shortage in the Ruhr", "Factories cut output as coke deliveries stall."),
          beat(9, 2, "Follow a single coal convoy inland", "A barge waits at the lock while the river freezes."),
          beat(10, 2, blockadePurpose, blockadeBeat)
        ]
      }
    ];
    const audit = await auditProductionMap(briefs, contractFor(briefs, 10));
    expect(audit.denseChapterIndexes).toEqual([]);
    const grouped = groupSparseFindingsByChapter(audit.sparseFindings);
    expect(grouped.map((group) => group.chapterIndex)).toEqual([1, 2]);
    expect(grouped[0]?.findings[0]?.pageIndexes[0]).toBe(5);
    expect(grouped[1]?.findings[0]?.pageIndexes[0]).toBe(10);
    const rewrite = sparseRewriteFindingsFromAudit(audit, briefs);
    expect(rewrite.map((finding) => finding.pageIndex)).toEqual([5, 10]);
  });

  it("classifies a five-page chapter with one collision as sparse", async () => {
    const briefs = sparseFivePageCollisionBriefs();
    const audit = await auditProductionMap(briefs, contractFor(briefs, 5));
    expect(audit.chapterClassifications).toEqual([
      expect.objectContaining({
        chapterIndex: 1,
        pageCount: 5,
        affectedPageCount: 1,
        affectedRatio: 0.2,
        classification: "sparse"
      })
    ]);
    expect(audit.denseChapterIndexes).toEqual([]);
  });

  it("flags whole-book generic templates that never passed the chapter-brief decoder", async () => {
    const briefs: ChapterBrief[] = [
      {
        chapterIndex: 1,
        title: "One",
        summary: "Opening.",
        continuityFocus: [],
        pages: [1, 2, 3, 4].map((pageIndex) =>
          beat(
            pageIndex,
            1,
            `Advance the chapter on page ${pageIndex}.`,
            `Advance the chapter with a concrete, non-repetitive beat on page ${pageIndex}.`
          )
        )
      }
    ];
    const audit = await auditProductionMap(briefs, contractFor(briefs, 4));
    expect(audit.findings.some((finding) => finding.code === "GENERIC_ASSIGNMENT")).toBe(true);
    expect(audit.denseChapterIndexes).toEqual([1]);
    expect(audit.blocking).toBe(true);
  });

  it("leaves similar chapter topics with distinct page assignments clean", async () => {
    const briefs: ChapterBrief[] = [
      {
        chapterIndex: 1,
        title: "Forces in Contact",
        summary: "Friction turns contact into a measurable change in motion.",
        continuityFocus: [],
        pages: [mechanicsPage(1, 1), mechanicsPage(2, 1), mechanicsPage(3, 1)]
      },
      {
        chapterIndex: 2,
        title: "Displacement at Sea",
        summary: "A hull's buoyancy is measured independently of the crate trials.",
        continuityFocus: [],
        pages: [
          beat(
            4,
            2,
            "Introduce displacement as the weight of water a hull pushes aside.",
            "A loaded barge settles until the displaced harbour water equals its weight."
          ),
          beat(
            5,
            2,
            "Hold cargo mass constant while the hull's wetted surface changes.",
            "The same crates ride higher once the barge moves from salt water into a river lock."
          ),
          beat(
            6,
            2,
            "Connect the waterline change to the density of the surrounding water.",
            "A marked strake that was wet in the harbour sits dry in the lock, completing the density contrast."
          )
        ]
      }
    ];
    const audit = await auditProductionMap(briefs, contractFor(briefs, 6));
    expect(audit.blocking).toBe(false);
    expect(audit.findings).toEqual([]);
    expect(audit.chapterClassifications.every((entry) => entry.classification === "clean")).toBe(true);
  });

  it("re-audits collisions introduced by a model patch", async () => {
    const briefs = distinctBriefs();
    const source = briefs[0]!.pages[1]!;
    const patched = mergePageMapCriticPatch(
      briefs,
      {
        beatPatches: [
          {
            pageIndex: 4,
            purpose: source.purpose,
            beat: source.beat,
            endingPressure: source.endingPressure
          }
        ],
        duplicatePurposeWarnings: [],
        missingEndingPressure: [],
        unscheduledPromises: []
      },
      4
    );
    const before = await auditProductionMap(briefs, contractFor(briefs, 4));
    const after = await auditProductionMap(patched, contractFor(patched, 4));
    expect(before.blocking).toBe(false);
    expect(after.blocking).toBe(true);
    expect(after.findings.some((finding) => finding.pageIndexes.includes(4))).toBe(true);
  });

  it("chunks rewrite findings into twelve-finding provider calls without dropping the tail", () => {
    const findings = Array.from({ length: 30 }, (_, index) => ({
      pageIndex: index + 2,
      duplicateOfPageIndex: 1,
      earlierText: "earlier",
      reason: "duplicate"
    }));
    const batches = chunkFindingsForRewriteCalls(findings);
    expect(batches.map((batch) => batch.length)).toEqual([12, 12, 6]);
    expect(batches.flat().map((finding) => finding.pageIndex)).toEqual(findings.map((finding) => finding.pageIndex));
  });
});
