import {
  type MobileExportAvailabilityDto,
  type MobileExportSetDto,
  type MobileImageRecord,
  type MobilePlanDto,
  type MobilePlanRecord,
  type MobileProjectImageDto
} from "./dto.js";
import { mobileAssetFilenameSchema } from "./schemas.js";
import { jsonRecord, sanitizeDownloadFilename, stringField, versionedImageAssetUrl } from "./support.js";
import {
  exportRequiresSubscription,
  exportContentType,
  exportFormatLabel,
  EXPORT_FORMATS,
  bookPlanSchema,
  loadConfig,
  type BookPlan
} from "@book-maker/core";
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
    url: versionedImageAssetUrl(
      `/api/mobile/projects/${encodeURIComponent(image.projectId)}/assets/${encodeURIComponent(image.id)}`,
      image
    ),
    contentType: imageContentType(image),
    altText,
    pageId: image.pageId,
    aiGenerated: imageIsAiGenerated(image.metadata)
  };
}

/**
 * Whether a model drew this picture, read off what made it: the cover pipeline
 * writes `coverArtSource: "design" | "ai"` on everything it renders and an
 * upload writes `source: "upload"` (`manuscript/manuscriptCover.ts`). A row
 * that says neither — a page illustration, a cover from before the field —
 * was drawn, so it stays reportable.
 */
export function imageIsAiGenerated(metadata: unknown): boolean {
  const record = jsonRecord(metadata);
  return record.source !== "upload" && record.coverArtSource !== "design";
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

function completeExportSet(
  entries: ReadonlyArray<{ format: ProjectExportFormat; dto: MobileExportAvailabilityDto }>
): MobileExportSetDto {
  const set: Partial<MobileExportSetDto> = {};
  for (const { format, dto } of entries) {
    set[format] = dto;
  }
  const missing = EXPORT_FORMATS.filter((format) => set[format] === undefined);
  if (missing.length > 0) {
    throw new Error(`serializeExportSet is missing ${missing.join(", ")}`);
  }
  return set as MobileExportSetDto;
}

export async function serializeExportSet(
  projectId: string,
  title: string,
  appConfig: ReturnType<typeof loadConfig>,
  contentRevision: number,
  // False skips the storage HEADs and reports every file unavailable: the
  // status read of a book still planning or generating, which cannot have
  // gained a file and was paying a HEAD per format per tick.
  probeFiles = true
): Promise<MobileExportSetDto> {
  const files = await Promise.all(
    EXPORT_FORMATS.map(async (format) => ({
      format,
      file: probeFiles
        ? await projectExportAvailability(appConfig, projectId, format)
        : { available: false, byteSize: null, modifiedAt: null }
    }))
  );
  return completeExportSet(
    files.map(({ format, file }) => ({ format, dto: serializeExport(projectId, title, format, file, contentRevision) }))
  );
}

/**
 * One format's entry. Every book downloads free since 2026-10-15, so the three
 * fields an installed app still reads to decide on an unlock are constant:
 * `unlocked: true`, `creditsRequired: 0` (the app requires the key) and
 * `planIncludesUnlock: false`, which never offers a plan for a file that is
 * already free. The Word file's plan gate is `requiresSubscription`, a
 * different thing: a format, never a charge.
 */
export function serializeExport(
  projectId: string,
  title: string,
  format: ProjectExportFormat,
  file: { available: boolean; byteSize: number | null; modifiedAt: Date | null },
  contentRevision: number
): MobileExportAvailabilityDto {
  return {
    format,
    label: exportFormatLabel(format),
    available: file.available,
    unlocked: true,
    requiresSubscription: exportRequiresSubscription(format),
    creditsRequired: 0,
    planIncludesUnlock: false,
    downloadUrl: `/api/mobile/projects/${encodeURIComponent(projectId)}/export/${format}`,
    ...(format === "pdf" ? { readUrl: `/api/mobile/projects/${encodeURIComponent(projectId)}/read/pdf` } : {}),
    filename: `${sanitizeDownloadFilename(title)}.${format}`,
    contentType: exportContentType(format),
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
