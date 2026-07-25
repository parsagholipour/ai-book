export type FailedPlanRevisionRecoveryDb = {
  project: {
    updateMany(args: {
      where: { id: string; status: "PLANNING"; currentPlanId: { not: null } };
      data: { status: "PLAN_READY" };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: { currentPlanId: true };
    }): Promise<{ currentPlanId: string | null } | null>;
  };
};

export async function restoreProjectAfterFailedPlanRevision(
  db: FailedPlanRevisionRecoveryDb,
  projectId: string
): Promise<boolean> {
  const restored = await db.project
    .updateMany({
      where: { id: projectId, status: "PLANNING", currentPlanId: { not: null } },
      data: { status: "PLAN_READY" }
    })
    .catch(() => null);
  if (!restored) {
    return false;
  }
  if (restored.count > 0) {
    return true;
  }

  const project = await db.project
    .findUnique({
      where: { id: projectId },
      select: { currentPlanId: true }
    })
    .catch(() => null);
  return Boolean(project?.currentPlanId);
}
