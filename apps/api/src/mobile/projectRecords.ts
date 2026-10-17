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
import { laneFromBookTypeChoice, productBookTypeForLane } from "../mobileCreationLanes.js";
import { type MobileCreationLane } from "../mobileCreationSchemas.js";
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
import { authorDefaultsForNewBook } from "./authorProfile.js";
import { type ProjectForChat } from "./projectChat.js";
import { planOperation } from "./projectStatusSerializers.js";
import {
  MOBILE_AUTO_BOOK_TYPE_SETTINGS,
  MOBILE_BOOK_TYPE_SETTINGS,
  MOBILE_CHILDREN_STORY_SETTINGS,
  MOBILE_PRODUCT_PRESETS,
  MOBILE_TITLE_SOURCE_PLANNER_PENDING,
  UNTITLED_MOBILE_PROJECT_TITLE,
  mobileComposedProjectCreateSchema,
  mobilePageCountRecommendationAiSchema,
  mobileProjectCreateBodySchema
} from "./schemas.js";
import { cleanTargetLanguage, fingerprintGenerationRequest, jsonInputValue, jsonRecord, jsonValue } from "./support.js";
import {
  AUTO_BOOK_GENERATION_STRATEGY_ID,
  createProjectSchema,
  includeCoverForSource,
  maxGeneratedBookPages,
  mediaSettingsSchema,
  mediaSettingsWithReplanSettings,
  normalizeProjectLanguage,
  parseBookMatter,
  planGenerationCreditCost,
  type ReplanSettings
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { GenerationAttemptConflictError, startGenerationAttempt } from "@book-maker/db/billing";
import { z } from "zod";
import { requestedPageCountScope } from "./pageCountScope.js";
import { manuscriptSummarySelect } from "./manuscript/manuscriptSerializers.js";
import { aiWorkKindForTier, assertAiCapacity, speculativeWorkAllowed } from "./aiCapacity.js";
import { UltraTierUnavailableError, ultraTierRefused } from "./ultraTier.js";

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
  const lane = resolvedMobileCreationLane(parsed, bookTypeChoice);
  // Auto settles on a lane during the chat, and that lane is what the book is
  // filed under: left CUSTOM, a "practical guide" the chat agreed to was
  // written as cue-word prose and never reached the toolkit path. The stored
  // `mobile.bookType` stays "custom" and the choice stays "auto".
  const bookType =
    lane === "children_story" && (isAutoBookType || parsed.bookType === "short_story")
      ? MOBILE_CHILDREN_STORY_SETTINGS
      : !isAutoBookType
        ? MOBILE_BOOK_TYPE_SETTINGS[parsed.bookType]
        : lane
          ? MOBILE_BOOK_TYPE_SETTINGS[productBookTypeForLane(lane)]
          : MOBILE_AUTO_BOOK_TYPE_SETTINGS;
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
    toneProfile: bookType.toneProfile,
    generationStrategy: AUTO_BOOK_GENERATION_STRATEGY_ID,
    ...(quality.parallelPageGeneration !== undefined
      ? { parallelPageGeneration: quality.parallelPageGeneration }
      : {}),
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

/**
 * The lane a book is being made in: the reader's concrete choice, else (Auto)
 * the lane the creation chat or advisor resolved — the same recipe lane
 * `toolkitBookKind` reads back off the stored metadata.
 */
export function resolvedMobileCreationLane(
  parsed: z.infer<typeof mobileProjectCreateBodySchema>,
  bookTypeChoice: MobileBookTypeChoice | undefined
): MobileCreationLane | undefined {
  const chosen = laneFromBookTypeChoice(bookTypeChoice);
  if (chosen) return chosen;
  return [
    parsed.creationPayload?.recipe?.lane,
    parsed.creationPayload?.detectedLane,
    parsed.advisor?.recipe.lane,
    parsed.advisor?.detectedLane
  ].find((lane): lane is MobileCreationLane => lane !== undefined && lane !== "auto");
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
  const presets = payload.selectedPresets ?? advisor.recommendation;
  const choice = presets.bookTypeChoice;
  // Auto is unresolved. The legacy product field is a compatibility value,
  // not a book type the user chose, and may outlive a switch back to Auto.
  const legacyBookType = choice === undefined ? presets.bookType : undefined;
  // Auto lists the lane the chat resolved, once it has resolved one.
  const resolvedAutoLane = [payload.recipe?.lane, advisor.recipe.lane].find((candidate) => candidate && candidate !== "auto");
  const lane = choice === "auto"
    ? resolvedAutoLane ?? "auto"
    : choice && choice !== "short_story"
      ? choice
      : advisor.recipe.lane === "auto" ? advisor.detectedLane : advisor.recipe.lane;
  const hasLongNotes = (payload.sourceNotes || payload.brief?.sourceNotes || "").trim().length > 1200;
  let options: [number, string][];
  if (lane === "auto" && !legacyBookType) {
    options = [
      [8, "A focused version of the central idea, with limited supporting material."],
      [hasLongNotes ? 18 : 12, "Room to develop the central idea and include supporting detail."],
      [24, "More room for depth, supporting material, and secondary elements."]
    ];
  } else if (lane === "children_story") {
    options = [
      [4, "A simple read-aloud with one event and a clear ending."],
      [8, "A complete read-aloud arc with room for repetition and picture-led scenes."],
      [12, "More story beats and character moments while keeping scenes short for young readers."]
    ];
  } else if (lane === "adult_story" || choice === "short_story" || legacyBookType === "short_story") {
    options = [
      [12, "A focused adult short story built around one conflict and a small cast."],
      [24, "Room to develop the adult story's characters, tension, and resolution across several scenes."],
      [48, "A longer adult story with layered character development and secondary conflicts."]
    ];
  } else if (lane === "workbook" || lane === "client_tool" || legacyBookType === "workbook") {
    options = [
      [16, "A focused set of lessons and exercises for practicing the core skill."],
      [28, "Lessons, worked examples, and space for readers to practice each step."],
      [40, "More practice rounds, reflection prompts, and examples across the workbook's topics."]
    ];
  } else {
    options = [
      [8, "The core advice and a short action checklist for a quick read."],
      [hasLongNotes ? 18 : 12, "Room to explain the main ideas with examples and clear next steps."],
      [24, "Deeper explanations, additional examples, and more supporting source material."]
    ];
  }
  const requestedScope = requestedPageCountScope(payload);
  const presetIndex = hasLongNotes || presets.lengthPreset === "expanded"
    ? 2 : presets.lengthPreset === "short" ? 0 : 1;
  const recommendedIndex = requestedScope?.depth === "concise"
    ? 0
    : Math.max(presetIndex, requestedScope ? { balanced: 1, expanded: 2 }[requestedScope.depth] : 0);
  const reason = requestedScope
    ? ` ${requestedScope.reason}`
    : hasLongNotes
      ? " Best fit for the amount of source material."
      : recommendedIndex === 0
        ? " Fits your preference for a short read."
        : recommendedIndex === 2
          ? " Fits your preference for expanded coverage."
          : " Fits your preference for standard coverage.";
  return options.map(([targetPages, description], index) => ({
    targetPages,
    label: ["Concise", "Balanced", "Expanded"][index]!,
    description: description + (index === recommendedIndex ? reason : ""),
    isRecommended: index === recommendedIndex
  }));
}

export function normalizePageCountRecommendations(
  recommendations: unknown,
  fallback: MobilePageCountRecommendationDto[]
): MobilePageCountRecommendationDto[] {
  const parsed = mobilePageCountRecommendationAiSchema.safeParse({ recommendations });
  // A length past the generated-book ceiling (`paidMaxBookPages`) would be
  // refused at Build, so a model that offers one is not believed at all.
  const ceiling = maxGeneratedBookPages();
  return parsed.success && parsed.data.recommendations.every((option) => option.targetPages <= ceiling)
    ? parsed.data.recommendations.sort((a, b) => a.targetPages - b.targetPages)
    : fallback;
}

export async function createMobileProjectRecord(
  userId: string,
  input: MobileCreateProjectInput,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<MobileProjectRecord> {
  const [template, author] = await Promise.all([
    db.template.findFirst({
      where: input.templateSlug ? { slug: input.templateSlug } : { category: input.category }
    }),
    // The book's copy of its owner's author profile: the pen name unless the
    // creation named an author, and the matter pages (`authorProfile.ts`).
    authorDefaultsForNewBook(userId, db)
  ]);
  const authorName = input.authorName ?? author.authorName;
  return (await db.project.create({
    data: {
      userId,
      title: input.title ?? UNTITLED_MOBILE_PROJECT_TITLE,
      ...(authorName ? { authorName } : {}),
      ...(author.bookMatter ? { bookMatter: jsonInputValue(author.bookMatter) } : {}),
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
  const { bookMatter } = replanCopyBookMatter(source, targetLanguage);
  const copy = (await db.project.create({
    data: {
      userId: options.userId,
      title: revisedCopyTitle(source.title),
      ...(source.subtitle ? { subtitle: source.subtitle } : {}),
      ...(source.authorName ? { authorName: source.authorName } : {}),
      ...(bookMatter !== undefined ? { bookMatter: jsonInputValue(bookMatter) } : {}),
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

/** The matter fields that are the reader's own prose, written in the book's language. */
export type ReplanCopyWithheldMatter = "dedication" | "aboutAuthor";

/**
 * The matter a replan copy starts with, and the prose it leaves behind.
 *
 * The rebuilt book is the same book to its reader, so its dedication,
 * publication details and biography come with it verbatim, as its byline does.
 * A copy rebuilt in another language is the exception: the compile prints every
 * matter label in the copy's language and nothing translates the reader's own
 * prose, so a Spanish copy printed "Sobre el autor" over the English biography.
 * Translating it is not this path's to do — matter is the reader's words, never
 * generated (core `schemas/bookMatter.ts`), and a dedication or biography a
 * model writes prints only past the grounding review the chat's matter composer
 * runs. So a translation keeps the fields that read the same in any language
 * (website, © holder and year, imprint, ISBN, the rights toggle) and withholds
 * the dedication and the biography; the apply reply names what stayed behind.
 */
export function replanCopyBookMatter(
  source: { bookMatter: unknown; language: string },
  targetLanguage: string | null
): { bookMatter: unknown; withheld: ReplanCopyWithheldMatter[] } {
  if (source.bookMatter === null || source.bookMatter === undefined) return { bookMatter: undefined, withheld: [] };
  const changesLanguage =
    targetLanguage !== null &&
    normalizeProjectLanguage(targetLanguage).toLowerCase() !== normalizeProjectLanguage(source.language).toLowerCase();
  if (!changesLanguage) return { bookMatter: source.bookMatter, withheld: [] };
  const { dedication, aboutAuthor, ...neutral } = parseBookMatter(source.bookMatter);
  const withheld: ReplanCopyWithheldMatter[] = [
    ...(dedication ? (["dedication"] as const) : []),
    ...(aboutAuthor ? (["aboutAuthor"] as const) : [])
  ];
  return { bookMatter: Object.keys(neutral).length > 0 ? neutral : undefined, withheld };
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

/**
 * What a project *summary* reads: the cover alone rather than every page
 * visual, counts rather than rows, and the working copy's word and chapter
 * tallies for Studio books (one nested select; no chapter markdown).
 */
export function mobileProjectSummaryInclude() {
  return {
    currentPlan: true,
    images: { where: { type: "COVER" }, orderBy: { createdAt: "desc" }, take: 1 },
    _count: { select: { pages: true, images: true, jobs: true } },
    manuscript: manuscriptSummarySelect
  } as const;
}

export function mobileProjectDetailInclude() {
  return {
    currentPlan: true,
    manuscript: manuscriptSummarySelect,
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
  const input = createProjectSchema.parse(inputSnapshot);
  const planQuote = planGenerationCreditCost(input);
  const commandKey = `mobile:project-initial-plan:${projectId}`;
  const dedupeKey = `plan-book:${projectId}`;
  const existingAttempt = await prisma.generationAttempt.findUnique({
    where: { commandKey },
    select: { id: true }
  });
  if (!existingAttempt) {
    const [project, existingJob] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: { currentPlanId: true }
      }),
      prisma.generationJob.findUnique({
        where: { dedupeKey },
        select: { id: true }
      })
    ]);
    if (project?.currentPlanId) {
      throw new GenerationAttemptConflictError("This project already has a plan.");
    }
    if (existingJob) {
      throw new GenerationAttemptConflictError("Planning has already started for this project.");
    }
    // A start, not a replay of one already paid for: a new book may not start
    // at Ultra while the operator has it off (`ultraTier.ts`), and the spend
    // breaker answers before anything is reserved.
    if (ultraTierRefused(planQuote.modelTier)) {
      throw new UltraTierUnavailableError();
    }
    await assertAiCapacity(userId, aiWorkKindForTier(planQuote.modelTier));
  }
  // Whether the plan's composition prep may be queued after it (harness redesign H4): speculative, unbilled work.
  const prepareComposition = await speculativeWorkAllowed(userId);
  const started = await startGenerationAttempt({
    userId,
    commandKey,
    requestFingerprint: fingerprintGenerationRequest({ projectId, inputSnapshot }),
    projectId,
    operation: "PLAN_GENERATION",
    quotedCredits: planQuote.credits,
    description: "Mobile plan generation",
    metadata: {
      initialPlan: true,
      modelTier: planQuote.modelTier,
      pricingKey: planQuote.pricingKey
    },
    create: async (tx, { attemptId, ledgerEntry }) => {
      const project = await tx.project.findUnique({
        where: { id: projectId },
        select: { currentPlanId: true }
      });
      if (project?.currentPlanId) {
        throw new GenerationAttemptConflictError("This project already has a plan.");
      }
      // Race-safe twin of the `existingJob` read above, and it has to run
      // *before* the enqueue rather than over what the enqueue returns:
      // `enqueueGenerationJob` refuses this exact disagreement itself now, with
      // a `GenerationAttemptJobClaimError` that answers 500 because a shared
      // guard cannot attribute the fault. Here it has a name — a row under
      // `plan-book:<projectId>` means planning already started, and a failed one
      // is retried for a fresh charge through the resume route, never by
      // re-running this command — so this claims the answer first and gives the
      // app a 409 with a sentence. `startGenerationAttempt`'s own
      // `assertPrimaryJobBelongsToAttempt` remains the third net. All three
      // throw inside the attempt transaction, so all three roll the charge back.
      const spentPlanJob = await tx.generationJob.findUnique({
        where: { dedupeKey },
        select: { attemptId: true }
      });
      if (spentPlanJob && spentPlanJob.attemptId !== attemptId) {
        throw new GenerationAttemptConflictError("Planning has already started for this project.");
      }
      const job = await enqueueGenerationJob({
        projectId,
        type: "PLAN_BOOK",
        dedupeKey,
        transaction: tx,
        dispatch: false,
        attemptId,
        payload: {
          inputSnapshot,
          ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {}),
          ...(prepareComposition ? { prepareComposition: true } : {})
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
