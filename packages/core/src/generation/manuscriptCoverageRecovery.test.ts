import { expect, it } from "vitest";
import { refreshManuscriptCoverageFacts, reviewManuscriptCoverage } from "./manuscriptCoverage.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";

const scene = "Make each page a distinct visual scene";
const noArt = "No illustrations, images, or cover artwork";
const page = { index: 12, markdown: "Wise Turtle reached the fork and stood beside Rabbit. Turtle studied the grass along the path." };
const reason = "Turtle later delegates and trusts Rabbit, but the story does not establish a consequential limitation for Turtle that this choice overcomes.";

it("lets the existing verifier correct a scene requirement misclassified as image appearance", async () => {
  const brief = `${scene}. ${noArt}.`;
  const { model, calls } = scriptedDevelopmentModel([{ complete: true, requirements: [
    { kind: "visual", text: scene, quote: scene },
    { kind: "media_absence", text: noArt, quote: noArt, mediaScope: "all" }
  ] }, { complete: true, requirements: [
    { id: "brief-1", assessmentMedium: "prose", status: "fulfilled", reason: "The page stages a distinct action at the fork.", evidence: [{ pageIndex: 12, quote: page.markdown }] },
    { id: "brief-2", status: "unverified", reason: "No export inventory yet.", evidence: [] }
  ] }]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [page], textModel: model });
  expect(result.requirements[0]).toMatchObject({ kind: "content", status: "fulfilled" });
  expect(result.assessmentComplete).toBe(true);
  expect(calls).toHaveLength(2);
  const refreshed = refreshManuscriptCoverageFacts(result, { title: "Story", targetStoryPages: 1,
    storyPageIndexes: [12], illustratedPageIndexes: [], expectedIllustratedPageIndexes: [], characters: [], referenceProvenance: [],
    mediaInventory: { storyPagesWithArtwork: [], coverArtworkCount: 0 } });
  expect(refreshed.status).toBe("reviewed");
});

it("recovers Quick's altered name with one bounded quote check, retaining exact manuscript bytes", async () => {
  const brief = "Let Wise Turtle's patience solve part of the problem.";
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ kind: "content", text: brief, quote: brief }] },
    { complete: true, requirements: [{ id: "brief-1", status: "fulfilled", reason: "Turtle observes the clue.",
      evidence: [{ pageIndex: 12, quote: "Wise Turtle studied the grass along the path." }] }] },
    { corrections: [{ id: "citation-1", supportsSameClaim: true, quote: "Turtle studied the grass along the path." }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [page], textModel: model });
  expect(result.requirements[0]?.status).toBe("fulfilled");
  expect(result.requirements[0]?.evidence).toEqual([{ pageIndex: 12, quote: "Turtle studied the grass along the path." }]);
  expect(calls).toHaveLength(3);
  expect(calls[2]?.textAttemptBudget?.limit).toBe(1);
});

it("keeps Quick's specific arc concern explicitly unverified when the manuscript read is incomplete", async () => {
  const brief = "Show growth for Wise Turtle.";
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ kind: "content", text: brief, quote: brief }] },
    { complete: false, requirements: [{ id: "brief-1", status: "missing", reason,
      evidence: [{ pageIndex: 12, quote: "Wise Turtle reached the fork and stood beside Rabbit." }] }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [page], textModel: model });
  expect(result.requirements[0]).toMatchObject({ status: "unverified", reason: expect.stringContaining(reason) });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "BRIEF_COVERAGE_UNVERIFIED", message: expect.stringContaining(reason) }));
  expect(result.issues.some(issue => issue.code === "MISSING_BRIEF_REQUIREMENT")).toBe(false);
});

it.each(["image", undefined])("keeps actual image appearance unverified with medium %s, even in a no-artwork brief", async (assessmentMedium) => {
  const brief = `Preserve Turtle's portrait likeness. ${noArt}.`;
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ kind: "visual", text: "Preserve Turtle's portrait likeness.", quote: "Preserve Turtle's portrait likeness." }] },
    { complete: true, requirements: [{ id: "brief-1", assessmentMedium, status: "fulfilled", reason: "Turtle is named.", evidence: [{ pageIndex: 12, quote: page.markdown }] }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [page], textModel: model });
  expect(result.requirements[0]).toMatchObject({ kind: "visual", status: "unverified" });
  expect(calls).toHaveLength(2);
});

it("still requires exact prose evidence for a reclassified scene requirement", async () => {
  const { model, calls } = scriptedDevelopmentModel([
    { complete: true, requirements: [{ kind: "visual", text: scene, quote: scene }] },
    { complete: true, requirements: [{ id: "brief-1", assessmentMedium: "prose", status: "fulfilled", reason: "Every page has a scene.", evidence: [] }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief: scene, promises: [], pages: [page], textModel: model });
  expect(result.requirements[0]).toMatchObject({ kind: "content", status: "unverified" });
  expect(calls).toHaveLength(2);
});

it("does not accept an absence claim or a complete assessment when another verdict is omitted", async () => {
  const brief = "Show growth for Turtle and Rabbit.";
  const { model } = scriptedDevelopmentModel([
    { complete: true, requirements: ["Turtle", "Rabbit"].map((name) => ({ kind: "content", text: `Show growth for ${name}.`, quote: brief })) },
    { complete: true, requirements: [{ id: "brief-1", status: "missing", reason, evidence: [] }] }
  ]);
  const result = await reviewManuscriptCoverage({ brief, promises: [], pages: [page], textModel: model });
  expect(result.assessmentComplete).toBe(false);
  expect(result.requirements.map((item) => item.status)).toEqual(["unverified", "unverified"]);
  expect(result.requirements[0]?.reason).toContain(reason);
});
