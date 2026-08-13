import {
  mobileBookTypeChoiceSchema,
  mobilePageCountModeSchema,
  mobilePageCountSourceSchema,
  mobileTargetPagesSchema
} from "../mobileCreation.js";
import { buildProjectStatus, normalizeProjectQuality, type PipelineStep } from "../projectStatus.js";
import { serializeEditProgress } from "./editProgress.js";
import { serializeGenerationProgress } from "./generationProgress.js";
import { generationRecoveryQuote } from "./generationRetryQuote.js";
import { imageSettingsFromMediaSettings } from "./imageSettings.js";
import { loadProjectQualityReport, qualityWithExportsOnDisk } from "./qualityVerdict.js";
import { type GenerationJobType } from "../queue.js";
import { projectExportAvailability, type ProjectExportFormat } from "../routes/projects.js";
import {
  type MobileBookEditOperationRecord,
  type MobileExportAvailabilityDto,
  type MobileExportSetDto,
  type MobileImageRecord,
  type MobileMediaMetadata,
  type MobilePlanDto,
  type MobilePlanOperationDto,
  type MobilePlanRecord,
  type MobileProjectDetailDto,
  type MobileProjectImageDto,
  type MobileProjectRecord,
  type MobileProjectRevisionOriginDto,
  type MobileProjectStatusDto,
  type MobileProjectSummaryDto,
  type MobileQualityPreset,
  type MobileQueuedJobDto,
  type ProjectStatusResult
} from "./dto.js";
import {
  MOBILE_TITLE_SOURCE_PLANNER_PENDING,
  mobileAssetFilenameSchema,
  mobileBookTypeSchema,
  mobileLengthPresetSchema,
  mobileQualityPresetSchema
} from "./schemas.js";
import { generatedPagePreview, jsonRecord, previewText, sanitizeDownloadFilename, stringField } from "./support.js";
import {
  bookPlanSchema,
  createProjectSchema,
  creditCostForOperation,
  generationJobControlsProjectStatus,
  loadConfig,
  mediaSettingsSchema,
  modelTierSchema,
  payloadOwnsProjectOutcome,
  type BookPlan
} from "@book-maker/core";
import { hasActiveProjectEntitlement } from "@book-maker/db/billing";
import { extname } from "node:path";
import { z } from "zod";

/**
 * Turns Prisma project rows into the summary/detail/status DTOs the app renders,
 * including progress percentages and recovery affordances.
 */

export * from "./planningProgress.js";
export * from "./generationRecovery.js";
import { serializePlanningProgress } from "./planningProgress.js";

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

export async function loadSerializedProjectStatus(
  projectId: string,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string
): Promise<MobileProjectStatusDto | null> {
  const status = await buildProjectStatus(projectId);
  if (!status) {
    return null;
  }
  const exports = await serializeExportSet(
    projectId,
    status.project.title,
    appConfig,
    userId,
    status.project.contentRevision
  );
  return serializeProjectStatus(status, exports);
}

export function serializeProjectStatus(status: ProjectStatusResult, exports: MobileExportSetDto): MobileProjectStatusDto {
  const project = status.project;
  const steps = status.progress.pipeline.map(mobileStepFromPipeline);
  // Derivative operations report failure through their own resources. A
  // narration or voice-character failure must not make a healthy book look
  // failed or replace the book's own recovery guidance. The same is true per
  // *job* for the two payload-flagged kinds that settle alone: an export
  // repair rebuilds a file for a book that is already finished and paid for,
  // and a presentation-only reprint restores the settled status it was born
  // under — a Chromium blip on either would leave a COMPLETE book saying
  // "needs attention" forever — `hasFailure` in the app is exactly this field —
  // with nothing the reader could do about it. The repair re-queues itself
  // when a download or status surface next asks; a reprint re-queues when the
  // reader toggles the preference again.
  const failedJob = project.jobs.find(
    (job) =>
      job.status === "FAILED" &&
      generationJobControlsProjectStatus(job.type) &&
      payloadOwnsProjectOutcome(job.payload)
  );
  const imageSettings = imageSettingsFromMediaSettings(project.mediaSettings);
  const generationProgress = serializeGenerationProgress(status, imageSettings);
  const editProgress = serializeEditProgress(status);
  const progressPercent = statusProgressPercent(status, generationProgress, editProgress);
  const planningProgress = serializePlanningProgress(status);
  // Newest eligible attempt first: `resumableAttemptIds` follows the failed
  // jobs' creation order, so after a paid retry fails the retry's id is the
  // later one — and it, not the original, is what can be retried again. An
  // attempt that already has a retry is excluded outright: confirming its
  // quote would replay that retry and queue nothing, forever.
  const resumableAttempts = [...(status.progress.resumableAttemptIds ?? [])]
    .reverse()
    .flatMap((attemptId) => {
      const attempt = (project.generationAttempts ?? []).find((candidate) => candidate.id === attemptId);
      return attempt ? [attempt] : [];
    });
  const failedAttempt =
    resumableAttempts.find(
      (attempt) =>
        (attempt.status === "FAILED" || attempt.status === "CANCELED") &&
        !attempt.refundPending &&
        !attempt.retryAttempt &&
        attempt.quotedCredits >= 0
    ) ?? null;
  const recoveryQuote = failedAttempt ? generationRecoveryQuote(failedAttempt) : null;

  return {
    projectId: project.id,
    status: normalizeProjectStatus(project.status),
    statusLabel: statusLabel(project.status),
    progressPercent,
    ...imageSettings,
    // The live phrase leads whenever there is one: it is the only part of this
    // payload that says what is happening right now rather than what stage it is.
    currentAction: planningProgress?.steps.find((step) => step.status === "active")?.label ??
      generationProgress?.detail ??
      editProgress?.detail ??
      currentActionFromSteps(project.status, steps, progressPercent),
    planningProgress,
    generationProgress,
    editProgress,
    failureMessage: failedJob ? failureMessageForJob(failedJob.type as GenerationJobType, failedJob.error) : null,
    retryAvailable: status.progress.resumableFailedJobs > 0 && recoveryQuote !== null,
    recoveryQuote,
    steps,
    pageProgress: {
      completed: status.progress.pages.complete,
      target: status.progress.pages.target
    },
    imageCount: status.progress.images,
    quality: qualityWithExportsOnDisk(status.quality, exports),
    exports,
    updatedAt: project.updatedAt.toISOString()
  };
}


export function mobileStepFromPipeline(step: PipelineStep): MobileProjectStatusDto["steps"][number] {
  const keyByPipelineKey = {
    plan: "plan",
    pages: "write",
    images: "visuals",
    export: "export"
  } as const satisfies Record<PipelineStep["key"], MobileProjectStatusDto["steps"][number]["key"]>;
  const labelByPipelineKey = {
    plan: "Plan",
    pages: "Write",
    images: "Visuals",
    export: "Export"
  } as const satisfies Record<PipelineStep["key"], string>;

  return {
    key: keyByPipelineKey[step.key],
    label: labelByPipelineKey[step.key],
    status: step.status,
    detail: step.detail ?? null
  };
}

export function statusProgressPercent(
  status: ProjectStatusResult,
  generationProgress?: MobileProjectStatusDto["generationProgress"],
  editProgress?: MobileProjectStatusDto["editProgress"]
): number {
  const projectStatus = status.project.status;
  if (projectStatus === "COMPLETE" || projectStatus === "REVIEW_REQUIRED") {
    return 100;
  }
  if (projectStatus === "DRAFT") {
    return 0;
  }
  if (projectStatus === "PLANNING") {
    return 10;
  }
  if (projectStatus === "PLAN_READY") {
    return 20;
  }
  if (projectStatus === "EDITING") {
    // The flat 92 is the fallback for the window between enqueueing an edit and
    // the worker picking it up, when there is no job progress to report yet.
    return editProgress?.percent ?? 92;
  }
  // One number, one source: the bar the app draws and the bar inside the step
  // list must never disagree about the same book.
  if (generationProgress) {
    return generationProgress.percent;
  }

  const pageTarget = Math.max(1, status.progress.pages.target);
  const pageRatio = Math.max(0, Math.min(1, status.progress.pages.complete / pageTarget));
  const pagesPercent = 20 + Math.round(pageRatio * 60);
  const visualsDone = status.progress.pipeline.find((step) => step.key === "images")?.status === "done";
  const exportDone = status.progress.pipeline.find((step) => step.key === "export")?.status === "done";
  return Math.max(pagesPercent, visualsDone ? 88 : 0, exportDone ? 96 : 0);
}

export function projectProgressPercent(status: string, completePages: number, targetPages: number): number {
  if (status === "COMPLETE" || status === "REVIEW_REQUIRED") {
    return 100;
  }
  if (status === "DRAFT") {
    return 0;
  }
  if (status === "PLANNING") {
    return 10;
  }
  if (status === "PLAN_READY") {
    return 20;
  }
  if (status === "EDITING") {
    return 92;
  }
  const pageRatio = Math.max(0, Math.min(1, completePages / Math.max(targetPages, 1)));
  return status === "GENERATING" ? 20 + Math.round(pageRatio * 60) : Math.round(pageRatio * 80);
}

export function currentActionFromSteps(
  status: string,
  steps: MobileProjectStatusDto["steps"],
  progressPercent: number
): string {
  const activeStep = steps.find((step) => step.status === "active");
  if (activeStep?.key === "plan") {
    return "Creating your book plan.";
  }
  if (activeStep?.key === "write") {
    return "Writing your book pages.";
  }
  if (activeStep?.key === "visuals") {
    return "Creating visuals.";
  }
  if (activeStep?.key === "export") {
    return "Preparing downloads.";
  }
  return currentActionForProject(status, progressPercent);
}

export function currentActionForProject(
  status: string,
  progressPercent: number,
  options: { hasExistingPlan?: boolean } = {}
): string {
  switch (status) {
    case "DRAFT":
      return "Ready to create a book plan.";
    case "PLANNING":
      return options.hasExistingPlan ? "Revising your book plan." : "Creating your book plan.";
    case "PLAN_READY":
      return "Ready for review.";
    case "GENERATING":
      return progressPercent >= 90 ? "Preparing downloads." : "Writing your book.";
    case "EDITING":
      return "Editing your book.";
    case "COMPLETE":
      return "Ready to download.";
    case "REVIEW_REQUIRED":
      return "Ready to download - some pages are flagged for review.";
    case "FAILED":
      return "Needs attention.";
    default:
      return "Working on your book.";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft saved";
    case "PLANNING":
      return "Building your outline";
    case "PLAN_READY":
      return "Review your book plan";
    case "GENERATING":
      return "Generating your book";
    case "EDITING":
      return "Editing your book";
    case "COMPLETE":
      return "Ready to export";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Needs attention";
    default:
      return "Working";
  }
}

export function failureMessageForJob(type: GenerationJobType, rawError: string | null): string {
  const phase = {
    PLAN_BOOK: "creating your plan",
    REVISE_PLAN: "revising your plan",
    GENERATE_BOOK: "starting book generation",
    GENERATE_PAGE: "writing a page",
    GENERATE_IMAGE: "creating a visual",
    COMPILE_EXPORT: "preparing downloads",
    APPLY_BOOK_EDIT: "editing your book",
    REPLAN_BOOK: "rebuilding your book plan",
    PREPARE_CHARACTER_CANDIDATES: "preparing voice characters",
    BUILD_CHARACTER_PERSONA: "building a voice character",
    IMPORT_BOOK: "importing your book",
    CONTINUE_BOOK: "writing new chapters",
    GENERATE_AUDIOBOOK: "narrating your book",
    GENERATE_CHARACTER_PORTRAIT: "drawing a character portrait"
  } satisfies Record<GenerationJobType, string>;
  const detail = rawError?.replace(/\s+/g, " ").trim();
  return detail ? `We hit a problem while ${phase[type]}: ${detail.slice(0, 240)}` : `We hit a problem while ${phase[type]}.`;
}

export function planOperation(
  status: MobilePlanOperationDto["status"],
  projectId: string,
  planId: string | null,
  job: { id: string; status: string },
  currentAction: string
): MobilePlanOperationDto {
  return {
    projectId,
    planId,
    status,
    currentAction,
    job: {
      id: job.id,
      status: normalizeJobStatus(job.status),
      currentAction
    }
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

export function normalizeProjectStatus(status: string): string {
  return status.toLowerCase();
}

export function isLiveProjectStatus(status: string): boolean {
  return status === "planning" || status === "generating" || status === "editing";
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

export function normalizeJobStatus(status: string): MobileQueuedJobDto["status"] {
  if (status === "ACTIVE") {
    return "active";
  }
  if (status === "COMPLETED") {
    return "completed";
  }
  if (status === "FAILED") {
    return "failed";
  }
  if (status === "CANCELED") {
    return "canceled";
  }
  return "queued";
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


/** Imported manuscripts carry mediaSettings.mobile.import provenance. */
export function projectSourceFromMediaSettings(mediaSettings: unknown): "imported" | "generated" {
  const mobile = jsonRecord(jsonRecord(mediaSettings).mobile);
  return Object.keys(jsonRecord(mobile.import)).length > 0 ? "imported" : "generated";
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

/**
 * Which pages an edit is about, said the way the reader would say it.
 *
 * "Selected pages" was true of every rewrite and told no one anything; the
 * indexes are on the row, and they are the same numbers the live progress card
 * counts down, so the two never describe the same job differently.
 */
function describeEditPages(indexes: number[]): string {
  const pages = [...new Set(indexes.filter((index) => Number.isInteger(index) && index > 0))].sort(
    (left, right) => left - right
  );
  if (pages.length === 0) {
    return "the selected pages";
  }
  if (pages.length === 1) {
    return `page ${pages[0]}`;
  }
  if (pages.length === 2) {
    return `pages ${pages[0]} and ${pages[1]}`;
  }
  return `${pages.length} pages`;
}

function capitalizeFirst(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

export function currentActionForEditOperation(operation: MobileBookEditOperationRecord): string {
  if (operation.status === "FAILED") {
    if (operation.kind === "PLAN_REVISION") {
      return "Plan revision failed.";
    }
    return "Edit failed.";
  }
  if (operation.status === "APPLIED") {
    // The worker records pages it skipped because their text had changed
    // between the quote and the apply; the card is where that has to be said,
    // because the queued chat reply already promised those pages.
    const skipped = jsonRecord(operation.classifier)
      .skippedPageIndexes as unknown;
    const skippedPages = Array.isArray(skipped)
      ? skipped.filter((index): index is number => Number.isInteger(index) && (index as number) > 0)
      : [];
    if (skippedPages.length > 0) {
      return operation.affectedPageIndexes.length === 0
        ? `Nothing was changed: ${describeEditPages(skippedPages)} no longer contained that text.`
        : `Edit applied. ${capitalizeFirst(describeEditPages(skippedPages))} no longer contained that text and ${skippedPages.length === 1 ? "was" : "were"} left unchanged.`;
    }
    return "Edit applied.";
  }
  if (operation.kind === "BOOK_REPLAN") {
    return "Rebuilding a new copy.";
  }
  if (operation.kind === "PAGE_REWRITE") {
    return `Rewriting ${describeEditPages(operation.affectedPageIndexes)}.`;
  }
  if (operation.kind === "CHAPTER_REGENERATE") {
    return "Rewriting the chapter.";
  }
  if (operation.kind === "CONTINUE_BOOK") {
    return "Writing new chapters.";
  }
  if (operation.kind === "PLAN_REVISION") {
    return "Revising the plan.";
  }
  if (operation.kind === "MANUAL_EDIT") {
    return "Saving your manual edits.";
  }
  return "Applying text edits.";
}
