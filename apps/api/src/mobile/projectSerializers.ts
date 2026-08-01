import {
  mobileBookTypeChoiceSchema,
  mobilePageCountModeSchema,
  mobilePageCountSourceSchema,
  mobileTargetPagesSchema
} from "../mobileCreation.js";
import { buildProjectStatus, normalizeProjectQuality, type PipelineStep } from "../projectStatus.js";
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
  type MobileProjectStatusDto,
  type MobileProjectSummaryDto,
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
  loadConfig,
  mediaSettingsSchema,
  type BookPlan
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { hasActiveProjectEntitlement } from "@book-maker/db/billing";
import { extname } from "node:path";
import { z } from "zod";

/**
 * Turns Prisma project rows into the summary/detail/status DTOs the app renders,
 * including progress percentages and recovery affordances.
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

  return {
    id: project.id,
    title: project.title,
    subtitle: project.subtitle ?? null,
    authorName: project.authorName ?? null,
    bookType: mobile?.bookType ?? inferBookType(project.category, project.subcategory),
    lengthPreset: mobile?.lengthPreset ?? "custom",
    qualityPreset: mobile?.qualityPreset ?? "custom",
    imagesEnabled: mobile?.imagesEnabled ?? imagesEnabledFromMediaSettings(project.mediaSettings),
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

export async function serializeProjectDetail(
  project: MobileProjectRecord,
  appConfig: ReturnType<typeof loadConfig>,
  userId: string
): Promise<MobileProjectDetailDto> {
  const summary = await serializeProjectSummary(project, appConfig, userId);
  const latestCompile = await prisma.generationJob.findFirst({
    where: { projectId: project.id, type: "COMPILE_EXPORT" },
    orderBy: { createdAt: "desc" },
    select: { qualityReport: true }
  });
  return {
    ...summary,
    prompt: project.prompt,
    language: project.language,
    plan: project.currentPlan ? serializePlan(project.currentPlan) : null,
    pages: (project.pages ?? []).map((page) => ({
      id: page.id,
      index: page.index,
      title: page.title,
      summary: page.summary,
      previewText: generatedPagePreview(page.markdown, page.summary),
      status: page.status.toLowerCase(),
      image: serializeImage(page.images?.[0] ?? null, "page_visual", `Visual for ${page.title}`)
    })),
    quality: normalizeProjectQuality(latestCompile?.qualityReport)
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
  const failedJob = project.jobs.find((job) => job.status === "FAILED");
  const progressPercent = statusProgressPercent(status);
  const planningProgress = serializePlanningProgress(status);

  return {
    projectId: project.id,
    status: normalizeProjectStatus(project.status),
    statusLabel: statusLabel(project.status),
    progressPercent,
    currentAction: planningProgress?.steps.find((step) => step.status === "active")?.label ??
      currentActionFromSteps(project.status, steps, progressPercent),
    planningProgress,
    failureMessage: failedJob ? failureMessageForJob(failedJob.type as GenerationJobType, failedJob.error) : null,
    retryAvailable: status.progress.resumableFailedJobs > 0,
    steps,
    pageProgress: {
      completed: status.progress.pages.complete,
      target: status.progress.pages.target
    },
    imageCount: status.progress.images,
    quality: status.quality,
    exports,
    updatedAt: project.updatedAt.toISOString()
  };
}

export function serializePlanningProgress(status: ProjectStatusResult): MobileProjectStatusDto["planningProgress"] {
  if (status.project.status !== "PLANNING" && status.project.status !== "PLAN_READY") {
    return null;
  }
  const job =
    status.project.jobs.find(
      (candidate) =>
        (candidate.type === "PLAN_BOOK" || candidate.type === "REVISE_PLAN") &&
        (candidate.status === "QUEUED" || candidate.status === "ACTIVE")
    ) ??
    (status.project.status === "PLAN_READY"
      ? status.project.jobs.find(
          (candidate) =>
            (candidate.type === "PLAN_BOOK" || candidate.type === "REVISE_PLAN") &&
            candidate.status === "COMPLETED"
        )
      : undefined);
  if (!job) {
    return null;
  }

  const isRevision = job.type === "REVISE_PLAN";
  const isCompleted = job.status === "COMPLETED";
  const storedSteps = new Map(job.steps.map((step) => [step.key, step.status]));
  const storedStatus = (key: string) =>
    isCompleted ? "done" as const : storedSteps.get(key) ?? "pending";
  const steps: NonNullable<MobileProjectStatusDto["planningProgress"]>["steps"] = isRevision
    ? [
        { key: "understand", label: "Understanding your changes", status: "done" },
        {
          key: "shape",
          label: "Improving your plan",
          status: storedSteps.size ? storedStatus("revise") : "active"
        },
        { key: "finalize", label: "Saving your revision", status: storedStatus("save") }
      ]
    : [
        {
          key: "understand",
          label: "Understanding your idea",
          status: storedSteps.size ? storedStatus("research") : "active"
        },
        { key: "shape", label: "Shaping the chapters and flow", status: storedStatus("plan") },
        { key: "finalize", label: "Finalizing your plan", status: storedStatus("save") }
      ];

  return {
    percent: planningProgressPercent(job, status.project.targetPages, isRevision),
    steps
  };
}

export function planningProgressPercent(
  job: ProjectStatusResult["project"]["jobs"][number],
  targetPages: number,
  isRevision: boolean
): number {
  if (job.status === "COMPLETED") {
    return 100;
  }

  const storedPercent = clampPlanningPercent(job.progress, 99);
  const outputTokens = Number.isFinite(job.tokens?.outputTokens) ? Math.max(0, job.tokens?.outputTokens ?? 0) : 0;
  if (outputTokens === 0) {
    return storedPercent;
  }

  const activeStep = job.steps.find((step) => step.status === "active")?.key;
  const shapeStep = isRevision ? "revise" : "plan";
  if (activeStep !== shapeStep && activeStep !== "save") {
    return storedPercent;
  }

  const expectedTokens = expectedPlanningOutputTokens(targetPages, isRevision);
  const outputRatio = Math.min(1, 1 - Math.exp((-1.6 * outputTokens) / expectedTokens));
  const shapeStart = isRevision ? 35 : 45;
  const shapeEnd = isRevision ? 89 : 79;
  const tokenPercent = activeStep === "save"
    ? shapeEnd + 1 + Math.round((98 - (shapeEnd + 1)) * outputRatio)
    : shapeStart + Math.round((shapeEnd - shapeStart) * outputRatio);

  return Math.max(storedPercent, Math.min(99, tokenPercent));
}

export function expectedPlanningOutputTokens(targetPages: number, isRevision: boolean): number {
  const pages = Number.isFinite(targetPages) ? Math.max(1, Math.floor(targetPages)) : 12;
  const estimatedChapters = Math.max(1, Math.ceil(pages / 12));
  return isRevision
    ? Math.max(650, Math.min(4_000, 500 + estimatedChapters * 140))
    : Math.max(1_400, Math.min(6_500, 1_000 + estimatedChapters * 360));
}

export function clampPlanningPercent(value: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, Math.round(Number.isFinite(value) ? value : 0)));
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

export function statusProgressPercent(status: ProjectStatusResult): number {
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
    return 92;
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
      return "Fix the flagged pages before exporting.";
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
    RESEARCH: "checking research",
    IMPORT_BOOK: "importing your book",
    CONTINUE_BOOK: "writing new chapters",
    GENERATE_AUDIOBOOK: "narrating your book"
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
    !pageCountSource.success ||
    typeof metadata.imagesEnabled !== "boolean"
  ) {
    return null;
  }
  return {
    bookType: bookType.data,
    bookTypeChoice: bookTypeChoice.data ?? (bookType.data === "custom" ? "auto" : bookType.data),
    lengthPreset: lengthPreset.data,
    qualityPreset: qualityPreset.data,
    imagesEnabled: metadata.imagesEnabled,
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

export function imagesEnabledFromMediaSettings(mediaSettings: unknown): boolean {
  const parsed = mediaSettingsSchema.safeParse(mediaSettings);
  return parsed.success ? parsed.data.fullIllustrations || parsed.data.includeCover : true;
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

export function canRecoverGenerationJob(
  type: GenerationJobType,
  payload: unknown,
  context: { currentPlanId: string | null; currentPlanCreatedAt: Date | null; pageIds: Set<string> },
  jobCreatedAt: Date
): boolean {
  const payloadRecord = jsonRecord(payload);

  if (type === "PLAN_BOOK") {
    return !context.currentPlanCreatedAt || jobCreatedAt > context.currentPlanCreatedAt;
  }

  if (type === "REVISE_PLAN") {
    return (
      typeof payloadRecord.planId === "string" &&
      payloadRecord.planId === context.currentPlanId &&
      typeof payloadRecord.message === "string" &&
      payloadRecord.message.trim().length > 0
    );
  }

  if (!context.currentPlanId) {
    return false;
  }

  const planId = payloadPlanId(payloadRecord);
  if (planId && planId !== context.currentPlanId) {
    return false;
  }

  if (type === "GENERATE_BOOK") {
    return planId === context.currentPlanId;
  }

  if (type === "GENERATE_PAGE") {
    return isCurrentPagePayload(payloadRecord, context);
  }

  if (type === "GENERATE_IMAGE") {
    return (
      isCurrentCoverPayload(payloadRecord, context) ||
      (isCurrentPagePayload(payloadRecord, context) && typeof payloadRecord.prompt === "string")
    );
  }

  return type === "COMPILE_EXPORT" || type === "APPLY_BOOK_EDIT" || type === "REPLAN_BOOK";
}

export function isPlanningRecoveryJob(type: GenerationJobType): boolean {
  return type === "PLAN_BOOK" || type === "REVISE_PLAN";
}

export function recoveryPayload(
  type: GenerationJobType,
  payload: unknown,
  currentPlanId: string | null
): Record<string, unknown> {
  if (isPlanningRecoveryJob(type) || !currentPlanId) {
    return jsonRecord(payload);
  }
  return {
    ...jsonRecord(payload),
    planId: currentPlanId
  };
}

export function payloadPlanId(payload: Record<string, unknown>): string | null {
  return typeof payload.planId === "string" ? payload.planId : null;
}

export function isCurrentPagePayload(
  payload: Record<string, unknown>,
  context: { pageIds: Set<string> }
): boolean {
  return typeof payload.pageId === "string" && context.pageIds.has(payload.pageId);
}

export function isCurrentCoverPayload(
  payload: Record<string, unknown>,
  context: { currentPlanId: string | null }
): boolean {
  return payload.assetType === "COVER" && payloadPlanId(payload) === context.currentPlanId;
}

/** Imported manuscripts carry mediaSettings.mobile.import provenance. */
export function projectSourceFromMediaSettings(mediaSettings: unknown): "imported" | "generated" {
  const mobile = jsonRecord(jsonRecord(mediaSettings).mobile);
  return Object.keys(jsonRecord(mobile.import)).length > 0 ? "imported" : "generated";
}

export function currentActionForEditOperation(operation: MobileBookEditOperationRecord): string {
  if (operation.status === "FAILED") {
    if (operation.kind === "PLAN_REVISION") {
      return "Plan revision failed.";
    }
    return "Edit failed.";
  }
  if (operation.status === "APPLIED") {
    return "Edit applied.";
  }
  if (operation.kind === "BOOK_REPLAN") {
    return "Rebuilding a new copy.";
  }
  if (operation.kind === "PAGE_REWRITE") {
    return "Rewriting selected pages.";
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
