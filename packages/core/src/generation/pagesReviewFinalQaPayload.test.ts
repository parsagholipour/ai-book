import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { runFinalBookQa } from "./pagesReview.js";

const input: CreateProjectInput = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 2,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral" as const
  }
};

const plan = makeFallbackPlan(input);

function chapelOpening(): string {
  return [
    "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble before anyone touched it from the other side.",
    "",
    '"You promised you would wait," Mara said from the stairwell.',
    "",
    "Jack did not turn. The folded warrant in his coat had already warmed against his ribs, and the red wax seal had cracked where his thumb kept worrying it. Inside the chapel, someone dragged a chair across stone. That small sound decided him. He lifted the latch, stepped through, and let Mara see the scar over his left eyebrow catch the candlelight."
  ].join("\n");
}

function capturingFinalQaModel(rawData: unknown): {
  model: TextModelAdapter;
  payload?: Record<string, unknown>;
  systemPrompt?: string;
} {
  const capture: { model: TextModelAdapter; payload?: Record<string, unknown>; systemPrompt?: string } = {
    model: {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        capture.systemPrompt = options.messages[0]?.content ?? "";
        capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
        return {
          data: options.schema.parse(rawData),
          text: JSON.stringify(rawData),
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    }
  };
  return capture;
}

describe("runFinalBookQa payload terminology", () => {
  it("does not describe pageMap summaries as complete compiled manuscript prose", async () => {
    const capture = capturingFinalQaModel({
      approved: true,
      score: 92,
      issues: [],
      requiredFixes: [],
      notes: "Approved."
    });

    await runFinalBookQa({
      input,
      plan,
      pages: [
        {
          index: 1,
          title: "The Wall Bell",
          markdown: chapelOpening(),
          summary: "Jack reaches the chapel door as the bell starts."
        },
        {
          index: 2,
          title: "The Ledger Room",
          markdown:
            "The ledger room smelled of tallow and wet wool. Mara spread the parish accounts across the table and set a candle at each corner so the columns would not swim. Jack read the entries twice. Somebody had paid the bell-ringer a full week's wage on a night the tower was supposed to be empty, and the signature under the payment was the priest's — dated two days after the priest had left for the coast.",
          summary: "Mara finds a payment the absent priest could not have signed."
        }
      ],
      textModel: capture.model
    });

    expect(capture.systemPrompt).toMatch(/abbreviated planning and progression context/i);
    expect(capture.systemPrompt).not.toMatch(/complete compiled Markdown/i);
    expect(capture.systemPrompt).toMatch(/Do not decide full-book repeated-page quality from pageMap summaries/i);
    expect(capture.payload?.instruction).toMatch(/did not receive the complete compiled Markdown/i);
    expect(capture.payload?.instruction).not.toMatch(/Approve only if the compiled Markdown/i);
    expect(capture.systemPrompt).toMatch(/openingPages carries the book's first page as written/i);
    expect(capture.payload?.instruction).toMatch(/openingPages is the book's first page as written/i);
    const pageMap = capture.payload?.pageMap as Array<{ summary: string }>;
    expect(pageMap[0]?.summary).toMatch(/chapel door/);
    expect(JSON.stringify(capture.payload?.pageMap)).not.toMatch(/parish accounts across the table/);
  });
});
