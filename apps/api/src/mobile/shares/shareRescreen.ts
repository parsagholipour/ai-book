import type { AppConfig, GenerationTextModelRouting } from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { objectStore } from "@book-maker/storage";
import { liveRoutingLoader } from "../../generationTextModelRouting.js";
import { recordInlineDecisionAttempt } from "../../inlineDecisionUsage.js";
import type { UserTextModerationDeps } from "../../userTextModeration.js";
import { readSharedBookText, screenSharedBook, type SharedBookVerdict } from "./shareBook.js";
import { SHARE_TEXT_OFFLINE_REASON } from "./shareCopy.js";
import { sharePreviewPrefix } from "./sharePreviewPdf.js";
import { bookShareSelect, type BookShareRecord } from "./shareRecords.js";

/**
 * Screening a live share again after its book changed.
 *
 * A share used to be screened only when it was created or changed mode, while
 * `/s/<slug>/book.pdf` always serves the book's *current* compile — so an Edit
 * Mode save, a chat edit, an undo, a matter edit, a Studio publish or a
 * takeover put text in front of strangers that no screen had read (launch
 * review 2026-10-15, C2). Every screen now stamps the `contentRevision` it read
 * the text at (`BookShare.screenedContentRevision`), the public routes serve a
 * share only while that stamp is the book's current revision
 * (`shareServesCurrentText`), and this module brings a share whose book moved
 * back: the same two screens the create path runs (`screenSharedBook`), over
 * one snapshot of the text and its revision (`readSharedBookText`), with the
 * same three answers —
 *
 * - **passed**: the new revision is stamped and the share serves again;
 * - **refused**: the link is turned off — `REVOKED`, never `TAKEN_DOWN`, with
 *   `SHARE_TEXT_OFFLINE_REASON` for the author to read as the share's
 *   `stoppedReason` — its cached preview slices are cleared and nothing is
 *   written anywhere public. It is the create path's 422 arriving later, not an
 *   operator's verdict: the refused text was never served (the share was
 *   already "being updated"), and the model screen's wording is unmeasured, so
 *   a false positive must not lock sharing for good. The author edits and
 *   shares again, and that PUT runs the full create-time screen;
 * - **held** (the model screen had no verdict on part of the text): stamped and
 *   live, with a system `book_text_review` report for an operator, as at
 *   create — but at most one pending at a time per share, because an author who
 *   edits a held book would otherwise file one per edit.
 *
 * Two doors ask for it. The background sweep (`server.ts`, every few minutes)
 * re-screens a bounded batch of ACTIVE shares whose book moved, one after
 * another. A public request for a stale share asks too, so a share people are
 * actually opening comes back without waiting for the sweep — and **public
 * traffic cannot buy model spend with that**: it starts at most one screen per
 * share per revision in this process, never a second while one runs for the
 * share, and at most `PUBLIC_RESCREEN_CONCURRENCY` across every share; what it
 * declines the sweep reaches. The model screen's own verdict cache (by text
 * hash, `contentSafetyScreen.ts`) means the windows an edit did not touch are
 * not paid for again either.
 *
 * The outcome is applied under the project's row lock and then the share's, in
 * the order a project delete takes them: a book that moved again while it was
 * being read is `superseded` (the next screen reads the newer text), and a
 * share revoked, taken down or already stamped at this revision or later is
 * left as it is. An operator's `TAKEN_DOWN` stays permanent; nothing here
 * writes it.
 */

/** A re-screen holds no request open, so it may read a long book whole before it holds part of it unread. */
export const SHARE_RESCREEN_BUDGET_MS = 60_000;
/** Shares one sweep pass re-screens, one after another. */
export const SHARE_RESCREEN_SWEEP_LIMIT = 10;
export const SHARE_RESCREEN_SWEEP_INTERVAL_MS = 2 * 60_000;
/** Re-screens public requests may have running at once, across every share. */
export const PUBLIC_RESCREEN_CONCURRENCY = 2;
/** (share, revision) pairs public requests have already asked about; the oldest are forgotten first. */
const PUBLIC_RESCREEN_MEMORY = 10_000;

export type ShareRescreenOutcome =
  | "passed"
  | "held"
  /** Refused: the link is off (REVOKED, with the system's reason) until the author shares again. */
  | "turned_off"
  /** The book moved again while its text was being read: nothing applied, the next screen reads the newer text. */
  | "superseded"
  /** Nothing to do: the share or book is gone, the share is not live, or it is already screened at this revision. */
  | "unchanged";

type RescreenLog = {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
};

export type ShareRescreenDeps = {
  /** The model screen's deps, built per share so its cost rows name the author and the book. */
  moderation: (share: Pick<BookShareRecord, "projectId" | "userId">) => UserTextModerationDeps;
  log?: RescreenLog;
  budgetMs?: number;
};

export type ShareRescreenSweep = {
  checked: number;
  passed: number;
  held: number;
  turnedOff: number;
  superseded: number;
  failed: number;
};

export type ShareRescreener = {
  /** Re-screens one share now, joining a screen already running for it. */
  rescreen(shareId: string): Promise<ShareRescreenOutcome>;
  /**
   * A stranger reached a stale share: start a screen in the background unless
   * this share was already asked about at this revision, one is running for
   * it, or public requests already have their quota running. Never waits.
   */
  requestFromPublic(share: Pick<BookShareRecord, "id">, project: { contentRevision: number }): void;
  /** One sweep pass over at most `limit` stale ACTIVE shares. */
  sweep(limit?: number): Promise<ShareRescreenSweep>;
};

const consoleLog: RescreenLog = {
  info: () => {},
  warn: (details, message) => console.warn(message, details)
};

export function createShareRescreener(deps: ShareRescreenDeps): ShareRescreener {
  const log = deps.log ?? consoleLog;
  const inFlight = new Map<string, Promise<ShareRescreenOutcome>>();
  const asked = new Set<string>();
  let publicRunning = 0;

  const rescreen = (shareId: string): Promise<ShareRescreenOutcome> => {
    const running = inFlight.get(shareId);
    if (running) {
      return running;
    }
    const run = rescreenOnce(shareId, deps, log).finally(() => inFlight.delete(shareId));
    inFlight.set(shareId, run);
    return run;
  };

  return {
    rescreen,
    requestFromPublic(share, project) {
      const key = `${share.id}:${project.contentRevision}`;
      if (asked.has(key) || inFlight.has(share.id) || publicRunning >= PUBLIC_RESCREEN_CONCURRENCY) {
        return;
      }
      asked.add(key);
      while (asked.size > PUBLIC_RESCREEN_MEMORY) {
        const oldest = asked.values().next().value;
        if (oldest === undefined) break;
        asked.delete(oldest);
      }
      publicRunning += 1;
      void rescreen(share.id)
        .catch((error: unknown) =>
          log.warn({ event: "share.rescreen_failed", shareId: share.id, err: errorSummary(error) }, "Share re-screen failed")
        )
        .finally(() => {
          publicRunning -= 1;
        });
    },
    async sweep(limit = SHARE_RESCREEN_SWEEP_LIMIT) {
      const ids = await staleShareIds(limit);
      const swept: ShareRescreenSweep = { checked: ids.length, passed: 0, held: 0, turnedOff: 0, superseded: 0, failed: 0 };
      for (const id of ids) {
        try {
          const outcome = await rescreen(id);
          if (outcome === "passed") swept.passed += 1;
          else if (outcome === "held") swept.held += 1;
          else if (outcome === "turned_off") swept.turnedOff += 1;
          else if (outcome === "superseded") swept.superseded += 1;
        } catch (error) {
          // One share's failure is not the batch's: the next pass asks again.
          swept.failed += 1;
          log.warn({ event: "share.rescreen_failed", shareId: id, err: errorSummary(error) }, "Share re-screen failed");
        }
      }
      return swept;
    }
  };
}

/**
 * The model screen's deps for the live process: the Quality tab's routing, read
 * on first use, and one cost row per attempt charged to the share's author.
 */
export function liveShareRescreenModeration(config: AppConfig): ShareRescreenDeps["moderation"] {
  let loader: (() => Promise<GenerationTextModelRouting>) | undefined;
  const loadRouting = () => (loader ??= liveRoutingLoader(config))();
  return (share) => ({
    config,
    loadRouting,
    recordAttempt: (attempt) => recordInlineDecisionAttempt(attempt, { projectId: share.projectId, userId: share.userId })
  });
}

/**
 * ACTIVE shares whose book has moved past their stamp, or that were never
 * stamped, oldest share first — the `(status, createdAt)` index's order.
 */
async function staleShareIds(limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s."id" FROM "BookShare" s
    JOIN "Project" p ON p."id" = s."projectId"
    WHERE s."status" = 'ACTIVE'
      AND (s."screenedContentRevision" IS NULL OR s."screenedContentRevision" <> p."contentRevision")
    ORDER BY s."createdAt" ASC, s."id" ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

async function rescreenOnce(shareId: string, deps: ShareRescreenDeps, log: RescreenLog): Promise<ShareRescreenOutcome> {
  const share = (await prisma.bookShare.findUnique({ where: { id: shareId }, select: bookShareSelect })) as BookShareRecord | null;
  if (!share || share.status !== "ACTIVE") {
    return "unchanged";
  }
  const text = await readSharedBookText(share.projectId);
  if (!text || share.screenedContentRevision === text.contentRevision) {
    return "unchanged";
  }
  const verdict = await screenSharedBook(text, deps.moderation(share), log, {
    budgetMs: deps.budgetMs ?? SHARE_RESCREEN_BUDGET_MS
  });
  const outcome = await settleRescreen(share, verdict, text.title);
  log.info(
    {
      event: "share.rescreened",
      shareId: share.id,
      projectId: share.projectId,
      contentRevision: verdict.contentRevision,
      outcome,
      ...(verdict.verdict === "refused" ? { reason: verdict.refusal.reason } : {})
    },
    "Shared book re-screened"
  );
  if (outcome === "turned_off") {
    await objectStore()
      .deletePrefix(sharePreviewPrefix(share.projectId))
      .catch((error: unknown) => log.warn({ event: "share.preview_cleanup_failed", shareId: share.id, err: errorSummary(error) }, "share preview cleanup failed"));
  }
  return outcome;
}

async function settleRescreen(share: BookShareRecord, verdict: SharedBookVerdict, title: string): Promise<ShareRescreenOutcome> {
  return prisma.$transaction(async (tx) => {
    // The project first, then the share — a project delete's order, since the
    // share cascades from it. FOR SHARE holds the revision still until commit,
    // so a link is turned off for the text it read and no other.
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${share.projectId} FOR SHARE`;
    const project = await tx.project.findUnique({ where: { id: share.projectId }, select: { contentRevision: true } });
    if (!project) {
      return "unchanged";
    }
    if (project.contentRevision !== verdict.contentRevision) {
      return "superseded";
    }
    // The share write's own lock statement (`writeShare`), so a concurrent
    // re-share, revoke or operator take-down is ordered against this one.
    await tx.$queryRaw`SELECT "id" FROM "BookShare" WHERE "projectId" = ${share.projectId} FOR UPDATE`;
    const live = (await tx.bookShare.findUnique({
      where: { projectId: share.projectId },
      select: bookShareSelect
    })) as BookShareRecord | null;
    if (!live || live.id !== share.id || live.status !== "ACTIVE") {
      return "unchanged";
    }
    if (live.screenedContentRevision !== null && live.screenedContentRevision >= verdict.contentRevision) {
      return "unchanged";
    }
    if (verdict.verdict === "refused") {
      // REVOKED, so the author can share again (a new PUT, the full create-time
      // screen, a new slug); the reason rides the column every return to
      // ACTIVE clears. An operator's TAKEN_DOWN is the permanent state, and
      // this never writes it.
      await tx.bookShare.update({
        where: { id: live.id },
        data: { status: "REVOKED", takedownReason: SHARE_TEXT_OFFLINE_REASON }
      });
      return "turned_off";
    }
    await tx.bookShare.update({ where: { id: live.id }, data: { screenedContentRevision: verdict.contentRevision } });
    if (verdict.verdict === "allowed") {
      return "passed";
    }
    const pending = await tx.moderationReport.findMany({
      where: {
        bookShareId: live.id,
        status: "PENDING",
        reporterUserId: null,
        targetSnapshot: { path: ["kind"], equals: "book_text_review" }
      },
      select: { id: true },
      take: 1
    });
    if (pending.length === 0) {
      await tx.moderationReport.create({
        data: {
          reporterUserId: null,
          projectId: live.projectId,
          bookShareId: live.id,
          targetType: "BOOK_SHARE",
          reason: "OTHER",
          comment: null,
          targetSnapshot: {
            kind: "book_text_review",
            slug: live.slug,
            title,
            mode: live.mode,
            contentRevision: verdict.contentRevision,
            verdict: verdict.review
          } as Prisma.InputJsonValue
        }
      });
    }
    return "held";
  });
}

function errorSummary(error: unknown): Record<string, unknown> | string {
  return error instanceof Error ? { name: error.name, message: error.message } : String(error);
}
