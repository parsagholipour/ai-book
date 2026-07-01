import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult
} from "../adapters/types.js";
import type { MarkdownPage } from "./markdown.js";
import { createReaderChaptersForExport } from "./readerChapters.js";

describe("createReaderChaptersForExport", () => {
  it("groups a long 10-page manuscript instead of accepting page-level chapters", async () => {
    const input = inputForPages(10);
    const pages = longPages(10);
    const textModel = new StaticJsonTextModel({
      chapters: pages.map((page) => ({
        index: page.index,
        title: `Chapter ${page.index}: ${page.title}`,
        summary: page.summary,
        startPageIndex: page.index,
        endPageIndex: page.index
      }))
    });

    const chapters = await createReaderChaptersForExport({
      input,
      plan: makeFallbackPlan(input),
      pages,
      textModel
    });

    expect(textModel.calls).toBe(1);
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    expect(chapters.length).toBeLessThan(10);
    expect(chapters.every((chapter) => chapter.endPageIndex - chapter.startPageIndex + 1 > 1)).toBe(true);
    expect(chapters[0]?.startPageIndex).toBe(1);
    expect(chapters[chapters.length - 1]?.endPageIndex).toBe(10);
  });

  it("does not chapterize short manuscripts", async () => {
    const input = inputForPages(4);
    const textModel = new ThrowingTextModel();

    const chapters = await createReaderChaptersForExport({
      input,
      plan: makeFallbackPlan(input),
      pages: longPages(4),
      textModel
    });

    expect(chapters).toEqual([]);
    expect(textModel.calls).toBe(0);
  });

  it("falls back to deterministic chapter groups when model boundaries are invalid", async () => {
    const input = inputForPages(12);
    const textModel = new StaticJsonTextModel({
      chapters: [
        {
          index: 1,
          title: "First Claim",
          summary: "Starts the manuscript.",
          startPageIndex: 1,
          endPageIndex: 6
        },
        {
          index: 2,
          title: "Overlapping Claim",
          summary: "Overlaps the prior range.",
          startPageIndex: 6,
          endPageIndex: 12
        }
      ]
    });

    const chapters = await createReaderChaptersForExport({
      input,
      plan: makeFallbackPlan(input),
      pages: longPages(12),
      textModel
    });

    expect(chapters.length).toBeGreaterThanOrEqual(2);
    expect(chapters[0]?.startPageIndex).toBe(1);
    expect(chapters[chapters.length - 1]?.endPageIndex).toBe(12);
    for (let index = 1; index < chapters.length; index += 1) {
      expect(chapters[index]?.startPageIndex).toBe((chapters[index - 1]?.endPageIndex ?? 0) + 1);
    }
  });
});

class StaticJsonTextModel implements TextModelAdapter {
  calls = 0;

  constructor(private readonly data: unknown) {}

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    return {
      text: options.messages.map((message) => message.content).join("\n"),
      model: "test-model",
      provider: "test"
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    this.calls += 1;
    const data = options.schema.parse(this.data);
    return {
      data,
      text: JSON.stringify(this.data),
      model: "test-model",
      provider: "test"
    };
  }

  async *streamText(): AsyncGenerator<string> {
    yield "";
  }
}

class ThrowingTextModel extends StaticJsonTextModel {
  constructor() {
    super({});
  }

  override async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    this.calls += 1;
    throw new Error(`Unexpected model call for ${options.purpose ?? "unknown purpose"}.`);
  }
}

function inputForPages(targetPages: number): CreateProjectInput {
  return {
    prompt: "A research-grounded nonfiction manuscript about how an argument changes across several movements.",
    category: "CUSTOM",
    targetPages,
    complexity: 5,
    temperature: 0.4,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: false,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral" as const,
      generationStrategy: "research-grounded"
    }
  };
}

function longPages(count: number): MarkdownPage[] {
  return Array.from({ length: count }, (_, index) => {
    const pageNumber = index + 1;
    const detail = `movement ${pageNumber}`;
    const body = Array.from(
      { length: 180 },
      (_, wordIndex) => `specific-${pageNumber}-${wordIndex}`
    ).join(" ");
    return {
      index: pageNumber,
      title: `The ${detail}`,
      summary: `Page ${pageNumber} develops ${detail} with a distinct claim and consequence.`,
      markdown: `This page develops ${detail}. ${body}.`
    };
  });
}
