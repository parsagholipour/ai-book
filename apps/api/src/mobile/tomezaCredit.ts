import { bookCarriesTomezaCredit, TOMEZA_CREDIT_HEAD_BYTES, tomezaCreditInManuscriptHead } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { resolvePlanTier } from "@book-maker/db/billing";
import { objectKey, objectStore } from "@book-maker/storage";
import {
  commitCoverChange,
  COVER_CHANGE_SETTLED_STATUSES,
  dispatchCoverJobs,
  ManuscriptCoverRefusal,
  type CommittedCoverChange
} from "./coverChange.js";
import { TOMEZA_CREDIT_CHAT_COPY } from "./tomezaCreditChatCopy.js";

/**
 * Taking the free tier's "Made with Tomeza" line off one book.
 *
 * The credit is never stored: every compile decides it from the owner's plan
 * (`bookMatterForExport`), so a subscriber's next compile drops it on its own.
 * Subscribing deliberately reprints nothing — a whole library re-rendered on
 * one purchase is a burst of compiles for books nobody opened (Parsa,
 * 2026-10-06). A subscriber who wants a finished book without the line asks
 * for it here instead, from the book's "Title & credits" sheet or its chat,
 * and gets a free presentation reprint: the commit a title change makes, with
 * nothing changed but the revision, so the compile it queues reads the plan
 * again and leaves the line out. A free account is told it comes with a plan.
 *
 * Whether there is anything to take off is read from the published
 * `book.md` itself (`bookCarriesTomezaCredit`), not from the plan: a book
 * compiled after the owner subscribed already lacks it, and one compiled before
 * still prints it whatever the plan says now. Only its opening bytes are read
 * (`tomezaCreditInManuscriptHead`), because the sheet asks on every open and
 * the credit sits in the front matter of a file that can run to megabytes.
 */

export type TomezaCreditRemoval =
  /** A free presentation reprint is committed and dispatched, at this revision. */
  | { kind: "reprinted"; contentRevision: number }
  /** The published book does not print the line, so there is nothing to reprint. */
  | { kind: "not_printed" }
  /** A free account: the line comes off with a plan. Nothing was read or written. */
  | { kind: "subscription_required" }
  /** No finished book yet; its first compile reads the plan when it runs. */
  | { kind: "not_finished" }
  /**
   * The book is EDITING. A removal just asked for is one of these windows, but
   * not every one ends in a recompile (an edit can settle without one), so the
   * reader is told only that the book is being updated and to ask again once it
   * is ready if the line is still there — never that the new version drops it.
   */
  | { kind: "refreshing" }
  /** A job or an edit owns a settled book right now (a narration, a queued Apply). */
  | { kind: "busy" };

export const TOMEZA_CREDIT_PLAN_MESSAGE = "Removing the “Made with Tomeza” line comes with any plan.";
export const TOMEZA_CREDIT_BUSY_MESSAGE = "Your book is being worked on right now. Try again once that finishes.";
export const TOMEZA_CREDIT_REFRESHING_MESSAGE =
  "Your book is being updated right now. Once it’s ready, if the “Made with Tomeza” line is still there, tap Remove it again.";
/** The chat's English answer too: one sentence for one state, kept with the chat's table. */
export const TOMEZA_CREDIT_NOT_FINISHED_MESSAGE = TOMEZA_CREDIT_CHAT_COPY.en.not_finished;

/**
 * Whether the book's published manuscript prints the credit: false when there
 * is none, null when the store could not be read (logged, never thrown — the
 * sheet that asks still opens).
 *
 * False while the book is EDITING without reading anything: the published file
 * may be the one being replaced, and a removal just asked for is exactly this
 * window, so the sheet must not offer it a second time. That is "nothing to
 * offer now", not "the next file drops it": not every EDITING window ends in a
 * recompile, and the sheet opened once the book settles reads the file again
 * (a free account's line is what `madeWithCredit` already says).
 */
export async function publishedTomezaCredit(project: { id: string; status: string }): Promise<boolean | null> {
  if (project.status === "EDITING") {
    return false;
  }
  const projectId = project.id;
  try {
    const key = objectKey("books", projectId, "book.md");
    const head = await objectStore().getLeadingBytes(key, TOMEZA_CREDIT_HEAD_BYTES);
    if (!head) return false;
    const settled = tomezaCreditInManuscriptHead(head.bytes.toString("utf8"), head.bytes.length >= head.size);
    if (settled !== undefined) return settled;
    // A front matter longer than the head — a title past any limit — is answered by the whole file.
    const bytes = await objectStore().get(key);
    return bytes ? bookCarriesTomezaCredit(bytes.toString("utf8")) : false;
  } catch (error) {
    console.warn(`Could not read the published manuscript of project ${projectId} for its Tomeza credit`, error);
    return null;
  }
}

/**
 * The one decision the book-matter route and the chat share. `project` is the
 * caller's ownership-checked read; the settled status and the absence of open
 * work are asked again under the project row lock by `commitCoverChange`.
 *
 * The plan is read fresh, never from a limiter's cache, because the answer
 * gates a reprint. An unreadable published file is reprinted anyway: the
 * reader asked, they are entitled, and a reprint is free.
 */
export async function removeTomezaCredit(project: {
  id: string;
  userId: string;
  status: string;
  currentPlanId: string | null;
}): Promise<TomezaCreditRemoval> {
  if ((await resolvePlanTier(project.userId)) === "free") {
    return { kind: "subscription_required" };
  }
  if (project.status === "EDITING") {
    return { kind: "refreshing" };
  }
  if (!COVER_CHANGE_SETTLED_STATUSES.has(project.status) || !project.currentPlanId) {
    return { kind: "not_finished" };
  }
  if ((await publishedTomezaCredit(project)) === false) {
    return { kind: "not_printed" };
  }
  let committed: CommittedCoverChange;
  try {
    // No cover, title or matter change: the revision bump and the
    // presentation compile are the whole edit.
    committed = await prisma.$transaction((tx) => commitCoverChange(tx, project.id, {}));
  } catch (error) {
    if (error instanceof ManuscriptCoverRefusal) {
      // PUBLISH_FIRST: no plan under the lock. BOOK_NOT_READY: the book left
      // its settled status between the read and the lock, which a finished
      // book does only for a rebuild. PROJECT_BUSY: open work on a settled
      // book — a narration, an Apply still queued — which reprints nothing.
      if (error.code === "PUBLISH_FIRST") return { kind: "not_finished" };
      return { kind: error.code === "BOOK_NOT_READY" ? "refreshing" : "busy" };
    }
    throw error;
  }
  await dispatchCoverJobs(project.id, committed);
  return { kind: "reprinted", contentRevision: committed.contentRevision };
}
