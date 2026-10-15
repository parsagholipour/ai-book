import type { Prisma } from "@book-maker/db";
import { z } from "zod";
import type { BookShareRecord } from "./mobile/shares/shareRecords.js";

/**
 * The one `ModerationReport` shape every report route writes and every
 * moderation read returns: the reason list, the body, the select and the
 * serializer. `mobileSafety.ts` (books, pictures, voice calls, book-chat
 * replies) and `aiOutputReports.ts` (creation chat, plans, character pictures,
 * Studio suggestions) both read it, so a report filed from any surface lands in
 * the operator queue in the same form.
 */

export const reportReasonSchema = z.enum([
  "offensive",
  "hate_or_harassment",
  "sexual_content",
  "violence_or_self_harm",
  "child_safety",
  "deceptive_or_misleading",
  "privacy_or_copyright",
  "other"
]);

export const moderationReportBodySchema = z
  .object({
    reason: reportReasonSchema,
    comment: z.string().trim().max(2000).optional()
  })
  .strict();

export type ModerationReportRecord = {
  id: string;
  reporterUserId: string | null;
  projectId: string | null;
  imageAssetId: string | null;
  bookShareId: string | null;
  targetType: string;
  reason: string;
  comment: string | null;
  status: string;
  targetSnapshot: unknown;
  reviewerUserId: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
  reporter?: { email: string; displayName: string | null } | null;
  project?: { title: string } | null;
  imageAsset?: { type: string } | null;
  bookShare?: BookShareRecord | null;
};

export const moderationReportSelect = {
  id: true,
  reporterUserId: true,
  projectId: true,
  imageAssetId: true,
  bookShareId: true,
  targetType: true,
  reason: true,
  comment: true,
  status: true,
  targetSnapshot: true,
  reviewerUserId: true,
  reviewedAt: true,
  reviewNotes: true,
  createdAt: true,
  updatedAt: true
} as const;

export function serializeModerationReport(report: ModerationReportRecord) {
  return {
    id: report.id,
    reporterUserId: report.reporterUserId,
    reporterEmail: report.reporter?.email ?? null,
    projectId: report.projectId,
    projectTitle:
      report.project?.title ??
      stringFromRecord(report.targetSnapshot, "title") ??
      stringFromRecord(report.targetSnapshot, "projectTitle"),
    imageAssetId: report.imageAssetId,
    bookShareId: report.bookShareId,
    targetType: report.targetType.toLowerCase(),
    reason: report.reason.toLowerCase(),
    comment: report.comment,
    status: report.status.toLowerCase(),
    targetSnapshot: report.targetSnapshot,
    reviewerUserId: report.reviewerUserId,
    reviewedAt: report.reviewedAt?.toISOString() ?? null,
    reviewNotes: report.reviewNotes,
    createdAt: report.createdAt.toISOString(),
    updatedAt: report.updatedAt.toISOString()
  };
}

export function toReportReason(reason: z.infer<typeof reportReasonSchema>) {
  return reason.toUpperCase() as Uppercase<typeof reason>;
}

/** Whitespace collapsed and trimmed; an empty answer is no answer. */
export function cleanText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

export function jsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function stringFromRecord(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const raw = record[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
