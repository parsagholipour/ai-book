import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { DecisionRequest, DecisionResult } from "../adapters/decisions.js";
import { FallbackDecisionAdapter } from "../adapters/decisionRouting.js";
import { JEV_SELECTION } from "../adapters/generationTextModelRouting.js";
import { SourceAwareTextModel, SourceEvidenceContext } from "../sources/generation.js";
import { sourceCitation, type SourcePassage, type SourceService } from "../sources/types.js";
import { checkChangedPageGrounding } from "./changedPageGrounding.js";

const original = { title: "Trial findings", markdown: "The North team reported that the treatment may help. The trial did not measure recovery rates." };
const notes = ["North trial report, results: The small trial suggests a possible benefit. Recovery rates were not measured. The East team did not conduct this trial."];
function verdict(selectedOption = "supported", probability = 0.94): DecisionResult {
  return { ...JEV_SELECTION, selectedOption, probabilities: Object.fromEntries(
    ["supported", "defect", "insufficient_context"].map((id) => [id, id === selectedOption ? probability : (1 - probability) / 2])
  ) };
}
function fixture(result = verdict()) {
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockResolvedValue({ data: {
    groundedOk: false, unsupportedClaims: ["The candidate claims a measured recovery rate; remove it because the trial did not measure recovery."]
  }, text: "", provider: "fake", model: "fake" });
  const choose = vi.fn(async (_request: DecisionRequest) => result);
  const decisions = { resolve: vi.fn(async () => ({ choose })), recordOutcome: vi.fn(async () => {}) };
  return { textModel, generate, choose, decisions, options: {
    textModel, decisions, pageIndex: 5, original,
    candidate: { ...original, markdown: "The treatment helped 94% of participants recover." }, researchNotes: notes
  } };
}

describe("changed page grounding", () => {
  it.each([
    ["statistic", "The treatment helped 94% of participants recover."],
    ["attribution", "The East team reported that the treatment may help."],
    ["certainty", "The North team proved that the treatment always helps."],
    ["uncertainty", "The North team found no basis to think the treatment could help."],
    ["contradiction", "The North team measured recovery rates."]
  ])("escalates changed %s with complete before/after text and real supplied evidence", async (_name, markdown) => {
    const test = fixture(verdict("defect"));
    const candidate = { ...original, markdown };
    expect(await checkChangedPageGrounding({ ...test.options, candidate })).toMatchObject({ groundingStatus: "failed", groundedOk: false });
    const request = test.choose.mock.calls[0]![0];
    expect(JSON.parse(JSON.parse(request.context).reviewerContext[0].content)).toEqual({ pageIndex: 5, original, candidate, researchNotes: notes });
    expect(request.escalationPolicy).toBe("caller");
    expect(request.instructions).toContain("stronger certainty OR stronger uncertainty");
    expect(request.instructions).toContain("Removing an unsupported claim");
    const diagnostic = test.generate.mock.calls[0]![0];
    expect(diagnostic.purpose).toBe("verify-page-claims");
    expect(JSON.parse(diagnostic.messages[1]!.content)).toMatchObject({ original, markdown, researchNotes: notes });
    expect(diagnostic.messages[0]!.content).toContain("concrete correction");
  });

  it("accepts removal of an unsupported statistic and records the avoided verification", async () => {
    const test = fixture();
    const result = await checkChangedPageGrounding({ ...test.options, original: test.options.candidate, candidate: original });
    expect(result).toEqual({ groundedOk: true, unsupportedClaims: [], groundingStatus: "verified" });
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.decisions.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "screen-changed-page-grounding", version: "changed-page-grounding-v1", verificationAvoided: true
    }));
  });

  it.each([verdict("insufficient_context"), verdict("supported", 0.6), { ...verdict(), probabilities: undefined }])("diagnoses uncertain or invalid confidence without a generic choice fallback", async (result) => {
    const test = fixture(result);
    const genericFallback = vi.fn();
    const route = new FallbackDecisionAdapter({
      primary: JEV_SELECTION, fallback: { provider: "openai", model: "fallback" }, gateWinningProbability: true,
      createAdapter: (selection) => selection.provider === JEV_SELECTION.provider ? { choose: test.choose } : { choose: genericFallback }
    });
    expect(await checkChangedPageGrounding({ ...test.options, decisions: { resolve: async () => route } })).toMatchObject({ groundingStatus: "failed" });
    expect(test.generate).toHaveBeenCalledOnce();
    expect(genericFallback).not.toHaveBeenCalled();
  });

  it("does not verify missing public evidence", async () => {
    const test = fixture();
    expect(await checkChangedPageGrounding({ ...test.options, researchNotes: [" "] })).toMatchObject({ groundingStatus: "unverified_no_sources" });
    expect(test.choose).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
  });

  it("freezes authorized cited passages for both the screen and diagnostic with no duplicate retrieval", async () => {
    const test = fixture(verdict("defect"));
    const passage: SourcePassage = { sourceId: "trial", version: 2, ordinal: 19, name: "North trial", locator: "Results", content: notes[0]! };
    const service: SourceService = { search: vi.fn(async () => []), overview: vi.fn(async () => []), read: vi.fn(async () => passage) };
    const wrapped = new SourceAwareTextModel(test.textModel, async () => service);
    const decisionSources = new SourceEvidenceContext(async () => { throw new Error("Must reuse the authorized pack"); });
    const result = await checkChangedPageGrounding({ ...test.options, researchNotes: [], textModel: wrapped,
      candidate: { ...original, markdown: `94% recovered. ${sourceCitation(passage)}` },
      decisions: { resolve: async () => ({ choose: async (request) => test.choose(await decisionSources.prepareDecision(request)) }) }
    });
    expect(result.groundingStatus).toBe("failed");
    expect(service.search).toHaveBeenCalledOnce();
    expect(service.read).toHaveBeenCalledExactlyOnceWith("trial", 2, 19);
    const screen = test.choose.mock.calls[0]![0];
    expect(screen.sourceContextPrepared).toBe(true);
    expect(screen.context).toContain(passage.content);
    expect(screen.context).toContain(sourceCitation(passage));
    expect(JSON.stringify(test.generate.mock.calls[0]![0].messages)).toContain(passage.content);
    expect(JSON.stringify(test.generate.mock.calls[0]![0].messages)).toContain(sourceCitation(passage));
  });

  it("does not treat a source overview as returned passage evidence", async () => {
    const test = fixture();
    const service: SourceService = { search: async () => [], overview: async () => [], read: async () => null };
    expect(await checkChangedPageGrounding({ ...test.options, researchNotes: [], textModel: new SourceAwareTextModel(test.textModel, async () => service) })).toMatchObject({ groundingStatus: "unverified_no_sources" });
    expect(test.choose).not.toHaveBeenCalled();
  });

  it("never sends evidence to a model when source authorization fails", async () => {
    const test = fixture();
    const textModel = new SourceAwareTextModel(test.textModel, async () => { throw new Error("Source version is not owned by this project"); });
    expect(await checkChangedPageGrounding({ ...test.options, textModel })).toMatchObject({ groundingStatus: "unavailable" });
    expect(test.choose).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
  });

  it.each(["route", "provider"])("uses diagnosis when %s fails", async (stage) => {
    const test = fixture();
    if (stage === "route") test.decisions.resolve.mockRejectedValue(new Error("route offline"));
    else test.choose.mockRejectedValue(new Error("Jev offline"));
    expect(await checkChangedPageGrounding(test.options)).toMatchObject({ groundingStatus: "failed" });
    expect(test.generate).toHaveBeenCalledOnce();
  });

  it("records verifier unavailability without inventing a verified pass", async () => {
    const test = fixture(verdict("defect"));
    test.generate.mockRejectedValue(new Error("verifier offline"));
    expect(await checkChangedPageGrounding(test.options)).toMatchObject({ groundingStatus: "unavailable" });
  });

  it.each(["resolve", "choose", "diagnostic", "sources"])("propagates cancellation in %s", async (stage) => {
    const test = fixture(verdict("defect"));
    const stop = Object.assign(new Error("Stopped"), { name: "StopRequestedError" });
    if (stage === "resolve") test.decisions.resolve.mockRejectedValue(stop);
    if (stage === "choose") test.choose.mockRejectedValue(stop);
    if (stage === "diagnostic") test.generate.mockRejectedValue(stop);
    const textModel = stage === "sources" ? new SourceAwareTextModel(test.textModel, async () => { throw stop; }) : test.textModel;
    await expect(checkChangedPageGrounding({ ...test.options, textModel })).rejects.toBe(stop);
    if (stage !== "diagnostic") expect(test.generate).not.toHaveBeenCalled();
  });

  it("honors an abort before spending and isolates failed outcome logging", async () => {
    const test = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(checkChangedPageGrounding({ ...test.options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(test.choose).not.toHaveBeenCalled();
    test.decisions.recordOutcome.mockRejectedValue(new Error("log offline"));
    expect(await checkChangedPageGrounding(test.options)).toMatchObject({ groundingStatus: "verified" });
    expect(test.generate).not.toHaveBeenCalled();
  });
});
