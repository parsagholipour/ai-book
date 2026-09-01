import type { TextModelAdapter } from "../adapters/types.js";
import type { PageReviewPromptMode } from "./qualityGates.js";
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
  reviewRequiredPageQualityChecks,
  runLocalPageQualityChecks
} from "./pagesLocalQa.js";
import { runLocalFinalQa, runRequiredFinalQa } from "./pagesFinalLocalQa.js";
import { isSourceIdentityOnlyIssue } from "./citationRepairPolicy.js";
import { hasSmartUnslopCandidates } from "./smartUnslop.js";
import { pageQaProviderCallMetadata, withPageQaTriggerReasons } from "./pageQaRewriteTelemetry.js";
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
import { evidenceLedgerRules } from "./evidenceLedger.js";
import { localStyleInstructions, pagePromptBookStyle } from "./styleContract.js";

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
  /** Keep the model review but bypass configurable local checks; required invariants remain. */
  skipLocalChecks?: boolean | undefined;
  /** Operator-selected context size for the model page reviewer. Defaults to the legacy full prompt. */
  pageReviewPromptMode?: PageReviewPromptMode | undefined;
};

export type RevisePageOptions = ReviewPageOptions & {
  report: PageQualityReport;
  /** Candidate produced by this rewrite; the original draft is candidate 1. */
  qaCandidateNumber?: number | undefined;
  /** The recovery planner repaired the assignment before this rewrite. */
  qaBriefRepaired?: boolean | undefined;
  /** Approved edit instruction; authoritative over a stale page brief. */
  editInstruction?: string | undefined;
  /** Prompt-only character canon; never an additional edit requirement. */
  characterContext?: string | undefined;
  /** Supplemental guidance for this page; it may refine but never replace editInstruction. */
  pageEditGuidance?: string | undefined;
  /** Concrete omissions from the preceding adherence verdict. */
  adherenceRepair?: string[] | undefined;
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
  /** Keep the model review but bypass configurable local whole-book checks; required invariants remain. */
  skipLocalChecks?: boolean | undefined;
};

export async function reviewPageDraft(options: ReviewPageOptions): Promise<PageQualityReport> {
  const localReport = options.skipLocalChecks
    ? reviewRequiredPageQualityChecks(options)
    : runLocalPageQualityChecks(options);
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
  const citationReviewRules = reviewerCitationRules(citation.payload.researchNotes.length > 0);
  const compactPrompt = options.pageReviewPromptMode === "compact";
  const reviewPageScope = compactPrompt
    ? compactPageReviewScope(options)
    : pageScopePayload(options);

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
            ...citationReviewRules,
            "Treat semantic repetition as a failure even when wording differs: the same encounter, same decision, same exposition, or same emotional turn cannot appear twice.",
            "Do not reject merely because the same character performs a necessary recurring action type assigned by the current pageBrief; reject it only when it restages the same beat, reuses distinctive wording, or fails to add a new consequence.",
            "For a final page, reject vague closure unless it resolves the core promise with a concrete consequence or completed choice.",
            ...opening.rules,
            "Use pageScope to distinguish global page position from chapter-local position.",
            ...(citation.payload.researchNotes.length === 0
              ? [
                  "researchNotes is empty, so pageBrief in the user payload is the sanitized brief: omitting a diary, dispatch, archive, named testimony, or other source identity is not a reason to reject, even if an unsanitized stored brief asked for one. Evaluate only the sanitized current pageBrief. Still reject independently identifiable factual errors, unsupported claims, repetition, and continuity or structure defects."
                ]
              : ["Evaluate only the current pageBrief."]),
            "Do not reject a page for omitting chapter keyBeats or futureChapterPageBriefs assigned to later pages.",
            "Compare the draft with futureChapterPageBriefs and reject it if it substantially performs, resolves, or restages a beat reserved for a later page. The current endingPressure only authorizes a short concluding handoff that opens the next problem; it does not authorize developing that problem earlier in the page. Multiple paragraphs developing a future page's purpose, or a conclusion delivering that future page's endingPressure, consume the reserved beat and must be rejected even if the prose calls this a setup.",
            "If pageScope.isLastPageOfChapter is false, do not require chapter closure or all chapter keyBeats on this page.",
            ...evidenceLedgerRules(options.input, options.plan, "reviewer"),
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
                antiAiRules: localStyleInstructions(options.plan),
                styleGuidance: styleGuidancePayload(options.input)
              },
              chapter: compactPrompt ? compactReviewChapter(options.chapter) : options.chapter,
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
              pageScope: reviewPageScope,
              pageIndex: options.pageIndex,
              draft: options.draft,
              previousPages: compactPriorPages(
                options.previousPages,
                compactPrompt ? 1 : 5,
                compactPrompt ? 450 : 800
              ),
              ...(options.nextPages && options.nextPages.length > 0
                ? {
                    followingPages: compactFollowingPages(
                      options.nextPages,
                      compactPrompt ? 1 : 2,
                      compactPrompt ? 450 : 800
                    )
                  }
                : {}),
              ...(options.styleExcerpts && options.styleExcerpts.length > 0
                ? {
                    styleExcerpts: compactPrompt
                      ? options.styleExcerpts.slice(0, 1).map((excerpt) => excerpt.slice(0, 600))
                      : options.styleExcerpts
                  }
                : {}),
              continuityNotes: continuityNotesForPrompt(
                options.continuityNotes,
                compactPrompt ? 6 : CONTINUITY_NOTE_PROMPT_LIMITS.review
              ),
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
  const guardrailDefects = reviewerGuardrailDefects(options);
  const guardedReport = {
    ...modelReport,
    approved: modelReport.approved && guardrailDefects.length === 0,
    issues: [...guardrailDefects.map((defect) => defect.issue), ...modelReport.issues],
    requiredRevisions: [
      ...guardrailDefects.map((defect) => defect.requiredRevision),
      ...modelReport.requiredRevisions
    ]
  };
  const filteredReport = filterIgnoredReviewerComplaints(guardedReport);
  const remainingFeedback = [...filteredReport.issues, ...filteredReport.requiredRevisions];
  const notesEndorseApproval =
    /\b(?:approved|effectively|fulfills?|grounded|no (?:fabrication|progression issues?|repetition)|prose is (?:natural|specific)|avoids? (?:fabrication|invent\w*))\b/i.test(guardedReport.notes);
  const explicitlyNonBlockingReport =
    guardrailDefects.length === 0 &&
    guardedReport.score >= 75 &&
    filteredReport.issues.length > 0 &&
    !remainingFeedback.some(isExplicitlyBlockingFeedback) &&
    (remainingFeedback.every(isExplicitlyNonBlockingFeedback) || notesEndorseApproval);
  const approved =
    filteredReport.onlyIgnoredRejection ||
    explicitlyNonBlockingReport ||
    (!filteredReport.hasRemainingDefectAfterStripping && guardedReport.approved && guardedReport.score >= 75);
  const reviewedReport = {
    ...guardedReport,
    approved,
    issues: approved && (filteredReport.onlyIgnoredRejection || explicitlyNonBlockingReport)
      ? []
      : approved
      ? filteredReport.issues
      : normalizeIssueList(filteredReport.issues, "Reviewer rejected the page."),
    requiredRevisions:
      approved && (filteredReport.onlyIgnoredRejection || explicitlyNonBlockingReport)
        ? []
        : approved || filteredReport.requiredRevisions.length > 0
        ? filteredReport.requiredRevisions
        : ["Revise the page until it is specific, progressive, and free of generation artifacts."],
    checks: {
      ...localReport.checks,
      ...modelReport.checks
    }
  };
  if (reviewedReport.approved) {
    return reviewedReport;
  }
  return withPageQaTriggerReasons(reviewedReport, [
    ...(!modelReport.approved || modelReport.score < 75 || guardrailDefects.length === 0
      ? (["model_review"] as const)
      : []),
    ...(guardrailDefects.length > 0 ? (["reserved_beat"] as const) : [])
  ]);
}

function compactReviewChapter(chapter: ChapterPlan | undefined) {
  if (!chapter) return undefined;
  return {
    index: chapter.index,
    title: chapter.title,
    summary: chapter.summary,
    targetPages: chapter.targetPages
  };
}

/**
 * Keep positional scope intact while turning the duplicated chapter-page maps
 * into short continuity/reservation signatures. The authoritative pageBrief
 * remains a separate, complete payload field.
 */
function compactPageReviewScope(options: ReviewPageOptions) {
  const scope = pageScopePayload(options);
  return {
    ...scope,
    previousChapterPageBriefs: scope.previousChapterPageBriefs.map((page) => ({
      pageIndex: page.pageIndex,
      completedBeat: compactReviewBeat(page.purpose, page.beat, page.endingPressure, page.claim),
      ...(page.evidenceAnchors ? { evidenceAnchors: page.evidenceAnchors } : {})
    })),
    futureChapterPageBriefs: scope.futureChapterPageBriefs.map((page) => ({
      pageIndex: page.pageIndex,
      reservedBeat: compactReviewBeat(page.purpose, page.beat, page.endingPressure, page.claim),
      ...(page.evidenceAnchors ? { evidenceAnchors: page.evidenceAnchors } : {})
    }))
  };
}

function compactReviewBeat(...parts: Array<string | undefined>): string {
  const signature = parts.filter((part): part is string => Boolean(part?.trim())).join(" — ");
  return signature.length <= 280 ? signature : `${signature.slice(0, 279)}…`;
}

const EXPLICITLY_NON_BLOCKING_FEEDBACK =
  /\b(?:acceptable|adequate|adequately|addressed|anchored|appropriate(?:ly)?|approved with minor suggestions|avoids?|but|consider|correct per instructions|could (?:be|benefit)|fulfill\w*|generally|grounded|if (?:available|documented|possible)|minor|no required revisions|not disqualifying|not required|slight(?:ly)?|somewhat|though|which it is)\b/i;
const EXPLICITLY_BLOCKING_FEEDBACK =
  /\b(?:continuity|contradict\w*|does not (?:explicitly return|fulfill)|factual|fails? to fulfill|inaccura\w*|incorrect|mislead\w*|overextend\w*|overpack\w*|repetit\w*|reserved beat|restag\w*|unsupported|wrong)\b/i;
const NEGATED_BLOCKING_FEEDBACK =
  /\b(?:avoids?|do(?:es)? not(?: (?:constitute|imply|introduce|present))?|no|not (?:presented|treated) as|without)\s+(?:any impression of )?(?:(?:an?|the) )?(?:new |specific )?(?:contradict\w*|factual (?:claims?|errors?)|repetit\w*|restag\w*|unsupported claims?)\b/gi;
const QUALIFIED_REPETITION_FEEDBACK =
  /\b(?:necessary .{0,100}does not stall|not (?:a )?semantic repetition|required ending pressure|which is the ending pressure)\b/i;

function isExplicitlyNonBlockingFeedback(feedback: string): boolean {
  return !isExplicitlyBlockingFeedback(feedback) && EXPLICITLY_NON_BLOCKING_FEEDBACK.test(feedback);
}

function isExplicitlyBlockingFeedback(feedback: string): boolean {
  let normalized = feedback.replace(NEGATED_BLOCKING_FEEDBACK, "");
  if (QUALIFIED_REPETITION_FEEDBACK.test(normalized)) {
    normalized = normalized.replace(/\b(?:repeats?|repetit\w*)\b/gi, "");
  }
  return EXPLICITLY_BLOCKING_FEEDBACK.test(normalized);
}

type ReviewerGuardrailDefect = {
  issue: string;
  requiredRevision: string;
};

const RESERVED_BEAT_STOP_WORDS = new Set([
  "about", "after", "again", "against", "along", "also", "among", "because", "before", "between",
  "chapter", "close", "closes", "closing", "conclude", "concludes", "concluding", "could", "current",
  "demonstrate", "final", "finish", "finishes", "finishing", "from", "have", "into", "itself", "later",
  "page", "purpose", "should", "show", "shows", "showing", "single", "that", "their", "them", "then",
  "there", "these", "they", "this", "those", "through", "toward", "under", "what", "when", "where",
  "which", "while", "with", "without", "would"
]);

function reviewerGuardrailDefects(options: ReviewPageOptions): ReviewerGuardrailDefect[] {
  const defects: ReviewerGuardrailDefect[] = [];
  const reservedBeat = reservedClosingBeatDefect(options);
  if (reservedBeat) {
    defects.push(reservedBeat);
  }
  return defects;
}

function reservedClosingBeatDefect(options: ReviewPageOptions): ReviewerGuardrailDefect | undefined {
  const nextPage = options.chapterBrief?.pages
    .filter((page) => page.pageIndex > options.pageIndex)
    .sort((left, right) => left.pageIndex - right.pageIndex)[0];
  if (!nextPage || !/\b(?:clos\w*|conclud\w*|synthesi[sz]\w*)\b/i.test(`${nextPage.purpose} ${nextPage.beat}`)) {
    return undefined;
  }

  const futureTerms = significantReviewTerms(`${nextPage.purpose} ${nextPage.beat}`);
  const currentTerms = significantReviewTerms([
    options.pageBrief?.purpose ?? "",
    options.pageBrief?.beat ?? "",
    ...(options.pageBrief?.requiredContinuity ?? [])
  ].join(" "));
  const distinctiveFutureTerms = [...futureTerms].filter((term) => !currentTerms.has(term));
  const paragraphs = options.draft.markdown.split(/\n\s*\n/).filter((paragraph) => paragraph.trim());
  if (paragraphs.length < 2) {
    return undefined;
  }

  const paragraphMatches = paragraphs.map((paragraph) => {
    const terms = significantReviewTerms(paragraph);
    return distinctiveFutureTerms.filter((term) => terms.has(term));
  });
  const allMatches = new Set(paragraphMatches.flat());
  const preConclusionMatches = new Set(paragraphMatches.slice(0, -1).flat());
  if (allMatches.size < 3 || preConclusionMatches.size < 2) {
    return undefined;
  }

  const concepts = [...allMatches].slice(0, 4).join(", ");
  return {
    issue: `The draft substantially restages the reserved closing beat for page ${nextPage.pageIndex}: it develops future-page concepts (${concepts}) before the concluding handoff and returns to them in the ending.`,
    requiredRevision: `Keep page ${options.pageIndex} on its assigned beat and reserve the closing synthesis for page ${nextPage.pageIndex}; use only a short final handoff to that later problem.`
  };
}

function significantReviewTerms(raw: string): Set<string> {
  return new Set(
    (raw.match(/[A-Za-z]{5,}/g) ?? [])
      .map(normalizeReviewTerm)
      .filter((term) => term.length >= 5 && !RESERVED_BEAT_STOP_WORDS.has(term))
  );
}

function normalizeReviewTerm(raw: string): string {
  let term = raw.toLowerCase();
  if (term.endsWith("ies") && term.length > 5) {
    term = `${term.slice(0, -3)}y`;
  } else if (term.endsWith("ing") && term.length > 6) {
    term = term.slice(0, -3);
  } else if (term.endsWith("ed") && term.length > 5) {
    term = term.slice(0, -2);
  } else if (term.endsWith("s") && term.length > 5) {
    term = term.slice(0, -1);
  }
  if (term.startsWith("settl")) return "settle";
  if (term.startsWith("memor")) return "memory";
  return term;
}

const FABRICATION_ONLY_CONCERN =
  /\b(?:composite|fabricat\w*|fake|fictional(?:i[sz]\w*)?|hallucinat\w*|imaginary|invent\w*|made[- ]?up|nonexistent|not real|reconstruct\w*|unsupported (?:individual|person|record|scene|source|testimony|witness))\b/i;
const INDEPENDENT_REVIEW_DEFECT =
  /\b(?:anachron\w*|chronolog\w*|continuity|contradict\w*|factual|filler|generic scaffold|inaccura\w*|incorrect|mislead\w*|overextend\w*|overpack\w*|placeholder|progression|prompt leak|repetit\w*|reserved beat|restag\w*|stalls?|unsupported (?:assertion|claim|conclusion|detail|finding|number|statistic|statement)|wrong)\b/i;
const REVIEW_SOURCE_CONTEXT_REFERENCE =
  /\b(?:archive|citation|diar(?:y|ies)|dispatch(?:es)?|document|evidence|journal(?:ist)?|publication|record|researchNotes|source|testimon(?:y|ies)|witness)\b/i;
const REVIEW_SOURCE_CONTEXT_ABSENCE =
  /\b(?:absent|anonymous|drop|identity|missing|no identity|not (?:identified|included|listed|named|present|provided)|remove|researchNotes|unnamed|without (?:identity|identification|naming|source))\b/i;

function isFabricationOnlyComplaint(feedback: string): boolean {
  return FABRICATION_ONLY_CONCERN.test(feedback) && !INDEPENDENT_REVIEW_DEFECT.test(feedback);
}

function isReviewerSourceContextOnlyComplaint(feedback: string): boolean {
  return REVIEW_SOURCE_CONTEXT_REFERENCE.test(feedback) &&
    REVIEW_SOURCE_CONTEXT_ABSENCE.test(feedback) &&
    !INDEPENDENT_REVIEW_DEFECT.test(feedback);
}

function reviewerCitationRules(hasResearchNotes: boolean): string[] {
  const gate = hasResearchNotes
    ? "Use only sources present in researchNotes when checking source details, but treat researchNotes as context rather than an exhaustive inventory of everything established in the book."
    : "researchNotes is empty: use the draft, previousPages, and qualified public facts as the available context; do not require a diary, dispatch, archive, citation, named testimony, or other source identity.";
  return [
    gate,
    "For this review, never reject a person, event, scene, quotation, record, publication, institution, or other detail merely because it may be fake, invented, fabricated, fictional, reconstructed, or absent from researchNotes. An earlier page outside the supplied context may have established it. Reject only an independently identifiable defect such as a factual or chronological error, an unsupported claim, repetition, contradiction, prompt leakage, stalled progression, or a reserved-beat restage."
  ];
}

function filterIgnoredReviewerComplaints(report: PageQualityReport): {
  issues: string[];
  requiredRevisions: string[];
  onlyIgnoredRejection: boolean;
  hasRemainingDefectAfterStripping: boolean;
} {
  const isIgnored = (feedback: string): boolean =>
    isFabricationOnlyComplaint(feedback) ||
    isReviewerSourceContextOnlyComplaint(feedback) ||
    isSourceIdentityOnlyIssue(feedback);
  const issues = report.issues.filter((issue) => !isIgnored(issue));
  const requiredRevisions = report.requiredRevisions.filter((revision) => !isIgnored(revision));
  const strippedComplaint =
    issues.length < report.issues.length ||
    requiredRevisions.length < report.requiredRevisions.length ||
    (!report.approved && report.issues.length === 0 && report.requiredRevisions.length === 0 &&
      isFabricationOnlyComplaint(report.notes));
  const onlyIgnoredRejection =
    strippedComplaint && issues.length === 0 && requiredRevisions.length === 0;

  return {
    issues,
    requiredRevisions,
    onlyIgnoredRejection,
    hasRemainingDefectAfterStripping:
      strippedComplaint && (issues.length > 0 || requiredRevisions.length > 0)
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
  const pageInstruction = buildPageInstruction(options, "rewrite");
  const conditionalUnslop = hasSmartUnslopCandidates(options.report);
  const citation = citationContractFields(
    options.retrievedResearch ?? options.researchNotes ?? options.plan.researchNotes
  );
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "revise-page",
    ...(options.qaCandidateNumber !== undefined
      ? {
          providerCallMetadata: pageQaProviderCallMetadata({
            report: options.report,
            candidateNumber: options.qaCandidateNumber,
            ...(options.qaBriefRepaired ? { additionalReasons: ["brief_repair"] } : {})
          })
        }
      : {}),
    temperature: Math.min(0.85, options.input.temperature),
    maxTokens: 3200,
    schema: pageDraftSchema,
    messages: [
      {
        role: "system",
        content: [
          "Revise one book page so it passes editorial QA.",
          ...(options.editInstruction
            ? [
                "editInstruction is the approved reader request and is authoritative. Apply it explicitly. pageBrief governs structure and continuity, but never whether the requested change is performed. Do not soften, substitute, or silently omit it."
              ]
            : []),
          ...(options.pageEditGuidance
            ? [
                "pageEditGuidance is supplemental guidance for this page. Follow it while still satisfying the complete authoritative editInstruction."
              ]
            : []),
          ...(options.characterContext
            ? ["characterContext is supplemental canon for character identity, traits, and appearance. Use it when revising, but do not treat it as an additional requested edit."]
            : []),
          ...(conditionalUnslop
            ? [
                "Smart unslop findings in qualityReport are deterministic scanner candidates, not confirmed defects and not authorization to edit.",
                "Judge every candidate in the full page context. Protect literal, domain-valid, quoted, attributed, accurately caveated, and genre-natural uses.",
                "If none of the Smart unslop candidates is a clear contextual defect, leave those spans unchanged. If qualityReport names no separate confirmed defect either, copy rejectedDraft to the output exactly: preserve title, markdown, summary, continuityNotes, and imagePrompt byte-for-byte, and make no other improvement.",
                "For a confirmed candidate or a separate confirmed defect, make the smallest repair only in its sentence. Copy every other sentence byte-for-byte and preserve facts, quantities, dates, names, quotations, citations, code, units, scope, uncertainty, attribution, register, and meaning. Add no claim or conclusion."
              ]
            : []),
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
            ...(options.editInstruction ? { editInstruction: options.editInstruction } : {}),
            ...(options.characterContext ? { characterContext: options.characterContext } : {}),
            ...(options.pageEditGuidance ? { pageEditGuidance: options.pageEditGuidance } : {}),
            ...(options.adherenceRepair?.length ? { adherenceRepair: options.adherenceRepair } : {}),
            book: {
              title: options.plan.title,
              premise: options.plan.premise,
              audience: options.plan.audience,
              category: options.input.category,
              subcategory: options.input.subcategory,
              ...pagePromptBookStyle(options.plan),
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
  const localIssues = options.skipLocalChecks
    ? runRequiredFinalQa(options.input, options.pages)
    : runLocalFinalQa(options.input, options.pages);
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
   * pagesShared.ts). This reviewer is handed actual opening prose (when it
   * judges opening) and a compact pageMap of summaries, not the compiled book,
   * so the range test is settled and `statesOpeningQuality` is exactly the exemption.
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
          "Reject the book if the supplied payload shows placeholders, prompt leakage, broken continuity, or no progression.",
          "Reject the book if factual or research-grounded passages contain invented studies, journals, institutes, statistics, experts, citations, or claims described as fictional/fabricated/invented.",
          ...citation.rules,
          "pageMap is abbreviated planning and progression context, not the book and not complete manuscript prose.",
          "Do not decide full-book repeated-page quality from pageMap summaries; those rows are not the compiled manuscript.",
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
              ? "Approve only if the supplied payload — abbreviated pageMap planning context and actual openingPages prose — can be shown without obvious generation artifacts. This call did not receive the complete compiled Markdown. pageMap summaries and openingPages excerpts may end with … because they are shortened for this check; that is not a book defect. Identical titles on adjacent pages are fine when the summaries describe different beats. openingPages is the book's first page as written and the only page an opening verdict is about; judge the reader's first impression from it, and give any other page's issue the page number pageMap records for it."
              : "Approve only if the supplied payload — abbreviated pageMap planning context — can be shown without obvious generation artifacts. This call did not receive the complete compiled Markdown. pageMap summaries may end with … because they are shortened for this check; that is not a book defect. Identical titles on adjacent pages are fine when the summaries describe different beats. Give every issue the page number pageMap records for it."
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
