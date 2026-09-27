import { expect, it } from "vitest";
import { linkContinuityFindings, pictureBookFindingDiagnosis } from "./pictureBookFindingIdentity.js";
import { storyExtractResultSchema, validateStoryExtractEvidence } from "./storyState.js";
import { pageFindingProvenance } from "./manuscriptQualityProvenance.js";
import { pictureBookPageReview, pictureBookReviewRowSchema } from "./pictureBookReviewValidation.js";

const markdown = "Turtle waited by the gate. Then Rabbit found him at the pond.";
const finding = { domain: "prose", category: "continuity", message: "Turtle changes location without a transition.",
  guidance: "Show Turtle walking to the pond.", basis: "page_prose", requirementQuote: null, quote: markdown, relatedEvidence: [] };
const contradiction = "The gate-to-pond transition is missing.";
const extract = storyExtractResultSchema.parse({ storyDelta: {}, contradictions: [contradiction] });

it("carries one local finding ID from grouped review through an unverified continuity diagnostic", () => {
  const review = pictureBookPageReview(pictureBookReviewRowSchema.parse({ pageIndex: 3, score: 90,
    findings: [finding], storyExtract: extract, styleAudit: null, continuityFindingLinks: [{ contradiction, findingIndex: 0 }] }),
  { index: 3, title: "Pond", summary: "", markdown }, { pageModelReview: true, storyExtractAudit: true, styleAuditor: false }, "A story");
  const validated = validateStoryExtractEvidence(review.storyExtract!, { index: 3, markdown }, []);
  expect(validated.unverifiedContradictions).toEqual([contradiction]);
  expect(validated.findingIdsByContradiction?.[contradiction]).toBe(pageFindingProvenance(3, review.report.issues[0]!).findingId);
  expect(review.report.issues[0]).toBe(pictureBookFindingDiagnosis(3, finding));
});

it.each([
  [{ contradiction, findingIndex: 99 }], [{ contradiction: "unrelated concern", findingIndex: 0 }],
  [{ contradiction, findingIndex: 0 }, { contradiction, findingIndex: 0 }], "malformed"
].map(links => ({ links })))("ignores invalid links without discarding review results or buying a repair: %j", ({ links }) => {
  expect(linkContinuityFindings(extract, 3, [finding], links)).toEqual(extract);
});
