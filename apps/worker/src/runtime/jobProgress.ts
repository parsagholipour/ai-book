import { type JobStep } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { StopRequestedError, isStoppedGenerationJob } from "./jobTypes.js";

/**
 * Per-job step templates and progress reporting for `GenerationJob` rows. The
 * status transitions that consume these live in jobLifecycle.ts; handlers
 * report movement through here.
 */


const JOB_STEP_TEMPLATES: Record<string, Array<{ key: string; label: string }>> = {
  "plan-book": [
    { key: "research", label: "Research" },
    { key: "plan", label: "Create plan" },
    { key: "save", label: "Save plan" }
  ],
  "revise-plan": [
    { key: "revise", label: "Revise plan" },
    { key: "save", label: "Save revision" }
  ],
  "generate-book": [
    { key: "briefs", label: "Prepare book" },
    { key: "setup", label: "Create pages" },
    { key: "enqueue", label: "Queue follow-ups" }
  ],
  "generate-page": [
    { key: "prepare", label: "Prepare context" },
    { key: "draft", label: "Draft page" },
    { key: "qa", label: "Quality review" },
    { key: "revise", label: "Revise draft" },
    { key: "save", label: "Save page" }
  ],
  "generate-image": [
    { key: "prompt", label: "Build prompt" },
    { key: "render", label: "Render image" },
    { key: "store", label: "Store asset" }
  ],
  "compile-export": [
    { key: "qa", label: "Final review" },
    { key: "compile", label: "Compile markdown" },
    { key: "write", label: "Write Markdown" },
    { key: "pdf", label: "Generate PDF" },
    { key: "epub", label: "Generate EPUB" }
  ],
  "apply-book-edit": [
    { key: "prepare", label: "Prepare edit" },
    { key: "snapshot", label: "Snapshot pages" },
    { key: "apply", label: "Apply edits" },
    { key: "export", label: "Refresh exports" }
  ],
  "replan-book": [
    { key: "revise", label: "Revise plan" },
    { key: "save", label: "Save approved plan" },
    { key: "generate", label: "Queue regeneration" }
  ],
  "prepare-character-candidates": [
    { key: "detect", label: "Detect characters" },
    { key: "save", label: "Save candidates" }
  ],
  "build-character-persona": [
    { key: "persona", label: "Build persona" },
    { key: "portrait", label: "Create profile picture" },
    { key: "save", label: "Save character" }
  ],
  "import-book": [
    { key: "read", label: "Read manuscript" },
    { key: "segment", label: "Split into chapters" },
    { key: "analyze", label: "Learn writing style" },
    { key: "save", label: "Save your book" }
  ],
  "continue-book": [
    { key: "outline", label: "Outline new chapters" },
    { key: "draft", label: "Write new pages" },
    { key: "save", label: "Save chapters" },
    { key: "export", label: "Refresh exports" }
  ],
  "generate-audiobook": [
    { key: "prepare", label: "Prepare narration" },
    { key: "synthesize", label: "Narrate chapters" },
    { key: "finalize", label: "Finish audiobook" }
  ]
};

export function buildStepTemplate(jobName: string): JobStep[] {
  const template = JOB_STEP_TEMPLATES[jobName];
  if (!template) {
    return [];
  }
  return template.map((step, index) => ({
    ...step,
    status: index === 0 ? "active" : "pending"
  }));
}

export function parseJobSteps(value: unknown): JobStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (step): step is JobStep =>
      typeof step === "object" &&
      step !== null &&
      typeof (step as JobStep).key === "string" &&
      typeof (step as JobStep).label === "string" &&
      ["pending", "active", "done", "failed"].includes((step as JobStep).status)
  );
}

export async function updateJobProgress(
  generationJobId: string | undefined,
  update: { progress?: number; message?: string; steps?: JobStep[] },
  options: { allowStopped?: boolean } = {}
) {
  if (!generationJobId) {
    return;
  }
  if (!options.allowStopped) {
    await assertJobNotStopped(generationJobId);
  }
  await prisma.generationJob.update({
    where: { id: generationJobId },
    data: {
      // The single write site for progress, so the clamp lives here: handlers
      // derive percentages from counters that can legitimately overshoot (a
      // resumed audiobook whose old partition had more chapters than the
      // current one) and the app renders whatever number lands in the row.
      ...(update.progress !== undefined ? { progress: Math.min(100, update.progress) } : {}),
      ...(update.message !== undefined ? { message: update.message } : {}),
      ...(update.steps !== undefined ? { steps: update.steps as Prisma.InputJsonValue } : {})
    }
  });
}

/**
 * Countable facts about the step being worked on, for the API to narrate.
 *
 * Deliberately numbers and tokens rather than sentences: `GenerationJob.message`
 * is internal text the mobile serializers must never forward, so anything the
 * reader is meant to see has to arrive as data they can phrase themselves.
 */
export type JobStepCounters = {
  done?: number;
  total?: number;
  phase?: string;
  pageIndex?: number;
};

function withCounters(step: JobStep, counters: JobStepCounters | undefined): JobStep {
  if (!counters) {
    return step;
  }
  return {
    ...step,
    ...(typeof counters.done === "number" ? { done: counters.done } : {}),
    ...(typeof counters.total === "number" ? { total: counters.total } : {}),
    ...(counters.phase ? { phase: counters.phase } : {}),
    ...(typeof counters.pageIndex === "number" ? { pageIndex: counters.pageIndex } : {})
  };
}

/**
 * Marks `activeKey` as the step being worked on, optionally with counters.
 *
 * Re-calling it for the step that is already active is the supported way to
 * report movement inside a long step — which page of an edit is being rewritten
 * and what is being done to it — because it is the same single write either way.
 */
export async function advanceJobStep(
  generationJobId: string | undefined,
  activeKey: string,
  progress?: number,
  message?: string,
  counters?: JobStepCounters
) {
  if (!generationJobId) {
    return;
  }
  await assertJobNotStopped(generationJobId);
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { steps: true }
  });
  const steps = parseJobSteps(job?.steps);
  if (!steps.length) {
    return;
  }
  let foundActive = false;
  const nextSteps = steps.map((step) => {
    if (step.key === activeKey) {
      foundActive = true;
      return withCounters({ ...step, status: "active" as const }, counters);
    }
    if (!foundActive) {
      return { ...step, status: "done" as const };
    }
    return { ...step, status: "pending" as const };
  });
  const active = nextSteps.find((step) => step.status === "active");
  const stepMessage = message ?? active?.label;
  await updateJobProgress(generationJobId, {
    steps: nextSteps,
    ...(progress !== undefined ? { progress } : {}),
    ...(stepMessage ? { message: stepMessage } : {})
  });
}

export async function completeAllJobSteps(generationJobId: string | undefined) {
  if (!generationJobId) {
    return;
  }
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { steps: true }
  });
  const steps = parseJobSteps(job?.steps);
  if (!steps.length) {
    return;
  }
  await updateJobProgress(generationJobId, {
    steps: steps.map((step) => ({ ...step, status: "done" as const }))
  });
}

export async function failActiveJobStep(
  generationJobId: string | undefined,
  options: { allowStopped?: boolean } = {}
) {
  if (!generationJobId) {
    return;
  }
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { steps: true }
  });
  const steps = parseJobSteps(job?.steps);
  if (!steps.length) {
    return;
  }
  await updateJobProgress(generationJobId, {
    steps: steps.map((step) =>
      step.status === "active" ? { ...step, status: "failed" as const } : step
    )
  }, options);
}

export async function assertJobNotStopped(generationJobId: string | undefined) {
  if (await hasStoppedGenerationJob(generationJobId)) {
    throw new StopRequestedError();
  }
}

export async function hasStoppedGenerationJob(generationJobId: string | undefined): Promise<boolean> {
  if (!generationJobId) {
    return false;
  }
  const job = await prisma.generationJob.findUnique({
    where: { id: generationJobId },
    select: { status: true, message: true, error: true }
  });
  return isStoppedGenerationJob(job);
}
