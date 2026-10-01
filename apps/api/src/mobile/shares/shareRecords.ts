import { Prisma, prisma } from "@book-maker/db";
import type { ModerationAttemptRecord, UserTextModerationResult, UserTextSurface } from "../../userTextModeration.js";
import { generateShareSlug } from "./shareSlug.js";

/**
 * The share row: its select, its wire shape, and the one transaction that
 * writes it. Everything that decides *whether* to write — the screen, the
 * moderation verdict, the unlock — has run before `writeShare` is called.
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
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
};

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
  takedownReason: string | null;
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
  /** The preview cap — half of `readingPages`, at least 1. */
  maxPreviewPages: number | null;
  likenessRequired: boolean;
  exportUnlocked: boolean;
  /** The live `exportUnlock` price; 0 once the book is unlocked. */
  exportUnlockCredits: number;
};

export type MobileShareStateDto = {
  share: MobileBookShareDto | null;
  book: MobileShareBookDto;
};

export type MobileShareWriteDto = MobileShareStateDto & {
  /** The PDF unlock was charged by this request. */
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

export type ShareWrite = {
  userId: string;
  projectId: string;
  projectTitle: string;
  mode: BookShareMode;
  previewPages: number | null;
  showAuthorName: boolean;
  caption: CaptionDecision | "unchanged";
  confirmRights: boolean;
  confirmLikeness: boolean;
};

const MAX_WRITE_ATTEMPTS = 3;

/**
 * Creates, updates, or re-activates the book's one share row, in one
 * transaction with the system review a held note needs.
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
        const existing = (await tx.bookShare.findUnique({
          where: { projectId: write.projectId },
          select: bookShareSelect
        })) as BookShareRecord | null;
        const now = new Date();
        const reactivating = !existing || existing.status !== "ACTIVE";
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
        } else if (reactivating) {
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
