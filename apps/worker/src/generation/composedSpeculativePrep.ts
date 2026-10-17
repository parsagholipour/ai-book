import {
  generateAuthorStance,
  isRecord,
  planAuthorStance,
  planBookArc,
  type AuthorStance,
  type BookPlan,
  type CreateProjectInput,
  type ManuscriptRequirementInventory,
  type TextModelAdapter
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { config } from "../runtime/config.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import type { RunLogger } from "../providers/runLogging.js";
import { chapterSetupsForPlan } from "./bookHelpers.js";
import { briefRequirementsForForms, takeBriefInventory } from "./composedBriefInventory.js";
import { settleBookEpisodes } from "./composedChaptersMaterial.js";
import { BOOK_ARC } from "./composedExperiments.js";
import { planComposedForms } from "./composedFormPlan.js";
import { composedDevelopmentWillRun, storedStanceUsable } from "./composedPreparation.js";
import {
  compositionPrepRecord,
  isPrepFencedError,
  preparationFingerprint,
  PrepFencedError,
  writePreparedPlan,
  type CompositionPrepRecord,
  type PrepOutcome,
  type PrepStep
} from "./composedPrepRecord.js";
import { loadQualityContext } from "./qualitySettings.js";

/**
 * Speculative composition prep (harness redesign H4): the calls a composed
 * book run makes before its first chapter that read only the plan and the
 * brief — the author stance, the brief's requirement inventory, the episodes
 * and the chapter form plan — made while the reader is still reading the plan,
 * and stored on that plan version for the run to adopt (`composedPrepHandoff.ts`).
 *
 * The same functions the run calls, in the order and with the inputs it would
 * call them, so an adopted answer is the one the run would have asked for.
 * Nothing here searches the web, gathers a source or writes a chapter or a
 * page: a grounded search is a fee on a plan nobody may approve, and the
 * dossier stays the run's. Every write goes through `writePreparedPlan`,
 * fenced on this job's own row, and each step's outcome is written in the
 * same document as its answer.
 */
export async function prepareCompositionSpeculatively(options: {
  projectId: string;
  planId: string;
  generationJobId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  textModel: TextModelAdapter;
  runLog?: Pick<RunLogger, "append"> | undefined;
}): Promise<{ outcome: "prepared" | "fenced" | "already-prepared"; steps: Partial<Record<PrepStep, PrepOutcome>> }> {
  const { projectId, planId, generationJobId, input, plan, textModel } = options;
  const quality = await loadQualityContext(input);
  const steps: Partial<Record<PrepStep, PrepOutcome>> = {};
  // A book the shelved development arm will replan, or whose stored arc re-cuts the pages, gets its episodes and
  // forms from the run, after the plan they depend on exists.
  const laterStepsApply = !composedDevelopmentWillRun({ input, plan, quality, hasPages: false }) && !BOOK_ARC && !planBookArc(plan);
  const planned: PrepStep[] = laterStepsApply ? ["stance", "inventory", "episodes", "forms"] : ["stance", "inventory"];
  const record: CompositionPrepRecord = {
    version: 1, generationJobId, fingerprint: preparationFingerprint(input, quality.settings, config.MOCK_AI), planned, steps: {}, written: []
  };
  const log = (event: string, detail: Record<string, unknown> = {}) =>
    options.runLog?.append(`generation.speculative_prep.${event}`, { projectId, planId, ...detail }).catch(() => undefined);

  const store = async (step: PrepStep, fields: Record<string, unknown>, outcome?: PrepOutcome) => {
    await writePreparedPlan({
      planId,
      generationJobId,
      patch: (planningPackage) => {
        const current = compositionPrepRecord(planningPackage);
        if (!current || current.generationJobId !== generationJobId || current.discardedBy) throw new PrepFencedError();
        const next: Record<string, unknown> = { ...planningPackage };
        const written = [...current.written];
        let wrote = false;
        // Written once, like every plan field: a value already there is not this prep's to replace — except a
        // stance the pass could not write from, which the pass replaces too (`persistGeneratedAuthorStance`).
        for (const [field, value] of Object.entries(fields)) {
          const occupied = field === "authorStance" ? storedStanceUsable(planningPackage[field]) : planningPackage[field] !== undefined;
          if (value === undefined || occupied) continue;
          next[field] = value;
          written.push(field);
          wrote = true;
        }
        const settled: PrepOutcome = outcome ?? (wrote ? "stored" : "skipped");
        steps[step] = settled;
        next.compositionPrep = { ...current, steps: { ...current.steps, [step]: settled }, written };
        return next;
      }
    });
  };
  const failed = async (step: PrepStep, error: unknown) => {
    if (isStopRequestedError(error) || isPrepFencedError(error)) throw error;
    await log("step_failed", { step, error: error instanceof Error ? error.message : String(error) });
    await store(step, {}, "failed");
  };

  try {
    await writePreparedPlan({
      planId,
      generationJobId,
      patch: (planningPackage) => {
        // A redelivery finds its own record: what the first delivery stored stands, and nothing is planned twice.
        if (isRecord(planningPackage.compositionPrep)) throw new PrepFencedError("This plan already has a composition prep.");
        return { ...planningPackage, compositionPrep: record };
      }
    });
    await log("started", { planned, fingerprint: record.fingerprint });

    // The stance and the inventory run side by side, as the run starts them.
    const stanceStep = (async (): Promise<AuthorStance | undefined> => {
      const fromPlan = planAuthorStance(plan);
      if (fromPlan) {
        await store("stance", {}, "skipped");
        return fromPlan;
      }
      try {
        const stance = await generateAuthorStance({ input, plan, textModel });
        await store("stance", { authorStance: stance });
        return stance;
      } catch (error) {
        await failed("stance", error);
        return undefined;
      }
    })();
    const inventoryStep = (async (): Promise<ManuscriptRequirementInventory | undefined> => {
      const inventory = await takeBriefInventory({ input, plan, textModel });
      if (inventory) await store("inventory", { requirementInventory: inventory });
      else await store("inventory", {}, input.prompt.trim() ? "failed" : "skipped");
      return inventory;
    })();
    inventoryStep.catch(() => undefined);

    const stance = await stanceStep;
    if (!stance || !laterStepsApply) {
      await inventoryStep;
      return { outcome: "prepared", steps };
    }
    // The run composes with the generated stance on its plan, so every later read of the writing mode sees it.
    const stancedPlan: BookPlan = planAuthorStance(plan) ? plan : { ...plan, authorStance: stance };
    let episodes;
    try {
      episodes = await settleBookEpisodes({
        projectId, planId, input, plan: stancedPlan, stance, textModel, quality,
        writeEpisodes: (planned, setting) => store("episodes", { episodes: planned, ...(setting ? { instructionalSetting: setting } : {}) })
      });
      if (episodes.outcome !== "planned") await store("episodes", {}, episodes.outcome === "failed" ? "failed" : "skipped");
    } catch (error) {
      await failed("episodes", error);
      await inventoryStep;
      return { outcome: "prepared", steps };
    }
    if (episodes.outcome === "failed") {
      // The run plans the episodes again, and its form plan reads those: nothing here can be adopted past this.
      await inventoryStep;
      return { outcome: "prepared", steps };
    }
    const inventory = await inventoryStep;
    try {
      let recorded = false;
      await planComposedForms({
        projectId, planId, input, plan: stancedPlan, stance, arc: undefined,
        setups: chapterSetupsForPlan(stancedPlan, input.targetPages), fixed: [],
        episodes: episodes.episodes, ...(episodes.setting ? { setting: episodes.setting } : {}),
        quality, textModel, requirements: briefRequirementsForForms(inventory),
        persist: false,
        onRecord: async (forms) => {
          await store("forms", { compositions: forms, exampleCast: forms.cast, toolkit: forms.toolkit });
          recorded = true;
        }
      });
      if (!recorded) await store("forms", {}, "failed");
    } catch (error) {
      await failed("forms", error);
    }
    return { outcome: "prepared", steps };
  } catch (error) {
    if (!isPrepFencedError(error)) throw error;
    await log("fenced", { reason: error.message, steps });
    return { outcome: error.message.startsWith("This plan already") ? "already-prepared" : "fenced", steps };
  } finally {
    await log("finished", { steps });
  }
}

/** Whether the prep should start at all: its plan is still the project's current, unapproved one. */
export async function speculativePrepTarget(projectId: string, planId: string) {
  const planVersion = await prisma.planVersion.findUnique({
    where: { id: planId },
    include: { project: true }
  });
  if (!planVersion || planVersion.projectId !== projectId) return undefined;
  if (planVersion.status !== "DRAFT" || planVersion.project.currentPlanId !== planId) return undefined;
  return planVersion;
}
