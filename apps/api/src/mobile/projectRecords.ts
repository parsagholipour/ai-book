import {
  explicitTargetPagesForMobilePayload,
  mobileBriefMetadata,
  mobileCreationDraftPayloadSchema,
  type MobileBookAdvisorResponse,
  type MobileBookTypeChoice,
  type MobileCreationDraftPayload,
  type MobilePageCountMode,
  type MobilePageCountSource
} from "../mobileCreation.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import { createCreationOutputForProject, creationOutputsForDraft, mobileCreationDraftOutputsInclude } from "./creationSessions.js";
import {
  type MobileCreateProjectInput,
  type MobileMediaMetadata,
  type MobilePageCountRecommendationDto,
  type MobilePageCountResolution,
  type MobilePlanOperationDto,
  type MobileProjectCreateRequestDto,
  type MobileProjectRecord
} from "./dto.js";
import { type ProjectForChat } from "./projectChat.js";
import { planOperation } from "./projectSerializers.js";
import {
  MOBILE_AUTO_BOOK_TYPE_SETTINGS,
  MOBILE_BOOK_TYPE_SETTINGS,
  MOBILE_PRODUCT_PRESETS,
  MOBILE_TITLE_SOURCE_PLANNER_PENDING,
  UNTITLED_MOBILE_PROJECT_TITLE,
  mobileComposedProjectCreateSchema,
  mobilePageCountRecommendationSchema,
  mobileProjectCreateBodySchema
} from "./schemas.js";
import { cleanTargetLanguage, fingerprintGenerationRequest, jsonInputValue, jsonRecord, jsonValue } from "./support.js";
import {
  AUTO_BOOK_GENERATION_STRATEGY_ID,
  createProjectSchema,
  creditCostForOperation,
  includeCoverForSource,
  mediaSettingsSchema,
  mediaSettingsWithReplanSettings,
  type ReplanSettings
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { startGenerationAttempt } from "@book-maker/db/billing";
import { z } from "zod";

/**
 * Creating and loading mobile Project rows, including page-count resolution and
 * the replan copy flow.
 */

/**
 * Both callers reach here with validated input: the create-project route parses
 * the untrusted body against `mobileProjectCreateBodySchema` first, and the
 * creation-chat build composes its prompt server-side. So this parse takes the
 * looser prompt ceiling — applying the typed-input cap to a composed prompt
 * only turned a long creation chat into a 500.
 */
export function buildMobileCreateProjectInput(input: MobileProjectCreateRequestDto): MobileCreateProjectInput {
  const parsed = mobileComposedProjectCreateSchema.parse(input);
  const bookTypeChoice = bookTypeChoiceForMobileCreate(parsed);
  const isAutoBookType = bookTypeChoice === "auto";
  const bookType = isAutoBookType ? MOBILE_AUTO_BOOK_TYPE_SETTINGS : MOBILE_BOOK_TYPE_SETTINGS[parsed.bookType];
  const quality = MOBILE_PRODUCT_PRESETS[parsed.qualityPreset];
  const exactTargetPages = parsed.pageCountMode === "custom" && parsed.targetPages ? parsed.targetPages : undefined;
  const targetPages = exactTargetPages ?? bookType.targetPages[parsed.lengthPreset];
  const pageCountMode: MobilePageCountMode = exactTargetPages ? "custom" : parsed.pageCountMode;
  const pageCountSource: MobilePageCountSource = exactTargetPages ? parsed.pageCountSource ?? "settings" : parsed.pageCountSource ?? "legacy";
  const mobileMetadata: MobileMediaMetadata = {
    bookType: isAutoBookType ? "custom" : parsed.bookType,
    bookTypeChoice: bookTypeChoice ?? parsed.bookType,
    lengthPreset: exactTargetPages ? "custom" : parsed.lengthPreset,
    qualityPreset: parsed.qualityPreset,
    imagesEnabled: parsed.imagesEnabled,
    coverEnabled: parsed.coverEnabled,
    illustrationsEnabled: parsed.illustrationsEnabled,
    pageCountMode,
    targetPages,
    pageCountSource
  };
  if (parsed.creationBrief && parsed.advisor) {
    const legacyCreationPayload =
      parsed.creationPayload ??
      mobileCreationDraftPayloadSchema.parse({
        payloadVersion: 2,
        rawIdea: parsed.creationBrief.topic,
        optionalDetails: {
          title: parsed.creationBrief.title,
          authorName: parsed.creationBrief.authorName,
          mustInclude: parsed.creationBrief.mustInclude,
          tone: parsed.creationBrief.tone
        },
        sourceNotes: parsed.creationBrief.sourceNotes,
        selectedPresets: {
          bookType: parsed.bookType,
          ...(bookTypeChoice ? { bookTypeChoice } : {}),
          lengthPreset: parsed.lengthPreset,
          qualityPreset: parsed.qualityPreset,
          imagesEnabled: parsed.imagesEnabled,
          coverEnabled: parsed.coverEnabled,
          illustrationsEnabled: parsed.illustrationsEnabled,
          pageCountMode,
          targetPages,
          pageCountSource
        },
        brief: parsed.creationBrief
      });
    const metadata = mobileBriefMetadata(legacyCreationPayload, parsed.advisor);
    for (const [key, value] of Object.entries(metadata)) {
      mobileMetadata[key] = jsonValue(value);
    }
  } else if (parsed.creationPayload && parsed.advisor) {
    const metadata = mobileBriefMetadata(parsed.creationPayload, parsed.advisor);
    for (const [key, value] of Object.entries(metadata)) {
      mobileMetadata[key] = jsonValue(value);
    }
  } else {
    if (parsed.creationBrief) {
      mobileMetadata.brief = jsonValue(parsed.creationBrief);
    }
    if (parsed.creationPayload) {
      mobileMetadata.payloadVersion = 2;
      mobileMetadata.creationPayload = jsonValue(parsed.creationPayload);
    }
    if (parsed.advisor) {
      mobileMetadata.advisor = jsonValue(parsed.advisor);
    }
  }
  if (!parsed.title) {
    mobileMetadata.titleSource = MOBILE_TITLE_SOURCE_PLANNER_PENDING;
  }
  // Declining the AI cover buys a bundled design rather than no cover.
  const coverArtSource = parsed.coverEnabled ? "ai" : "design";
  const baseMediaSettings = mediaSettingsSchema.parse({
    fullIllustrations: parsed.illustrationsEnabled,
    illustrationCadence: parsed.illustrationsEnabled ? "template-driven" : "manual",
    includeCover: includeCoverForSource(coverArtSource),
    coverArtSource,
    coverTemplate: bookType.coverTemplate,
    finalReview: quality.finalReview,
    toneProfile: bookType.toneProfile,
    generationStrategy: AUTO_BOOK_GENERATION_STRATEGY_ID,
    parallelPageGeneration: quality.parallelPageGeneration,
    draftCandidates: quality.draftCandidates,
    modelTier: quality.modelTier
  });
  const projectInput = createProjectSchema.parse({
    title: parsed.title ?? UNTITLED_MOBILE_PROJECT_TITLE,
    ...(parsed.authorName ? { authorName: parsed.authorName } : {}),
    prompt: parsed.prompt,
    category: bookType.category,
    subcategory: bookType.subcategory,
    templateSlug: bookType.templateSlug,
    targetPages,
    complexity: quality.complexity,
    temperature: quality.temperature,
    language: parsed.language,
    mediaSettings: baseMediaSettings
  });

  return {
    ...projectInput,
    mediaSettings: {
      ...projectInput.mediaSettings,
      mobile: mobileMetadata
    }
  };
}

export function bookTypeChoiceForMobileCreate(parsed: z.infer<typeof mobileProjectCreateBodySchema>): MobileBookTypeChoice | undefined {
  return parsed.bookTypeChoice ?? parsed.creationPayload?.selectedPresets?.bookTypeChoice ?? parsed.advisor?.recommendation.bookTypeChoice;
}

export function resolveMobilePageCount(
  payload: MobileCreationDraftPayload,
  selectedPresets: MobileCreationDraftPayload["selectedPresets"]
): MobilePageCountResolution {
  if (selectedPresets?.pageCountMode === "custom" && selectedPresets.targetPages) {
    return {
      resolved: true,
      targetPages: selectedPresets.targetPages,
      source: selectedPresets.pageCountSource ?? "settings",
      mode: "custom"
    };
  }
  const explicitTargetPages = explicitTargetPagesForMobilePayload(payload);
  if (explicitTargetPages) {
    return { resolved: true, targetPages: explicitTargetPages, source: "chat", mode: "custom" };
  }
  return { resolved: false };
}

export function presetsWithResolvedPageCount(
  presets: MobileCreationDraftPayload["selectedPresets"],
  pageCount: MobilePageCountResolution
): NonNullable<MobileCreationDraftPayload["selectedPresets"]> {
  if (!presets) {
    throw new Error("Cannot resolve page count without selected mobile presets.");
  }
  if (!pageCount.resolved) {
    return { ...presets, pageCountMode: presets.pageCountMode ?? "auto", pageCountSource: presets.pageCountSource ?? "legacy" };
  }
  return {
    ...presets,
    pageCountMode: "custom",
    targetPages: pageCount.targetPages,
    pageCountSource: pageCount.source
  };
}

export function deterministicPageCountRecommendations(
  payload: MobileCreationDraftPayload,
  advisor: MobileBookAdvisorResponse
): MobilePageCountRecommendationDto[] {
  const lane = advisor.recipe.lane === "auto" ? advisor.detectedLane : advisor.recipe.lane;
  const bookType = advisor.recommendation.bookType;
  if (lane === "workbook" || lane === "client_tool" || bookType === "workbook") {
    return [
      { targetPages: 16, label: "16 pages", description: "A focused workbook with a few exercises." },
      { targetPages: 28, label: "28 pages", description: "Recommended for lessons, examples, and practice." },
      { targetPages: 40, label: "40 pages", description: "A fuller workbook with more sections." }
    ];
  }
  if (lane === "children_story" || lane === "adult_story" || bookType === "short_story") {
    return [
      { targetPages: 4, label: "4 pages", description: "Very short and simple." },
      { targetPages: 8, label: "8 pages", description: "Recommended for a compact story arc." },
      { targetPages: 12, label: "12 pages", description: "More room for scenes and details." }
    ];
  }
  const hasLongNotes = payload.sourceNotes.trim().length > 1200;
  return [
    { targetPages: 8, label: "8 pages", description: "A quick, concise read." },
    { targetPages: hasLongNotes ? 18 : 12, label: hasLongNotes ? "18 pages" : "12 pages", description: "Recommended for a useful first draft." },
    { targetPages: 24, label: "24 pages", description: "More space for examples and depth." }
  ];
}

export function normalizePageCountRecommendations(
  recommendations: MobilePageCountRecommendationDto[],
  fallback: MobilePageCountRecommendationDto[]
): MobilePageCountRecommendationDto[] {
  const seen = new Set<number>();
  const cleaned: MobilePageCountRecommendationDto[] = [];
  for (const item of recommendations) {
    const parsed = mobilePageCountRecommendationSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.targetPages)) {
      continue;
    }
    seen.add(parsed.data.targetPages);
    cleaned.push(parsed.data);
    if (cleaned.length >= 4) {
      break;
    }
  }
  return cleaned.length >= 2 ? cleaned : fallback;
}

export async function createMobileProjectRecord(
  userId: string,
  input: MobileCreateProjectInput,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<MobileProjectRecord> {
  const template = await db.template.findFirst({
    where: input.templateSlug ? { slug: input.templateSlug } : { category: input.category }
  });
  return (await db.project.create({
    data: {
      userId,
      title: input.title ?? UNTITLED_MOBILE_PROJECT_TITLE,
      ...(input.authorName ? { authorName: input.authorName } : {}),
      prompt: input.prompt,
      category: input.category,
      ...(input.subcategory ? { subcategory: input.subcategory } : {}),
      targetPages: input.targetPages,
      complexity: input.complexity,
      temperature: input.temperature,
      language: input.language,
      mediaSettings: jsonInputValue(input.mediaSettings),
      ...(template ? { templateId: template.id } : {})
    },
    include: mobileProjectDetailInclude()
  })) as MobileProjectRecord;
}

export async function createReplanProjectCopy(options: {
  userId: string;
  sourceProject: ProjectForChat;
  request: string;
  operationId: string;
  targetLanguage?: string | null;
  /**
   * The generation settings the request named, already priced. They have to land
   * on the copy rather than on the plan alone: `mobile.targetPages` is what the
   * app's settings sheet reads, so a copy that keeps the source's number
   * describes itself as the length nobody asked for.
   */
  settings?: ReplanSettings | null;
  transaction?: Prisma.TransactionClient | undefined;
  attachToCreationSession?: boolean | undefined;
}): Promise<MobileProjectRecord> {
  const source = options.sourceProject;
  const targetLanguage = cleanTargetLanguage(options.targetLanguage);
  const settings = options.settings ?? {};
  const sourceMediaSettings = mediaSettingsWithReplanSettings(mediaSettingsSchema.parse(source.mediaSettings), settings);
  const mobileMetadata = jsonRecord(sourceMediaSettings.mobile);
  const copyMediaSettings = mediaSettingsSchema.parse({
    ...sourceMediaSettings,
    mobile: {
      ...mobileMetadata,
      revisionOfProjectId: source.id,
      revisionOperationId: options.operationId,
      revisionRequest: options.request,
      revisionSource: "project_chat_book_replan",
      ...(targetLanguage ? { revisionTargetLanguage: targetLanguage } : {})
    }
  });
  const db = options.transaction ?? prisma;
  const copy = (await db.project.create({
    data: {
      userId: options.userId,
      title: revisedCopyTitle(source.title),
      ...(source.subtitle ? { subtitle: source.subtitle } : {}),
      ...(source.authorName ? { authorName: source.authorName } : {}),
      ...(source.coverTagline ? { coverTagline: source.coverTagline } : {}),
      prompt: source.prompt,
      category: source.category,
      ...(source.subcategory ? { subcategory: source.subcategory } : {}),
      targetPages: settings.targetPages ?? source.targetPages,
      complexity: source.complexity,
      temperature: source.temperature,
      language: targetLanguage ?? source.language,
      mediaSettings: jsonInputValue(copyMediaSettings),
      status: "EDITING",
      ...(source.templateId ? { templateId: source.templateId } : {})
    },
    include: mobileProjectDetailInclude()
  })) as MobileProjectRecord;

  if (options.attachToCreationSession !== false) {
    await attachReplanCopyToCreationSession({
      sourceProjectId: source.id,
      copyProjectId: copy.id,
      copyTitle: copy.title
    });
  }
  return copy;
}

export async function attachReplanCopyToCreationSession(options: {
  sourceProjectId: string;
  copyProjectId: string;
  copyTitle: string;
}): Promise<void> {
  const sourceOutput = await prisma.mobileCreationOutput.findFirst({
    where: { projectId: options.sourceProjectId },
    include: { draft: { include: mobileCreationDraftOutputsInclude() } },
    orderBy: { createdAt: "desc" }
  });
  if (!sourceOutput?.draft) {
    return;
  }
  const parsed = mobileCreationDraftPayloadSchema.safeParse(sourceOutput.draft.payload);
  if (!parsed.success) {
    return;
  }
  await createCreationOutputForProject({
    draftId: sourceOutput.draftId,
    projectId: options.copyProjectId,
    title: options.copyTitle,
    existingOutputs: creationOutputsForDraft(sourceOutput.draft, parsed.data)
  });
  await prisma.mobileCreationDraft.update({
    where: { id: sourceOutput.draftId },
    data: { createdProjectId: options.copyProjectId, status: "ACTIVE" }
  });
}

export function revisedCopyTitle(title: string): string {
  const suffix = " (Revised)";
  if (title.endsWith(suffix)) {
    return title;
  }
  return `${title.slice(0, 160 - suffix.length)}${suffix}`;
}

export async function loadMobileProjectDetail(userId: string, projectId: string): Promise<MobileProjectRecord | null> {
  return (await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: mobileProjectDetailInclude()
  })) as MobileProjectRecord | null;
}

export function mobileProjectDetailInclude() {
  return {
    currentPlan: true,
    pages: {
      orderBy: { index: "asc" },
      select: {
        id: true,
        index: true,
        title: true,
        markdown: true,
        summary: true,
        status: true,
        imageFailureReason: true,
        images: {
          select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true },
          orderBy: { createdAt: "asc" }
        }
      }
    },
    images: { select: { id: true, projectId: true, pageId: true, type: true, path: true, metadata: true } },
    _count: { select: { pages: true, images: true, jobs: true } }
  } as const;
}

export async function queueInitialMobilePlan(
  userId: string,
  projectId: string,
  inputSnapshot: Record<string, unknown>
): Promise<MobilePlanOperationDto> {
  const planCost = creditCostForOperation("PLAN_GENERATION");
  const started = await startGenerationAttempt({
    userId,
    commandKey: `mobile:project-initial-plan:${projectId}`,
    requestFingerprint: fingerprintGenerationRequest({ projectId, inputSnapshot }),
    projectId,
    operation: "PLAN_GENERATION",
    quotedCredits: planCost,
    description: "Mobile plan generation",
    metadata: { initialPlan: true },
    create: async (tx, { attemptId, ledgerEntry }) => {
      const job = await enqueueGenerationJob({
        projectId,
        type: "PLAN_BOOK",
        dedupeKey: `plan-book:${projectId}`,
        transaction: tx,
        dispatch: false,
        attemptId,
        payload: {
          inputSnapshot,
          ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
        }
      });
      await tx.project.update({ where: { id: projectId }, data: { status: "PLANNING" } });
      return { projectId, primaryJobId: job.id };
    }
  });
  const job = started.attempt.primaryJobId
    ? await dispatchGenerationJob(started.attempt.primaryJobId)
    : null;
  if (!job) {
    throw new Error("Generation attempt has no primary job.");
  }
  return planOperation("planning_queued", projectId, null, job, "Creating your book plan.");
}
