import {
  type MobileExportAvailabilityDto,
  type MobileExportSetDto,
  type MobileImageRecord,
  type MobilePlanDto,
  type MobilePlanRecord,
  type MobileProjectImageDto
} from "./dto.js";
import { mobileAssetFilenameSchema } from "./schemas.js";
import { jsonRecord, sanitizeDownloadFilename, stringField } from "./support.js";
import {
  bookPlanSchema,
  creditCostForOperation,
  loadConfig,
  type BookPlan
} from "@book-maker/core";
import { hasActiveProjectEntitlement } from "@book-maker/db/billing";
import {
  projectExportAvailability,
  type ProjectExportFormat
} from "../routes/projectExports.js";
import { extname } from "node:path";

/**
 * Serializes the plans and generated artifacts attached to a mobile project.
 * Export probing lives behind this seam so project DTO serializers do not
 * depend on either the operator or mobile route modules.
 */

export function serializeImage(
  image: MobileImageRecord | null,
  role: MobileProjectImageDto["role"],
  altText: string
): MobileProjectImageDto | null {
  if (!image) {
    return null;
  }
  return {
    id: image.id,
    role,
    url: `/api/mobile/projects/${encodeURIComponent(image.projectId)}/assets/${encodeURIComponent(image.id)}`,
    contentType: imageContentType(image),
    altText,
    pageId: image.pageId
  };
}

export function serializePlan(planVersion: MobilePlanRecord): MobilePlanDto {
  const parsed = bookPlanSchema.safeParse(planVersion.planningPackage);
  const plan = parsed.success ? parsed.data : fallbackPlan(planVersion.planningPackage);
  return {
    id: planVersion.id,
    projectId: planVersion.projectId,
    version: planVersion.version,
    status: normalizePlanStatus(planVersion.status),
    title: plan.title,
    subtitle: plan.subtitle ?? null,
    premise: plan.premise,
    audience: plan.audience,
    questions: plan.questions.map((question) => ({
      prompt: question.prompt,
      options: question.options,
      answerKind: question.answerKind,
      allowCustom: question.allowCustom
    })),
    chapters: plan.chapters.map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      summary: chapter.summary,
      targetPages: chapter.targetPages
    })),
    createdAt: planVersion.createdAt.toISOString(),
    updatedAt: planVersion.updatedAt.toISOString(),
    approvedAt: planVersion.approvedAt?.toISOString() ?? null
  };
}

export function fallbackPlan(value: unknown): BookPlan {
  const record = jsonRecord(value);
  return {
    title: stringField(record, "title") ?? "Book plan",
    premise: stringField(record, "premise") ?? "",
    audience: stringField(record, "audience") ?? "",
    writingComplexity: 5,
    voiceGuide: ["Follow the requested book voice."],
    antiAiRules: ["Avoid generic filler."],
    questions: [],
    chapters: [],
    characters: [],
    locations: [],
    continuityRules: [],
    promises: [],
    researchQueries: [],
    researchNotes: [],
    illustrationPlan: {
      cadence: "template-driven",
      globalStyle: "",
      characterReferencePrompts: [],
      pageRules: []
    }
  };
}

export async function serializeExportSet(
  projectId: string,
  title: string,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string,
  contentRevision: number
): Promise<MobileExportSetDto> {
  const [pdf, epub, unlocked] = await Promise.all([
    projectExportAvailability(appConfig, projectId, "pdf"),
    projectExportAvailability(appConfig, projectId, "epub"),
    hasActiveProjectEntitlement({ userId, projectId, type: "EXPORT_UNLOCK" })
  ]);
  return {
    pdf: serializeExport(projectId, title, "pdf", pdf, unlocked, contentRevision),
    epub: serializeExport(projectId, title, "epub", epub, unlocked, contentRevision)
  };
}

export function serializeExport(
  projectId: string,
  title: string,
  format: ProjectExportFormat,
  file: { available: boolean; byteSize: number | null; modifiedAt: Date | null },
  unlocked: boolean,
  contentRevision: number
): MobileExportAvailabilityDto {
  return {
    format,
    available: file.available,
    unlocked,
    creditsRequired: unlocked ? 0 : creditCostForOperation("EXPORT_UNLOCK"),
    downloadUrl: `/api/mobile/projects/${encodeURIComponent(projectId)}/export/${format}`,
    filename: `${sanitizeDownloadFilename(title)}.${format}`,
    contentType: format === "pdf" ? "application/pdf" : "application/epub+zip",
    revision: contentRevision,
    byteSize: file.byteSize,
    updatedAt: file.modifiedAt?.toISOString() ?? null
  };
}

export function normalizePlanStatus(status: string): MobilePlanDto["status"] {
  if (status === "APPROVED") {
    return "approved";
  }
  if (status === "SUPERSEDED") {
    return "superseded";
  }
  return "draft";
}

export function imageContentType(image: { path: string; metadata: unknown }): string {
  const mimeType = stringField(jsonRecord(image.metadata), "mimeType");
  if (mimeType?.startsWith("image/")) {
    return mimeType;
  }
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif"
    } satisfies Record<string, string>
  )[extname(image.path).toLowerCase()] ?? "application/octet-stream";
}

export function mobileAssetFilenameFromPath(path: string, projectId: string): string | null {
  let pathname = path;
  try {
    pathname = new URL(path).pathname;
  } catch {
    // Relative asset paths are supported below.
  }
  const prefix = `/assets/images/${projectId}/`;
  const index = pathname.indexOf(prefix);
  if (index === -1) {
    return null;
  }
  const filename = decodeURIComponent(pathname.slice(index + prefix.length));
  return mobileAssetFilenameSchema.safeParse(filename).success ? filename : null;
}
