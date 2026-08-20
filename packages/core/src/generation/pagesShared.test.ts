import { describe, expect, it } from "vitest";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type { TextModelAdapter } from "../adapters/types.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { generateBatchDraft, generateChapterDraft } from "./pages.js";
import {
  missingStyleLockIndexes,
  pagesForStyleExcerpts,
  pinStyleExcerpts,
  sampleExcerptsFromInput,
  type PriorPageContext
} from "./pagesShared.js";

function page(index: number, voice: string): PriorPageContext {
  return {
    index,
    title: `Page ${index}`,
    markdown: `${voice} ${"prose ".repeat(20)}`,
    summary: `Summary ${index}`
  };
}

describe("pinStyleExcerpts", () => {
  it("excerpts the two lowest-index pages even when they are not first in the array", () => {
    const excerpts = pinStyleExcerpts([
      page(17, "seventeen-window"),
      page(18, "eighteen-window"),
      page(1, "opening-voice"),
      page(2, "second-voice")
    ]);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("opening-voice");
    expect(excerpts[1]).toContain("second-voice");
    expect(excerpts.join(" ")).not.toMatch(/seventeen-window|eighteen-window/);
  });

  it("cannot invent pages 1 and 2 when only later pages are present", () => {
    const excerpts = pinStyleExcerpts([page(17, "seventeen-window"), page(18, "eighteen-window")]);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[0]).toContain("seventeen-window");
    expect(excerpts[1]).toContain("eighteen-window");
  });
});

describe("sampleExcerptsFromInput", () => {
  const baseInput = {
    prompt: "A story.",
    category: "STORY",
    targetPages: 8,
    complexity: 5,
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
  } as CreateProjectInput;

  it("returns mediaSettings.mobile.import.styleProfile.sampleExcerpts", () => {
    const excerpts = sampleExcerptsFromInput({
      ...baseInput,
      mediaSettings: {
        ...baseInput.mediaSettings,
        mobile: {
          import: {
            styleProfile: {
              sampleExcerpts: ["Opening cadence.", "Second voice.", ""]
            }
          }
        }
      }
    } as CreateProjectInput);
    expect(excerpts).toEqual(["Opening cadence.", "Second voice."]);
  });

  it("yields an empty list when mobile is missing", () => {
    expect(sampleExcerptsFromInput(baseInput)).toEqual([]);
  });
});

describe("style lock helpers", () => {
  it("names indexes 1 and 2 as missing from a page-21 recency window", () => {
    const recency = Array.from({ length: 18 }, (_, offset) => ({ index: offset + 3 }));
    expect(missingStyleLockIndexes(recency, 21)).toEqual([1, 2]);
  });

  it("names only index 1 as missing when the window still holds page 2", () => {
    const recency = Array.from({ length: 18 }, (_, offset) => ({ index: offset + 2 }));
    expect(missingStyleLockIndexes(recency, 20)).toEqual([1]);
  });

  it("concatenates loaded pages 1–2 for excerpts without replacing the recency window", () => {
    const recency = [page(17, "seventeen-window"), page(18, "eighteen-window")];
    const lock = [page(1, "opening-voice"), page(2, "second-voice")];
    const merged = pagesForStyleExcerpts(recency, lock);
    expect(merged.map((entry) => entry.index)).toEqual([1, 2, 17, 18]);
    expect(recency.map((entry) => entry.index)).toEqual([17, 18]);
    expect(pinStyleExcerpts(merged)[0]).toContain("opening-voice");
    expect(pinStyleExcerpts(merged)[1]).toContain("second-voice");
  });
});

describe("chapter and batch draft style excerpts", () => {
  const input = {
    prompt: "A story.",
    category: "STORY",
    targetPages: 10,
    complexity: 5,
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
  } as CreateProjectInput;
  const plan = makeFallbackPlan(input);
  const excerpts = ["Opening voice.", "Second page voice."];
  const markdown =
    "The chapel door had been painted black so many times that the grain underneath looked bruised. Jack pressed two fingers to the iron latch and felt it tremble.";

  function capturingModel(pages: Array<{ index: number; title: string; markdown: string; summary: string; continuityNotes: string[] }>) {
    const capture: { payload?: Record<string, unknown>; model: TextModelAdapter } = {
      model: {
        async generateText() {
          return { text: "", model: "test-model", provider: "test" };
        },
        async generateJson(options) {
          capture.payload = JSON.parse(options.messages[1]?.content ?? "{}") as Record<string, unknown>;
          return { data: options.schema.parse({ pages }), text: "{}", model: "test-model", provider: "test" };
        },
        async *streamText() {
          yield "";
        },
        generateWithTools: unsupportedGenerateWithTools
      }
    };
    return capture;
  }

  it("includes the excerpts in the user payload only when they are nonempty", async () => {
    const withExcerpts = capturingModel([
      { index: 2, title: "Turn", markdown, summary: "Jack moves.", continuityNotes: [] }
    ]);
    await generateChapterDraft({
      input,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 2,
      chapterPageEnd: 2,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      styleExcerpts: excerpts,
      textModel: withExcerpts.model
    });
    expect(withExcerpts.payload?.styleExcerpts).toEqual(excerpts);

    const omitted = capturingModel([
      { index: 2, title: "Turn", markdown, summary: "Jack moves.", continuityNotes: [] }
    ]);
    await generateChapterDraft({
      input,
      plan,
      chapter: plan.chapters[0]!,
      chapterPageStart: 2,
      chapterPageEnd: 2,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      textModel: omitted.model
    });
    expect(omitted.payload).not.toHaveProperty("styleExcerpts");

    const batch = capturingModel([
      { index: 4, title: "Turn", markdown, summary: "Jack moves.", continuityNotes: [] }
    ]);
    await generateBatchDraft({
      input,
      plan,
      chapterBriefs: [],
      pageStart: 4,
      pageEnd: 4,
      previousPages: [],
      continuityNotes: [],
      researchNotes: [],
      styleExcerpts: excerpts,
      textModel: batch.model
    });
    expect(batch.payload?.styleExcerpts).toEqual(excerpts);
  });
});
