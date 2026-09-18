import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { JEV_SELECTION } from "../adapters/generationTextModelRouting.js";
import type { DecisionRequest } from "../adapters/decisions.js";
import { createProjectSchema } from "../schemas/book.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { scanSmartUnslopCandidates } from "./smartUnslop.js";
import { confirmSmartUnslopCandidates } from "./smartUnslopDecision.js";

describe("Smart Unslop decision context", () => {
  it("keeps the whole page and every candidate, including repeat matches and hard wraps beyond rewrite excerpt limits", async () => {
    const input = createProjectSchema.parse({ prompt: "Use deliberate parallelism to teach technical distinctions.", targetPages: 8 });
    const plan = makeFallbackPlan(input);
    const markdown = [
      '> “Here\'s the thing: at its core this serves as a testament to calibration.”',
      '```text\nAt its core\n```',
      ...Array.from({ length: 6 }, (_, index) => `Device ${index} is not a\nreservoir. It is a filter.`),
      "The qualification applies only to the stated operating conditions. ".repeat(500),
      "The complete final sentence must reach the decision."
    ].join("\n\n");
    const scan = scanSmartUnslopCandidates(markdown);
    expect(scan.significant).toBe(true);
    const choose = vi.fn(async (_request: DecisionRequest) => ({
      ...JEV_SELECTION, selectedOption: "legitimate_use",
      probabilities: { legitimate_use: 0.9, contextual_defect: 0.05, needs_review: 0.05 }
    }));
    const accepted = await confirmSmartUnslopCandidates({
      scan, decisions: { resolve: async () => ({ choose }) },
      userRequest: "Keep the intentional repetitions.",
      reviewOptions: {
        input, plan, pageIndex: 2,
        draft: { title: "Filters", markdown, summary: "Technical distinctions.", continuityNotes: [] },
        previousPages: [], continuityNotes: [], textModel: new FakeTextModelAdapter(),
        styleExcerpts: ["Technical writing from the opening page."]
      }
    });
    expect(accepted).toBe(true);
    const request = choose.mock.calls[0]![0];
    const context = JSON.parse(request.context);
    expect(context.fullPage.markdown).toBe(markdown);
    expect(context.flaggedSpans).toHaveLength(6);
    expect(new Set(context.flaggedSpans.map((span: { id: string }) => span.id)).size).toBe(6);
    for (const span of context.flaggedSpans) {
      expect(context.scannedProse.slice(span.start, span.end)).toBe(span.text);
    }
    expect(context.book.readerBrief).toBe(input.prompt);
    expect(context.styleExcerpts).toEqual(["Technical writing from the opening page."]);
    expect(context.explicitReaderEditRequest).toBe("Keep the intentional repetitions.");
    expect(request.escalationPolicy).toBe("caller");
  });

  it("propagates a cancelled recordOutcome instead of returning a legitimate skip", async () => {
    const input = createProjectSchema.parse({ prompt: "Explain water treatment precisely", category: "EDUCATION", language: "en", targetPages: 8 });
    const plan = makeFallbackPlan(input);
    const markdown = [
      "The basin is not a tank. It is a settling chamber.",
      "Chlorine is not an ordinary additive. It is a timed disinfectant.",
      "The reservoir is not spare storage. It is a buffer for peak demand."
    ].join("\n\n");
    const scan = scanSmartUnslopCandidates(markdown);
    expect(scan.significant).toBe(true);
    const choose = vi.fn(async () => ({
      ...JEV_SELECTION, selectedOption: "legitimate_use",
      probabilities: { legitimate_use: 0.9, contextual_defect: 0.05, needs_review: 0.05 }
    }));
    const cancelled = new DOMException("Cancelled", "AbortError");
    const recordOutcome = vi.fn(async () => { throw cancelled; });
    await expect(confirmSmartUnslopCandidates({
      scan,
      decisions: { resolve: async () => ({ choose }), recordOutcome },
      reviewOptions: {
        input, plan, pageIndex: 2,
        draft: { title: "Treatment", markdown, summary: "Engineering distinctions.", continuityNotes: [] },
        previousPages: [], continuityNotes: [], textModel: new FakeTextModelAdapter()
      }
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(choose).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      selectedOption: "legitimate_use", rewriteAvoided: true
    }));
  });
});
