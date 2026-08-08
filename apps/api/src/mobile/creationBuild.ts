import {
  adviseMobileBook,
  authorForMobilePayload,
  briefForMobilePayload,
  composeMobileProjectPrompt,
  mergeMobileCreationPresets,
  mobileBookAdvisorResponseSchema,
  mobileCreationDraftPayloadSchema,
  titleForMobilePayload,
  type MobileBookAdvisorResponse,
  type MobileCreationDraftPayload,
} from "../mobileCreation.js";
import { dispatchGenerationJob, enqueueGenerationJob } from "../queue.js";
import {
  _chatTitleForPayload,
  conversationMessagesFromPayload,
  createCreationOutputForProject,
  creationOutputsForDraft,
  mobileCreationDraftOutputsInclude,
  serializeCreationOutput,
  updateCreationDraftCas
} from "./creationSessions.js";
import {
  type FinalizeOutcome,
  type MobileCreationBuildOverrides,
  type MobileCreationFinalizeResponseDto,
  type MobileCreationOutputRecord,
  type MobilePageCountRecommendationDto,
  type MobilePlanOperationDto,
  type MobileProjectRecord
} from "./dto.js";
import { sendInsufficientCredits, sendMobileError } from "./httpErrors.js";
import {
  buildMobileCreateProjectInput,
  createMobileProjectRecord,
  deterministicPageCountRecommendations,
  loadMobileProjectDetail,
  normalizePageCountRecommendations,
  presetsWithResolvedPageCount,
  resolveMobilePageCount
} from "./projectRecords.js";
import { inputSnapshotFromProject, planOperation, serializeProjectDetail } from "./projectSerializers.js";
import {
  mobilePageCountRecommendationAiSchema
} from "./schemas.js";
import { fingerprintGenerationRequest, jsonInputValue, promiseWithTimeout } from "./support.js";
import {
  createFastRoutingTextModel,
  creditCostForOperation,
  generateJsonWithRetry,
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import {
  GenerationAttemptConflictError,
  InsufficientCreditsError,
  startGenerationAttempt
} from "@book-maker/db/billing";
import { type FastifyReply } from "fastify";
import type { MobileRouteContext } from "./routeContext.js";
import { assessCurrentContentRestrictions } from "../contentRestrictions.js";

class CreationSessionConflictError extends Error {
  constructor() {
    super("Creation session changed before the build started.");
    this.name = "CreationSessionConflictError";
  }
}

/**
 * The creation "build" step: turn an accepted creation draft into a real
 * Project, resolving page count and charging credits along the way.
 *
 * Exposed as a factory because these helpers close over the route context
 * (config, rate limiters, AI enrichment hooks). Both the creation-session and
 * the legacy creation-draft routes build their own copy.
 */
export function createCreationBuildHelpers(context: MobileRouteContext) {
  const { appConfig, options, advisorEnrichment } = context;

  async function prepareMobileCreationBuild(
    userId: string,
    draftId: string,
    overrides: MobileCreationBuildOverrides = {}
  ) {
    const draft = await prisma.mobileCreationDraft.findFirst({
      where: { id: draftId, userId },
      include: mobileCreationDraftOutputsInclude()
    });
    if (!draft) {
      return { ok: false as const, status: 404, code: "DRAFT_NOT_FOUND", message: "Creation draft not found." };
    }
    if (draft.status !== "ACTIVE" && draft.status !== "COMPLETED") {
      return { ok: false as const, status: 409, code: "DRAFT_NOT_ACTIVE", message: "This creation draft is not available for building." };
    }

    const parsedPayload = mobileCreationDraftPayloadSchema.safeParse(draft.payload);
    if (!parsedPayload.success) {
      return {
        ok: false as const,
        status: 400,
        code: "VALIDATION_ERROR",
        message: "This creation draft needs to be updated before it can create a project."
      };
    }

    const mergedPresets = overrides.presets
      ? mergeMobileCreationPresets(parsedPayload.data.selectedPresets, overrides.presets)
      : parsedPayload.data.selectedPresets;
    const mergedPayload: MobileCreationDraftPayload = {
      ...parsedPayload.data,
      ...(mergedPresets ? { selectedPresets: mergedPresets } : {}),
      ...(overrides.sourceNotes !== undefined ? { sourceNotes: overrides.sourceNotes } : {}),
      ...(overrides.optionalDetails ? { optionalDetails: overrides.optionalDetails } : {})
    };
    const restriction = await assessCurrentContentRestrictions(
      [
        mergedPayload.rawIdea ?? "",
        mergedPayload.sourceNotes ?? "",
        JSON.stringify(mergedPayload.optionalDetails ?? {})
      ].join("\n")
    );
    if (!restriction.allowed) {
      return {
        ok: false as const,
        status: 422,
        code: restriction.reason === "copyright" ? "COPYRIGHT_RESTRICTED" : "CONTENT_RESTRICTED",
        message: restriction.message
      };
    }
    const advisorFromDraft = mobileBookAdvisorResponseSchema.safeParse(draft.advisorSnapshot);
    const advisor = advisorFromDraft.success
      ? advisorFromDraft.data
      : await adviseMobileBook(mergedPayload, {
          enrich: advisorEnrichment,
          timeoutMs: options.advisorTimeoutMs
        });
    const selectedPresets = mergedPayload.selectedPresets ?? advisor.recommendation;
    const unresolvedAuto = selectedPresets.bookTypeChoice === "auto";
    const effectiveAdvisor = unresolvedAuto && advisor.detectedLane !== "auto"
      ? await adviseMobileBook(
          mobileCreationDraftPayloadSchema.parse({
            ...mergedPayload,
            selectedPresets: { ...selectedPresets, bookTypeChoice: "auto" },
            detectedLane: "auto",
            recipe: undefined
          }),
          { enrich: advisorEnrichment, timeoutMs: options.advisorTimeoutMs }
        )
      : advisor;
    const finalPayload = mobileCreationDraftPayloadSchema.parse({
      ...mergedPayload,
      selectedPresets,
      detectedLane: unresolvedAuto ? effectiveAdvisor.detectedLane : mergedPayload.detectedLane ?? effectiveAdvisor.detectedLane,
      recipe: unresolvedAuto ? effectiveAdvisor.recipe : mergedPayload.recipe ?? effectiveAdvisor.recipe
    });
    const finalAdvisor: MobileBookAdvisorResponse = {
      ...effectiveAdvisor,
      recommendation: selectedPresets,
      detectedLane: finalPayload.detectedLane ?? effectiveAdvisor.detectedLane,
      recipe: finalPayload.recipe ?? effectiveAdvisor.recipe
    };
    return {
      ok: true as const,
      draft,
      selectedPresets,
      finalPayload,
      finalAdvisor,
      pageCount: resolveMobilePageCount(finalPayload, selectedPresets)
    };
  }

  async function finalizeMobileCreationDraft(
    userId: string,
    draftId: string,
    overrides: MobileCreationBuildOverrides = {},
    options: { requireResolvedPageCount?: boolean } = {}
  ): Promise<FinalizeOutcome> {
    const prepared = await prepareMobileCreationBuild(userId, draftId, overrides);
    if (!prepared.ok) {
      return prepared;
    }
    if (options.requireResolvedPageCount && !prepared.pageCount.resolved) {
      return { ok: false, status: 409, code: "PAGE_COUNT_REQUIRED", message: "Choose how many pages this book should be before building the plan." };
    }

    const { draft } = prepared;
    const buildRequestId = overrides.requestId ?? `legacy-build-${draftId}-${draft.revision ?? 1}`;
    const selectedPresets = presetsWithResolvedPageCount(prepared.selectedPresets, prepared.pageCount);
    const finalPayload = mobileCreationDraftPayloadSchema.parse({
      ...prepared.finalPayload,
      selectedPresets
    });
    const finalAdvisor: MobileBookAdvisorResponse = {
      ...prepared.finalAdvisor,
      recommendation: selectedPresets
    };

    const input = buildMobileCreateProjectInput({
      bookType: selectedPresets.bookType,
      bookTypeChoice: selectedPresets.bookTypeChoice,
      lengthPreset: selectedPresets.lengthPreset,
      qualityPreset: selectedPresets.qualityPreset,
      imagesEnabled: selectedPresets.imagesEnabled,
      coverEnabled: selectedPresets.coverEnabled,
      illustrationsEnabled: selectedPresets.illustrationsEnabled,
      pageCountMode: selectedPresets.pageCountMode,
      targetPages: selectedPresets.targetPages,
      pageCountSource: selectedPresets.pageCountSource,
      title: titleForMobilePayload(finalPayload, finalAdvisor),
      authorName: authorForMobilePayload(finalPayload),
      prompt: composeMobileProjectPrompt(finalPayload, finalAdvisor),
      language: overrides.language ?? prepared.finalPayload.language ?? "en",
      creationBrief: briefForMobilePayload(finalPayload, finalAdvisor),
      creationPayload: finalPayload,
      advisor: finalAdvisor
    });
    const planCost = creditCostForOperation("PLAN_GENERATION");
    let project: MobileProjectRecord | null = null;
    let output: MobileCreationOutputRecord;
    let operation: MobilePlanOperationDto | null = null;
    let createdOutput: MobileCreationOutputRecord | null = null;
    let claimedRevision: number | null = null;
    try {
      const started = await startGenerationAttempt({
        userId,
        commandKey: `mobile:creation-build:${draftId}:${buildRequestId}`,
        requestFingerprint: fingerprintGenerationRequest({ draftId, buildRequestId, input }),
        operation: "PLAN_GENERATION",
        quotedCredits: planCost,
        description: "Mobile plan generation",
        metadata: { draftId, buildRequestId },
        create: async (tx, { attemptId, ledgerEntry }) => {
          const claimed = await updateCreationDraftCas({
            draft,
            expectedRevision: overrides.expectedRevision,
            data: {
              status: "ACTIVE",
              advisorSnapshot: jsonInputValue(finalAdvisor),
              payload: jsonInputValue(finalPayload)
            },
            transaction: tx
          });
          if (!claimed) {
            throw new CreationSessionConflictError();
          }
          claimedRevision = claimed.revision;
          const createdProject = await createMobileProjectRecord(userId, input, tx);
          project = createdProject;
          createdOutput = await createCreationOutputForProject({
            draftId,
            projectId: createdProject.id,
            requestId: buildRequestId,
            title: createdProject.title,
            existingOutputs: creationOutputsForDraft(draft, finalPayload),
            transaction: tx
          });
          await tx.project.update({ where: { id: createdProject.id }, data: { status: "PLANNING" } });
          const durableJob = await enqueueGenerationJob({
            projectId: createdProject.id,
            type: "PLAN_BOOK",
            dedupeKey: `plan-book:${createdProject.id}`,
            transaction: tx,
            dispatch: false,
            attemptId,
            payload: {
              inputSnapshot: inputSnapshotFromProject(createdProject),
              ...(ledgerEntry ? { billingLedgerEntryId: ledgerEntry.id } : {})
            }
          });
          await tx.mobileCreationDraft.update({
            where: { id: draftId },
            data: {
              status: "ACTIVE",
              advisorSnapshot: jsonInputValue(finalAdvisor),
              createdProjectId: createdProject.id,
              revision: { increment: 1 }
            }
          });
          return { projectId: createdProject.id, primaryJobId: durableJob.id };
        }
      });
      if (!started.attempt.projectId || !started.attempt.primaryJobId) {
        throw new Error("Creation attempt is missing its project or primary job.");
      }
      project = project ?? (await loadMobileProjectDetail(userId, started.attempt.projectId));
      if (!project) {
        throw new Error("Created project could not be loaded.");
      }
      const loadedOutput =
        createdOutput ??
        (await prisma.mobileCreationOutput.findFirst({
          where: { draftId, requestId: buildRequestId },
          include: { project: { select: { title: true, updatedAt: true } } }
        }));
      if (!loadedOutput) {
        throw new Error("Created output could not be loaded.");
      }
      output = loadedOutput;
      const durableJob = await dispatchGenerationJob(started.attempt.primaryJobId);
      if (!durableJob) {
        throw new Error("Creation attempt has no durable job.");
      }
      operation = planOperation("planning_queued", project.id, null, durableJob, "Creating your book plan.");
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return { ok: false, insufficient: error };
      }
      if (error instanceof GenerationAttemptConflictError) {
        return { ok: false, status: 409, code: error.code, message: error.message };
      }
      if (error instanceof CreationSessionConflictError) {
        return {
          ok: false,
          status: 409,
          code: "SESSION_CONFLICT",
          message: "This chat changed elsewhere. Reload it before building."
        };
      }
      throw error;
    }
    const refreshedProject = (await loadMobileProjectDetail(userId, project.id)) ?? project;
    const latestDraft = await prisma.mobileCreationDraft.findUnique({
      where: { id: draftId },
      select: { revision: true }
    });
    return {
      ok: true,
      project: await serializeProjectDetail(refreshedProject, appConfig, userId),
      output: serializeCreationOutput(output),
      operation,
      sessionRevision: latestDraft?.revision ?? claimedRevision ?? draft.revision ?? 1
    };
  }

  async function pageCountRecommendationsForPreflight(
    payload: MobileCreationDraftPayload,
    advisor: MobileBookAdvisorResponse
  ): Promise<MobilePageCountRecommendationDto[]> {
    const fallback = deterministicPageCountRecommendations(payload, advisor);
    try {
      const textModel = createFastRoutingTextModel(appConfig);
      const result = await promiseWithTimeout(
        generateJsonWithRetry(textModel, {
          purpose: "mobile-page-count-preflight",
          temperature: 0.2,
          maxTokens: 700,
          schema: mobilePageCountRecommendationAiSchema,
          messages: [
            {
              role: "system",
              content:
                "Recommend 2-4 practical page counts for a mobile book creator. Keep options concise. Do not mention AI models, providers, tokens, billing, or internal systems."
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  chat: conversationMessagesFromPayload(payload)
                    .slice(-20)
                    .map((message) => ({ role: message.role, content: message.content })),
                  rawIdea: payload.rawIdea,
                  sourceNotesPreview: payload.sourceNotes.slice(0, 600),
                  detectedLane: advisor.detectedLane,
                  recipe: advisor.recipe,
                  fallback
                },
                null,
                2
              )
            }
          ]
        }),
        options.pageCountRecommendationTimeoutMs ?? 2500
      );
      return normalizePageCountRecommendations(result.data.recommendations, fallback);
    } catch {
      return fallback;
    }
  }

  return { prepareMobileCreationBuild, finalizeMobileCreationDraft, pageCountRecommendationsForPreflight };
}

export function sendFinalizeOutcome(reply: FastifyReply, outcome: FinalizeOutcome): FastifyReply {
  if (outcome.ok) {
    return reply.code(201).send({
      project: outcome.project,
      output: outcome.output,
      operation: outcome.operation,
      sessionRevision: outcome.sessionRevision
    } satisfies MobileCreationFinalizeResponseDto);
  }
  if ("insufficient" in outcome) {
    return sendInsufficientCredits(reply, outcome.insufficient);
  }
  return sendMobileError(reply, outcome.status, outcome.code, outcome.message);
}
