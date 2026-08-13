import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { generatePageDraft, generateWholeBookDraft, shouldIllustratePage } from "./pages.js";

const input: CreateProjectInput = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 10,
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

const pageMarkdown = [
  "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble before anyone touched it from the other side.",
  "",
  '"You promised you would wait," Mara said from the stairwell.',
  "",
  "Jack did not turn. The folded warrant in his coat had already warmed against his ribs, and the red wax seal had cracked where his thumb kept worrying it. Inside the chapel, someone dragged a chair across stone. That small sound decided him. He lifted the latch, stepped through, and let Mara see the scar over his left eyebrow catch the candlelight."
].join("\n");

describe("illustration cadence", () => {
  it("treats education and health as diagram-friendly nonfiction", () => {
    const educationInput = { ...input, category: "EDUCATION" as const };
    const healthInput = { ...input, category: "HEALTH" as const };
    const businessInput = { ...input, category: "BUSINESS" as const };

    expect(shouldIllustratePage(educationInput, makeFallbackPlan(educationInput), 4)).toBe(true);
    expect(shouldIllustratePage(healthInput, makeFallbackPlan(healthInput), 4)).toBe(true);
    expect(shouldIllustratePage(businessInput, makeFallbackPlan(businessInput), 4)).toBe(false);
  });
});

describe("illustration prompt gating", () => {
  it("only asks for an imagePrompt on pages that will be illustrated", async () => {
    const illustrated: { request?: GenerateJsonOptions<unknown> } = {};
    const skipped: { request?: GenerateJsonOptions<unknown> } = {};
    const modelFor = (slot: { request?: GenerateJsonOptions<unknown> }): TextModelAdapter => ({
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        slot.request = options;
        return {
          data: options.schema.parse({
            title: "The Door Opens",
            markdown: pageMarkdown,
            summary: "Jack opens the chapel door.",
            continuityNotes: []
          }),
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    });

    await generatePageDraft({
      input,
      plan,
      pageIndex: 1,
      previousSummaries: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: modelFor(illustrated)
    });
    await generatePageDraft({
      input,
      plan,
      pageIndex: 2,
      previousSummaries: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: modelFor(skipped)
    });

    const illustratedSystem = illustrated.request?.messages.find((message) => message.role === "system")?.content;
    const skippedSystem = skipped.request?.messages.find((message) => message.role === "system")?.content;
    expect(illustratedSystem).toMatch(/imagePrompt for this page's illustration/i);
    expect(skippedSystem).toMatch(/Do not include imagePrompt/i);
    expect(skippedSystem).not.toMatch(/exact character names/i);
  });

  it("names the illustrated indexes in a whole-book draft prompt", async () => {
    let systemPrompt = "";
    const model: TextModelAdapter = {
      async generateText() {
        return { text: "", model: "test-model", provider: "test" };
      },
      async generateJson(options) {
        systemPrompt = options.messages[0]?.content ?? "";
        const pages = Array.from({ length: 5 }, (_, index) => ({
          index: index + 1,
          title: `Turn ${index + 1}`,
          markdown: pageMarkdown,
          summary: `Page ${index + 1} advances the story.`,
          continuityNotes: []
        }));
        return {
          data: options.schema.parse({ pages }),
          text: "",
          model: "test-model",
          provider: "test"
        };
      },
      async *streamText() {
        yield "";
      },
      generateWithTools: unsupportedGenerateWithTools
    };

    await generateWholeBookDraft({
      input: { ...input, targetPages: 5 },
      plan: makeFallbackPlan({ ...input, targetPages: 5 }),
      researchNotes: [],
      textModel: model
    });

    expect(systemPrompt).toMatch(/Only include imagePrompt on page 1/i);
    expect(systemPrompt).not.toMatch(/optional imagePrompt/i);
  });
});
