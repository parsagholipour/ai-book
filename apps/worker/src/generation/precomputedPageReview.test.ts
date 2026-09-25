import { describe, expect, it } from "vitest";
import { matchingPrecomputedReview, type PrecomputedPageReview } from "./precomputedPageReview.js";
import { pageQualityReportSchema } from "@book-maker/core";

describe("manuscript review snapshot binding", () => {
  const draft = { index: 2, title: "Lantern", markdown: "The lantern waited in the reeds.", summary: "A lantern." };
  const prior = { index: 1, title: "Search", markdown: "Three lanterns were recovered.", summary: "Three lanterns." };
  const review: PrecomputedPageReview = { draftMarkdown: draft.markdown,
    report: pageQualityReportSchema.parse({ approved: true, score: 94 }),
    storyExtract: null, styleAudit: null,
    completedChecks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false }, manuscriptPages: [prior, draft] };
  const options = { draft, previousPages: [prior], quality: { enabled: (feature: string) => feature === "pageModelReview" }, precomputed: review };
  it("reuses a complete review of the same manuscript", () => expect(matchingPrecomputedReview(options)).toBe(review));
  it("refuses a verdict after surrounding prose changes", () => expect(matchingPrecomputedReview({ ...options,
    previousPages: [{ ...prior, markdown: "Every lantern was recovered." }] })).toBeUndefined());
  it("refuses a missing configured check", () => expect(matchingPrecomputedReview({ ...options,
    quality: { enabled: () => true } })).toBeUndefined());
});
