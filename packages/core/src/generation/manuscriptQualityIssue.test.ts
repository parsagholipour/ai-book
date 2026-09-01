import { describe, expect, it } from "vitest";
import {
  optionalIssueCluster,
  parseManuscriptQualityIssueCluster
} from "./manuscriptQualityIssue.js";

describe("parseManuscriptQualityIssueCluster", () => {
  it("accepts a canonical page with distinct duplicates", () => {
    expect(
      parseManuscriptQualityIssueCluster({
        canonicalPageIndex: 4,
        duplicatePageIndexes: [7, 5, 7]
      })
    ).toEqual({ canonicalPageIndex: 4, duplicatePageIndexes: [5, 7] });
  });

  it("drops a cluster that lists the canonical page as a duplicate or has no duplicates", () => {
    expect(
      parseManuscriptQualityIssueCluster({
        canonicalPageIndex: 4,
        duplicatePageIndexes: [4]
      })
    ).toBeUndefined();
    expect(
      parseManuscriptQualityIssueCluster({
        canonicalPageIndex: 4,
        duplicatePageIndexes: []
      })
    ).toBeUndefined();
    expect(optionalIssueCluster({ canonicalPageIndex: 0, duplicatePageIndexes: [1] })).toEqual({});
  });
});
