import { describe, expect, it } from "vitest";
import { manuscriptRequirementId, requirementAssessmentErrors, validRequirementTargets } from "./pictureBookRequirementTargets.js";

const brief = "Compare two solutions and their consequences.";
const pages = [{ index: 1, markdown: "Maya tried the rope first, but it frayed." },
  { index: 2, markdown: "The bridge held firm. Maya compared its steady footing with the fraying rope." }];
const target = { id: "finding-1", requirementId: manuscriptRequirementId(brief, brief), requirementQuote: brief,
  pageIndex: 1, problem: "Only one solution is explained.", acceptanceCriteria: "Compare both solutions and their outcomes.",
  evidence: [{ pageIndex: 1, quote: pages[0]!.markdown }] };
const assessment = { findingId: target.id, resolved: true, noNewRegressions: true, reason: "The later comparison covers both outcomes.",
  evidence: pages.map(p => ({ pageIndex: p.index, quote: p.markdown })) };
const pageMap = new Map(pages.map(p => [p.index, p]));

describe("requirement repair evidence", () => {
  it("binds targets to exact user text and original evidence, and rejects duplicate IDs", () => {
    expect(validRequirementTargets(brief, pages, [target])).toEqual([target]);
    expect(validRequirementTargets(brief, pages, [target, target])).toHaveLength(1);
    expect(validRequirementTargets("A different brief.", pages, [target])).toEqual([]);
    expect(validRequirementTargets(brief, [pages[1]!], [target])).toEqual([]);
    expect(manuscriptRequirementId("A changed brief.", brief)).not.toBe(target.requirementId);
  });

  it("accepts exact evidence across scenes without requiring the fix on the original finding's page", () => {
    expect(requirementAssessmentErrors([target], 1, [assessment], pageMap)).toEqual([]);
    expect(requirementAssessmentErrors([target], 2, undefined, pageMap)).toEqual([]);
  });

  it.each([
    undefined, [], [assessment, assessment], [{ ...assessment, findingId: "invented" }],
    [{ ...assessment, evidence: [] }], [{ ...assessment, evidence: [{ pageIndex: 2, quote: pages[0]!.markdown }] }],
    [{ ...assessment, evidence: [{ pageIndex: 1, quote: "A sentence from the old manuscript." }] }]
  ])("rejects missing, duplicate, invented and stale resolution evidence (%#)", assessments => {
    expect(requirementAssessmentErrors([target], 1, assessments, pageMap).length).toBeGreaterThan(0);
  });

  it("permits an explicit unresolved verdict without pretending there is resolution evidence", () => {
    expect(requirementAssessmentErrors([target], 1, [{ ...assessment, resolved: false, evidence: [] }], pageMap)).toEqual([]);
  });
});
