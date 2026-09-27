import { beforeEach, expect, it, vi } from "vitest";
import { bookPlanSchema, consumeTextAttempt, createProjectSchema, FakeTextModelAdapter, pageQualityReportSchema } from "@book-maker/core";
import captured from "./testing/quickReviewFailure0338.json" with { type: "json" };

const mocks = vi.hoisted(() => ({ payload: {} as Record<string, unknown>, stop: vi.fn() }));
vi.mock("@book-maker/db", () => {
  const tx = { generationJob: {
    findUnique: async () => ({ payload: structuredClone(mocks.payload) }),
    update: async ({ data }: { data: { payload: Record<string, unknown> } }) => { mocks.payload = structuredClone(data.payload); }
  } };
  return { prisma: { ...tx, $transaction: (run: (value: typeof tx) => Promise<unknown>) => run(tx) } };
});
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: mocks.stop }));
import { prepareShortPictureBookReview } from "./shortPictureBook.js";
import { pictureBookDeliveryReviews } from "./shortPictureBookReviewDelivery.js";
import { enrichPageQualityReport } from "./qualityEnrichment.js";

beforeEach(() => { mocks.payload = {}; vi.clearAllMocks(); });

it("does not restart exhausted story and style checks during page publication", async () => {
  const textModel = new FakeTextModelAdapter();
  textModel.generateJson = vi.fn(async () => { throw new Error("Unexpected provider call"); });
  const result = await enrichPageQualityReport({ input: createProjectSchema.parse(captured.input), plan: bookPlanSchema.parse(captured.plan),
    pageIndex: 3, draft: { ...captured.pages[2]!, continuityNotes: [] },
    report: pageQualityReportSchema.parse({ approved: false, score: 100, scoreBasis: "screened_unscored" }),
    previousPages: [], researchNotes: [], textModel, projectId: "quick",
    quality: { enabled: () => true }, storyState: { promises: [], facts: [], entities: {}, unanswered: [] }, styleExcerpts: ["Opening voice."],
    precomputed: { reviewUnavailable: true, storyExtract: null, styleAudit: null, manuscriptPages: captured.pages } });
  expect(textModel.generateJson).not.toHaveBeenCalled();
  expect(result.extract).toBeNull();
  expect(result.report).toMatchObject({ approved: false, requiredRevisions: [], qualityAdvisories: [
    { check: "story_continuity", status: "unverified" }, { check: "style", status: "unverified" }
  ] });
});

it("delivers all thirty captured Quick pages when a reviewer repeats an invalid requirement citation", async () => {
  const model = new FakeTextModelAdapter();
  let calls = 0;
  model.generateJson = async request => {
    consumeTextAttempt(request);
    const raw = captured.responses[calls++];
    if (!raw) throw new Error("Unexpected extra provider request");
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "captured", model: "captured" };
  };
  const request = { projectId: "quick", generationJobId: "quick-generation", input: createProjectSchema.parse(captured.input),
    plan: bookPlanSchema.parse(captured.plan), pages: captured.pages, chapterBriefs: [], textModel: model,
    quality: { enabled: (feature: string) => feature === "pageModelReview" || feature === "storyExtractAudit" } };
  const reviews = await prepareShortPictureBookReview(request);
  expect(reviews.size).toBe(30);
  expect(reviews.get(3)?.draftMarkdown).toBe(captured.pages[2]!.markdown);
  expect(reviews.get(3)?.report.approved).toBe(false);
  expect(reviews.get(3)?.report.notes).toMatch(/unavailable|incomplete|unverified/i);
  expect(reviews.get(3)?.completedChecks.pageModelReview).toBe(false);
  for (const original of captured.checkpoint.reviews) expect(reviews.get(original.pageIndex)).toEqual(original);
  expect(calls).toBe(2);
  expect((await prepareShortPictureBookReview(request)).size).toBe(30);
  expect(calls).toBe(2);
});

it("delivers a complete unverified manuscript when the review provider is unavailable", async () => {
  const model = new FakeTextModelAdapter();
  model.generateJson = vi.fn(async () => { throw new Error("Review provider unavailable"); });
  const request = { projectId: "quick", generationJobId: "outage", input: createProjectSchema.parse(captured.input),
    plan: bookPlanSchema.parse(captured.plan), pages: captured.pages, chapterBriefs: [], textModel: model,
    quality: { enabled: (feature: string) => feature === "pageModelReview" || feature === "storyExtractAudit" } };
  const reviews = await prepareShortPictureBookReview(request);
  expect(reviews.size).toBe(30);
  expect([...reviews.values()].every(review => review.reviewUnavailable && !review.report.approved)).toBe(true);
  const calls = vi.mocked(model.generateJson).mock.calls.length;
  expect(calls).toBeGreaterThan(0); expect(calls).toBeLessThanOrEqual(5);
  expect((await prepareShortPictureBookReview(request)).size).toBe(30);
  expect(model.generateJson).toHaveBeenCalledTimes(calls);
});

it("keeps grounded editorial findings when the auxiliary checks exhaust recovery", () => {
  const page = captured.pages[2]!;
  const finding = { domain: "prose" as const, basis: "page_prose" as const, requirementQuote: null, category: "progression" as const,
    message: "Turtle waits instead of changing the search.", guidance: "Give Turtle a choice that changes the search.", quote: page.markdown.slice(0, 40), relatedEvidence: [] };
  const result = pictureBookDeliveryReviews({ input: createProjectSchema.parse(captured.input), pages: captured.pages,
    checks: { pageModelReview: true, storyExtractAudit: true, styleAuditor: false }, checkpoint: {
      ...captured.checkpoint, reviews: [], editorialRows: [{ pageIndex: 3, score: 70, findings: [finding] }], citationRows: []
    } as Parameters<typeof pictureBookDeliveryReviews>[0]["checkpoint"] });
  expect(result[2]).toMatchObject({ reviewUnavailable: true, findings: [finding], storyExtract: null,
    completedChecks: { pageModelReview: true, storyExtractAudit: false },
    report: { approved: false, score: 70, issues: [expect.stringContaining(finding.quote)], requiredRevisions: [finding.guidance] } });
});
