import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { chapterEpisodeSchema, dossierExcerptSchema } from "../schemas/episodes.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { fallbackChapterComposition, formPaletteFor } from "./chapterForms.js";
import { cutChapter, cutChapterTail, deletionOnlyResult, editChapter, type EditChapterOptions } from "./composedChapter.js";

const input: CreateProjectInput = {
  prompt: "A history of the river survey.", category: "HISTORY", targetPages: 12,
  complexity: 5, temperature: 0.7, language: "en",
  mediaSettings: { fullIllustrations: false, illustrationCadence: "template-driven", includeCover: false,
    coverTemplate: "auto", finalReview: true, toneProfile: "neutral" }
};
const plan = makeFallbackPlan(input);
const chapter = plan.chapters[0]!;
const original = "The survey did not establish that the dam caused the flood. The engineers recorded water levels after the rain. Their report concerned only the northern district, and its estimates remained uncertain.";
const improved = "The survey did not establish that the dam caused the flood. Engineers recorded water levels after the rain. Their report covered only the northern district, and its estimates remained uncertain.";
const clearReview = { meaning: "pass", intent: "pass", meaningReason: "The claim and its limits survive.", intentReason: "The redundant phrasing is removed." };

function fixture(candidate = improved) {
  const textModel = new FakeTextModelAdapter(input);
  const generateText = vi.spyOn(textModel, "generateText").mockResolvedValue({ text: candidate, provider: "fixture", model: "editor" });
  const generateJson = vi.spyOn(textModel, "generateJson").mockImplementation(async (request) => {
    const context = JSON.parse(request.messages[1]!.content);
    const data = { ...clearReview, ...(context.removedSpans ? { removedSpanReviews: context.removedSpans.map((span: { index: number }) => ({ index: span.index, meaning: "pass", join: "pass", retainedEvidence: "The retained passage conveys the same qualification.", joinReason: "The surviving sentences have complete local referents." })) } : {}) };
    return { data, text: JSON.stringify(data), provider: "fixture", model: "reviewer" };
  });
  const options: EditChapterOptions = {
    input, plan, chapter, textModel, markdown: original, allowExtension: false,
    stance: { thesis: "The record limits the inference.", positions: [], refusals: [], voiceSample: "The engineer read the gauge." },
    composition: fallbackChapterComposition({ chapter, startPage: 1, endPage: 1 }, formPaletteFor("analytical-history"), 0),
    chapterPageStart: 1, chapterPageEnd: 1, earlierChapters: [], continuityNotes: [], researchNotes: [],
    previousChapterTail: "The north and south districts had separate surveys.",
    readerNotes: ["Clarify the description of the report without changing its claim."]
  };
  const reviewed = () => JSON.parse(generateJson.mock.calls[0]![0].messages[1]!.content);
  const reviewSystem = () => generateJson.mock.calls[0]![0].messages[0]!.content;
  return { options, generateText, generateJson, reviewed, reviewSystem };
}

describe("chapter semantic acceptance", () => {
  it("reviews every changed line edit once, in full context, whatever its size", async () => {
    // The reviewer is the whole gate: a decision-model screen ahead of it was measured across four
    // Balanced evaluations (2026-09-19) and removed — one review saved, five retained edits passed,
    // two wrong vetoes, half its attempts provider failures.
    const test = fixture();
    const surroundingChapters = [{ index: 2, title: "Evidence", markdown: "Northern evidence. ".repeat(12_000) }];
    const continuityNotes = Array.from({ length: 400 }, (_, i) => `Continuity note ${i}: the gauge reading of that morning stands.`);
    expect(await editChapter({ ...test.options, surroundingChapters, continuityNotes })).toMatchObject({ markdown: improved, changed: true });
    expect(test.generateJson).toHaveBeenCalledOnce();
    expect(test.generateJson.mock.calls[0]![0].purpose).toBe("review-chapter-edit-acceptance");
    expect(test.reviewed()).toMatchObject({ operation: "chapter_edit", chapterIndex: chapter.index, original, candidate: improved, surroundingChapters, continuityNotes, previousChapterTail: test.options.previousChapterTail });
    expect(test.reviewSystem()).toMatch(/negation and polarity.*causal relationships.*scope.*uncertainty.*attribution.*qualifications/);
    expect(test.reviewSystem()).toContain("concrete improvement");
  });

  it.each([
    ["polarity reversal", original.replace("did not establish", "did establish")],
    ["changed causal direction", original.replace("dam caused the flood", "flood caused the dam")],
    ["lost qualification", original.replace("only the northern district", "the entire region")],
    ["lost uncertainty", original.replace("remained uncertain", "were conclusive")],
    ["changed attribution", original.replace("engineers", "mayor").replace("Their report", "His report")]
  ])("retains the original after a %s despite intact length and names", async (_name, candidate) => {
    const test = fixture(candidate);
    test.generateJson.mockResolvedValue({ provider: "fixture", model: "reviewer", text: "", data: { ...clearReview, meaning: "regression" } });
    expect(await editChapter(test.options)).toMatchObject({ markdown: original, changed: false, attempts: 1 });
    expect(test.generateJson).toHaveBeenCalledOnce();
    expect(test.reviewed()).toMatchObject({ original, candidate });
  });

  it("skips the review for unchanged or structurally invalid output", async () => {
    for (const candidate of [original, "", "Truncated.", "Foreign script. " + "漢".repeat(45)]) {
      const test = fixture(candidate);
      expect(await editChapter(test.options)).toMatchObject({ markdown: original, changed: false });
      expect(test.generateJson).not.toHaveBeenCalled();
    }
  });

  it("reviews the full chapter including quotations, code and figure stand-ins", async () => {
    const protectedText = 'The report says, “The water may rise, but we cannot establish why.”\n\n```python\nassert cause is None\n```\n\n[Figure: Northern water levels]';
    const test = fixture(`${improved}\n\n${protectedText}`);
    const draft = `${original}\n\n${protectedText}`;
    expect(await editChapter({ ...test.options, markdown: draft })).toMatchObject({ changed: true });
    expect(test.reviewed()).toMatchObject({ original: draft, candidate: `${improved}\n\n${protectedText}` });
    expect(test.reviewSystem()).toContain("exact quotations");
    expect(test.reviewSystem()).toContain("code and figure meaning");
  });

  it.each(["uncertain", "regression", "malformed", "failure"])("retains the original when the bounded contextual review is %s", async (failure) => {
    const test = fixture();
    if (failure === "failure") test.generateJson.mockRejectedValue(new Error("Unavailable"));
    else test.generateJson.mockResolvedValue({ provider: "fixture", model: "reviewer", text: "", data: failure === "malformed" ? {} : { ...clearReview, meaning: failure === "uncertain" ? "needs_review" : "regression" } });
    expect(await editChapter(test.options)).toMatchObject({ markdown: original, changed: false });
    expect(test.generateJson).toHaveBeenCalledOnce();
  });

  it.each(["before edit", "during review"])("propagates cancellation %s", async (stage) => {
    const test = fixture();
    const controller = new AbortController();
    const stop = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
    if (stage === "before edit") controller.abort(stop);
    if (stage === "during review") test.generateJson.mockRejectedValue(stop);
    await expect(editChapter({ ...test.options, signal: controller.signal })).rejects.toBe(stop);
    if (stage === "before edit") expect(test.generateText).not.toHaveBeenCalled();
  });

  it("uses correction instructions and actual evidence rather than preserving an erroneous claim", async () => {
    const before = original.replace("did not establish", "established");
    const test = fixture(original);
    const factualCorrection = {
      instructions: ["Remove the claim that the survey established causation; its passage explicitly denies this."],
      evidence: [{ id: "survey", sourceChapterIndex: 1,
        episode: chapterEpisodeSchema.parse({ title: "River survey", kind: "document", person: "Engineers", place: "Northern district", date: "1900", document: "Survey", why: "Causal limits" }),
        claims: [], sequence: [], disagreements: [], unknowns: [], reviewVersion: 2 as const,
        excerpts: [dossierExcerptSchema.parse({ id: "passage", chapterIndex: 1, episodeTitle: "River survey", documentTitle: "Survey", documentUrl: "https://example.com/survey", text: "The survey did not establish that the dam caused the flood." })]
      }]
    };
    expect(await editChapter({ ...test.options, markdown: before, factualCorrection })).toMatchObject({ markdown: original, changed: true });
    expect(test.reviewed()).toMatchObject({ original: before, candidate: original, factualCorrection });
    expect(test.reviewSystem()).toContain("Do not require an incorrect claim to survive");
    expect(test.reviewSystem()).toContain("missing usable evidence or missing instructions");
    expect(test.reviewSystem()).toContain("Inconclusive supplied evidence requires needs_review");
    expect(test.generateText.mock.calls[0]![0].messages[0]!.content).toContain("do not preserve the erroneous claim");
    // The reviewer still retains a correction it judges wrong.
    const retained = fixture(original);
    retained.generateJson.mockResolvedValue({ provider: "fixture", model: "reviewer", text: "", data: { ...clearReview, meaning: "regression" } });
    expect(await editChapter({ ...retained.options, markdown: before, factualCorrection })).toMatchObject({ markdown: before, changed: false });
    // Empty packets are unauthorized retain, not needs_review: no review at all.
    const unsupported = fixture(original);
    expect(await editChapter({ ...unsupported.options, markdown: before, factualCorrection: { instructions: factualCorrection.instructions, evidence: [] } })).toMatchObject({ markdown: before, changed: false });
    expect(await editChapter({ ...unsupported.options, markdown: before, factualCorrection: { instructions: factualCorrection.instructions, evidence: [], computations: ["  "] } })).toMatchObject({ changed: false });
    expect(unsupported.generateJson).not.toHaveBeenCalled();
  });

  it("accepts an exact computation as the evidence behind an arithmetic correction", async () => {
    // The third 100-page book: the editor corrected 2^14 ≡ 5 (mod 19) to 6 and the logarithm to 16, and a
    // decision-model screen called the changed numbers a regression twice, so the known-wrong statement
    // shipped. The reviewer, told it may redo the arithmetic, is the only judge of a correction now.
    const wrongMath = "Squaring gives \\(128^2=16384\\equiv169\\pmod{187}\\), and the chain continues.";
    const rightMath = wrongMath.replace("169", "115");
    const test = fixture(rightMath);
    const factualCorrection = { instructions: ["“128^2=16384\\equiv169\\pmod{187}”: 16384 ≡ 115 (mod 187), but the statement gives 169."], evidence: [], computations: ["16384 ≡ 115 (mod 187), but the statement gives 169."] };
    expect(await editChapter({ ...test.options, markdown: wrongMath, factualCorrection })).toMatchObject({ markdown: rightMath, changed: true });
    expect(test.generateJson).toHaveBeenCalledOnce();
    expect(test.reviewed().factualCorrection).toEqual(factualCorrection);
    expect(test.reviewSystem()).toContain("exact arithmetic in computations, which you may redo yourself");
    expect(test.generateText.mock.calls[0]![0].messages[1]!.content).toContain("16384 ≡ 115 (mod 187)");
  });

  it("disables only semantic acceptance when the gate is off", async () => {
    const test = fixture();
    expect(await editChapter({ ...test.options, semanticAcceptance: false })).toMatchObject({ changed: true });
    expect(test.generateJson).not.toHaveBeenCalled();
    test.generateText.mockResolvedValue({ text: "Cut.", provider: "fixture", model: "editor" });
    expect(await editChapter({ ...test.options, semanticAcceptance: false })).toMatchObject({ changed: false });
  });
});

// Unique sentence openings avoid the corruption detector while retaining realistic word headroom.
const body = Array.from({ length: 45 }, (_, i) => `Ledger ${i} records the water level measured by the survey team beside the northern bridge that morning.`).join(" ");
const qualification = "This association does not establish that the dam caused the flood.";
const fullDraft = `${body}\n\n${qualification}\n\nThe report ends with the measurements.`;
const cutCandidate = `${body}\n\nThe report ends with the measurements.`;

describe("deletion-only semantic acceptance", () => {
  it.each(["missing", "unclear join", "duplicate index"])("retains the original when per-span diagnosis has %s", async (failure) => {
    const test = fixture(cutCandidate);
    const span = { index: 0, meaning: "pass", join: failure === "unclear join" ? "needs_review" : "pass", retainedEvidence: "The meaning exists in the opening.", joinReason: "The portability has no local antecedent." };
    test.generateJson.mockResolvedValue({ data: { ...clearReview, removedSpanReviews: failure === "missing" ? [] : failure === "duplicate index" ? [span, span] : [span] }, text: "", provider: "fixture", model: "reviewer" });
    expect(await cutChapter({ ...test.options, markdown: fullDraft, notes: ["Remove repeated caveat"] })).toMatchObject({ changed: false, markdown: fullDraft });
  });
  it("gives the judge binding cut limits and every removed span with its new neighbors", async () => {
    const draft = `${qualification}\n\n${body}\n\n${qualification}\n\nThe first recap repeats that limitation.\n\nThe report ends with the measurements.`;
    const candidate = `${qualification}\n\n${body}\n\nThe report ends with the measurements.`;
    const test = fixture(candidate);
    await cutChapter({ ...test.options, markdown: draft, maxRemovableWords: 30, notes: ["Delete all six opening paragraphs", "Delete the repeated caveat"] });
    const context = test.reviewed();
    expect(context.operation).toBe("deletion_only_cut");
    expect(context.cutConstraints).toMatchObject({ maxRemovableWords: 30, preserveFirstParagraph: true, originalWords: expect.any(Number), candidateWords: expect.any(Number), minimumWords: expect.any(Number) });
    expect(context.removedSpans).toEqual([expect.objectContaining({ removed: `${qualification}\n\nThe first recap repeats that limitation.`, before: body, after: "The report ends with the measurements." })]);
    expect(test.reviewSystem()).toContain("feasible subset");
    expect(test.reviewSystem()).toContain("every removed span");
  });
  it("rejects deletion of an essential qualification after extractiveness and word budgets pass", async () => {
    expect(deletionOnlyResult(fullDraft, cutCandidate)).toBe(cutCandidate);
    const test = fixture(cutCandidate);
    test.generateJson.mockResolvedValue({ provider: "fixture", model: "reviewer", text: "", data: { ...clearReview, meaning: "regression" } });
    const notes = ["Remove the caveat if redundant."];
    expect(await cutChapter({ ...test.options, markdown: fullDraft, notes })).toMatchObject({ markdown: fullDraft, changed: false });
    expect(test.generateJson).toHaveBeenCalledOnce();
    expect(test.reviewed()).toMatchObject({ original: fullDraft, candidate: cutCandidate, readerNotes: notes });
  });

  it("accepts legitimate redundancy removal with the retained passage and surrounding chapters in view, whatever their size", async () => {
    const draft = `${qualification}\n\n${fullDraft}`;
    const candidate = `${qualification}\n\n${cutCandidate}`;
    for (const markdown of ["The southern district used a different survey.", "The southern district already limits the same inference. ".repeat(3_000)]) {
      const test = fixture(candidate);
      const surroundingChapters = [{ index: 2, title: "The south", markdown }];
      expect(await cutChapter({ ...test.options, markdown: draft, surroundingChapters, notes: ["Remove the repeated qualification; the first paragraph already limits the same inference."] })).toMatchObject({ markdown: candidate, changed: true });
      expect(test.generateJson).toHaveBeenCalledOnce();
      expect(test.reviewed()).toMatchObject({ original: draft, candidate, surroundingChapters });
    }
  });

  it("includes the unchanged head when judging a tail-only cut", async () => {
    const test = fixture(cutCandidate);
    const head = "The survey explicitly rules out a causal conclusion.";
    const draft = `${head}\n\n${body}\n\n${qualification}\n\nThe report ends with the measurements.`;
    expect(await cutChapterTail({ ...test.options, markdown: draft, notes: ["Remove the repeated qualification."] })).toMatchObject({ changed: true });
    expect(test.reviewed()).toMatchObject({ original: draft, candidate: `${head}\n\n${cutCandidate}` });
  });

  it.each(["unchanged", "rewritten", "over budget", "zero allowance"])("skips the review for a cut that is %s", async (kind) => {
    const test = fixture(kind === "unchanged" ? fullDraft : kind === "rewritten" ? cutCandidate.replace("northern", "southern") : cutCandidate);
    expect(await cutChapter({ ...test.options, markdown: fullDraft, notes: [], maxRemovableWords: kind === "zero allowance" ? 0 : kind === "over budget" ? 1 : 100 })).toMatchObject({ markdown: fullDraft, changed: false });
    expect(test.generateJson).not.toHaveBeenCalled();
  });

  it("skips the review with the gate off while preserving deletion-only validation", async () => {
    const test = fixture(cutCandidate);
    expect(await cutChapter({ ...test.options, markdown: fullDraft, notes: [], semanticAcceptance: false })).toMatchObject({ changed: true });
    expect(test.generateJson).not.toHaveBeenCalled();
    test.generateText.mockResolvedValue({ text: cutCandidate.replace("northern", "southern"), provider: "fixture", model: "editor" });
    expect(await cutChapter({ ...test.options, markdown: fullDraft, notes: [], semanticAcceptance: false })).toMatchObject({ changed: false });
  });
});
