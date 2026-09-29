import { expect, it, vi } from "vitest";
import { createProjectSchema, pageQualityReportSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import { reviewPictureBookManuscript } from "./pictureBookReview.js";

const requirement = "Exactly 10 interior illustrations, on story pages 3, 6, 9, 12, 15, 18, 21, 24, 27, 30.";
const input = createProjectSchema.parse({ prompt: `Rabbit and Wise Turtle each learn a different lesson. ${requirement}`, category: "KIDS", targetPages: 30,
  mediaSettings: { fullIllustrations: true, illustrationCadence: "every-third-page" } });
const pages = Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Page ${i + 1}`, markdown: `Rabbit carries lantern ${i + 1} toward Wise Turtle on the grassy bank.`, summary: "" }));
const deferredFinding = (index: number) => ({ domain: "deferred_media", basis: "missing_requirement", requirementQuote: requirement, category: "brief",
  message: "The required interior illustration has not been generated yet.", guidance: `Generate the scheduled interior illustration for page ${index}.`, quote: pages[index - 1]!.markdown, relatedEvidence: [] });
function setup() {
  const response = { pages: pages.map((page) => ({ pageIndex: page.index, score: 92, findings: page.index % 3 === 0 ? [deferredFinding(page.index)] : [], storyExtract: null, styleAudit: null })) };
  const generateJson = vi.fn(async <T>(options: GenerateJsonOptions<T>) => ({ data: parseSchemaWithContext("Fixture", options.schema, response, options.purpose, JSON.stringify(response)) }));
  const options = { input, plan: makeFallbackPlan(input), pages, chapterBriefs: [], continuityReview: false, checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false },
    textModel: { generateJson } as unknown as TextModelAdapter };
  return { options, response, generateJson };
}

it("keeps ten scheduled asset requirements separate from prose approval and survives report serialization", async () => {
  const { options, generateJson } = setup();
  const result = await reviewPictureBookManuscript(options);
  expect(generateJson).toHaveBeenCalledTimes(1);
  expect(result.every((page) => page.report.approved && page.report.issues.length === 0 && page.report.requiredRevisions.length === 0)).toBe(true);
  const illustrated = result.filter((page) => page.report.deferredMedia);
  expect(illustrated.map((page) => page.pageIndex)).toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
  expect(pageQualityReportSchema.parse(illustrated[0]!.report).deferredMedia).toMatchObject({ stage: "before_illustrations", brief: input.prompt, draftMarkdown: pages[2]!.markdown,
    requirements: [{ kind: "interior_illustration", pageIndex: 3, requirementQuote: requirement, quote: pages[2]!.markdown }] });
  expect(generateJson.mock.calls[0]![0].messages[0]!.content).toContain("Scores evaluate prose only");
});

it("retains a genuine page30 prose defect alongside its deferred illustration", async () => {
  const { options, response } = setup();
  response.pages[29]!.findings.push({ ...deferredFinding(30), domain: "prose", basis: "missing_requirement",
    requirementQuote: "Rabbit and Wise Turtle each learn a different lesson.", category: "arc", message: "Turtle's requested arc lacks a payoff.", guidance: "Give Turtle a distinct changed choice here." });
  const result = await reviewPictureBookManuscript(options);
  expect(result.filter((page) => !page.report.approved).map((page) => page.pageIndex)).toEqual([30]);
  expect(result[29]!.report.requiredRevisions).toEqual(["Give Turtle a distinct changed choice here."]);
  expect(result[29]!.report.deferredMedia?.requirements).toHaveLength(1);
});

it("reviews text-only prose without awaiting artwork or discarding a character arc defect", async () => {
  const { options, response, generateJson } = setup();
  options.input = { ...input, prompt: "Rabbit and Wise Turtle each learn a different lesson.", mediaSettings: {
    ...input.mediaSettings, fullIllustrations: false, illustrationCadence: "manual", includeCover: false, coverArtSource: "none"
  } };
  for (const page of response.pages) page.findings = [];
  response.pages[29]!.findings = [{ ...deferredFinding(30), domain: "prose", requirementQuote: options.input.prompt,
    category: "arc", message: "Turtle's requested arc lacks a payoff.", guidance: "Give Turtle a distinct changed choice here." }];
  const result = await reviewPictureBookManuscript(options);
  expect(generateJson).toHaveBeenCalledTimes(1);
  const request = generateJson.mock.calls[0]![0];
  expect(request.messages[0]!.content).toContain("no scheduled interior illustrations");
  expect(request.messages[0]!.content).not.toContain("images are generated later");
  expect(JSON.parse(request.messages[1]!.content)).toMatchObject({ reviewStage: "manuscript_only", selectedIllustrationPageIndexes: [] });
  expect(result.filter((page) => !page.report.approved).map((page) => page.pageIndex)).toEqual([30]);
  expect(result[29]!.report.requiredRevisions).toEqual(["Give Turtle a distinct changed choice here."]);
  expect(result.every((page) => !page.report.deferredMedia)).toBe(true);
});

it("rejects a deferred artwork finding when illustrations are disabled", async () => {
  const { options } = setup();
  options.input = { ...input, mediaSettings: { ...input.mediaSettings, fullIllustrations: false } };
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
});

it.each(["unscheduled", "inventedQuote", "proseContradiction", "noDomain"])("does not defer %s evidence", async (kind) => {
  const { options, response } = setup();
  const finding = deferredFinding(kind === "unscheduled" ? 2 : 3);
  if (kind === "inventedQuote") finding.requirementQuote = "Add a dragon illustration.";
  if (kind === "proseContradiction") finding.basis = "page_prose";
  if (kind === "noDomain") Object.assign(finding, { domain: undefined });
  response.pages[kind === "unscheduled" ? 1 : 2]!.findings = [finding];
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
});
