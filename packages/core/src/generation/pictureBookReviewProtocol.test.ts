import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { parseSchemaWithContext } from "../adapters/json.js";
import { consumeTextAttempt } from "../adapters/textAttemptBudget.js";
import { reviewPictureBookManuscript, type PictureBookReviewCheckpoint } from "./pictureBookReview.js";

const fixture = JSON.parse(readFileSync(new URL("./testing/premiumMalformedGroupReview.json", import.meta.url), "utf8"));
const clean = (pageIndex: number) => ({ pageIndex, score: 96, findings: [], storyExtract: "no_changes", styleAudit: "clean" });
function setup(answers: unknown[]) {
  let callCount = 0;
  const generateJson = vi.fn(async <T>(request: GenerateJsonOptions<T>) => {
    consumeTextAttempt(request);
    const answer = answers[Math.min(callCount++, answers.length - 1)];
    return { data: parseSchemaWithContext("Fixture", request.schema, answer, request.purpose, JSON.stringify(answer)) };
  });
  const options = { input: { category: "KIDS", targetPages: 30, prompt: fixture.brief, language: "en", mediaSettings: {} },
    plan: { title: "The Lantern Path", premise: "A search", audience: "children", chapters: [], characters: [], promises: [], voiceGuide: [] },
    pages: fixture.pages, chapterBriefs: [], continuityReview: false, checks: fixture.checks,
    textModel: { generateJson } as unknown as TextModelAdapter } as unknown as Parameters<typeof reviewPictureBookManuscript>[0];
  return { options, generateJson };
}

it("recovers Premium's malformed review tail while retaining the 28 completed reviews and page 29 finding", async () => {
  const original = fixture.response.pages[28];
  const repaired = { ...clean(29), score: original.score, findings: original.findings,
    storyExtract: { storyDelta: { ...original.storyExtract.storyDelta, promisesPaid: original.storyExtract.promisesPaid }, contradictions: [] } };
  const { options, generateJson } = setup([fixture.response, { pages: [clean(30)], auxiliaryCorrections: [
    { id: "page:29", storyExtract: repaired.storyExtract, styleAudit: repaired.styleAudit }
  ] }]);
  const checkpoints: PictureBookReviewCheckpoint[] = [];
  options.onCheckpoint = async (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); };
  const result = await reviewPictureBookManuscript(options);
  expect(result).toHaveLength(30);
  expect(generateJson).toHaveBeenCalledTimes(2);
  expect(checkpoints[1]).toMatchObject({ unresolvedPageIndexes: [29, 30], roundsStarted: 1, attemptsUsed: 1 });
  expect(result.slice(0, 28)).toEqual(checkpoints[1]!.reviews);
  expect(result[28]).toMatchObject({ report: { approved: false, score: 88 }, findings: original.findings });
  const request = JSON.parse(generateJson.mock.calls[1]![0].messages.find((message) => message.role === "user")!.content);
  expect(request.reviewPageIndexes).toEqual([30]);
  expect(request.auxiliaryRecovery.rows).toEqual([{ id: "page:29", pageIndex: 29, requiredFields: ["storyExtract", "styleAudit"], findings: original.findings }]);
  expect(checkpoints.at(-1)).toMatchObject({ unresolvedPageIndexes: [], protocolIssues: [], attemptsUsed: 2 });
});

it.each([null, "malformed tail", { score: 90 }, { ...clean(2), pageIndex: "2" }, clean(99)])(
  "recovers a missing page after the provider returns an unaddressable row: %j", async (badRow) => {
    const { options, generateJson } = setup([{ pages: [clean(1), badRow] }, { pages: [clean(2)] }]);
    options.pages = fixture.pages.slice(0, 2);
    const result = await reviewPictureBookManuscript(options);
    expect(result.map((review) => review.pageIndex)).toEqual([1, 2]);
    expect(generateJson).toHaveBeenCalledTimes(2);
  }
);

it("cannot turn Premium's valid page 29 finding into approval when completing its other checks", async () => {
  const { options, generateJson } = setup([fixture.response, { pages: [clean(30)], auxiliaryCorrections: [
    { id: "page:29", storyExtract: "no_changes", styleAudit: "clean" }
  ] }]);
  const result = await reviewPictureBookManuscript(options);
  expect(result[28]).toMatchObject({ report: { approved: false, score: 88 }, findings: fixture.response.pages[28].findings });
  const request = JSON.parse(generateJson.mock.calls[1]![0].messages.find((message) => message.role === "user")!.content);
  expect(request.auxiliaryRecovery.rows).toEqual([{ id: "page:29", pageIndex: 29, requiredFields: ["storyExtract", "styleAudit"], findings: fixture.response.pages[28].findings }]);
  expect(request.priorProtocolIssues).toEqual(["Response contains a row without a valid page index."]);
});

it.each([
  { pages: [] },
  { pages: [clean(30), "another malformed fragment"] },
  { pages: [clean(30), clean(30)] }
])("still rejects an incomplete or malformed recovery without replenishing attempts: %j", async (recovery) => {
  const { options, generateJson } = setup([fixture.response, { ...recovery, auxiliaryCorrections: [
    { id: "page:29", storyExtract: "no_changes", styleAudit: "clean" }
  ] }]);
  let saved!: PictureBookReviewCheckpoint;
  options.onCheckpoint = async (checkpoint) => { saved = structuredClone(checkpoint); };
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(saved).toMatchObject({ roundsStarted: 2, attemptsUsed: 2 });
  await expect(reviewPictureBookManuscript({ ...options, resume: saved })).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(generateJson).toHaveBeenCalledTimes(2);
});

it("honors the shared physical attempt cap even when protocol recovery is needed", async () => {
  const { options, generateJson } = setup([fixture.response]);
  generateJson.mockImplementationOnce(async (request) => {
    for (let attempt = 0; attempt < 5; attempt += 1) consumeTextAttempt(request);
    return { data: parseSchemaWithContext("Fixture", request.schema, fixture.response, request.purpose, JSON.stringify(fixture.response)) };
  });
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ checkpoint: {
    attemptsUsed: 5, unresolvedPageIndexes: [29, 30], editorialRows: [{ pageIndex: 29, findings: fixture.response.pages[28].findings }]
  } });
  expect(generateJson).toHaveBeenCalledTimes(1);
});

it("honors cancellation after a malformed response without buying recovery", async () => {
  const { options, generateJson } = setup([fixture.response]);
  const controller = new AbortController(); options.signal = controller.signal;
  options.onCheckpoint = async (checkpoint) => { if (checkpoint.attemptsUsed === 1) controller.abort(); };
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ name: "AbortError" });
  expect(generateJson).toHaveBeenCalledTimes(1);
});

it("repairs an unreadable response envelope once within the same physical attempt budget", async () => {
  const { options, generateJson } = setup([{ pages: null }, { pages: [clean(1), clean(2)] }]);
  options.pages = fixture.pages.slice(0, 2);
  let saved!: PictureBookReviewCheckpoint;
  options.onCheckpoint = async (checkpoint) => { saved = structuredClone(checkpoint); };
  await expect(reviewPictureBookManuscript(options)).resolves.toHaveLength(2);
  expect(generateJson).toHaveBeenCalledTimes(2);
  expect(saved).toMatchObject({ attemptsUsed: 2, roundsStarted: 1, unresolvedPageIndexes: [] });
});

it("stops after the bounded envelope repair fails and keeps that spend on resume", async () => {
  const { options, generateJson } = setup([{ pages: null }]);
  let saved!: PictureBookReviewCheckpoint;
  options.onCheckpoint = async (checkpoint) => { saved = structuredClone(checkpoint); };
  await expect(reviewPictureBookManuscript(options)).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(saved).toMatchObject({ attemptsUsed: 2, roundsStarted: 2 });
  await expect(reviewPictureBookManuscript({ ...options, resume: saved })).rejects.toMatchObject({ name: "PictureBookReviewIncompleteError" });
  expect(generateJson).toHaveBeenCalledTimes(2);
});
