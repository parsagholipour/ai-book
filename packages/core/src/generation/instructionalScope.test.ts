import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import type { GenerateJsonOptions, GenerateTextOptions } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import type { InstructionalToolkit } from "../schemas/instructional.js";
import { RHYTHM_EXEMPLAR } from "./authorStance.js";
import { fallbackChapterComposition, formPaletteFor } from "./chapterForms.js";
import { composeChapter, editChapter, type ComposeChapterOptions } from "./composedChapter.js";
import { planEpisodes } from "./episodes.js";
import { EXAMPLE_PEOPLE_RULE, TOOLKIT_EXEMPLAR, TOOLKIT_LAYOUT_RULE, TOOLKIT_SHAPE_RULES, usesToolkit } from "./instructionalBook.js";
import { inferWritingMode } from "./styleContract.js";

/**
 * Narrative, history, children's and every other book off the toolkit path
 * compose exactly as they did. The toolkit reaches a prompt only through
 * `activeToolkit`, so for each of these books a prompt built with a toolkit
 * handed in is byte-identical to one built without it, and carries none of the
 * toolkit's sentences. A practical guide with a toolkit is the positive control.
 */

function input(category: CreateProjectInput["category"], prompt: string, mobile?: Record<string, unknown>): CreateProjectInput {
  return {
    prompt,
    category,
    targetPages: 12,
    complexity: 5,
    temperature: 0.7,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "manual",
      includeCover: false,
      coverTemplate: "auto",
      finalReview: false,
      toneProfile: "neutral",
      ...(mobile ? { mobile } : {})
    }
  } as CreateProjectInput;
}

const OFF_PATH: Array<[string, CreateProjectInput]> = [
  ["a history", input("HISTORY", "A history of the shipping container.")],
  ["a novel", input("STORY", "A novel about a lighthouse keeper.", { bookTypeChoice: "adult_story" })],
  ["a children's book", input("KIDS", "A bedtime story about a fox.", { bookTypeChoice: "children_story" })],
  ["a business history filed under Business", input("BUSINESS", "A history of Nokia, from rubber boots to phones.", { bookTypeChoice: "lead_magnet" })],
  ["a guide the reader did not choose as one", input("BUSINESS", "A practical guide to pricing your work.", { bookTypeChoice: "offer_guide" })]
];

const TOOLKIT: InstructionalToolkit = {
  kind: "guide",
  setting: { country: "United States", year: "2026" },
  caveats: [{ text: "Use your formal reporting channel for harassment.", chapterIndex: 1 }],
  rules: ["The agenda runs 25 minutes."]
};

const TOOLKIT_MARKERS = [TOOLKIT_LAYOUT_RULE, EXAMPLE_PEOPLE_RULE, TOOLKIT_SHAPE_RULES[0]!, TOOLKIT_EXEMPLAR.slice(0, 60), "bookRules", "cautions", "setting is fixed"];

function recordingModel(bookInput: CreateProjectInput) {
  const fake = new FakeTextModelAdapter(bookInput);
  const seen: string[] = [];
  const model = new FakeTextModelAdapter(bookInput);
  model.generateText = async (options: GenerateTextOptions) => {
    seen.push(options.messages.map((message) => `${message.role}: ${message.content}`).join("\n"));
    return fake.generateText(options);
  };
  model.generateJson = async <T,>(options: GenerateJsonOptions<T>) => {
    seen.push(options.messages.map((message) => `${message.role}: ${message.content}`).join("\n"));
    return fake.generateJson(options);
  };
  return { model, seen };
}

function composeOptions(bookInput: CreateProjectInput, plan: BookPlan, model: FakeTextModelAdapter): ComposeChapterOptions {
  const chapter = plan.chapters[0]!;
  const composition = fallbackChapterComposition({ chapter, startPage: 1, endPage: chapter.targetPages }, formPaletteFor(inferWritingMode(bookInput, plan)), 0);
  return {
    input: bookInput,
    plan,
    stance: { thesis: "A thesis.", positions: ["A position.", "Another."], refusals: [], voiceSample: "A voice sample." },
    chapter,
    composition,
    chapterPageStart: 1,
    chapterPageEnd: chapter.targetPages,
    earlierChapters: [],
    continuityNotes: [],
    researchNotes: [],
    textModel: model,
    contract: "creative",
    sourced: false,
    exampleCast: [{ name: "Maya", role: "A first-time manager.", introducedIn: 1 }]
  };
}

async function prompts(bookInput: CreateProjectInput, toolkit: InstructionalToolkit | undefined): Promise<string[]> {
  const plan = { ...makeFallbackPlan(bookInput), continuityRules: ["Keep the agenda at 25 minutes."] };
  const { model, seen } = recordingModel(bookInput);
  const options = { ...composeOptions(bookInput, plan, model), ...(toolkit ? { toolkit } : {}) };
  const draft = await composeChapter(options);
  await editChapter({ ...options, markdown: `${draft.markdown}\n\nOne more paragraph for the editor to consider.` });
  return seen;
}

describe("books off the toolkit path compose exactly as before", () => {
  for (const [label, bookInput] of OFF_PATH) {
    it(`${label}: the same prompts with or without a toolkit handed in, and none of its sentences`, async () => {
      expect(usesToolkit(bookInput, makeFallbackPlan(bookInput))).toBe(false);
      const without = await prompts(bookInput, undefined);
      const withToolkit = await prompts(bookInput, TOOLKIT);
      expect(withToolkit).toEqual(without);
      const text = without.join("\n");
      for (const marker of TOOLKIT_MARKERS) expect(text).not.toContain(marker);
      expect(text).toContain("continuityRules");
    });

    it(`${label}: plans its episodes with the prompt it always had`, async () => {
      const plan = makeFallbackPlan(bookInput);
      const { model, seen } = recordingModel(bookInput);
      await planEpisodes({ input: bookInput, plan, stance: { thesis: "t", positions: ["p", "q"], refusals: [], voiceSample: "v" }, textModel: model });
      expect(seen.join("\n")).not.toContain("A research lead is one fact");
    });
  }
});

describe("a practical guide with a toolkit is on the path", () => {
  const guide = input("BUSINESS", "Create a practical guide to one-on-one meetings.", { bookTypeChoice: "practical_guide" });

  it("gets the toolkit's layout, its example-people rule, the how-to exemplar, bookRules and its cautions — and no continuityRules", async () => {
    const text = (await prompts(guide, TOOLKIT)).join("\n");
    for (const marker of TOOLKIT_MARKERS) expect(text).toContain(marker);
    expect(text).not.toContain("continuityRules");
    expect(text).not.toContain(RHYTHM_EXEMPLAR.slice(0, 60));
  });

  it("composes as a legacy instructional book when it was planned before the toolkit existed", async () => {
    const text = (await prompts(guide, undefined)).join("\n");
    for (const marker of TOOLKIT_MARKERS) expect(text).not.toContain(marker);
    expect(text).toContain("continuityRules");
  });
});
