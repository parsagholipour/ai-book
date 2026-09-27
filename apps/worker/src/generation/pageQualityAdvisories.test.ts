import { describe, expect, it } from "vitest";
import { pageQualityAdvisoryIssues } from "./pageQualityAdvisories.js";
import { groupManuscriptQualityFindings, pageFindingProvenance } from "@book-maker/core";
describe("page quality evidence advisories", () => {
  it("keeps unavailable findings as deduplicated warnings on exact pages", () => {
    const qualityReport = { approved: true, score: 95, qualityAdvisories: [
      { check: "story_continuity", status: "unverified", message: "The paid marker conflicts with the final lantern." },
      { check: "story_continuity", status: "unverified", message: "The paid marker conflicts with the final lantern." }
    ] };
    const issues = pageQualityAdvisoryIssues([{ index: 24, qualityReport }, { index: 20, qualityReport }, { index: 18, qualityReport: {} }]);
    expect(issues).toEqual([expect.objectContaining({ code: "STORY_CONTINUITY_UNVERIFIED", severity: "warning", affectedPageIndexes: [20, 24] })]);
  });
  it("does not carry an old advisory after the current keeper has none", () => {
    expect(pageQualityAdvisoryIssues([{ index: 20, qualityReport: { approved: true, score: 95 } }])).toEqual([]);
  });
  it("groups an explicitly linked continuity advisory with its prose finding, preserving both diagnostics", () => {
    const provenance = pageFindingProvenance(3, "A location transition is missing.");
    const advisory = pageQualityAdvisoryIssues([{ index: 3, qualityReport: { approved: false, score: 90, qualityAdvisories: [
      { check: "story_continuity", status: "unverified", message: "Turtle's location is inconsistent.", findingId: provenance.findingId }
    ] } }]);
    const prose = { code: "WHOLE_BOOK_REVIEW", severity: "warning" as const, source: "model" as const,
      message: "A location transition is missing.", guidance: "Add a transition.", affectedPageIndexes: [3], provenance };
    expect(groupManuscriptQualityFindings([prose, ...advisory])).toEqual([expect.objectContaining({ issueIndexes: [0, 1] })]);
  });
});
