import {
  getProjectOrThrow,
  nextPlanVersion,
  planInputSnapshot,
  planMediaSettingsSnapshot,
  strategyForInput
} from "../generation/bookHelpers.js";
import { strategyUsesSemanticMemory } from "../generation/embeddingWrites.js";
import { embedResearchSourcesForProject } from "../generation/researchMemory.js";
import { planRevisionConsistencyWarning } from "../generation/planRevisionSafety.js";
import {
  inputForPlanVersion,
  inputFromProject,
  inputFromSnapshot,
  inputWithMessageMediaPreferences,
  inputWithMobileSourceMaterial
} from "../generation/projectInput.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { config } from "../runtime/config.js";
import { advanceJobStep, editOperationIdFromJob } from "../runtime/jobLifecycle.js";
import { isStopRequestedError, type JobCompletion } from "../runtime/jobTypes.js";
import { jsonPayloadToRecord } from "../runtime/serialization.js";
import { applyPlanThinkingBoost, loadQualityContext } from "../generation/qualitySettings.js";
import { seedProjectStoryState } from "../generation/storyStateStore.js";
import { bookPlanSchema, createProviders, critiquePlan, mergePlanCriticPatch, mediaSettingsRowWriteback } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import type { PlanBookJob, RevisePlanJob } from "../runtime/jobPayloads.js";

/**
 * `plan-book` and `revise-plan` jobs: research a brief and turn it into a BookPlan.
 */

/** Identity for the redelivery dedupe of stored research sources. */
function researchSourceIdentity(source: { query: string; title: string; url?: string | null | undefined }): string {
  return [source.query, source.title, source.url ?? ""].join("\0");
}

export async function planBook(job: PlanBookJob): Promise<JobCompletion> {
  const { projectId, inputSnapshot, generationJobId } = job.data;
  const project = await getProjectOrThrow(projectId);
  const input = inputFromSnapshot(inputSnapshot) ?? inputFromProject(project);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  const quality = await loadQualityContext(input);
  applyPlanThinkingBoost(providers.text, quality.enabled("planThinkingBoost"));
  let plan = await strategy.createPlan({
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
  if (quality.enabled("planCritic")) {
    try {
      const patch = await critiquePlan({ textModel: providers.text, plan });
      plan = mergePlanCriticPatch(plan, patch);
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      console.warn(`Plan critic skipped for project ${projectId}`, error);
    }
  }
  const version = await nextPlanVersion(projectId);

  await prisma.$transaction(async (tx) => {
    const planVersion = await tx.planVersion.create({
      data: {
        projectId,
        version,
        planningPackage: plan,
        inputSnapshot: planInputSnapshot(input),
        messages: []
      }
    });

    await tx.project.update({
      where: { id: projectId },
      data: { currentPlanId: planVersion.id, title: plan.title }
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

    if (plan.researchNotes.length > 0) {
      // Existing-rows guard, mirroring embedResearchSourcesForProject: a
      // redelivered plan-book re-runs this whole transaction, and unlike the
      // cast above these rows were appended rather than replaced — doubling
      // the book's Sources list forever (the compile rebuilds it from these
      // rows on every export). Insert only the notes that are not already
      // stored.
      const existingSources = await tx.researchSource.findMany({
        where: { projectId },
        select: { query: true, title: true, url: true }
      });
      const storedKeys = new Set(existingSources.map((source) => researchSourceIdentity(source)));
      const missingNotes = plan.researchNotes.filter((source) => !storedKeys.has(researchSourceIdentity(source)));
      if (missingNotes.length > 0) {
        await tx.researchSource.createMany({
          data: missingNotes.map((source) => ({
            projectId,
            query: source.query,
            title: source.title,
            url: source.url ?? null,
            summary: source.summary,
            publishedAt: source.publishedAt ? new Date(source.publishedAt) : null
          }))
        });
      }
    }
  });
  await seedProjectStoryState(projectId, plan.promises ?? []);
  // Best-effort: the plan is already committed, and a failure past this point
  // marks the project FAILED in a state `canRecoverGenerationJob` refuses to
  // resume — the plan is newer than the job. Missing embeddings only degrade
  // semantic recall, and page generation re-embeds as it goes. Only the
  // sequential-pages strategy ever queries these embeddings, so other modes
  // skip the calls entirely.
  if (strategyUsesSemanticMemory(strategy)) {
    try {
      await embedResearchSourcesForProject(projectId, providers.embedding);
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      console.warn(`Research embedding failed after plan save for project ${projectId}`, error);
    }
  }
  return {
    afterJobCompleted: async () => {
      await prisma.project.update({
        where: { id: projectId },
        data: { status: "PLAN_READY" }
      });
    }
  };
}

export async function revisePlan(job: RevisePlanJob) {
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
  if (operationId) {
    const operation = await prisma.bookEditOperation.findUnique({
      where: { id: operationId },
      select: { generationJobId: true, ledgerEntryId: true, status: true, classifier: true }
    });
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
  const input = inputWithMessageMediaPreferences(inputForPlanVersion(planVersion.project, planVersion.inputSnapshot), message);
  const strategy = strategyForInput(input);
  const providers = createLoggedProviders(job, createProviders(config, input), input);
  const currentPlan = bookPlanSchema.parse(planVersion.planningPackage);
  await advanceJobStep(generationJobId, "revise", 35);
  const revised = await strategy.revisePlan({
    currentPlan,
    userMessage: message,
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

  await prisma.$transaction(async (tx) => {
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
        messages: [...priorMessages, { role: "user", content: message, at: new Date().toISOString() }]
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
        mediaSettings: mediaSettingsRowWriteback(
          liveProject?.mediaSettings,
          planMediaSettingsSnapshot(input) as Record<string, unknown>
        ) as Prisma.InputJsonValue
      }
    });
    if (claimedProject.count !== 1) {
      throw new Error("Plan revision lost to a concurrent approval");
    }
  });
  await advanceJobStep(generationJobId, "save", 90);
}
