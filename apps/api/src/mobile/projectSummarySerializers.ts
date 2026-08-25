import {
  mobileBookTypeChoiceSchema,
  mobilePageCountModeSchema,
  mobilePageCountSourceSchema,
  mobileTargetPagesSchema
} from "../mobileCreation.js";
import { normalizeProjectQuality } from "../projectStatus.js";
import { imageSettingsFromMediaSettings } from "./imageSettings.js";
import { loadProjectQualityReport, qualityWithExportsOnDisk } from "./qualityVerdict.js";
import {
  serializeExportSet,
  serializeImage,
  serializePlan
} from "./projectArtifactSerializers.js";
import {
  currentActionForProject,
  normalizeProjectStatus,
  projectProgressPercent,
  statusLabel
} from "./projectStatusSerializers.js";
import {
  type MobileMediaMetadata,
  type MobileProjectDetailDto,
  type MobileProjectRecord,
  type MobileProjectRevisionOriginDto,
  type MobileProjectSummaryDto,
  type MobileQualityPreset
} from "./dto.js";
import {
  MOBILE_TITLE_SOURCE_PLANNER_PENDING,
  mobileBookTypeSchema,
  mobileLengthPresetSchema,
  mobileQualityPresetSchema
} from "./schemas.js";
import { generatedPagePreview, jsonRecord, previewText, stringField } from "./support.js";
import {
  createProjectSchema,
  isImportedManuscript,
  loadConfig,
  mediaSettingsSchema,
  modelTierSchema
} from "@book-maker/core";
import { z } from "zod";

/**
 * Turns Prisma project rows into the summary and detail DTOs the app renders,
 * and owns the mobile metadata/provenance stored with a project.
 */

export async function serializeProjectSummary(
  project: MobileProjectRecord,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string
): Promise<MobileProjectSummaryDto> {
  const mobile = mobileMetadataFromMediaSettings(project.mediaSettings);
  const pageCount = project._count?.pages ?? project.pages?.length ?? 0;
  const imageCount = project._count?.images ?? 0;
  const progressPercent = projectProgressPercent(project.status, pageCount, project.targetPages);
  const hasExistingPlan = Boolean(project.currentPlanId || project.currentPlan);
  const imageSettings = imageSettingsFromMediaSettings(project.mediaSettings);

  return {
    id: project.id,
    title: project.title,
    subtitle: project.subtitle ?? null,
    authorName: project.authorName ?? null,
    bookType: mobile?.bookType ?? inferBookType(project.category, project.subcategory),
    lengthPreset: mobile?.lengthPreset ?? "custom",
    qualityPreset: qualityPresetForProject(project.mediaSettings, mobile?.qualityPreset),
    ...imageSettings,
    status: normalizeProjectStatus(project.status),
    statusLabel: statusLabel(project.status),
    progressPercent,
    currentAction: currentActionForProject(project.status, progressPercent, { hasExistingPlan }),
    promptPreview: previewText(project.prompt),
    targetPages: project.targetPages,
    pageCount,
    imageCount,
    hasPlan: hasExistingPlan,
    source: projectSourceFromMediaSettings(project.mediaSettings),
    revisedFrom: revisedFromMediaSettings(project.mediaSettings),
    coverImage: serializeImage(
      project.images?.find((image) => image.type === "COVER") ?? null,
      "cover",
      `Cover for ${project.title}`
    ),
    exports: await serializeExportSet(project.id, project.title, appConfig, userId, project.contentRevision),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
  };
}

/**
 * The preset the app shows *and* prices with.
 *
 * The app mirrors the server's credit formula and picks its rates off this one
 * field, so it has to name the tier the server would charge at. The mobile echo
 * is the answer whenever the app created the book. When it is missing — an
 * import, an operator-console project, a row older than the echo — the tier
 * itself answers, because that is what `estimateFullBookCreditCost` prices from.
 * Only a project with neither is "custom", which both sides read as balanced.
 */
function qualityPresetForProject(
  mediaSettings: unknown,
  echoed: MobileQualityPreset | undefined
): MobileQualityPreset | "custom" {
  if (echoed) {
    return echoed;
  }
  const tier = modelTierSchema.safeParse(jsonRecord(mediaSettings).modelTier);
  return tier.success ? tier.data : "custom";
}

export async function serializeProjectDetail(
  project: MobileProjectRecord,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string
): Promise<MobileProjectDetailDto> {
  const summary = await serializeProjectSummary(project, appConfig, userId);
  // One row, asked for by ownership rather than sifted out of the newest few
  // compiles: a book that keeps losing its exports queues a repair every five
  // minutes, and eight of those buried the compile that actually reviewed the
  // manuscript — after which the detail response reported no verdict at all.
  const qualityReport = await loadProjectQualityReport(project.id);
  return {
    ...summary,
    prompt: project.prompt,
    language: project.language,
    plan: project.currentPlan ? serializePlan(project.currentPlan) : null,
    pages: (project.pages ?? []).map((page) => {
      const image = serializeImage(page.images?.[0] ?? null, "page_visual", `Visual for ${page.title}`);
      return {
        id: page.id,
        index: page.index,
        title: page.title,
        summary: page.summary,
        previewText: generatedPagePreview(page.markdown, page.summary),
        status: page.status.toLowerCase(),
        image,
        // The reason code stays server-side; the app only needs "this page
        // lost its illustration", and only while no image exists to show.
        imageFailed: image === null && Boolean(page.imageFailureReason)
      };
    }),
    quality: qualityWithExportsOnDisk(normalizeProjectQuality(qualityReport), summary.exports)
  };
}

export function inputSnapshotFromProject(project: {
  title: string;
  subtitle: string | null;
  authorName: string | null;
  coverTagline: string | null;
  prompt: string;
  category: string;
  subcategory: string | null;
  targetPages: number;
  complexity: number;
  temperature: number;
  language: string;
  mediaSettings: unknown;
}): Record<string, unknown> {
  const mediaSettings = mediaSettingsSchema.parse(project.mediaSettings);
  const title = hasPlannerPendingMobileTitle(mediaSettings) ? undefined : project.title;
  const input = createProjectSchema.parse({
    ...(title ? { title } : {}),
    ...(project.subtitle ? { subtitle: project.subtitle } : {}),
    ...(project.authorName ? { authorName: project.authorName } : {}),
    ...(project.coverTagline ? { coverTagline: project.coverTagline } : {}),
    prompt: project.prompt,
    category: project.category,
    ...(project.subcategory ? { subcategory: project.subcategory } : {}),
    targetPages: project.targetPages,
    complexity: project.complexity,
    temperature: project.temperature,
    language: project.language,
    mediaSettings
  });
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

export function hasPlannerPendingMobileTitle(mediaSettings: unknown): boolean {
  return stringField(jsonRecord(jsonRecord(mediaSettings).mobile), "titleSource") === MOBILE_TITLE_SOURCE_PLANNER_PENDING;
}

export function mobileMetadataFromMediaSettings(mediaSettings: unknown): MobileMediaMetadata | null {
  const metadata = jsonRecord(jsonRecord(mediaSettings).mobile);
  const imageSettings = imageSettingsFromMediaSettings(mediaSettings);
  const bookType = z.union([mobileBookTypeSchema, z.literal("custom")]).safeParse(metadata.bookType);
  const bookTypeChoice = mobileBookTypeChoiceSchema.optional().safeParse(metadata.bookTypeChoice);
  const lengthPreset = z.union([mobileLengthPresetSchema, z.literal("custom")]).safeParse(metadata.lengthPreset);
  const qualityPreset = mobileQualityPresetSchema.safeParse(metadata.qualityPreset);
  const pageCountMode = mobilePageCountModeSchema.default("auto").safeParse(metadata.pageCountMode);
  const targetPages = mobileTargetPagesSchema.safeParse(metadata.targetPages);
  const pageCountSource = mobilePageCountSourceSchema.default("legacy").safeParse(metadata.pageCountSource);
  if (
    !bookType.success ||
    !bookTypeChoice.success ||
    !lengthPreset.success ||
    !qualityPreset.success ||
    !pageCountMode.success ||
    !pageCountSource.success
  ) {
    return null;
  }
  return {
    bookType: bookType.data,
    bookTypeChoice: bookTypeChoice.data ?? (bookType.data === "custom" ? "auto" : bookType.data),
    lengthPreset: lengthPreset.data,
    qualityPreset: qualityPreset.data,
    coverEnabled: imageSettings.coverEnabled,
    illustrationsEnabled: imageSettings.illustrationsEnabled,
    imagesEnabled: imageSettings.imagesEnabled,
    pageCountMode: pageCountMode.data,
    targetPages: targetPages.success ? targetPages.data : 0,
    pageCountSource: pageCountSource.data
  };
}

export function inferBookType(category: string, subcategory: string | null): MobileProjectSummaryDto["bookType"] {
  if (subcategory === "Lead Magnet Ebook" || category === "BUSINESS" || category === "SELF_HELP") {
    return "lead_magnet";
  }
  if (subcategory === "Workbook or Study Guide" || category === "EDUCATION") {
    return "workbook";
  }
  if (subcategory === "Short Story" || category === "STORY") {
    return "short_story";
  }
  return "custom";
}

/**
 * Imported manuscripts carry `mediaSettings.mobile.import` provenance.
 *
 * The predicate is `isImportedManuscript` in `@book-maker/core`, not a copy of
 * it: the same record decides the label the app shows here and whether local QA
 * and the model reviewers are allowed to rewrite the author's own opening
 * sentence (`packages/core/src/generation/pagesLocalQa.ts`). Those were two
 * character-identical expressions in two workspaces, which is one edit away
 * from a book the app calls "imported" whose first line the pipeline still
 * treats as generated. Core is the leaf of the dependency graph, so this
 * direction is the one it already allows.
 */
export function projectSourceFromMediaSettings(mediaSettings: unknown): "imported" | "generated" {
  return isImportedManuscript(mediaSettings) ? "imported" : "generated";
}

/**
 * The backward pointer a replan copy carries to the book it was rebuilt from
 * (`createReplanProjectCopy` writes it onto `mediaSettings.mobile`). The
 * forward linkage lives on the source project's edit operation and chat
 * thread; this is the only place the copy itself names its origin. The
 * operation id and source marker stay server-side.
 */
export function revisedFromMediaSettings(mediaSettings: unknown): MobileProjectRevisionOriginDto | null {
  const mobile = jsonRecord(jsonRecord(mediaSettings).mobile);
  if (mobile.revisionSource !== "project_chat_book_replan") {
    return null;
  }
  if (typeof mobile.revisionOfProjectId !== "string" || !mobile.revisionOfProjectId) {
    return null;
  }
  const request = typeof mobile.revisionRequest === "string" && mobile.revisionRequest.trim() ? mobile.revisionRequest.trim() : null;
  const targetLanguage =
    typeof mobile.revisionTargetLanguage === "string" && mobile.revisionTargetLanguage ? mobile.revisionTargetLanguage : null;
  return { projectId: mobile.revisionOfProjectId, request, targetLanguage };
}
