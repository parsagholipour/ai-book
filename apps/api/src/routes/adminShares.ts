import { loadConfig } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { objectStore } from "@book-maker/storage";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sharePreviewPrefix } from "../mobile/shares/sharePreviewPdf.js";
import { bookShareSelect, shareUrl, type BookShareRecord } from "../mobile/shares/shareRecords.js";
import { markOperatorRequest } from "../requestAuth.js";

/**
 * The operator's three actions on a shared book, from the Moderation screen:
 *
 * - **approve caption** — a note the gate held (`PENDING_REVIEW`), or one an
 *   operator removed, is shown after all;
 * - **remove caption** — the note stops showing. REMOVED sticks to that exact
 *   text: the author's resubmitting it unchanged is not re-moderated, so it
 *   stays removed until they write something else;
 * - **take down** — the share answers 410 and the author sees `reason` in the
 *   app. A taken-down share cannot be re-shared or revoked away by its author.
 *
 * Each records the operator's decision on the note's verdict record and settles
 * the report it was taken from, plus every other pending report on the share
 * that the same decision answers.
 */

const shareParams = z.object({ id: z.string().min(1).max(64) });
const actionBody = z
  .object({
    action: z.enum(["approve_caption", "remove_caption", "take_down"]),
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

export const adminShareRoutes: FastifyPluginAsync = async (fastify) => {
  const appConfig = loadConfig();

  fastify.post("/api/admin/shares/:id/moderation", { schema: { tags: ["admin"] } }, async (request, reply) => {
    const operator = request.operatorAuth ?? (await markOperatorRequest(request));
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
    if (action !== "take_down" && !existing.caption) {
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
    const share = (await prisma.$transaction(async (tx) => {
      const updated = await tx.bookShare.update({
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
      if (reportId) {
        await tx.moderationReport.updateMany({ where: { id: reportId, bookShareId: id }, data: settled });
      }
      await tx.moderationReport.updateMany({
        where: {
          bookShareId: id,
          status: "PENDING",
          // A take-down answers every report on the share; a caption decision
          // answers the system's own caption reviews.
          ...(action === "take_down" ? {} : { reporterUserId: null, targetSnapshot: { path: ["kind"], equals: "caption_review" } })
        },
        data: settled
      });
      return updated;
    })) as BookShareRecord;
    if (action === "take_down") {
      await objectStore()
        .deletePrefix(sharePreviewPrefix(share.projectId))
        .catch((error: unknown) => request.log.warn({ err: error, shareId: id }, "share preview cleanup failed"));
    }
    return { share: serializeAdminShare(share, appConfig.PUBLIC_API_URL) };
  });
};
