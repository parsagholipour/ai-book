import { generateCompactPictureBookMap, usesCompactPictureBookPlanning } from "./compactPictureBookPlanning.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { modelTierForInput } from "../adapters/modelTiers.js";
import { stampChapterBriefPhysicalAttempt, type TextModelAdapter } from "../adapters/types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { range } from "../collections.js";
import {
  targetLanguageGenerationGuidance,
  targetLanguagePayload
} from "../prompting/language.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import { chapterBriefRepairFields, type ChapterBriefRepairContext } from "./chapterBriefRepairContext.js";
import {
  PageMapResponseInvalidError,
  generatedChapterBriefResponseSchema,
  pageMapResponseInvalidErrorFromSchemaError,
  type GeneratedChapterBriefContract
} from "./generatedChapterBriefAcceptance.js";
import { evidenceLedgerFields, evidenceLedgerOutputContract, evidenceLedgerRules } from "./evidenceLedger.js";
import {
  MODEL_PAGE_ARRAY_KEYS,
  MODEL_PAGE_BEAT_KEYS,
  MODEL_PAGE_CLAIM_KEYS,
  MODEL_PAGE_CONTINUITY_KEYS,
  MODEL_PAGE_ENDING_PRESSURE_KEYS,
  MODEL_PAGE_EVIDENCE_ANCHOR_KEYS,
  MODEL_PAGE_IMAGE_MOMENT_KEYS,
  MODEL_PAGE_INDEX_KEYS,
  MODEL_PAGE_PURPOSE_KEYS
} from "./generatedPageResponse.js";
import {
  FIRST_PAGE_ENDING_PRESSURE,
  LAST_PAGE_ENDING_PRESSURE,
  firstPageBriefFieldsForRange,
  pageEndingContract
} from "./pageBriefContract.js";
import { finalizeProductionPageBeat, OPENING_PAGE_SCOPE_RULES } from "./pageBriefOpeningScope.js";
import { normalizePlanPageTargets } from "./planner.js";
import type {
  BookPlan,
  ChapterBrief,
  ChapterPlan,
  CreateProjectInput,
  PageProductionBeat
} from "../schemas/book.js";
import { chapterBriefSchema, pageProductionBeatSchema } from "../schemas/book.js";
import {
  arrayLikeField,
  citationContractFields,
  isRecord,
  numberField,
  objectKeys,
  openingContractForRange,
  plannerToneRules,
  stringArrayField,
  stringField,
  styleGuidancePayload
} from "./pagesShared.js";
import { pagePromptBookStyle } from "./styleContract.js";

/**
 * The production-editor layer: the global page-by-page production map and the
 * per-chapter briefs behind it. (The brief repair QA fell back to was removed
 * with the per-page review chain, 2026-10-16.)
 * Split out of pages.ts, which re-exports everything public so
 * `@book-maker/core` is unchanged.
 *
 * The writers of page 1's brief live here, and none of them owns the contract
 * it writes that brief under. `pageBriefContract.ts` does, and every rule line
 * in this file is reached through its `firstPageBriefFieldsForRange`. (The
 * page-map critic and the brief repair read that module too until they were
 * removed on 2026-10-16.)
 */

export type GenerateChapterBriefOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  chapter: ChapterPlan;
  chapterPageStart: number;
  chapterPageEnd: number;
  /** Filtered generation notes; falls back to citeable plan notes when absent. */
  researchNotes?: string[] | undefined;
  repairContext?: ChapterBriefRepairContext;
  textModel: TextModelAdapter;
};

export type GeneratePageMapOptions = {
  input: CreateProjectInput;
  plan: BookPlan;
  textModel: TextModelAdapter;
};

const CHUNKED_PAGE_MAP_THRESHOLD = 24;
const CHAPTER_BRIEF_REPAIR_ATTEMPTS = 2;

const wholeBookPageMapSchema = z.object({
  pages: z.array(pageProductionBeatSchema).min(1)
});

export async function generateWholeBookPageMap(options: GeneratePageMapOptions): Promise<ChapterBrief[]> {
  if (usesCompactPictureBookPlanning(options.input)) return generateCompactPictureBookMap({ ...options, chapterRanges: chapterRangesForPlan(options.plan, options.input.targetPages) });
  if (options.input.targetPages > CHUNKED_PAGE_MAP_THRESHOLD) {
    return generateChunkedPageMap(options);
  }

  // This pass maps the whole book, so it is always the one that briefs page 1.
  const firstPage = firstPageBriefFieldsForRange(options, 1, options.input.targetPages);
  const citation = citationContractFields(options.plan.researchNotes);
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
            ...evidenceLedgerRules(options.input, options.plan, "producer"),
            "Use global page indexes, not chapter-local page numbers.",
            ...OPENING_PAGE_SCOPE_RULES,
            ...citation.rules,
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
                ...pagePromptBookStyle(options.plan),
                continuityRules: options.plan.continuityRules,
                styleGuidance: styleGuidancePayload(options.input)
              },
              ...firstPage.payload,
              ...citation.payload,
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
                    imageMoment: "Optional single visual moment for illustration.",
                    ...evidenceLedgerOutputContract(options.input, options.plan)
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
  const contract: GeneratedChapterBriefContract = {
    chapterIndex: options.chapter.index,
    pageRange: { start: options.chapterPageStart, end: options.chapterPageEnd },
    allowCompleteLocalPageNumbering: true
  };
  // Only the absolute range containing page 1 opens the book, even when a
  // zero-page leading chapter hands that page to the next chapter.
  const firstPage = firstPageBriefFieldsForRange(options, options.chapterPageStart, options.chapterPageEnd);
  const citation = citationContractFields(options.researchNotes ?? options.plan.researchNotes);
  const repair = chapterBriefRepairFields(options);
  try {
    const result = await generateJsonWithRetry(options.textModel, {
      purpose: "generate-chapter-brief",
      providerCallMetadata: {
        chapterBriefLogicalCallId: randomUUID(),
        chapterBriefTier: modelTierForInput(options.input),
        chapterBriefChapterIndex: contract.chapterIndex,
        chapterBriefPageStart: contract.pageRange.start,
        chapterBriefPageEnd: contract.pageRange.end,
        chapterBriefAttempt: 1,
        chapterBriefMaxAttempts: CHAPTER_BRIEF_REPAIR_ATTEMPTS + 1
      },
      temperature: Math.min(0.7, options.input.temperature),
      maxTokens: 5000,
      schema: generatedChapterBriefResponseSchema(contract),
      repairAttempts: CHAPTER_BRIEF_REPAIR_ATTEMPTS,
      annotatePhysicalAttempt: stampChapterBriefPhysicalAttempt,
      messages: [
        {
          role: "system",
          content: [
            "You are the production editor for a long-form book.",
            "Create a practical chapter brief for the writer.",
            "Every page in the requested range must receive a distinct page beat.",
            "The beats must prevent filler, repetition, and generic endings.",
            ...repair.rules,
            ...evidenceLedgerRules(options.input, options.plan, "producer"),
            "Return exactly one root JSON object with chapterIndex, title, summary, pages, and continuityFocus.",
            "Use pages for the page beat array; do not return pageBeats as the root shape.",
            // The keys are named and shown because prose alone had the model
            // inventing them from the words: "concrete action or explanation"
            // came back as concreteActionOrExplanation, action_or_explanation,
            // or a beat object holding purpose and action, and every one of
            // those was rejected by the strict brief acceptance and re-asked.
            "Each entry in pages is one flat page object shaped exactly like outputContract.pages[0]: pageIndex, chapterIndex, purpose, beat, requiredContinuity, endingPressure and optional imageMoment are its own top-level keys, spelled exactly that way, never nested inside beat or renamed.",
            ...OPENING_PAGE_SCOPE_RULES,
            ...citation.rules,
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
                ...pagePromptBookStyle(options.plan),
                continuityRules: options.plan.continuityRules,
                styleGuidance: styleGuidancePayload(options.input)
              },
              ...firstPage.payload,
              ...citation.payload,
              chapter: options.chapter,
              ...repair.payload,
              pageRange: {
                start: options.chapterPageStart,
                end: options.chapterPageEnd,
                globalPageIndexes: expectedPages
              },
              outputContract: {
                chapterIndex: contract.chapterIndex,
                title: "The chapter's title.",
                summary: "What the chapter accomplishes, in one short paragraph.",
                pages: [
                  {
                    pageIndex: contract.pageRange.start,
                    chapterIndex: contract.chapterIndex,
                    purpose: "One sentence describing what this page must accomplish.",
                    beat: "One concrete action, explanation, or story turn assigned to this page.",
                    requiredContinuity: ["Continuity facts that must stay true on this page."],
                    endingPressure: "The page's concrete handoff to the next page.",
                    imageMoment: "Optional single visual moment for illustration.",
                    ...evidenceLedgerOutputContract(options.input, options.plan)
                  }
                ],
                continuityFocus: ["Continuity facts the whole chapter must keep straight."]
              },
              instruction:
                "Return one page object for each of pageRange.globalPageIndexes, in order, shaped exactly like outputContract.pages[0]. purpose, beat, requiredContinuity, endingPressure, and optional imageMoment are top-level keys of every page object, and beat is a string holding the page's concrete action or explanation, never an object."
            },
            null,
            2
          )
        }
      ]
    });

    return applyChapterContextToBrief(result.data, options);
  } catch (error) {
    const typed =
      error instanceof PageMapResponseInvalidError
        ? error
        : pageMapResponseInvalidErrorFromSchemaError(error, contract);
    if (typed) {
      throw typed;
    }
    throw error;
  }
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
      .map((page) =>
        finalizeProductionPageBeat(
          {
            ...page,
            chapterIndex: rangeInfo.chapter.index
          },
          options.plan.researchNotes,
          {
            chapter: rangeInfo.chapter,
            chapterPageStart: rangeInfo.startPage,
            chapterPageEnd: rangeInfo.endPage
          }
        )
      );

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
      finalizeProductionPageBeat(
        fallbackPageBeatFromChapter({
          input: options.input,
          plan: options.plan,
          chapter: rangeInfo.chapter,
          pageIndex,
          localIndex: index,
          pageCount: pageIndexes.length
        }),
        options.plan.researchNotes,
        {
          chapter: rangeInfo.chapter,
          chapterPageStart: rangeInfo.startPage,
          chapterPageEnd: rangeInfo.endPage
        }
      )
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
        imageMoment: page.imageMoment,
        ...evidenceLedgerFields(page)
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

function applyChapterContextToBrief(brief: ChapterBrief, options: GenerateChapterBriefOptions): ChapterBrief {
  return {
    ...brief,
    chapterIndex: options.chapter.index,
    title: brief.title.trim() || options.chapter.title,
    summary: brief.summary.trim() || options.chapter.summary,
    pages: brief.pages.map((page) =>
      finalizeProductionPageBeat(
        {
          ...page,
          chapterIndex: options.chapter.index,
          pageIndex: page.pageIndex
        },
        options.researchNotes ?? options.plan.researchNotes,
        {
          chapter: options.chapter,
          chapterPageStart: options.chapterPageStart,
          chapterPageEnd: options.chapterPageEnd
        }
      )
    )
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
    numberField(record, [...MODEL_PAGE_INDEX_KEYS]) ?? expectedPages[index] ?? expectedPages[0]! + index;
  const purpose = stringField(record, [...MODEL_PAGE_PURPOSE_KEYS]) ?? textBeat;
  const beat = stringField(record, [...MODEL_PAGE_BEAT_KEYS]) ?? purpose;
  const imageMoment = stringField(record, [...MODEL_PAGE_IMAGE_MOMENT_KEYS]);

  return {
    pageIndex,
    chapterIndex,
    purpose: purpose ?? `Advance the chapter on page ${pageIndex}.`,
    beat: beat ?? `Advance the chapter with a concrete, non-repetitive beat on page ${pageIndex}.`,
    requiredContinuity: stringArrayField(record, [...MODEL_PAGE_CONTINUITY_KEYS]) ?? [],
    endingPressure:
      stringField(record, [...MODEL_PAGE_ENDING_PRESSURE_KEYS]) ??
      "Leave a concrete reason for the next page to continue.",
    ...(imageMoment ? { imageMoment } : {}),
    ...evidenceLedgerFields({
      claim: stringField(record, [...MODEL_PAGE_CLAIM_KEYS]),
      evidenceAnchors: stringArrayField(record, [...MODEL_PAGE_EVIDENCE_ANCHOR_KEYS])
    })
  };
}

function findPageBeatArray(value: unknown): unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of MODEL_PAGE_ARRAY_KEYS) {
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
