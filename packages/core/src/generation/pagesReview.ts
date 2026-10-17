import { writerArtworkContext } from "./writerArtworkContext.js";
import { buildPageReviewPrompt } from "./pageReviewPrompt.js";
import type { GenerateJsonOptions, TextModelAdapter } from "../adapters/types.js";
import type { PageReviewPromptMode } from "./qualityGates.js";
import {
  targetLanguageGenerationGuidance,
  targetLanguagePayload
} from "../prompting/language.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import type {
  BookPlan,
  ChapterBrief,
  ChapterPlan,
  CreateProjectInput,
  PageDraft,
  PageProductionBeat,
  PageQualityReport
} from "../schemas/book.js";
import { pageDraftSchema, pageQualityReportSchema } from "../schemas/book.js";
import { codeBlockRules } from "./codeBlockRules.js";
import { figureFreeDraft, figureFreeProse } from "./figures/figureBlocks.js";
import { finalizePageDraft } from "./figures/figureDraftSummary.js";
import {
  reviewRequiredPageQualityChecks,
  runLocalPageQualityChecks
} from "./pagesLocalQa.js";
import { isSourceIdentityOnlyIssue } from "./citationRepairPolicy.js";
import { hasSmartUnslopCandidates } from "./smartUnslop.js";
import { pageQaProviderCallMetadata, withPageQaTriggerReasons } from "./pageQaRewriteTelemetry.js";
import {
  GROUNDED_FACTUALITY_RULE,
  IMAGE_PROMPT_CHARACTER_RULE,
  INTERNAL_PAGE_TITLE_RULE,
  READER_FACING_PAGE_BRIEF_RULES,
  buildPageInstruction,
  chapterBriefPayloadForPageScope,
  citationContractFields,
  sanitizePageBriefForCitationContract,
  compactFollowingPages,
  compactPriorPages,
  pageScopePayload,
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
  /** Original reader prose, fixed across repair attempts so planning aliases cannot become canon. */
  repairOriginalMarkdown?: string | undefined;
  signal?: AbortSignal | undefined;
  styleExcerpts?: string[] | undefined;
  /** Citeable generation notes loaded by the worker. */
  researchNotes?: string[] | undefined;
  /** Keep the model review but bypass configurable local checks; required invariants remain. */
  skipLocalChecks?: boolean | undefined;
  /** Operator-selected context size for the model page reviewer. Defaults to the legacy full prompt. */
  pageReviewPromptMode?: PageReviewPromptMode | undefined;
};

export type RevisePageOptions = ReviewPageOptions & {
  report: PageQualityReport;
  /** Candidate produced by this rewrite; the original draft is candidate 1. */
  qaCandidateNumber?: number | undefined;
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
    if (!shouldUseLocalReviewFallback(error)) {
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
  const pageInstruction = buildPageInstruction(options, "rewrite");
  const conditionalUnslop = hasSmartUnslopCandidates(options.report);
  const citation = citationContractFields(options.researchNotes ?? options.plan.researchNotes);
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "revise-page",
    ...(options.qaCandidateNumber !== undefined
      ? {
          providerCallMetadata: pageQaProviderCallMetadata({
            report: options.report,
            candidateNumber: options.qaCandidateNumber
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
                  options.researchNotes ?? options.plan.researchNotes
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

function normalizeIssueList(issues: string[], fallback: string): string[] {
  return issues.length > 0 ? issues : [fallback];
}
