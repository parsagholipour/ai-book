import { writerArtworkContext } from "./writerArtworkContext.js";
import { reviseSentenceLength, sentenceLengthRepairFor, type SentenceLengthRepair } from "./pageSentenceRepair.js";
import { buildPageReviewPrompt } from "./pageReviewPrompt.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import type { PageReviewPromptMode } from "./qualityGates.js";
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
import { codeBlockRules } from "./codeBlockRules.js";
import { figureFreeDraft, figureFreeProse, figureStandInMarkdown } from "./figures/figureBlocks.js";
import { finalizePageDraft } from "./figures/figureDraftSummary.js";
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
  openingContractForRange,
  pageScopePayload,
  reviewerStyleRules,
  styleGuidancePayload,
  writerToneRules,
  PRIOR_PAGE_ENDING_RULE,
  type PriorPageContext
} from "./pagesShared.js";
import { pagePromptBookStyle } from "./styleContract.js";

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
  userRequest?: string | undefined;
  /** Concrete manuscript repair goals that must survive review against older page briefs. */
  repairInstruction?: string | undefined;
  /** Original reader prose, fixed across repair attempts so planning aliases cannot become canon. */
  repairOriginalMarkdown?: string | undefined;
  sentenceRepair?: SentenceLengthRepair | undefined;
  signal?: AbortSignal | undefined;
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
  /**
   * The page was drafted for this edit — a continuation's or an inserted page —
   * so `editInstruction` is its brief and the draft is not finished prose the
   * reader approved. Such a page is repaired like any generated page. Told it
   * was "a reader-requested edit of finished prose" and to keep every unnamed
   * sentence byte for byte, a continuation's repair kept a page opening that
   * re-narrated the page before it (2026-10-02).
   */
  draftedForEdit?: boolean | undefined;
  /** Prompt-only character canon; never an additional edit requirement. */
  characterContext?: string | undefined;
  /** Supplemental guidance for this page; it may refine but never replace editInstruction. */
  pageEditGuidance?: string | undefined;
  /** Concrete omissions from the preceding adherence verdict. */
  adherenceRepair?: string[] | undefined;
  /**
   * `keep`: chat rewrite whose request names the figure; draft may carry a fence.
   * `hold`: holdFiguresAside path; strip invented fences, keep `[Figure: …]`
   * stand-ins so later revises/reviews still see the stand-in.
   * Absent: `figureFreeDraft` (fences and stand-ins gone) — generate-like
   * revises and pages with no figure.
   */
  figures?: "keep" | "hold";
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
  options.signal?.throwIfAborted();
  const localReport = options.skipLocalChecks
    ? reviewRequiredPageQualityChecks(options)
    : runLocalPageQualityChecks(options);
  if (!localReport.approved) {
    return localReport;
  }

  return diagnosePageReview(options, localReport, buildPageReviewPrompt(options), options.textModel);
}

async function diagnosePageReview(options: ReviewPageOptions, localReport: PageQualityReport, prompt: GenerateJsonOptions<PageQualityReport>, textModel: TextModelAdapter): Promise<PageQualityReport> {
  let result: { data: PageQualityReport };
  try {
    options.signal?.throwIfAborted();
    result = await generateJsonWithRetry(textModel, prompt);
    options.signal?.throwIfAborted();
  } catch (error) {
    options.signal?.throwIfAborted();
    if ((options.sentenceRepair && !options.userRequest) || !shouldUseLocalReviewFallback(error)) {
      throw error;
    }
    return {
      ...localReport,
      notes: `${localReport.notes} Model reviewer returned malformed JSON, so local checks were used.`
    };
  }

  // The model's verdict is the verdict. A deterministic guardrail used to sit
  // here and veto an approval when the draft shared a few five-letter words
  // with the next page's brief; measured over 1,200 shipped pages it fired on
  // 76 the reviewer had approved at 88-94, so it was removed (2026-09-02).
  const modelReport = pageQualityReportSchema.parse(result.data);
  // A syntax repair needs affirmative semantic verification. Generic feedback
  // normalization must not turn an explicit preservation failure into approval.
  if (options.sentenceRepair && !options.userRequest) {
    const approved = modelReport.approved && modelReport.score >= 75 && modelReport.groundedOk &&
      modelReport.unsupportedClaims.length === 0 && Object.values(modelReport.checks).every(Boolean);
    const report = { ...modelReport, approved, scoreBasis: "reviewer" as const };
    return approved ? report : withPageQaTriggerReasons(report, ["model_review"]);
  }
  const filteredReport = filterIgnoredReviewerComplaints(modelReport);
  const remainingFeedback = [...filteredReport.issues, ...filteredReport.requiredRevisions];
  const notesEndorseApproval =
    /\b(?:approved|effectively|fulfills?|grounded|no (?:fabrication|progression issues?|repetition)|prose is (?:natural|specific)|avoids? (?:fabrication|invent\w*))\b/i.test(modelReport.notes);
  const explicitlyNonBlockingReport =
    modelReport.score >= 75 &&
    filteredReport.issues.length > 0 &&
    !remainingFeedback.some(isExplicitlyBlockingFeedback) &&
    (remainingFeedback.every(isExplicitlyNonBlockingFeedback) || notesEndorseApproval);
  // A contextual leak verdict must survive permissive feedback normalization.
  const approved = modelReport.checks.promptLeakFree && (
    filteredReport.onlyIgnoredRejection ||
    explicitlyNonBlockingReport ||
    (!filteredReport.hasRemainingDefectAfterStripping && modelReport.approved && modelReport.score >= 75));
  const reviewedReport = {
    ...modelReport,
    scoreBasis: "reviewer" as const,
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
  return withPageQaTriggerReasons(reviewedReport, ["model_review"]);
}


const EXPLICITLY_NON_BLOCKING_FEEDBACK =
  /\b(?:acceptable|adequate|adequately|addressed|anchored|appropriate(?:ly)?|approved with minor suggestions|avoids?|but|consider|correct per instructions|could (?:be|benefit)|fulfill\w*|generally|grounded|if (?:available|documented|possible)|minor|no required revisions|not disqualifying|not required|slight(?:ly)?|somewhat|though|which it is)\b/i;
const EXPLICITLY_BLOCKING_FEEDBACK =
  /\b(?:continuity|contradict\w*|does not (?:explicitly return|fulfill)|factual|fails? to fulfill|inaccura\w*|incorrect|mislead\w*|overextend\w*|overpack\w*|repetit\w*|reserved beat|restag\w*|unsupported|wrong)\b/i;
const NEGATED_BLOCKING_FEEDBACK =
  /\b(?:avoids?|do(?:es)? not(?: (?:constitute|imply|introduce|present))?|no|not (?:presented|treated) as|without)\s+(?:any impression of )?(?:(?:an?|the) )?(?:new |specific )?(?:contradict\w*|factual (?:claims?|errors?)|repetit\w*|restag\w*|unsupported claims?)\b/gi;
const QUALIFIED_REPETITION_FEEDBACK =
  /\b(?:necessary .{0,100}does not stall|not (?:a )?semantic repetition|required ending pressure|which is the ending pressure)\b/i;

// These are editorial findings about narration, not claims that a source is
// fabricated. The actual reviewer may report them as styleNatural=false while
// leaving promptLeakFree=true, so neither flag alone can preserve the feedback.
const NARRATION_FRAMING_DEFECT = /\b(?:intrusive disclaimer|authorial disclaimer|fiction(?:al)?[- ]status disclaimer|immersion[- ]breaking|meta[- ](?:framing|commentary|opening)|reads (?:like|as) (?:an? )?(?:disclaimer|production note))\b/i;

function isExplicitlyNonBlockingFeedback(feedback: string): boolean {
  return !isExplicitlyBlockingFeedback(feedback) && EXPLICITLY_NON_BLOCKING_FEEDBACK.test(feedback);
}

function isExplicitlyBlockingFeedback(feedback: string): boolean {
  if (NARRATION_FRAMING_DEFECT.test(feedback)) return true;
  let normalized = feedback.replace(NEGATED_BLOCKING_FEEDBACK, "");
  if (QUALIFIED_REPETITION_FEEDBACK.test(normalized)) {
    normalized = normalized.replace(/\b(?:repeats?|repetit\w*)\b/gi, "");
  }
  return EXPLICITLY_BLOCKING_FEEDBACK.test(normalized);
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

function filterIgnoredReviewerComplaints(report: PageQualityReport): {
  issues: string[];
  requiredRevisions: string[];
  onlyIgnoredRejection: boolean;
  hasRemainingDefectAfterStripping: boolean;
} {
  // A confirmed narration leak needs its diagnosis and repair, too. Filtering
  // "remove In this invented scene" as a fabrication-only concern discarded
  // the precise instruction that would have fixed the published opening.
  if (!report.checks.promptLeakFree ||
      (!report.approved && [...report.issues, ...report.requiredRevisions].some(feedback => NARRATION_FRAMING_DEFECT.test(feedback)))) {
    return { issues: report.issues, requiredRevisions: report.requiredRevisions,
      onlyIgnoredRejection: false, hasRemainingDefectAfterStripping: false };
  }
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
  const finishedProseEdit = Boolean(options.editInstruction) && !options.draftedForEdit;
  if (options.sentenceRepair && !options.editInstruction) {
    return sentenceLengthRepairFor(options.input, options.draft, options.report)
      ? reviseSentenceLength(options) : options.draft;
  }
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
          "Preserve rejectedDraft.imagePrompt byte-for-byte when the depicted scene, characters, action and setting stay the same. Prose, grammar, pacing or summary edits alone do not change an illustration. When the depicted scene does change, update imagePrompt to match the accepted scene and its exact named characters.",
          ...(finishedProseEdit
            ? [
                // A reader's edit lands in finished, approved prose. The two
                // generic lines below it told the model to move the beat and
                // freshen wording, and a QA repair round after a code
                // conversion rewrote whole pages from scratch on their say-so.
                "This is a reader-requested edit of finished prose: keep every sentence of rejectedDraft that neither editInstruction nor a listed issue requires you to change, byte for byte. Do not freshen wording, examples, openings or transitions that nothing named, and do not add material the instruction did not ask for."
              ]
            : [
                "Change the actual story or explanation beat when needed; do not merely rephrase repeated material.",
                "The replacement must advance beyond the prior pages and satisfy the current page brief."
              ]),
          INTERNAL_PAGE_TITLE_RULE,
          GROUNDED_FACTUALITY_RULE,
          ...citation.rules,
          "Do not mention the critique, AI, prompts, JSON, schemas, generation, or production instructions.",
          ...READER_FACING_PAGE_BRIEF_RULES,
          "If the current pageBrief requires a recurring action type from previousPages, keep the required action but change the physical details, sentence rhythm, and consequence.",
          "Do not reuse distinctive phrases from previousPages; replace them with fresh concrete wording.",
          "Vary how pages open: do not begin the replacement with the same opening move, image, or sentence shape the previousPages excerpts begin with.",
          // A reader's edit of finished prose keeps every opening nothing named.
          ...(finishedProseEdit
            ? []
            : [
                PRIOR_PAGE_ENDING_RULE,
                // Replayed on the page-14 seam (2026-10-02): the reviser keeps what
                // it was handed, so the ending alone still let one repeat in three
                // through on its rejected draft's opening; named, three in four held.
                "A rejectedDraft that opens by re-narrating that ending needs a new opening."
              ]),
          "Use pageScope to keep the replacement inside the current global page and chapter-local position.",
          ...(options.nextPages && options.nextPages.length > 0
            ? [
                "followingPages is prose that already exists after this page and is not being rewritten. The replacement must end so the first of them reads on naturally, and must not repeat a beat or line that already appears there."
              ]
            : []),
          "The current pageBrief is authoritative for its historical assignment; source-identity requirements are governed only by researchNotes and the citation rule. Do not import futureChapterPageBriefs or later chapter keyBeats unless they are explicitly assigned to this page.",
          IMAGE_PROMPT_CHARACTER_RULE,
          ...targetLanguageGenerationGuidance(options.input.language),
          ...writerToneRules(options.input),
          ...codeBlockRules(options.input, options.plan)
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
            ...writerArtworkContext(options.input, options.plan),
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

  const draft = finalizePageDraft(pageDraftSchema.parse(result.data));
  if (options.figures === "keep") return draft;
  if (options.figures === "hold") {
    const markdown = figureFreeProse(draft.markdown);
    return markdown === draft.markdown ? draft : { ...draft, markdown };
  }
  return figureFreeDraft(draft);
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
  // The one place this reviewer is shown page prose; the pageMap rows are
  // summaries. A post-compose call reads a figure block as its stand-in line,
  // so a chart on the first page is "where it sits", never JSON to judge.
  return pages
    .filter((page) => page.index === 1)
    .map((page) => ({
      index: page.index,
      title: page.title,
      markdown: compactSummaryForQa(figureStandInMarkdown(page.markdown), FINAL_QA_OPENING_PAGE_CHARS)
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
          "This is a text review that may run before illustrations are generated. The supplied book.title is export metadata; do not report missing title, cover or illustrations because they do not appear in page prose or summaries.",
          "Character intentions, boasts and mistaken beliefs are not guarantees of literal success. A character learning to cooperate may resolve an earlier boast about working alone. Flag missing character growth only when supported by the supplied actual prose; abbreviated summaries alone cannot prove its absence.",
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
