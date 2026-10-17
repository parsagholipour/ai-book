import type { FastifyReply } from "fastify";
import { BOOK_WORK_JOB_TYPES, PAYLOAD_LANED_JOB_TYPES, isBookWork, jobLaneClass } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { hasActiveSubscriptionEntitlement } from "@book-maker/db/billing";
import { sendChatPayload } from "./chatStreaming.js";

/**
 * One account's share of the worker's long lane.
 *
 * The long lane (`jobLanes.ts` in core) runs one book at a time in production,
 * and a book is 9–93 minutes. Nothing stopped one account from approving ten
 * plans in a row and holding every other reader's book behind its own for a
 * day. So each door that starts long-lane work — plan approval, a paid retry of
 * a book run, a chat continuation or rebuild, an audiobook, an import — asks
 * how many of this account's books already have long work queued or running,
 * and refuses past the limit: one on a free account, three on any paid plan
 * (`hasActiveSubscriptionEntitlement`, the spend breaker's notion of paid).
 *
 * A chat edit that rewrites a book's worth of pages takes the long lane too
 * (`LONG_LANE_EDIT_PAGE_THRESHOLD`), so its Apply and its paid retry are doors.
 *
 * Where it sits is the rule, the same as the spend breaker's: after auth,
 * validation, any replay of work already paid for and the breaker itself, and
 * before every reservation, free-tier slot claim and write. A refusal costs and
 * claims nothing, and the reader can start the book the moment one finishes.
 *
 * "In progress" is read off the durable `GenerationJob` rows, classified by the
 * same lane map the enqueue sides route by, so a book whose only open job is an
 * edit's re-typeset (interactive) does not count against it, and a book whose
 * pictures or generation compile are still waiting does — those run in the image
 * and compile lanes now, beside the long one, but the book is still being made
 * (`isBookWork`). The book being started is never counted against itself. It is a check, not a lock: two approvals racing in
 * the same instant can both pass it, which costs one extra book in line, never
 * money.
 */

export const FREE_BOOKS_IN_PROGRESS_LIMIT = 1;
export const PAID_BOOKS_IN_PROGRESS_LIMIT = 3;

export type BooksInProgressRefusal = {
  /** How many books this account may have in progress at once. */
  limit: number;
  /** How many it has now. */
  inProgress: number;
};

/** The distinct books (other than `exceptProjectIds`) this account has long-lane work open for. */
export async function longLaneBooksInProgress(userId: string, exceptProjectIds: readonly string[] = []): Promise<Set<string>> {
  const rows = await prisma.generationJob.findMany({
    where: {
      status: { in: ["QUEUED", "ACTIVE"] },
      type: { in: [...BOOK_WORK_JOB_TYPES] },
      project: { userId },
      ...(exceptProjectIds.length > 0 ? { projectId: { notIn: [...exceptProjectIds] } } : {})
    },
    select: { projectId: true, type: true, payload: true }
  });
  const books = new Set<string>();
  for (const row of rows) {
    if (!row.projectId) continue;
    const payload = (PAYLOAD_LANED_JOB_TYPES as readonly string[]).includes(row.type) ? row.payload : null;
    const laneClass = jobLaneClass(row.type, payload);
    if (laneClass && isBookWork(laneClass)) books.add(row.projectId);
  }
  return books;
}

/**
 * The refusal for starting one more book's long work, or null when this
 * account may. A plan that cannot be read counts as paid, as it does for the
 * spend breaker: this protects a queue, and must not become a way to lock a
 * subscriber out.
 */
export async function booksInProgressRefusal(
  userId: string,
  options: { exceptProjectIds?: readonly string[] } = {}
): Promise<BooksInProgressRefusal | null> {
  const books = await longLaneBooksInProgress(userId, options.exceptProjectIds ?? []);
  if (books.size < FREE_BOOKS_IN_PROGRESS_LIMIT) return null;
  const paid = await hasActiveSubscriptionEntitlement(userId).catch((error: unknown) => {
    console.error("Could not read the plan for the books-in-progress limit; counting the account as paid", error);
    return true;
  });
  const limit = paid ? PAID_BOOKS_IN_PROGRESS_LIMIT : FREE_BOOKS_IN_PROGRESS_LIMIT;
  return books.size >= limit ? { limit, inProgress: books.size } : null;
}

/** The one sentence `BOOKS_IN_PROGRESS_LIMIT` owns. */
export function booksInProgressMessage(refusal: BooksInProgressRefusal): string {
  return refusal.limit === 1
    ? "You already have a book being made. You can start this one as soon as it's finished — free accounts make one book at a time."
    : `You already have ${refusal.inProgress} books being made. You can start this one as soon as one of them is finished.`;
}

export function sendBooksInProgressLimit(reply: FastifyReply, refusal: BooksInProgressRefusal): FastifyReply {
  return sendChatPayload(reply, 429, {
    error: {
      code: "BOOKS_IN_PROGRESS_LIMIT",
      message: booksInProgressMessage(refusal),
      booksInProgress: { limit: refusal.limit, inProgress: refusal.inProgress }
    }
  });
}

/** True when the request may go on; otherwise the refusal has been sent. */
export async function requireBooksInProgressCapacity(
  reply: FastifyReply,
  userId: string,
  options: { exceptProjectIds?: readonly string[] } = {}
): Promise<boolean> {
  const refusal = await booksInProgressRefusal(userId, options);
  if (!refusal) return true;
  sendBooksInProgressLimit(reply, refusal);
  return false;
}

/**
 * Whether any of these rows would be book work — the long lane, or a
 * generation's pictures or compile — which the resume door asks before gating:
 * a retry that redraws a book's pictures puts that book back in progress.
 */
export function startsLongLaneWork(jobs: ReadonlyArray<{ type: string; payload: unknown }>): boolean {
  return jobs.some((job) => {
    const laneClass = jobLaneClass(job.type, job.payload);
    return laneClass !== null && isBookWork(laneClass);
  });
}

/** The cards whose Apply writes the text fork's `APPLY_BOOK_EDIT` payload, pages and all. */
const PAGE_TEXT_EDIT_KINDS = new Set(["page_rewrite", "local_patch", "chapter_regenerate"]);

/**
 * Whether applying this chat card starts long-lane work: a continuation drafts
 * new chapters onto the book, a rebuild copies it and regenerates it whole, and
 * a text edit that rewrites more than `LONG_LANE_EDIT_PAGE_THRESHOLD` pages is
 * an `APPLY_BOOK_EDIT` the lane map sends long. The payload does not exist yet,
 * so the card's pages stand in for its `affectedPageIndexes` and a local patch
 * quoted at nothing for its `mode: "exact"` (the Apply's own reading of a free
 * quote: a verified find/replace), and the lane map answers from those — the
 * same rule, not a copy of it. The Apply re-resolves its pages against the book
 * as it is then, so a book that changed under the card can disagree by a page:
 * a check, not a lock, like the rest of this file. Every other card is an
 * interactive-lane edit and is never held to the limit.
 */
export function proposalStartsLongLaneWork(pending: {
  intent?: { kind: string } | null | undefined;
  affectedPageIndexes?: readonly number[] | undefined;
  credits?: number | undefined;
}): boolean {
  const kind = pending.intent?.kind;
  if (kind === "continue_book" || kind === "book_replan") return true;
  if (!kind || !PAGE_TEXT_EDIT_KINDS.has(kind)) return false;
  const exact = kind === "local_patch" && pending.credits === 0;
  return startsLongLaneWork([
    {
      type: "APPLY_BOOK_EDIT",
      payload: { affectedPageIndexes: [...(pending.affectedPageIndexes ?? [])], ...(exact ? { mode: "exact" } : {}) }
    }
  ]);
}

/**
 * The OpenAPI shape of the refusal, for a route that declares its 429:
 * fast-json-stringify drops a field the declared schema does not name.
 */
export const booksInProgressError = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        resetsAt: { type: "string", format: "date-time" },
        booksInProgress: {
          type: "object",
          properties: { limit: { type: "integer" }, inProgress: { type: "integer" } },
          required: ["limit", "inProgress"]
        }
      },
      required: ["code", "message"]
    }
  },
  required: ["error"]
} as const;
