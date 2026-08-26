import { describe, expect, it } from "vitest";
import { pageReviewPassesFor } from "./pageQualityGateReview.js";

describe("pageReviewPassesFor", () => {
  it("owns the configurable local/model decision used by execution and progress", () => {
    const quality = { enabled: (feature: string) => feature === "pageModelReview" };

    expect(pageReviewPassesFor({ quality })).toEqual({
      localEnabled: false,
      modelEnabled: true,
      anyConfiguredPassEnabled: true
    });
    expect(pageReviewPassesFor({ quality, allowModelReview: false })).toEqual({
      localEnabled: false,
      modelEnabled: false,
      anyConfiguredPassEnabled: false
    });
    expect(pageReviewPassesFor({ quality: { enabled: () => false } })).toEqual({
      localEnabled: false,
      modelEnabled: false,
      anyConfiguredPassEnabled: false
    });
  });
});
