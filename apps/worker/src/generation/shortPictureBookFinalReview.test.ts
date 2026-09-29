import { beforeEach, expect, it, vi } from "vitest";
import { createProjectSchema, pageQualityReportSchema, makeFallbackPlan, pictureBookReviewFingerprint } from "@book-maker/core";
const mocks = vi.hoisted(() => ({ find: vi.fn(), prior: vi.fn(), chapter: vi.fn(), final: vi.fn() }));
vi.mock("@book-maker/db", () => ({ prisma: { generationJob: { findUnique: mocks.find, findFirst: mocks.prior } } }));
vi.mock("../runtime/jobLifecycle.js", () => ({ assertJobNotStopped: vi.fn() }));
vi.mock("../handlers/compileExportChapterReview.js", () => ({ runBoundedChapterQualityReview: mocks.chapter }));
vi.mock("./bookHelpers.js", () => ({ toFinalQaPage: (page: unknown) => page }));
import { reviewFinalizationManuscript } from "../handlers/compileFinalizationReview.js";
import { readPictureBookReviewSnapshot } from "./shortPictureBookReviewCache.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle bring a lantern home.", category: "KIDS", targetPages: 5,
  mediaSettings: { finalReview: true, fullIllustrations: false, includeCover: false, coverArtSource: "none" } });
const plan = { ...makeFallbackPlan(input), chapters: [{ index: 1, title: "Home", summary: "The journey.", keyBeats: [], targetPages: 5 }] };
const pages = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, title: `Page ${i + 1}`,
  markdown: `Rabbit carried lantern ${i + 1} across the bridge to Turtle.`, summary: "Homeward.", chapter: { index: 1, title: "Home" } }));
const checks = { pageModelReview: true, storyExtractAudit: false, styleAuditor: false };
const report = pageQualityReportSchema.parse({ approved: true, score: 95, issues: [], requiredRevisions: [], notes: "" });
const snapshot = () => ({ fingerprint: pictureBookReviewFingerprint({ input, plan, pages, checks }),
  reviews: pages.map((page) => ({ pageIndex: page.index, draftMarkdown: page.markdown, report, storyExtract: null, styleAudit: null, completedChecks: checks })) });
const options = () => ({ input, plan, pages, projectId: "p", researchNotes: [], skipLocalChecks: true, textModel: {},
  strategy: { runFinalBookQa: mocks.final }, shortBookReview: { generationJobId: "g", quality: { enabled: (name: string) => name === "pageModelReview" } }
}) as unknown as Parameters<typeof reviewFinalizationManuscript>[0];
beforeEach(() => {
  vi.resetAllMocks(); mocks.find.mockResolvedValue({ payload: { pictureBookReview: snapshot() } });
  mocks.chapter.mockResolvedValue([]); mocks.final.mockResolvedValue({ ...report, requiredFixes: [] });
});

it("makes zero transition or summary calls for an exact fully reviewed snapshot", async () => {
  const result = await reviewFinalizationManuscript(options());
  expect(result.finalQa.approved).toBe(true);
  expect(result.finalQa.notes).toContain("local final checks reran");
  expect(mocks.chapter).not.toHaveBeenCalled(); expect(mocks.final).not.toHaveBeenCalled();
});

it("finds the initial review across the GENERATE_BOOK to COMPILE_EXPORT job boundary", async () => {
  const request = options(); request.shortBookReview!.planId = "plan-1";
  mocks.find.mockResolvedValue({ payload: { planId: "plan-1" } });
  mocks.prior.mockResolvedValue({ payload: { pictureBookReview: snapshot() } });
  expect((await reviewFinalizationManuscript(request)).finalQa.approved).toBe(true);
  expect(mocks.prior).toHaveBeenCalledWith(expect.objectContaining({ where: {
    projectId: "p", type: "GENERATE_BOOK", status: "COMPLETED", payload: { path: ["planId"], equals: "plan-1" }
  } }));
  expect(mocks.chapter).not.toHaveBeenCalled(); expect(mocks.final).not.toHaveBeenCalled();
  mocks.prior.mockResolvedValue({ payload: { pictureBookReview: { ...snapshot(), fingerprint: "older-manuscript" } } });
  await reviewFinalizationManuscript(request);
  expect(mocks.final).toHaveBeenCalledOnce();
});

it.each(["prose", "brief", "chapter", "gate", "legacy", "partial", "duplicate"])("falls back when %s no longer proves the current review", async (kind) => {
  const request = options(); const cache = snapshot();
  if (kind === "prose") request.pages = request.pages.map((page) => page.index === 4 ? { ...page, markdown: "A different event." } : page);
  if (kind === "brief") request.input = { ...input, prompt: `${input.prompt} Before moonrise.` };
  if (kind === "chapter") request.pages = request.pages.map((page) => ({ ...page, chapter: page.chapter ? { ...page.chapter, title: "Changed title" } : null }));
  if (kind === "gate") request.shortBookReview!.quality.enabled = () => true;
  if (kind === "legacy") cache.fingerprint = "old-contract";
  if (kind === "partial") cache.reviews.pop();
  if (kind === "duplicate") cache.reviews[4] = cache.reviews[0]!;
  mocks.find.mockResolvedValue({ payload: { pictureBookReview: cache } });
  await reviewFinalizationManuscript(request);
  expect(mocks.chapter).toHaveBeenCalledOnce(); expect(mocks.final).toHaveBeenCalledOnce();
});

it("retains inherited model rejections with page-addressed fixes", async () => {
  const cache = snapshot();
  cache.reviews[2] = { ...cache.reviews[2]!, report: { ...report, approved: false, issues: ["Lost lantern handoff"], requiredRevisions: ["Restore the handoff"] } };
  mocks.find.mockResolvedValue({ payload: { pictureBookReview: cache } });
  const result = await reviewFinalizationManuscript(options());
  expect(result.finalQa).toMatchObject({ approved: false, issues: ["Page 3: Lost lantern handoff"], requiredFixes: ["Page 3: Restore the handoff"] });
  expect(mocks.final).not.toHaveBeenCalled();
});

it("reruns local checks even when the cached model verdict is clean", async () => {
  const request = options(); request.skipLocalChecks = false;
  const result = await reviewFinalizationManuscript(request);
  // These deliberately near-identical fixture pages violate deterministic repetition checks.
  expect(result.finalQa.approved).toBe(false);
  expect(result.finalQa.issues.length).toBeGreaterThan(0);
  expect(mocks.final).not.toHaveBeenCalled();
});

it("rejects protocol-incomplete checkpoints and accepts the atomic post-repair snapshot", async () => {
  expect(readPictureBookReviewSnapshot({ ...snapshot(), protocolIssues: ["Unknown row"] }, { input, plan, pages, checks })).toBeUndefined();
  expect(readPictureBookReviewSnapshot({ ...snapshot(), citationRows: [{ pageIndex: 3 }] }, { input, plan, pages, checks })).toBeUndefined();
  expect(readPictureBookReviewSnapshot({ ...snapshot(), editorialRows: [{ pageIndex: 3 }] }, { input, plan, pages, checks })).toBeUndefined();
  expect(readPictureBookReviewSnapshot({ ...snapshot(), metadataRows: [{ pageIndex: 3 }] }, { input, plan, pages, checks })).toBeUndefined();
  mocks.find.mockResolvedValue({ payload: { pictureBookReview: { ...snapshot(), fingerprint: "outdated" }, pictureBookFinalReview: snapshot() } });
  expect((await reviewFinalizationManuscript(options())).finalQa.approved).toBe(true);
  expect(mocks.final).not.toHaveBeenCalled();
});

const incompleteSnapshot = () => ({ ...snapshot(), reviews: snapshot().reviews.filter(review => review.pageIndex !== 3),
  version: 2, roundsStarted: 2, attemptsUsed: 2, outputWidened: false, deliveryFallback: true,
  unresolvedPageIndexes: [3], validationIssues: [{ pageIndex: 3, message: "Unverified requirement quote." }], protocolIssues: [], citationRows: [], editorialRows: [] });

it("reuses an exhausted delivery snapshot across jobs without approving or rewriting its unverified page", async () => {
  const request = options(); request.shortBookReview!.planId = "plan-1";
  mocks.find.mockResolvedValue({ payload: { planId: "plan-1" } });
  mocks.prior.mockResolvedValue({ payload: { pictureBookReview: incompleteSnapshot() } });
  expect(readPictureBookReviewSnapshot(incompleteSnapshot(), { input, plan, pages, checks })).toBeUndefined();
  const result = await reviewFinalizationManuscript(request);
  expect(result.finalQa).toMatchObject({ approved: false, issues: [], requiredFixes: [] });
  expect(result.issues).toEqual([expect.objectContaining({ code: "FINAL_REVIEW_UNAVAILABLE", affectedPageIndexes: [3] })]);
  expect(mocks.chapter).not.toHaveBeenCalled(); expect(mocks.final).not.toHaveBeenCalled();
});

it("retains verified repair targets alongside unavailable assessments", async () => {
  const cache = incompleteSnapshot();
  cache.reviews[0]!.report = { ...report, approved: false, issues: ["Missing handoff"], requiredRevisions: ["Show the handoff"] };
  mocks.find.mockResolvedValue({ payload: { pictureBookReview: cache } });
  const result = await reviewFinalizationManuscript(options());
  expect(result.finalQa).toMatchObject({ approved: false, issues: ["Page 1: Missing handoff"], requiredFixes: ["Page 1: Show the handoff"] });
  expect(result.issues[0]?.affectedPageIndexes).toEqual([3]);
  expect(mocks.final).not.toHaveBeenCalled();
});

it("does not turn a malformed response tail into an all-clean review", async () => {
  const cache = { ...incompleteSnapshot(), reviews: snapshot().reviews, unresolvedPageIndexes: [], validationIssues: [], protocolIssues: ["Unknown extra row"] };
  mocks.find.mockResolvedValue({ payload: { pictureBookReview: cache } });
  const result = await reviewFinalizationManuscript(options());
  expect(result.finalQa).toMatchObject({ approved: false, issues: [], requiredFixes: [] });
  expect(result.issues[0]?.affectedPageIndexes).toEqual([1, 2, 3, 4, 5]);
  expect(mocks.final).not.toHaveBeenCalled();
});

it.each(["prose", "unsettled"])("refuses an unavailable snapshot when %s changes its binding", async kind => {
  const cache = incompleteSnapshot();
  const request = options();
  if (kind === "prose") request.pages = request.pages.map(page => ({ ...page, markdown: `${page.markdown} A new event.` }));
  else cache.roundsStarted = 1;
  mocks.find.mockResolvedValue({ payload: { pictureBookReview: cache } });
  await reviewFinalizationManuscript(request);
  expect(mocks.final).toHaveBeenCalledOnce();
});
