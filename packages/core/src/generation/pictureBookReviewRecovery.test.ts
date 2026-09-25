import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import { consumeTextAttempt } from "../adapters/textAttemptBudget.js";
import { PictureBookReviewIncompleteError, type PictureBookReviewCheckpoint, reviewPictureBookManuscript } from "./pictureBookReview.js";

const fixture = JSON.parse(readFileSync(new URL("./testing/balancedGroupReview.json", import.meta.url), "utf8"));
const clean = (pageIndex: number) => ({ pageIndex, score: 96, findings: [], storyExtract: null, styleAudit: null });
function setup(answers: unknown[]) {
  let callCount = 0;
  const generateJson = vi.fn(async <T>(options: GenerateJsonOptions<T>) => {
    consumeTextAttempt(options);
    const answer = answers[Math.min(callCount++, answers.length - 1)];
    return { data: parseSchemaWithContext("Fixture", options.schema, answer, options.purpose, JSON.stringify(answer)) };
  });
  const options = { input: { category: "KIDS", targetPages: 30, prompt: fixture.brief, language: "en", mediaSettings: {} },
    plan: { title: "Lanterns", premise: "A search", audience: "children", chapters: [], characters: [], promises: [], voiceGuide: [] },
    pages: fixture.pages, chapterBriefs: [], checks: { pageModelReview: true, storyExtractAudit: false, styleAuditor: false },
    textModel: { generateJson } as unknown as TextModelAdapter } as unknown as Parameters<typeof reviewPictureBookManuscript>[0];
  return { options, generateJson };
}

it("preserves Balanced's 29 valid captured verdicts and rechecks only page 18 with all frozen prose", async () => {
  const { options, generateJson } = setup([fixture.response, { pages: [clean(18)] }]);
  const result = await reviewPictureBookManuscript(options);
  expect(result).toHaveLength(30);
  expect(generateJson).toHaveBeenCalledTimes(2);
  const request = JSON.parse(generateJson.mock.calls[1]![0].messages.find((message) => message.role === "user")!.content);
  expect(request.reviewPageIndexes).toEqual([18]);
  expect(request.pages).toEqual(fixture.pages);
  expect(result[17]!.report.approved).toBe(true);
  expect(result[0]!.report.score).toBe(fixture.response.pages[0].score);
});


it.each(["missing", "duplicate", "unknownField", "missingEnabledAssessment"])("rechecks only an unresolved %s row and preserves all other verdicts", async (kind) => {
  const rows = Array.from({ length: 30 }, (_, i) => clean(i + 1));
  if (kind === "missing") rows.pop();
  if (kind === "duplicate") rows.push(clean(30));
  if (kind === "unknownField") Object.assign(rows[29]!, { invented: true });
  if (kind === "missingEnabledAssessment") Object.assign(rows[29]!, { score: undefined });
  const { options, generateJson } = setup([{ pages: rows }, { pages: [clean(30)] }]);
  const snapshots: PictureBookReviewCheckpoint[] = [];
  options.onCheckpoint = async (checkpoint) => { snapshots.push(structuredClone(checkpoint)); };
  await expect(reviewPictureBookManuscript(options)).resolves.toHaveLength(30);
  expect(snapshots[1]).toMatchObject({ unresolvedPageIndexes: [30], roundsStarted: 1, attemptsUsed: 1 });
  expect(snapshots[1]!.reviews).toHaveLength(29);
  expect(snapshots[2]).toMatchObject({ unresolvedPageIndexes: [30], roundsStarted: 2, attemptsUsed: 5 });
  expect(generateJson).toHaveBeenCalledTimes(2);
});

it("keeps exact requirement grounding and preserves a partial checkpoint when the targeted verdict is still invalid", async () => {
  const response = structuredClone(fixture.response);
  response.pages[17].findings[0].domain = "prose";
  const { options, generateJson } = setup([response, { pages: [response.pages[17]] }]);
  const snapshots: PictureBookReviewCheckpoint[] = [];
  options.onCheckpoint = async (checkpoint) => { snapshots.push(structuredClone(checkpoint)); };
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError", checkpoint: { unresolvedPageIndexes: [18], roundsStarted: 2, attemptsUsed: 2 } });
  expect(snapshots.at(-1)!.reviews).toHaveLength(29);
  expect(snapshots.at(-1)!.validationIssues[0]!.message).toContain("exact user requirement");
  await expect(reviewPictureBookManuscript({ ...options, resume: snapshots.at(-1)! })).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(generateJson).toHaveBeenCalledTimes(2);
});

it("preserves a valid prose failure while only rechecking its invalid neighbor", async () => {
  const response = structuredClone(fixture.response);
  response.pages[0].findings = [{ domain: "prose", basis: "page_prose", requirementQuote: null, category: "repetition",
    message: "The same action is unnecessarily repeated.", guidance: "Remove only the repeated action.", quote: fixture.pages[0].markdown.slice(0, 60), relatedEvidence: [] }];
  const { options } = setup([response, { pages: [clean(18)] }]);
  const result = await reviewPictureBookManuscript(options);
  expect(result[0]!.report).toMatchObject({ approved: false, requiredRevisions: ["Remove only the repeated action."] });
  expect(result[0]!.draftMarkdown).toBe(fixture.pages[0].markdown);
  expect(result[17]!.report.approved).toBe(true);
});

it.each(["unknownIndex", "missingIndex"])("fails closed on %s protocol rows without blessing a complete set", async (kind) => {
  const response = { pages: [...Array.from({ length: 30 }, (_, i) => clean(i + 1)), kind === "unknownIndex" ? clean(99) : { score: 90 }] };
  const { options, generateJson } = setup([response]);
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError", checkpoint: { reviews: expect.any(Array), protocolIssues: [expect.any(String)] } });
  expect(generateJson).toHaveBeenCalledTimes(1);
});

it("resumes only unresolved pages after settled partial validation and rejects unknown crash spend", async () => {
  const first = setup([fixture.response]);
  let saved!: PictureBookReviewCheckpoint;
  first.options.onCheckpoint = async (checkpoint) => {
    if (checkpoint.roundsStarted === 1 && checkpoint.attemptsUsed === 1) { saved = structuredClone(checkpoint); throw new Error("Simulated process exit after durable save"); }
  };
  await expect(reviewPictureBookManuscript(first.options)).rejects.toThrow("Simulated process exit");
  const next = setup([{ pages: [clean(18)] }]);
  next.options.resume = saved;
  await expect(reviewPictureBookManuscript(next.options)).resolves.toHaveLength(30);
  expect(next.generateJson).toHaveBeenCalledTimes(1);
  const interrupted = setup([{ pages: [clean(18)] }]);
  interrupted.options.resume = { ...saved, roundsStarted: 2, attemptsUsed: 5 };
  await expect(reviewPictureBookManuscript(interrupted.options)).rejects.toBeInstanceOf(PictureBookReviewIncompleteError);
  expect(interrupted.generateJson).not.toHaveBeenCalled();
});

it("shares the five physical-call cap across initial review, targeted recovery and transport attempts", async () => {
  const { options, generateJson } = setup([fixture.response, { pages: [clean(18)] }]);
  generateJson.mockImplementationOnce(async (request) => {
    for (let i = 0; i < 5; i += 1) consumeTextAttempt(request);
    return { data: parseSchemaWithContext("Fixture", request.schema, fixture.response, request.purpose, JSON.stringify(fixture.response)) };
  });
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ checkpoint: { attemptsUsed: 5, unresolvedPageIndexes: [18] } });
  expect(generateJson).toHaveBeenCalledTimes(1);
});

it("does not buy another call when cancellation arrives after the first partial response", async () => {
  const { options, generateJson } = setup([fixture.response]);
  const controller = new AbortController(); options.signal = controller.signal;
  options.onCheckpoint = async (checkpoint) => { if (checkpoint.attemptsUsed === 1) controller.abort(); };
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ name: "AbortError" });
  expect(generateJson).toHaveBeenCalledTimes(1);
});

it("never dispatches when reserving durable progress fails", async () => {
  const { options, generateJson } = setup([fixture.response]);
  options.onCheckpoint = async () => { throw new Error("database unavailable"); };
  await expect(reviewPictureBookManuscript(options)).rejects.toThrow("database unavailable");
  expect(generateJson).not.toHaveBeenCalled();
});
