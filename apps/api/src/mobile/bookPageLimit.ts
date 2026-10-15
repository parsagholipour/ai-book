import { maxGeneratedBookPages } from "@book-maker/core";
import { getBookPageLimit } from "@book-maker/db/billing";
import { type FastifyReply } from "fastify";
import { type BookEditIntent } from "../bookEditIntent.js";
import { type MobileProjectChatMessageRecord } from "./dto.js";
import { createAssistantChatMessage } from "./projectChat.js";

/**
 * How long a generated book may be, and every door it is checked at.
 *
 * Two lengths, one rule. A free account may have a book of up to
 * `freeMaxBookPages` pages generated; past that is a plan perk. And *no*
 * account — a plan included — may have one past `paidMaxBookPages` (200, until
 * a long illustrated compile is measured on the production host), which the
 * 600-page ceiling every request schema holds sits above. Neither is a quota:
 * nothing is claimed, so a refusal has nothing to hand back, and the check is
 * simply repeated at each door that would start generating a book that long —
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
 * The two refusals are told apart by their code, because the app answers them
 * differently: `PAGE_LIMIT_EXCEEDED` opens the long-book offer (a plan unlocks
 * it, and the body's numbers fill the sheet in), while `BOOK_LENGTH_UNAVAILABLE`
 * is a sentence and nothing to buy — every shipped app shows an unknown code's
 * message, and none of them sells a plan on it. The ceiling is asked first, so a
 * free account asking for 300 pages is never sold a plan that would refuse it too.
 */

/** The longest book any request schema accepts — every schema's `max(600)`. */
export const MAX_BOOK_PAGES = 600;

export type PageLimitRefusal = {
  /**
   * `free`: past the free tier's limit, and a plan writes it.
   * `ceiling`: past the longest book anyone may have generated right now.
   */
  kind: "free" | "ceiling";
  /** The limit the book is past: the free tier's, or the ceiling. */
  limit: number;
  /** How long the book would have been. */
  requestedPages: number;
  /** The longest book a plan may have generated right now (`paidMaxBookPages`). */
  maxPages: number;
};

/**
 * The refusal for a book of `requestedPages`, or null when this account may
 * have it — at or under the ceiling on any paid plan, or at or under the free
 * limit on the free tier.
 */
export async function pageLimitRefusal(userId: string, requestedPages: number): Promise<PageLimitRefusal | null> {
  if (!Number.isFinite(requestedPages)) {
    return null;
  }
  const ceiling = maxGeneratedBookPages();
  if (requestedPages > ceiling) {
    return { kind: "ceiling", limit: ceiling, requestedPages: Math.floor(requestedPages), maxPages: ceiling };
  }
  const limit = await getBookPageLimit(userId);
  if (limit === null || requestedPages <= limit) {
    return null;
  }
  return { kind: "free", limit, requestedPages: Math.floor(requestedPages), maxPages: ceiling };
}

/** The one sentence each refusal's code owns. */
export function pageLimitMessage(refusal: PageLimitRefusal): string {
  if (refusal.kind === "ceiling") {
    return `Books longer than ${refusal.limit} pages aren't available yet. Choose ${refusal.limit} pages or fewer.`;
  }
  return `Free books go up to ${refusal.limit} pages. Choose a plan to write this ${refusal.requestedPages}-page book — plans go up to ${refusal.maxPages} pages.`;
}

export function pageLimitCode(refusal: PageLimitRefusal): "PAGE_LIMIT_EXCEEDED" | "BOOK_LENGTH_UNAVAILABLE" {
  return refusal.kind === "ceiling" ? "BOOK_LENGTH_UNAVAILABLE" : "PAGE_LIMIT_EXCEEDED";
}

export function sendPageLimitExceeded(reply: FastifyReply, refusal: PageLimitRefusal): FastifyReply {
  return reply.code(403).send({
    error: {
      code: pageLimitCode(refusal),
      message: pageLimitMessage(refusal),
      pageLimit: { limit: refusal.limit, requestedPages: refusal.requestedPages, maxPages: refusal.maxPages }
    }
  });
}

/**
 * The serializer's copy of that body, for a route that documents its 403.
 *
 * fast-json-stringify drops whatever a response schema does not name, and
 * `mobileAuthError` names only `code` and `message` — so a route declaring its
 * 403 with that one would ship the sentence without the numbers the offer is
 * drawn from. The same hazard `insufficientCreditsError` exists for. Both codes
 * share the body, so one schema documents both.
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

/**
 * The chat-metadata twin of the HTTP body's `pageLimit`, which the app's upsell
 * chip reads — so only a refusal a plan lifts carries it. A ceiling refusal
 * carries none: the chip would offer to unlock a length no plan writes.
 */
export function pageLimitMetadata(refusal: PageLimitRefusal): Record<string, unknown> {
  if (refusal.kind === "ceiling") {
    return {};
  }
  return { pageLimit: { limit: refusal.limit, requestedPages: refusal.requestedPages, maxPages: refusal.maxPages } };
}

/**
 * What the chat says instead of a plain proposal when the change would take the
 * book past a limit. Past the free tier's, the card still follows it, priced, so
 * the reader sees exactly what a plan buys them, and its Apply works once they
 * have one; past the ceiling there is nothing to buy and no card follows.
 */
export function pageLimitChatText(refusal: PageLimitRefusal): string {
  if (refusal.kind === "ceiling") {
    return `That would make this a ${refusal.requestedPages}-page book, and books longer than ${refusal.limit} pages aren't available yet. Ask for a smaller change and I’ll make it.`;
  }
  return `That would make this a ${refusal.requestedPages}-page book, and free books go up to ${refusal.limit} pages. Choose a plan to unlock books up to ${refusal.maxPages} pages, then tap Apply and I’ll make the change.`;
}

/**
 * The proposal-time answer to a change past the ceiling: the sentence and no
 * card, because no plan and no Apply could run it. The pending edit is closed,
 * so the next message is a new request rather than an answer to this one.
 */
export async function pageCeilingChatReply(
  projectId: string,
  parentId: string,
  intent: BookEditIntent,
  refusal: PageLimitRefusal
): Promise<MobileProjectChatMessageRecord> {
  return createAssistantChatMessage({
    projectId,
    parentId,
    content: pageLimitChatText(refusal),
    metadata: { intent, charged: false, pendingEditCancelled: true }
  });
}

/**
 * The Apply-time refusal: the reader tapped Apply while still on the free plan.
 * Mirrors `imageLimitChatMessage` — nothing started, nothing was charged, and a
 * fresh proposal pair keeps the edit one Apply away once they upgrade. Past the
 * ceiling (a card quoted before the operator lowered it) there is no pair to
 * keep: the answer is the ceiling reply.
 */
export async function pageLimitChatMessage(
  projectId: string,
  parentId: string,
  intent: BookEditIntent,
  refusal: PageLimitRefusal,
  resume: { pendingEdit: Record<string, unknown>; editProposal?: Record<string, unknown> }
): Promise<MobileProjectChatMessageRecord> {
  if (refusal.kind === "ceiling") {
    return pageCeilingChatReply(projectId, parentId, intent, refusal);
  }
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
