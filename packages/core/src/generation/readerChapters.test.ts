import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  JsonResult,
  TextModelAdapter,
  TextResult,
  ToolCallsResult
} from "../adapters/types.js";
import type { MarkdownPage } from "./markdown.js";
import { createReaderChaptersForExport, readerChapterFingerprint } from "./readerChapters.js";

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

    const { chapters, source } = await createReaderChaptersForExport({
      input,
      plan: makeFallbackPlan(input),
      pages,
      textModel
    });

    expect(textModel.calls).toBe(1);
    // Page-level chapters are rejected, so this is the deterministic grouping
    // standing in — the caller must not cache it and pin a rejected answer.
    expect(source).toBe("fallback");
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    expect(chapters.length).toBeLessThan(10);
    expect(chapters.every((chapter) => chapter.endPageIndex - chapter.startPageIndex + 1 > 1)).toBe(true);
    expect(chapters[0]?.startPageIndex).toBe(1);
    expect(chapters[chapters.length - 1]?.endPageIndex).toBe(10);
  });

  it("reports a usable model answer as cacheable, including an empty one", async () => {
    const input = inputForPages(12);
    const valid = new StaticJsonTextModel({
      chapters: [
        { index: 1, title: "First Movement", summary: "Opens.", startPageIndex: 1, endPageIndex: 6 },
        { index: 2, title: "Second Movement", summary: "Closes.", startPageIndex: 7, endPageIndex: 12 }
      ]
    });
    const accepted = await createReaderChaptersForExport({
      input,
      plan: makeFallbackPlan(input),
      pages: longPages(12),
      textModel: valid
    });
    expect(accepted.source).toBe("model");
    expect(accepted.chapters).toHaveLength(2);

    // A long single-arc book: the empty array is the model's real answer, and
    // it is exactly the one worth caching.
    const singleArc = await createReaderChaptersForExport({
      input,
      plan: makeFallbackPlan(input),
      pages: longPages(12),
      textModel: new StaticJsonTextModel({ chapters: [] })
    });
    expect(singleArc.source).toBe("model");
    expect(singleArc.chapters).toEqual([]);
  });

  it("does not let an unusable reply be cached as a real answer", async () => {
    // These come back as `[]` exactly as they always did — the book is
    // unchanged. What must not happen is the caller keeping them: `schema:
    // z.unknown()` accepts any JSON, so a misshaped reply is never retried, and
    // pinning it would tell this book it has no chapters for as long as its
    // text is unchanged. Before the cache existed the next compile simply asked
    // again, and it still must be able to.
    const input = inputForPages(12);
    const pages = longPages(12);

    const unreadable = [
      ["no chapters array at all", { result: "ok" }],
      ["a bare string", "no chapters here"],
      [
        "a single chapter, when the prompt asks for two to twelve or none",
        { chapters: [{ index: 1, title: "All Of It", summary: "One.", startPageIndex: 1, endPageIndex: 12 }] }
      ]
    ] as const;

    for (const [label, reply] of unreadable) {
      const result = await createReaderChaptersForExport({
        input,
        plan: makeFallbackPlan(input),
        pages,
        textModel: new StaticJsonTextModel(reply)
      });

      expect(result.chapters, label).toEqual([]);
      expect(result.source, label).toBe("rejected");
    }
  });

  it("does not chapterize short manuscripts", async () => {
    const input = inputForPages(4);
    const textModel = new ThrowingTextModel();

    const { chapters, source } = await createReaderChaptersForExport({
      input,
      plan: makeFallbackPlan(input),
      pages: longPages(4),
      textModel
    });

    expect(chapters).toEqual([]);
    expect(textModel.calls).toBe(0);
    // Cacheable: no call was needed, so nothing transient can be frozen into it.
    expect(source).toBe("model");
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

    const { chapters, source } = await createReaderChaptersForExport({
      input,
      plan: makeFallbackPlan(input),
      pages: longPages(12),
      textModel
    });

    // The caller must not cache this: the deterministic grouping only stood in
    // because the model's boundaries were rejected.
    expect(source).toBe("fallback");
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    expect(chapters[0]?.startPageIndex).toBe(1);
    expect(chapters[chapters.length - 1]?.endPageIndex).toBe(12);
    for (let index = 1; index < chapters.length; index += 1) {
      expect(chapters[index]?.startPageIndex).toBe((chapters[index - 1]?.endPageIndex ?? 0) + 1);
    }
  });
});

describe("readerChapterFingerprint", () => {
  it("is stable across calls with the same manuscript", () => {
    const input = inputForPages(10);
    const plan = makeFallbackPlan(input);
    const pages = longPages(10);

    expect(readerChapterFingerprint({ input, plan, pages })).toBe(
      readerChapterFingerprint({ input, plan, pages: [...pages].reverse() })
    );
  });

  it("changes when a page body changes", () => {
    const input = inputForPages(10);
    const plan = makeFallbackPlan(input);
    const pages = longPages(10);
    const edited = pages.map((page) =>
      page.index === 4 ? { ...page, markdown: `${page.markdown} One more sentence.` } : page
    );

    expect(readerChapterFingerprint({ input, plan, pages: edited })).not.toBe(
      readerChapterFingerprint({ input, plan, pages })
    );
  });

  it("changes when the plan's title changes", () => {
    const input = inputForPages(10);
    const plan = makeFallbackPlan(input);
    const pages = longPages(10);

    expect(readerChapterFingerprint({ input, plan: { ...plan, title: "Another Title" }, pages })).not.toBe(
      readerChapterFingerprint({ input, plan, pages })
    );
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

  generateWithTools(): Promise<ToolCallsResult> {
    return unsupportedGenerateWithTools();
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
