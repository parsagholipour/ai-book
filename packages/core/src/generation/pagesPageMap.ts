import { z } from "zod";
import type { TextModelAdapter } from "../adapters/types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { CONTINUITY_NOTE_PROMPT_LIMITS, continuityNotesForPrompt } from "../context/contextPack.js";
import {
  targetLanguageGenerationGuidance,
  targetLanguagePayload
} from "../prompting/language.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import {
  FIRST_PAGE_ENDING_PRESSURE,
  LAST_PAGE_ENDING_PRESSURE,
  firstPageBriefFieldsForRange,
  pageEndingContract
} from "./pageBriefContract.js";
import { normalizePlanPageTargets } from "./planner.js";
import type {
  BookPlan,
  ChapterBrief,
  ChapterPlan,
  CreateProjectInput,
  PageProductionBeat,
  PageQualityReport
} from "../schemas/book.js";
import { chapterBriefSchema, pageProductionBeatSchema } from "../schemas/book.js";
import { hasPageBriefMetaLanguage } from "./pagesLocalQa.js";
import type { ReviewPageOptions } from "./pagesReview.js";
import {
  GROUNDED_FACTUALITY_RULE,
  arrayLikeField,
  chapterBriefPayloadForPageScope,
  compactPriorPages,
  isRecord,
  numberField,
  objectKeys,
  openingContractForRange,
  pageScopePayload,
  plannerToneRules,
  range,
  stringArrayField,
  stringField,
  styleGuidancePayload,
  unwrapModelObject
} from "./pagesShared.js";

/**
 * The production-editor layer: the global page-by-page production map, the
 * per-chapter briefs behind it, and the brief repair loop QA falls back to.
 * Split out of pages.ts, which re-exports everything public so
 * `@book-maker/core` is unchanged.
 *
 * Four of the five writers of page 1's brief live here, and none of them owns
 * the contract it writes that brief under. `pageBriefContract.ts` does, and
 * every rule line in this file is reached through its
 * `firstPageBriefFieldsForRange`. The fifth writer, `pageMapCritic.ts`, reads
 * that module rather than this one.
 */

export type GenerateChapterBriefOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  chapterPageStart: number;
  chapterPageEnd: number;
  textModel: TextModelAdapter;
};

export type GeneratePageMapOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  textModel: TextModelAdapter;
};

export type RepairPageBriefOptions = ReviewPageOptions & {
  pageBrief: PageProductionBeat;
  report: PageQualityReport;
};

/**
 * The ceiling for a pass that **rewrites work the pipeline already produced**,
 * rather than creating it: `repairPageBrief` below, rewriting an assignment QA
 * rejected, and `polishPageDraft` (`pages.ts`), rewriting the page that
 * assignment produced. Sampled at the book's own creative temperature a rewrite
 * stops improving what it was handed and starts replacing it.
 *
 * It is a ceiling, not a setting: a book configured cooler keeps its own
 * temperature. It lives here because `pages.ts` imports this module and not the
 * other way round — the two passes used to clamp to independent `0.65`
 * literals with a comment in `pages.ts` asserting they were one number, so
 * moving the ceiling moved only the polish path.
 */
export const REWRITE_TEMPERATURE_CEILING = 0.65;

const CHUNKED_PAGE_MAP_THRESHOLD = 24;

const wholeBookPageMapSchema = z.object({
  pages: z.array(pageProductionBeatSchema).min(1)
});

export async function generateWholeBookPageMap(options: GeneratePageMapOptions): Promise<ChapterBrief[]> {
  if (options.input.targetPages > CHUNKED_PAGE_MAP_THRESHOLD) {
    return generateChunkedPageMap(options);
  }

  // This pass maps the whole book, so it is always the one that briefs page 1.
  const firstPage = firstPageBriefFieldsForRange(options, 1, options.input.targetPages);
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
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: "generate-page-map",
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
            ...firstPage.rules,
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
              ...firstPage.payload,
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
  // This brief is chapter-scoped, so only the chapter whose absolute page range
  // covers global page 1 opens the book; telling every chapter to hook a first
  // impression would hook a reader who is already twenty pages in. The test is
  // on the range this call was handed rather than on the chapter index, because
  // a leading chapter that ended up with no pages hands page 1 to the next one —
  // which is why `writesFirstPage` (`pagesShared.ts`), under the helper below,
  // is a range predicate and not an index one.
  const firstPage = firstPageBriefFieldsForRange(options, options.chapterPageStart, options.chapterPageEnd);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "generate-chapter-brief",
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
          ...firstPage.rules,
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
            ...firstPage.payload,
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

export async function repairPageBrief(options: RepairPageBriefOptions): Promise<PageProductionBeat> {
  // `pageIndex` on a review/repair call is the *global* page index — it is what
  // `pageScopePayload` publishes as `globalPageIndex` — so this is the book's
  // first page whatever chapter the repair happens to be scoped to, and it
  // stays right for a page 1 redrafted inside a finished book. A repair rewrites
  // exactly one page, so it asks the range question in its one-page form.
  const firstPage = firstPageBriefFieldsForRange(options, options.pageIndex, options.pageIndex);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "repair-page-brief",
    temperature: Math.min(REWRITE_TEMPERATURE_CEILING, options.input.temperature),
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
          // Placed after the two endingPressure rules above because page 1
          // amends them rather than replacing them: the landing still has to be
          // a concrete claim the prose earns, and it also has to leave the
          // second page something to answer.
          ...firstPage.rules,
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
            ...firstPage.payload,
            chapter: options.chapter,
            chapterBrief: chapterBriefPayloadForPageScope(options.chapterBrief),
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
            continuityNotes: continuityNotesForPrompt(options.continuityNotes, CONTINUITY_NOTE_PROMPT_LIMITS.review),
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
  const handoffPressure =
    chapterPageNumber === options.pageCount && nextChapter ? `Hand off cleanly toward ${nextChapter.title}.` : undefined;
  // The chapter hand-off composes with the opening tension rather than shadowing
  // it, because a one-page first chapter is both: the tension is what page 1 owes
  // the reader, and the named hand-off is the only thing telling page 2 which
  // chapter it is opening. Ranking the first-page rule above the hand-off left
  // page 2 starting a chapter nothing had set up. The book's own ending never
  // composes and wins outright — a one-page book resolves its promise instead of
  // teasing a page 2 that does not exist — which is the ranking
  // `pageEndingContract` (`pageBriefContract.ts`) holds for all five producers,
  // so this reads it rather than deciding it again.
  const contract = pageEndingContract(options.pageIndex, options.input.targetPages);
  const endingPressure =
    contract === "ending"
      ? LAST_PAGE_ENDING_PRESSURE
      : contract === "opening"
        ? handoffPressure
          ? `${FIRST_PAGE_ENDING_PRESSURE} ${handoffPressure}`
          : FIRST_PAGE_ENDING_PRESSURE
        : (handoffPressure ?? "End with a concrete reason the next assigned page must continue.");
  const baseBeat = `${assignedBeat} Keep the page focused on ${options.chapter.summary}`;
  // The hook is *assigned* here, never pasted, which is the whole of
  // `OPENING_HOOK_BRIEF_RULE`'s docstring in `pageBriefContract.ts`. Every
  // prompt that carries a page-1 pageBrief already carries `plan.openingHook`
  // beside it as its own key — the draft (`pageDraftMessages.ts`), the review
  // and revision passes (`pagesReview.ts`), the bulk draft (`pages.ts`) — and
  // `buildPageInstruction` tells that same writer to deliver the hook "without
  // echoing its wording". A copy of the hook's prose inside the beat is
  // therefore one string the writer is told to transform
  // (READER_FACING_PAGE_BRIEF_RULES) and to leave unechoed at the same time,
  // and on this path there is no model call to reconcile the two. So the brief
  // states the assignment and the payload field supplies the words.
  //
  // Which is why this is the one first-page site that reads the contract rather
  // than stating it through `firstPageBriefFieldsForRange`: it writes no prompt,
  // so it has no rule line to state and no payload to carry the key — the
  // condition is all of the contract it can hold. It is still the same contract,
  // read from the same `openingContractForRange` (`pagesShared.ts`) the four
  // prompt producers reach through the brief helper, because the one thing this
  // path must not do is answer the question differently: an imported manuscript's
  // hook is invented by a plan revision that never saw page 1, and a purpose line
  // assigning it here would send the writer after the author's own first sentence
  // with no `openingHook` payload anywhere in the prompt that drafts it.
  const openingHook = openingContractForRange(options, options.pageIndex, options.pageIndex).openingHook;
  const openingPurpose = openingHook
    ? `Opening page of the book for ${options.chapter.title}. Deliver the plan's openingHook here, in the page's own prose.`
    : `Opening page of the book for ${options.chapter.title}.`;

  return {
    pageIndex: options.pageIndex,
    chapterIndex: options.chapter.index,
    purpose: options.pageIndex === 1 ? openingPurpose : `${capitalize(position)} for ${options.chapter.title}.`,
    beat: baseBeat,
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
  // Each chapter's brief depends only on the plan and that chapter, so the
  // chunks run in a small pool instead of one model latency per chapter.
  return mapWithConcurrency(chapterSetups, CHAPTER_BRIEF_CONCURRENCY, (setup) =>
    generateChapterBrief({
      input: options.input,
      plan: options.plan,
      chapter: setup.chapter,
      chapterPageStart: setup.startPage,
      chapterPageEnd: setup.endPage,
      textModel: options.textModel
    })
  );
}

const CHAPTER_BRIEF_CONCURRENCY = 3;

export function pageMapForRange(chapterBriefs: ChapterBrief[], pageStart: number, pageEnd: number): PageProductionBeat[] {
  return chapterBriefs
    .flatMap((brief) => brief.pages)
    .filter((page) => page.pageIndex >= pageStart && page.pageIndex <= pageEnd)
    .sort((first, second) => first.pageIndex - second.pageIndex);
}

export function pageMapForWholeBookDraft(chapterBriefs: ChapterBrief[]) {
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

/**
 * The last-resort pressure when the model's own is empty or meta-laden. It is
 * deliberately blind to {@link pageEndingContract}: both of that function's
 * sentences are worded as instructions to the writer ("End the first page
 * with…", "Resolve the book's…"), which is exactly the procedural shape the
 * repair contract above forbids and the shape QA rejected to get here — pasting
 * one in would fail the next review on the one page that can least afford it.
 * The `fallbackPageBeatFromChapter` composition has no counterpart here for the
 * same reason its other half does not exist: a repair is scoped to one page
 * inside the current chapter and never names a next chapter to hand off to, so
 * there is nothing for a first-page pressure to compose with. Page 1's tension
 * and the last page's resolution are carried by the prompt rules instead, where
 * the model can phrase either as a claim.
 */
function repairedEndingPressureFallback(options: RepairPageBriefOptions): string {
  const feedback = [...options.report.issues, ...options.report.requiredRevisions, options.report.notes].join(" ");
  const authorityContext = `${feedback} ${options.plan.premise} ${options.chapter?.summary ?? ""}`;
  if (/\b(?:archiv\w*|preserv\w*|surviv\w*|record|silence|evidence)\b/i.test(feedback) && /\b(?:power|authority|govern|leadership|sovereignty|suprem)\b/i.test(authorityContext)) {
    return "Surviving records establish a minimum threshold of documented female authority rather than proof that power was absent where evidence was lost.";
  }
  return "The new material establishes one evidence-bound implication for the central claim.";
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

function looksLikePageBeatArray(value: unknown[]): boolean {
  return value.some(looksLikePageBeat);
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
