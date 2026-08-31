import type { ChatMessage } from "../adapters/types.js";
import { buildContextPack } from "../context/contextPack.js";
import {
  targetLanguageGenerationGuidance,
  targetLanguagePayload
} from "../prompting/language.js";
import {
  kidsReadingGuidanceLines,
  kidsReadingGuidancePayload
} from "../prompting/readingLevel.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { pageGetsInteriorIllustration } from "./illustrationSlots.js";
import {
  GROUNDED_FACTUALITY_RULE,
  IMAGE_PROMPT_CHARACTER_RULE,
  INTERNAL_PAGE_TITLE_RULE,
  READER_FACING_PAGE_BRIEF_RULES,
  buildPageInstruction,
  citationContractFields,
  sanitizePageBriefForCitationContract,
  chapterBriefPayloadForPageScope,
  compactFollowingPages,
  compactPriorPages,
  pageScopePayload,
  writerToneRules,
  type GeneratePageOptions,
  type PageDraftContextMode,
  type PriorPageContext
} from "./pagesShared.js";

const COMPACT_PAGE_SUMMARY_COUNT = 18;
const COMPACT_PAGE_SUMMARY_CHARACTERS = 400;
const COMPACT_HANDOFF_EDGE_CHARACTERS = 350;

function resolvedPageDraftContextMode(options: GeneratePageOptions): PageDraftContextMode {
  return options.pageDraftContextMode ?? "excerpted";
}

function compactPageSummaryLines(options: GeneratePageOptions): string[] {
  return priorPagesForCompactContext(options)
    .filter((page) => page.summary.trim().length > 0)
    .slice(-COMPACT_PAGE_SUMMARY_COUNT)
    .map(
      (page) =>
        `Page ${page.index} — ${page.title}: ${clipPromptText(page.summary.trim(), COMPACT_PAGE_SUMMARY_CHARACTERS)}`
    );
}

function priorPagesForCompactContext(options: GeneratePageOptions): PriorPageContext[] {
  return [...(options.previousPages ?? [])]
    .filter((page) => page.index < options.pageIndex)
    .sort((left, right) => left.index - right.index);
}

function compactNearestPriorPage(options: GeneratePageOptions, styleExcerpts: string[]) {
  const nearest = priorPagesForCompactContext(options).at(-1);
  if (!nearest) {
    return undefined;
  }
  const characters = Array.from(nearest.markdown);
  const beginningLength = Math.min(COMPACT_HANDOFF_EDGE_CHARACTERS, characters.length);
  const endingStart = Math.max(beginningLength, characters.length - COMPACT_HANDOFF_EDGE_CHARACTERS);
  const matchingStyleLock = nearestPageStyleLock(nearest.markdown, styleExcerpts);
  const styleLockedPrefixLength = matchingStyleLock?.prefixLength ?? 0;

  return {
    index: nearest.index,
    title: nearest.title,
    isDirectHandoff: nearest.index === options.pageIndex - 1,
    ...(matchingStyleLock ? { beginningStyleLockExcerpt: matchingStyleLock.index } : {}),
    beginningExcerpt: characters.slice(Math.min(styleLockedPrefixLength, beginningLength), beginningLength).join(""),
    endingExcerpt: characters.slice(Math.max(styleLockedPrefixLength, endingStart)).join("")
  };
}

function nearestPageStyleLock(markdown: string, styleExcerpts: string[]) {
  const withoutLeadingWhitespace = markdown.trimStart();
  const leadingWhitespaceLength = Array.from(
    markdown.slice(0, markdown.length - withoutLeadingWhitespace.length)
  ).length;
  let matchingStyleLock: { index: number; prefixLength: number } | undefined;

  styleExcerpts.forEach((excerpt, index) => {
    if (!withoutLeadingWhitespace.startsWith(excerpt)) {
      return;
    }
    const prefixLength = leadingWhitespaceLength + Array.from(excerpt).length;
    if (!matchingStyleLock || prefixLength > matchingStyleLock.prefixLength) {
      matchingStyleLock = { index: index + 1, prefixLength };
    }
  });

  return matchingStyleLock;
}

function clipPromptText(value: string, characterLimit: number): string {
  const characters = Array.from(value);
  if (characters.length <= characterLimit) {
    return value;
  }
  return `${characters.slice(0, characterLimit - 1).join("")}…`;
}

export function pageDraftImagePromptGuidance(input: CreateProjectInput, pageIndex: number): string[] {
  if (pageGetsInteriorIllustration(input, pageIndex)) {
    return [
      "Return JSON with title, markdown, summary, continuityNotes, and an imagePrompt for this page's illustration.",
      "Images are generated later, so imagePrompt must be a separate visual prompt field and must not appear in markdown.",
      IMAGE_PROMPT_CHARACTER_RULE
    ];
  }
  return [
    "Return JSON with title, markdown, summary, and continuityNotes.",
    "Do not include imagePrompt; this page will not be illustrated."
  ];
}

export function buildPageDraftSystemContent(
  options: GeneratePageOptions,
  extraSystemLines: string[] = []
): string {
  const citation = citationContractFields(options.researchNotes);
  const contextMode = resolvedPageDraftContextMode(options);
  return [
    "Write one finished Markdown page of the book as a human author would.",
    ...(options.editInstruction
      ? [
          "editInstruction is the approved reader request and is authoritative. Apply it explicitly. pageBrief governs structure and continuity, but never whether the requested change is performed. Do not soften, substitute, or silently omit it."
        ]
      : []),
    ...(options.characterContext
      ? ["characterContext is supplemental canon for character identity, traits, and appearance. Use it when writing, but do not treat it as an additional requested edit."]
      : []),
    "Do not mention AI, prompts, plans, JSON, schemas, generation, or production instructions.",
    INTERNAL_PAGE_TITLE_RULE,
    GROUNDED_FACTUALITY_RULE,
    ...citation.rules,
    "Do not use scaffold phrases, meta commentary, or a summary of what the page should do.",
    ...READER_FACING_PAGE_BRIEF_RULES,
    "Make the page itself advance the story or explanation through concrete action, claims, dialogue, or scene work.",
    "Every page must add a distinct irreversible change, new information, completed decision, or resolved consequence.",
    ...(contextMode === "compact"
      ? [
          "Do not replay an encounter, decision, exposition point, or emotional beat recorded in the indexed previous-page summaries.",
          "When present, nearestPriorPage is the nearest available completed page, not necessarily the immediately preceding page. Continue directly from its ending only when isDirectHandoff is true; otherwise use it as earlier context without inventing a missing handoff.",
          "When nearestPriorPage.beginningStyleLockExcerpt is present, that numbered Style lock excerpt in context.system contains the beginning of the nearest page; beginningExcerpt contains only any non-overlapping remainder. Read them together without treating the style-lock prose as a second occurrence."
        ]
      : ["Do not replay an encounter, decision, exposition point, or emotional beat that already appeared in recent pages."]),
    "If the pageBrief requires a recurring action type from earlier pages, such as running, waiting, arguing, or explaining, use fresh concrete details and make the outcome different.",
    ...(contextMode === "compact"
      ? [
          "When nearestPriorPage is present, treat it as a phrase blacklist for distinctive action wording; do not reuse its memorable clauses.",
          "When nearestPriorPage is present, vary how pages open: do not begin this page with the same opening move, image, or sentence shape as its beginningExcerpt or referenced beginningStyleLockExcerpt."
        ]
      : [
          "Treat previousPages as a phrase blacklist for distinctive action wording; do not reuse memorable clauses from earlier pages.",
          "Vary how pages open: do not begin this page with the same opening move, image, or sentence shape the recentPages excerpts begin with."
        ]),
    "Use pageScope to distinguish global page position from chapter-local position.",
    ...(options.nextPages && options.nextPages.length > 0
      ? [
          "followingPages is prose that already exists after this page and is not being rewritten. End so the first of them reads on naturally from your last line, and do not write any beat, reveal, or line of dialogue that already appears there."
        ]
      : []),
    "The current pageBrief is authoritative for its historical assignment; source-identity requirements are governed only by researchNotes and the citation rule. Chapter keyBeats and futureChapterPageBriefs are context only unless assigned to this page.",
    ...pageDraftImagePromptGuidance(options.input, options.pageIndex),
    ...targetLanguageGenerationGuidance(options.input.language),
    ...writerToneRules(options.input),
    ...extraSystemLines
  ].join(" ");
}

export function buildPageDraftUserPayload(options: GeneratePageOptions) {
  const pageInstruction = buildPageInstruction(options, "initialDraft");
  const citation = citationContractFields(options.researchNotes);
  const readingGuidance = kidsReadingGuidancePayload(options.input);
  const pageDraftContextMode = resolvedPageDraftContextMode(options);
  const compactContext = pageDraftContextMode === "compact";
  const styleExcerpts = options.styleExcerpts ?? [];
  const compactStyleExcerpts = styleExcerpts.map((excerpt) => excerpt.trim()).filter(Boolean);
  // Keep budget accounting on the internal pack, but do not spend provider
  // input tokens sending the model diagnostic metadata it cannot draft from.
  const { budget: _diagnosticBudget, ...context } = buildContextPack({
    plan: options.plan,
    chapter: options.chapter,
    pageIndex: options.pageIndex,
    targetPages: options.input.targetPages,
    previousSummaries: compactContext ? compactPageSummaryLines(options) : options.previousSummaries,
    continuityNotes: options.continuityNotes,
    researchNotes: options.researchNotes,
    semanticMemory: options.semanticMemory,
    entityState: options.entityState,
    ...(styleExcerpts.length > 0 ? { styleExcerpts: compactContext ? compactStyleExcerpts : styleExcerpts } : {}),
    tokenBudget: 7000,
    readingGuidance: kidsReadingGuidanceLines(options.input)
  });
  const recentPages = compactContext ? [] : compactPriorPages(options.previousPages ?? [], 5, 1000);
  const nearestPriorPage = compactContext ? compactNearestPriorPage(options, compactStyleExcerpts) : undefined;
  // Tighter than the backward window on purpose: the page has to *land* into
  // what follows, which the opening of the next page settles, and a wide
  // forward window invites the draft to write the rest of the book's beats.
  const followingPages = compactFollowingPages(options.nextPages ?? [], 2, 800);
  return {
    pageDraftContextMode,
    context,
    ...(options.editInstruction ? { editInstruction: options.editInstruction } : {}),
    ...(options.characterContext ? { characterContext: options.characterContext } : {}),
    ...(options.adherenceRepair?.length ? { adherenceRepair: options.adherenceRepair } : {}),
    language: targetLanguagePayload(options.input.language),
    userContext: {
      prompt: options.input.prompt,
      category: options.input.category,
      subcategory: options.input.subcategory,
      // The former styleGuidance object duplicated every tone rule already in
      // the system message. Kids books alone retain their structured reading
      // contract because audienceLabel and the validation-tolerance ceiling
      // are not otherwise serialized, even though the actionable rules are.
      ...(readingGuidance ? { readingGuidance } : {})
    },
    chapterBrief: chapterBriefPayloadForPageScope(options.chapterBrief),
    pageBrief: options.pageBrief
      ? sanitizePageBriefForCitationContract(options.pageBrief, options.researchNotes)
      : options.pageBrief,
    ...citation.payload,
    pageScope: pageScopePayload(options),
    characters: options.plan.characters,
    ...(pageGetsInteriorIllustration(options.input, options.pageIndex)
      ? { illustrationPlan: options.plan.illustrationPlan }
      : {}),
    ...(compactContext
      ? (nearestPriorPage ? { nearestPriorPage } : {})
      : {
          recentPages,
          ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
          alreadyCovered: recentPages.map((page) => ({
            page: page.index,
            title: page.title,
            coveredBeat: page.summary
          }))
        }),
    ...(followingPages.length > 0 ? { followingPages } : {}),
    ...pageInstruction.payload,
    pageInstruction: pageInstruction.text
  };
}

export function buildPageDraftMessages(
  options: GeneratePageOptions,
  extraSystemLines: string[] = []
): ChatMessage[] {
  return [
    {
      role: "system",
      content: buildPageDraftSystemContent(options, extraSystemLines)
    },
    {
      role: "user",
      content: JSON.stringify(buildPageDraftUserPayload(options), null, 2)
    }
  ];
}
