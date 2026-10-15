import { Prisma, prisma } from "@book-maker/db";
import type { BookTextScreen } from "../../contentSafetyScreen.js";
import type { ModerationAttemptRecord, UserTextModerationResult, UserTextSurface } from "../../userTextModeration.js";
import { generateShareSlug } from "./shareSlug.js";

/**
 * The share row: its select, its wire shape, and the one transaction that
 * writes it. The book text screen and the note's verdict run beforehand;
 * `writeShare` checks takedown status again under the share's row lock, and
 * stamps the revision the text screen read.
 */

export const bookShareSelect = {
  id: true,
  projectId: true,
  userId: true,
  slug: true,
  mode: true,
  previewPages: true,
  caption: true,
  captionStatus: true,
  captionVerdict: true,
  showAuthorName: true,
  rightsConfirmedAt: true,
  likenessConfirmedAt: true,
  status: true,
  takedownReason: true,
  screenedContentRevision: true,
  viewCount: true,
  createdAt: true,
  updatedAt: true
} as const;

export type BookShareMode = "PREVIEW" | "FULL";
export type BookShareCaptionStatus = "NONE" | "ALLOWED" | "PENDING_REVIEW" | "REMOVED";
export type BookShareStatus = "ACTIVE" | "REVOKED" | "TAKEN_DOWN";

export type BookShareRecord = {
  id: string;
  projectId: string;
  userId: string;
  slug: string;
  mode: BookShareMode;
  previewPages: number | null;
  caption: string | null;
  captionStatus: BookShareCaptionStatus;
  captionVerdict: unknown;
  showAuthorName: boolean;
  rightsConfirmedAt: Date;
  likenessConfirmedAt: Date | null;
  status: BookShareStatus;
  takedownReason: string | null;
  /** The book revision whose text the share screens last passed or held; null is never screened. */
  screenedContentRevision: number | null;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Whether a share may show strangers its book now: only the text screened at
 * the book's **current** revision is served. Any edit — Edit Mode, a chat
 * edit, undo and redo, matter, a Studio publish, a takeover — moves
 * `contentRevision` past the stamp, and until the share is screened again
 * (`shareRescreen.ts`) its page reads as being updated, its PDF answers 503 and
 * nothing of the new text, title or cover leaves the server. A legacy row with
 * no stamp is a share that has never been screened at a known revision.
 */
export function shareServesCurrentText(
  share: Pick<BookShareRecord, "screenedContentRevision">,
  project: { contentRevision: number }
): boolean {
  return share.screenedContentRevision !== null && share.screenedContentRevision === project.contentRevision;
}

export type MobileBookShareDto = {
  slug: string;
  url: string;
  mode: "preview" | "full";
  previewPages: number | null;
  caption: string | null;
  captionStatus: "none" | "allowed" | "pending_review" | "removed";
  showAuthorName: boolean;
  /**
   * A live share has the likeness confirmation on record, so an edit need not
   * ask again. A re-share after a revoke always asks again.
   */
  likenessConfirmed: boolean;
  status: "active" | "revoked" | "taken_down";
  /** The operator's sentence, only while the share is taken down. */
  takedownReason: string | null;
  /**
   * Why the system turned a link off, only while the share is revoked: a
   * re-screen refused the book's changed text (`SHARE_TEXT_OFFLINE_REASON`).
   * Null for a share its author stopped. Such a share is shared again like any
   * stopped one — a new PUT, the full create-time screen, a new slug.
   */
  stoppedReason: string | null;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MobileShareBookDto = {
  /** Whether a share can be made or changed right now. */
  shareable: boolean;
  unavailableReason: "not_finished" | "being_updated" | null;
  kind: "generated" | "written";
  /** M in "N of M pages": reading pages, front matter excluded. Null when unknown. */
  readingPages: number | null;
  /** Half the measured reading pages, at least 1; just 1 when unmeasured. */
  maxPreviewPages: number | null;
  likenessRequired: boolean;
  /**
   * Always true: a full share is free, because no book carries an export
   * unlock any more (2026-10-15). Kept for installed builds, which ask for an
   * unlock when it is false.
   */
  exportUnlocked: boolean;
  /** Always 0, for the same installed builds. */
  exportUnlockCredits: number;
};

export type MobileShareStateDto = {
  share: MobileBookShareDto | null;
  book: MobileShareBookDto;
};

export type MobileShareWriteDto = MobileShareStateDto & {
  /** Always false: a share charges nothing. Kept for installed builds. */
  exportUnlockCharged: boolean;
};

export function shareUrl(publicApiUrl: string, slug: string): string {
  return `${publicApiUrl.replace(/\/+$/, "")}/s/${encodeURIComponent(slug)}`;
}

export function serializeBookShare(share: BookShareRecord, publicApiUrl: string): MobileBookShareDto {
  return {
    slug: share.slug,
    url: shareUrl(publicApiUrl, share.slug),
    mode: share.mode === "FULL" ? "full" : "preview",
    previewPages: share.previewPages,
    caption: share.caption,
    captionStatus: share.captionStatus.toLowerCase() as MobileBookShareDto["captionStatus"],
    showAuthorName: share.showAuthorName,
    likenessConfirmed: share.status === "ACTIVE" && share.likenessConfirmedAt !== null,
    status: share.status.toLowerCase() as MobileBookShareDto["status"],
    takedownReason: share.status === "TAKEN_DOWN" ? share.takedownReason : null,
    // The column is the share's one "why it is not live": an operator's reason
    // while taken down, the system's while revoked. Every return to ACTIVE
    // clears it, and an author's own stop never sets it.
    stoppedReason: share.status === "REVOKED" ? share.takedownReason : null,
    viewCount: share.viewCount,
    createdAt: share.createdAt.toISOString(),
    updatedAt: share.updatedAt.toISOString()
  };
}

/**
 * The stored form of a note: line endings unified, control characters other
 * than newlines and tabs dropped, runs of blank lines collapsed, trimmed.
 * Empty is no note.
 */
export function normalizeCaption(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const cleaned = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || null;
}

/** What a caption write stores: the status the page obeys and the gate's record. */
export type CaptionDecision = {
  caption: string | null;
  captionStatus: BookShareCaptionStatus;
  captionVerdict: Prisma.InputJsonValue | typeof Prisma.DbNull;
  /** File a system review, because the gate gave no verdict. */
  fileReview: boolean;
};

/** A share with no note: nothing to show and nothing to review. */
export function noCaptionDecision(): CaptionDecision {
  return { caption: null, captionStatus: "NONE", captionVerdict: Prisma.DbNull, fileReview: false };
}

export function captionDecisionFromModeration(
  caption: string,
  surface: UserTextSurface,
  result: Exclude<UserTextModerationResult, { verdict: "refused" }>
): CaptionDecision {
  const record = verdictRecord(surface, result);
  if (result.verdict === "allowed") {
    return { caption, captionStatus: "ALLOWED", captionVerdict: record, fileReview: false };
  }
  return { caption, captionStatus: "PENDING_REVIEW", captionVerdict: record, fileReview: true };
}

export function verdictRecord(surface: UserTextSurface, result: UserTextModerationResult): Prisma.InputJsonValue {
  return {
    surface,
    verdict: result.verdict,
    ...(result.verdict === "undecided" ? { reason: result.reason } : { decidedBy: result.decidedBy }),
    ...(result.verdict === "refused" ? { violation: result.violation } : {}),
    decidedAt: new Date().toISOString(),
    attempts: result.attempts.map(attemptJson)
  } as Prisma.InputJsonValue;
}

function attemptJson(attempt: ModerationAttemptRecord): Prisma.InputJsonValue {
  return { ...attempt } as Prisma.InputJsonValue;
}

/**
 * What the book-text review records when the sexual-content filter's screen
 * could not decide part of a shared book: how much it read, how much it could
 * not, and why. Filed beside the share as a system report, like a held note.
 */
export function bookTextReview(screen: Extract<BookTextScreen, { verdict: "held" }>): Prisma.InputJsonValue {
  return {
    surface: "book_text",
    verdict: "undecided",
    windows: screen.windows,
    undecidedWindows: screen.undecided,
    unscreenedWindows: screen.unscreened,
    reasons: screen.reasons,
    decidedAt: new Date().toISOString()
  };
}

export type ShareWrite = {
  userId: string;
  projectId: string;
  projectTitle: string;
  mode: BookShareMode;
  previewPages: number | null;
  showAuthorName: boolean;
  caption: CaptionDecision | "unchanged";
  /** File a system review of the book's text: the sexual-content screen left part of it undecided. */
  textReview?: Prisma.InputJsonValue | null;
  /**
   * The book revision this request's text screen read, or null when it ran no
   * screen (the share is live, in the same mode, and already screened at the
   * current revision). A stamp only ever moves forward: a concurrent re-screen
   * may already have screened a later revision, and revisions never go back.
   */
  screenedContentRevision?: number | null;
  confirmRights: boolean;
  confirmLikeness: boolean;
};

const MAX_WRITE_ATTEMPTS = 3;

export class ShareTakenDownError extends Error {
  readonly code = "SHARE_TAKEN_DOWN";

  constructor() {
    super("The share has been taken down.");
    this.name = "ShareTakenDownError";
  }
}

export class SharingDisabledError extends Error {
  readonly code = "SHARING_DISABLED";

  constructor() {
    super("Sharing is turned off for this account.");
    this.name = "SharingDisabledError";
  }
}

type RawReader = { $queryRaw: Prisma.TransactionClient["$queryRaw"] };

/**
 * Whether the account may put a book on a public link or remix one: an
 * operator has neither suspended it nor turned its sharing off
 * (`../../accountModeration.ts`). With `lock`, inside a share write, the read
 * takes the user row `FOR SHARE`: the account action takes it `FOR NO KEY
 * UPDATE`, so the two are ordered and no share goes live across a takedown.
 * One raw statement for both, so the route's early answer and the write's
 * locked one cannot be two different questions. No row is not a refusal — the
 * share's own foreign key answers for a user that is gone.
 */
export async function accountMayShare(client: RawReader, userId: string, options: { lock?: boolean } = {}): Promise<boolean> {
  const rows = options.lock
    ? await client.$queryRaw<Array<{ status: string; sharingDisabledAt: Date | null }>>`
        SELECT "status"::text AS "status", "sharingDisabledAt" FROM "User" WHERE "id" = ${userId} FOR SHARE
      `
    : await client.$queryRaw<Array<{ status: string; sharingDisabledAt: Date | null }>>`
        SELECT "status"::text AS "status", "sharingDisabledAt" FROM "User" WHERE "id" = ${userId}
      `;
  const user = rows[0];
  return !user || (user.status === "ACTIVE" && user.sharingDisabledAt === null);
}

/**
 * Creates, updates, or re-activates a revoked share, in one
 * transaction with the system review a held note — or a book text the
 * sexual-content screen held — needs.
 *
 * A new or re-activated share mints a new slug and records it in `ShareSlug`
 * first; that table's primary key is what makes a slug unrepeatable, so a
 * collision (vanishingly rare) or a concurrent create for the same book is a
 * unique violation that simply retries the whole transaction.
 */
export async function writeShare(write: ShareWrite): Promise<BookShareRecord> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        // The account first, then the share: an operator's account action
        // locks the user row before it takes the account's shares down.
        if (!(await accountMayShare(tx, write.userId, { lock: true }))) {
          throw new SharingDisabledError();
        }
        // The operator's UPDATE in adminShares takes this same row lock, so
        // its takedown either precedes this read or follows our commit.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "BookShare" WHERE "projectId" = ${write.projectId} FOR UPDATE
        `;
        // No row means no lock: do not read a concurrent insert as an existing
        // share we own. Its unique-create conflict retries and locks it instead.
        const existing = locked.length
          ? (await tx.bookShare.findUnique({
              where: { projectId: write.projectId },
              select: bookShareSelect
            })) as BookShareRecord | null
          : null;
        if (existing?.status === "TAKEN_DOWN") {
          throw new ShareTakenDownError();
        }
        const now = new Date();
        const screened = write.screenedContentRevision ?? null;
        const stamp =
          screened === null
            ? {}
            : { screenedContentRevision: Math.max(screened, existing?.screenedContentRevision ?? screened) };
        const captionFields =
          write.caption === "unchanged"
            ? {}
            : {
                caption: write.caption.caption,
                captionStatus: write.caption.captionStatus,
                captionVerdict: write.caption.captionVerdict
              };
        const fields = {
          mode: write.mode,
          previewPages: write.mode === "PREVIEW" ? write.previewPages : null,
          showAuthorName: write.showAuthorName,
          ...captionFields,
          ...stamp,
          ...(write.confirmLikeness ? { likenessConfirmedAt: now } : {})
        };
        let share: BookShareRecord;
        if (!existing) {
          const slug = generateShareSlug();
          await tx.shareSlug.create({ data: { slug } });
          share = (await tx.bookShare.create({
            data: {
              projectId: write.projectId,
              userId: write.userId,
              slug,
              rightsConfirmedAt: now,
              status: "ACTIVE",
              ...fields,
              ...(write.caption === "unchanged" ? { captionStatus: "NONE" } : {})
            },
            select: bookShareSelect
          })) as BookShareRecord;
        } else if (existing.status === "REVOKED") {
          const slug = generateShareSlug();
          await tx.shareSlug.create({ data: { slug } });
          share = (await tx.bookShare.update({
            where: { id: existing.id },
            data: {
              slug,
              status: "ACTIVE",
              takedownReason: null,
              rightsConfirmedAt: now,
              // A re-share asks the likeness question again rather than trusting an old yes.
              likenessConfirmedAt: write.confirmLikeness ? now : null,
              ...fields
            },
            select: bookShareSelect
          })) as BookShareRecord;
        } else {
          share = (await tx.bookShare.update({
            where: { id: existing.id },
            data: { ...fields, ...(write.confirmRights ? { rightsConfirmedAt: now } : {}) },
            select: bookShareSelect
          })) as BookShareRecord;
        }
        if (write.caption !== "unchanged" && write.caption.fileReview && write.caption.caption) {
          await tx.moderationReport.create({
            data: {
              reporterUserId: null,
              projectId: write.projectId,
              bookShareId: share.id,
              targetType: "BOOK_SHARE",
              reason: "OTHER",
              comment: null,
              targetSnapshot: {
                kind: "caption_review",
                slug: share.slug,
                title: write.projectTitle,
                mode: share.mode,
                caption: write.caption.caption,
                verdict: write.caption.captionVerdict === Prisma.DbNull ? null : write.caption.captionVerdict
              } as Prisma.InputJsonValue
            }
          });
        }
        if (write.textReview) {
          await tx.moderationReport.create({
            data: {
              reporterUserId: null,
              projectId: write.projectId,
              bookShareId: share.id,
              targetType: "BOOK_SHARE",
              reason: "OTHER",
              comment: null,
              targetSnapshot: {
                kind: "book_text_review",
                slug: share.slug,
                title: write.projectTitle,
                mode: share.mode,
                verdict: write.textReview
              } as Prisma.InputJsonValue
            }
          });
        }
        return share;
      });
    } catch (error) {
      if (attempt < MAX_WRITE_ATTEMPTS && isUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function loadShareForProject(projectId: string): Promise<BookShareRecord | null> {
  return (await prisma.bookShare.findUnique({
    where: { projectId },
    select: bookShareSelect
  })) as BookShareRecord | null;
}

export async function loadShareBySlug(slug: string): Promise<BookShareRecord | null> {
  return (await prisma.bookShare.findUnique({
    where: { slug },
    select: bookShareSelect
  })) as BookShareRecord | null;
}

/** Whether a slug was ever issued, for the "no longer shared" answer to a retired one. */
export async function wasShareSlugIssued(slug: string): Promise<boolean> {
  return Boolean(await prisma.shareSlug.findUnique({ where: { slug }, select: { slug: true } }));
}
