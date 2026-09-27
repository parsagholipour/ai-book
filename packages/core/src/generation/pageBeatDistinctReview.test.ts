import { expect, it } from "vitest";
import type { ChapterBrief } from "../schemas/book.js";
import { dedupePageBeats, findDuplicatePageBeats } from "./pageBeatDedup.js";
import { beatRewritePatchSchema, groundedDistinctBeatPairs } from "./pageBeatDistinctReview.js";
import { auditProductionMap, productionMapContractFromRanges, sparseRewriteFindingsFromAudit } from "./productionMapAudit.js";
import { mergePageMapCriticPatch } from "./pageMapCritic.js";
import { capturingJsonModel, chainedBriefs, saturatedBriefs } from "./testing/pageBeatDedupFixtures.js";
import capturedMap from "./testing/premiumBridgeMap2124.json" with { type: "json" };
import capturedRewrite from "./testing/premiumBridgeRepair2124.json" with { type: "json" };

function bridgeBriefs(): ChapterBrief[] {
  return capturedMap.chapters.map((chapter, i) => ({
    chapterIndex: i + 1, title: chapter.title, summary: chapter.summary, continuityFocus: [],
    pages: capturedMap.pages.filter(page => page.pageIndex > (capturedMap.chapters[i - 1]?.endPage ?? 0)
      && page.pageIndex <= chapter.endPage).map(page => ({ ...page, chapterIndex: i + 1 }))
  }));
}

function contractFor(briefs: ChapterBrief[]) {
  return productionMapContractFromRanges(briefs.flatMap(brief => brief.pages).length,
    briefs.map(brief => ({ chapterIndex: brief.chapterIndex,
      startPage: brief.pages[0]!.pageIndex, endPage: brief.pages.at(-1)!.pageIndex })));
}

function decision(briefs = bridgeBriefs(), pageIndex = 23, duplicateOfPageIndex = 2) {
  return {
    pageIndex, duplicateOfPageIndex,
    reason: "The earlier scene establishes the marker; the later scene restores it after displacement and recovery.",
    evidence: [duplicateOfPageIndex, pageIndex].map(index => ({
      pageIndex: index, quote: briefs.flatMap(brief => brief.pages).find(page => page.pageIndex === index)!.beat
    }))
  };
}

async function review(briefs: ChapterBrief[], response: unknown, enabled = true) {
  const audit = await auditProductionMap(briefs, contractFor(briefs), { reviewNearDuplicates: true });
  const findings = sparseRewriteFindingsFromAudit(audit, briefs);
  const capture = capturingJsonModel(response);
  const patch = await dedupePageBeats({ textModel: capture.model, briefs, findings, promises: [],
    lastPageIndex: briefs.flatMap(brief => brief.pages).length,
    ...(enabled ? { reviewablePairs: findings } : {}) });
  const merged = mergePageMapCriticPatch(briefs, patch, 30);
  return { patch, merged, capture, audit: await auditProductionMap(merged, contractFor(briefs), {
    reviewNearDuplicates: true, distinctPairs: patch.distinctPairs ?? []
  }) };
}

it("keeps the captured setup/payoff unchanged with grounded evidence and supplies the intervening story", async () => {
  const briefs = bridgeBriefs();
  const keep = decision(briefs);
  keep.evidence.push(...[5, 22].map(pageIndex => ({ pageIndex,
    quote: capturedMap.pages.find(page => page.pageIndex === pageIndex)!.beat })));
  const result = await review(briefs, { distinctPairs: [keep] });
  expect(result.patch.beatPatches).toEqual([]);
  expect(result.merged).toEqual(briefs);
  expect(result.audit.blocking).toBe(false);
  expect(result.capture.payload?.storyContext).toHaveLength(22);
  expect(result.capture.payload?.storyContext[3].beat).toBe(capturedMap.pages[4]!.beat);
  expect(result.capture.payload?.storyContext[0].pageIndex).toBe(2);
  expect(result.capture.payload?.storyContext.at(-1).pageIndex).toBe(23);
  expect(result.capture.system).toContain("same completed event");
});

it.each(["missing endpoint", "invented quote", "foreign pair", "duplicate decision", "both decisions", "unreviewed"])(
  "does not clear a lexical finding for %s", async scenario => {
    const keep = decision();
    const response = { distinctPairs: [keep], beatPatches: [] as typeof capturedRewrite.beatPatches };
    if (scenario === "missing endpoint") keep.evidence[0] = { pageIndex: 5, quote: capturedMap.pages[4]!.beat };
    if (scenario === "invented quote") keep.evidence[0]!.quote = "The bridge lantern was never here.";
    if (scenario === "foreign pair") keep.duplicateOfPageIndex = 3;
    if (scenario === "duplicate decision") response.distinctPairs.push(keep);
    if (scenario === "both decisions") response.beatPatches = capturedRewrite.beatPatches;
    const result = await review(bridgeBriefs(), response, scenario !== "unreviewed");
    expect(result.patch.distinctPairs ?? []).toEqual([]);
    expect(result.audit.blocking).toBe(true);
  }
);

it("accepts the captured rewrite for reaudit instead of silently dropping it for shared vocabulary", async () => {
  const result = await review(bridgeBriefs(), capturedRewrite);
  const page = result.merged.flatMap(brief => brief.pages).find(page => page.pageIndex === 23)!;
  expect(page.beat).toBe(capturedRewrite.beatPatches[0]!.beat);
  // Acceptance of a rewrite alone is not a semantic exemption from the mandatory reaudit.
  expect(result.audit.blocking).toBe(true);
  expect(result.audit.findings.some(finding => finding.code === "NEAR_DUPLICATE_BEAT")).toBe(true);
});

it("rewrites a confirmed duplicate and then audits the resulting map", async () => {
  const briefs = bridgeBriefs();
  briefs[3]!.pages[2]!.purpose = "Establish the bridge marker again";
  briefs[3]!.pages[2]!.beat = "At the bridge Rabbit skips ahead while Wise Turtle checks its lantern on the far-side post.";
  const rewrite = {
    pageIndex: 23, purpose: "Inspect the bridge foundations for storm damage",
    beat: "An otter dives beneath the wooden arch and plugs a leaking joint with clay.",
    requiredContinuity: ["The repaired joint holds water back."],
    endingPressure: "Fresh footprints lead toward the clearing."
  };
  const result = await review(briefs, { beatPatches: [rewrite] });
  expect(result.merged.flatMap(brief => brief.pages).find(page => page.pageIndex === 23)?.beat).toBe(rewrite.beat);
  expect(result.audit.blocking).toBe(false);
});

it.each(["endpoint", "intervening state", "missing page"])("invalidates a decision after changing %s", async change => {
  const briefs = bridgeBriefs();
  const result = await review(briefs, { distinctPairs: [decision(briefs)] });
  const changed = structuredClone(result.merged);
  if (change === "endpoint") changed[3]!.pages[2]!.beat += " Rabbit nods.";
  if (change === "intervening state") changed[0]!.pages[4]!.beat = "The storm passes without moving a single lantern.";
  if (change === "missing page") changed[0]!.pages.splice(4, 1);
  const audit = await auditProductionMap(changed, contractFor(briefs), { distinctPairs: result.patch.distinctPairs ?? [] });
  expect(audit.blocking).toBe(true);
  expect(audit.findings.some(finding => finding.code === "NEAR_DUPLICATE_BEAT")).toBe(true);
});

it("keeps exact duplicates blocking even if a reviewer claims they differ", async () => {
  const briefs = bridgeBriefs();
  const first = briefs[0]!.pages[1]!, last = briefs[3]!.pages[2]!;
  last.purpose = first.purpose;
  last.beat = first.beat;
  const result = await review(briefs, { distinctPairs: [decision(briefs)] });
  expect(result.patch.distinctPairs).toEqual([]);
  expect(result.audit.findings.some(finding => finding.code === "DUPLICATE_ASSIGNMENT_FINGERPRINT")).toBe(true);
  expect(result.audit.blocking).toBe(true);
});

it("cannot use a different purpose to excuse a verbatim beat", async () => {
  const briefs = bridgeBriefs();
  briefs[3]!.pages[2]!.beat = briefs[0]!.pages[1]!.beat;
  const result = await review(briefs, { distinctPairs: [decision(briefs)] });
  expect(result.patch.distinctPairs).toEqual([]);
  expect(result.audit.blocking).toBe(true);
});

it("does not let an approved strongest pair mask another near duplicate", async () => {
  const briefs = chainedBriefs();
  const pair = decision(briefs, 3, 2);
  const decisions = beatRewritePatchSchema.parse({ distinctPairs: [pair] }).distinctPairs;
  const distinctPairs = groundedDistinctBeatPairs({ briefs, candidates: [pair], decisions, patchedPageIndexes: [] });
  expect(distinctPairs).toHaveLength(1);
  const audit = await auditProductionMap(briefs, contractFor(briefs), { distinctPairs, reviewNearDuplicates: true });
  expect(audit.findings.some(finding => finding.beatFinding?.pageIndex === 4)).toBe(true);
  // Ignore only page 4's strongest match explicitly; page 2 remains a candidate.
  const findings = await findDuplicatePageBeats(briefs, { rewriteSlotLimit: 0, distinctPairKeys: new Set(["3:4"]) });
  expect(findings.find(finding => finding.pageIndex === 4)?.duplicateOfPageIndex).toBe(2);
});

it("reviews dense lexical candidates before considering chapter regeneration", async () => {
  const briefs = bridgeBriefs();
  const first = briefs[0]!.pages[1]!;
  for (const index of [0, 1]) {
    const page = briefs[3]!.pages[index]!;
    page.purpose = `Restore the bridge marker after change ${index}`;
    page.beat = first.beat + ` Now the helpers notice consequence ${index}.`;
  }
  const audit = await auditProductionMap(briefs, contractFor(briefs), { reviewNearDuplicates: true });
  expect(audit.blocking).toBe(true);
  expect(audit.denseChapterIndexes).toEqual([]);
  expect(audit.chapterClassifications.find(chapter => chapter.chapterIndex === 4)?.classification).toBe("sparse");
  expect(audit.sparseFindings.length).toBeGreaterThan(1);
  const copies = saturatedBriefs();
  expect((await auditProductionMap(copies, contractFor(copies), { reviewNearDuplicates: true })).denseChapterIndexes).toEqual([1]);
});
