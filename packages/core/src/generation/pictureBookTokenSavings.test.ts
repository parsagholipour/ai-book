import { expect, it } from "vitest";
import { createProjectSchema, pageQualityReportSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { pictureBookReviewMessages } from "./pictureBookReviewPrompt.js";
import { pictureBookReviewFingerprint, reviewPictureBookManuscript, unchangedPrefixStoryExtracts } from "./pictureBookReview.js";
import { storyExtractResultSchema } from "./storyState.js";
import { scriptedDevelopmentModel } from "./testing/bookDevelopmentFixtures.js";
import { generateWholeBookDraft } from "./pages.js";

const input = createProjectSchema.parse({ prompt: "Rabbit finds a lantern and helps Turtle carry it home.", category: "KIDS", targetPages: 5,
  mediaSettings: { fullIllustrations: false, includeCover: false, coverArtSource: "none" } });
const plan = makeFallbackPlan(input);
const pages = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, title: `Page ${i + 1}`,
  markdown: `Rabbit carried lantern ${i + 1} across the bridge to Turtle.`, summary: "Redundant scene summary." }));
const checks = { pageModelReview: true, storyExtractAudit: true, styleAuditor: false };
const options = (model = scriptedDevelopmentModel([]).model) => ({ input, plan, pages, checks, chapterBriefs: [], textModel: model });
const extract = storyExtractResultSchema.parse({ storyDelta: { unansweredAdded: ["Where is the lantern?"] } });
const reviews = pages.map((page) => ({ pageIndex: page.index, draftMarkdown: page.markdown,
  report: pageQualityReportSchema.parse({ approved: true, score: 95, issues: [], requiredRevisions: [], notes: "" }), storyExtract: extract, styleAudit: null, completedChecks: checks }));

it("retains exact prose, brief, canon, continuity and opening/transition checks without duplicate scaffolding", () => {
  const messages = pictureBookReviewMessages({ ...options(), checks: { ...checks, styleAuditor: true } }, [1, 2, 3, 4, 5], []);
  const payload = JSON.parse(messages[1]!.content);
  expect(payload.pages).toEqual(pages.map(({ index, title, markdown }) => ({ index, title, markdown })));
  expect(payload.brief).toBe(input.prompt);
  expect(payload.book.characters).toEqual(plan.characters);
  expect(payload.book.continuityRules).toEqual(plan.continuityRules);
  expect(payload).not.toHaveProperty("chapterBriefs");
  expect(payload).not.toHaveProperty("voiceSamples");
  expect(payload.voiceSamplePageIndexes).toEqual([1, 2]);
  expect(messages[0]!.content).toContain("throat-clearing");
  expect(messages[0]!.content).toContain("every adjacent chapter handoff");
});

it.each(["none", "design", "ai"] as const)("omits unused artwork context for %s covers while retaining character canon", async (coverArtSource) => {
  const { model, calls } = scriptedDevelopmentModel([{ pages: pages.map((page) => ({ ...page, continuityNotes: [] })) }]);
  await generateWholeBookDraft({ input: { ...input, mediaSettings: { ...input.mediaSettings, coverArtSource } }, plan, researchNotes: [], textModel: model });
  const payload = JSON.parse(calls[0]!.messages.find((message) => message.role === "user")!.content);
  expect(payload.characters).toEqual(plan.characters);
  expect("illustrationPlan" in payload).toBe(coverArtSource === "ai");
});

it("retains artwork context when interior slots are enabled", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ pages: pages.map((page) => ({ ...page, continuityNotes: [] })) }]);
  await generateWholeBookDraft({ input: { ...input, mediaSettings: { ...input.mediaSettings, fullIllustrations: true, illustrationCadence: "every-page" } }, plan, researchNotes: [], textModel: model });
  expect(JSON.parse(calls[0]!.messages[1]!.content).illustrationPlan).toEqual(plan.illustrationPlan);
});

it("reuses only the unchanged chronological prefix, never an untouched downstream page", () => {
  const candidate = pages.map((page) => page.index === 3 ? { ...page, markdown: "Turtle carries two lanterns." } : page);
  expect([...unchangedPrefixStoryExtracts(pages, candidate, reviews).keys()]).toEqual([1, 2]);
  expect([...unchangedPrefixStoryExtracts(pages, [...pages].reverse(), reviews).keys()]).toEqual([]);
});

it("keeps all prose in repair review but expands the authorized reuse marker from saved state", async () => {
  const { model, calls } = scriptedDevelopmentModel([{ pages: pages.map((page) => ({ pageIndex: page.index, score: 95,
    findings: [], storyExtract: page.index <= 2 ? "reuse" : "no_changes", styleAudit: null })) }]);
  const result = await reviewPictureBookManuscript({ ...options(model), reusableStoryExtracts: new Map([[1, extract], [2, extract]]) });
  expect(result[0]!.storyExtract).toEqual(extract);
  expect(result[2]!.storyExtract?.storyDelta.unansweredAdded).toEqual([]);
  const payload = JSON.parse(calls[0]!.messages.find((message) => message.role === "user")!.content);
  expect(payload.reusableStoryExtractPageIndexes).toEqual([1, 2]);
  expect(payload.pages).toHaveLength(5);
});

it("rejects unauthorized reuse instead of treating it as no state changes", async () => {
  const answer = { pages: pages.map((page) => ({ pageIndex: page.index, score: 95, findings: [], storyExtract: "reuse", styleAudit: null })) };
  const { model } = scriptedDevelopmentModel([answer, answer]);
  await expect(reviewPictureBookManuscript(options(model))).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
});

it("binds all reviewed dependencies while excluding summaries the reviewer never reads", () => {
  const fingerprint = pictureBookReviewFingerprint(options());
  expect(pictureBookReviewFingerprint({ ...options(), pages: pages.map((page) => ({ ...page, summary: "New summary" })) })).toBe(fingerprint);
  for (const changed of [
    { input: { ...input, prompt: `${input.prompt} Before moonrise.` } },
    { plan: { ...plan, continuityRules: ["Turtle owns both lanterns."] } },
    { checks: { ...checks, pageModelReview: false } },
    { pages: pages.map((page) => page.index === 5 ? { ...page, markdown: "Turtle loses both lanterns." } : page) }
  ]) expect(pictureBookReviewFingerprint({ ...options(), ...changed })).not.toBe(fingerprint);
});
