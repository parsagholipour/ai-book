import { type BookEditIntent, type BookEditPageContext } from "./bookEditIntent.js";
import {
  endOfBookPlacementFromMessage,
  imagePlacementFromMessage,
  pageIndexesMatchingSubject
} from "./bookEditMessage.js";

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

/**
 * Move or remove an existing picture. No subject and no generation — the
 * proposal path resolves `target` against the live book the same way a
 * replacement does. Destination is required for a move; a missing one is the
 * one allowed question, and a spent budget defaults to the end of the book.
 */
export type ImageLayoutEdit = {
  action: "move" | "remove";
  /** Source-page hint from the router; the proposal path resolves the picture. */
  pageIndex?: number;
  destPlacement?: "end_of_book" | "page";
  destPageIndex?: number;
  target?: {
    operationId: string;
    assetId?: string;
    marker?: string;
    oldSubject?: string;
    pageIndex: number;
  };
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
  context: { clarifyExhausted?: boolean | undefined } = {}
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
  // language-independent placement channel, which is what makes
  // "در صفحه ۵ یک عکس اضافه کن" work — the English helper below sees nothing
  // in Persian text.
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
            (imagePlacementFromMessage(withoutSubjectText(message, subject)) ?? {}))
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
 * What the router's move_image / remove_image decision maps to. Remove never
 * clarifies. Move clarifies only when no destination was named; a spent
 * budget defaults to the end of the book rather than a whole-book rewrite.
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
  },
  message: string,
  context: { clarifyExhausted?: boolean | undefined } = {}
): BookEditIntent {
  const named = positivePageIndexes(decision.pageIndexes);
  const destNamed = positivePageIndexes(decision.imageDestPageIndexes);
  const sourcePage = named[0];
  const destFromChannel = destNamed[0] ?? (named.length >= 2 ? named[1] : undefined);

  if (action === "remove") {
    return layoutIntent({ action, ...(sourcePage !== undefined ? { pageIndex: sourcePage } : {}) }, decision);
  }

  let destPlacement: "end_of_book" | "page" | undefined;
  let destPageIndex: number | undefined;
  if (destFromChannel !== undefined) {
    destPlacement = "page";
    destPageIndex = destFromChannel;
  } else if (decision.imagePlacement === "end_of_book") {
    destPlacement = "end_of_book";
  } else if (sourcePage === undefined) {
    const fromMessage = imagePlacementFromMessage(message);
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
      ...(destPlacement === "page" && destPageIndex !== undefined ? { destPageIndex } : {})
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
  edit: Pick<ImageLayoutEdit, "destPlacement" | "destPageIndex">,
  pages: BookEditPageContext[]
): { destPageIndex: number; destPlacement: "end_of_book" | "page" } | null {
  if (pages.length === 0) {
    return null;
  }
  const lastPageIndex = Math.max(...pages.map((page) => page.index));
  if (edit.destPlacement === "page" && edit.destPageIndex !== undefined) {
    return pages.some((page) => page.index === edit.destPageIndex)
      ? { destPageIndex: edit.destPageIndex, destPlacement: "page" }
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

export function imageLayoutProposalSummary(
  kind: "move_image" | "remove_image",
  affectedPageIndexes: number[],
  layout: ImageLayoutEdit | null | undefined
): string {
  if (kind === "remove_image") {
    const named = layout?.target?.oldSubject;
    const page = layout?.target?.pageIndex ?? affectedPageIndexes[0];
    if (named && page !== undefined) {
      return `Remove the illustration of “${clippedImageSubject(named)}” from page ${page}`;
    }
    return page !== undefined ? `Remove the illustration on page ${page}` : "Remove the latest illustration";
  }
  const named = layout?.target?.oldSubject;
  const fromPage = layout?.target?.pageIndex;
  const destEnd = layout?.destPlacement === "end_of_book";
  const toPage = destEnd ? undefined : layout?.destPageIndex ?? affectedPageIndexes.at(-1);
  const dest = destEnd || toPage === undefined ? "the end of the book" : `page ${toPage}`;
  if (named && fromPage !== undefined) {
    return `Move the illustration of “${clippedImageSubject(named)}” from page ${fromPage} to ${dest}`;
  }
  if (fromPage !== undefined) {
    return `Move the illustration on page ${fromPage} to ${dest}`;
  }
  return `Move the illustration to ${dest}`;
}

export function imageLayoutQueuedMessage(
  kind: "move_image" | "remove_image",
  affectedPageIndexes: number[],
  layout: ImageLayoutEdit | null | undefined
): string {
  if (kind === "remove_image") {
    const page = affectedPageIndexes[0];
    return page === undefined
      ? "I’ll remove that illustration and refresh the exports."
      : `I’ll remove the illustration on page ${page} and refresh the exports.`;
  }
  const destEnd = layout?.destPlacement === "end_of_book";
  const dest = destEnd
    ? "the end of the book"
    : `page ${layout?.destPageIndex ?? affectedPageIndexes.at(-1) ?? ""}`.trim();
  return `I’ll move that illustration to ${dest} and refresh the exports.`;
}
