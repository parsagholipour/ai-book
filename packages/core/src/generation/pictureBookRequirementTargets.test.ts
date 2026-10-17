import { describe, expect, it } from "vitest";
import { manuscriptRequirementId, validRequirementTargets } from "./pictureBookRequirementTargets.js";

const brief = "Compare two solutions and their consequences.";
const pages = [{ index: 1, markdown: "Maya tried the rope first, but it frayed." },
  { index: 2, markdown: "The bridge held firm. Maya compared its steady footing with the fraying rope." }];
const target = { id: "finding-1", requirementId: manuscriptRequirementId(brief, brief), requirementQuote: brief,
  pageIndex: 1, problem: "Only one solution is explained.", acceptanceCriteria: "Compare both solutions and their outcomes.",
  evidence: [{ pageIndex: 1, quote: pages[0]!.markdown }] };

describe("requirement repair evidence", () => {
  it("binds targets to exact user text and original evidence, and rejects duplicate IDs", () => {
    expect(validRequirementTargets(brief, pages, [target])).toEqual([target]);
    expect(validRequirementTargets(brief, pages, [target, target])).toHaveLength(1);
    expect(validRequirementTargets("A different brief.", pages, [target])).toEqual([]);
    expect(validRequirementTargets(brief, [pages[1]!], [target])).toEqual([]);
    expect(manuscriptRequirementId("A changed brief.", brief)).not.toBe(target.requirementId);
  });
});
