import type { ChatMessage } from "../adapters/types.js";
import { buildContextPack } from "../context/contextPack.js";
import {
  targetLanguageGenerationGuidance,
  targetLanguagePayload
} from "../prompting/language.js";
import { kidsReadingGuidanceLines } from "../prompting/readingLevel.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { pageGetsInteriorIllustration } from "./illustrationSlots.js";
import {
  GROUNDED_FACTUALITY_RULE,
  IMAGE_PROMPT_CHARACTER_RULE,
  INTERNAL_PAGE_TITLE_RULE,
  READER_FACING_PAGE_BRIEF_RULES,
  buildPageInstruction,
  chapterBriefPayloadForPageScope,
  compactFollowingPages,
  compactPriorPages,
  pageScopePayload,
  styleGuidancePayload,
  writerToneRules,
  type GeneratePageOptions
} from "./pagesShared.js";

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
  return [
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
    "Vary how pages open: do not begin this page with the same opening move, image, or sentence shape the recentPages excerpts begin with.",
    "Use pageScope to distinguish global page position from chapter-local position.",
    ...(options.nextPages && options.nextPages.length > 0
      ? [
          "followingPages is prose that already exists after this page and is not being rewritten. End so the first of them reads on naturally from your last line, and do not write any beat, reveal, or line of dialogue that already appears there."
        ]
      : []),
    "The current pageBrief is authoritative; chapter keyBeats and futureChapterPageBriefs are context only unless assigned to this page.",
    ...pageDraftImagePromptGuidance(options.input, options.pageIndex),
    ...targetLanguageGenerationGuidance(options.input.language),
    ...writerToneRules(options.input),
    ...extraSystemLines
  ].join(" ");
}

export function buildPageDraftUserPayload(options: GeneratePageOptions) {
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
    ...(options.styleExcerpts && options.styleExcerpts.length > 0 ? { styleExcerpts: options.styleExcerpts } : {}),
    tokenBudget: 7000,
    readingGuidance: kidsReadingGuidanceLines(options.input)
  });
  const recentPages = compactPriorPages(options.previousPages ?? [], 5, 1000);
  // Tighter than the backward window on purpose: the page has to *land* into
  // what follows, which the opening of the next page settles, and a wide
  // forward window invites the draft to write the rest of the book's beats.
  const followingPages = compactFollowingPages(options.nextPages ?? [], 2, 800);
  const styleExcerpts = options.styleExcerpts ?? [];

  return {
    context,
    language: targetLanguagePayload(options.input.language),
    userContext: {
      prompt: options.input.prompt,
      category: options.input.category,
      subcategory: options.input.subcategory,
      styleGuidance: styleGuidancePayload(options.input)
    },
    chapterBrief: chapterBriefPayloadForPageScope(options.chapterBrief),
    pageBrief: options.pageBrief,
    pageScope: pageScopePayload(options),
    characters: options.plan.characters,
    illustrationPlan: options.plan.illustrationPlan,
    recentPages,
    ...(followingPages.length > 0 ? { followingPages } : {}),
    ...(styleExcerpts.length > 0 ? { styleExcerpts } : {}),
    alreadyCovered: recentPages.map((page) => ({
      page: page.index,
      title: page.title,
      coveredBeat: page.summary
    })),
    pageInstruction: buildPageInstruction(options.pageIndex, options.input.targetPages)
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
