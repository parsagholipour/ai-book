import { describe, expect, it, vi } from "vitest";
import { makeFallbackPlan } from "@book-maker/core";

import { patchPageForUserRequest } from "./textEditPatch.js";

const input = {
  prompt: "A practical guide to the algorithms working developers still need.",
  category: "CUSTOM" as const,
  targetPages: 8,
  complexity: 6,
  temperature: 0.6,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven" as const,
    includeCover: true,
    coverTemplate: "auto" as const,
    finalReview: true,
    toneProfile: "neutral" as const
  }
};
const plan = makeFallbackPlan(input as never);

const markdown = [
  "A warehouse dashboard lists outgoing packages by tracking number, and the clerk needs one of them.",
  "",
  "```pseudocode",
  "binarySearch(items, target):",
  "    low = 0",
  "```",
  "",
  "Each comparison discards half of what remains, which is why the ordering matters so much here."
].join("\n");

const jsBlock = "```javascript\nconst binarySearch = (items, target) => {\n  let low = 0;\n};\n```";

const approvedReport = {
  approved: true,
  score: 91,
  issues: [],
  requiredRevisions: [],
  notes: "Reviewer approved.",
  groundedOk: true,
  unsupportedClaims: [],
  checks: {
    placeholderFree: true,
    promptLeakFree: true,
    titleClean: true,
    repetitionOk: true,
    progressionOk: true,
    styleNatural: true
  }
};

function page(overrides: Partial<{ markdown: string; qualityReport: unknown }> = {}) {
  return {
    index: 4,
    title: "Halving the Search",
    markdown,
    summary: "Binary search on ordered tracking numbers.",
    imagePrompt: null,
    qualityReport: approvedReport,
    ...overrides
  };
}

function textModel(...replies: unknown[]) {
  const generateJson = vi.fn();
  for (const reply of replies) {
    generateJson.mockImplementationOnce(async () => ({ data: reply, text: JSON.stringify(reply) }));
  }
  return { generateJson };
}

describe("patchPageForUserRequest", () => {
  it("applies the model's replacements to the stored page and keeps its standing report", async () => {
    const model = textModel({
      outcome: "patched",
      reason: "",
      patches: [{ find: "```pseudocode\nbinarySearch(items, target):\n    low = 0\n```", replace: jsBlock }]
    });

    const outcome = await patchPageForUserRequest({
      page: page(),
      input: input as never,
      plan,
      providers: { text: model as never },
      editInstruction: "Rewrite every code block in JavaScript."
    });

    expect(outcome.kind).toBe("patched");
    if (outcome.kind !== "patched") return;
    expect(outcome.applied).toBe(1);
    expect(outcome.draft.markdown).toBe(markdown.replace(/```pseudocode[\s\S]*?```/, jsBlock));
    expect(outcome.draft.summary).toBe("Binary search on ordered tracking numbers.");
    expect(outcome.draft.qualityReport).toMatchObject({ approved: true, score: 91 });
    expect(outcome.draft.qualityReport.notes).toContain("Reviewer approved.");
    expect(outcome.draft.qualityReport.notes).toContain("1 replacement");
    const request = model.generateJson.mock.calls[0]![0] as { purpose: string; temperature: number };
    expect(request.purpose).toBe("patch-page");
    expect(request.temperature).toBe(0.2);
  });

  it("re-asks once with the failures and falls back to a whole page when the spans are still wrong", async () => {
    const miss = { outcome: "patched", reason: "", patches: [{ find: "not on the page", replace: "x" }] };
    const model = textModel(miss, miss);

    const outcome = await patchPageForUserRequest({
      page: page(),
      input: input as never,
      plan,
      providers: { text: model as never },
      editInstruction: "Rewrite every code block in JavaScript."
    });

    expect(outcome).toMatchObject({ kind: "whole_page" });
    expect(model.generateJson).toHaveBeenCalledTimes(2);
    const second = JSON.parse((model.generateJson.mock.calls[1]![0] as { messages: Array<{ content: string }> }).messages[1]!.content);
    expect(second.patchRepair).toEqual([{ find: "not on the page", reason: "not_found" }]);
  });

  it("passes the model's own declines through unchanged", async () => {
    const unchanged = await patchPageForUserRequest({
      page: page(),
      input: input as never,
      plan,
      providers: { text: textModel({ outcome: "unchanged", reason: "No code here.", patches: [] }) as never },
      editInstruction: "Rewrite every code block in JavaScript."
    });
    expect(unchanged).toEqual({ kind: "unchanged", reason: "No code here." });

    const whole = await patchPageForUserRequest({
      page: page(),
      input: input as never,
      plan,
      providers: { text: textModel({ outcome: "whole_page", reason: "It re-plots the page.", patches: [] }) as never },
      editInstruction: "Rewrite the page as a dialogue."
    });
    expect(whole).toEqual({ kind: "whole_page", reason: "It re-plots the page." });
  });

  it("keeps a FAILED_QA page's report honest and self-approves a page with no readable one", async () => {
    const patch = { outcome: "patched", reason: "", patches: [{ find: "warehouse", replace: "depot" }] };

    const failed = await patchPageForUserRequest({
      page: page({ qualityReport: { ...approvedReport, approved: false, score: 58 } }),
      input: input as never,
      plan,
      providers: { text: textModel(patch) as never },
      editInstruction: "Say depot instead of warehouse."
    });
    expect(failed.kind === "patched" && failed.draft.qualityReport.approved).toBe(false);

    const unreadable = await patchPageForUserRequest({
      page: page({ qualityReport: null }),
      input: input as never,
      plan,
      providers: { text: textModel(patch) as never },
      editInstruction: "Say depot instead of warehouse."
    });
    expect(unreadable.kind === "patched" && unreadable.draft.qualityReport).toMatchObject({ approved: true, score: 90 });
  });

  it("hands a page whose patch leaks the prompt to the whole-page path", async () => {
    const outcome = await patchPageForUserRequest({
      page: page(),
      input: input as never,
      plan,
      providers: {
        text: textModel({
          outcome: "patched",
          reason: "",
          patches: [{ find: "warehouse dashboard", replace: "warehouse dashboard on a placeholder page" }]
        }) as never
      },
      editInstruction: "Say depot instead of warehouse."
    });

    expect(outcome).toMatchObject({ kind: "whole_page", reason: expect.stringContaining("integrity") });
  });

  it("sends the adherence reviewer's omissions along on a repair", async () => {
    const model = textModel({ outcome: "patched", reason: "", patches: [{ find: "warehouse", replace: "depot" }] });

    await patchPageForUserRequest({
      page: page(),
      input: input as never,
      plan,
      providers: { text: model as never },
      editInstruction: "Say depot instead of warehouse.",
      adherenceRepair: ["The summary still says warehouse."]
    });

    const payload = JSON.parse((model.generateJson.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages[1]!.content);
    expect(payload.adherenceRepair).toEqual(["The summary still says warehouse."]);
  });
});
