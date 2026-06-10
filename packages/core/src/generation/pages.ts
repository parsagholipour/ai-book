import { z } from "zod";
import type { ImageAdapter, ImageFallbackMetadata, TextModelAdapter } from "../adapters/types.js";
import { isDiagramFriendlyBookCategory } from "../categories.js";
import { buildContextPack } from "../context/contextPack.js";
import { jailbreakImagePromptPrefix } from "../prompting/jailbreak.js";
import {
  targetLanguageGenerationGuidance,
  targetLanguagePayload,
  targetLanguageReviewGuidance
} from "../prompting/language.js";
import {
  kidsReadingGuidanceForInput,
  kidsReadingGuidanceLines,
  kidsReadingGuidancePayload
} from "../prompting/readingLevel.js";
import { plannerToneGuidance, reviewerStyleGuidance, toneProfileFromMediaSettings, writerToneGuidance } from "../prompting/tone.js";
import { generateJsonWithJailbreak } from "./generateWithJailbreak.js";
import { normalizePlanPageTargets } from "./planner.js";
import type {
  BookPlan,
  ChapterBrief,
  ChapterPlan,
  CreateProjectInput,
  FinalBookQa,
  PageDraft,
  PageProductionBeat,
  PageQualityReport
} from "../schemas/book.js";
import {
  chapterBriefSchema,
  finalBookQaSchema,
  pageDraftSchema,
  pageProductionBeatSchema,
  pageQualityReportSchema
} from "../schemas/book.js";

function isLessCensored(input: CreateProjectInput): boolean {
  return input.mediaSettings.lessCensored === true;
}

function plannerToneRules(input: CreateProjectInput): string[] {
  return [...kidsReadingGuidanceLines(input), ...plannerToneGuidance(toneProfileFromMediaSettings(input.mediaSettings))];
}

function writerToneRules(input: CreateProjectInput): string[] {
  return [...kidsReadingGuidanceLines(input), ...writerToneGuidance(toneProfileFromMediaSettings(input.mediaSettings))];
}

function reviewerStyleRules(input: CreateProjectInput): string[] {
  return [
    ...kidsReadingGuidanceLines(input).map((line) => `Reject if the page violates this reading-level rule: ${line}`),
    ...reviewerStyleGuidance()
  ];
}

const READER_FACING_PAGE_BRIEF_RULES = [
  "Treat pageBrief purpose, beat, requiredContinuity, and endingPressure as internal assignment notes; transform them into prose instead of echoing their wording.",
  'Do not write procedural phrases such as "concluding the survey", "this chapter transitions", "the next section", or "the scope of this survey" in the page.',
  "If requiredContinuity points to an earlier page, preserve consistency without re-explaining that page's concrete examples; add a new implication or consequence.",
  "When pageScope.isLastPageOfChapter is true, close with a concrete implication for the chapter's argument and let any handoff to the next chapter arise from substance, not from announcing a transition."
];

function styleGuidancePayload(input: CreateProjectInput) {
  const toneProfile = toneProfileFromMediaSettings(input.mediaSettings);
  return {
    toneProfile,
    readingGuidance: kidsReadingGuidancePayload(input),
    rules: writerToneGuidance(toneProfile)
  };
}

export type GenerateChapterBriefOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  chapterPageStart: number;
  chapterPageEnd: number;
  textModel: TextModelAdapter;
};

export type PriorPageContext = {
  index: number;
  title: string;
  markdown: string;
  summary: string;
};

export type GeneratePageOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  pageBrief?: PageProductionBeat | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  pageIndex: number;
  previousSummaries: string[];
  previousPages?: PriorPageContext[] | undefined;
  continuityNotes: string[];
  researchNotes: string[];
  /** Semantically retrieved long-range context outside the recency window. */
  semanticMemory?: string[] | undefined;
  /** Structured character/location state lines. */
  entityState?: string[] | undefined;
  textModel: TextModelAdapter;
};

export type ReviewPageOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  pageBrief?: PageProductionBeat | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  pageIndex: number;
  draft: PageDraft;
  previousPages: PriorPageContext[];
  continuityNotes: string[];
  textModel: TextModelAdapter;
};

export type RevisePageOptions = ReviewPageOptions & {
  report: PageQualityReport;
};

export type RepairPageBriefOptions = ReviewPageOptions & {
  pageBrief: PageProductionBeat;
  report: PageQualityReport;
};

export type FinalQaPage = {
  index: number;
  title: string;
  markdown: string;
  summary: string;
};

export type FinalBookQaOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  pages: FinalQaPage[];
  researchNotes?: string[] | undefined;
  textModel: TextModelAdapter;
};

type PageScopeSource = {
  input: CreateProjectInput;
  chapter?: ChapterPlan | undefined;
  chapterBrief?: ChapterBrief | undefined;
  pageBrief?: PageProductionBeat | undefined;
  chapterPageStart?: number | undefined;
  chapterPageEnd?: number | undefined;
  pageIndex: number;
};

function pageScopePayload(options: PageScopeSource) {
  const briefPages = options.chapterBrief?.pages ?? [];
  const briefIndexes = briefPages.map((page) => page.pageIndex).filter((pageIndex) => Number.isFinite(pageIndex));
  const chapterPageStart = options.chapterPageStart ?? (briefIndexes.length > 0 ? Math.min(...briefIndexes) : undefined);
  const chapterPageEnd = options.chapterPageEnd ?? (briefIndexes.length > 0 ? Math.max(...briefIndexes) : undefined);
  const chapterPageCount =
    chapterPageStart !== undefined && chapterPageEnd !== undefined
      ? Math.max(1, chapterPageEnd - chapterPageStart + 1)
      : options.chapter?.targetPages;
  const chapterPageNumber =
    chapterPageStart !== undefined && chapterPageEnd !== undefined && options.pageIndex >= chapterPageStart
      ? Math.min(Math.max(options.pageIndex - chapterPageStart + 1, 1), chapterPageCount ?? 1)
      : undefined;
  const futureChapterPageBriefs = briefPages
    .filter((page) => page.pageIndex > options.pageIndex)
    .map(compactPageBriefForScope);
  const previousChapterPageBriefs = briefPages
    .filter((page) => page.pageIndex < options.pageIndex)
    .map(compactPageBriefForScope);

  return {
    globalPageIndex: options.pageIndex,
    totalBookPages: options.input.targetPages,
    chapterIndex: options.chapter?.index ?? options.pageBrief?.chapterIndex ?? options.chapterBrief?.chapterIndex,
    chapterTitle: options.chapter?.title ?? options.chapterBrief?.title,
    chapterPageStart,
    chapterPageEnd,
    chapterPageNumber,
    chapterPageCount,
    isFirstPageOfChapter: chapterPageStart !== undefined ? options.pageIndex === chapterPageStart : undefined,
    isLastPageOfChapter: chapterPageEnd !== undefined ? options.pageIndex === chapterPageEnd : undefined,
    currentPageBriefIsAuthoritative: true,
    previousChapterPageBriefs,
    futureChapterPageBriefs,
    instruction:
      "Judge and write only the beat assigned to pageBrief for this global page. Future chapter page briefs are reserved for later pages."
  };
}

function compactPageBriefForScope(page: PageProductionBeat) {
  return {
    pageIndex: page.pageIndex,
    chapterIndex: page.chapterIndex,
    purpose: page.purpose,
    beat: page.beat,
    endingPressure: page.endingPressure
  };
}

export type GenerateImageBytesOptions = {
  image: ImageAdapter;
  prompt: string;
  projectId: string;
  pageId?: string | undefined;
  referenceImagePaths?: string[] | undefined;
  aspectRatio?: string | undefined;
  lessCensored?: boolean | undefined;
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

export type WholeBookDraft = {
  pages: WholeBookPageDraft[];
};

export type GenerateWholeBookOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapterBriefs?: ChapterBrief[] | undefined;
  researchNotes: string[];
  textModel: TextModelAdapter;
};

export type GeneratePageMapOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
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

const CHUNKED_PAGE_MAP_THRESHOLD = 24;
const INTERNAL_PAGE_TITLE_RULE =
  "The title field is internal tracking metadata only; give it a concise page-specific title that reflects this page's beat, and do not reuse the book title, chapter title, a Page N label, mini-chapter heading, or an adjacent/recent page title.";
const GROUNDED_FACTUALITY_RULE =
  "For factual or research-grounded prose, never invent studies, journals, experts, institutions, citations, statistics, source names, or numeric findings; use provided researchNotes or qualify/omit unsupported claims.";
const IMAGE_PROMPT_CHARACTER_RULE =
  "When imagePrompt depicts recurring characters, use exact character names from characters, preserve visualRules, and avoid generic labels when a named character appears.";
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

const wholeBookPageMapSchema = z.object({
  pages: z.array(pageProductionBeatSchema).min(1)
});

export async function generateWholeBookPageMap(options: GeneratePageMapOptions): Promise<ChapterBrief[]> {
  if (options.input.targetPages > CHUNKED_PAGE_MAP_THRESHOLD) {
    return generateChunkedPageMap(options);
  }

  const chapterPageRanges = chapterRangesForPlan(options.plan, options.input.targetPages).map((setup) => ({
    index: setup.chapter.index,
    title: setup.chapter.title,
    summary: setup.chapter.summary,
    targetPages: setup.endPage - setup.startPage + 1,
    pageRange: {
      start: setup.startPage,
      end: setup.endPage
    },
    keyBeats: setup.chapter.keyBeats,
    illustrationPrompts: setup.chapter.illustrationPrompts ?? []
  }));

  try {
    const result = await generateJsonWithJailbreak(options.textModel, {
      purpose: "generate-page-map",
      lessCensored: isLessCensored(options.input),
      jailbreakRole: "planner",
      temperature: Math.min(0.55, options.input.temperature),
      maxTokens: Math.min(12000, Math.max(1800, options.input.targetPages * 180)),
      schema: wholeBookPageMapSchema,
      messages: [
        {
          role: "system",
          content: [
            "You are the production editor for a complete book.",
            "Create a global page-by-page production map before drafting begins.",
            "Return exactly one root JSON object with one key: pages.",
            "The pages value must be an array of page beat objects, not strings, field names, schema keys, examples, or nested chapter records.",
            "Every page from 1 through targetPages must appear once, in order.",
            "The targetPages value and provided chapterPageRanges are final; compress chapter beats as needed instead of adding pages.",
            "Never emit pageIndex values greater than targetPages.",
            "Each page beat object must include pageIndex, chapterIndex, purpose, beat, requiredContinuity, endingPressure, and optional imageMoment.",
            "Use global page indexes, not chapter-local page numbers.",
            ...targetLanguageGenerationGuidance(options.input.language),
            ...plannerToneRules(options.input)
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
              chapterPageRanges,
              characters: options.plan.characters,
              locations: options.plan.locations,
              outputContract: {
                pages: [
                  {
                    pageIndex: 1,
                    chapterIndex: chapterPageRanges[0]?.index ?? 1,
                    purpose: "One sentence describing what this page must accomplish.",
                    beat: "One concrete action, explanation, or story turn assigned to this page.",
                    requiredContinuity: ["Continuity facts that must stay true on this page."],
                    endingPressure: "The page's concrete handoff to the next page.",
                    imageMoment: "Optional single visual moment for illustration."
                  }
                ]
              },
              instruction:
                `Return exactly ${options.input.targetPages} ordered page objects for global pages 1 through ${options.input.targetPages}. Use chapterPageRanges as the authoritative chapter allocation, even if the original outline implied more chapter beats.`
            },
            null,
            2
          )
        }
      ]
    });
    return parsePageMapFromModel(result.data, options);
  } catch (error) {
    if (shouldUseDeterministicPageMapFallback(error)) {
      return fallbackPageMapFromPlan(options);
    }
    throw error;
  }
}

export async function generateChapterBrief(options: GenerateChapterBriefOptions): Promise<ChapterBrief> {
  const expectedPages = range(options.chapterPageStart, options.chapterPageEnd);
  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "generate-chapter-brief",
    lessCensored: isLessCensored(options.input),
    jailbreakRole: "planner",
    temperature: Math.min(0.7, options.input.temperature),
    maxTokens: 5000,
    schema: z.unknown(),
    messages: [
      {
        role: "system",
        content: [
          "You are the production editor for a long-form book.",
          "Create a practical chapter brief for the writer.",
          "Every page in the requested range must receive a distinct page beat.",
          "The beats must prevent filler, repetition, and generic endings.",
          "Return exactly one root JSON object with chapterIndex, title, summary, pages, and continuityFocus.",
          "Use pages for the page beat array; do not return pageBeats as the root shape.",
          ...targetLanguageGenerationGuidance(options.input.language),
          ...plannerToneRules(options.input)
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
              continuityRules: options.plan.continuityRules,
              styleGuidance: styleGuidancePayload(options.input)
            },
            chapter: options.chapter,
            pageRange: {
              start: options.chapterPageStart,
              end: options.chapterPageEnd,
              globalPageIndexes: expectedPages
            },
            instruction:
              "Return one beat per page. Each beat needs purpose, concrete action or explanation, required continuity, ending pressure, and optional image moment."
          },
          null,
          2
        )
      }
    ]
  });

  const brief = parseChapterBriefFromModel(result.data, options);
  const actualPages = new Set(brief.pages.map((page) => page.pageIndex));
  const missingPages = expectedPages.filter((pageIndex) => !actualPages.has(pageIndex));
  if (missingPages.length > 0) {
    throw new Error(`Chapter brief missing page beats: ${missingPages.join(", ")}`);
  }
  return brief;
}

export async function generatePageDraft(options: GeneratePageOptions): Promise<PageDraft> {
  const context = buildContextPack({
    plan: options.plan,
    chapter: options.chapter,
    pageIndex: options.pageIndex,
    targetPages: options.input.targetPages,
    previousSummaries: options.previousSummaries,
    continuityNotes: options.continuityNotes,
    researchNotes: options.researchNotes,
    semanticMemory: options.semanticMemory,
    entityState: options.entityState,
    tokenBudget: 7000,
    lessCensored: isLessCensored(options.input),
    readingGuidance: kidsReadingGuidanceLines(options.input)
  });
  const recentPages = compactPriorPages(options.previousPages ?? [], 5, 1000);

  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "generate-page",
    lessCensored: isLessCensored(options.input),
    jailbreakRole: "writer",
    temperature: options.input.temperature,
    maxTokens: 3000,
    schema: pageDraftSchema,
    messages: [
      {
        role: "system",
        content: [
          "Write one finished Markdown page of the book as a human author would.",
          "Do not mention AI, prompts, plans, JSON, schemas, generation, or production instructions.",
          INTERNAL_PAGE_TITLE_RULE,
          GROUNDED_FACTUALITY_RULE,
          "Do not use scaffold phrases, meta commentary, or a summary of what the page should do.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          "Make the page itself advance the story or explanation through concrete action, claims, dialogue, or scene work.",
          "Every page must add a distinct irreversible change, new information, completed decision, or resolved consequence.",
          "Do not replay an encounter, decision, exposition point, or emotional beat that already appeared in recent pages.",
          "If the pageBrief requires a recurring action type from earlier pages, such as running, waiting, arguing, or explaining, use fresh concrete details and make the outcome different.",
          "Treat previousPages as a phrase blacklist for distinctive action wording; do not reuse memorable clauses from earlier pages.",
          "Use pageScope to distinguish global page position from chapter-local position.",
          "The current pageBrief is authoritative; chapter keyBeats and futureChapterPageBriefs are context only unless assigned to this page.",
          "Return JSON with title, markdown, summary, continuityNotes, and optional imagePrompt.",
          IMAGE_PROMPT_CHARACTER_RULE,
          ...targetLanguageGenerationGuidance(options.input.language),
          ...writerToneRules(options.input)
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            context,
            language: targetLanguagePayload(options.input.language),
            userContext: {
              prompt: options.input.prompt,
              category: options.input.category,
              subcategory: options.input.subcategory,
              styleGuidance: styleGuidancePayload(options.input)
            },
            chapterBrief: options.chapterBrief,
            pageBrief: options.pageBrief,
            pageScope: pageScopePayload(options),
            characters: options.plan.characters,
            illustrationPlan: options.plan.illustrationPlan,
            recentPages,
            alreadyCovered: recentPages.map((page) => ({
              page: page.index,
              title: page.title,
              coveredBeat: page.summary
            })),
            pageInstruction:
              buildPageInstruction(options.pageIndex, options.input.targetPages)
          },
          null,
          2
        )
      }
    ]
  });

  return pageDraftSchema.parse(result.data);
}

export async function generateWholeBookDraft(options: GenerateWholeBookOptions): Promise<WholeBookDraft> {
  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "generate-whole-book",
    lessCensored: isLessCensored(options.input),
    jailbreakRole: "writer",
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
          "Each page object must include index, title, markdown, summary, continuityNotes, and optional imagePrompt.",
          "Images are generated later, so imagePrompt must be a separate visual prompt field and must not appear in markdown.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          "Every page must add distinct progression; do not repeat the same scene, explanation, decision, or emotional beat across pages.",
          IMAGE_PROMPT_CHARACTER_RULE,
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
  return {
    pages: normalizeWholeBookPageSet(draft.pages, options.input.targetPages)
  };
}

export async function generateChapterDraft(options: GenerateChapterDraftOptions): Promise<WholeBookDraft> {
  const expectedPages = range(options.chapterPageStart, options.chapterPageEnd);
  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "generate-chapter-draft",
    lessCensored: isLessCensored(options.input),
    jailbreakRole: "writer",
    temperature: options.input.temperature,
    maxTokens: Math.min(64000, Math.max(4000, expectedPages.length * 900)),
    schema: z.unknown(),
    messages: [
      {
        role: "system",
        content: [
          "Write one complete chapter of the book as finished Markdown pages.",
          "Return exactly one root JSON object with a pages array.",
          "Every returned page must include global index, title, markdown, summary, continuityNotes, and optional imagePrompt.",
          "Return exactly the requested global page indexes, in order.",
          INTERNAL_PAGE_TITLE_RULE,
          GROUNDED_FACTUALITY_RULE,
          "Do not mention AI, prompts, JSON, schemas, generation, or production instructions in reader-facing pages.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          IMAGE_PROMPT_CHARACTER_RULE,
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
  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "generate-page-batch",
    lessCensored: isLessCensored(options.input),
    jailbreakRole: "writer",
    temperature: options.input.temperature,
    maxTokens: Math.min(24000, Math.max(4000, expectedPages.length * 900)),
    schema: z.unknown(),
    messages: [
      {
        role: "system",
        content: [
          "Write a small ordered batch of finished Markdown book pages.",
          "Return exactly one root JSON object with a pages array.",
          "Every returned page must include global index, title, markdown, summary, continuityNotes, and optional imagePrompt.",
          "Return exactly the requested page indexes, in order.",
          INTERNAL_PAGE_TITLE_RULE,
          GROUNDED_FACTUALITY_RULE,
          "Make each page advance a distinct beat and avoid repeating recent pages.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          IMAGE_PROMPT_CHARACTER_RULE,
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
  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "polish-page",
    lessCensored: isLessCensored(options.input),
    jailbreakRole: "writer",
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
          IMAGE_PROMPT_CHARACTER_RULE,
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

export async function reviewPageDraft(options: ReviewPageOptions): Promise<PageQualityReport> {
  const localReport = runLocalPageQualityChecks(options);
  if (!localReport.approved) {
    return localReport;
  }

  let result: { data: PageQualityReport };
  try {
    result = await generateJsonWithJailbreak(options.textModel, {
      purpose: "review-page",
      lessCensored: isLessCensored(options.input),
      jailbreakRole: "reviewer",
      temperature: 0.15,
      maxTokens: 1800,
      schema: pageQualityReportSchema,
      messages: [
        {
          role: "system",
          content: [
            "You are a strict book editor.",
            "Review one generated page for reader-facing quality.",
            "Reject filler, repetition, prompt leakage, generic scaffold prose, continuity contradictions, and pages that do not progress.",
            "Reject invented or explicitly fabricated research, including made-up studies, journals, institutes, statistics, experts, or citations.",
            "Treat semantic repetition as a failure even when wording differs: the same encounter, same decision, same exposition, or same emotional turn cannot appear twice.",
            "Do not reject merely because the same character performs a necessary recurring action type assigned by the current pageBrief; reject it only when it restages the same beat, reuses distinctive wording, or fails to add a new consequence.",
            "For a final page, reject vague closure unless it resolves the core promise with a concrete consequence or completed choice.",
            "Use pageScope to distinguish global page position from chapter-local position.",
            "Evaluate only the current pageBrief. Do not reject a page for omitting chapter keyBeats or futureChapterPageBriefs assigned to later pages.",
            "If pageScope.isLastPageOfChapter is false, do not require chapter closure or all chapter keyBeats on this page.",
            ...targetLanguageReviewGuidance(options.input.language),
            ...reviewerStyleRules(options.input),
            "Return one JSON object with approved (boolean), score (integer 0-100), issues (string array), requiredRevisions (string array), notes (string), and checks with placeholderFree, promptLeakFree, titleClean, repetitionOk, progressionOk, styleNatural booleans.",
            "Do not use feedback as the only root field."
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
              chapter: options.chapter,
              chapterBrief: options.chapterBrief,
              pageBrief: options.pageBrief,
              pageScope: pageScopePayload(options),
              pageIndex: options.pageIndex,
              draft: options.draft,
              previousPages: compactPriorPages(options.previousPages, 5, 800),
              continuityNotes: options.continuityNotes.slice(-20),
              instruction:
                "Approve only if this is a finished, specific page that can appear in the final book without visible generation artifacts, repeated beats, or stalled progression."
            },
            null,
            2
          )
        }
      ]
    });
  } catch (error) {
    if (!shouldUseLocalReviewFallback(error)) {
      throw error;
    }
    return {
      ...localReport,
      notes: `${localReport.notes} Model reviewer returned malformed JSON, so local checks were used.`
    };
  }

  const modelReport = pageQualityReportSchema.parse(result.data);
  const approved = modelReport.approved && modelReport.score >= 75;
  return {
    ...modelReport,
    approved,
    issues: approved ? modelReport.issues : normalizeIssueList(modelReport.issues, "Reviewer rejected the page."),
    requiredRevisions:
      approved || modelReport.requiredRevisions.length > 0
        ? modelReport.requiredRevisions
        : ["Revise the page until it is specific, progressive, and free of generation artifacts."],
    checks: {
      ...localReport.checks,
      ...modelReport.checks
    }
  };
}

function shouldUseLocalReviewFallback(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    /Json(?:Parse|Validation)Error$/i.test(error.name) ||
    /\b(?:invalid JSON|Model did not return a JSON object|Expected .* in JSON|Unexpected token|Unterminated string|JSON validation failed|schema validation)\b/i.test(
      error.message
    )
  );
}

export async function revisePageDraft(options: RevisePageOptions): Promise<PageDraft> {
  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "revise-page",
    lessCensored: isLessCensored(options.input),
    jailbreakRole: "writer",
    temperature: Math.min(0.85, options.input.temperature),
    maxTokens: 3200,
    schema: pageDraftSchema,
    messages: [
      {
        role: "system",
        content: [
          "Revise one book page so it passes editorial QA.",
          "Return a complete replacement page, not notes.",
          "Change the actual story or explanation beat when needed; do not merely rephrase repeated material.",
          "The replacement must advance beyond the prior pages and satisfy the current page brief.",
          INTERNAL_PAGE_TITLE_RULE,
          GROUNDED_FACTUALITY_RULE,
          "Do not mention the critique, AI, prompts, JSON, schemas, generation, or production instructions.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          "If the current pageBrief requires a recurring action type from previousPages, keep the required action but change the physical details, sentence rhythm, and consequence.",
          "Do not reuse distinctive phrases from previousPages; replace them with fresh concrete wording.",
          "Use pageScope to keep the replacement inside the current global page and chapter-local position.",
          "The current pageBrief is authoritative. Do not import futureChapterPageBriefs or later chapter keyBeats unless they are explicitly assigned to this page.",
          IMAGE_PROMPT_CHARACTER_RULE,
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
            chapter: options.chapter,
            chapterBrief: options.chapterBrief,
            pageBrief: options.pageBrief,
            pageScope: pageScopePayload(options),
            pageIndex: options.pageIndex,
            characters: options.plan.characters,
            illustrationPlan: options.plan.illustrationPlan,
            rejectedDraft: options.draft,
            qualityReport: options.report,
            previousPages: compactPriorPages(options.previousPages, 5, 800),
            instruction: buildPageInstruction(options.pageIndex, options.input.targetPages)
          },
          null,
          2
        )
      }
    ]
  });

  return pageDraftSchema.parse(result.data);
}

export async function repairPageBrief(options: RepairPageBriefOptions): Promise<PageProductionBeat> {
  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "repair-page-brief",
    lessCensored: isLessCensored(options.input),
    jailbreakRole: "planner",
    temperature: Math.min(0.65, options.input.temperature),
    maxTokens: 2200,
    schema: pageProductionBeatSchema,
    messages: [
      {
        role: "system",
        content: [
          "You are a production editor repairing one page assignment after QA proved the assignment produces repetition or stalled progression.",
          "Return a replacement page brief, not reader-facing prose.",
          "Keep the same pageIndex and chapterIndex.",
          "Preserve the book premise, audience, and chapter purpose, but you may discard original required examples, sources, metaphors, or ending pressure when QA says they cause repetition.",
          "The repaired beat must create a distinct new contribution beyond previousPages: a new textual analysis, concrete case, irreversible decision, practical consequence, or specific evidence path.",
          GROUNDED_FACTUALITY_RULE,
          "Do not ask the writer to restate, reframe, or lightly polish the rejected draft.",
          "If the chapter requires recurring mechanics, repair the assignment around the new consequence, location, choice, or relation rather than banning the recurring action itself.",
          "Use pageScope to keep the repaired assignment inside the current page. Do not move futureChapterPageBriefs or later chapter keyBeats into this page.",
          "The endingPressure must name a concrete consequence, completed choice, or resolved claim.",
          "The endingPressure must be phrased as a substantive landing claim the prose can earn, not a procedural instruction. It must not include words such as concluding, survey, chapter, section, scope, transition, recap, reader, or next chapter.",
          "Return exactly one JSON object with pageIndex, chapterIndex, purpose, beat, requiredContinuity, endingPressure, and optional imageMoment.",
          ...targetLanguageGenerationGuidance(options.input.language),
          ...plannerToneRules(options.input)
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
            chapter: options.chapter,
            chapterBrief: options.chapterBrief,
            pageIndex: options.pageIndex,
            pageScope: pageScopePayload(options),
            originalPageBrief: options.pageBrief,
            rejectedDraft: {
              title: options.draft.title,
              summary: options.draft.summary,
              excerpt: options.draft.markdown.slice(0, 1400)
            },
            qualityReport: options.report,
            previousPages: compactPriorPages(options.previousPages, 6, 900),
            continuityNotes: options.continuityNotes.slice(-20),
            instruction:
              "Repair the assignment itself. If the original brief requires material already covered or flagged by QA, replace that material with a fresh page beat that still belongs in this chapter."
          },
          null,
          2
        )
      }
    ]
  });

  return normalizeRepairedPageBrief(result.data, options);
}

export async function runFinalBookQa(options: FinalBookQaOptions): Promise<FinalBookQa> {
  const localIssues = runLocalFinalQa(options.input, options.pages);
  if (localIssues.length > 0) {
    return {
      approved: false,
      score: Math.max(0, 100 - localIssues.length * 15),
      issues: localIssues,
      requiredFixes: localIssues,
      notes: "Local final QA rejected the book before export."
    };
  }

  const result = await generateJsonWithJailbreak(options.textModel, {
    purpose: "final-book-qa",
    lessCensored: isLessCensored(options.input),
    jailbreakRole: "reviewer",
    temperature: 0.1,
    maxTokens: 2200,
    schema: finalBookQaSchema,
    messages: [
      {
        role: "system",
        content: [
          "You are the final quality editor for a book export.",
          "Reject the book if it contains placeholders, repeated pages, prompt leakage, broken continuity, or no progression.",
          "Reject the book if factual or research-grounded passages contain invented studies, journals, institutes, statistics, experts, citations, or claims described as fictional/fabricated/invented.",
          "pageMap summaries are abbreviated excerpts for this review, not the exported manuscript.",
          "Do not reject because a pageMap summary ends with an ellipsis or looks cut off.",
          ...targetLanguageReviewGuidance(options.input.language),
          ...reviewerStyleRules(options.input),
          "Return one JSON object with approved (boolean), score (integer 0-100), issues (string array), requiredFixes (string array), and notes (string).",
          "Do not use reasons or feedback as the only root field."
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
              targetPages: options.input.targetPages,
              audience: options.plan.audience,
              category: options.input.category,
              subcategory: options.input.subcategory,
              styleGuidance: styleGuidancePayload(options.input)
            },
            pageMap: compactPageMap(options.pages),
            researchNotes: options.researchNotes?.slice(0, 20) ?? [],
            instruction:
              "Approve only if the compiled Markdown can be shown to a reader as the book output without obvious generation artifacts. pageMap summaries may end with … because they are shortened for this check; that is not a book defect. Identical titles on adjacent pages are fine when the summaries describe different beats."
          },
          null,
          2
        )
      }
    ]
  });

  const report = finalBookQaSchema.parse(result.data);
  return {
    ...report,
    approved: report.approved && report.score >= 80,
    issues: report.approved && report.score >= 80 ? report.issues : normalizeIssueList(report.issues, "Final QA rejected the book."),
    requiredFixes:
      report.approved || report.requiredFixes.length > 0
        ? report.requiredFixes
        : ["Repair failed pages and rerun final QA before export."]
  };
}

export function shouldIllustratePage(input: CreateProjectInput, plan: BookPlan, pageIndex: number): boolean {
  if (!input.mediaSettings.fullIllustrations) {
    return false;
  }
  const cadence = input.mediaSettings.illustrationCadence;
  if (cadence === "manual") {
    return false;
  }
  if (cadence === "every-page") {
    return true;
  }
  if (input.category === "KIDS") {
    return true;
  }
  if (isDiagramFriendlyBookCategory(input.category)) {
    return pageIndex === 1 || pageIndex % 4 === 0;
  }
  return pageIndex === 1 || pageIndex % 8 === 0;
}

export async function generateImageBytes(options: GenerateImageBytesOptions): Promise<GeneratedImageBytes> {
  const lessCensored = options.lessCensored === true;
  const levels: Array<0 | 1 | 2> = lessCensored ? [0, 1, 2] : [0];
  let lastError: unknown;

  for (const level of levels) {
    const prefix = jailbreakImagePromptPrefix(level);
    const prompt = prefix ? `${prefix}\n\n${options.prompt}` : options.prompt;
    const request = {
      prompt,
      projectId: options.projectId,
      aspectRatio: options.aspectRatio ?? "4:3",
      lessCensored,
      ...(options.referenceImagePaths?.length ? { referenceImagePaths: options.referenceImagePaths } : {}),
      ...(options.pageId ? { pageId: options.pageId } : {})
    };
    try {
      const result = await options.image.generateImage(request);
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
    } catch (error) {
      lastError = error;
      if (!lessCensored || level === 2) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Image generation failed.");
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

function normalizeWholeBookPageSet(pages: WholeBookPageDraft[], targetPages: number): WholeBookPageDraft[] {
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
  if (missing.length > 0 || extra.length > 0 || duplicates.size > 0) {
    const parts = [
      missing.length ? `missing pages ${missing.join(", ")}` : "",
      extra.length ? `unexpected pages ${extra.join(", ")}` : "",
      duplicates.size ? `duplicate pages ${[...duplicates].join(", ")}` : ""
    ].filter(Boolean);
    throw new Error(`Whole-book generation returned an invalid page set: ${parts.join("; ")}.`);
  }

  return expectedIndexes.map((pageIndex) => byIndex.get(pageIndex)!);
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

function parsePageMapFromModel(raw: unknown, options: GeneratePageMapOptions): ChapterBrief[] {
  const expectedPages = range(1, options.input.targetPages);
  const pageBeats = findAllPageBeatItems(raw);
  if (pageBeats.length === 0) {
    throw new Error(`Page map did not include a usable pages/pageBeats array. Root keys: ${objectKeys(raw)}.`);
  }

  const normalized = pageBeats.map((page, index) => normalizeModelPageBeat(page, index, expectedPages, 1));
  const pages = normalizePageMapPages(normalized, expectedPages, options.input.targetPages);
  const ranges = chapterRangesForPlan(options.plan, options.input.targetPages);
  return ranges.map((rangeInfo) => {
    const chapterPages = pages
      .filter((page) => page.pageIndex >= rangeInfo.startPage && page.pageIndex <= rangeInfo.endPage)
      .map((page) => ({
        ...page,
        chapterIndex: rangeInfo.chapter.index
      }));

    return chapterBriefSchema.parse({
      chapterIndex: rangeInfo.chapter.index,
      title: rangeInfo.chapter.title,
      summary: rangeInfo.chapter.summary,
      pages: chapterPages,
      continuityFocus: [
        ...rangeInfo.chapter.keyBeats,
        ...chapterPages.flatMap((page) => page.requiredContinuity)
      ].slice(0, 12)
    });
  });
}

function shouldUseDeterministicPageMapFallback(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    /Json(?:Parse|Validation)Error$/i.test(error.name) ||
    /\b(?:invalid JSON|Model did not return a JSON object|Unterminated string|JSON validation failed|schema validation)\b/i.test(
      error.message
    )
  );
}

function fallbackPageMapFromPlan(options: GeneratePageMapOptions): ChapterBrief[] {
  return chapterRangesForPlan(options.plan, options.input.targetPages).map((rangeInfo) => {
    const pageIndexes = range(rangeInfo.startPage, rangeInfo.endPage);
    const pages = pageIndexes.map((pageIndex, index) =>
      fallbackPageBeatFromChapter({
        input: options.input,
        plan: options.plan,
        chapter: rangeInfo.chapter,
        pageIndex,
        localIndex: index,
        pageCount: pageIndexes.length
      })
    );

    return chapterBriefSchema.parse({
      chapterIndex: rangeInfo.chapter.index,
      title: rangeInfo.chapter.title,
      summary: rangeInfo.chapter.summary,
      pages,
      continuityFocus: [
        ...rangeInfo.chapter.keyBeats,
        ...options.plan.continuityRules,
        ...pages.flatMap((page) => page.requiredContinuity)
      ].slice(0, 12)
    });
  });
}

function fallbackPageBeatFromChapter(options: {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  pageIndex: number;
  localIndex: number;
  pageCount: number;
}): PageProductionBeat {
  const keyBeats = options.chapter.keyBeats.length > 0 ? options.chapter.keyBeats : [options.chapter.summary];
  const assignedBeat = keyBeats[Math.min(options.localIndex, keyBeats.length - 1)] ?? options.chapter.summary;
  const illustrationPrompt =
    options.chapter.illustrationPrompts?.[
      Math.min(options.localIndex, Math.max(0, options.chapter.illustrationPrompts.length - 1))
    ];
  const chapterPageNumber = options.localIndex + 1;
  const position =
    options.pageCount === 1
      ? "single chapter page"
      : options.localIndex === 0
        ? "opening chapter page"
        : chapterPageNumber === options.pageCount
          ? "closing chapter page"
          : `chapter page ${chapterPageNumber}`;
  const nextChapter = normalizedChaptersForGeneration(options.plan, options.input.targetPages).find(
    (chapter) => chapter.index > options.chapter.index
  );
  const endingPressure =
    options.pageIndex === options.input.targetPages
      ? "Resolve the book's central promise with a concrete final consequence."
      : chapterPageNumber === options.pageCount && nextChapter
        ? `Hand off cleanly toward ${nextChapter.title}.`
        : "End with a concrete reason the next assigned page must continue.";

  return {
    pageIndex: options.pageIndex,
    chapterIndex: options.chapter.index,
    purpose: `${capitalize(position)} for ${options.chapter.title}.`,
    beat: `${assignedBeat} Keep the page focused on ${options.chapter.summary}`,
    requiredContinuity: [
      `Chapter ${options.chapter.index}: ${options.chapter.title}.`,
      ...options.plan.continuityRules.slice(0, 4)
    ],
    endingPressure,
    imageMoment: illustrationPrompt ?? assignedBeat
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizePageMapPages(
  pages: PageProductionBeat[],
  expectedPages: number[],
  targetPages: number
): PageProductionBeat[] {
  const indexes = pages.map((page) => page.pageIndex);
  const ordered = indexes.length === expectedPages.length && indexes.every((pageIndex, index) => pageIndex === expectedPages[index]);
  if (ordered) {
    return pages;
  }

  const expectedPrefix = pages.slice(0, expectedPages.length);
  const prefixIndexes = expectedPrefix.map((page) => page.pageIndex);
  const hasExpectedPrefix =
    expectedPrefix.length === expectedPages.length &&
    prefixIndexes.every((pageIndex, index) => pageIndex === expectedPages[index]);
  const trailingPages = pages.slice(expectedPages.length);
  const hasOnlyTrailingExtras = trailingPages.length > 0 && trailingPages.every((page) => page.pageIndex > targetPages);
  if (hasExpectedPrefix && hasOnlyTrailingExtras) {
    return expectedPrefix;
  }

  throw new Error(
    `Page map must include every page from 1 through ${targetPages} exactly once and in order. Received ${indexes.join(", ")}.`
  );
}

async function generateChunkedPageMap(options: GeneratePageMapOptions): Promise<ChapterBrief[]> {
  const chapterSetups = chapterRangesForPlan(options.plan, options.input.targetPages);
  const briefs: ChapterBrief[] = [];
  for (const setup of chapterSetups) {
    const brief = await generateChapterBrief({
      input: options.input,
      plan: options.plan,
      chapter: setup.chapter,
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      textModel: options.textModel
    });
    briefs.push(brief);
  }
  return briefs;
}

function pageMapForRange(chapterBriefs: ChapterBrief[], pageStart: number, pageEnd: number): PageProductionBeat[] {
  return chapterBriefs
    .flatMap((brief) => brief.pages)
    .filter((page) => page.pageIndex >= pageStart && page.pageIndex <= pageEnd)
    .sort((first, second) => first.pageIndex - second.pageIndex);
}

function pageMapForWholeBookDraft(chapterBriefs: ChapterBrief[]) {
  return chapterBriefs
    .flatMap((brief) =>
      brief.pages.map((page) => ({
        chapterIndex: brief.chapterIndex,
        chapterTitle: brief.title,
        pageIndex: page.pageIndex,
        purpose: page.purpose,
        beat: page.beat,
        requiredContinuity: page.requiredContinuity,
        endingPressure: page.endingPressure,
        imageMoment: page.imageMoment
      }))
    )
    .sort((first, second) => first.pageIndex - second.pageIndex);
}

function chapterRangesForPlan(
  plan: BookPlan,
  targetPages: number
): Array<{ chapter: ChapterPlan; startPage: number; endPage: number }> {
  let nextPageIndex = 1;
  return normalizedChaptersForGeneration(plan, targetPages).map((chapter) => {
    const startPage = nextPageIndex;
    const endPage = Math.min(targetPages, startPage + chapter.targetPages - 1);
    nextPageIndex = endPage + 1;
    return { chapter, startPage, endPage };
  });
}

function normalizedChaptersForGeneration(plan: BookPlan, targetPages: number): ChapterPlan[] {
  return normalizePlanPageTargets(plan, targetPages).chapters;
}

function findAllPageBeatItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    if (looksLikePageBeatArray(value)) {
      return value;
    }
    return value.flatMap((item) => findAllPageBeatItems(item));
  }
  if (!isRecord(value)) {
    return [];
  }

  const direct = findPageBeatArray(value);
  if (direct) {
    return direct;
  }

  return Object.values(value).flatMap((item) => findAllPageBeatItems(item));
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

function wholeBookMaxTokens(input: CreateProjectInput): number {
  const tokensPerPage = input.category === "KIDS" ? 350 : 850;
  return Math.min(64000, Math.max(4000, input.targetPages * tokensPerPage));
}

export type LocalPageReviewOptions = Omit<ReviewPageOptions, "textModel">;

/**
 * Runs only the deterministic local quality heuristics (no model call).
 * Used by bulk strategies (e.g. whole-book single pass) to produce honest
 * quality reports without the full model review loop.
 */
export function reviewPageDraftLocally(options: LocalPageReviewOptions): PageQualityReport {
  return runLocalPageQualityChecks({ ...options, textModel: undefined as unknown as TextModelAdapter });
}

function runLocalPageQualityChecks(options: ReviewPageOptions): PageQualityReport {
  const text = `${options.draft.title}\n${options.draft.markdown}`;
  const currentBody = options.draft.markdown.trim();
  const issues: string[] = [];
  const checks = {
    placeholderFree: true,
    promptLeakFree: true,
    titleClean: true,
    repetitionOk: true,
    progressionOk: true,
    styleNatural: true
  };

  const placeholder = PLACEHOLDER_PATTERNS.find((pattern) => pattern.test(text));
  if (placeholder) {
    checks.placeholderFree = false;
    issues.push("Page contains placeholder or scaffold prose.");
  }

  const promptLeak = PROMPT_LEAK_PATTERNS.find((pattern) => pattern.test(text));
  if (promptLeak) {
    checks.promptLeakFree = false;
    issues.push("Page leaks prompts, schema, image instructions, or production notes.");
  }

  if (hasPageBriefMetaLanguage(currentBody)) {
    checks.promptLeakFree = false;
    checks.progressionOk = false;
    issues.push("Page turns page-brief instructions into reader-facing meta-commentary.");
  }

  const fabricatedResearch = FABRICATED_RESEARCH_PATTERNS.find((pattern) => pattern.test(text));
  if (fabricatedResearch) {
    checks.promptLeakFree = false;
    checks.progressionOk = false;
    issues.push("Page contains invented or explicitly fabricated research evidence.");
  }

  if (hasFormulaicProofLeap(currentBody)) {
    checks.styleNatural = false;
    issues.push("Page uses a formulaic proof-leap phrase that makes the prose sound generated.");
  }

  if (hasFormulaicAdjacentContrast(currentBody)) {
    checks.styleNatural = false;
    issues.push("Page stacks adjacent contrast sentences in a generic AI-rhetorical pattern.");
  }

  if (hasExcessiveDashUse(currentBody)) {
    checks.styleNatural = false;
    issues.push("Page overuses em/en dashes in a way that makes the prose sound generated.");
  }

  if (hasDuplicatePagePrefix(options.pageIndex, options.draft.title)) {
    checks.titleClean = false;
    issues.push("Page title repeats the page label.");
  }

  const adjacentPage = options.previousPages.at(-1);
  if (adjacentPage && normalizeTitle(adjacentPage.title) === normalizeTitle(options.draft.title)) {
    checks.titleClean = false;
    checks.repetitionOk = false;
    issues.push(`Page title repeats adjacent page ${adjacentPage.index}.`);
  }

  const repeatedPage = options.previousPages.slice(-5).find((page) => {
    const bodySimilarity = similarity(currentBody, page.markdown);
    const summarySimilarity = similarity(options.draft.summary, page.summary);
    const lexicalOverlap = keywordOverlap(options.draft.summary, page.summary);
    return bodySimilarity >= 0.82 || summarySimilarity >= 0.72 || lexicalOverlap >= 0.78;
  });
  if (repeatedPage) {
    checks.repetitionOk = false;
    issues.push(`Page repeats or substantially overlaps the beat from page ${repeatedPage.index}.`);
  }

  const kidsGuidance = kidsReadingGuidanceForInput(options.input);
  const wordCount = kidsGuidance ? countReadableWords(currentBody) : tokenize(currentBody).length;
  const minWords = kidsGuidance?.targetWordsPerPage.min ?? (options.input.category === "STORY" ? 70 : 90);
  if (wordCount < minWords) {
    checks.progressionOk = false;
    issues.push(`Page is too short to show meaningful progression (${wordCount} words).`);
  }

  if (kidsGuidance && wordCount > kidsGuidance.maxWordsPerPageWithTolerance) {
    checks.styleNatural = false;
    issues.push(
      `Page is too long for ages ${kidsGuidance.ageRange} (${wordCount} words; target ${kidsGuidance.targetWordsPerPage.min}-${kidsGuidance.targetWordsPerPage.max}).`
    );
  }

  if (kidsGuidance) {
    const sentenceStats = sentenceLengthStats(currentBody);
    if (
      sentenceStats.average > kidsGuidance.maxAverageSentenceWords ||
      sentenceStats.max > kidsGuidance.maxSentenceWords
    ) {
      checks.styleNatural = false;
      issues.push(
        `Sentences are too long for ages ${kidsGuidance.ageRange} (average ${sentenceStats.average.toFixed(1)} words, longest ${sentenceStats.max}; target average <= ${kidsGuidance.maxAverageSentenceWords}, longest <= ${kidsGuidance.maxSentenceWords}).`
      );
    }
  }

  if (SCAFFOLD_SHAPE_PATTERNS.some((pattern) => pattern.test(currentBody))) {
    checks.progressionOk = false;
    issues.push("Page describes its intended function instead of becoming finished book prose.");
  }

  if (options.pageIndex === options.input.targetPages && hasVagueEnding(options.draft)) {
    checks.progressionOk = false;
    issues.push("Final page ending is too vague to resolve the book's central promise.");
  }

  return {
    approved: issues.length === 0,
    score: Math.max(0, 100 - issues.length * 25),
    issues,
    requiredRevisions: issues.map((issue) => `Fix: ${issue}`),
    notes: issues.length === 0 ? "Local quality checks passed." : "Local quality checks rejected the page.",
    checks
  };
}

function runLocalFinalQa(input: CreateProjectInput, pages: FinalQaPage[]): string[] {
  const issues: string[] = [];
  if (pages.length !== input.targetPages) {
    issues.push(`Expected ${input.targetPages} pages but found ${pages.length}.`);
  }

  for (const page of pages) {
    const report = runLocalPageQualityChecks({
      input,
      plan: {
        title: "",
        premise: "",
        audience: "",
        writingComplexity: input.complexity,
        voiceGuide: [""],
        antiAiRules: [""],
        questions: [],
        chapters: [],
        characters: [],
        locations: [],
        continuityRules: [],
        researchQueries: [],
        researchNotes: [],
        illustrationPlan: {
          cadence: input.mediaSettings.illustrationCadence,
          globalStyle: "",
          characterReferencePrompts: [],
          pageRules: []
        }
      },
      pageIndex: page.index,
      draft: {
        title: page.title,
        markdown: page.markdown,
        summary: page.summary,
        continuityNotes: []
      },
      previousPages: pages.filter((candidate) => candidate.index < page.index).slice(-4),
      continuityNotes: [],
      textModel: {} as TextModelAdapter
    });
    if (!report.approved) {
      issues.push(`Page ${page.index}: ${report.issues.join(" ")}`);
    }
  }

  return issues.slice(0, 20);
}

export function compactSummaryForQa(summary: string, maxLength: number): string {
  const trimmed = summary.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const budget = Math.max(16, maxLength - 1);
  const slice = trimmed.slice(0, budget).trimEnd();
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > budget * 0.55 ? slice.slice(0, lastSpace) : slice;
  return `${body}…`;
}

function summaryLimitForFinalQa(pageCount: number): number {
  if (pageCount <= 30) {
    return 800;
  }
  if (pageCount <= 80) {
    return 450;
  }
  return 220;
}

function compactPageMap(pages: FinalQaPage[]) {
  const summaryLimit = summaryLimitForFinalQa(pages.length);
  const compact = pages.map((page) => ({
    index: page.index,
    title: page.title,
    summary: compactSummaryForQa(page.summary, summaryLimit)
  }));
  if (compact.length <= 120) {
    return compact;
  }

  const first = compact.slice(0, 40);
  const last = compact.slice(-40);
  const middle: typeof compact = [];
  const stride = Math.max(1, Math.floor((compact.length - 80) / 40));
  for (let index = 40; index < compact.length - 40; index += stride) {
    middle.push(compact[index]!);
    if (middle.length >= 40) {
      break;
    }
  }
  return [...first, { index: -1, title: "Omitted middle pages sampled", summary: `${compact.length - 120} pages omitted from this compact QA map.` }, ...middle, ...last];
}

function hasDuplicatePagePrefix(pageIndex: number, title: string): boolean {
  const pattern = new RegExp(`^\\s*page\\s+${pageIndex}\\s*[:\\-]\\s*page\\s+${pageIndex}\\b`, "i");
  return pattern.test(title);
}

function buildPageInstruction(pageIndex: number, targetPages: number): string {
  const base = [
    "Write exactly this page, not a description of the page.",
    "Use a clean title without a Page N prefix.",
    "Treat the title as internal metadata only; the markdown should begin with book prose, not a page title or heading.",
    GROUNDED_FACTUALITY_RULE,
    "Advance beyond recentPages and alreadyCovered; do not restate their scene, decision, exposition, or emotional beat.",
    'Treat pageBrief and endingPressure as internal notes; do not echo phrases like "concluding the survey" or announce a transition to another chapter.',
    "The page summary must name the new beat or changed consequence introduced on this page."
  ];
  if (pageIndex === targetPages) {
    base.push(
      "This is the final page: resolve the book's central promise with a concrete consequence, completed choice, or settled question instead of a vague closing image."
    );
  }
  return base.join(" ");
}

function normalizeRepairedPageBrief(raw: unknown, options: RepairPageBriefOptions): PageProductionBeat {
  const parsed = pageProductionBeatSchema.parse(raw);
  const chapterIndex = options.chapter?.index ?? options.pageBrief.chapterIndex;
  const purpose = parsed.purpose.trim() || `Advance page ${options.pageIndex} with a non-repetitive page assignment.`;
  const beat =
    parsed.beat.trim() ||
    `Add a distinct concrete beat for page ${options.pageIndex} that does not restate previous pages or the rejected draft.`;
  const rawEndingPressure = parsed.endingPressure.trim();
  const endingPressure =
    rawEndingPressure && !hasPageBriefMetaLanguage(rawEndingPressure)
      ? rawEndingPressure
      : repairedEndingPressureFallback(options);
  const requiredContinuity = parsed.requiredContinuity.map((item) => item.trim()).filter(Boolean);
  const imageMoment = parsed.imageMoment?.trim();

  return {
    ...parsed,
    pageIndex: options.pageIndex,
    chapterIndex,
    purpose,
    beat,
    requiredContinuity,
    endingPressure,
    ...(imageMoment ? { imageMoment } : {})
  };
}

function repairedEndingPressureFallback(options: RepairPageBriefOptions): string {
  const feedback = [...options.report.issues, ...options.report.requiredRevisions, options.report.notes].join(" ");
  const authorityContext = `${feedback} ${options.plan.premise} ${options.chapter?.summary ?? ""}`;
  if (/\b(?:archiv\w*|preserv\w*|surviv\w*|record|silence|evidence)\b/i.test(feedback) && /\b(?:power|authority|govern|leadership|sovereignty|suprem)\b/i.test(authorityContext)) {
    return "Surviving records establish a minimum threshold of documented female authority rather than proof that power was absent where evidence was lost.";
  }
  return "The new material establishes one evidence-bound implication for the central claim.";
}

function compactPriorPages(pages: PriorPageContext[], count: number, excerptLength: number) {
  return pages.slice(-count).map((page) => ({
    index: page.index,
    title: page.title,
    summary: page.summary,
    excerpt: page.markdown.slice(0, excerptLength)
  }));
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^page\s+\d+\s*[:\-]\s*/i, "")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(first: string, second: string): number {
  const firstShingles = shingles(tokenize(first), 3);
  const secondShingles = shingles(tokenize(second), 3);
  if (firstShingles.size === 0 || secondShingles.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const shingle of firstShingles) {
    if (secondShingles.has(shingle)) {
      shared += 1;
    }
  }
  return shared / Math.min(firstShingles.size, secondShingles.size);
}

function keywordOverlap(first: string, second: string): number {
  const firstKeywords = new Set(tokenize(first).filter((token) => !SUMMARY_STOP_WORDS.has(token)));
  const secondKeywords = new Set(tokenize(second).filter((token) => !SUMMARY_STOP_WORDS.has(token)));
  if (firstKeywords.size < 4 || secondKeywords.size < 4) {
    return 0;
  }
  let shared = 0;
  for (const keyword of firstKeywords) {
    if (secondKeywords.has(keyword)) {
      shared += 1;
    }
  }
  return shared / Math.min(firstKeywords.size, secondKeywords.size);
}

function shingles(tokens: string[], size: number): Set<string> {
  const output = new Set<string>();
  for (let index = 0; index <= tokens.length - size; index += 1) {
    output.add(tokens.slice(index, index + size).join(" "));
  }
  return output;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function countReadableWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function sentenceLengthStats(text: string): { average: number; max: number } {
  const sentenceWordCounts = splitSentences(text).map(countReadableWords).filter((count) => count > 0);
  if (sentenceWordCounts.length === 0) {
    return { average: 0, max: 0 };
  }
  const total = sentenceWordCounts.reduce((sum, count) => sum + count, 0);
  return {
    average: total / sentenceWordCounts.length,
    max: Math.max(...sentenceWordCounts)
  };
}

function hasFormulaicProofLeap(text: string): boolean {
  return PROOF_LEAP_PATTERNS.some((pattern) => pattern.test(text));
}

function hasFormulaicAdjacentContrast(text: string): boolean {
  const sentences = splitSentences(text).filter((sentence) => tokenize(sentence).length >= 4);
  for (let index = 0; index < sentences.length - 1; index += 1) {
    const current = sentences[index]!;
    const next = sentences[index + 1]!;
    const pair = `${current} ${next}`;
    if (
      RHETORICAL_SETUP_PATTERNS.some((pattern) => pattern.test(current)) &&
      CONTRAST_RESOLUTION_PATTERNS.some((pattern) => pattern.test(next)) &&
      THESIS_ABSTRACTION_PATTERN.test(pair)
    ) {
      return true;
    }
    if (
      BROAD_NEGATION_PATTERN.test(current) &&
      THESIS_SENTENCE_START_PATTERN.test(next) &&
      THESIS_ABSTRACTION_PATTERN.test(next)
    ) {
      return true;
    }
  }
  return false;
}

function hasExcessiveDashUse(text: string): boolean {
  const dashCount = (text.match(/[—–]/g) ?? []).length;
  if (dashCount < 4) {
    return false;
  }
  const wordCount = Math.max(1, tokenize(text).length);
  const sentenceCount = Math.max(1, splitSentences(text).length);
  return dashCount / wordCount >= 0.018 || dashCount / sentenceCount >= 0.35;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function hasVagueEnding(draft: PageDraft): boolean {
  const endingText = `${draft.markdown}\n${draft.summary}`.toLowerCase();
  const hasVagueSignal = VAGUE_ENDING_PATTERNS.some((pattern) => pattern.test(endingText));
  const hasResolutionSignal = RESOLUTION_PATTERNS.some((pattern) => pattern.test(endingText));
  return hasVagueSignal && !hasResolutionSignal;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function parseChapterBriefFromModel(raw: unknown, options: GenerateChapterBriefOptions): ChapterBrief {
  const unwrapped = unwrapModelObject(raw, ["chapterBrief", "brief", "productionBrief", "data", "result"]);
  const pageBeats = findPageBeatArray(unwrapped) ?? findPageBeatArray(raw);
  if (!pageBeats || pageBeats.length === 0) {
    throw new Error(
      `Chapter brief did not include a usable pages/pageBeats array. Root keys: ${objectKeys(raw)}. Chapter keys: ${objectKeys(unwrapped)}.`
    );
  }

  const chapterRecord = isRecord(unwrapped) ? unwrapped : {};
  const fallbackRecord = isRecord(raw) ? raw : {};
  const inferredChapterIndex =
    numberField(chapterRecord, ["chapterIndex", "chapterNumber", "chapter"]) ??
    numberField(fallbackRecord, ["chapterIndex", "chapterNumber", "chapter"]) ??
    options.chapter.index;
  const expectedPages = range(options.chapterPageStart, options.chapterPageEnd);

  const canonical = {
    chapterIndex: inferredChapterIndex,
    title:
      stringField(chapterRecord, ["title", "chapterTitle", "name"]) ??
      stringField(fallbackRecord, ["title", "chapterTitle", "name"]) ??
      options.chapter.title,
    summary:
      stringField(chapterRecord, ["summary", "chapterSummary", "overview", "description"]) ??
      stringField(fallbackRecord, ["summary", "chapterSummary", "overview", "description"]) ??
      options.chapter.summary,
    pages: pageBeats.map((page, index) => normalizeModelPageBeat(page, index, expectedPages, inferredChapterIndex)),
    continuityFocus:
      stringArrayField(chapterRecord, ["continuityFocus", "continuity", "continuityNotes", "requiredContinuity"]) ??
      stringArrayField(fallbackRecord, ["continuityFocus", "continuity", "continuityNotes", "requiredContinuity"]) ??
      []
  };

  return applyChapterContextToBrief(chapterBriefSchema.parse(canonical), options);
}

function applyChapterContextToBrief(brief: ChapterBrief, options: GenerateChapterBriefOptions): ChapterBrief {
  const expectedPages = range(options.chapterPageStart, options.chapterPageEnd);
  const usesLocalPageNumbers =
    brief.pages.length === expectedPages.length && brief.pages.every((page, index) => page.pageIndex === index + 1);
  return {
    ...brief,
    chapterIndex: options.chapter.index,
    title: brief.title.trim() || options.chapter.title,
    summary: brief.summary.trim() || options.chapter.summary,
    pages: brief.pages.map((page, index) => ({
      ...page,
      chapterIndex: options.chapter.index,
      pageIndex: usesLocalPageNumbers ? expectedPages[index]! : page.pageIndex
    }))
  };
}

function normalizeModelPageBeat(
  value: unknown,
  index: number,
  expectedPages: number[],
  chapterIndex: number
): PageProductionBeat {
  const record = isRecord(value) ? value : {};
  const textBeat = typeof value === "string" ? value : undefined;
  const pageIndex =
    numberField(record, ["pageIndex", "pageNumber", "page", "index", "globalPageIndex"]) ??
    expectedPages[index] ??
    expectedPages[0]! + index;
  const purpose = stringField(record, ["purpose", "pagePurpose", "goal", "objective", "function"]) ?? textBeat;
  const beat =
    stringField(record, ["beat", "pageBeat", "action", "event", "scene", "description", "summary", "content"]) ??
    purpose;

  return {
    pageIndex,
    chapterIndex,
    purpose: purpose ?? `Advance the chapter on page ${pageIndex}.`,
    beat: beat ?? `Advance the chapter with a concrete, non-repetitive beat on page ${pageIndex}.`,
    requiredContinuity: stringArrayField(record, ["requiredContinuity", "continuity", "continuityNotes"]) ?? [],
    endingPressure:
      stringField(record, ["endingPressure", "nextPagePressure", "hook", "transition", "endingHook", "pageTurn"]) ??
      "Leave a concrete reason for the next page to continue.",
    imageMoment: stringField(record, ["imageMoment", "visualMoment", "imagePrompt", "illustrationMoment"])
  };
}

function unwrapModelObject(value: unknown, keys: string[]): unknown {
  if (!isRecord(value)) {
    return value;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return value;
}

function findPageBeatArray(value: unknown): unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["pages", "pageBeats", "page_beats", "pagebeats", "beats", "pagePlans", "page_plans"]) {
    const candidate = arrayLikeField(value, key);
    if (candidate && (key.toLowerCase().includes("page") || looksLikePageBeatArray(candidate))) {
      return candidate;
    }
  }

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) && looksLikePageBeatArray(nested)) {
      return nested;
    }
    const candidate = findPageBeatArray(nested);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function arrayLikeField(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const nestedKey of ["items", "list", "pages", "pageBeats", "page_beats", "beats"]) {
    const nested = value[nestedKey];
    if (Array.isArray(nested)) {
      return nested;
    }
  }
  const entries = Object.entries(value);
  if (entries.length > 0 && entries.every(([entryKey]) => /^\d+$/.test(entryKey))) {
    return entries.sort(([first], [second]) => Number(first) - Number(second)).map(([, item]) => item);
  }
  return undefined;
}

function looksLikePageBeatArray(value: unknown[]): boolean {
  return value.length > 0 && value.some(looksLikePageBeat);
}

function looksLikePageBeat(value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return [
    "pageIndex",
    "pageNumber",
    "page",
    "pageBeat",
    "beat",
    "purpose",
    "pagePurpose",
    "endingPressure",
    "nextPagePressure",
    "hook",
    "scene"
  ].some((key) => key in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function stringArrayField(record: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return undefined;
}

function objectKeys(value: unknown): string {
  return isRecord(value) ? Object.keys(value).join(", ") || "(none)" : "(not an object)";
}

function normalizeIssueList(issues: string[], fallback: string): string[] {
  return issues.length > 0 ? issues : [fallback];
}

const PLACEHOLDER_PATTERNS = [
  /approved premise/i,
  /concrete detail anchors/i,
  /language stays deliberate/i,
  /scene advances one small promise/i,
  /useful pressure/i,
  /mock_ai placeholder/i,
  /placeholder page/i,
  /drafted content for/i
];

const PROMPT_LEAK_PATTERNS = [
  /global visual style/i,
  /continuity rules:/i,
  /return json/i,
  /json schema/i,
  /pageinstruction/i,
  /image prompt/i,
  /avoid text inside images/i,
  /generation instructions/i,
  /production instructions/i,
  /do not mention ai/i
];

const PAGE_BRIEF_META_LANGUAGE_PATTERNS = [
  /\b(?:concluding|conclude|concludes|closing|close|ending|end)\s+the\s+(?:survey|chapter|section|discussion|analysis|page)\b/i,
  /\b(?:the|this)\s+(?:survey|chapter|section|discussion|analysis|page)\s+(?:concludes|closes|ends|transitions|moves|prepares|sets up)\b/i,
  /\b(?:transition(?:s|ing)?|shift(?:s|ing)?|move(?:s|ing)?|prepare(?:s|ing)?)\s+(?:the\s+reader\s+)?(?:from|toward|to|into|away from|for)\s+(?:the\s+)?(?:next|following|subsequent)\s+(?:chapter|section|analysis|focus)\b/i,
  /\b(?:sets?|leaves)\s+up\s+(?:the\s+)?(?:next|following|subsequent)\s+(?:chapter|section|analysis|focus)\b/i
];

function hasPageBriefMetaLanguage(text: string): boolean {
  return PAGE_BRIEF_META_LANGUAGE_PATTERNS.some((pattern) => pattern.test(text));
}

const FABRICATED_RESEARCH_PATTERNS = [
  /\b(?:fictional|fabricated|invented|made[-\s]?up)\b.{0,100}\b(?:stud(?:y|ies)|data|journal|institute|authority|research|project|statistics|evidence|source|citation|expert|findings?)\b/i,
  /\b(?:stud(?:y|ies)|data|journal|institute|authority|research|project|statistics|evidence|source|citation|expert|findings?)\b.{0,100}\b(?:fictional|fabricated|invented|made[-\s]?up)\b/i,
  /\bfabricated data\b/i,
  /\binvented longitudinal studies\b/i
];

const PROOF_LEAP_PATTERNS = [
  /\b(?:this|that|it)\s+(?:is|was)\s+not\s+(?:a\s+)?coincidence\b.{0,140}\b(?:sign|proof|evidence|indication|revelation|reveals?|shows?|means|proves?|demonstrates?|divine)\b/i,
  /\bno\s+accident\b.{0,140}\b(?:sign|proof|evidence|indication|revelation|reveals?|shows?|means|proves?|demonstrates?|divine)\b/i,
  /\bhidden\s+in\s+plain\s+sight\b/i,
  /\bthe\s+truth\s+is\s+that\b.{0,140}\b(?:superior|supremacy|inferior|destiny|essence|divine|ultimate|absolute)\b/i
];

const RHETORICAL_SETUP_PATTERNS = [
  /\bwhere\s+are\b/i,
  /\bwhat\s+of\b/i,
  /\byou\s+(?:have\s+been\s+taught|might\s+object|may\s+ask)\b/i,
  /\bbut\s+what\s+if\b/i,
  /\bpause\s+and\s+reflect\b/i
];

const CONTRAST_RESOLUTION_PATTERNS = [
  /^(?:they|he|she|it|this|that)\s+(?:are|is|was|were)\b/i,
  /^(?:instead|but|yet|and yet|the truth is|what this means is)\b/i,
  /\b(?:not\s+.+;\s+(?:it|they|this|that)\s+(?:is|are)|opposite|therefore|thus)\b/i
];

const THESIS_ABSTRACTION_PATTERN =
  /\b(?:truth|sign|proof|evidence|indication|superiority|supremacy|primacy|hierarchy|destiny|essence|divine|original|supreme|ultimate|inferiority)\b/i;

const BROAD_NEGATION_PATTERN = /\b(?:not|never|opposite|absent|wrong|misread|misunderstood|been taught)\b/i;
const THESIS_SENTENCE_START_PATTERN = /^(?:this|that|it|the truth|therefore|thus|instead)\b/i;

const SCAFFOLD_SHAPE_PATTERNS = [
  /\bthe page opens\b/i,
  /\bthe scene advances\b/i,
  /\bstaying close to the book\b/i,
  /\bleaves the next page\b/i
];

const VAGUE_ENDING_PATTERNS = [
  /\bnothing\.?\s+everything\b/i,
  /\bnothing\b.{0,80}\beverything\b/i,
  /\bthe rest (?:was|is) silence\b/i,
  /\bwhat came next\b/i,
  /\bwhatever came next\b/i,
  /\binto the unknown\b/i,
  /\bthe beginning\b/i,
  /\bnot the end\b/i
];

const RESOLUTION_PATTERNS = [
  /\bresolved\b/i,
  /\bforgave\b/i,
  /\bconfessed\b/i,
  /\bfreed\b/i,
  /\bsurrendered\b/i,
  /\bacquitted\b/i,
  /\breturned\b/i,
  /\bchose\b/i,
  /\bpromised\b/i,
  /\bsigned\b/i,
  /\bburied\b/i,
  /\bopened\b/i,
  /\bclosed\b/i
];

const SUMMARY_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "before",
  "between",
  "into",
  "through",
  "with",
  "without",
  "from",
  "that",
  "this",
  "what",
  "when",
  "where",
  "while",
  "they",
  "them",
  "their",
  "page",
  "jack",
  "chapter",
  "story"
]);
