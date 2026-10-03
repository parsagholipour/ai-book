import { getBookPageLimit } from "@book-maker/db/billing";
import { type FastifyReply } from "fastify";
import { type BookEditIntent } from "../bookEditIntent.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { createAssistantChatMessage } from "./projectChat.js";

/**
 * The free tier's book length, and every door it is checked at.
 *
 * A free account may have a book of up to `freeMaxBookPages` pages generated;
 * past that, up to the 600-page ceiling every request schema already holds, is a
 * plan perk. It is a *length* rule, not a quota: nothing is claimed, so a refusal
 * has nothing to hand back, and the check is simply repeated at each door that
 * would start generating a book that long —
 *
 * - the creation Build and the project `/plan` route, before planning is charged;
 * - plan approval and a paid full-book retry, which are what actually write it;
 * - the chat's replan, continuation and page insert, at the proposal (so the
 *   card already says so) and again at Apply (the authoritative one).
 *
 * Only generation is gated. A book the author wrote or imported is theirs at
 * any length, and deleting, moving or rewriting pages of a long book never makes
 * it longer — so a page change is refused only when it *grows* the book past the
 * limit, and a replan whenever the book it would write is past it.
 *
 * The refusal is `PAGE_LIMIT_EXCEEDED` everywhere, with its numbers beside the
 * sentence, because the app answers it with the long-book offer rather than a
 * snackbar: the code picks the sheet, the numbers fill it in.
 */

/** The longest book any plan may have generated — every request schema's `max(600)`. */
export const MAX_BOOK_PAGES = 600;

export type PageLimitRefusal = {
  /** The free tier's page limit. */
  limit: number;
  /** How long the book would have been. */
  requestedPages: number;
};

/**
 * The refusal for a book of `requestedPages`, or null when this account may
 * have it — on any paid plan, or at or under the free limit.
 */
export async function pageLimitRefusal(userId: string, requestedPages: number): Promise<PageLimitRefusal | null> {
  const limit = await getBookPageLimit(userId);
  if (limit === null || !Number.isFinite(requestedPages) || requestedPages <= limit) {
    return null;
  }
  return { limit, requestedPages: Math.floor(requestedPages) };
}

/** The one sentence `PAGE_LIMIT_EXCEEDED` owns. */
export function pageLimitMessage(refusal: PageLimitRefusal): string {
  return `Free books go up to ${refusal.limit} pages. Choose a plan to write this ${refusal.requestedPages}-page book — plans go up to ${MAX_BOOK_PAGES} pages.`;
}

export function sendPageLimitExceeded(reply: FastifyReply, refusal: PageLimitRefusal): FastifyReply {
  return reply.code(403).send({
    error: {
      code: "PAGE_LIMIT_EXCEEDED",
      message: pageLimitMessage(refusal),
      pageLimit: { limit: refusal.limit, requestedPages: refusal.requestedPages, maxPages: MAX_BOOK_PAGES }
    }
  });
}

/**
 * The serializer's copy of that body, for a route that documents its 403.
 *
 * fast-json-stringify drops whatever a response schema does not name, and
 * `mobileAuthError` names only `code` and `message` — so a route declaring its
 * 403 with that one would ship the sentence without the numbers the offer is
 * drawn from. The same hazard `insufficientCreditsError` exists for.
 */
export const pageLimitExceededError = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        pageLimit: {
          type: "object",
          properties: {
            limit: { type: "integer" },
            requestedPages: { type: "integer" },
            maxPages: { type: "integer" }
          },
          required: ["limit", "requestedPages", "maxPages"]
        }
      },
      required: ["code", "message", "pageLimit"]
    }
  },
  required: ["error"]
} as const;

/** The chat-metadata twin of the HTTP body's `pageLimit`, which the app's upsell chip reads. */
export function pageLimitMetadata(refusal: PageLimitRefusal): Record<string, unknown> {
  return { pageLimit: { limit: refusal.limit, requestedPages: refusal.requestedPages, maxPages: MAX_BOOK_PAGES } };
}

/**
 * What the chat says instead of a plain proposal when the change would take the
 * book past the free limit. The card still follows it, priced, so the reader
 * sees exactly what a plan buys them, and its Apply works once they have one.
 */
export function pageLimitChatText(refusal: PageLimitRefusal): string {
  return `That would make this a ${refusal.requestedPages}-page book, and free books go up to ${refusal.limit} pages. Choose a plan to unlock books up to ${MAX_BOOK_PAGES} pages, then tap Apply and I’ll make the change.`;
}

/**
 * The Apply-time refusal: the reader tapped Apply while still on the free plan.
 * Mirrors `imageLimitChatMessage` — nothing started, nothing was charged, and a
 * fresh proposal pair keeps the edit one Apply away once they upgrade.
 */
export async function pageLimitChatMessage(
  projectId: string,
  parentId: string,
  intent: BookEditIntent,
  refusal: PageLimitRefusal,
  resume: { pendingEdit: Record<string, unknown>; editProposal?: Record<string, unknown> }
): Promise<MobileProjectChatMessageRecord> {
  return createAssistantChatMessage({
    projectId,
    parentId,
    content: pageLimitChatText(refusal),
    metadata: { intent, charged: false, ...pageLimitMetadata(refusal), ...resume }
  });
}

/** The book's length once a continuation of `newPages` lands. */
export function continuedBookPages(project: { pages: unknown[] }, newPages: number): number {
  return project.pages.length + Math.max(0, newPages);
}

/** The length a replan copy would be written at. */
export function replannedBookPages(intent: Pick<BookEditIntent, "replanSettings">, project: { targetPages: number }): number {
  return intent.replanSettings?.targetPages ?? project.targetPages;
}

/**
 * A page change is refused only when it makes the book longer *and* past the
 * limit: deleting from or reordering a long book shortens or keeps it, and
 * neither is generating a long book.
 */
export function restructuredBookPages(project: { pages: unknown[] }, totalPages: number): number | null {
  return totalPages > project.pages.length ? totalPages : null;
}
