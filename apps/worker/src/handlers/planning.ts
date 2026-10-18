import {
  getProjectOrThrow,
  nextPlanVersion,
  planInputSnapshot,
  planMediaSettingsSnapshot,
  strategyForInput
} from "../generation/bookHelpers.js";
import { strategyUsesSemanticMemory } from "../generation/embeddingWrites.js";
import { planRevisionConsistencyWarning } from "../generation/planRevisionSafety.js";
import {
  authoritativeReplanMessage,
  resolveEditPromptContext
} from "../generation/editOperationContext.js";
import {
  inputForPlanVersion,
  inputFromProject,
  inputFromSnapshot,
  inputWithMessageMediaPreferences,
  inputWithMobileSourceMaterial
} from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { newlyTakenSeriesEndingFacts, withSeriesEndingFacts } from "../generation/seriesEndingFacts.js";
import { config } from "../runtime/config.js";
import { advanceJobStep, editOperationIdFromJob } from "../runtime/jobLifecycle.js";
import type { JobCompletion } from "../runtime/jobTypes.js";
import { jsonPayloadToRecord } from "../runtime/serialization.js";
import { applyPlanThinkingBoost, loadQualityContext } from "../generation/qualitySettings.js";
import { claimPlanningCompletion } from "../runtime/planningCompletion.js";
import { preparePlanningResearch, savePlanningResearch } from "./planningResearch.js";
import { prepareCompositionDedupeKey, withoutPreparedFields } from "../generation/composedPrepRecord.js";
import { enqueueWorkerJob } from "../runtime/dispatch.js";
import { bookPlanSchema, createProviders, explicitLanguageRequest, isRecord, mediaSettingsRowWriteback, mediaSettingsWithBookSeries, normalizeProjectLanguage, seedStoryStateFromPromises, type BookGenerationStrategy } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import type { PlanBookJob, RevisePlanJob } from "../runtime/jobPayloads.js";

/**
 * `plan-book` and `revise-plan` jobs: research a brief and turn it into a BookPlan.
 */

export async function planBook(job: PlanBookJob): Promise<JobCompletion> {
  const { projectId, inputSnapshot, generationJobId } = job.data;
  const project = await getProjectOrThrow(projectId);
  const storedInput = inputFromSnapshot(inputSnapshot) ?? inputFromProject(project);
  const strategy = strategyForInput(storedInput);
  const providers = createLoggedProviders(job, createProviders(config, storedInput), storedInput);
  const quality = await loadQualityContext(storedInput);
  applyPlanThinkingBoost(providers.text, quality.enabled("planThinkingBoost"));
  // A continuation reads its earlier book's last chapter once, before the plan
  // and the plan version's snapshot, so both carry what that ending fixed.
  const input = await withSeriesEndingFacts(storedInput, providers.text, projectId);
  const plan = await strategy.createPlan({
    // Planning sees pasted notes and uploaded-file digests; the stored
    // snapshot below stays clean so page generation input is unchanged.
    input: inputWithMobileSourceMaterial(input),
    textModel: providers.text,
    research: providers.research,
    forceFallback: config.MOCK_AI,
    onPhase: async (phase) => {
      switch (phase) {
        case "understand":
          await advanceJobStep(generationJobId, "research", 20, "Understanding your idea");
          break;
        case "shape":
          await advanceJobStep(generationJobId, "plan", 45, "Shaping the chapters and flow");
          break;
        case "finalize":
          await advanceJobStep(generationJobId, "save", 80, "Finalizing your plan");
          break;
      }
    }
  });
  const version = await nextPlanVersion(projectId);
  const research = strategyUsesSemanticMemory(strategy)
    ? await preparePlanningResearch(projectId, plan.researchNotes, providers.embedding)
    : new Map();

  const planVersionId = await prisma.$transaction(async (tx) => {
    // Output, readiness and the paid verdict are indivisible. A crash after
    // this commit is handled by the processor's existing COMPLETED replay.
    await claimPlanningCompletion(tx, job, {
      currentPlanId: project.currentPlanId,
      contentRevision: project.contentRevision
    });
    const planVersion = await tx.planVersion.create({
      data: {
        projectId,
        version,
        planningPackage: plan,
        inputSnapshot: planInputSnapshot(input),
        messages: []
      }
    });

    // The ending's facts reach the row too, merged onto the live row's
    // settings the way a revision's write-back is, so a rebuild of this book
    // does not read the earlier book's last chapter again.
    const seriesTaken = newlyTakenSeriesEndingFacts(storedInput, input);
    const liveRow = seriesTaken ? await tx.project.findUnique({ where: { id: projectId }, select: { mediaSettings: true } }) : null;
    await tx.project.update({
      where: { id: projectId },
      data: {
        currentPlanId: planVersion.id, title: plan.title, status: "PLAN_READY",
        storyState: seedStoryStateFromPromises(plan.promises ?? []) as Prisma.InputJsonValue,
        ...(seriesTaken ? { mediaSettings: mediaSettingsWithBookSeries(liveRow?.mediaSettings ?? {}, seriesTaken) as Prisma.InputJsonValue } : {})
      }
    });

    await tx.character.deleteMany({ where: { projectId } });
    await tx.location.deleteMany({ where: { projectId } });

    if (plan.characters.length > 0) {
      await tx.character.createMany({
        data: plan.characters.map((character) => ({
          projectId,
          name: character.name,
          role: character.role,
          description: character.description,
          traits: character.traits,
          visualRules: character.visualRules
        }))
      });
    }

    if (plan.locations.length > 0) {
      await tx.location.createMany({
        data: plan.locations.map((location) => ({
          projectId,
          name: location.name,
          description: location.description,
          rules: location.rules
        }))
      });
    }

    await savePlanningResearch(tx, projectId, plan.researchNotes, research);
    return planVersion.id;
  });
  return {
    durableCompletionCommitted: true,
    ...(job.data.prepareComposition ? { afterJobCompleted: () => queueCompositionPrep(projectId, planVersionId, strategy) } : {})
  };
}

/**
 * Queues the speculative composition prep for a plan a reader is about to read (harness redesign H4,
 * `handlers/prepareComposition.ts`): only for a composed book, only while the plan is still the project's
 * current one, and never as part of the plan's own paid attempt. Best-effort: a plan without a prep is a plan
 * whose book run makes those calls itself.
 */
async function queueCompositionPrep(projectId: string, planId: string, strategy: BookGenerationStrategy): Promise<void> {
  if (strategy.executionMode !== "composed-chapters") return;
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { status: true, currentPlanId: true } });
    if (project?.status !== "PLAN_READY" || project.currentPlanId !== planId) return;
    await enqueueWorkerJob({
      projectId,
      type: "PREPARE_COMPOSITION",
      payload: { planId },
      dedupeKey: prepareCompositionDedupeKey(planId),
      attemptIdOverride: null
    });
  } catch (error) {
    console.warn("Speculative composition prep was not queued", { event: "generation.speculative_prep.not_queued", projectId, planId, error });
  }
}

export async function revisePlan(job: RevisePlanJob): Promise<JobCompletion> {
  const { projectId, planId, message, generationJobId } = job.data;
  const operationId = editOperationIdFromJob(job);
  const respondedQuestionPrompts = job.data.respondedQuestionPrompts;
  const planVersion = await prisma.planVersion.findUnique({ where: { id: planId }, include: { project: true } });
  if (!planVersion) {
    throw new Error("Plan not found");
  }
  if (planVersion.project.currentPlanId !== planId) {
    console.warn("Plan revision consistency warning", {
      event: "plan_revision.consistency_warning",
      warning: "stale_plan",
      projectId,
      planId,
      currentPlanId: planVersion.project.currentPlanId,
      operationId,
      generationJobId
    });
    throw new Error("Plan revision targets a superseded plan");
  }
  const operation = operationId
    ? await prisma.bookEditOperation.findUnique({
        where: { id: operationId },
        select: {
          generationJobId: true,
          ledgerEntryId: true,
          status: true,
          classifier: true,
          request: true,
          editInstruction: true,
          characterContext: true
        }
      })
    : null;
  if (operationId) {
    const billingLedgerEntryId = job.data.billingLedgerEntryId ?? null;
    const operationClassifier = jsonPayloadToRecord(operation?.classifier);
    const warning = planRevisionConsistencyWarning({
      durableGenerationJobId: generationJobId,
      linkedGenerationJobId: operation?.generationJobId,
      linkedLedgerEntryId: operation?.ledgerEntryId,
      payloadLedgerEntryId: billingLedgerEntryId,
      billingRequired: operationClassifier.source !== "web"
    });
    if (warning) {
      console.warn("Plan revision consistency warning", {
        event: "plan_revision.consistency_warning",
        warning,
        projectId,
        planId,
        operationId,
        generationJobId,
        linkedGenerationJobId: operation?.generationJobId
      });
      throw new Error(
        warning === "operation_job_mismatch"
          ? "Plan revision operation no longer owns this job"
          : "Plan revision billing linkage is inconsistent"
      );
    }
  }
  const { editInstruction, requestContext, characterContext } = resolveEditPromptContext(operation ?? {}, {
    request: message,
    ...(job.data.editInstruction ? { editInstruction: job.data.editInstruction } : {}),
    ...(job.data.characterContext ? { characterContext: job.data.characterContext } : {})
  });
  const userMessage = authoritativeReplanMessage(editInstruction, requestContext, characterContext);
  const input = inputWithMessageMediaPreferences(
    inputForPlanVersion(planVersion.project, planVersion.inputSnapshot),
    editInstruction
  );
  const classifier = jsonPayloadToRecord(operation?.classifier);
  const requestedLanguage = typeof classifier.targetLanguage === "string" && classifier.targetLanguage.trim()
    ? classifier.targetLanguage
    : explicitLanguageRequest(editInstruction);
  if (requestedLanguage) input.language = normalizeProjectLanguage(requestedLanguage);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  // What the speculative composition prep stored was planned for this version's chapters, not the revision's:
  // a revision merges onto the current plan, so it is taken off first.
  const currentPlan = bookPlanSchema.parse(isRecord(planVersion.planningPackage) ? withoutPreparedFields(planVersion.planningPackage) : planVersion.planningPackage);
  await advanceJobStep(generationJobId, "revise", 35);
  const revised = await strategy.revisePlan({
    currentPlan,
    userMessage,
    textModel: providers.text,
    input: inputWithMobileSourceMaterial(input),
    targetPages: input.targetPages,
    temperature: input.temperature,
    language: input.language,
    toneProfile: input.mediaSettings.toneProfile,
    respondedQuestionPrompts
  });
  const version = await nextPlanVersion(projectId);
  const priorMessages = Array.isArray(planVersion.messages) ? planVersion.messages : [];

  const revisedPlanId = await prisma.$transaction(async (tx) => {
    // CAS, not a blind write: an approval that committed while this revision
    // was being drafted owns the plan now. Superseding it here would silently
    // demote a committed approval and yank the project back to PLAN_READY
    // underneath a paid GENERATE_BOOK. Losing the claim fails the revision
    // instead, and its charge refunds through the normal failure path.
    const superseded = await tx.planVersion.updateMany({
      where: { id: planId, status: { notIn: ["APPROVED", "SUPERSEDED"] } },
      data: { status: "SUPERSEDED" }
    });
    if (superseded.count !== 1) {
      throw new Error("Plan revision lost to a concurrent approval");
    }
    const newPlan = await tx.planVersion.create({
      data: {
        projectId,
        version,
        planningPackage: revised,
        inputSnapshot: planInputSnapshot(input),
        messages: [...priorMessages, { role: "user", content: editInstruction, at: new Date().toISOString() }]
      }
    });
    // Merged over the live row, never a wholesale replacement: the row owns
    // presentation preferences (chapter headings, the Sources toggle) that the
    // plan snapshot has stripped or that changed after it was taken. Read
    // inside the transaction so a presentation edit landing mid-revision is
    // not reverted.
    const liveProject = await tx.project.findUnique({
      where: { id: projectId },
      select: { mediaSettings: true }
    });
    // Same claim on the project: only while the revised plan is still the
    // current one may the revision move the project. `currentPlanId` pointing
    // elsewhere means an approval (of a sibling version) won the race.
    const claimedProject = await tx.project.updateMany({
      where: { id: projectId, currentPlanId: planId },
      data: {
        currentPlanId: newPlan.id,
        status: "PLAN_READY",
        title: revised.title,
        language: input.language,
        mediaSettings: mediaSettingsRowWriteback(
          liveProject?.mediaSettings,
          planMediaSettingsSnapshot(input) as Record<string, unknown>
        ) as Prisma.InputJsonValue
      }
    });
    if (claimedProject.count !== 1) {
      throw new Error("Plan revision lost to a concurrent approval");
    }
    return newPlan.id;
  });
  await advanceJobStep(generationJobId, "save", 90);
  return job.data.prepareComposition ? { afterJobCompleted: () => queueCompositionPrep(projectId, revisedPlanId, strategy) } : {};
}
