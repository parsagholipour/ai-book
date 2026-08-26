import type { TextModelAdapter } from "../adapters/types.js";
import { CONTINUITY_NOTE_PROMPT_LIMITS, continuityNotesForPrompt } from "../context/contextPack.js";
import {
  targetLanguageGenerationGuidance,
  targetLanguagePayload,
  targetLanguageReviewGuidance
} from "../prompting/language.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
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
import { finalBookQaSchema, pageDraftSchema, pageQualityReportSchema } from "../schemas/book.js";
import {
  compactPageMap,
  compactSummaryForQa,
  runLocalFinalQa,
  runLocalPageQualityChecks
} from "./pagesLocalQa.js";
import {
  GROUNDED_FACTUALITY_RULE,
  IMAGE_PROMPT_CHARACTER_RULE,
  INTERNAL_PAGE_TITLE_RULE,
  OPENING_QUALITY_RULE_MARKER,
  READER_FACING_PAGE_BRIEF_RULES,
  buildPageInstruction,
  chapterBriefPayloadForPageScope,
  citationContractFields,
  sanitizePageBriefForCitationContract,
  compactFollowingPages,
  compactPriorPages,
  openingContractFieldsForPage,
  openingContractForRange,
  pageScopePayload,
  reviewerStyleRules,
  styleGuidancePayload,
  writerToneRules,
  type PriorPageContext
} from "./pagesShared.js";

/**
 * The editorial review loop: the model page reviewer, the revision writer and
 * final book QA. Split out of pages.ts, which re-exports everything public so
 * `@book-maker/core` is unchanged.
 */

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
  /**
   * Prose that already exists after this page. Empty for a book written front
   * to back; set when a page is inserted into a finished one, where a reviewer
   * that cannot see what follows reads a correct hand-off as a stalled ending.
   */
  nextPages?: PriorPageContext[] | undefined;
  continuityNotes: string[];
  textModel: TextModelAdapter;
  styleExcerpts?: string[] | undefined;
  /** Citeable generation notes loaded by the worker. */
  researchNotes?: string[] | undefined;
  retrievedResearch?: string[] | undefined;
};

export type RevisePageOptions = ReviewPageOptions & {
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

export async function reviewPageDraft(options: ReviewPageOptions): Promise<PageQualityReport> {
  const localReport = runLocalPageQualityChecks(options);
  if (!localReport.approved) {
    return localReport;
  }

  // Everything this reviewer says about the book's opening, from the same call
  // that decides what its writer was told (`openingContractFields`,
  // pagesShared.ts): the ban when this is page 1 of a book the pipeline wrote,
  // the hook sentence when *that same book's* plan committed to one, and the
  // `openingHook` key that sentence names. Reading the three conditions here is
  // what shipped the ban to page 7 of a forty-page book and to page 1 of an
  // imported manuscript. The hook rides the exemption for a reason this end of
  // the contract makes plain: an import's hook is invented by a plan revision
  // that never saw page 1, and a reviewer told to check page 1 delivers it
  // rejects the author's own opening — a verdict whose only repair is
  // `revisePageDraft` rewriting that page.
  const opening = openingContractFieldsForPage(options, "reviewer");
  const citation = citationContractFields(options.researchNotes ?? options.plan.researchNotes);

  let result: { data: PageQualityReport };
  try {
    result = await generateJsonWithRetry(options.textModel, {
      purpose: "review-page",
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
            ...citation.rules,
            "Treat semantic repetition as a failure even when wording differs: the same encounter, same decision, same exposition, or same emotional turn cannot appear twice.",
            "Do not reject merely because the same character performs a necessary recurring action type assigned by the current pageBrief; reject it only when it restages the same beat, reuses distinctive wording, or fails to add a new consequence.",
            "For a final page, reject vague closure unless it resolves the core promise with a concrete consequence or completed choice.",
            ...opening.rules,
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
                // voiceGuide is a writer assignment. A history plan that said
                // "begin with documented testimony" made this reviewer reject
                // pages that had no citeable notes.
                antiAiRules: options.plan.antiAiRules,
                styleGuidance: styleGuidancePayload(options.input)
              },
              chapter: options.chapter,
              chapterBrief: chapterBriefPayloadForPageScope(options.chapterBrief),
              pageBrief: options.pageBrief
                ? sanitizePageBriefForCitationContract(options.pageBrief, options.researchNotes ?? options.plan.researchNotes)
                : options.pageBrief,
              // This reviewer's first-page rules are system lines rather than a
              // built instruction, so it spreads the payload the shared contract
              // handed it beside those lines; every other page prompt gets the
              // same pair out of `buildPageInstruction`.
              ...opening.payload,
              ...citation.payload,
              pageScope: pageScopePayload(options),
              pageIndex: options.pageIndex,
              draft: options.draft,
              previousPages: compactPriorPages(options.previousPages, 5, 800),
              ...(options.nextPages && options.nextPages.length > 0
                ? { followingPages: compactFollowingPages(options.nextPages, 2, 800) }
                : {}),
              ...(options.styleExcerpts && options.styleExcerpts.length > 0
                ? { styleExcerpts: options.styleExcerpts }
                : {}),
              continuityNotes: continuityNotesForPrompt(options.continuityNotes, CONTINUITY_NOTE_PROMPT_LIMITS.review),
              instruction:
                options.nextPages && options.nextPages.length > 0
                  ? "Approve only if this is a finished, specific page that can appear in the final book without visible generation artifacts or repeated beats. followingPages is prose that already exists after this page: judge progression by whether this page leads into it without repeating it, not by whether the page resolves on its own."
                  : "Approve only if this is a finished, specific page that can appear in the final book without visible generation artifacts, repeated beats, or stalled progression."
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
  const pageInstruction = buildPageInstruction(options);
  const citation = citationContractFields(
    options.retrievedResearch ?? options.researchNotes ?? options.plan.researchNotes
  );
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "revise-page",
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
          ...citation.rules,
          "Do not mention the critique, AI, prompts, JSON, schemas, generation, or production instructions.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          "If the current pageBrief requires a recurring action type from previousPages, keep the required action but change the physical details, sentence rhythm, and consequence.",
          "Do not reuse distinctive phrases from previousPages; replace them with fresh concrete wording.",
          "Vary how pages open: do not begin the replacement with the same opening move, image, or sentence shape the previousPages excerpts begin with.",
          "Use pageScope to keep the replacement inside the current global page and chapter-local position.",
          ...(options.nextPages && options.nextPages.length > 0
            ? [
                "followingPages is prose that already exists after this page and is not being rewritten. The replacement must end so the first of them reads on naturally, and must not repeat a beat or line that already appears there."
              ]
            : []),
          "The current pageBrief is authoritative for its historical assignment; source-identity requirements are governed only by researchNotes and the citation rule. Do not import futureChapterPageBriefs or later chapter keyBeats unless they are explicitly assigned to this page.",
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
            chapterBrief: chapterBriefPayloadForPageScope(options.chapterBrief),
            pageBrief: options.pageBrief
              ? sanitizePageBriefForCitationContract(
                  options.pageBrief,
                  options.retrievedResearch ?? options.researchNotes ?? options.plan.researchNotes
                )
              : options.pageBrief,
            ...pageInstruction.payload,
            ...citation.payload,
            pageScope: pageScopePayload(options),
            pageIndex: options.pageIndex,
            characters: options.plan.characters,
            illustrationPlan: options.plan.illustrationPlan,
            rejectedDraft: options.draft,
            qualityReport: options.report,
            previousPages: compactPriorPages(options.previousPages, 4, 700),
            ...(options.nextPages && options.nextPages.length > 0
              ? { followingPages: compactFollowingPages(options.nextPages, 2, 700) }
              : {}),
            ...(options.styleExcerpts && options.styleExcerpts.length > 0
              ? { styleExcerpts: options.styleExcerpts }
              : {}),
            instruction: pageInstruction.text
          },
          null,
          2
        )
      }
    ]
  });

  return pageDraftSchema.parse(result.data);
}

/**
 * Per-page ceiling on the opening prose final QA is judged on.
 *
 * This reviewer is told openingPages is how the book opens and rejects the
 * whole book on it, so a page cut mid-sentence reads as an unfinished opening
 * and fails a manuscript with nothing wrong with it — and an issue phrased
 * "the opening stops mid-sentence" names no page number, which is the shape the
 * repair pass has the hardest time targeting. The widest fuse any page writer
 * runs under is polishPageDraft's 3,400 tokens, so ~13,600 characters at the
 * loosest tokenization: a page that fits its own output budget fits here whole.
 * Only page 1 is ever sent, so the ceiling costs less than the pageMap already
 * in this prompt. What still overruns is cut with the pageMap's own ellipsis
 * marker, and both prompts say that marker is a shortening rather than a
 * defect.
 */
const FINAL_QA_OPENING_PAGE_CHARS = 14_000;

/**
 * The opening this reviewer judges is page 1, and nothing else.
 *
 * It used to be handed pages 1 and 2, and page 1 is the only page an opening
 * verdict can be repaired on: an issue like "the second page repeats the first
 * page's opening image" carries no digit, so `extractRepairPageIndexesFromText`
 * (`apps/worker/src/generation/bookHelpers.ts`) finds no page number and the
 * opening heuristic beside it adds index 1. Page 2 was never redrafted, so if
 * page 1 was fine the repair changed nothing, the second `runFinalBookQa`
 * rejected the book on the same complaint, and it exported permanently flagged
 * with no path back — a rejection the pipeline cannot act on.
 *
 * The alternative was to keep both pages and instruct the reviewer to attribute
 * every opening issue to a page number so the digit match places it. That is a
 * wider first impression bought with the model's compliance: "the second page"
 * is the phrasing this failed on, and it maps to page 1 whatever the prompt
 * asks for. Narrowing the payload is the deterministic half, and it costs
 * little — page 2 is still in this prompt as a `pageMap` row, which carries its
 * own index, so a complaint drawn from it names a page the repair can find.
 */
function finalQaOpeningPages(pages: FinalQaPage[]) {
  return pages
    .filter((page) => page.index === 1)
    .map((page) => ({
      index: page.index,
      title: page.title,
      markdown: compactSummaryForQa(page.markdown, FINAL_QA_OPENING_PAGE_CHARS)
    }));
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

  /*
   * The imported-manuscript exemption, carried the rest of the way — and asked
   * of the same contract every page prompt asks (`openingContractForRange`,
   * pagesShared.ts). This reviewer is handed the whole book, so the range test
   * is settled and `statesOpeningQuality` is exactly the exemption.
   *
   * The deterministic gate skips page 1's opening check for an import — which
   * means it returns no issues, the early return above does not fire, and this
   * model call runs. Stating the opening rule here therefore made the exemption
   * *worse* than having none: before it, the local rejection was where the path
   * stopped; after it, the reviewer was asked to reject the author's own first
   * sentence, the verdict came back naming no page, `extractRepairPageIndexes`
   * (`apps/worker/src/generation/bookHelpers.ts`) files a pageless opening
   * complaint against page 1, and the repair pass model-rewrote that line.
   *
   * The rule and the page it is judged from go together. Keeping the payload
   * while dropping the sentence would leave an unlabelled excerpt of the
   * author's prose beside the pageMap for the model to draw its own conclusion
   * from, which is the same mistake in a quieter form. A book whose page set
   * carries no index 1 leaves both out anyway, which is why the flag is read
   * off the pages this call actually kept.
   */
  const openingPages = openingContractForRange(options, 1, options.input.targetPages).statesOpeningQuality
    ? finalQaOpeningPages(options.pages)
    : [];
  const judgesOpening = openingPages.length > 0;
  const citation = citationContractFields(options.researchNotes ?? options.plan.researchNotes);

  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "final-book-qa",
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
          ...citation.rules,
          "pageMap summaries are abbreviated excerpts for this review, not the exported manuscript.",
          ...(judgesOpening
            ? [
                "Do not reject because a pageMap summary or an openingPages excerpt ends with an ellipsis or looks cut off.",
                `openingPages carries the book's first page as written: reject the book when the opening is meta, ${OPENING_QUALITY_RULE_MARKER}, or generic, or fails to commit to the book's subject.`,
                "An opening verdict is about that first page; give any other page's issue the page number pageMap records for it."
              ]
            : [
                "Do not reject because a pageMap summary ends with an ellipsis or looks cut off.",
                "Give every issue the page number pageMap records for it."
              ]),
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
            ...(judgesOpening ? { openingPages } : {}),
            ...citation.payload,
            instruction: judgesOpening
              ? "Approve only if the compiled Markdown can be shown to a reader as the book output without obvious generation artifacts. pageMap summaries and openingPages excerpts may end with … because they are shortened for this check; that is not a book defect. Identical titles on adjacent pages are fine when the summaries describe different beats. openingPages is the book's first page as written and the only page an opening verdict is about; judge the reader's first impression from it, and give any other page's issue the page number pageMap records for it."
              : "Approve only if the compiled Markdown can be shown to a reader as the book output without obvious generation artifacts. pageMap summaries may end with … because they are shortened for this check; that is not a book defect. Identical titles on adjacent pages are fine when the summaries describe different beats. Give every issue the page number pageMap records for it."
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

function normalizeIssueList(issues: string[], fallback: string): string[] {
  return issues.length > 0 ? issues : [fallback];
}
