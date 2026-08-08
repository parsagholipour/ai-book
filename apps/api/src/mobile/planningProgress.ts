import { type MobileProjectStatusDto, type ProjectStatusResult } from "./dto.js";

/**
 * Planning-phase progress: the step list and token-informed percentage the app
 * renders while a plan or plan revision is being generated. Split out of
 * projectSerializers.ts, which re-exports it.
 */

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
