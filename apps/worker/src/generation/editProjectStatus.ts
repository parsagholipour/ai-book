import type { SettledProjectStatus } from "@book-maker/core";
import type { BookEditOperationKind, Prisma } from "@book-maker/db";

type EditProjectStatusClient = Pick<
  Prisma.TransactionClient,
  "bookEditOperation" | "generationJob" | "project"
>;

type EditStatusPhase = "ACTIVE" | "APPLIED" | "APPLIED_NOOP";

const LEGACY_PUBLICATION_KINDS = new Set<BookEditOperationKind>([
  "LOCAL_PATCH",
  "PAGE_REWRITE",
  "CHAPTER_REGENERATE",
  "ADD_IMAGE",
  "MOVE_IMAGE",
  "REMOVE_IMAGE",
  "RESTRUCTURE_PAGES"
]);

function classifierRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Legacy APPLIED no-ops and edits already undone never own an export tail. */
function legacyOperationHasPublication(operation: {
  kind: BookEditOperationKind;
  classifier: unknown;
}): boolean {
  if (!LEGACY_PUBLICATION_KINDS.has(operation.kind)) return false;
  const classifier = classifierRecord(operation.classifier);
  return classifier.undoneAt === undefined &&
    classifier.structuralRolledBackAt === undefined &&
    classifier.textExactSkipped !== true &&
    classifier.layoutMissing !== true &&
    classifier.structuralSkipped === undefined;
}

/** Resolve the operation stamp an EDITING outcome compile must publish for. */
export async function appliedEditPublicationOwnerId(
  client: Pick<Prisma.TransactionClient, "bookEditOperation">,
  projectId: string,
  publicationRevision: number
): Promise<string | null> {
  return (
    await client.bookEditOperation.findFirst({
      where: { projectId, status: "APPLIED", publicationRevision },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true }
    })
  )?.id ?? null;
}

/**
 * Lock the project first, then prove that this operation still owns its edit
 * publication generation. The order matches export publication and stop.
 *
 * `publicationRevision` fences lifecycles that changed manuscript content.
 * The later-operation and later-job checks cover the equally important window
 * before a newer edit/presentation has advanced that revision. The operation's
 * own APPLY_BOOK_EDIT job is the sole newer-than-operation row it may ignore.
 */
async function ownsEditProjectStatus(
  client: EditProjectStatusClient,
  options: {
    projectId: string;
    operationId: string;
    phase: EditStatusPhase;
    statuses: readonly (SettledProjectStatus | "EDITING")[];
    allowedGenerationJobIds?: readonly string[];
  }
): Promise<boolean> {
  const project = await client.project.updateMany({
    where: { id: options.projectId, status: { in: [...options.statuses] } },
    data: { contentRevision: { increment: 0 } }
  });
  if (project.count !== 1) return false;

  const operationLock = await client.bookEditOperation.updateMany({
    where: { id: options.operationId, projectId: options.projectId },
    data: { automaticRetryCount: { increment: 0 } }
  });
  if (operationLock.count !== 1) return false;

  const operation = await client.bookEditOperation.findUnique({
    where: { id: options.operationId },
    select: {
      id: true,
      projectId: true,
      generationJobId: true,
      kind: true,
      classifier: true,
      status: true,
      createdAt: true,
      appliedAt: true,
      publicationRevision: true
    }
  });
  if (
    !operation ||
    operation.projectId !== options.projectId ||
    operation.status !== (options.phase === "APPLIED_NOOP" ? "APPLIED" : options.phase)
  ) {
    return false;
  }

  const currentProject = await client.project.findUnique({
    where: { id: options.projectId },
    select: { contentRevision: true }
  });
  if (!currentProject) {
    return false;
  }

  const laterOperation = await client.bookEditOperation.findFirst({
    where: {
      projectId: options.projectId,
      OR: [
        { createdAt: { gt: operation.createdAt } },
        { createdAt: operation.createdAt, id: { gt: operation.id } }
      ]
    },
    select: { id: true }
  });
  if (laterOperation) return false;

  const ownershipStartedAt = operation.appliedAt ?? operation.createdAt;
  const allowedJobIds = [operation.generationJobId, ...(options.allowedGenerationJobIds ?? [])].filter(
    (id): id is string => Boolean(id)
  );
  const laterLifecycle = await client.generationJob.findFirst({
    where: {
      projectId: options.projectId,
      createdAt: options.phase === "APPLIED" && operation.publicationRevision === null
        ? { gte: ownershipStartedAt }
        : { gt: ownershipStartedAt },
      ...(allowedJobIds.length > 0 ? { id: { notIn: allowedJobIds } } : {})
    },
    select: { id: true }
  });
  if (laterLifecycle) return false;

  if (options.phase !== "APPLIED") return true;
  if (operation.publicationRevision !== null) {
    return operation.publicationRevision === currentProject.contentRevision;
  }

  // Upgrade compatibility is narrower than ordinary stamped ownership. An
  // APPLIED row by itself is historical and ambiguous; only its still-open,
  // project-scoped APPLY_BOOK_EDIT row proves that processJob has not completed
  // this delivery's mutation-to-publication handoff. The project and operation
  // locks above, plus the absence of any later operation/job, make adopting the
  // current revision an atomic one-time recovery rather than a recency guess.
  if (!operation.appliedAt || !operation.generationJobId || !legacyOperationHasPublication(operation)) {
    return false;
  }
  const ownerJob = await client.generationJob.findUnique({
    where: { id: operation.generationJobId },
    select: { projectId: true, type: true, status: true }
  });
  if (
    !ownerJob ||
    ownerJob.projectId !== options.projectId ||
    ownerJob.type !== "APPLY_BOOK_EDIT" ||
    (ownerJob.status !== "QUEUED" && ownerJob.status !== "ACTIVE")
  ) {
    return false;
  }
  const adopted = await client.bookEditOperation.updateMany({
    where: {
      id: operation.id,
      projectId: options.projectId,
      status: "APPLIED",
      publicationRevision: null,
      generationJobId: operation.generationJobId
    },
    data: { publicationRevision: currentProject.contentRevision }
  });
  return adopted.count === 1;
}

/** Reopen only this APPLIED operation's still-current publication generation. */
export async function claimAppliedEditPublication(
  client: EditProjectStatusClient,
  projectId: string,
  operationId: string,
  fallbackStatus: SettledProjectStatus,
  allowedGenerationJobIds: readonly string[] = []
): Promise<boolean> {
  if (
    !(await ownsEditProjectStatus(client, {
      projectId,
      operationId,
      phase: "APPLIED",
      statuses: [fallbackStatus, "EDITING"],
      allowedGenerationJobIds
    }))
  ) {
    return false;
  }
  const claimed = await client.project.updateMany({
    where: { id: projectId, status: { in: [fallbackStatus, "EDITING"] } },
    data: { status: "EDITING" }
  });
  return claimed.count === 1;
}

/**
 * Restore a project only while this operation owns the named phase. ACTIVE is
 * for a first-delivery no-op; APPLIED is for a stamped publication fallback.
 */
export async function restoreEditProjectStatus(
  client: EditProjectStatusClient,
  projectId: string,
  operationId: string,
  fallbackStatus: SettledProjectStatus,
  phase: EditStatusPhase = "APPLIED"
): Promise<boolean> {
  if (
    !(await ownsEditProjectStatus(client, {
      projectId,
      operationId,
      phase,
      statuses: ["EDITING"]
    }))
  ) {
    return false;
  }
  const restored = await client.project.updateMany({
    where: { id: projectId, status: "EDITING" },
    data: { status: fallbackStatus }
  });
  return restored.count === 1;
}
