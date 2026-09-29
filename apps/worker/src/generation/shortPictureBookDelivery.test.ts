import { beforeEach, expect, it, vi } from "vitest";
import { bookPlanSchema, consumeTextAttempt, createProjectSchema, makeFallbackPlan, FakeTextModelAdapter,
  pageQualityReportSchema, repairPictureBookManuscript } from "@book-maker/core";
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
import { readPictureBookDeliverySnapshot, readPictureBookReviewSnapshot } from "./shortPictureBookReviewCache.js";

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
  const purposes: string[] = [];
  model.generateJson = async request => {
    consumeTextAttempt(request);
    purposes.push(request.purpose ?? "");
    if (request.purpose === "review-picture-book-continuity") return { data: request.schema.parse({ findings: [] }),
      text: '{"findings":[]}', provider: "fixture", model: "fixture" };
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
  expect(purposes).toEqual(["review-page", "review-picture-book-continuity", "review-page"]);
  expect((await prepareShortPictureBookReview(request)).size).toBe(30);
  expect(calls).toBe(2);
  expect(purposes).toHaveLength(3);
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

// Minimized from Balanced's September 28 page 24: its missing-dialogue finding
// was grounded, but an inexact sensory-detail witness left the checklist pending.
const dialogueInput = createProjectSchema.parse({ category: "KIDS", targetPages: 30,
  prompt: "Write a children's story. Give each page natural dialogue and concrete sensory details." });
const dialoguePage = { index: 24, title: "The Lights Return", summary: "The lanterns return to their posts.",
  markdown: "Rabbit crossed to meet Wise Turtle on the west bank. Then he lifted Blue from the stump and carried it to the fallen-log post. While Rabbit set Blue in place, Wise Turtle carried Amber to the stump and set it down. Amber, Blue, and Green now glowed at their proper posts, in order along the path." };
const dialoguePlan = bookPlanSchema.parse({ ...makeFallbackPlan(dialogueInput), requirementInventory: {
  status: "available", brief: dialogueInput.prompt, complete: true,
  requirements: ["natural dialogue", "concrete sensory details"].map(quote => ({ kind: "content", text: quote, quote,
    scope: { extent: "each_page", quote: "Give each page natural dialogue and concrete sensory details." } }))
} });
const dialogueFinding = { domain: "prose" as const, basis: "missing_requirement" as const, requirementQuote: "natural dialogue",
  category: "brief" as const, repairKind: "semantic" as const,
  message: "This page has no dialogue, despite the explicit natural-dialogue requirement for each page.",
  guidance: "Add a brief exchange while preserving both lantern returns.",
  quote: "While Rabbit set Blue in place, Wise Turtle carried Amber to the stump and set it down.", relatedEvidence: [] };
const pendingChecklist = [{ requirementIndex: 0, evidence: null },
  { requirementIndex: 1, evidence: "Amber, Blue, and Green now glowed at their proper posts." }];
const dialogueChecks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };

it("preserves a missing-dialogue repair instruction through exhausted checklist recovery and cached delivery", async () => {
  const model = new FakeTextModelAdapter();
  const responses = [
    { pages: [{ pageIndex: 24, score: 84, findings: [dialogueFinding], requirementChecks: pendingChecklist }] },
    { pages: [], auxiliaryCorrections: [{ id: "page:24", requirementChecks: pendingChecklist }] }
  ];
  let calls = 0;
  const purposes: string[] = [];
  model.generateJson = async request => {
    consumeTextAttempt(request);
    purposes.push(request.purpose ?? "");
    if (request.purpose === "review-picture-book-continuity") return { data: request.schema.parse({ findings: [] }),
      text: '{"findings":[]}', provider: "fixture", model: "fixture" };
    const raw = responses[calls++];
    if (!raw) throw new Error("Unexpected extra provider request");
    return { data: request.schema.parse(raw), text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  };
  const options = { projectId: "balanced", generationJobId: "balanced-delivery", input: dialogueInput,
    plan: dialoguePlan, pages: [dialoguePage], chapterBriefs: [], textModel: model,
    quality: { enabled: (feature: string) => feature === "pageModelReview" } };
  const reviews = await prepareShortPictureBookReview(options);
  const review = reviews.get(24);
  expect(review).toMatchObject({ reviewUnavailable: true, findings: [dialogueFinding],
    completedChecks: dialogueChecks, report: { approved: false,
      issues: [expect.stringContaining(dialogueFinding.message)], requiredRevisions: [dialogueFinding.guidance] } });
  expect(review?.requirementChecks).toBeUndefined();
  const context = { ...options, checks: dialogueChecks };
  expect(readPictureBookReviewSnapshot(mocks.payload.pictureBookReview, context)).toBeUndefined();
  expect(readPictureBookDeliverySnapshot(mocks.payload.pictureBookReview, context)?.[0]).toEqual(review);
  expect((await prepareShortPictureBookReview(options)).get(24)).toEqual(review);
  expect(calls).toBe(2);
  expect(purposes).toEqual(["review-page", "review-picture-book-continuity", "review-page"]);

  // A sentence-length warning must not hide the recovered dialogue repair target.
  const repairModel = new FakeTextModelAdapter();
  repairModel.generateJson = vi.fn(async request => {
    const payload = JSON.parse(request.messages.at(-1)!.content);
    expect(payload.semanticTargetPageIndexes).toEqual([24]);
    expect(payload.sentenceRepairs).toBeUndefined();
    expect(payload.issues[0].messages).toContain(dialogueFinding.guidance);
    return { data: request.schema.parse({ pages: [] }), text: '{"pages":[]}', provider: "fixture", model: "fixture" };
  });
  await repairPictureBookManuscript({ ...options, textModel: repairModel, issues: [{ pageIndexes: [24],
    messages: [...review!.report.issues, ...review!.report.requiredRevisions, "Page 24: Sentences are too long for this reading level."] }] });
  expect(repairModel.generateJson).toHaveBeenCalledTimes(1);
});

it.each([
  { label: "an ungrounded manuscript quote", finding: { ...dialogueFinding, quote: "Rabbit said a sentence absent from this page." } },
  { label: "an invented requirement", finding: { ...dialogueFinding, requirementQuote: "Include a poem on each page" } },
  { label: "unsupported cross-page scope", finding: { ...dialogueFinding, basis: "cross_page" as const } }
])("does not promote $label while retaining an incomplete checklist", ({ finding }) => {
  const result = pictureBookDeliveryReviews({ input: dialogueInput, pages: [dialoguePage], checks: dialogueChecks,
    checkpoint: { version: 2, reviews: [], unresolvedPageIndexes: [24], validationIssues: [], protocolIssues: [],
      roundsStarted: 2, attemptsUsed: 2, outputWidened: false,
      editorialRows: [{ pageIndex: 24, score: 84, findings: [finding], requirementChecks: pendingChecklist }] } });
  expect(result[0]).toMatchObject({ reviewUnavailable: true, completedChecks: { pageModelReview: false },
    report: { approved: false, issues: [], requiredRevisions: [], scoreBasis: "screened_unscored" } });
  expect(result[0]?.findings).toBeUndefined();
});

it("quarantines contradicted dialogue claims while retaining independent repair findings", () => {
  const page = { ...dialoguePage, markdown: '“Every light is gone,” Rabbit said. He leaned forward, ready to dash into the dripping woods.' };
  const challenged = { ...dialogueFinding, quote: page.markdown, message: "This page has no dialogue." };
  const independent = { ...challenged, basis: "page_prose" as const, requirementQuote: null, category: "style" as const,
    message: "An independent style defect remains.", guidance: "Fix the independent defect." };
  const checkpoint = { version: 2 as const, reviews: [], unresolvedPageIndexes: [24], validationIssues: [], protocolIssues: [],
    roundsStarted: 2, attemptsUsed: 2, outputWidened: false,
    editorialRows: [{ pageIndex: 24, score: 84, findings: [challenged, independent] }] };
  const [review] = pictureBookDeliveryReviews({ input: dialogueInput, pages: [page], checks: dialogueChecks, checkpoint });
  expect(review).toMatchObject({ reviewUnavailable: true, findings: [independent], unverifiedFindings: [challenged],
    report: { approved: false, requiredRevisions: [independent.guidance] } });
  const [onlyChallenge] = pictureBookDeliveryReviews({ input: dialogueInput, pages: [page], checks: dialogueChecks,
    checkpoint: { ...checkpoint, editorialRows: [{ pageIndex: 24, score: 84, findings: [challenged] }] } });
  expect(onlyChallenge).toMatchObject({ reviewUnavailable: true, findings: [], unverifiedFindings: [challenged],
    report: { approved: false, requiredRevisions: [], issues: [], scoreBasis: "screened_unscored" } });
});
