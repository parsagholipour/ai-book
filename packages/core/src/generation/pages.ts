import { z } from "zod";
import type { ImageAdapter, ImageFallbackMetadata, TextModelAdapter } from "../adapters/types.js";
import { isDiagramFriendlyBookCategory } from "../categories.js";
import {
  targetLanguageGenerationGuidance,
  targetLanguagePayload
} from "../prompting/language.js";
import { kidsReadingGuidanceForInput } from "../prompting/readingLevel.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import type {
  BookPlan,
  ChapterBrief,
  ChapterPlan,
  CreateProjectInput,
  PageDraft,
  PageProductionBeat
} from "../schemas/book.js";
import { pageDraftSchema } from "../schemas/book.js";
import { buildPageDraftMessages, pageDraftImagePromptGuidance } from "./pageDraftMessages.js";
import {
  GROUNDED_FACTUALITY_RULE,
  IMAGE_PROMPT_CHARACTER_RULE,
  INTERNAL_PAGE_TITLE_RULE,
  READER_FACING_PAGE_BRIEF_RULES,
  arrayLikeField,
  buildPageInstruction,
  compactPriorPages,
  isRecord,
  numberField,
  range,
  stringArrayField,
  stringField,
  styleGuidancePayload,
  unwrapModelObject,
  writerToneRules,
  type GeneratePageOptions,
  type PriorPageContext
} from "./pagesShared.js";
import { pageGetsInteriorIllustration } from "./illustrationSlots.js";
import { pageMapForRange, pageMapForWholeBookDraft } from "./pagesPageMap.js";

export { shouldIllustratePage } from "./illustrationSlots.js";

export {
  compactSummaryForQa,
  reviewPageDraftLocally,
  type LocalPageReviewOptions
} from "./pagesLocalQa.js";
export {
  generateChapterBrief,
  generateWholeBookPageMap,
  repairPageBrief,
  type GenerateChapterBriefOptions,
  type GeneratePageMapOptions,
  type RepairPageBriefOptions
} from "./pagesPageMap.js";
export {
  reviewPageDraft,
  revisePageDraft,
  runFinalBookQa,
  type FinalBookQaOptions,
  type FinalQaPage,
  type ReviewPageOptions,
  type RevisePageOptions
} from "./pagesReview.js";
export {
  pinStyleExcerpts,
  sampleExcerptsFromInput,
  buildPageInstruction,
  pagesForStyleExcerpts,
  missingStyleLockIndexes,
  STYLE_LOCK_PAGE_INDEXES,
  type GeneratePageOptions,
  type PriorPageContext
} from "./pagesShared.js";

export type GenerateImageBytesOptions = {
  image: ImageAdapter;
  prompt: string;
  /** Absent for account-level renders (a library-character portrait). */
  projectId?: string | undefined;
  pageId?: string | undefined;
  referenceImagePaths?: string[] | undefined;
  aspectRatio?: string | undefined;
};

export type GeneratedImageBytes = {
  bytes: Buffer;
  mimeType: string;
  provider: string;
  model: string;
  revisedPrompt?: string | undefined;
  fallback?: ImageFallbackMetadata | undefined;
};

export type WholeBookPageDraft = PageDraft & {
  index: number;
};

export type WholeBookPageSetDiagnostics = {
  requestedPages: number;
  acceptedPages: number;
  missingIndexes: number[];
  unexpectedIndexes: number[];
  duplicateIndexes: number[];
  renumbered: boolean;
};

export type WholeBookDraft = {
  pages: WholeBookPageDraft[];
  pageSetDiagnostics?: WholeBookPageSetDiagnostics | undefined;
};

export type GenerateWholeBookOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapterBriefs?: ChapterBrief[] | undefined;
  researchNotes: string[];
  textModel: TextModelAdapter;
};

export type GenerateChapterDraftOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  chapterBrief?: ChapterBrief | undefined;
  chapterPageStart: number;
  chapterPageEnd: number;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  researchNotes: string[];
  textModel: TextModelAdapter;
};

export type GenerateBatchDraftOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapterBriefs: ChapterBrief[];
  pageStart: number;
  pageEnd: number;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  researchNotes: string[];
  textModel: TextModelAdapter;
};

export type PolishPageOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  pageBrief?: PageProductionBeat | undefined;
  pageIndex: number;
  draft: PageDraft;
  previousPages: PriorPageContext[];
  nextPages: PriorPageContext[];
  continuityNotes: string[];
  researchNotes: string[];
  textModel: TextModelAdapter;
};

const DRAFT_PAGE_INDEX_KEYS = ["globalPageIndex", "globalIndex", "globalPage", "index", "pageIndex", "pageNumber", "page"];

const wholeBookDraftSchema = z.preprocess(
  normalizeWholeBookDraft,
  z.object({
    pages: z.array(
      z.object({
        index: z.number().int().positive(),
        title: z.string(),
        markdown: z.string(),
        summary: z.string(),
        continuityNotes: z.array(z.string()).default([]),
        imagePrompt: z.string().optional()
      })
    )
  })
);

export async function generatePageDraft(options: GeneratePageOptions): Promise<PageDraft> {
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "generate-page",
    temperature: options.input.temperature,
    maxTokens: 3000,
    schema: pageDraftSchema,
    messages: buildPageDraftMessages(options)
  });

  return pageDraftSchema.parse(result.data);
}

export async function generateWholeBookDraft(options: GenerateWholeBookOptions): Promise<WholeBookDraft> {
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "generate-whole-book",
    temperature: options.input.temperature,
    maxTokens: wholeBookMaxTokens(options.input),
    schema: wholeBookDraftSchema,
    messages: [
      {
        role: "system",
        content: [
          "Write the complete Markdown book in one pass as a human author would.",
          "Do not mention AI, prompts, plans, JSON, schemas, generation, or production instructions in reader-facing pages.",
          INTERNAL_PAGE_TITLE_RULE,
          GROUNDED_FACTUALITY_RULE,
          "Return exactly one root JSON object with a pages array.",
          ...multiPageImagePromptGuidance(options.input, 1, options.input.targetPages),
          ...READER_FACING_PAGE_BRIEF_RULES,
          "Every page must add distinct progression; do not repeat the same scene, explanation, decision, or emotional beat across pages.",
          ...targetLanguageGenerationGuidance(options.input.language),
          ...writerToneRules(options.input)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            userPrompt: options.input.prompt,
            language: targetLanguagePayload(options.input.language),
            book: {
              title: options.plan.title,
              premise: options.plan.premise,
              audience: options.plan.audience,
              targetPages: options.input.targetPages,
              category: options.input.category,
              subcategory: options.input.subcategory,
              writingComplexity: options.plan.writingComplexity,
              voiceGuide: options.plan.voiceGuide,
              antiAiRules: options.plan.antiAiRules,
              continuityRules: options.plan.continuityRules,
              styleGuidance: styleGuidancePayload(options.input)
            },
            chapters: options.plan.chapters,
            characters: options.plan.characters,
            locations: options.plan.locations,
            pageMap: options.chapterBriefs ? pageMapForWholeBookDraft(options.chapterBriefs) : undefined,
            researchNotes: options.researchNotes,
            illustrationPlan: options.plan.illustrationPlan,
            pageGuidance: {
              targetWordsPerPage: targetWordsPerPage(options.input),
              instruction: options.chapterBriefs
                ? "Use pageMap as the authoritative page-by-page production structure. Return exactly the requested page indexes from 1 through targetPages. Write finished page prose, not outline notes. Give each page a distinct page-specific title without a Page N prefix, and do not duplicate adjacent page titles. Do not put page titles or headings inside markdown."
                : "Return exactly the requested page indexes from 1 through targetPages. Write finished page prose, not outline notes. Give each page a distinct page-specific title without a Page N prefix, and do not duplicate adjacent page titles. Do not put page titles or headings inside markdown."
            }
          },
          null,
          2
        )
      }
    ]
  });

  const draft = wholeBookDraftSchema.parse(result.data);
  const normalized = normalizeWholeBookPageSet(draft.pages, options.input.targetPages);
  return {
    pages: normalized.pages,
    pageSetDiagnostics: normalized.diagnostics
  };
}

export async function generateChapterDraft(options: GenerateChapterDraftOptions): Promise<WholeBookDraft> {
  const expectedPages = range(options.chapterPageStart, options.chapterPageEnd);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "generate-chapter-draft",
    temperature: options.input.temperature,
    maxTokens: Math.min(64000, Math.max(4000, expectedPages.length * 900)),
    schema: z.unknown(),
    messages: [
      {
        role: "system",
        content: [
          "Write one complete chapter of the book as finished Markdown pages.",
          "Return exactly one root JSON object with a pages array.",
          "Return exactly the requested global page indexes, in order.",
          ...multiPageImagePromptGuidance(options.input, options.chapterPageStart, options.chapterPageEnd),
          INTERNAL_PAGE_TITLE_RULE,
          GROUNDED_FACTUALITY_RULE,
          "Do not mention AI, prompts, JSON, schemas, generation, or production instructions in reader-facing pages.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          ...targetLanguageGenerationGuidance(options.input.language),
          ...writerToneRules(options.input)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            book: {
              title: options.plan.title,
              premise: options.plan.premise,
              audience: options.plan.audience,
              targetPages: options.input.targetPages,
              category: options.input.category,
              subcategory: options.input.subcategory,
              writingComplexity: options.plan.writingComplexity,
              voiceGuide: options.plan.voiceGuide,
              antiAiRules: options.plan.antiAiRules,
              continuityRules: options.plan.continuityRules,
              styleGuidance: styleGuidancePayload(options.input)
            },
            chapter: options.chapter,
            chapterBrief: options.chapterBrief,
            characters: options.plan.characters,
            illustrationPlan: options.plan.illustrationPlan,
            pageRange: {
              start: options.chapterPageStart,
              end: options.chapterPageEnd
            },
            previousPages: compactPriorPages(options.previousPages, 6, 900),
            continuityNotes: options.continuityNotes.slice(-24),
            researchNotes: options.researchNotes.slice(0, 18),
            pageGuidance: {
              targetWordsPerPage: targetWordsPerPage(options.input),
              instruction:
                "Write finished page prose, not outline notes. Use the field named index for the exact global page number from pageRange.globalPageIndexes; do not restart at 1 inside the chapter. Keep page titles clean without a Page N prefix. Do not put page titles or headings inside markdown."
            }
          },
          null,
          2
        )
      }
    ]
  });

  return {
    pages: normalizeDraftPageSubset(wholeBookDraftSchema.parse(result.data).pages, expectedPages, "Chapter draft")
  };
}

export async function generateBatchDraft(options: GenerateBatchDraftOptions): Promise<WholeBookDraft> {
  const expectedPages = range(options.pageStart, options.pageEnd);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "generate-page-batch",
    temperature: options.input.temperature,
    maxTokens: Math.min(24000, Math.max(4000, expectedPages.length * 900)),
    schema: z.unknown(),
    messages: [
      {
        role: "system",
        content: [
          "Write a small ordered batch of finished Markdown book pages.",
          "Return exactly one root JSON object with a pages array.",
          "Return exactly the requested page indexes, in order.",
          ...multiPageImagePromptGuidance(options.input, options.pageStart, options.pageEnd),
          INTERNAL_PAGE_TITLE_RULE,
          GROUNDED_FACTUALITY_RULE,
          "Make each page advance a distinct beat and avoid repeating recent pages.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          ...targetLanguageGenerationGuidance(options.input.language),
          ...writerToneRules(options.input)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            book: {
              title: options.plan.title,
              premise: options.plan.premise,
              audience: options.plan.audience,
              targetPages: options.input.targetPages,
              category: options.input.category,
              subcategory: options.input.subcategory,
              voiceGuide: options.plan.voiceGuide,
              antiAiRules: options.plan.antiAiRules,
              styleGuidance: styleGuidancePayload(options.input)
            },
            pageRange: {
              start: options.pageStart,
              end: options.pageEnd,
              globalPageIndexes: expectedPages
            },
            characters: options.plan.characters,
            illustrationPlan: options.plan.illustrationPlan,
            pageMap: pageMapForRange(options.chapterBriefs, options.pageStart, options.pageEnd),
            previousPages: compactPriorPages(options.previousPages, 8, 900),
            continuityNotes: options.continuityNotes.slice(-24),
            researchNotes: options.researchNotes.slice(0, 18),
            pageGuidance: {
              targetWordsPerPage: targetWordsPerPage(options.input),
              instruction:
                "Write finished page prose, not outline notes. Use the field named index for the exact global page number from pageRange.globalPageIndexes; do not restart at 1 inside the batch. Keep page titles clean without a Page N prefix. Do not put page titles or headings inside markdown."
            }
          },
          null,
          2
        )
      }
    ]
  });

  return {
    pages: normalizeDraftPageSubset(wholeBookDraftSchema.parse(result.data).pages, expectedPages, "Page batch", {
      allowPartialPrefix: true
    })
  };
}

export async function polishPageDraft(options: PolishPageOptions): Promise<PageDraft> {
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "polish-page",
    temperature: Math.min(0.65, options.input.temperature),
    maxTokens: 3400,
    schema: pageDraftSchema,
    messages: [
      {
        role: "system",
        content: [
          "Polish one drafted book page into final reader-facing prose.",
          "Keep the same page-level event and continuity unless it conflicts with nearby pages.",
          "Improve specificity, prose rhythm, continuity, and progression.",
          "Return a complete replacement page, not notes.",
          INTERNAL_PAGE_TITLE_RULE,
          GROUNDED_FACTUALITY_RULE,
          "Do not mention AI, prompts, JSON, schemas, generation, or production instructions.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          ...pageDraftImagePromptGuidance(options.input, options.pageIndex),
          ...targetLanguageGenerationGuidance(options.input.language),
          ...writerToneRules(options.input)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            language: targetLanguagePayload(options.input.language),
            book: {
              title: options.plan.title,
              premise: options.plan.premise,
              audience: options.plan.audience,
              category: options.input.category,
              subcategory: options.input.subcategory,
              voiceGuide: options.plan.voiceGuide,
              antiAiRules: options.plan.antiAiRules,
              styleGuidance: styleGuidancePayload(options.input)
            },
            pageIndex: options.pageIndex,
            chapter: options.chapter,
            chapterBrief: options.chapterBrief,
            pageBrief: options.pageBrief,
            characters: options.plan.characters,
            illustrationPlan: options.plan.illustrationPlan,
            draft: options.draft,
            previousPages: compactPriorPages(options.previousPages, 4, 800),
            nextPages: compactPriorPages(options.nextPages, 3, 800),
            continuityNotes: options.continuityNotes.slice(-24),
            researchNotes: options.researchNotes.slice(0, 18),
            instruction: buildPageInstruction(options.pageIndex, options.input.targetPages)
          },
          null,
          2
        )
      }
    ]
  });

  return result.data;
}

function multiPageImagePromptGuidance(input: CreateProjectInput, from: number, to: number): string[] {
  const illustrated: number[] = [];
  for (let i = from; i <= to; i++) {
    if (pageGetsInteriorIllustration(input, i)) {
      illustrated.push(i);
    }
  }
  if (illustrated.length === 0) {
    return [
      "Every returned page must include global index, title, markdown, summary, and continuityNotes.",
      "Do not include imagePrompt on any page; none of these pages will be illustrated."
    ];
  }
  const listed = illustrated.join(", ");
  return [
    "Every returned page must include global index, title, markdown, summary, and continuityNotes.",
    `Only include imagePrompt on page${illustrated.length === 1 ? "" : "s"} ${listed}; omit it on every other page.`,
    "Images are generated later, so imagePrompt must be a separate visual prompt field and must not appear in markdown.",
    IMAGE_PROMPT_CHARACTER_RULE
  ];
}

export async function generateImageBytes(options: GenerateImageBytesOptions): Promise<GeneratedImageBytes> {
  const result = await options.image.generateImage({
    prompt: options.prompt,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    aspectRatio: options.aspectRatio ?? "4:3",
    ...(options.referenceImagePaths?.length ? { referenceImagePaths: options.referenceImagePaths } : {}),
    ...(options.pageId ? { pageId: options.pageId } : {})
  });
  const bytes = result.data ?? (result.url ? await downloadGeneratedImage(result.url) : undefined);
  if (!bytes) {
    throw new Error("Image adapter did not return image bytes or a downloadable URL.");
  }
  const output = {
    bytes,
    mimeType: result.mimeType,
    provider: result.provider,
    model: result.model,
    fallback: result.fallback
  };
  return result.revisedPrompt ? { ...output, revisedPrompt: result.revisedPrompt } : output;
}

async function downloadGeneratedImage(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image (${response.status}): ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function normalizeWholeBookDraft(value: unknown): unknown {
  const unwrapped = unwrapModelObject(value, ["wholeBook", "book", "draft", "data", "result"]);
  const pages = findWholeBookPages(unwrapped) ?? findWholeBookPages(value);
  if (!pages) {
    return unwrapped;
  }

  return {
    ...(isRecord(unwrapped) ? unwrapped : {}),
    pages: pages.map((page, index) => normalizeWholeBookPage(page, index))
  };
}

function findWholeBookPages(value: unknown): unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["pages", "bookPages", "pageDrafts", "chapters"]) {
    const candidate = arrayLikeField(value, key);
    if (!candidate) {
      continue;
    }
    if (key === "chapters") {
      const nestedPages = candidate.flatMap((chapter) => (isRecord(chapter) ? findWholeBookPages(chapter) ?? [] : []));
      if (nestedPages.length > 0) {
        return nestedPages;
      }
    } else {
      return candidate;
    }
  }

  return undefined;
}

function normalizeWholeBookPage(value: unknown, fallbackIndex: number): unknown {
  const record = isRecord(value) ? value : {};
  const title = stringField(record, ["title", "pageTitle", "heading"]) ?? `Page ${fallbackIndex + 1}`;
  const markdown =
    stringField(record, ["markdown", "body", "content", "text", "pageMarkdown"]) ??
    (typeof value === "string" ? value : "");
  const summary = stringField(record, ["summary", "synopsis", "pageSummary"]) ?? markdown.slice(0, 240);
  const continuityNotes = stringArrayField(record, ["continuityNotes", "continuity", "notes"]) ?? [];
  const imagePrompt = stringField(record, ["imagePrompt", "illustrationPrompt", "visualPrompt"]);

  return {
    index: numberField(record, DRAFT_PAGE_INDEX_KEYS) ?? fallbackIndex + 1,
    title,
    markdown,
    summary,
    continuityNotes,
    ...(imagePrompt ? { imagePrompt } : {})
  };
}

function normalizeWholeBookPageSet(
  pages: WholeBookPageDraft[],
  targetPages: number
): { pages: WholeBookPageDraft[]; diagnostics: WholeBookPageSetDiagnostics } {
  const pageCount = pages.length;
  const minimumPages = Math.ceil(targetPages * 0.5);
  const maximumPages = Math.floor(targetPages * 1.5);
  const byIndex = new Map<number, WholeBookPageDraft>();
  const duplicates = new Set<number>();
  for (const page of pages) {
    if (byIndex.has(page.index)) {
      duplicates.add(page.index);
    }
    byIndex.set(page.index, page);
  }

  const expectedIndexes = range(1, targetPages);
  const missing = expectedIndexes.filter((pageIndex) => !byIndex.has(pageIndex));
  const extra = [...byIndex.keys()].filter((pageIndex) => pageIndex < 1 || pageIndex > targetPages);
  if (pageCount < minimumPages || pageCount > maximumPages) {
    const parts = [
      `returned ${pageCount} pages; expected ${minimumPages}-${maximumPages} pages for target ${targetPages}`,
      missing.length ? `missing pages ${missing.join(", ")}` : "",
      extra.length ? `unexpected pages ${extra.join(", ")}` : "",
      duplicates.size ? `duplicate pages ${[...duplicates].join(", ")}` : ""
    ].filter(Boolean);
    throw new Error(`Whole-book generation returned an invalid page set: ${parts.join("; ")}.`);
  }

  const orderedPages = pages
    .map((page, sourceIndex) => ({ page, sourceIndex }))
    .sort((first, second) => first.page.index - second.page.index || first.sourceIndex - second.sourceIndex);
  const normalizedPages = orderedPages.map(({ page }, index) => ({ ...page, index: index + 1 }));
  const renumbered =
    targetPages !== normalizedPages.length ||
    normalizedPages.some((page, index) => page.index !== orderedPages[index]!.page.index);

  return {
    pages: normalizedPages,
    diagnostics: {
      requestedPages: targetPages,
      acceptedPages: normalizedPages.length,
      missingIndexes: missing,
      unexpectedIndexes: extra.sort((first, second) => first - second),
      duplicateIndexes: [...duplicates].sort((first, second) => first - second),
      renumbered
    }
  };
}

function normalizeDraftPageSubset(
  pages: WholeBookPageDraft[],
  expectedPages: number[],
  label: string,
  options: { allowPartialPrefix?: boolean } = {}
): WholeBookPageDraft[] {
  const normalizedPages = remapLocalDraftPageIndexes(pages, expectedPages);
  const indexes = normalizedPages.map((page) => page.index);
  const fullOrdered =
    indexes.length === expectedPages.length && indexes.every((pageIndex, index) => pageIndex === expectedPages[index]);
  const partialPrefixOrdered =
    options.allowPartialPrefix === true &&
    indexes.length > 0 &&
    indexes.length < expectedPages.length &&
    indexes.every((pageIndex, index) => pageIndex === expectedPages[index]);
  const ordered = fullOrdered || partialPrefixOrdered;
  if (!ordered) {
    throw new Error(
      `${label} returned pages out of order or outside the requested range. Expected ${expectedPages.join(", ")}; received ${indexes.join(", ")}.`
    );
  }

  const requiredPages = options.allowPartialPrefix === true ? expectedPages.slice(0, indexes.length) : expectedPages;
  const byIndex = new Map<number, WholeBookPageDraft>();
  const duplicates = new Set<number>();
  for (const page of normalizedPages) {
    if (byIndex.has(page.index)) {
      duplicates.add(page.index);
    }
    byIndex.set(page.index, page);
  }
  const missing = requiredPages.filter((pageIndex) => !byIndex.has(pageIndex));
  const extra = indexes.filter((pageIndex) => !expectedPages.includes(pageIndex));
  if (missing.length > 0 || extra.length > 0 || duplicates.size > 0) {
    const parts = [
      missing.length ? `missing pages ${missing.join(", ")}` : "",
      extra.length ? `unexpected pages ${extra.join(", ")}` : "",
      duplicates.size ? `duplicate pages ${[...duplicates].join(", ")}` : ""
    ].filter(Boolean);
    throw new Error(`${label} returned an invalid page set: ${parts.join("; ")}.`);
  }

  return normalizedPages;
}

function remapLocalDraftPageIndexes(pages: WholeBookPageDraft[], expectedPages: number[]): WholeBookPageDraft[] {
  if (pages.length === 0 || pages.length > expectedPages.length) {
    return pages;
  }

  const alreadyGlobal = pages.every((page, index) => page.index === expectedPages[index]);
  const usesLocalPageNumbers = pages.every((page, index) => page.index === index + 1);
  if (alreadyGlobal || !usesLocalPageNumbers) {
    return pages;
  }

  return pages.map((page, index) => ({ ...page, index: expectedPages[index]! }));
}

function targetWordsPerPage(input: CreateProjectInput): { min: number; max: number } {
  const kidsGuidance = kidsReadingGuidanceForInput(input);
  if (kidsGuidance) {
    return kidsGuidance.targetWordsPerPage;
  }
  if (isDiagramFriendlyBookCategory(input.category)) {
    return { min: 140, max: 360 };
  }
  return { min: 160, max: 420 };
}

const WHOLE_BOOK_MIN_OUTPUT_SAFETY_TOKENS = 16_000;
const WHOLE_BOOK_MAX_OUTPUT_SAFETY_TOKENS = 64_000;
const WHOLE_BOOK_VISIBLE_TEXT_TOKENS_PER_WORD = 3;
const WHOLE_BOOK_METADATA_TOKENS_PER_PAGE = 600;

function wholeBookMaxTokens(input: CreateProjectInput): number {
  const maxWordsPerPage = targetWordsPerPage(input).max;
  const generousTokensPerPage =
    maxWordsPerPage * WHOLE_BOOK_VISIBLE_TEXT_TOKENS_PER_WORD + WHOLE_BOOK_METADATA_TOKENS_PER_PAGE;

  // maxTokens is a runaway-output fuse, not the expected response size. The
  // visible-text multiplier is deliberately conservative for token-dense
  // languages, while the per-page allowance covers JSON, summaries,
  // continuity notes, and image prompts. Short books receive extra headroom so
  // a normal five-page draft cannot collide with the safety limit again.
  return Math.min(
    WHOLE_BOOK_MAX_OUTPUT_SAFETY_TOKENS,
    Math.max(WHOLE_BOOK_MIN_OUTPUT_SAFETY_TOKENS, input.targetPages * generousTokensPerPage)
  );
}
