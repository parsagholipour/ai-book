import { type BookEditIntent, type BookEditPageContext } from "./bookEditIntent.js";
import {
  bulkImageSelectionFromMessage,
  endOfBookPlacementFromMessage,
  imagePlacementFromMessage,
  imagePositionFromMessage,
  pageIndexesMatchingSubject
} from "./bookEditMessage.js";
import { MODEL_PAGE_NUMBERING, type ReaderPageNumbering } from "./bookPageNumbering.js";

/**
 * The model side of "add a photo of X": what the router's insert_image
 * decision maps to, and where the image actually lands in the live book.
 *
 * There is deliberately no regex recognizer here. The router is the one
 * classifier — extraction of a subject and a placement from free text is model
 * work, and a regex fast path making that call ahead of the model is how "her
 * signature on the 3rd page" once became the subject of an end-of-book card.
 * Without a model the request degrades to the heuristics' clarify; that
 * outage-only cost was accepted when the recognizer was removed.
 */

export type ImageInsertionEdit = {
  /** What the picture should show, in the user's own words. */
  subject: string;
  /**
   * Absent when the request named no place. The proposal path then applies
   * the subject-anchored default against the live pages — never a question,
   * because placement always has a safe default (the end of the book).
   */
  placement?: "end_of_book" | "page";
  /** Only meaningful with placement "page". Validated against real pages later. */
  pageIndex?: number;
  /**
   * Present when the request replaces an existing illustration instead of
   * adding another. The router only *raises* the request (empty operationId —
   * it cannot know which pictures exist); the proposal path resolves it to a
   * live target: a chat-added marker (`operationId`), a generation ImageAsset
   * (`assetId`), or another in-page markdown ref (`marker`).
   */
  replace?: { operationId: string; assetId?: string; marker?: string; oldSubject?: string };
};

/** One resolved picture: how the worker finds it, and the page it sits on today. */
export type ImageLayoutTarget = {
  operationId: string;
  assetId?: string;
  marker?: string;
  oldSubject?: string;
  pageIndex: number;
};

/**
 * Which pictures a layout edit covers. Remove-only: a move is always one
 * picture, because nobody asks to move seven pictures to one place and a card
 * could not honestly summarise it if they did.
 */
export type ImageLayoutSelection = { kind: "all" } | { kind: "chapter"; chapterIndex: number };

/**
 * Move or remove existing pictures. No subject and no generation — the proposal
 * path resolves `targets` against the live book the same way a replacement
 * resolves its one target. Destination is required for a move; a missing one is
 * the one allowed question, and a spent budget defaults to the end of the book.
 */
export type ImageLayoutEdit = {
  action: "move" | "remove";
  /** Source-page hint from the router; the proposal path resolves the pictures. */
  pageIndex?: number;
  /**
   * Absent means the one picture the router pointed at. Set only by a remove:
   * "all the pictures", or "the pictures in chapter 2". The card names the count
   * it resolved to, so the reader confirms the scope and not just the verb.
   */
  selection?: ImageLayoutSelection;
  destPlacement?: "end_of_book" | "page";
  destPageIndex?: number;
  /**
   * Where on the destination page the picture lands, when the request named a
   * place inside a page rather than a page. Absent keeps whatever form the
   * picture already has.
   *
   * Positioning is markdown-only, and that is forced by two things the compile
   * decides: `compileBookMarkdown` prints a page's `ImageAsset` hero above the
   * prose *always*, and a chat-added picture has no `ImageAsset` row at all —
   * it is only a markdown line. So `bottom` demotes a hero to an inline line,
   * `top` for a hero is already true, and an inline line simply moves within
   * the page's own markdown. There is no row to promote an inline line into.
   */
  destPosition?: "top" | "bottom";
  /**
   * Every picture this edit resolved to, in reading order — one entry for a
   * move. Empty until the proposal path fills it: the router raises the request
   * but cannot know which pictures the book actually has.
   */
  targets?: ImageLayoutTarget[];
};

/** The intent a recognised image request routes to. Proposal-gated and priced as one image. */
function imageInsertionIntent(
  edit: ImageInsertionEdit,
  decision: { confidence: number; reasoning: string; assistantMessage: string }
): BookEditIntent {
  return {
    kind: "add_image",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: edit.placement === "page" && edit.pageIndex ? [edit.pageIndex] : [],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "small_text",
    clarification: "none",
    imageEdit: edit
  };
}

/**
 * The subject's own words must not become a placement ("an illustration of
 * the diagram from page 4" names no target page), so the model-reported
 * subject is excised before the message is read for one.
 */
function withoutSubjectText(message: string, subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) {
    return message;
  }
  const index = message.toLowerCase().indexOf(trimmed.toLowerCase());
  return index === -1 ? message : `${message.slice(0, index)} ${message.slice(index + trimmed.length)}`;
}

/** What the router's insert_image decision maps to. Placement never clarifies; only a missing subject may. */
export function imageInsertionIntentFromDecision(
  decision: {
    confidence: number;
    reasoning: string;
    assistantMessage: string;
    imageSubject?: string | null | undefined;
    imagePlacement?: "end_of_book" | "page" | null | undefined;
    imageReplace?: boolean | null | undefined;
    pageIndexes?: number[] | undefined;
  },
  message: string,
  context: { clarifyExhausted?: boolean | undefined; pageNumbering?: ReaderPageNumbering | undefined } = {}
): BookEditIntent {
  const subject = decision.imageSubject?.trim() ?? "";
  if (!subject && !context.clarifyExhausted) {
    // The one legitimate clarifying question here: a picture of nothing cannot
    // be drawn. Recorded as a "scope" clarification because that is what makes
    // the route store the resumable pendingEdit for the merged retry.
    return {
      kind: "clarify",
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      affectedPageIndexes: [],
      assistantMessage:
        "What should the new picture show? If you’d rather leave it to me, say “go ahead” and I’ll illustrate a scene from this book.",
      scope: "none",
      impact: "small_text",
      clarification: "scope"
    };
  }
  const explicitPage = decision.pageIndexes?.find((index) => Number.isInteger(index) && index > 0);
  // `pageIndexes` wins over everything: it is the router's one
  // language-independent placement channel. The message helper now reads the
  // same page-words ("در صفحه ۵") as a backstop when that channel is empty.
  const edit: ImageInsertionEdit = {
    // The budget is spent and the subject is still missing: a deterministic
    // generic stands in — never the raw message, which reads as prose in an
    // image prompt.
    subject: subject || "a scene from this book",
    // A replacement request, not yet a target: the proposal path resolves it
    // against the live book (and answers, rather than proposing, when there
    // is no illustration to replace).
    ...(decision.imageReplace ? { replace: { operationId: "" } } : {}),
    ...(explicitPage
      ? { placement: "page" as const, pageIndex: explicitPage }
      : decision.imagePlacement === "end_of_book"
        ? { placement: "end_of_book" as const }
        : decision.imagePlacement === "page"
          ? // "page" names no page by itself — pageIndexes is the router's page
            // channel, and it was empty here — so it is treated as no placement
            // rather than a guess. The enum member stays in the decide schema
            // because model replies emit it.
            {}
          : // Field backstop, not a classifier: fills a placement the model
            // omitted after it already chose insert_image.
            (imagePlacementFromMessage(withoutSubjectText(message, subject), {
              pdfPageMap: context.pageNumbering?.pdfPageMap
            }) ?? {}))
  };
  return imageInsertionIntent(edit, decision);
}

function positivePageIndexes(indexes: number[] | null | undefined): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const index of indexes ?? []) {
    if (!Number.isInteger(index) || index <= 0 || seen.has(index)) {
      continue;
    }
    seen.add(index);
    ordered.push(index);
  }
  return ordered;
}

function layoutIntent(
  edit: ImageLayoutEdit,
  decision: { confidence: number; reasoning: string; assistantMessage: string }
): BookEditIntent {
  const affected = [
    ...(edit.pageIndex ? [edit.pageIndex] : []),
    ...(edit.destPlacement === "page" && edit.destPageIndex ? [edit.destPageIndex] : [])
  ];
  return {
    kind: edit.action === "move" ? "move_image" : "remove_image",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [...new Set(affected)],
    assistantMessage: decision.assistantMessage,
    scope: "none",
    impact: "small_text",
    clarification: "none",
    imageLayout: edit
  };
}

/**
 * Which pictures a remove covers. A `chapter` whose index cannot be resolved
 * degrades to the single-picture default rather than to `all`: under-doing is
 * one more sentence away, over-doing needs an undo.
 */
function layoutSelectionFromDecision(
  decision: { imageSelection?: "one" | "chapter" | "all" | null | undefined; chapterIndex?: number | null | undefined },
  message: string
): ImageLayoutSelection | undefined {
  if (decision.imageSelection === "all") {
    return { kind: "all" };
  }
  if (decision.imageSelection === "chapter") {
    const chapterIndex = decision.chapterIndex;
    return typeof chapterIndex === "number" && Number.isInteger(chapterIndex) && chapterIndex > 0
      ? { kind: "chapter", chapterIndex }
      : undefined;
  }
  return bulkImageSelectionFromMessage(message) ? { kind: "all" } : undefined;
}

/**
 * What the router's move_image / remove_image decision maps to. Remove never
 * clarifies. Move clarifies only when no destination was named — and a place
 * *inside* a page is a complete destination, so it must be read before the
 * question is even considered; a spent budget then defaults to the end of the
 * book rather than a whole-book rewrite.
 */
export function imageLayoutIntentFromDecision(
  action: "move" | "remove",
  decision: {
    confidence: number;
    reasoning: string;
    assistantMessage: string;
    imagePlacement?: "end_of_book" | "page" | null | undefined;
    pageIndexes?: number[] | undefined;
    imageDestPageIndexes?: number[] | null | undefined;
    imageSelection?: "one" | "chapter" | "all" | null | undefined;
    imagePosition?: "top" | "bottom" | null | undefined;
    chapterIndex?: number | null | undefined;
  },
  message: string,
  context: { clarifyExhausted?: boolean | undefined; pageNumbering?: ReaderPageNumbering | undefined } = {}
): BookEditIntent {
  const named = positivePageIndexes(decision.pageIndexes);
  const destNamed = positivePageIndexes(decision.imageDestPageIndexes);
  const sourcePage = named[0];
  const destFromChannel = destNamed[0] ?? (named.length >= 2 ? named[1] : undefined);

  if (action === "remove") {
    const selection = layoutSelectionFromDecision(decision, message);
    return layoutIntent(
      {
        action,
        ...(sourcePage !== undefined ? { pageIndex: sourcePage } : {}),
        ...(selection ? { selection } : {})
      },
      decision
    );
  }

  let destPlacement: "end_of_book" | "page" | undefined;
  let destPageIndex: number | undefined;
  // Read before anything else: "at the bottom of the last page" names a
  // position on a page the reader pointed at, and the end-of-book reader below
  // would otherwise claim it and move the picture somewhere else entirely.
  const destPosition = decision.imagePosition ?? imagePositionFromMessage(message) ?? undefined;
  if (destFromChannel !== undefined) {
    destPlacement = "page";
    destPageIndex = destFromChannel;
  } else if (destPosition) {
    // A place inside a page, with no page named: the picture stays where it is
    // and only its position changes. The proposal path fills the page in from
    // whichever picture it resolves when the router named none.
    destPlacement = "page";
    destPageIndex = sourcePage;
  } else if (decision.imagePlacement === "end_of_book") {
    destPlacement = "end_of_book";
  } else if (sourcePage === undefined) {
    const fromMessage = imagePlacementFromMessage(message, { pdfPageMap: context.pageNumbering?.pdfPageMap });
    if (fromMessage?.placement === "page") {
      destPlacement = "page";
      destPageIndex = fromMessage.pageIndex;
    } else if (fromMessage?.placement === "end_of_book") {
      destPlacement = "end_of_book";
    }
  } else if (endOfBookPlacementFromMessage(message)) {
    destPlacement = "end_of_book";
  }

  if (!destPlacement) {
    if (!context.clarifyExhausted) {
      return {
        kind: "clarify",
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        affectedPageIndexes: sourcePage !== undefined ? [sourcePage] : [],
        assistantMessage:
          "Which page should I move the picture to? If you’d rather leave it to me, say “go ahead” and I’ll put it at the end of the book.",
        scope: "none",
        impact: "small_text",
        clarification: "scope"
      };
    }
    destPlacement = "end_of_book";
  }

  return layoutIntent(
    {
      action: "move",
      ...(sourcePage !== undefined ? { pageIndex: sourcePage } : {}),
      destPlacement,
      ...(destPlacement === "page" && destPageIndex !== undefined ? { destPageIndex } : {}),
      ...(destPosition ? { destPosition } : {})
    },
    decision
  );
}

/**
 * Resolves where the image actually goes, against the live pages. Shared by
 * the proposal and queue paths so the card and the charge agree.
 *
 * An explicit page that vanished returns null and is the caller's call: the
 * proposal path falls back to the default, the queue path re-proposes a fresh
 * card rather than inserting somewhere the user never named.
 */
export function resolveImageInsertionTarget(
  edit: Pick<ImageInsertionEdit, "subject" | "placement" | "pageIndex">,
  pages: BookEditPageContext[]
): { targetPageIndex: number; placement: "end_of_book" | "page" } | null {
  if (pages.length === 0) {
    return null;
  }
  const lastPageIndex = Math.max(...pages.map((page) => page.index));
  if (edit.placement === "page" && edit.pageIndex !== undefined) {
    return pages.some((page) => page.index === edit.pageIndex)
      ? { targetPageIndex: edit.pageIndex, placement: "page" }
      : null;
  }
  if (edit.placement === "end_of_book") {
    return { targetPageIndex: lastPageIndex, placement: "end_of_book" };
  }
  // No placement named. Exactly one page mentioning the subject reads as "the
  // page about X"; zero or several means the end of the book.
  const matches = pageIndexesMatchingSubject(edit.subject, pages);
  return matches.length === 1
    ? { targetPageIndex: matches[0]!, placement: "page" }
    : { targetPageIndex: lastPageIndex, placement: "end_of_book" };
}

/** Resolves a move destination against the live pages. A vanished explicit page returns null. */
export function resolveImageLayoutDest(
  edit: Pick<ImageLayoutEdit, "destPlacement" | "destPageIndex" | "destPosition">,
  pages: BookEditPageContext[],
  /**
   * Where the picture is now. A within-page move names a position and no page,
   * so the destination is the picture's own page — which only the resolution
   * pass knows, because the router may have named no page at all.
   */
  sourcePageIndex?: number
): { destPageIndex: number; destPlacement: "end_of_book" | "page" } | null {
  if (pages.length === 0) {
    return null;
  }
  const lastPageIndex = Math.max(...pages.map((page) => page.index));
  const named = edit.destPageIndex ?? (edit.destPosition ? sourcePageIndex : undefined);
  if (edit.destPlacement === "page" && named !== undefined) {
    return pages.some((page) => page.index === named)
      ? { destPageIndex: named, destPlacement: "page" }
      : null;
  }
  if (edit.destPlacement === "end_of_book") {
    return { destPageIndex: lastPageIndex, destPlacement: "end_of_book" };
  }
  return { destPageIndex: lastPageIndex, destPlacement: "end_of_book" };
}

/** Summaries stay one line; a long subject is capped rather than wrapped. */
export function clippedImageSubject(subject: string): string {
  const clean = subject.trim().replace(/\s+/g, " ");
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
}

/** The one picture a move edit is about, or the first of a remove's set. */
function firstLayoutTarget(layout: ImageLayoutEdit | null | undefined): ImageLayoutTarget | undefined {
  return layout?.targets?.[0];
}

/**
 * Where a moved picture lands, as a phrase. A position with a page is the
 * within-page case ("the bottom of page 4"); a position alone still reads as a
 * place rather than a page, because the reader named one.
 */
function layoutDestPhrase(
  layout: ImageLayoutEdit | null | undefined,
  fallbackPage: number | undefined,
  numbering: ReaderPageNumbering
): string {
  if (layout?.destPlacement === "end_of_book") {
    return "the end of the book";
  }
  const page = layout?.destPageIndex ?? fallbackPage;
  const shown = page === undefined ? undefined : numbering.displayPage(page);
  const position = layout?.destPosition;
  if (position) {
    return shown === undefined ? `the ${position} of the page` : `the ${position} of page ${shown}`;
  }
  return shown === undefined ? "the end of the book" : `page ${shown}`;
}

export function imageLayoutProposalSummary(
  kind: "move_image" | "remove_image",
  affectedPageIndexes: number[],
  layout: ImageLayoutEdit | null | undefined,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING
): string {
  const target = firstLayoutTarget(layout);
  if (kind === "remove_image") {
    // The count is the whole confirmation for a bulk remove: "remove all the
    // pictures" is one tap away from emptying an illustrated book, so the card
    // has to say how many rather than just the verb.
    const count = layout?.targets?.length ?? 0;
    const selection = layout?.selection;
    if (selection?.kind === "chapter") {
      return count === 1
        ? `Remove the illustration in chapter ${selection.chapterIndex}`
        : `Remove the ${count} illustrations in chapter ${selection.chapterIndex}`;
    }
    if (selection?.kind === "all") {
      return count === 1
        ? "Remove the only illustration in this book"
        : `Remove all ${count} illustrations`;
    }
    const named = target?.oldSubject;
    const page = target?.pageIndex ?? affectedPageIndexes[0];
    const shown = page === undefined ? undefined : numbering.displayPage(page);
    if (named && shown !== undefined) {
      return `Remove the illustration of “${clippedImageSubject(named)}” from page ${shown}`;
    }
    return shown !== undefined ? `Remove the illustration on page ${shown}` : "Remove the latest illustration";
  }
  const named = target?.oldSubject;
  const fromPage = target?.pageIndex;
  const dest = layoutDestPhrase(layout, affectedPageIndexes.at(-1), numbering);
  // A within-page move has one page on both sides, so naming it twice ("from
  // page 4 to the bottom of page 4") reads as a mistake rather than a move.
  const samePage = layout?.destPosition !== undefined && layout?.destPageIndex === fromPage;
  if (samePage) {
    return named ? `Move the illustration of “${clippedImageSubject(named)}” to ${dest}` : `Move the illustration to ${dest}`;
  }
  if (named && fromPage !== undefined) {
    return `Move the illustration of “${clippedImageSubject(named)}” from page ${numbering.displayPage(fromPage)} to ${dest}`;
  }
  if (fromPage !== undefined) {
    return `Move the illustration on page ${numbering.displayPage(fromPage)} to ${dest}`;
  }
  return `Move the illustration to ${dest}`;
}

export function imageLayoutQueuedMessage(
  kind: "move_image" | "remove_image",
  affectedPageIndexes: number[],
  layout: ImageLayoutEdit | null | undefined,
  numbering: ReaderPageNumbering = MODEL_PAGE_NUMBERING
): string {
  if (kind === "remove_image") {
    const count = layout?.targets?.length ?? 0;
    const selection = layout?.selection;
    if (selection?.kind === "chapter" && count > 1) {
      return `I’ll remove the ${count} illustrations in chapter ${selection.chapterIndex} and refresh the exports.`;
    }
    if (selection?.kind === "all" && count > 1) {
      return `I’ll remove all ${count} illustrations and refresh the exports.`;
    }
    const page = affectedPageIndexes[0];
    return page === undefined
      ? "I’ll remove that illustration and refresh the exports."
      : `I’ll remove the illustration on page ${numbering.displayPage(page)} and refresh the exports.`;
  }
  return `I’ll move that illustration to ${layoutDestPhrase(layout, affectedPageIndexes.at(-1), numbering)} and refresh the exports.`;
}
