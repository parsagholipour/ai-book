import { expect, it } from "vitest";
import { bookPlanSchema, createProjectSchema, FakeTextModelAdapter, type PictureBookPageReview,
  type PictureBookRepairContext } from "@book-maker/core";
import captured from "./testing/repairRecovery2214.json" with { type: "json" };
import live from "./testing/repairAcceptanceLive.json" with { type: "json" };
import { reviewShortBookRepairCandidate, shortBookRepairRejection } from "./compileShortBookRepairReview.js";
import { hasOnlyInheritedEditorialFindings } from "./compileRepairOutcome.js";

async function replay() {
  let calls = 0;
  let sawPreviousReview = false;
  const text = new FakeTextModelAdapter();
  text.generateJson = async request => {
    const payload = JSON.parse(request.messages.find(message => message.role === "user")!.content);
    if (payload.previousEditorialReview) {
      sawPreviousReview = true;
      const changed = live.candidate.pages.filter(page => {
        const old = live.previous.pages.find(previous => previous.index === page.index);
        return !old || old.markdown !== page.markdown || old.title !== page.title;
      }).map(page => page.index);
      expect(payload.previousEditorialReview.changedPageIndexes).toEqual(changed);
    }
    const raw = live.responses[calls++];
    if (!raw) throw new Error("Unexpected extra review");
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "captured", model: "captured" };
  };
  const fixture = captured.premium;
  const options = { input: createProjectSchema.parse(fixture.input), plan: bookPlanSchema.parse(fixture.plan),
    pages: fixture.pages, providers: { text }, strategy: { executionMode: "draft-then-polish", shouldIllustratePage: () => false },
    quality: { enabled: (feature: string) => ["pageLocalQa", "styleExcerpts", "pageModelReview", "storyExtractAudit", "styleAuditor", "smartUnslop"].includes(feature) }
  } as unknown as Parameters<typeof reviewShortBookRepairCandidate>[0];
  const candidate = live.candidate as Parameters<typeof reviewShortBookRepairCandidate>[1];
  const reviews = await reviewShortBookRepairCandidate(options, candidate,
    { pages: live.previous.pages, reviews: live.previousReviews as PictureBookPageReview[] }, text,
    { limit: 5, used: 1, outputWidened: false }, async () => {});
  expect(sawPreviousReview).toBe(true);
  return { calls, reviews, candidate, page: reviews.find(review => review.pageIndex === 29)! };
}

it("retains Premium's verified edits with its exact, unchanged repetition warning still failed QA", async () => {
  const { calls, reviews, candidate, page } = await replay();
  expect(calls).toBe(2);
  expect(page.report.approved).toBe(false);
  expect(page.styleAudit?.styleOk).toBe(false);
  expect(page.styleAudit?.unverifiedStyleIssues).toEqual([]);
  expect(page.report.issues.join(" ")).toMatch(/shadow-game|slowing/i);
  expect(candidate.context.changes.map(change => change.pageIndex)).toEqual([2, 3, 14]);
  expect(shortBookRepairRejection(candidate.context, reviews)).toBeUndefined();
});

it.each(["changed_page", "targeted_page", "linked_edit", "unmatched_style", "invented_quote", "extra_local_failure", "causal_style"])(
  "cannot treat %s as an inherited duplicate style warning", async kind => {
    const { page, candidate } = await replay();
    const context: PictureBookRepairContext = structuredClone(candidate.context);
    if (kind === "changed_page") context.changes.push({ ...context.changes[0]!, pageIndex: 29 });
    if (kind === "targeted_page") context.issues = [...context.issues, { pageIndexes: [29], messages: ["Fix this repetition."] }];
    if (kind === "linked_edit") page.findings![0]!.relatedEvidence.push({ pageIndex: 14, quote: candidate.pages[13]!.markdown });
    if (kind === "unmatched_style") page.styleAudit!.styleIssues.push("A separate voice problem.");
    if (kind === "invented_quote") page.styleAudit!.evidence![0]!.quote = "This passage never happened in the book.";
    if (kind === "extra_local_failure") { page.report.issues.push("Page is too short."); page.report.requiredRevisions.push("Fix page length."); }
    if (kind === "causal_style") page.styleAudit!.evidence![0]!.category = "continuity";
    expect(hasOnlyInheritedEditorialFindings(page, context)).toBe(false);
  });
