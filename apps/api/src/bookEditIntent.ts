import {
  normalizeProjectLanguage,
  runToolLoop,
  withRecoverableNetworkRetry,
  type TextModelAdapter,
  type ToolLoopTool
} from "@book-maker/core";
import { z } from "zod";
import { backMatterIntent, backMatterIntentFromMessage, type BackMatterEdit } from "./bookEditBackMatter.js";
import { withTimeout } from "./withTimeout.js";

/** Per-attempt budget for the classifier model call; the heuristic fallback covers overruns. */
const CLASSIFIER_CALL_BUDGET_MS = 10_000;

export type BookEditIntentKind =
  | "answer"
  | "clarify"
  | "plan_revision"
  | "local_patch"
  | "page_rewrite"
  | "chapter_regenerate"
  | "undo_last_edit"
  | "show_content"
  | "book_replan"
  | "continue_book"
  | "back_matter";

export type BookEditProjectStage = "plan_ready" | "approved_plan" | "complete" | "other";
export type BookEditScope = "none" | "explicit_pages" | "matching_pages" | "all_pages";
export type BookEditImpact = "small_text" | "style_rewrite" | "structural_replan";
export type BookEditClarification = "none" | "scope" | "busy" | "confirm";

export type BookEditPageContext = {
  id: string;
  index: number;
  title: string;
  summary: string;
  previewText: string;
};

export type BookEditChapterContext = {
  index: number;
  title: string;
  pageIndexes: number[];
};

export type BookEditReplacement = {
  from: string;
  to: string;
};

/** What the user asked to read when the intent is show_content. */
export type ShowContentTarget =
  | { type: "outline" }
  | { type: "chapter"; index: number }
  | { type: "page"; index: number };

export type BookEditIntent = {
  kind: BookEditIntentKind;
  confidence: number;
  reasoning: string;
  affectedPageIndexes: number[];
  assistantMessage: string;
  scope: BookEditScope;
  impact: BookEditImpact;
  clarification: BookEditClarification;
  /** Chapter index when the intent targets a whole chapter (chapter_regenerate). */
  affectedChapterIndex?: number | null;
  /** Set for show_content intents. */
  contentTarget?: ShowContentTarget | null;
  /** Target book language for language-version replans. */
  targetLanguage?: string | null;
  /** Set for continue_book intents: how many chapters to append. */
  continuation?: { chapterCount: number } | null;
  /** Set for back_matter intents: whether the Sources list should be printed. */
  backMatter?: BackMatterEdit | null;
};

export const BOOK_EDIT_CONFIDENCE_THRESHOLD = 0.72;

/**
 * Actions the router may pick, scoped to the project stage so the model never
 * sees (or picks) actions that cannot run right now. Charged book edits go
 * through propose_edit; the server maps that to a priced intent kind.
 */
const decideActionsByStage: Record<
  Exclude<BookEditProjectStage, "other">,
  [DecideAction, ...DecideAction[]]
> = {
  plan_ready: ["answer", "clarify", "plan_revision", "show_content"],
  approved_plan: ["answer", "clarify", "plan_revision", "show_content"],
  complete: ["answer", "clarify", "show_content", "undo_last_edit", "propose_edit"]
};

export type DecideAction =
  | "answer"
  | "clarify"
  | "show_content"
  | "undo_last_edit"
  | "plan_revision"
  | "propose_edit";

function decideActionSchema(actions: [DecideAction, ...DecideAction[]]) {
  return z
    .object({
      action: z.enum(actions),
      confidence: z.number().min(0).max(1),
      reasoning: z.string().trim().min(1).max(600),
      assistantMessage: z.string().trim().min(1).max(1200),
      clarification: z.enum(["none", "scope"]).default("none"),
      /** Required when action is propose_edit. */
      editTarget: z
        .enum(["pages", "matching", "whole_book", "chapter", "structural", "language_copy", "continuation", "back_matter"])
        .optional(),
      editStyle: z.enum(["exact_replace", "rewrite"]).optional(),
      /** Whether the Sources list should be printed, when editTarget is back_matter. */
      backMatterSources: z.boolean().nullish(),
      pageIndexes: z.array(z.number().int().positive()).max(100).default([]),
      chapterIndex: z.number().int().positive().nullable().default(null),
      /** How many chapters to append when editTarget is continuation. */
      newChapterCount: z.number().int().min(1).max(8).nullish(),
      targetLanguage: z.string().trim().min(2).max(40).nullable().default(null),
      replacementFrom: z.string().trim().min(1).max(500).optional(),
      replacementTo: z.string().trim().min(1).max(500).optional()
    })
    .strict();
}

type DecideActionPayload = z.infer<ReturnType<typeof decideActionSchema>>;

export const CLASSIFIER_PAGE_SAMPLE_CAP = 120;

export type ClassifierPageSample = {
  pages: BookEditPageContext[];
  truncated: boolean;
};

/**
 * Bounds the page list serialized into the classifier prompt. Books over the
 * cap keep the pages the message refers to (±1 neighbor), the opening and
 * closing of the book, and an even stride across the middle, so a 600-page
 * book no longer ships every page summary while "edit page 412" still works.
 * Server-side page validation (affectedPagesForIntent) always uses the full
 * page set, so sampling here cannot make an edit target invalid pages.
 */
export function classifierPageSample(
  pages: BookEditPageContext[],
  message: string,
  cap = CLASSIFIER_PAGE_SAMPLE_CAP
): ClassifierPageSample {
  if (pages.length <= cap) {
    return { pages, truncated: false };
  }
  const orderedIndexes = [...pages].sort((a, b) => a.index - b.index).map((page) => page.index);
  const byIndex = new Map(pages.map((page) => [page.index, page]));
  const chosen = new Set<number>();
  // Pages the message names (plus one neighbor each side) win first; a huge
  // explicit range is clamped so the structural picks below always fit within
  // the cap (60 + 40 + 20 = cap).
  const mentioned = new Set<number>();
  for (const index of pageIndexesFromMessage(message, pages)) {
    for (const neighbor of [index - 1, index, index + 1]) {
      if (byIndex.has(neighbor)) {
        mentioned.add(neighbor);
      }
    }
  }
  for (const index of [...mentioned].slice(0, 60)) {
    chosen.add(index);
  }
  for (const index of orderedIndexes.slice(0, 40)) {
    chosen.add(index);
  }
  for (const index of orderedIndexes.slice(-20)) {
    chosen.add(index);
  }
  const remaining = orderedIndexes.filter((index) => !chosen.has(index));
  const slots = Math.max(0, cap - chosen.size);
  for (let slot = 0; slot < slots && remaining.length > 0; slot += 1) {
    const pick = remaining[Math.min(remaining.length - 1, Math.floor((slot * remaining.length) / slots))]!;
    chosen.add(pick);
  }
  return {
    pages: orderedIndexes.filter((index) => chosen.has(index)).map((index) => byIndex.get(index)!),
    truncated: true
  };
}

export async function classifyProjectChatMessage(options: {
  message: string;
  stage: BookEditProjectStage;
  pages: BookEditPageContext[];
  chapters?: BookEditChapterContext[] | undefined;
  planSummary?: string | undefined;
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }> | undefined;
  textModel?: TextModelAdapter | undefined;
  /** Fetches one page's full prose for the router's read_page tool. */
  loadPageBody?: ((index: number) => Promise<string | null>) | undefined;
}): Promise<BookEditIntent> {
  const message = options.message.trim();
  const chapters = options.chapters ?? [];
  // The sources list is compiled back matter, so no page edit can touch it.
  // Catching that here keeps it from being priced as a page rewrite that would
  // then leave the section in place.
  const backMatter = options.stage === "complete" ? backMatterIntentFromMessage(message) : null;
  if (backMatter) {
    return backMatter;
  }
  const heuristic = classifyWithHeuristics(message, options.stage, options.pages, options.planSummary, chapters);
  // Only ultra-high-precision read/undo shortcuts skip the model; everything
  // else (including chapter regen and language copies) goes through the tool agent.
  if (heuristic.kind === "show_content" || heuristic.kind === "undo_last_edit") {
    return normalizeIntentForStage(heuristic, options.stage);
  }
  const textModel = options.textModel;
  if (!textModel || options.stage === "other") {
    // Without a router model, fall back to the richer English heuristic tree.
    return normalizeIntentForStage(
      classifyWithDegradedHeuristics(message, options.stage, options.pages, options.planSummary, chapters),
      options.stage
    );
  }
  const stage = options.stage;

  try {
    const routed = await routeWithToolAgent({
      message,
      stage,
      pages: options.pages,
      chapters,
      planSummary: options.planSummary,
      recentMessages: options.recentMessages ?? [],
      heuristic,
      textModel,
      loadPageBody: options.loadPageBody
    });
    return normalizeIntentForStage(withDeterministicContentTarget(routed, message), stage);
  } catch {
    return normalizeIntentForStage(
      classifyWithDegradedHeuristics(message, options.stage, options.pages, options.planSummary, chapters),
      options.stage
    );
  }
}

/** Model-call budget for the whole routing loop (reads + final decision). */
const ROUTER_MAX_MODEL_CALLS = 4;
/** Prose cap per read_page result so a huge page cannot flood the router prompt. */
const ROUTER_READ_PAGE_TEXT_CAP = 4_000;

type RouteAgentOptions = {
  message: string;
  stage: Exclude<BookEditProjectStage, "other">;
  pages: BookEditPageContext[];
  chapters: BookEditChapterContext[];
  planSummary?: string | undefined;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  heuristic: BookEditIntent;
  textModel: TextModelAdapter;
  loadPageBody?: ((index: number) => Promise<string | null>) | undefined;
};

/**
 * The routing agent: the model may inspect actual page prose with read_page
 * before committing via decide. Charged edits use action propose_edit so the
 * server — not the model — picks the pricing tier from the edit target/style.
 */
async function routeWithToolAgent(options: RouteAgentOptions): Promise<BookEditIntent> {
  const actions = decideActionsByStage[options.stage];
  const canReadPages = options.pages.length > 0;
  const tools = canReadPages ? [readPageTool(options)] : [];
  const pageSample = classifierPageSample(options.pages, options.message);
  const result = await runToolLoop({
    textModel: options.textModel,
    purpose: "project_chat.edit_router",
    temperature: 0,
    maxTokens: 900,
    toolChoice: "required",
    maxModelCalls: ROUTER_MAX_MODEL_CALLS,
    tools,
    finishTool: {
      name: "decide",
      description:
        "Commit the final decision for the user's message. For any charged book change, use action propose_edit (never invent a pricing tier). Call exactly once after any page reads.",
      parameters: decideActionSchema(actions)
    },
    onModelCall: (invoke) =>
      withRecoverableNetworkRetry(
        () => withTimeout(invoke(), CLASSIFIER_CALL_BUDGET_MS, "Edit-intent router"),
        { attempts: 2, delayMs: 500 }
      ),
    messages: [
      { role: "system", content: routerSystemPrompt(options.stage, canReadPages) },
      {
        role: "user",
        content: JSON.stringify({
          projectStage: options.stage,
          userMessage: options.message,
          recentConversation: options.recentMessages.slice(-12).map((turn) => ({
            role: turn.role,
            content: turn.content.slice(0, 800)
          })),
          planSummary: options.planSummary ?? null,
          heuristicIntent: options.heuristic,
          heuristicInstruction: "Use heuristicIntent only as a hint. Prefer the user's actual meaning and projectStage.",
          chapters: options.chapters.map((chapter) => ({
            index: chapter.index,
            title: chapter.title,
            pageIndexes: chapter.pageIndexes
          })),
          pages: pageSample.pages.map((page) => ({
            index: page.index,
            title: page.title,
            summary: page.summary.slice(0, 240)
          })),
          pageContext: {
            totalPages: options.pages.length,
            includedPageCount: pageSample.pages.length,
            truncated: pageSample.truncated
          }
        })
      }
    ]
  });
  if (result.status !== "finished" || !result.finish) {
    throw new Error("Edit-intent router did not produce a routing decision.");
  }
  return intentFromDecideAction(result.finish, options.message, options.chapters);
}

/**
 * Maps the model's decide/propose_edit payload onto an internal BookEditIntent.
 * Pricing tiers (local_patch vs page_rewrite vs book_replan) are derived here
 * from editTarget + editStyle, never guessed as free-form kind labels.
 */
export function intentFromDecideAction(
  decision: DecideActionPayload,
  message: string,
  chapters: BookEditChapterContext[] = []
): BookEditIntent {
  if (decision.action === "propose_edit") {
    return intentFromProposeEdit(decision, message, chapters);
  }
  if (decision.action === "show_content") {
    return {
      kind: "show_content",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "small_text",
      clarification: "none",
      contentTarget: showContentTargetFromMessage(message) ?? { type: "outline" }
    };
  }
  if (decision.action === "undo_last_edit") {
    return {
      kind: "undo_last_edit",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }
  if (decision.action === "plan_revision") {
    return {
      kind: "plan_revision",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "small_text",
      clarification: "none",
      ...(decision.targetLanguage ? { targetLanguage: decision.targetLanguage } : {})
    };
  }
  if (decision.action === "clarify") {
    return {
      kind: "clarify",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: decision.pageIndexes ?? [],
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "small_text",
      clarification: decision.clarification === "scope" ? "scope" : "scope"
    };
  }
  return {
    kind: "answer",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "small_text",
    clarification: "none"
  };
}

export function intentFromProposeEdit(
  decision: DecideActionPayload,
  message: string,
  chapters: BookEditChapterContext[] = []
): BookEditIntent {
  const target = decision.editTarget ?? "pages";
  const style = decision.editStyle ?? (decision.replacementFrom ? "exact_replace" : "rewrite");
  const pageIndexes = [...new Set(decision.pageIndexes ?? [])].sort((a, b) => a - b);
  const chapterIndex = decision.chapterIndex ?? chapterRegenerateFromMessage(message);
  const targetLanguage =
    decision.targetLanguage ?? (target === "language_copy" ? targetLanguageFromLanguageVersionRequest(message) : null);

  if (target === "continuation") {
    const chapterCount = Math.min(
      8,
      Math.max(1, decision.newChapterCount ?? continuationRequestFromMessage(message)?.chapterCount ?? 1)
    );
    return {
      kind: "continue_book",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "none",
      impact: "style_rewrite",
      clarification: "none",
      continuation: { chapterCount }
    };
  }

  if (target === "back_matter") {
    // Defaults to removal: the section only exists to be dropped, so a model
    // that picks this target without saying which way meant "take it out".
    return backMatterIntent({ includeSources: decision.backMatterSources ?? false }, decision);
  }

  if (target === "language_copy" || target === "structural") {
    return {
      kind: "book_replan",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage: decision.assistantMessage,
      scope: "all_pages",
      impact: "structural_replan",
      clarification: "none",
      ...(targetLanguage ? { targetLanguage } : {})
    };
  }

  if (target === "chapter") {
    const chapter = chapterIndex ? chapters.find((candidate) => candidate.index === chapterIndex) : undefined;
    return {
      kind: "chapter_regenerate",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: chapter?.pageIndexes ?? pageIndexes,
      assistantMessage: decision.assistantMessage,
      scope: "explicit_pages",
      impact: "style_rewrite",
      clarification: chapterIndex ? "none" : "scope",
      affectedChapterIndex: chapterIndex
    };
  }

  const scope: BookEditScope =
    target === "whole_book"
      ? "all_pages"
      : target === "matching"
        ? "matching_pages"
        : pageIndexes.length > 0
          ? "explicit_pages"
          : "none";

  if (style === "exact_replace") {
    return {
      kind: scope === "none" ? "clarify" : "local_patch",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: pageIndexes,
      assistantMessage: decision.assistantMessage,
      scope,
      impact: "small_text",
      clarification: scope === "none" ? "scope" : "none"
    };
  }

  return {
    kind: scope === "none" ? "clarify" : "page_rewrite",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: pageIndexes,
    assistantMessage: decision.assistantMessage,
    scope,
    impact: "style_rewrite",
    clarification: scope === "none" ? "scope" : "none"
  };
}

function readPageTool(options: RouteAgentOptions): ToolLoopTool<{ index: number }> {
  const pagesByIndex = new Map(options.pages.map((page) => [page.index, page]));
  return {
    name: "read_page",
    description:
      "Read one page's actual prose before routing. Use it when the page titles and summaries are not enough to tell which pages the user's request involves.",
    parameters: z.object({ index: z.number().int().positive() }).strict(),
    execute: async ({ index }) => {
      const page = pagesByIndex.get(index);
      if (!page) {
        return { error: `Page ${index} does not exist. This book has ${options.pages.length} pages.` };
      }
      const body = options.loadPageBody ? await options.loadPageBody(index).catch(() => null) : null;
      return {
        index: page.index,
        title: page.title,
        summary: page.summary,
        text: (body ?? page.previewText).slice(0, ROUTER_READ_PAGE_TEXT_CAP)
      };
    }
  };
}

function routerSystemPrompt(stage: Exclude<BookEditProjectStage, "other">, canReadPages: boolean): string {
  const common = [
    "You decide what to do with each user chat message in an AI book-making app.",
    "You must finish by calling the decide tool; never answer in plain text.",
    ...(canReadPages
      ? [
          "When the page titles and summaries cannot tell which pages contain what the user mentions, call read_page on the most likely pages (at most two) before deciding."
        ]
      : []),
    "Use action answer for general questions that should not change anything.",
    "Messages that express dislike, discomfort, or a preference about existing content (for example: I don't like X, X should be Y, this feels too Z, too much X) are change requests, never answer.",
    "Use action clarify when the user wants a change but the target or scope is still unclear.",
    "Use action show_content when the user wants to read or see the outline, plan, table of contents, a chapter, or a page without changing it."
  ];
  const stageRules =
    stage === "complete"
      ? [
          "Use action undo_last_edit when the user wants to undo, revert, or roll back the most recent edit.",
          "For any charged book change, use action propose_edit. Set editTarget to pages (named pages), matching (find phrase matches), whole_book, chapter, structural (premise/character/audience/ending/structure/visual identity), language_copy (new language version), or continuation (continue the book: write the next chapter(s), keep writing, finish the story; set newChapterCount when the user says how many).",
          "Set editStyle to exact_replace for typos, renames, and quoted replacements; use rewrite for tone/style/content rewrites. Optionally set replacementFrom/replacementTo for exact replacements.",
          "Use editTarget back_matter, with backMatterSources false, when the user wants the sources / references / bibliography list at the end of the book gone (true to print it again). That list is generated at export time, so no page edit can remove it; this target is free.",
          "Set pageIndexes or chapterIndex when known. Set targetLanguage for language_copy.",
          "Never invent credit prices or internal pricing tiers; the server prices propose_edit."
        ]
      : [
          "This project is in plan review, so route every change request as plan_revision: content changes, planning preferences, media choices (no images, no covers, skip visuals), and structure requests.",
          "Use plan_revision with targetLanguage when the user asks to change the book's language."
        ];
  const closing = [
    "For change actions, write assistantMessage as a short confirmation of the specific change that will be proposed or made.",
    "Write assistantMessage in the same language the user's message is written in, even when the book's pages are in a different language.",
    "pages may be a sample of a longer book; pageContext reports totalPages and whether the list was truncated, and pages not listed still exist.",
    "Never include provider, model, chain-of-thought, or internal routing details in assistantMessage."
  ];
  return [...common, ...stageRules, ...closing].join(" ");
}

/** The model cannot emit structured content targets; recover them from the message. */
function withDeterministicContentTarget(intent: BookEditIntent, message: string): BookEditIntent {
  if (intent.kind !== "show_content") {
    return intent;
  }
  return { ...intent, contentTarget: showContentTargetFromMessage(message) ?? { type: "outline" } };
}

export type BookEditDislikePreference = {
  /** What the user objects to, when the message names it. */
  subject: string | null;
};

/**
 * Detects dissatisfaction or preference statements about existing content
 * ("I don't like X", "X should be Y", "too much Z"). These carry edit intent
 * even without an imperative edit verb, so they must never route to answer.
 */
export function dislikePreferenceFromMessage(message: string): BookEditDislikePreference | null {
  const text = message.trim();
  if (/\?\s*$/.test(text) || /^(?:what|why|how|where|when|who|which|can you explain|tell me)\b/i.test(text)) {
    return null;
  }
  const subjectPatterns = [
    /\bi\s+(?:really\s+|just\s+)?(?:do\s+not|don'?t|didn'?t|did\s+not)\s+(?:like|love|enjoy|want)\s+(.{2,120}?)(?=[.,;:!\n]|$)/i,
    /\bi\s+(?:really\s+)?(?:hate|dislike)\s+(.{2,120}?)(?=[.,;:!\n]|$)/i,
    /\bi(?:'m|\s+am)\s+not\s+(?:a\s+fan\s+of|happy\s+with|comfortable\s+with|okay\s+with|ok\s+with)\s+(.{2,120}?)(?=[.,;:!\n]|$)/i,
    /\b(?:there(?:'s|\s+is)\s+)?(?:way\s+|far\s+)?too\s+(?:much|many)\s+(.{2,80}?)(?=[.,;:!\n]|$)/i
  ];
  for (const pattern of subjectPatterns) {
    const match = text.match(pattern);
    const subject = match?.[1]
      ?.trim()
      .replace(/^(?:a|an|the)\s+/i, "")
      .replace(/\s+/g, " ");
    if (subject) {
      return { subject };
    }
  }
  const directive =
    /\b(?:this|that|it|they|she|he)\s+(?:really\s+)?should(?:n'?t|\s+not)?\s+(?:be|feel|stay|remain|happen|sound|read|have|include)\b/i.test(
      text
    ) ||
    (/\bshould\s+(?:be|feel|stay|remain|happen)\b/i.test(text) && !/\bshould\s+(?:i|we|you)\b/i.test(text)) ||
    /\bi\s+(?:would\s+)?prefer\b/i.test(text) ||
    /\bi'?d\s+rather\b/i.test(text);
  return directive ? { subject: null } : null;
}

const dislikeSubjectStopTerms = new Set([
  "the", "and", "that", "this", "these", "those", "with", "without", "from", "into", "onto", "over", "under",
  "part", "parts", "scene", "scenes", "chapter", "chapters", "page", "pages", "book", "story", "bit", "bits",
  "thing", "things", "stuff", "whole", "entire", "very", "really", "much", "many", "more", "less", "some", "all",
  "being", "having", "just", "then", "than", "when", "where", "how", "his", "her", "its", "their"
]);

/** Pages whose title, summary, or preview mention a significant word of the disliked subject. */
export function pageIndexesMatchingSubject(subject: string, pages: BookEditPageContext[]): number[] {
  const terms = [
    ...new Set(
      (subject.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((term) => !dislikeSubjectStopTerms.has(term))
    )
  ];
  if (terms.length === 0) {
    return [];
  }
  return pages
    .filter((page) => {
      const haystack = `${page.title} ${page.summary} ${page.previewText}`.toLowerCase();
      return terms.some(
        (term) => haystack.includes(term) || (term.endsWith("s") && haystack.includes(term.slice(0, -1)))
      );
    })
    .map((page) => page.index)
    .sort((a, b) => a - b);
}

/**
 * High-precision shortcuts only. Charged edit routing belongs to the tool agent;
 * this path is for show/undo short-circuits and degraded fallbacks when the model
 * is unavailable.
 */
export function classifyWithHeuristics(
  message: string,
  stage: BookEditProjectStage,
  pages: BookEditPageContext[],
  planSummary?: string | undefined,
  _chapters: BookEditChapterContext[] = []
): BookEditIntent {
  const isPlanStage = stage === "plan_ready" || stage === "approved_plan";
  const asksQuestion = /\?$|^(what|why|how|can you explain|tell me|summari[sz]e|where|when)\b/i.test(message.trim());
  const contentTarget = showContentTargetFromMessage(message);

  if (contentTarget && !hasEditVerbBeyondShow(message)) {
    return {
      kind: "show_content",
      confidence: 0.9,
      reasoning: "The user wants to read book content, not change it.",
      affectedPageIndexes: contentTarget.type === "page" ? [contentTarget.index] : [],
      assistantMessage: showContentAcknowledgement(contentTarget),
      scope: "none",
      impact: "small_text",
      clarification: "none",
      contentTarget
    };
  }

  if (isUndoRequestMessage(message)) {
    return {
      kind: "undo_last_edit",
      confidence: 0.9,
      reasoning: "The user asked to undo the most recent edit.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll undo the last edit and restore the previous version of those pages.",
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  if (asksQuestion || !looksLikeChangeRequest(message)) {
    return {
      kind: "answer",
      confidence: 0.78,
      reasoning: "The message reads as a question or general chat, not a change request.",
      affectedPageIndexes: [],
      assistantMessage: isPlanStage ? answerPlanQuestion(message, planSummary) : answerMessage(message, pages),
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  // Degraded fallback: never invent a charged edit kind from English regex trees.
  return {
    kind: "clarify",
    confidence: 0.45,
    reasoning: "Heuristic fallback cannot safely price or target this change without the router.",
    affectedPageIndexes: [],
    assistantMessage: isPlanStage
      ? "I can revise the plan — tell me what to change."
      : "Should I edit a specific page, matching phrase, or the whole book?",
    scope: "none",
    impact: "small_text",
    clarification: "scope"
  };
}

const continuationNumberWords: Record<string, number> = {
  a: 1,
  an: 1,
  another: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8
};

/**
 * Detects "continue my book" requests: keep writing, write the next chapter,
 * add N more chapters, finish the story. Returns the requested chapter count
 * (default 1) or null when the message is not a continuation request.
 */
export function continuationRequestFromMessage(message: string): { chapterCount: number } | null {
  const text = message.trim();
  if (/\?\s*$/.test(text)) {
    return null;
  }
  const addChapters = text.match(
    /\b(?:add|write|create|generate|give\s+me)\s+(?:(\d{1,2}|a|an|another|one|two|three|four|five|six|seven|eight)\s+)?(?:more\s+|new\s+|additional\s+|extra\s+)*chapters?\b/i
  );
  const nextChapter = text.match(
    /\b(?:write|start|draft|do)\s+(?:the\s+)?next\s+(?:(\d{1,2}|two|three|four|five)\s+)?chapters?\b/i
  );
  const continueBook =
    /\b(?:continue|keep\s+going\s+with|keep\s+writing|carry\s+on\s+with|pick\s+up)\b.{0,60}\b(?:book|story|novel|manuscript|writing|where\s+(?:i|it|we)\s+left\s+off)\b/i.test(
      text
    ) || /^(?:continue|keep\s+going|keep\s+writing)[.!\s]*$/i.test(text);
  const finishBook = /\b(?:finish|complete)\s+(?:writing\s+)?(?:the\s+|my\s+)?(?:book|story|novel|manuscript)\b/i.test(text);
  if (!addChapters && !nextChapter && !continueBook && !finishBook) {
    return null;
  }
  const countToken = (addChapters?.[1] ?? nextChapter?.[1])?.toLowerCase();
  const parsed = countToken ? continuationNumberWords[countToken] ?? Number.parseInt(countToken, 10) : 1;
  const chapterCount = Number.isFinite(parsed) ? Math.min(8, Math.max(1, parsed)) : 1;
  return { chapterCount };
}

function continuationAcknowledgement(chapterCount: number): string {
  return chapterCount > 1
    ? `I’ll write ${chapterCount} new chapters that continue your book in its own voice.`
    : "I’ll write the next chapter of your book in its own voice.";
}

function looksLikeChangeRequest(message: string): boolean {
  return (
    dislikePreferenceFromMessage(message) !== null ||
    targetLanguageFromLanguageVersionRequest(message) !== null ||
    continuationRequestFromMessage(message) !== null ||
    /\b(change|edit|rewrite|revise|fix|replace|rename|swap|switch|remove|delete|add|insert|update|make|turn|shorten|expand|polish|regenerate|move|reorder|restructure|redo|rework|want|prefer)\b/i.test(
      message
    ) ||
    /\b(?:no|without|skip)\s+(?:images?|covers?|illustrations?|visuals?)\b/i.test(message)
  );
}

function classifyWithDegradedHeuristics(
  message: string,
  stage: BookEditProjectStage,
  pages: BookEditPageContext[],
  planSummary?: string | undefined,
  chapters: BookEditChapterContext[] = []
): BookEditIntent {
  const lower = message.toLowerCase();
  const isPlanStage = stage === "plan_ready" || stage === "approved_plan";
  const explicitPages = pageIndexesFromMessage(message, pages);
  const broadScope = hasAllPagesScope(message);
  const explicitScope: BookEditScope = explicitPages.length > 0 ? "explicit_pages" : broadScope ? "all_pages" : "none";
  const replacement = replacementTermsFromMessage(message);
  const matchedReplacementPages = replacement ? pageIndexesMatchingText(replacement.from, pages) : [];
  const targetLanguage = targetLanguageFromLanguageVersionRequest(message);
  const languageVersionRequest = targetLanguage !== null;
  const hasEditVerb =
    /\b(change|edit|rewrite|revise|fix|replace|rename|swap|switch|remove|delete|add|insert|update|make|turn|shorten|expand|polish|regenerate|move|reorder|restructure|redo|rework)\b/i.test(
      message
    ) || languageVersionRequest;
  const dislike = dislikePreferenceFromMessage(message);
  const hasChangeIntent = hasEditVerb || dislike !== null;
  const asksQuestion = /\?$|^(what|why|how|can you explain|tell me|summari[sz]e|where|when)\b/i.test(message.trim());
  const scopeOnly = isBookEditScopeOnlyMessage(message);
  const contentTarget = showContentTargetFromMessage(message);
  const undoRequest = isUndoRequestMessage(message);
  const chapterRegen = chapterRegenerateFromMessage(message);
  const structural =
    /\b(add|remove|delete|new)\s+(a\s+)?(chapter|section|page)\b/i.test(message) ||
    /\b(change|switch|replace|swap|turn|make|move|reorder|restructure)\b.{0,80}\b(audience|premise|book type|length|structure|outline|plan|ending|title|cover|visual identity|illustration style)\b/i.test(
      message
    ) ||
    /\b(change|switch|replace|swap|turn|make)\b.{0,80}\b(main character|character|protagonist|hero|species|animal)\b/i.test(
      message
    ) ||
    /\b(main character|protagonist|hero|species|animal)\b.{0,80}\b(to|with|into)\b/i.test(message) ||
    /\b(move|reorder)\b.{0,60}\b(chapters?|ending|beginning|scenes?|sections?)\b/i.test(message) ||
    /\bmake\s+it\s+(twice|half|much)\b/i.test(lower);

  if (contentTarget && !hasEditVerbBeyondShow(message)) {
    return {
      kind: "show_content",
      confidence: 0.9,
      reasoning: "The user wants to read book content, not change it.",
      affectedPageIndexes: contentTarget.type === "page" ? [contentTarget.index] : [],
      assistantMessage: showContentAcknowledgement(contentTarget),
      scope: "none",
      impact: "small_text",
      clarification: "none",
      contentTarget
    };
  }

  if (undoRequest) {
    return {
      kind: "undo_last_edit",
      confidence: 0.9,
      reasoning: "The user asked to undo the most recent edit.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll undo the last edit and restore the previous version of those pages.",
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  const continuation = stage === "complete" ? continuationRequestFromMessage(message) : null;
  if (continuation) {
    return {
      kind: "continue_book",
      confidence: 0.86,
      reasoning: "The user asked to continue the book with new chapters.",
      affectedPageIndexes: [],
      assistantMessage: continuationAcknowledgement(continuation.chapterCount),
      scope: "none",
      impact: "style_rewrite",
      clarification: "none",
      continuation
    };
  }

  if (chapterRegen !== null && !isPlanStage) {
    const chapter = chapters.find((candidate) => candidate.index === chapterRegen);
    return {
      kind: "chapter_regenerate",
      confidence: 0.88,
      reasoning: "The user asked to regenerate a specific chapter.",
      affectedPageIndexes: chapter?.pageIndexes ?? [],
      assistantMessage: chapter
        ? `I’ll rewrite chapter ${chapterRegen} (“${chapter.title}”) with that direction.`
        : `I’ll rewrite chapter ${chapterRegen} with that direction.`,
      scope: "explicit_pages",
      impact: "style_rewrite",
      clarification: "none",
      affectedChapterIndex: chapterRegen
    };
  }
  const patch =
    replacement !== null ||
    /\b(typo|spelling|grammar|punctuation|capitali[sz]ation|rename)\b/i.test(message) ||
    /["“][^"”]{1,160}["”]\s+(to|with|into)\s+["“][^"”]{1,160}["”]/i.test(message);
  const rewrite =
    /\b(rewrite|revise|shorten|expand|polish|regenerate)\b/i.test(message) ||
    /\b(make|change|adjust)\b.{0,80}\b(tone|style|voice|mood|feel|warmer|clearer|simpler|funnier|scarier|softer|gentler|more exciting|more practical|more detailed)\b/i.test(
      message
    );
  const mediaPreference =
    /\b(?:i\s+(?:do\s+not|don't|dont)\s+want|no|without|skip|remove|disable|turn\s+off)\b.{0,80}\b(?:images?|covers?|visuals?|illustrations?|artwork|pictures?)\b/i.test(
      message
    );
  const softPlanChange =
    mediaPreference ||
    /^i\s+(?:want|would like|need|prefer)\b(?!\s+(?:to\s+)?(?:know|understand|ask|see|review|learn|hear)\b)(?=.{0,140}\b(?:audience|reader|readers|tone|style|title|premise|outline|chapters?|examples?|images?|covers?|visuals?|illustrations?|pages?|length|ending|parents|children|kids)\b)/i.test(
      message.trim()
    ) ||
    /\b(?:could|can)\s+(?:it|the\s+(?:book|story|plan|audience|tone|style|title|chapters?|outline))\s+(?:be|have|use|include|focus)\b/i.test(
      message
    ) ||
    /\b(?:audience|reader|readers|tone|style|title|premise|outline|chapters?|examples?|visuals?|illustrations?)\s+should\b/i.test(
      message
    ) ||
    /\bmake\s+it\s+more\b/i.test(message);

  if (scopeOnly) {
    return {
      kind: "clarify",
      confidence: 0.82,
      reasoning: "The message only supplies edit scope and needs a pending edit request to apply it.",
      affectedPageIndexes: [],
      assistantMessage: "What change should I apply to the whole book?",
      scope: broadScope ? "all_pages" : "none",
      impact: "small_text",
      clarification: "scope"
    };
  }

  if (isPlanStage && (hasChangeIntent || softPlanChange)) {
    return {
      kind: "plan_revision",
      confidence: 0.88,
      reasoning: "The project is in a plan stage and the message requests a change.",
      affectedPageIndexes: [],
      assistantMessage:
        stage === "approved_plan"
          ? "I’ll revise the approved plan with that direction so you can review it again."
          : "I’ll revise the book plan with that direction.",
      scope: explicitScope,
      impact: structural ? "structural_replan" : rewrite ? "style_rewrite" : "small_text",
      clarification: "none",
      ...(targetLanguage ? { targetLanguage } : {})
    };
  }

  if (isPlanStage) {
    return {
      kind: "answer",
      confidence: asksQuestion || !hasEditVerb ? 0.84 : 0.76,
      reasoning: "The project is in plan review and the user is asking about the plan rather than generated book text.",
      affectedPageIndexes: [],
      assistantMessage: answerPlanQuestion(message, planSummary),
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  if (stage !== "complete") {
    return {
      kind: asksQuestion || !hasChangeIntent ? "answer" : "clarify",
      confidence: asksQuestion || !hasChangeIntent ? 0.82 : 0.7,
      reasoning: "The project is not ready for generated-book edits.",
      affectedPageIndexes: [],
      assistantMessage:
        asksQuestion || !hasChangeIntent
          ? "I can answer questions about this project, but book text edits are available after the book is generated."
          : "I can help with that after the current book work is finished.",
      scope: explicitScope,
      impact: structural ? "structural_replan" : rewrite ? "style_rewrite" : "small_text",
      clarification: hasChangeIntent ? "scope" : "none"
    };
  }

  if (!hasChangeIntent && asksQuestion) {
    return {
      kind: "answer",
      confidence: 0.86,
      reasoning: "The user is asking a general question.",
      affectedPageIndexes: [],
      assistantMessage: answerMessage(message, pages),
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  if (!hasChangeIntent) {
    return {
      kind: "answer",
      confidence: 0.74,
      reasoning: "No edit intent was detected.",
      affectedPageIndexes: [],
      assistantMessage: "I can help with questions about the book or make edits if you tell me what to change.",
      scope: "none",
      impact: "small_text",
      clarification: "none"
    };
  }

  if (languageVersionRequest) {
    return {
      kind: "book_replan",
      confidence: 0.91,
      reasoning: "The user asked to create a generated language version of the completed book.",
      affectedPageIndexes: [],
      assistantMessage: `I’ll create a new ${languageDisplayName(targetLanguage)} copy and regenerate the book there. This book stays unchanged.`,
      scope: "all_pages",
      impact: "structural_replan",
      clarification: "none",
      targetLanguage
    };
  }

  if (structural) {
    return {
      kind: "book_replan",
      confidence: 0.9,
      reasoning: "The request changes the book identity, structure, or planning assumptions.",
      affectedPageIndexes: [],
      assistantMessage: "I’ll rebuild the plan and regenerate the book around that change.",
      scope: broadScope ? "all_pages" : explicitScope,
      impact: "structural_replan",
      clarification: "none"
    };
  }

  if (patch) {
    const scope: BookEditScope =
      explicitScope === "explicit_pages"
        ? "explicit_pages"
        : replacement
          ? "matching_pages"
          : broadScope
            ? "all_pages"
            : "none";
    const affectedPageIndexes = scope === "matching_pages" ? matchedReplacementPages : explicitPages;
    const confident = scope !== "none" || affectedPageIndexes.length > 0 || replacement !== null;
    return {
      kind: confident ? "local_patch" : "clarify",
      confidence: confident ? 0.86 : 0.68,
      reasoning: replacement
        ? "The request is an exact replacement or rename."
        : "The request looks like a small text edit.",
      affectedPageIndexes,
      assistantMessage:
        scope === "explicit_pages"
          ? `I’ll apply that text edit to page ${formatPageList(explicitPages)}.`
          : scope === "matching_pages" || scope === "all_pages"
            ? "I’ll apply that text edit throughout the book where it matches."
            : "Should I change a specific page, matching phrase, or the whole book?",
      scope,
      impact: "small_text",
      clarification: scope === "none" ? "scope" : "none"
    };
  }

  if (rewrite) {
    const canRewrite = explicitScope === "explicit_pages" || broadScope;
    return {
      kind: canRewrite ? "page_rewrite" : "clarify",
      confidence: canRewrite ? 0.86 : 0.68,
      reasoning: "The request is a same-structure rewrite or style edit.",
      affectedPageIndexes: explicitPages,
      assistantMessage:
        explicitScope === "explicit_pages"
          ? `I’ll rewrite page ${formatPageList(explicitPages)} with that direction.`
          : broadScope
            ? "I’ll rewrite the book with that direction while keeping the same structure."
            : "Should I rewrite a specific page or the whole book?",
      scope: explicitScope,
      impact: "style_rewrite",
      clarification: canRewrite ? "none" : "scope"
    };
  }

  if (dislike) {
    if (dislike.subject && isIdentityChangeSubject(dislike.subject)) {
      return {
        kind: "book_replan",
        confidence: 0.85,
        reasoning: "The user dislikes an identity-level part of the book, which needs a replan.",
        affectedPageIndexes: [],
        assistantMessage: "I’ll rebuild the plan and regenerate the book around that change.",
        scope: broadScope ? "all_pages" : explicitScope,
        impact: "structural_replan",
        clarification: "none"
      };
    }
    if (broadScope) {
      return {
        kind: "page_rewrite",
        confidence: 0.84,
        reasoning: "The user wants existing content changed across the whole book.",
        affectedPageIndexes: [],
        assistantMessage: "I’ll rewrite the book with that direction while keeping the same structure.",
        scope: "all_pages",
        impact: "style_rewrite",
        clarification: "none"
      };
    }
    const matchedPages = dislike.subject ? pageIndexesMatchingSubject(dislike.subject, pages) : [];
    const affectedPageIndexes = explicitPages.length > 0 ? explicitPages : matchedPages;
    if (affectedPageIndexes.length > 0) {
      return {
        kind: "page_rewrite",
        confidence: 0.84,
        reasoning: "The user expressed a preference change about existing content.",
        affectedPageIndexes,
        assistantMessage: `I’ll revise page ${formatPageList(affectedPageIndexes)} with that direction.`,
        scope: explicitPages.length > 0 ? "explicit_pages" : "matching_pages",
        impact: "style_rewrite",
        clarification: "none"
      };
    }
    return {
      kind: "clarify",
      confidence: 0.8,
      reasoning: "The user wants existing content changed but no target pages could be inferred.",
      affectedPageIndexes: [],
      assistantMessage:
        "I can change that. Should I revise the scenes where it appears, specific pages, or the whole book?",
      scope: "none",
      impact: "style_rewrite",
      clarification: "scope"
    };
  }

  return {
    kind: "clarify",
    confidence: 0.62,
    reasoning: "The message appears edit-like but the target is unclear.",
    affectedPageIndexes: explicitPages,
    assistantMessage: "Should I edit a specific page, matching phrase, or the whole book?",
    scope: explicitScope,
    impact: "small_text",
    clarification: "scope"
  };
}

function isIdentityChangeSubject(subject: string): boolean {
  return /\b(?:main\s+characters?|protagonists?|hero(?:es)?|species|titles?|premise|audience|endings?|structure|outline|covers?|visual\s+identity|illustration\s+style)\b/i.test(
    subject
  );
}

function pageIndexesMatchingText(text: string, pages: BookEditPageContext[]): number[] {
  const needle = text.toLowerCase();
  if (!needle) {
    return [];
  }
  return pages
    .filter((page) =>
      [page.title, page.summary, page.previewText].some((value) => value.toLowerCase().includes(needle))
    )
    .map((page) => page.index)
    .sort((a, b) => a - b);
}

function formatPageList(indexes: number[]): string {
  return indexes.length === 1 ? String(indexes[0]) : indexes.join(", ");
}


function normalizeIntentForStage(intent: BookEditIntent, stage: BookEditProjectStage): BookEditIntent {
  const bounded: BookEditIntent = {
    ...intent,
    confidence: Math.max(0, Math.min(1, intent.confidence)),
    affectedPageIndexes: [...new Set(intent.affectedPageIndexes)].sort((a, b) => a - b),
    scope: intent.scope ?? "none",
    impact: intent.impact ?? "small_text",
    clarification: intent.clarification ?? "none"
  };
  if (
    (stage === "plan_ready" || stage === "approved_plan") &&
    ["local_patch", "page_rewrite", "book_replan", "chapter_regenerate", "continue_book"].includes(bounded.kind)
  ) {
    return { ...bounded, kind: "plan_revision" };
  }
  if (bounded.confidence < BOOK_EDIT_CONFIDENCE_THRESHOLD && bounded.kind !== "answer" && bounded.kind !== "show_content") {
    return {
      ...bounded,
      kind: "clarify",
      clarification: bounded.clarification === "none" ? "scope" : bounded.clarification,
      assistantMessage: bounded.assistantMessage || "Can you clarify what you want changed?"
    };
  }
  return bounded;
}

const targetLanguageAliases: Record<string, string> = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  dutch: "nl",
  turkish: "tr",
  russian: "ru",
  arabic: "ar",
  farsi: "fa",
  persian: "fa",
  hindi: "hi",
  chinese: "zh",
  mandarin: "zh",
  japanese: "ja",
  korean: "ko",
  hebrew: "he",
  greek: "el",
  thai: "th",
  swedish: "sv",
  norwegian: "no",
  danish: "da",
  polish: "pl",
  ukrainian: "uk"
};

const targetLanguageNamePattern = Object.keys(targetLanguageAliases)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|");

function targetLanguageFromLanguageVersionRequest(message: string): string | null {
  const patterns = [
    new RegExp(
      `\\b(?:generate|create|make|regenerate|rewrite|translate|convert|build|produce)\\b.{0,100}\\b(${targetLanguageNamePattern})\\s+(?:version|copy|edition|translation)\\b`,
      "iu"
    ),
    new RegExp(
      `\\b(?:generate|create|make|regenerate|rewrite|translate|convert|build|produce)\\b.{0,100}\\b(?:in|to|into)\\s+(${targetLanguageNamePattern})\\b`,
      "iu"
    ),
    new RegExp(
      `\\b(?:translate|convert|rewrite|regenerate)\\b.{0,100}\\b(?:to|into|in)\\s+(${targetLanguageNamePattern})\\b`,
      "iu"
    ),
    new RegExp(
      `\\b(?:change|switch|set|make|turn|translate|convert)\\b.{0,80}\\blanguage\\b.{0,20}\\b(?:to|into|as|in|should\\s+be|:)\\s+(${targetLanguageNamePattern})\\b`,
      "iu"
    ),
    new RegExp(
      `\\blanguage\\s+(?:to|into|as|in|should\\s+be|:)\\s+(${targetLanguageNamePattern})\\b`,
      "iu"
    )
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    const rawLanguage = match?.[1]?.toLowerCase();
    const alias = rawLanguage ? targetLanguageAliases[rawLanguage] : undefined;
    if (alias) {
      return normalizeProjectLanguage(alias);
    }
  }
  return null;
}

function languageDisplayName(language: string | null): string {
  return language === "en" ? "English" : language ?? "translated";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detects requests to read (not change) the outline, a chapter, or a page.
 * Returns null when the message does not look like a read request.
 */
export function showContentTargetFromMessage(message: string): ShowContentTarget | null {
  const text = message.trim();
  // "Why …" asks for an explanation, never a content read, even when it
  // contains a read-verb homograph like "display".
  if (/^why\b/i.test(text)) {
    return null;
  }
  const readVerb = /\b(?:show|read|see|view|display|open|give)\s+(?:me\s+)?/i;
  const wantsRead =
    readVerb.test(text) ||
    // "what's in chapter 2", "what does page 3 say" - but not broad questions
    // like "what is this plan about?", which deserve a summarized answer.
    /^what(?:'s|\s+is)\s+(?:in|on)\b/i.test(text) ||
    /\bwhat\s+does\s+(?:chapter|page)\s+\d+\s+say\b/i.test(text) ||
    /^let me (?:see|read)\b/i.test(text) ||
    /\bread\s+(?:it|that)\s+(?:back|to me)\b/i.test(text);
  if (!wantsRead) {
    return null;
  }
  const pageMatch = text.match(/\bpage\s+(\d{1,3})\b/i);
  if (pageMatch && !/\b(?:outline|plan|chapters?|table of contents|toc)\b/i.test(text)) {
    return { type: "page", index: Number(pageMatch[1]) };
  }
  const chapterMatch = text.match(/\bchapter\s+(\d{1,2})\b/i);
  if (chapterMatch) {
    return { type: "chapter", index: Number(chapterMatch[1]) };
  }
  if (/\b(?:outline|plan|table of contents|toc|chapters|chapter list|structure)\b/i.test(text)) {
    return { type: "outline" };
  }
  return null;
}

/** True when the message combines a read phrase with an actual edit request. */
function hasEditVerbBeyondShow(message: string): boolean {
  return /\b(change|edit|rewrite|revise|fix|replace|rename|swap|remove|delete|insert|update|shorten|expand|polish|regenerate|redo|rework|make\s+it)\b/i.test(
    message
  );
}

function showContentAcknowledgement(target: ShowContentTarget): string {
  if (target.type === "page") {
    return `Here’s page ${target.index}.`;
  }
  if (target.type === "chapter") {
    return `Here’s chapter ${target.index}.`;
  }
  return "Here’s the current outline.";
}

export function isUndoRequestMessage(message: string): boolean {
  const normalized = message.toLowerCase().replace(/[.!?]+$/g, "").trim();
  return (
    /^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:undo|revert|roll\s*back)\b/.test(normalized) ||
    /\b(?:undo|revert|roll\s*back)\s+(?:the\s+|that\s+|my\s+)?(?:last|latest|previous|recent)?\s*(?:edit|change|revision|rewrite)?$/.test(
      normalized
    )
  );
}

/** Extracts the chapter index from "rewrite chapter 3, make it funnier"-style requests. */
export function chapterRegenerateFromMessage(message: string): number | null {
  const match = message.match(
    /\b(?:rewrite|regenerate|redo|rework|revise|refresh|improve)\s+(?:the\s+)?chapter\s+(\d{1,2})\b/i
  ) ??
    message.match(/\bchapter\s+(\d{1,2})\b.{0,40}\b(?:rewrite|regenerate|redo|rework|from scratch|again)\b/i);
  if (!match?.[1]) {
    return null;
  }
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : null;
}

export function pageIndexesFromMessage(message: string, pages: BookEditPageContext[]): number[] {
  const indexes = new Set<number>();
  for (const match of message.matchAll(/\bpages?\s+(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/gi)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) {
      indexes.add(index);
    }
  }
  for (const page of pages) {
    const title = page.title.trim().toLowerCase();
    if (title.length >= 4 && message.toLowerCase().includes(title)) {
      indexes.add(page.index);
    }
  }
  return [...indexes].filter((index) => pages.some((page) => page.index === index)).sort((a, b) => a - b);
}

export function quotedTexts(message: string): string[] {
  return [...message.matchAll(/["“]([^"”]{1,500})["”]/g)].map((match) => match[1]!.trim()).filter(Boolean);
}

export function replacementTermsFromMessage(message: string): BookEditReplacement | null {
  const quotes = quotedTexts(message);
  if (quotes.length >= 2) {
    return cleanReplacement({ from: quotes[0]!, to: quotes[1]! });
  }

  const match = message.match(
    /\b(?:replace|change|rename|swap|switch|turn)\s+(?:the\s+)?(.{1,160}?)\s+(?:with|to|into|as)\s+(.{1,220})$/i
  );
  if (!match) {
    return null;
  }
  return cleanReplacement({ from: match[1]!, to: match[2]! });
}

function cleanReplacement(replacement: BookEditReplacement): BookEditReplacement | null {
  const from = cleanReplacementTerm(replacement.from);
  const to = cleanReplacementTerm(replacement.to);
  if (!from || !to || editAttributeTerms.has(from.toLowerCase())) {
    return null;
  }
  return { from, to };
}

export function bookEditScopeFromMessage(message: string): BookEditScope {
  return hasAllPagesScope(message) ? "all_pages" : "none";
}

export function isBookEditScopeOnlyMessage(message: string): boolean {
  const normalized = normalizeScopeOnlyText(message);
  if (!hasAllPagesScope(normalized)) {
    return false;
  }
  const withoutScope = normalized
    .replace(/\b(?:the\s+)?(?:whole|entire|full)\s+(?:book|story|manuscript)\b/g, "")
    .replace(/\b(?:all|every)\s+(?:pages?|chapters?|book|story)\b/g, "")
    .replace(/\b(?:everywhere|throughout|globally)\b/g, "")
    .trim();
  return withoutScope.length === 0;
}

export function messageWithScope(message: string, scope: BookEditScope): string {
  if (scope === "all_pages") {
    return `${message.trim().replace(/[.?!]+$/g, "")} throughout the whole book.`;
  }
  return message.trim();
}

function hasAllPagesScope(message: string): boolean {
  return /\b(?:whole|entire|full)\s+(?:book|story|manuscript)\b/i.test(message) ||
    /\b(?:all|every)\s+(?:pages?|chapters?)\b/i.test(message) ||
    /\b(?:everywhere|throughout|globally)\b/i.test(message) ||
    /\bacross\s+(?:the\s+)?(?:book|story|all pages)\b/i.test(message);
}

function normalizeScopeOnlyText(message: string): string {
  return message
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/^(?:i\s+(?:said|mean|meant|told\s+you)\s+|just\s+|please\s+|do\s+|make\s+it\s+|the\s+)/i, "")
    .replace(/\s+please$/i, "")
    .trim();
}

function cleanReplacementTerm(value: string): string {
  return value
    .trim()
    .replace(/\b(?:in|throughout|across|over|for)\s+(?:the\s+)?(?:whole|entire|full|all|every)\s+(?:book|story|pages?|chapters?).*$/i, "")
    .replace(/\b(?:everywhere|throughout|globally)\b.*$/i, "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/[.?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const editAttributeTerms = new Set(["tone", "style", "voice", "mood", "feel", "vibe", "language", "length"]);

function answerPlanQuestion(message: string, planSummary?: string | undefined): string {
  const summary = planSummary?.trim();
  if (summary) {
    const firstLines = summary
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join("\n");
    if (/\bsummar/i.test(message) || /\bwhat\b.{0,40}\b(?:plan|about)\b/i.test(message)) {
      return `Here’s the current plan:\n${firstLines}`;
    }
  }
  return "I can answer questions about this plan. If you want something changed, tell me what to adjust and I’ll revise the plan for review.";
}

function answerMessage(message: string, pages: BookEditPageContext[]): string {
  const lower = message.toLowerCase();
  if (/\bhow many pages\b/.test(lower)) {
    return `This book currently has ${pages.length} generated pages.`;
  }
  if (/\bsummar/i.test(message)) {
    const pageLines = pages
      .slice(0, 6)
      .map((page) => `Page ${page.index}: ${page.summary || page.title}`)
      .join("\n");
    return pageLines || "There are no generated pages to summarize yet.";
  }
  return "I can answer questions about the latest book or edit it if you ask for a specific change.";
}
