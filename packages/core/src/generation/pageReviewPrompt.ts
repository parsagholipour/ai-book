import type { GenerateJsonOptions } from "../adapters/types.js";
import type { ChapterPlan, PageQualityReport } from "../schemas/book.js";
import { pageQualityReportSchema } from "../schemas/book.js";
import { CONTINUITY_NOTE_PROMPT_LIMITS, continuityNotesForPrompt } from "../context/contextPack.js";
import { targetLanguagePayload, targetLanguageReviewGuidance } from "../prompting/language.js";
import { chapterBriefPayloadForPageScope, citationContractFields, sanitizePageBriefForCitationContract, compactFollowingPages, compactPriorPages, openingContractFieldsForPage, pageScopePayload, reviewerStyleRules, styleGuidancePayload } from "./pagesShared.js";
import { evidenceLedgerRules } from "./evidenceLedger.js";
import { localStyleInstructions } from "./styleContract.js";
import type { ReviewPageOptions } from "./pagesReview.js";
import { READER_NAMING_REVIEW_RULE } from "./readerNaming.js";
import { buildSentenceRepairReviewPrompt } from "./pageSentenceRepair.js";

export function buildPageReviewPrompt(options: ReviewPageOptions): GenerateJsonOptions<PageQualityReport> {
  if (options.sentenceRepair && !options.userRequest) return buildSentenceRepairReviewPrompt(options);
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

  return {
      purpose: "review-page",
      ...(options.signal ? { signal: options.signal } : {}),
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
            READER_NAMING_REVIEW_RULE,
            "For confirmed planning-label leakage or fictional-status disclaimers leaking into narration, reject the page and set checks.promptLeakFree=false.",
            ...citationReviewRules,
            "Treat semantic repetition as a failure even when wording differs: the same encounter, same decision, same exposition, or same emotional turn cannot appear twice.",
            "The last previousPages entry may carry ending: the words the page immediately before this draft closes on, which the draft follows.",
            "Do not reject merely because the same character performs a necessary recurring action type assigned by the current pageBrief; reject it only when it restages the same beat, reuses distinctive wording, or fails to add a new consequence.",
            "For a final page, reject vague closure unless it resolves the core promise with a concrete consequence or completed choice.",
            ...opening.rules,
            ...(options.userRequest ? ["userRequest is the approved reader edit intent and overrides stale pageBrief and voice expectations. Requested changes in tone, register, pacing, mood or content are intentional; judge only unintended defects and preserve the requested change."] : []),
            ...(options.repairInstruction ? ["repairInstruction identifies concrete manuscript defects this candidate must fix. Evaluate those goals against the actual preceding and following prose. A necessary short bridge may override a conflicting old pageBrief; do not demand its removal merely for recalling where the characters just were. Still reject unnecessary repetition, invented facts or substantial performance of a reserved future scene. State whether the repair goals were achieved, and keep unresolved goals actionable."] : []),
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
            "Judge the final book page against its actual ending and the book promise. Technical references to the beginning of a day, quotations, and intentional open endings are not automatically vague; phrase matches alone cannot reject a page.",
            "Return one JSON object with approved (boolean), score (integer 0-100), issues (string array), requiredRevisions (string array), notes (string), and checks with placeholderFree, promptLeakFree, titleClean, repetitionOk, progressionOk, styleNatural booleans.",
            "Do not use feedback as the only root field."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              language: targetLanguagePayload(options.input.language),
              brief: options.input.prompt,
              book: {
                title: options.plan.title,
                premise: options.plan.premise,
                audience: options.plan.audience,
                characterNames: options.plan.characters.map((character) => character.name),
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
              ...(options.userRequest ? { userRequest: options.userRequest } : {}),
              ...(options.repairInstruction ? { repairInstruction: options.repairInstruction } : {}),
              ...(options.sentenceRepair ? { sentenceRepair: options.sentenceRepair } : {}),
              ...(options.repairOriginalMarkdown && options.repairOriginalMarkdown !== options.draft.markdown &&
                options.repairOriginalMarkdown !== options.sentenceRepair?.originalMarkdown
                ? { repairOriginalMarkdown: options.repairOriginalMarkdown } : {}),
              ...(options.retrievedResearch ? { retrievedResearch: options.retrievedResearch } : {}),
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
    };
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

function reviewerCitationRules(hasResearchNotes: boolean): string[] {
  const gate = hasResearchNotes
    ? "Use only sources present in researchNotes when checking source details, but treat researchNotes as context rather than an exhaustive inventory of everything established in the book."
    : "researchNotes is empty: use the draft, previousPages, and qualified public facts as the available context; do not require a diary, dispatch, archive, citation, named testimony, or other source identity.";
  return [
    gate,
    "For this review, never reject a person, event, scene, quotation, record, publication, institution, or other detail merely because it may be fake, invented, fabricated, fictional, reconstructed, or absent from researchNotes. An earlier page outside the supplied context may have established it. Reject only an independently identifiable defect such as a factual or chronological error, an unsupported claim, repetition, contradiction, prompt leakage, stalled progression, or a reserved-beat restage."
  ];
}
