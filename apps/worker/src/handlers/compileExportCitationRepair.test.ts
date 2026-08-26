import { describe, expect, it } from "vitest";
import { failedQaPageIndexesForCompile } from "./compileExportCitationRepair.js";

const page = (issues: string[]) => ({
  index: 2,
  status: "FAILED_QA",
  qualityReport: { approved: false, issues }
});

describe("failedQaPageIndexesForCompile", () => {
  it.each([
    [
      "a mixed source complaint and repetition",
      ["No specific dispatch date or archive is identified.", "The page repeats the explanation from page 1."]
    ],
    [
      "an invented scene",
      ["The page invents an unnamed county magistrate scene that the supplied record does not support."]
    ],
    [
      "a mixed defect in one issue",
      ["No specific dispatch date is identified, and the account contradicts the supplied record."]
    ]
  ])("keeps %s in the compile repair set", (_name, issues) => {
    expect(failedQaPageIndexesForCompile([page(issues)], [])).toEqual([2]);
  });
});
