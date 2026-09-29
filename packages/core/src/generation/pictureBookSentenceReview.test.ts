import { pictureBookChecklistSpans } from "./pictureBookChecklistSpans.js";
import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import type { GenerateJsonOptions } from "../adapters/types.js";
import { reviewPictureBookSentenceRepair } from "./pictureBookSentenceReview.js";
import { pictureBookPageReview } from "./pictureBookReviewValidation.js";

type Options = Parameters<typeof reviewPictureBookSentenceRepair>[0];
const original = "Turtle carried one lantern to the post and fitted it onto the hook.";
const candidate = "Turtle carried one lantern to the post. He fitted it onto the hook.";
const checks = { pageModelReview: true, storyExtractAudit: true, styleAuditor: false };
const response = () => ({ reviewedPageIndexes: [1, 2, 3], findings: [] as Record<string, unknown>[],
  assessments: [{ pageIndex: 2, targetResolved: true, meaningPreserved: true, reason: "The same actor performs both events in the same order.",
    semanticChanges: [] as { kind: string; originalQuote: string; candidateQuote: string; originalMeaning: string; candidateMeaning: string }[] }] });
function setup(answers: unknown[] = [response()]) {
  const pages = ["Rabbit found one lantern beside the tree.", original, "The single lantern remained on its hook until dawn."]
    .map((markdown, i) => ({ index: i + 1, title: `Page ${i + 1}`, markdown, summary: "A lantern recovery." }));
  const reviews = pages.map(page => pictureBookPageReview({ pageIndex: page.index, score: 96, findings: [],
    storyExtract: { storyDelta: { factsAdded: [page.markdown] }, contradictions: [] }, styleAudit: null }, page, checks, ""));
  const textModel = new FakeTextModelAdapter();
  const generateJson = vi.fn(async <T,>(request: GenerateJsonOptions<T>) => {
    request.textAttemptBudget!.used += 1;
    const raw: unknown = answers[Math.min(generateJson.mock.calls.length - 1, answers.length - 1)];
    return { data: parseSchemaWithContext("Fixture", request.schema, raw, request.purpose, JSON.stringify(raw)),
      text: JSON.stringify(raw), provider: "fixture", model: "fixture" };
  });
  textModel.generateJson = async request => {
    const result = await generateJson(request);
    return { ...result, data: request.schema.parse(result.data) };
  };
  const options = { input: { prompt: "Recover the single lantern.", language: "en", category: "KIDS", targetPages: 3,
    mediaSettings: { audienceAgeRange: "6-8" } }, plan: { title: "A Light", chapters: [], characters: [], promises: [], voiceGuide: [] },
    pages: pages.map(page => page.index === 2 ? { ...page, markdown: candidate } : { ...page }), chapterBriefs: [], checks: { ...checks },
    repairContext: { changes: [{ pageIndex: 2, originalMarkdown: original, reason: "Split the long sentence." }],
      sentenceOnlyPageIndexes: [2], issues: [] }, baseline: { pages, reviews }, textModel,
    continuityReview: false, // These tests isolate the compact equivalence protocol.
    textAttemptBudget: { limit: 5, used: 0, outputWidened: false }
  } as unknown as Options;
  return { options, generateJson };
}

describe("compact sentence repair verification", () => {
  it("keeps repeated continuity occurrences actionable in compact candidate verification", async () => {
    const answer = response(); answer.reviewedPageIndexes.push(4);
    const finding = { pageIndex: 3, domain: "prose", basis: "cross_page", requirementQuote: null,
      category: "continuity", repairKind: "semantic", message: "Two lanterns cannot later be the single lantern.",
      guidance: "Keep the count consistent.", quote: "The single lantern remained on its hook until dawn.",
      relatedEvidence: [{ pageIndex: 2, quote: "Turtle carried two lanterns to the post." }],
      relatedOccurrences: [{ pageIndex: 4, quote: "The single lantern remained on its hook until dawn." }] };
    const { options, generateJson } = setup([answer, { findings: [finding] }]);
    options.continuityReview = true;
    options.baseline!.pages = [...options.baseline!.pages, { ...options.baseline!.pages[2]!, index: 4 }];
    options.baseline!.reviews = [...options.baseline!.reviews, { ...options.baseline!.reviews[2]!, pageIndex: 4 }];
    options.pages = [...options.pages.map(page => page.index === 2 ? { ...page, markdown: candidate.replace("one lantern", "two lanterns") } : page),
      { ...options.pages[2]!, index: 4 }];
    const reviews = (await reviewPictureBookSentenceRepair(options))!;
    expect(reviews.filter(review => review.findings?.length).map(review => review.pageIndex)).toEqual([3, 4]);
    expect(reviews.every(review => !review.completedChecks.storyExtractAudit)).toBe(true);
    expect(generateJson).toHaveBeenCalledTimes(2);
  });

  it("checks continuity independently even when sentence equivalence was approved", async () => {
    const finding = { pageIndex: 3, domain: "prose", basis: "cross_page", requirementQuote: null,
      category: "continuity", repairKind: "semantic", message: "Two lanterns cannot later be the single lantern.",
      guidance: "Keep the count consistent.", quote: "The single lantern remained on its hook until dawn.",
      relatedEvidence: [{ pageIndex: 2, quote: "Turtle carried two lanterns to the post." }] };
    const { options, generateJson } = setup([response(), { findings: [finding] }]);
    options.continuityReview = true;
    options.pages = options.pages.map(page => page.index === 2 ? { ...page, markdown: candidate.replace("one lantern", "two lanterns") } : page);
    const reviews = (await reviewPictureBookSentenceRepair(options))!;
    expect(reviews[2]!.report.approved).toBe(false);
    expect(reviews[1]!.repairAssessment!.noNewRegressions).toBe(false);
    expect(reviews.every(review => !review.completedChecks.storyExtractAudit)).toBe(true);
    expect(generateJson.mock.calls.map(([request]) => request.purpose)).toEqual(["review-page", "review-picture-book-continuity"]);
    expect(options.textAttemptBudget!.used).toBe(2);
  });

  it("uses full-book context, fresh explicit equivalence, and an independent copy of original chronological deltas", async () => {
    const { options, generateJson } = setup();
    const reviews = (await reviewPictureBookSentenceRepair(options))!;
    expect(reviews.map(review => review.storyExtract)).toEqual(options.baseline!.reviews.map(review => review.storyExtract));
    expect(reviews[1]!.draftMarkdown).toBe(candidate);
    expect(reviews[1]!.repairAssessment).toMatchObject({ targetResolved: true, meaningPreserved: true, noNewRegressions: true });
    expect(reviews.every(review => review.completedChecks.storyExtractAudit && review.report.approved)).toBe(true);
    reviews[2]!.storyExtract!.storyDelta.factsAdded.push("Mutation probe");
    expect(options.baseline!.reviews[2]!.storyExtract!.storyDelta.factsAdded).not.toContain("Mutation probe");
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(generateJson.mock.calls[0]![0]).toMatchObject({ maxTokens: 4_000, purpose: "review-page" });
    expect(generateJson.mock.calls[0]![0].messages[0]!.content).toContain("On the actual final story page, closure satisfies ordinary page-turn guidance");
    expect(generateJson.mock.calls[0]![0].messages[0]!.content).toContain("An explicit request for a final-page hook, cliffhanger or unresolved ending takes precedence");
    expect(options.textAttemptBudget!.used).toBe(1);
  });

  it("requests a bounded corrected judgment for a veto with no changed proposition, without rewriting prose", async () => {
    const bad = response(); bad.assessments[0]!.meaningPreserved = false;
    bad.assessments[0]!.reason = "The same event remains clear but now uses two grammatical sentences.";
    const { options, generateJson } = setup([bad, response()]);
    expect((await reviewPictureBookSentenceRepair(options))![1]!.repairAssessment!.meaningPreserved).toBe(true);
    expect(generateJson).toHaveBeenCalledTimes(2);
    expect(generateJson.mock.calls[1]![0].messages[0]!.content).toContain("actual changed proposition");
    expect(generateJson.mock.calls[1]![0].messages[1]).toEqual(generateJson.mock.calls[0]![0].messages[1]);
  });

  it.each([
    ["actor", "Rabbit carried one lantern to the post. He fitted it onto the hook.", "Turtle carries it.", "Rabbit carries it."],
    ["quantity", "Turtle carried two lanterns to the post. He fitted them onto the hook.", "One lantern is carried.", "Two lanterns are carried."],
    ["negation", "Turtle did not carry one lantern to the post. He fitted it onto the hook.", "Turtle carries the lantern.", "Turtle does not carry the lantern."],
    ["chronology", "Turtle fitted one lantern onto the hook. Then he carried it to the post.", "Carrying precedes fitting.", "Fitting precedes carrying."],
    ["grammar", "Turtle carried one lantern to the post. And fitted onto.", "Turtle fits the lantern onto the hook.", "The second clause has no subject or complete object relationship."]
  ])("retains a grounded %s rejection and never reuses story state for it", async (kind, markdown, originalMeaning, candidateMeaning) => {
    const bad = response();
    Object.assign(bad.assessments[0]!, { meaningPreserved: false, reason: "A real semantic or grammatical relationship changed.",
      semanticChanges: [{ kind, originalQuote: original, candidateQuote: markdown, originalMeaning, candidateMeaning }] });
    const { options } = setup([bad]); options.pages = options.pages.map(page => page.index === 2 ? { ...page, markdown: markdown! } : page);
    const reviews = (await reviewPictureBookSentenceRepair(options))!;
    expect(reviews[1]!.repairAssessment!.meaningPreserved).toBe(false);
    expect(reviews.every(review => !review.completedChecks.storyExtractAudit && review.storyExtract === null)).toBe(true);
  });

  it("rejects a supported downstream defect on an unchanged later page", async () => {
    const answer = response(); answer.findings.push({ pageIndex: 3, domain: "prose", basis: "cross_page", requirementQuote: null,
      category: "continuity", message: "The later single-lantern count conflicts with the changed pair.", guidance: "Preserve the single lantern.",
      quote: "The single lantern remained on its hook until dawn.", relatedEvidence: [{ pageIndex: 2, quote: "Turtle carried two lanterns to the post." }] });
    const { options } = setup([answer]);
    options.pages = options.pages.map(page => page.index === 2 ? { ...page, markdown: candidate.replace("one lantern", "two lanterns") } : page);
    const reviews = (await reviewPictureBookSentenceRepair(options))!;
    expect(reviews[2]!.report.approved).toBe(false);
    expect(reviews[1]!.repairAssessment!.noNewRegressions).toBe(false);
    expect(reviews[2]!.storyExtract).toBeNull();
  });

  it.each(["missing coverage", "duplicate coverage", "extra assessment", "invented quote", "same meanings", "bad measurement"])("fails closed after bounded recovery for %s", async defect => {
    const answer = response();
    if (defect === "missing coverage") answer.reviewedPageIndexes.pop();
    if (defect === "duplicate coverage") answer.reviewedPageIndexes[2] = 2;
    if (defect === "extra assessment") answer.assessments.push({ ...answer.assessments[0]!, pageIndex: 3 });
    if (defect === "bad measurement") answer.assessments[0]!.reason = "This page has 400 words.";
    if (defect === "invented quote" || defect === "same meanings") Object.assign(answer.assessments[0]!, {
      meaningPreserved: false, semanticChanges: [{ kind: "event", originalQuote: original, candidateQuote: defect === "invented quote" ? "Invented text" : candidate,
        originalMeaning: "The event occurs.", candidateMeaning: defect === "same meanings" ? "The event occurs." : "The event does not occur." }] });
    const { options, generateJson } = setup([answer]);
    await expect(reviewPictureBookSentenceRepair(options)).rejects.toThrow(/validation failed/);
    expect(generateJson).toHaveBeenCalledTimes(2);
    expect(options.textAttemptBudget!.used).toBe(2);
  });

  it.each(["absent", "stale", "missing row", "prior concern", "unverified", "style", "semantic scope", "title", "unlisted edit", "order"])("leaves %s baselines to the existing full reviewer without a compact call", async condition => {
    const { options, generateJson } = setup();
    const baseline = options.baseline!;
    if (condition === "absent") options.baseline = undefined;
    if (condition === "stale") baseline.reviews[1]!.draftMarkdown += " Changed.";
    if (condition === "missing row") options.baseline = { ...baseline, reviews: baseline.reviews.slice(1) };
    if (condition === "prior concern") baseline.reviews[0]!.report.approved = false;
    if (condition === "unverified") baseline.reviews[0]!.storyExtract!.unverifiedContradictions = ["Unverified prior concern."];
    if (condition === "style") options.checks.styleAuditor = true;
    if (condition === "semantic scope") options.repairContext!.sentenceOnlyPageIndexes = [];
    if (condition === "title") options.pages = options.pages.map(page => ({ ...page, title: "Changed title" }));
    if (condition === "unlisted edit") options.pages = options.pages.map(page => page.index === 3 ? { ...page, markdown: "A different ending." } : page);
    if (condition === "order") options.pages = [...options.pages].reverse();
    expect(await reviewPictureBookSentenceRepair(options)).toBeUndefined();
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("does not spend beyond a shared budget or ignore cancellation", async () => {
    const { options, generateJson } = setup(); options.textAttemptBudget!.used = 5;
    await expect(reviewPictureBookSentenceRepair(options)).rejects.toThrow(/exhausted/);
    expect(generateJson).not.toHaveBeenCalled();
    expect(options.textAttemptBudget!.used).toBe(5);
    options.signal = AbortSignal.abort();
    await expect(reviewPictureBookSentenceRepair(options)).rejects.toThrow(/aborted/);
    expect(generateJson).not.toHaveBeenCalled();
  });
});


it.each([false, true])("reuses unchanged requirement checks but rechecks the repaired page (source IDs: %s)", async useIds => {
  const answer = response();
  Object.assign(answer.assessments[0]!, { requirementChecks: [{ requirementIndex: 0, evidence: "Turtle carried one lantern to the post." }] });
  const { options, generateJson } = setup([answer]);
  if (useIds) Object.assign(answer.assessments[0]!, { requirementChecks: [Object.keys(pictureBookChecklistSpans(options.pages[1]!))[0]!] });
  options.input.prompt = "Each page includes a lantern.";
  options.plan.requirementInventory = { version: 1, complete: true, status: "available", brief: options.input.prompt,
    requirements: [{ text: "A lantern on each page", kind: "content", quote: "includes a lantern",
      scope: { extent: "each_page", quote: options.input.prompt } }] };
  for (const review of options.baseline!.reviews) review.requirementChecks = [{ requirementIndex: 0, evidence: review.draftMarkdown }];
  const reviews = (await reviewPictureBookSentenceRepair(options))!;
  expect(generateJson).toHaveBeenCalledTimes(1);
  expect(reviews[1]!.requirementChecks).toEqual([{ requirementIndex: 0, evidence: "Turtle carried one lantern to the post." }]);
  expect(reviews[0]!.requirementChecks).toEqual(options.baseline!.reviews[0]!.requirementChecks);
  expect(reviews[2]!.requirementChecks).toEqual(options.baseline!.reviews[2]!.requirementChecks);
});
