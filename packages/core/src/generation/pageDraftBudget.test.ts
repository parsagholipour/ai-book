import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { buildContextPack } from "../context/contextPack.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { buildPageDraftMessages } from "./pageDraftMessages.js";
import type { GeneratePageOptions, PageDraftContextMode } from "./pagesShared.js";

const input: CreateProjectInput = {
  prompt: "A conservator follows a damaged map through a flooded archive.",
  category: "STORY",
  targetPages: 12,
  complexity: 6,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

const plan = makeFallbackPlan(input);

function draftOptions(pageDraftContextMode: PageDraftContextMode): GeneratePageOptions {
  const previousPage = {
    index: 1,
    title: "The Waterline",
    markdown: "Mara marks the waterline and seals the archive door behind her.",
    summary: "Mara records the rising water before entering the archive."
  };
  return {
    input,
    plan,
    chapter: plan.chapters[0],
    pageIndex: 2,
    pageDraftContextMode,
    previousSummaries: [previousPage.summary],
    previousPages: [previousPage],
    continuityNotes: ["The archive door is sealed."],
    researchNotes: ["Municipal record: the archive flooded in spring."],
    textModel: new FakeTextModelAdapter(input)
  };
}

function providerPayload(pageDraftContextMode: PageDraftContextMode) {
  const userMessage = buildPageDraftMessages(draftOptions(pageDraftContextMode)).find(
    (message) => message.role === "user"
  );
  return JSON.parse(userMessage?.content ?? "{}") as {
    context: Record<string, unknown>;
  };
}

describe("initial page-draft provider context", () => {
  it.each(["excerpted", "compact"] as const)(
    "omits diagnostic budget metadata in %s mode while retaining drafting context",
    (mode) => {
      const payload = providerPayload(mode);

      expect(payload.context).not.toHaveProperty("budget");
      expect(payload.context).toEqual(
        expect.objectContaining({
          system: expect.stringContaining(`Book: ${plan.title}`),
          outline: expect.stringContaining("Target page 2 of 12."),
          memory: expect.stringContaining("The archive door is sealed."),
          research: expect.stringContaining("Municipal record")
        })
      );
      expect(payload.context.memory).toEqual(
        expect.stringContaining(mode === "compact" ? "Page 1 — The Waterline:" : "Mara records the rising water")
      );
    }
  );

  it("retains the budget on the internal context pack for diagnostics", () => {
    const pack = buildContextPack({
      plan,
      chapter: plan.chapters[0],
      pageIndex: 2,
      targetPages: input.targetPages,
      previousSummaries: ["Mara enters the flooded archive."],
      continuityNotes: [],
      researchNotes: [],
      tokenBudget: 1_234
    });

    expect(pack.budget).toEqual({
      requestedTokens: 1_234,
      approximateTokens: expect.any(Number)
    });
  });
});
