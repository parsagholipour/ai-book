import { z } from "zod";

import { type BookEditProjectStage } from "./bookEditIntent.js";

/**
 * What the edit router is allowed to decide, and what it is told.
 *
 * Split out of `bookEditIntent.ts` because that file is the classifier — reading
 * a decision back into a `BookEditIntent` — while this one is the *interface* to
 * the model: the action list, the tool schema, and the prose. Every new edit
 * target adds a schema field and two or three sentences here, and none of it
 * changes how a decision is interpreted, so the two grow at different rates and
 * for different reasons.
 *
 * Like `bookEditMessage.ts`, this imports a type back from `bookEditIntent.ts`
 * and never a value: the cycle is erased at compile time, and keeping it that
 * way is what stops a module-initialization order bug.
 */

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

/**
 * The clarification budget: one question per request. Once the user has
 * answered a clarification without supplying the detail it asked for ("just
 * add"), asking again is a loop they cannot escape, so clarify is removed from
 * the actions the model is even allowed to return.
 */
export function decideActionsFor(
  stage: Exclude<BookEditProjectStage, "other">,
  clarifyExhausted: boolean
): [DecideAction, ...DecideAction[]] {
  const actions = decideActionsByStage[stage];
  if (!clarifyExhausted) {
    return actions;
  }
  const remaining = actions.filter((action) => action !== "clarify");
  // Every stage list leads with "answer", so dropping clarify always leaves one.
  return [remaining[0] ?? "answer", ...remaining.slice(1)];
}

export type DecideAction =
  | "answer"
  | "clarify"
  | "show_content"
  | "undo_last_edit"
  | "plan_revision"
  | "propose_edit";

export function decideActionSchema(actions: [DecideAction, ...DecideAction[]]) {
  return z
    .object({
      action: z.enum(actions),
      confidence: z.number().min(0).max(1),
      reasoning: z.string().trim().min(1).max(600),
      // 600, not more: for answers this text is only the fallback behind the
      // grounded pass, and for edits the proposal card carries the details —
      // the router was spending output tokens on prose that was discarded.
      assistantMessage: z.string().trim().min(1).max(600),
      clarification: z.enum(["none", "scope"]).default("none"),
      /** Required when action is propose_edit. */
      editTarget: z
        .enum([
          "pages",
          "matching",
          "whole_book",
          "chapter",
          "structural",
          "language_copy",
          "continuation",
          "back_matter",
          "chapter_heading",
          "insert_image",
          "move_image",
          "remove_image"
        ])
        .optional(),
      editStyle: z.enum(["exact_replace", "rewrite"]).optional(),
      /** Whether the Sources list should be printed, when editTarget is back_matter. */
      backMatterSources: z.boolean().nullish(),
      /** How a chapter heading should read, when editTarget is chapter_heading. */
      chapterHeadingStyle: z.enum(["label_number_title", "number_title", "title_only"]).nullish(),
      /** A word to use in place of "Chapter", when editTarget is chapter_heading. */
      chapterHeadingLabel: z.string().trim().min(1).max(24).nullish(),
      /** What the new picture should show, when editTarget is insert_image. */
      imageSubject: z.string().trim().min(1).max(300).nullish(),
      /** Where the new picture goes, when editTarget is insert_image and no page is named. */
      imagePlacement: z.enum(["end_of_book", "page"]).nullish(),
      /** True when the new picture replaces an existing illustration instead of adding another. */
      imageReplace: z.boolean().nullish(),
      pageIndexes: z.array(z.number().int().positive()).max(100).default([]),
      /** Destination page for move_image. Source stays pageIndexes. */
      imageDestPageIndexes: z.array(z.number().int().positive()).max(100).nullish(),
      /**
       * How many pictures a remove_image covers. Absent is the one picture the
       * router pointed at; `chapter` reads `chapterIndex` beside it.
       */
      imageSelection: z.enum(["one", "chapter", "all"]).nullish(),
      /**
       * Where inside a page a moved picture lands. A within-page move ("to the
       * top of the page", "below the text") names no destination page, so this
       * is what keeps it away from the destination question.
       */
      imagePosition: z.enum(["top", "bottom"]).nullish(),
      chapterIndex: z.number().int().positive().nullable().default(null),
      /** How many chapters to append when editTarget is continuation. */
      newChapterCount: z.number().int().min(1).max(8).nullish(),
      /** The whole book's new length in pages, when editTarget is structural. */
      newTargetPages: z.number().int().min(1).max(600).nullish(),
      /** Whether the rebuilt book should have interior illustrations, when editTarget is structural. */
      illustrationsEnabled: z.boolean().nullish(),
      targetLanguage: z.string().trim().min(2).max(40).nullable().default(null),
      replacementFrom: z.string().trim().min(1).max(500).optional(),
      replacementTo: z.string().trim().min(1).max(500).optional()
    })
    .strict();
}

export type DecideActionPayload = z.infer<ReturnType<typeof decideActionSchema>>;

/**
 * Everything the router is told about pictures. Grouped because the five rules
 * only make sense together: each one exists to keep a request off the *other*
 * targets, and a picture request misrouted to a page rewrite is the expensive
 * mistake — it quotes per page for prose nobody asked to change.
 */
const IMAGE_RULES = [
  "Adding a new picture, photo, image, illustration or drawing is propose_edit with editTarget insert_image — never a page edit and never a clarify. Set imageSubject to what the picture should show, in the user's own words but WITHOUT any placement words; when a follow-up adjusts an earlier image request, restate the full imageSubject from the conversation. Set pageIndexes to the one page it belongs on whenever the user names a place in any language or form — \"on page 3\", \"on the 3rd page\", \"the third page\", \"صفحه ۳\" all mean pageIndexes [3] — or imagePlacement to end_of_book for the end/back of the book. Example: \"Add the photo of her signature on the 3rd page\" → imageSubject \"her signature\", pageIndexes [3]. Never ask where the picture should go: when no place is named, the default is the end of the book.",
  "When the user corrects or replaces any existing picture — a built-in illustration or one they added — \"change the first image to…\", \"no, I actually want…\", \"instead…\", \"replace the photo with a castle\" — that is still insert_image, with imageReplace true and imageSubject set to the NEW subject; set pageIndexes when they name a page or an ordinal (\"the first image\", \"on page 1\"). A replacement keeps the old picture's spot; the server picks which picture. Without imageReplace the book ends up with both.",
  "Removing an existing picture is propose_edit with editTarget remove_image — never a page rewrite. Set pageIndexes to the page that currently holds it when they name one. The server picks which picture; never ask. Set imageSelection to all when the user means every picture in the book (\"remove all the pictures\", \"take the images out\", \"I don't want any illustrations\"), or to chapter together with chapterIndex when they mean one chapter's pictures (\"remove the images from chapter 2\"); leave it unset for a single picture. Removing every picture is still free and still one request, so never ask which one when they said all.",
  "Moving an existing picture is propose_edit with editTarget move_image — never a page rewrite. Set pageIndexes to the SOURCE page (where it is now) when they name one; set imageDestPageIndexes to the destination page when they name where it should go, or imagePlacement to end_of_book for the end/back of the book. If they name no destination, ask once which page, stating you will put it at the end of the book if they don't say.",
  "When a move names a place INSIDE a page — \"move the picture to the top of the page\", \"put the image below the text\", \"at the bottom of page 4\" — set imagePosition to top or bottom and leave pageIndexes as the page the picture is already on. That is a complete destination: do not set imageDestPageIndexes and do not ask which page.",
  "Requests to resize an existing picture — or to replace one WITHOUT saying what the new picture should show — and negated requests (\"don't add a photo of…\") are not insert_image, move_image or remove_image and must never be priced as a page rewrite: use action answer."
];

export function routerSystemPrompt(
  stage: Exclude<BookEditProjectStage, "other">,
  canReadPages: boolean,
  clarifyExhausted: boolean
): string {
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
    "Clarification policy: a change request is actionable as soon as you can tell what to change. Make sensible creative choices yourself, and never ask about optional creative preferences such as a character's name, role or relationships, which scene something belongs in, tone, mood, or ending. Use action clarify at most once per request, and only when a missing, contradictory, or unresolvable target makes any edit impossible.",
    "When you do ask, state in the same message the default you will apply if the user does not answer, so that simply agreeing is enough to proceed (for example: \"I'll add them as a new character in the scenes where the story needs them. Want to tell me more about them, or should I go ahead with that?\"). Never send a bare question with no stated default.",
    "Use action show_content when the user wants to read or see the outline, plan, table of contents, a chapter, or a page without changing it."
  ];
  const clarificationBudget = clarifyExhausted
    ? [
        "You already asked a clarifying question about this request and the user chose not to add detail. Decide now with your own sensible defaults and commit to the edit; asking again would strand them with no way forward.",
        "userMessage carries the original request together with the user's follow-up. Treat them as one request, and act on the original request."
      ]
    : [];
  const stageRules =
    stage === "complete"
      ? [
          "Use action undo_last_edit when the user wants to undo, revert, or roll back the most recent edit.",
          "For any charged book change, use action propose_edit. Set editTarget to pages (named pages), matching (find phrase matches), whole_book, chapter, structural (replacing the premise/main character/audience/ending/structure/visual identity), language_copy (new language version), or continuation (continue the book: write the next chapter(s), keep writing, finish the story; set newChapterCount when the user says how many).",
          "Adding something new to the finished book — a character, a scene, an object, a mention — is propose_edit, not clarify. Set editTarget to pages for the scenes where it belongs, or whole_book when it should run through the story. Reserve structural for replacing the book's premise or main character, because it regenerates the entire book.",
          ...IMAGE_RULES,
          "Set editStyle to exact_replace for typos, renames, and quoted replacements; use rewrite for tone/style/content rewrites. Optionally set replacementFrom/replacementTo for exact replacements.",
          "Use editTarget back_matter, with backMatterSources false, when the user wants the sources / references / bibliography list at the end of the book gone (true to print it again). That list is generated at export time, so no page edit can remove it; this target is free.",
          "Use editTarget chapter_heading when the user wants chapter headings worded differently — dropping the word \"Chapter\", showing only the title, changing the numbering, or calling them Parts or Episodes. Set chapterHeadingStyle to title_only (just the title), number_title (\"1. The Web Spins\"), or label_number_title (\"Chapter 1: The Web Spins\", the default), and chapterHeadingLabel when they name a different word. Chapter headings are generated at export time from the title alone, so no page edit can change them; this target is free.",
          "A request that changes how long the book is or whether it has pictures is structural, because both are decided when the book is planned. Set newTargetPages whenever the user names a length (\"make it 3 pages\", \"half as long\" — resolve it to a number), and illustrationsEnabled false when they want it without illustrations (true to add them). Report them even when the message also asks for other changes; the server prices the book you describe, so leaving them out quotes the old book's size.",
          "Set pageIndexes or chapterIndex when known. Set targetLanguage for language_copy.",
          "Never invent credit prices or internal pricing tiers; the server prices propose_edit."
        ]
      : [
          "This project is in plan review, so route every change request as plan_revision: content changes, planning preferences, media choices (no images, no covers, skip visuals), and structure requests.",
          "Use plan_revision with targetLanguage when the user asks to change the book's language."
        ];
  const closing = [
    "For change actions, write assistantMessage as a short confirmation of the specific change that will be proposed or made.",
    "For action answer, keep assistantMessage to two or three concise sentences: a separate grounded pass with the book's full context writes the final answer and only falls back to yours.",
    "Write assistantMessage in the same language the user's message is written in, even when the book's pages are in a different language.",
    "pages may be a sample of a longer book; pageContext reports totalPages and whether the list was truncated, and pages not listed still exist.",
    "Never include provider, model, chain-of-thought, or internal routing details in assistantMessage."
  ];
  return [...common, ...clarificationBudget, ...stageRules, ...closing].join(" ");
}
