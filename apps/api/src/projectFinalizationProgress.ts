import { prisma } from "@book-maker/db";
import { serializeFinalizationProgress } from "./mobile/finalizationProgress.js";
import { jsonRecord } from "./mobile/support.js";

/** Read the operation independently of the recent-job window used by the UI. */
export async function loadProjectFinalizationProgress(project: {
  id: string; status: string; currentPlanId: string | null; contentRevision: number; targetPages: number;
}) {
  if (project.status !== "GENERATING" || !project.currentPlanId || !Number.isInteger(project.contentRevision)) return null;
  const scope = {
    projectId: project.id, contentRevision: project.contentRevision,
    payload: { path: ["planId"], equals: project.currentPlanId }
  };
  const [compiles, books] = await Promise.all([
    prisma.generationJob.findMany({ where: { ...scope, type: "COMPILE_EXPORT", ownsQualityVerdict: true },
      orderBy: { createdAt: "desc" }, take: 1, select: { id: true, payload: true, createdAt: true, attemptId: true } }),
    prisma.generationJob.findMany({ where: { projectId: project.id, type: "GENERATE_BOOK", payload: scope.payload },
      orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, attemptId: true } })
  ]);
  const compile = compiles[0];
  if (!compile) return null;
  const payload = jsonRecord(compile.payload);
  let owner = compile;
  if (!payload.finalization) {
    const roots = await prisma.generationJob.findMany({
      where: { ...scope, type: "COMPILE_EXPORT", ownsQualityVerdict: true, attemptId: compile.attemptId,
        ...(typeof payload.finalizationOperationId === "string" ? { id: payload.finalizationOperationId } : {}),
        AND: [{ payload: { path: ["finalization", "version"], equals: 1 } }] },
      orderBy: { createdAt: "desc" }, take: 1, select: { id: true, payload: true, createdAt: true, attemptId: true }
    });
    if (!roots[0]) return null;
    owner = roots[0];
  }
  const book = books[0];
  // A retry can keep the same plan and content revision. Its new command must
  // never inherit an old operation's published phase or exhausted allowance.
  if (book && (book.createdAt > owner.createdAt || book.attemptId !== owner.attemptId)) return null;
  const state = jsonRecord(jsonRecord(owner.payload).finalization);
  if (state.version !== 1 || !Array.isArray(state.startedPageIds) || !Array.isArray(state.targetPageIds)) return null;
  const startedPageIds = state.startedPageIds;
  return serializeFinalizationProgress({ finalizationProgress: {
    phase: state.phase, pageIndex: state.activePageIndex, updatedAt: state.updatedAt,
    attempts: startedPageIds.length,
    remainingRepairPages: state.repairPassCompleted ? 0 : state.targetPageIds.filter((id) => !startedPageIds.includes(id)).length,
    illustrationJobsTotal: state.illustrationJobsTotal ?? (Array.isArray(state.pendingImageJobIds) ? state.pendingImageJobIds.length : 0)
  } }, project.targetPages);
}
