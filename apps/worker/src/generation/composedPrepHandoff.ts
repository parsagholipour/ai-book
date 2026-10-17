import { authorStanceSchema, bookPlanSchema, isRecord, type AuthorStance, type BookPlan, type CreateProjectInput } from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { config } from "../runtime/config.js";
import { assertJobNotStopped } from "../runtime/jobLifecycle.js";
import type { RunLogger } from "../providers/runLogging.js";
import {
  compositionPrepRecord,
  patchPlanPackage,
  preparationFingerprint,
  prepareCompositionDedupeKey,
  stepOutcome,
  withoutPreparedFields,
  type PrepStep
} from "./composedPrepRecord.js";

/**
 * How a book run takes over what the speculative composition prep stored
 * (harness redesign H4, `composedSpeculativePrep.ts`).
 *
 * - A prep still QUEUED never runs: the run cancels it.
 * - A prep that planned under different inputs (an approval that switched
 *   illustrations off, a gate the operator moved) is discarded, field by field.
 * - A prep still ACTIVE is waited for step by step: the run reads each step's
 *   answer when the prep stores it, exactly where it would otherwise have made
 *   the call itself, so the dossier still overlaps the form plan. A step the
 *   prep failed, or did not answer within `PREP_STEP_WAIT_MS`, is the run's
 *   again — and before it makes that call it fences the prep (its row goes
 *   CANCELED), so nothing the prep plans afterwards can land beside the run's
 *   own answer.
 *
 * Every write the prep makes is fenced on its row (`writePreparedPlan`), so
 * once the fence commits the plan holds exactly what the run reads next.
 */

/** Longer than a form plan's p90 (83 s) with a fallback hop: past it, the prep is presumed stuck. */
export const PREP_STEP_WAIT_MS = 150_000;
const POLL_MS = 1_000;

export type PreparedComposition = {
  /** The plan as the run opened it: every field the prep stored and the run adopted. */
  plan: BookPlan;
  /**
   * Waits until the prep has answered `step`, or is gone, and returns the stored plan. A step the prep did not
   * store is the run's to make, and the prep has been fenced before this returns (except the brief inventory,
   * which nothing else depends on).
   */
  forStep(step: PrepStep): Promise<BookPlan>;
  /** Fences the prep and returns the stored plan: for a run about to rewrite fields the prep may still write. */
  takeOver(): Promise<BookPlan>;
  /**
   * The stance the prep generated for a plan whose own stance the pass cannot write from: used as the run uses
   * the one it generates itself, whatever `planAuthorStance` would say of it read back.
   */
  stance(): Promise<AuthorStance | undefined>;
};

type HandoffDeps = { now?: () => number; sleep?: (ms: number) => Promise<void>; stepWaitMs?: number };

export async function openPreparedComposition(options: {
  projectId: string;
  planId: string;
  generationJobId?: string | undefined;
  input: CreateProjectInput;
  plan: BookPlan;
  qualitySettings: unknown;
  runLog?: Pick<RunLogger, "append"> | undefined;
} & HandoffDeps): Promise<PreparedComposition> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stepWaitMs = options.stepWaitMs ?? PREP_STEP_WAIT_MS;
  const owner = options.generationJobId ?? "book-run";
  const log = (event: string, detail: Record<string, unknown>) =>
    options.runLog?.append(`generation.composed_chapters.prep_${event}`, { projectId: options.projectId, planId: options.planId, ...detail }).catch(() => undefined);

  let prep = await prisma.generationJob.findUnique({ where: { dedupeKey: prepareCompositionDedupeKey(options.planId) }, select: { id: true, status: true } });
  if (prep?.status === "QUEUED") {
    const canceled = await cancelPrep(prep.id, ["QUEUED"]);
    if (canceled) await log("canceled", { prepJobId: prep.id, status: "QUEUED" });
    prep = await prisma.generationJob.findUnique({ where: { id: prep.id }, select: { id: true, status: true } });
  }
  let live = prep?.status === "ACTIVE";
  const prepJobId = prep?.id;
  const fence = async (reason: string) => {
    if (!live || !prepJobId) return;
    live = false;
    await cancelPrep(prepJobId, ["QUEUED", "ACTIVE"]);
    await log("fenced", { prepJobId, reason });
  };

  const readPackage = async (): Promise<Record<string, unknown> | undefined> => {
    const row = await prisma.planVersion.findUnique({ where: { id: options.planId }, select: { planningPackage: true } });
    return row && isRecord(row.planningPackage) ? row.planningPackage : undefined;
  };
  const parse = (planningPackage: Record<string, unknown> | undefined): BookPlan => {
    const parsed = planningPackage ? bookPlanSchema.safeParse(planningPackage) : undefined;
    return parsed?.success ? parsed.data : options.plan;
  };

  let opened = await readPackage();
  const record = compositionPrepRecord(opened);
  if (record && !record.adoptedBy && !record.discardedBy) {
    const fingerprint = preparationFingerprint(options.input, options.qualitySettings, config.MOCK_AI);
    if (fingerprint === record.fingerprint) {
      opened = await patchPlanPackage(options.planId, (stored) => {
        const current = compositionPrepRecord(stored);
        return current && !current.adoptedBy && !current.discardedBy ? { ...stored, compositionPrep: { ...current, adoptedBy: owner } } : null;
      });
      await log("adopted", { prepJobId: record.generationJobId, live, steps: record.steps });
    } else {
      // Planned under inputs this run does not have: nothing of it is this book's.
      await fence("fingerprint");
      opened = await patchPlanPackage(options.planId, (stored) => {
        const current = compositionPrepRecord(stored);
        if (!current || current.adoptedBy || current.discardedBy) return null;
        const without = withoutPreparedFields(stored);
        return { ...without, compositionPrep: { ...current, written: [], discardedBy: owner } };
      });
      await log("discarded", { prepJobId: record.generationJobId, written: record.written });
    }
  } else if (live && !record) {
    // A prep that has not written its record yet planned nothing this run could adopt, and must not start now.
    await fence("no-record");
    opened = await readPackage();
  }

  // With no prep on this plan the run's own plan stands, exactly as it was handed in.
  let latest = compositionPrepRecord(opened) ? parse(opened) : options.plan;
  const forStep = async (step: PrepStep): Promise<BookPlan> => {
    const started = now();
    while (live) {
      await assertJobNotStopped(options.generationJobId);
      const [planningPackage, row] = await Promise.all([
        readPackage(),
        prepJobId ? prisma.generationJob.findUnique({ where: { id: prepJobId }, select: { status: true } }) : Promise.resolve(null)
      ]);
      const current = compositionPrepRecord(planningPackage);
      const outcome = stepOutcome(current, step);
      if (outcome === "stored" || outcome === "skipped" || (outcome === "failed" && step === "inventory")) {
        latest = parse(planningPackage);
        await log("step", { step, outcome, waitedMs: now() - started });
        return latest;
      }
      if (outcome === "failed" || !current?.planned.includes(step)) {
        await fence(outcome === "failed" ? `${step}-failed` : `${step}-not-planned`);
        break;
      }
      if (row?.status !== "ACTIVE") {
        live = false;
        break;
      }
      if (now() - started >= stepWaitMs) {
        await fence(`${step}-timeout`);
        break;
      }
      await sleep(POLL_MS);
    }
    latest = parse(await readPackage());
    return latest;
  };
  return {
    plan: latest,
    forStep,
    stance: async () => {
      const stored = await forStep("stance");
      const row = await readPackage();
      if (stepOutcome(compositionPrepRecord(row), "stance") !== "stored" || !compositionPrepRecord(row)?.written.includes("authorStance")) return undefined;
      const parsed = authorStanceSchema.safeParse(stored.authorStance);
      return parsed.success ? parsed.data : undefined;
    },
    takeOver: async () => {
      await fence("take-over");
      latest = parse(await readPackage());
      return latest;
    }
  };
}

/**
 * The book run's fence: the prep's row goes CANCELED, which waits behind any prep write holding the row and
 * refuses every later one. CANCELED, never FAILED, so neither the operator's failed-job alert nor a book push
 * reads it as a failure or a reader's stop.
 */
async function cancelPrep(id: string, from: Array<"QUEUED" | "ACTIVE">): Promise<boolean> {
  const canceled = await prisma.generationJob.updateMany({
    where: { id, status: { in: from } },
    data: { status: "CANCELED", finishedAt: new Date(), message: "Taken over by the book run", error: "Superseded by the book run" }
  });
  return canceled.count === 1;
}
