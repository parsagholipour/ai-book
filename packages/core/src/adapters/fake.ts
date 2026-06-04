import { z } from "zod";
import { makeFallbackPlan } from "../prompting/templates.js";
import {
  bookPlanSchema,
  chapterBriefSchema,
  finalBookQaSchema,
  pageDraftSchema,
  pageQualityReportSchema,
  type CreateProjectInput
} from "../schemas/book.js";
import type {
  EmbeddingAdapter,
  GenerateJsonOptions,
  GenerateTextOptions,
  ImageAdapter,
  ImageRequest,
  ImageResult,
  JsonResult,
  ResearchAdapter,
  ResearchQuery,
  ResearchResult,
  TextModelAdapter,
  TextResult
} from "./types.js";

export class FakeTextModelAdapter implements TextModelAdapter {
  constructor(private readonly input?: CreateProjectInput) {}

  async generateText(options: GenerateTextOptions): Promise<TextResult> {
    return {
      text: `Drafted content for ${options.purpose ?? "book generation"}.`,
      model: "fake-model",
      provider: "fake",
      usage: { promptTokens: 1, outputTokens: 1 }
    };
  }

  async generateJson<T>(options: GenerateJsonOptions<T>): Promise<JsonResult<T>> {
    const data = this.fakeForSchema(options.schema, options);
    return {
      data: options.schema.parse(data),
      text: JSON.stringify(data),
      model: "fake-model",
      provider: "fake",
      usage: { promptTokens: 1, outputTokens: 1 }
    };
  }

  async *streamText(): AsyncGenerator<string> {
    yield "Fake streamed content.";
  }

  private fakeForSchema(schema: z.ZodTypeAny, options: GenerateJsonOptions<unknown>): unknown {
    if (options.purpose === "detect-language") {
      return fakeLanguageDetection(options);
    }

    if (schema === bookPlanSchema && this.input) {
      const plan = makeFallbackPlan(this.input);
      return {
        ...plan,
        premise: `[MOCK_AI placeholder plan] ${plan.premise}`,
        questions: [
          {
            prompt:
              "MOCK_AI is enabled, so this is a deterministic placeholder plan. How should this planning pass be handled?",
            options: [
              "Continue with the placeholder plan for local testing.",
              "Restart the API and worker without MOCK_AI=true, then regenerate.",
              "Use the placeholder plan but revise it with my notes."
            ],
            allowCustom: true
          },
          ...plan.questions
        ]
      };
    }

    if (schema === chapterBriefSchema || options.purpose === "generate-chapter-brief") {
      const pageRange = extractPageRange(options);
      const chapterIndex = extractChapterIndex(options);
      return {
        chapterIndex,
        title: `Dry Run Chapter ${chapterIndex}`,
        summary: "A deterministic chapter brief for local dry runs.",
        pages: Array.from({ length: pageRange.end - pageRange.start + 1 }, (_, index) => {
          const pageIndex = pageRange.start + index;
          return {
            pageIndex,
            chapterIndex,
            purpose: `Advance the dry-run book through event ${pageIndex}.`,
            beat: `The central subject faces a concrete turn involving ${dryRunDetail(pageIndex)}.`,
            requiredContinuity: [`Keep the central subject consistent on page ${pageIndex}.`],
            endingPressure: `Leave a clear reason for page ${pageIndex + 1} to exist.`,
            imageMoment: `A readable scene focused on ${dryRunDetail(pageIndex)}.`
          };
        }),
        continuityFocus: ["Keep page details distinct across the dry run."]
      };
    }

    if (options.purpose === "generate-page-map") {
      const targetPages = extractTargetPages(options);
      return {
        pages: Array.from({ length: targetPages }, (_, index) => {
          const pageIndex = index + 1;
          return {
            pageIndex,
            chapterIndex: extractChapterIndexForPageMap(options, pageIndex),
            purpose: `Advance the dry-run book through mapped event ${pageIndex}.`,
            beat: `The page map assigns ${dryRunDetail(pageIndex)} as the concrete turn for page ${pageIndex}.`,
            requiredContinuity: [`Preserve mapped detail ${dryRunDetail(pageIndex)}.`],
            endingPressure: `Carry page ${pageIndex}'s consequence forward.`,
            imageMoment: `A mapped illustration moment focused on ${dryRunDetail(pageIndex)}.`
          };
        })
      };
    }

    if (schema === pageDraftSchema) {
      const pageIndex = extractPageIndex(options);
      const detail = dryRunDetail(pageIndex);
      return {
        title: `Dry Run Turn ${pageIndex}`,
        markdown: dryRunMarkdown(pageIndex, detail),
        summary: `Page ${pageIndex} advances the dry-run book through ${detail}.`,
        continuityNotes: [`Page ${pageIndex} establishes ${detail} as a distinct dry-run detail.`],
        imagePrompt: `Reader-facing illustration for page ${pageIndex}: a scene centered on ${detail}.`
      };
    }

    if (
      options.purpose === "generate-whole-book" ||
      options.purpose === "generate-chapter-draft" ||
      options.purpose === "generate-page-batch"
    ) {
      const pageRange =
        options.purpose === "generate-whole-book"
          ? { start: 1, end: extractTargetPages(options) }
          : extractPageRange(options);
      return {
        pages: Array.from({ length: pageRange.end - pageRange.start + 1 }, (_, index) => {
          const pageIndex = pageRange.start + index;
          const detail = dryRunDetail(pageIndex);
          return {
            index: pageIndex,
            title: `Dry Run Turn ${pageIndex}`,
            markdown: dryRunMarkdown(pageIndex, detail),
            summary: `Page ${pageIndex} advances the dry-run book through ${detail}.`,
            continuityNotes: [`Page ${pageIndex} establishes ${detail} as a distinct dry-run detail.`],
            imagePrompt: `Reader-facing illustration for page ${pageIndex}: a scene centered on ${detail}.`
          };
        })
      };
    }

    if (schema === pageQualityReportSchema) {
      return {
        approved: true,
        score: 90,
        issues: [],
        requiredRevisions: [],
        notes: "Fake reviewer approved the deterministic dry-run page.",
        checks: {
          placeholderFree: true,
          promptLeakFree: true,
          titleClean: true,
          repetitionOk: true,
          progressionOk: true
        }
      };
    }

    if (schema === finalBookQaSchema) {
      return {
        approved: true,
        score: 90,
        issues: [],
        requiredFixes: [],
        notes: "Fake final QA approved the deterministic dry-run book."
      };
    }

    return {};
  }
}

export class FakeResearchAdapter implements ResearchAdapter {
  async search(query: ResearchQuery): Promise<ResearchResult> {
    return {
      query: query.query,
      summary: `No live search was run. Treat "${query.query}" as a research placeholder.`,
      sources: [
        {
          title: "Mock research note",
          summary: "A deterministic research placeholder for local tests and dry runs."
        }
      ]
    };
  }
}

export class FakeImageAdapter implements ImageAdapter {
  capabilities() {
    return {
      supportsReferenceImages: true,
      maxReferenceImages: 20
    };
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    const { width, height } = dimensionsForAspectRatio(request.aspectRatio);
    const isCoverArtwork = request.aspectRatio === "3:4";
    const svg = isCoverArtwork
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="#243b3a"/>
      <stop offset="0.55" stop-color="#6c8f87"/>
      <stop offset="1" stop-color="#d9b66f"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="${Math.round(width * 0.72)}" cy="${Math.round(height * 0.24)}" r="${Math.round(width * 0.18)}" fill="#f2efe7" opacity="0.72"/>
  <path d="M ${Math.round(width * 0.1)} ${Math.round(height * 0.72)} C ${Math.round(width * 0.32)} ${Math.round(height * 0.55)}, ${Math.round(width * 0.52)} ${Math.round(height * 0.85)}, ${Math.round(width * 0.92)} ${Math.round(height * 0.64)} L ${width} ${height} L 0 ${height} Z" fill="#17201f" opacity="0.72"/>
</svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#f2efe7"/>
  <rect x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.06)}" width="${Math.round(width * 0.88)}" height="${Math.round(height * 0.88)}" fill="#d9e8e2" stroke="#243b3a" stroke-width="6"/>
  <text x="${Math.round(width / 2)}" y="${Math.round(height * 0.45)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="42" fill="#243b3a">Illustration Placeholder</text>
  <text x="${Math.round(width / 2)}" y="${Math.round(height * 0.53)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#243b3a">${escapeXml(request.prompt.slice(0, 70))}</text>
</svg>`;

    return {
      provider: "fake",
      model: "fake-image",
      mimeType: "image/svg+xml",
      data: Buffer.from(svg)
    };
  }
}

export class FakeEmbeddingAdapter implements EmbeddingAdapter {
  async embed(text: string): Promise<number[]> {
    const seed = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return Array.from({ length: 768 }, (_, index) => ((seed + index * 17) % 1000) / 1000);
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;"
    };
    return entities[char] ?? char;
  });
}

function dimensionsForAspectRatio(aspectRatio: string | undefined): { width: number; height: number } {
  if (aspectRatio === "3:4") {
    return { width: 900, height: 1200 };
  }
  return { width: 1024, height: 768 };
}

function extractUserPayload(options: GenerateJsonOptions<unknown>): Record<string, unknown> {
  const userMessage = [...options.messages].reverse().find((message) => message.role === "user");
  if (!userMessage) {
    return {};
  }
  try {
    const parsed = JSON.parse(userMessage.content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fakeLanguageDetection(options: GenerateJsonOptions<unknown>): { language: string; code: string; confidence: number } {
  const payload = extractUserPayload(options);
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (/[\u0600-\u06ff]/.test(prompt)) {
    return { language: "Persian", code: "fa", confidence: 0.8 };
  }
  if (/[\u0400-\u04ff]/.test(prompt)) {
    return { language: "Russian", code: "ru", confidence: 0.8 };
  }
  if (/[\u4e00-\u9fff]/.test(prompt)) {
    return { language: "Chinese", code: "zh", confidence: 0.8 };
  }
  if (/[\u3040-\u30ff]/.test(prompt)) {
    return { language: "Japanese", code: "ja", confidence: 0.8 };
  }
  if (/[\uac00-\ud7af]/.test(prompt)) {
    return { language: "Korean", code: "ko", confidence: 0.8 };
  }
  return { language: "en", code: "en", confidence: 0.8 };
}

function extractPageIndex(options: GenerateJsonOptions<unknown>): number {
  const payload = extractUserPayload(options);
  if (typeof payload.pageIndex === "number") {
    return payload.pageIndex;
  }
  const pageBrief = payload.pageBrief;
  if (pageBrief && typeof pageBrief === "object" && !Array.isArray(pageBrief)) {
    const value = (pageBrief as Record<string, unknown>).pageIndex;
    if (typeof value === "number") {
      return value;
    }
  }
  const context = payload.context;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    const outline = (context as Record<string, unknown>).outline;
    if (typeof outline === "string") {
      const match = outline.match(/Target page\s+(\d+)/i);
      if (match?.[1]) {
        return Number(match[1]);
      }
    }
  }
  return 1;
}

function extractChapterIndex(options: GenerateJsonOptions<unknown>): number {
  const chapter = extractUserPayload(options).chapter;
  if (chapter && typeof chapter === "object" && !Array.isArray(chapter)) {
    const value = (chapter as Record<string, unknown>).index;
    if (typeof value === "number") {
      return value;
    }
  }
  return 1;
}

function extractChapterIndexForPageMap(options: GenerateJsonOptions<unknown>, pageIndex: number): number {
  const payload = extractUserPayload(options);
  const chapters = payload.chapters;
  const targetPages = extractTargetPages(options);
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return 1;
  }
  const count = chapters.length;
  const base = Math.floor(targetPages / count);
  const extra = targetPages % count;
  let start = 1;
  for (let index = 0; index < count; index += 1) {
    const length = base + (index < extra ? 1 : 0);
    const end = start + length - 1;
    if (pageIndex >= start && pageIndex <= end) {
      const chapter = chapters[index];
      if (chapter && typeof chapter === "object" && !Array.isArray(chapter)) {
        const value = (chapter as Record<string, unknown>).index;
        if (typeof value === "number") {
          return value;
        }
      }
      return index + 1;
    }
    start = end + 1;
  }
  return count;
}

function extractPageRange(options: GenerateJsonOptions<unknown>): { start: number; end: number } {
  const pageRange = extractUserPayload(options).pageRange;
  if (pageRange && typeof pageRange === "object" && !Array.isArray(pageRange)) {
    const record = pageRange as Record<string, unknown>;
    if (typeof record.start === "number" && typeof record.end === "number") {
      return { start: record.start, end: record.end };
    }
  }
  return { start: 1, end: 1 };
}

function extractTargetPages(options: GenerateJsonOptions<unknown>): number {
  const payload = extractUserPayload(options);
  const book = payload.book;
  if (book && typeof book === "object" && !Array.isArray(book)) {
    const value = (book as Record<string, unknown>).targetPages;
    if (typeof value === "number") {
      return Math.max(1, Math.floor(value));
    }
  }
  if (typeof payload.targetPages === "number") {
    return Math.max(1, Math.floor(payload.targetPages));
  }
  return 1;
}

function dryRunDetail(pageIndex: number): string {
  const details = [
    "a brass key",
    "a rain-dark window",
    "a folded letter",
    "a cracked stair",
    "a blue cup",
    "a quiet bell",
    "a chalk mark",
    "a locked drawer",
    "a warm lamp",
    "a silver thread"
  ];
  return details[(pageIndex - 1) % details.length]!;
}

function dryRunMarkdown(pageIndex: number, detail: string): string {
  const variants = [
    [
      `The morning found the central figure beside ${detail}, listening for the small change that had been building since the previous turn.`,
      "",
      "A sound, a choice, and a visible consequence arrived together. The figure tested one careful action, saw what it cost, and carried one new fact forward instead of circling the same thought.",
      "",
      `By the end of the page, ${detail} had become more than scenery: it was proof that the book had moved one step and could not simply return to where it began.`
    ],
    [
      `Near ${detail}, the central figure counted three signs that the old explanation no longer fit.`,
      "",
      "First came the missing mark. Then came the answer from someone who had stayed silent too long. Last came the choice to name the risk aloud, even though naming it changed the room.",
      "",
      "The page closes with a decision made in public, which gives the next turn a consequence to carry."
    ],
    [
      `The scene narrows to ${detail} and the hand hovering just above it.`,
      "",
      "No one moves quickly. The important change is smaller than that: a withheld sentence, a glance toward the door, a fact that stops being private. The central figure understands that waiting has become its own kind of answer.",
      "",
      "When the moment breaks, it breaks cleanly, leaving a new obligation behind."
    ],
    [
      `By dusk, ${detail} has drawn everyone back to the place they meant to avoid.`,
      "",
      "The central figure asks for the truth and receives only the part that hurts least. That is enough. A plan that sounded simple in memory turns awkward in the open air, and the page follows the awkwardness instead of skipping over it.",
      "",
      "The next page has to deal with what was admitted here."
    ],
    [
      `The central figure carries ${detail} across the threshold and notices who refuses to look at it.`,
      "",
      "That refusal changes the scene. A friend becomes uncertain, an enemy becomes useful, and a small object gathers the weight of a promise. Nothing is solved, but the direction of the book tilts.",
      "",
      "The page ends on the first step after that tilt, with the old path no longer available."
    ]
  ];
  return variants[(pageIndex - 1) % variants.length]!.join("\n");
}
