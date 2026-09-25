import { describe, expect, it } from "vitest";
import { pageQualityAdvisoryIssues } from "./pageQualityAdvisories.js";
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
});
