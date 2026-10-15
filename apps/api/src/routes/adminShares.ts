import { loadConfig } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { objectStore } from "@book-maker/storage";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sharePreviewPrefix } from "../mobile/shares/sharePreviewPdf.js";
import { bookShareSelect, shareUrl, type BookShareRecord } from "../mobile/shares/shareRecords.js";
import { requireOperatorActor } from "../requestAuth.js";

/**
 * The operator's four actions on a shared book, from the Moderation screen:
 *
 * - **approve caption** — a note the gate held (`PENDING_REVIEW`), or one an
 *   operator removed, is shown after all. Approving the share's note approves
 *   the held share: it also settles a pending `book_text_review`, the system
 *   review the sexual-content screen files when it had no verdict on part of
 *   the book's text, which used to stay open until a take-down;
 * - **approve book text** — the same settlement for a share with no note to
 *   approve: the operator read the book and it may stay up;
 * - **remove caption** — the note stops showing. REMOVED sticks to that exact
 *   text: the author's resubmitting it unchanged is not re-moderated, so it
 *   stays removed until they write something else;
 * - **take down** — the share answers 410 and the author sees `reason` in the
 *   app. A taken-down share cannot be re-shared or revoked away by its author.
 *
 * Each records the operator's decision — a caption decision on the note's
 * verdict record — and settles the report it was taken from, plus every other
 * pending report on the share that the same decision answers.
 */

const shareParams = z.object({ id: z.string().min(1).max(64) });
const actionBody = z
  .object({
    action: z.enum(["approve_caption", "remove_caption", "approve_book_text", "take_down"]),
    reason: z.string().trim().min(1).max(500).optional(),
    reportId: z.string().trim().min(1).max(64).optional()
  })
  .strict();

export type AdminShareDto = {
  id: string;
  slug: string;
  url: string;
  projectId: string;
  mode: "preview" | "full";
  previewPages: number | null;
  status: "active" | "revoked" | "taken_down";
  caption: string | null;
  captionStatus: "none" | "allowed" | "pending_review" | "removed";
  captionVerdict: unknown;
  takedownReason: string | null;
  viewCount: number;
};

export function serializeAdminShare(share: BookShareRecord, publicApiUrl: string): AdminShareDto {
  return {
    id: share.id,
    slug: share.slug,
    url: shareUrl(publicApiUrl, share.slug),
    projectId: share.projectId,
    mode: share.mode === "FULL" ? "full" : "preview",
    previewPages: share.previewPages,
    status: share.status.toLowerCase() as AdminShareDto["status"],
    caption: share.caption,
    captionStatus: share.captionStatus.toLowerCase() as AdminShareDto["captionStatus"],
    captionVerdict: share.captionVerdict,
    takedownReason: share.takedownReason,
    viewCount: share.viewCount
  };
}

/**
 * The system reviews each decision answers, besides the report it was taken
 * from. Approving the note approves the held share, so it closes a held book
 * text too; removing the note says nothing about the book.
 */
const SYSTEM_REVIEWS_SETTLED = {
  approve_caption: ["caption_review", "book_text_review"],
  remove_caption: ["caption_review"],
  approve_book_text: ["book_text_review"]
} as const;

export const adminShareRoutes: FastifyPluginAsync = async (fastify) => {
  const appConfig = loadConfig();

  fastify.post("/api/admin/shares/:id/moderation", { schema: { tags: ["admin"] } }, async (request, reply) => {
    const operator = await requireOperatorActor(request, reply);
    if (!operator) {
      return;
    }
    const { id } = shareParams.parse(request.params);
    const parsed = actionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Send a valid share action." } });
    }
    const { action, reason, reportId } = parsed.data;
    if (action === "take_down" && !reason) {
      return reply.code(400).send({ error: { code: "REASON_REQUIRED", message: "Say why the share is taken down; the author sees it." } });
    }
    const existing = (await prisma.bookShare.findUnique({ where: { id }, select: bookShareSelect })) as BookShareRecord | null;
    if (!existing) {
      return reply.code(404).send({ error: { code: "SHARE_NOT_FOUND", message: "Share not found." } });
    }
    if ((action === "approve_caption" || action === "remove_caption") && !existing.caption) {
      return reply.code(409).send({ error: { code: "NO_CAPTION", message: "This share has no note to review." } });
    }
    const now = new Date();
    const decision = {
      action,
      reviewerUserId: operator.userId,
      at: now.toISOString(),
      ...(reason ? { reason } : {})
    };
    const verdict =
      existing.captionVerdict && typeof existing.captionVerdict === "object" && !Array.isArray(existing.captionVerdict)
        ? (existing.captionVerdict as Record<string, unknown>)
        : {};
    const outcome = await prisma.$transaction(async (tx) => {
      const updated =
        action === "approve_book_text"
          ? await tx.bookShare.findUnique({ where: { id }, select: bookShareSelect })
          : await tx.bookShare.update({
              where: { id },
              data:
                action === "take_down"
                  ? { status: "TAKEN_DOWN", takedownReason: reason ?? null }
                  : {
                      captionStatus: action === "approve_caption" ? "ALLOWED" : "REMOVED",
                      captionVerdict: { ...verdict, operator: decision } as Prisma.InputJsonValue
                    },
              select: bookShareSelect
            });
      const settled = { status: "ACTIONED" as const, reviewerUserId: operator.userId, reviewedAt: now, reviewNotes: `${action}${reason ? `: ${reason}` : ""}` };
      let settledCount = 0;
      if (reportId) {
        settledCount += (await tx.moderationReport.updateMany({ where: { id: reportId, bookShareId: id }, data: settled })).count;
      }
      if (action === "take_down") {
        // A take-down answers every report on the share.
        await tx.moderationReport.updateMany({ where: { bookShareId: id, status: "PENDING" }, data: settled });
      } else {
        for (const kind of SYSTEM_REVIEWS_SETTLED[action]) {
          settledCount += (
            await tx.moderationReport.updateMany({
              where: { bookShareId: id, status: "PENDING", reporterUserId: null, targetSnapshot: { path: ["kind"], equals: kind } },
              data: settled
            })
          ).count;
        }
      }
      return { share: updated as BookShareRecord | null, settledCount };
    });
    if (action === "approve_book_text" && outcome.settledCount === 0) {
      return reply.code(409).send({ error: { code: "NO_TEXT_REVIEW", message: "This share has no book text waiting for review." } });
    }
    const share = outcome.share ?? existing;
    if (action === "take_down") {
      await objectStore()
        .deletePrefix(sharePreviewPrefix(share.projectId))
        .catch((error: unknown) => request.log.warn({ err: error, shareId: id }, "share preview cleanup failed"));
    }
    return { share: serializeAdminShare(share, appConfig.PUBLIC_API_URL) };
  });
};
