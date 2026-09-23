import { expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { dossierExcerptSchema } from "../schemas/episodes.js";
import { fallbackChapterComposition, formPaletteFor } from "./chapterForms.js";
import { composeChapter, editChapter, type EditChapterOptions } from "./composedChapter.js";

const input: CreateProjectInput = {
  prompt: "A history of the river survey.", category: "HISTORY", targetPages: 20,
  complexity: 5, temperature: 0.7, language: "en",
  mediaSettings: { fullIllustrations: false, illustrationCadence: "template-driven", includeCover: false,
    coverTemplate: "auto", finalReview: true, toneProfile: "neutral" }
};
const plan = makeFallbackPlan(input);
const chapter = plan.chapters[0]!;
const original = "The survey did not establish that the dam caused the flood. The engineers recorded water levels after the rain. Their report concerned only the northern district, and its estimates remained uncertain.";
const candidate = original.replace("The engineers recorded", "Engineers recorded");
const passage = dossierExcerptSchema.parse({ id: "source", chapterIndex: chapter.index,
  documentTitle: "Original Survey", documentUrl: "https://example.org/survey", provenanceVerified: true,
  text: "The survey did not establish causation. " + "A complete original passage with its qualifications. ".repeat(180)
});
const notes = Array.from({ length: 30 }, (_, index) => `Source ${index}: ${"Summary background for this chapter. ".repeat(400)}`);

function setup() {
  const textModel = new FakeTextModelAdapter(input);
  const text = vi.spyOn(textModel, "generateText").mockResolvedValue({ text: candidate, provider: "fixture", model: "editor" });
  const json = vi.spyOn(textModel, "generateJson").mockResolvedValue({
    data: { meaning: "pass", intent: "pass", meaningReason: "Preserved.", intentReason: "Clarified." }, text: "", provider: "fixture", model: "reviewer"
  });
  const options: EditChapterOptions = {
    input, plan, chapter, textModel, markdown: original, allowExtension: false,
    stance: { thesis: "The record limits the inference.", positions: [], refusals: [], voiceSample: "A survey." },
    composition: fallbackChapterComposition({ chapter, startPage: 1, endPage: 1 }, formPaletteFor("analytical-history"), 0),
    chapterPageStart: 1, chapterPageEnd: 1, earlierChapters: [], continuityNotes: [], researchNotes: notes,
    material: { episodes: [], excerpts: [passage] },
    factualCorrection: { instructions: ["Clarify the sentence without changing its qualification."], evidence: [], sourcePassages: [passage] }
  };
  return { options, text, json };
}

it("bounds research summaries in every compose retry, edit and acceptance prompt without spending the evidence allowance", async () => {
  const test = setup();
  await composeChapter(test.options);
  await editChapter(test.options);
  const requests = [...test.text.mock.calls.map(([request]) => request), ...test.json.mock.calls.map(([request]) => request)];
  expect(requests.some((request) => request.purpose === "review-chapter-edit-acceptance")).toBe(true);
  for (const request of requests) {
    const payload = JSON.parse(request.messages[1]!.content);
    expect(JSON.stringify(payload.researchNotes).length, request.purpose).toBeLessThanOrEqual(12_000);
    expect(payload.dossier[0].text).toBe(passage.text);
    if (payload.factualCorrection) expect(payload.factualCorrection.sourcePassages[0]).toEqual(passage);
    if (request.purpose === "review-chapter-edit-acceptance") {
      expect(payload.original).toBe(original);
      expect(payload.candidate).toBe(candidate);
    }
  }
  expect(test.options.researchNotes).toEqual(notes);
});

it("deduplicates notes before the count limit, so duplicates cannot displace a later source", async () => {
  const test = setup();
  const duplicate = "Survey: The northern district report remains qualified.";
  test.options.researchNotes = [...Array<string>(20).fill(duplicate), "Other source: The southern survey is independent."];
  await editChapter(test.options);
  for (const request of [test.text.mock.calls[0]![0], test.json.mock.calls[0]![0]]) {
    expect(JSON.parse(request.messages[1]!.content).researchNotes).toEqual([duplicate, "Other source: The southern survey is independent."]);
  }
});

it("keeps short notes byte-for-byte and deduplicates whitespace without merging different sources", async () => {
  const test = setup();
  const first = "Archive A: A qualified finding.\nA different sentence.";
  test.options.researchNotes = [" ", first, first.replace("\n", "  "), "Archive B: A qualified finding.\nA different sentence."];
  await editChapter(test.options);
  expect(JSON.parse(test.text.mock.calls[0]![0].messages[1]!.content).researchNotes)
    .toEqual([first, "Archive B: A qualified finding.\nA different sentence."]);
});

it("accounts for escaped characters and preserves whole sentences and source labels", async () => {
  const test = setup();
  const sentence = 'The record says “未確定”; the path is \\"north\\". ';
  test.options.researchNotes = Array.from({ length: 24 }, (_, i) => `Survey ${i} (https://example.org/${i}): ${sentence.repeat(100)}`);
  await editChapter(test.options);
  const result: string[] = JSON.parse(test.text.mock.calls[0]![0].messages[1]!.content).researchNotes;
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(12_000);
  expect(result).toHaveLength(18);
  for (const [i, note] of result.entries()) {
    expect(JSON.stringify(note).length).toBeLessThanOrEqual(2_000);
    expect(note).toMatch(new RegExp(`^Survey ${i} \\(https://example.org/${i}\\): `));
    expect(note).toMatch(/\. \[Summary shortened;/);
    expect(note).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
});

it("omits an over-budget indivisible sentence instead of fabricating an incomplete claim", async () => {
  const test = setup();
  test.options.researchNotes = ["Survey: " + "The finding is ".repeat(300) + "not established."];
  await editChapter(test.options);
  const result = JSON.parse(test.text.mock.calls[0]![0].messages[1]!.content).researchNotes;
  expect(result).toEqual(["Survey: [Summary omitted; consult source passages for evidence.]"]);
});
