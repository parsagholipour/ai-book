import { describe, expect, it, vi } from "vitest";
import type { DecisionOutcome, DecisionRequest, DecisionResult } from "../adapters/decisions.js";
import { FallbackDecisionAdapter } from "../adapters/decisionRouting.js";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { JEV_SELECTION } from "../adapters/generationTextModelRouting.js";
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

function verdict(selectedOption = "pass", probabilities = {
  pass: selectedOption === "pass" ? 0.9 : 0.05,
  regression: selectedOption === "regression" ? 0.9 : 0.05,
  needs_review: selectedOption === "needs_review" ? 0.9 : 0.05
}): DecisionResult { return { ...JEV_SELECTION, selectedOption, probabilities }; }

function fixture(candidate = improved, meaning = verdict(), intent = verdict()) {
  const textModel = new FakeTextModelAdapter(input);
  const generateText = vi.spyOn(textModel, "generateText").mockResolvedValue({ text: candidate, provider: "fixture", model: "editor" });
  const generateJson = vi.spyOn(textModel, "generateJson").mockResolvedValue({ data: clearReview, text: JSON.stringify(clearReview), provider: "fixture", model: "reviewer" });
  const choose = vi.fn(async (request: DecisionRequest) => request.purpose.endsWith("-meaning") ? meaning : intent);
  const decisions = { resolve: vi.fn(async () => ({ choose })), recordOutcome: vi.fn(async (_outcome: DecisionOutcome) => {}) };
  const options: EditChapterOptions = {
    input, plan, chapter, textModel, decisions, markdown: original, allowExtension: false,
    stance: { thesis: "The record limits the inference.", positions: [], refusals: [], voiceSample: "The engineer read the gauge." },
    composition: fallbackChapterComposition({ chapter, startPage: 1, endPage: 1 }, formPaletteFor("analytical-history"), 0),
    chapterPageStart: 1, chapterPageEnd: 1, earlierChapters: [], continuityNotes: [], researchNotes: [],
    previousChapterTail: "The north and south districts had separate surveys.",
    readerNotes: ["Clarify the description of the report without changing its claim."]
  };
  return { options, generateText, generateJson, choose, decisions };
}

describe("chapter semantic acceptance", () => {
  it.each([
    ["polarity reversal", original.replace("did not establish", "did establish")],
    ["changed causal direction", original.replace("dam caused the flood", "flood caused the dam")],
    ["lost qualification", original.replace("only the northern district", "the entire region")],
    ["lost uncertainty", original.replace("remained uncertain", "were conclusive")],
    ["changed attribution", original.replace("engineers", "mayor").replace("Their report", "His report")]
  ])("retains the original after a %s despite intact length and names", async (_name, candidate) => {
    const test = fixture(candidate, verdict("regression"));
    const result = await editChapter(test.options);
    expect(result).toMatchObject({ markdown: original, changed: false, attempts: 1 });
    expect(test.choose).toHaveBeenCalledTimes(2);
    expect(test.generateJson).not.toHaveBeenCalled();
    const request = test.choose.mock.calls[0]![0];
    expect(JSON.parse(request.context)).toMatchObject({ original, candidate, previousChapterTail: test.options.previousChapterTail });
    expect(request.instructions).toMatch(/negation and polarity.*causal relationships.*scope.*uncertainty.*attribution.*qualifications/);
  });

  it("requires both independent judgments and pins the decision route once", async () => {
    const test = fixture();
    expect(await editChapter(test.options)).toMatchObject({ markdown: improved, changed: true });
    expect(test.decisions.resolve).toHaveBeenCalledOnce();
    expect(test.choose.mock.calls.map(([request]) => request.purpose)).toEqual(["accept-chapter-edit-meaning", "accept-chapter-edit-intent"]);
    expect(test.choose.mock.calls[1]![0].context).toBe(test.choose.mock.calls[0]![0].context);
    expect(test.choose.mock.calls[1]![0].instructions).toContain("concrete improvement");
    expect(test.generateJson).not.toHaveBeenCalled();
    const arbitrary = fixture(improved, verdict(), verdict("regression"));
    expect(await editChapter(arbitrary.options)).toMatchObject({ markdown: original, changed: false });
  });

  it("skips judgments and route loading for unchanged or structurally invalid output", async () => {
    for (const candidate of [original, "", "Truncated.", "Foreign script. " + "漢".repeat(45)]) {
      const test = fixture(candidate);
      expect(await editChapter(test.options)).toMatchObject({ markdown: original, changed: false });
      expect(test.decisions.resolve).not.toHaveBeenCalled();
      expect(test.generateJson).not.toHaveBeenCalled();
    }
  });

  it("reviews the full chapter including quotations, code and figure stand-ins", async () => {
    const protectedText = 'The report says, “The water may rise, but we cannot establish why.”\n\n```python\nassert cause is None\n```\n\n[Figure: Northern water levels]';
    const test = fixture(`${improved}\n\n${protectedText}`);
    const draft = `${original}\n\n${protectedText}`;
    expect(await editChapter({ ...test.options, markdown: draft })).toMatchObject({ changed: true });
    const payload = JSON.parse(test.choose.mock.calls[0]![0].context);
    expect(payload.original).toBe(draft);
    expect(payload.candidate).toBe(`${improved}\n\n${protectedText}`);
    expect(test.choose.mock.calls[0]![0].instructions).toContain("exact quotations");
    expect(test.choose.mock.calls[0]![0].instructions).toContain("code and figure meaning");
  });

  it.each([
    verdict("needs_review"),
    verdict("pass", { pass: 0.6, regression: 0.2, needs_review: 0.2 }),
    { ...verdict(), probabilities: undefined },
    verdict("unknown")
  ])("uses one contextual review for an uncertain or invalid decision", async (result) => {
    const test = fixture(improved, result);
    expect(await editChapter(test.options)).toMatchObject({ markdown: improved, changed: true });
    expect(test.generateJson).toHaveBeenCalledOnce();
    expect(test.generateJson.mock.calls[0]![0].purpose).toBe("review-chapter-edit-acceptance");
    expect(test.generateJson.mock.calls[0]![0].messages[1]!.content).toBe(test.choose.mock.calls[0]![0].context);
  });

  it.each(["disabled route", "settings failure", "provider failure"])("reviews in context after %s", async (failure) => {
    const test = fixture();
    const decisions = failure === "disabled route" ? undefined : {
      ...test.decisions, resolve: async () => {
        if (failure === "settings failure") throw new Error("Settings unavailable");
        return { choose: async () => { throw new Error("Provider unavailable"); } };
      }
    };
    expect(await editChapter({ ...test.options, decisions })).toMatchObject({ changed: true });
    expect(test.generateJson).toHaveBeenCalledOnce();
  });

  it.each(["uncertain", "regression", "malformed", "failure"])("retains the original when the bounded contextual review is %s", async (failure) => {
    const test = fixture(improved, verdict("needs_review"));
    if (failure === "failure") test.generateJson.mockRejectedValue(new Error("Unavailable"));
    else test.generateJson.mockResolvedValue({ provider: "fixture", model: "reviewer", text: "", data: failure === "malformed" ? {} : { ...clearReview, meaning: failure === "uncertain" ? "needs_review" : "regression" } });
    expect(await editChapter(test.options)).toMatchObject({ markdown: original, changed: false });
    expect(test.generateJson).toHaveBeenCalledOnce();
  });

  it("bypasses generic choice fallback and records physical Jev attempts", async () => {
    const test = fixture(improved, verdict("pass", { pass: 0.6, regression: 0.2, needs_review: 0.2 }));
    const genericFallback = vi.fn();
    const onAttempt = vi.fn(async () => {});
    const adapter = new FallbackDecisionAdapter({ primary: JEV_SELECTION,
      fallback: { provider: "openai", model: "fallback" }, gateWinningProbability: true, onAttempt,
      createAdapter: (selection) => selection.provider === JEV_SELECTION.provider ? { choose: test.choose } : { choose: genericFallback }
    });
    expect(await editChapter({ ...test.options, decisions: { ...test.decisions, resolve: async () => adapter } })).toMatchObject({ changed: true });
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(genericFallback).not.toHaveBeenCalled();
    expect(test.generateJson).toHaveBeenCalledOnce();
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ purpose: "accept-chapter-edit-meaning", escalationReason: "low_probability" }));
  });

  it("does not let diagnostic failures change acceptance or buy more calls", async () => {
    const test = fixture();
    test.decisions.recordOutcome.mockRejectedValue(new Error("Log unavailable"));
    expect(await editChapter(test.options)).toMatchObject({ changed: true });
    expect(test.choose).toHaveBeenCalledTimes(2);
    expect(test.generateJson).not.toHaveBeenCalled();
  });

  it.each(["before edit", "during decision", "during review", "after decision"])("propagates cancellation %s", async (stage) => {
    const test = fixture(improved, stage === "during review" ? verdict("needs_review") : verdict());
    const controller = new AbortController();
    const stop = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
    if (stage === "before edit") controller.abort(stop);
    if (stage === "during decision") test.choose.mockRejectedValue(stop);
    if (stage === "during review") test.generateJson.mockRejectedValue(stop);
    if (stage === "after decision") test.choose.mockImplementation(async () => { controller.abort(stop); return verdict(); });
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
    for (const [request] of test.choose.mock.calls) {
      expect(JSON.parse(request.context)).toMatchObject({ original: before, candidate: original, factualCorrection });
      expect(request.instructions).toContain("Do not require an incorrect claim to survive");
      expect(request.instructions).toContain("missing usable evidence or missing instructions");
      expect(request.instructions).toContain("Inconclusive supplied evidence requires needs_review");
    }
    expect(test.generateText.mock.calls[0]![0].messages[0]!.content).toContain("do not preserve the erroneous claim");
    // Empty packets are unauthorized retain, not needs_review: no Jev or review.
    const unsupported = fixture(original);
    expect(await editChapter({ ...unsupported.options, markdown: before, factualCorrection: { instructions: factualCorrection.instructions, evidence: [] } })).toMatchObject({ markdown: before, changed: false });
    expect(unsupported.choose).not.toHaveBeenCalled();
    expect(unsupported.generateJson).not.toHaveBeenCalled();
  });

  it("disables only semantic acceptance when the gate is off", async () => {
    const test = fixture(improved, verdict("regression"));
    expect(await editChapter({ ...test.options, semanticAcceptance: false })).toMatchObject({ changed: true });
    expect(test.decisions.resolve).not.toHaveBeenCalled();
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
  it("rejects deletion of an essential qualification after extractiveness and word budgets pass", async () => {
    expect(deletionOnlyResult(fullDraft, cutCandidate)).toBe(cutCandidate);
    const test = fixture(cutCandidate, verdict("regression"));
    const notes = ["Remove the caveat if redundant."];
    expect(await cutChapter({ ...test.options, markdown: fullDraft, notes })).toMatchObject({ markdown: fullDraft, changed: false });
    expect(test.choose).toHaveBeenCalledTimes(2);
    expect(JSON.parse(test.choose.mock.calls[0]![0].context)).toMatchObject({ original: fullDraft, candidate: cutCandidate, readerNotes: notes });
  });

  it("accepts legitimate redundancy removal with the retained passage and surrounding chapters in view", async () => {
    const draft = `${qualification}\n\n${fullDraft}`;
    const candidate = `${qualification}\n\n${cutCandidate}`;
    const test = fixture(candidate);
    const surroundingChapters = [{ index: 2, title: "The south", markdown: "The southern district used a different survey." }];
    expect(await cutChapter({ ...test.options, markdown: draft, surroundingChapters, notes: ["Remove the repeated qualification; the first paragraph already limits the same inference."] })).toMatchObject({ markdown: candidate, changed: true });
    expect(JSON.parse(test.choose.mock.calls[0]![0].context)).toMatchObject({ original: draft, candidate, surroundingChapters });
  });

  it("includes the unchanged head when judging a tail-only cut", async () => {
    const test = fixture(cutCandidate);
    const head = "The survey explicitly rules out a causal conclusion.";
    const draft = `${head}\n\n${body}\n\n${qualification}\n\nThe report ends with the measurements.`;
    expect(await cutChapterTail({ ...test.options, markdown: draft, notes: ["Remove the repeated qualification."] })).toMatchObject({ changed: true });
    expect(JSON.parse(test.choose.mock.calls[0]![0].context)).toMatchObject({ original: draft, candidate: `${head}\n\n${cutCandidate}` });
  });

  it.each(["unchanged", "rewritten", "over budget", "zero allowance"])("skips judgments for a cut that is %s", async (kind) => {
    const test = fixture(kind === "unchanged" ? fullDraft : kind === "rewritten" ? cutCandidate.replace("northern", "southern") : cutCandidate);
    expect(await cutChapter({ ...test.options, markdown: fullDraft, notes: [], maxRemovableWords: kind === "zero allowance" ? 0 : kind === "over budget" ? 1 : 100 })).toMatchObject({ markdown: fullDraft, changed: false });
    expect(test.choose).not.toHaveBeenCalled();
    expect(test.generateJson).not.toHaveBeenCalled();
  });

  it("skips semantic calls with the gate off while preserving deletion-only validation", async () => {
    const test = fixture(cutCandidate, verdict("regression"));
    expect(await cutChapter({ ...test.options, markdown: fullDraft, notes: [], semanticAcceptance: false })).toMatchObject({ changed: true });
    expect(test.decisions.resolve).not.toHaveBeenCalled();
    test.generateText.mockResolvedValue({ text: cutCandidate.replace("northern", "southern"), provider: "fixture", model: "editor" });
    expect(await cutChapter({ ...test.options, markdown: fullDraft, notes: [], semanticAcceptance: false })).toMatchObject({ changed: false });
  });
});
