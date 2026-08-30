import type { Prisma } from "@book-maker/db";
import {
  ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL,
  continuationPublicationProtocolState,
  hasContinuationPublicationEvidence
} from "@book-maker/core";

type ContinuationStopJob = {
  id: string;
  status: string;
  type: string;
  payload: unknown;
};

type ContinuationStopOperation = {
  id: string;
  projectId: string;
  generationJobId: string | null;
  kind: string;
  status: string;
  classifier: unknown;
  publicationRevision: number | null;
};

export type ContinuationStopDisposition = "handoff" | "restore" | "fail-closed";

/** Pure durable classifier used while Stop holds Project -> job -> operation. */
export function continuationStopDisposition(
  projectId: string,
  job: ContinuationStopJob,
  operation: ContinuationStopOperation
): ContinuationStopDisposition {
  if (
    job.type !== "CONTINUE_BOOK" ||
    operation.projectId !== projectId ||
    operation.kind !== "CONTINUE_BOOK" ||
    operation.generationJobId !== job.id
  ) {
    return "fail-closed";
  }
  if (
    operation.status === "APPLIED" ||
    operation.publicationRevision !== null ||
    hasContinuationPublicationEvidence(operation.classifier)
  ) {
    return "handoff";
  }
  if (operation.status !== "QUEUED" && operation.status !== "ACTIVE") {
    return "fail-closed";
  }
  const payload = payloadRecord(job.payload);
  if (payload.operationId !== operation.id) {
    return "fail-closed";
  }
  // A QUEUED durable row proves the worker never claimed this delivery:
  // `markActive` (`apps/worker/src/runtime/jobLifecycle.ts`) takes the
  // GenerationJob row before it touches the operation, the plan or the
  // manuscript, and Stop reads this status under its own row claim. Nothing was
  // published, so the enqueue's own settled -> EDITING transition is the only
  // state to undo and the protocol markers have nothing left to say about it.
  // They license restoring an *ACTIVE* row, and only that.
  //
  // Requiring the pair here failed closed on any disagreement, and closed means
  // a finished, paid book marked FAILED with no route back (see
  // `SETTLED_PROJECT_STATUSES`). The marker is versioned precisely so it can be
  // bumped, and the bump *is* the disagreement, reaching every row at once: on
  // the deploy that moves the constant on, each continuation still queued under
  // the previous value reads `invalid` on both sides and matches neither the
  // current pair nor the legacy absent one. Stop already keeps this rule for a
  // continuation whose operation reaches no classifier at all, and a row we can
  // read is not owed a worse answer than one we cannot.
  if (job.status === "QUEUED") {
    return "restore";
  }
  return continuationPublicationProtocolState(operation.classifier) === ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL &&
    continuationPublicationProtocolState(payload) === ATOMIC_CANDIDATES_CONTINUATION_PROTOCOL
    ? "restore"
    : "fail-closed";
}

export type StoppedContinuationClassification = {
  /** Jobs whose durable tail belongs to a publication, not to this stop. */
  handoffJobIds: Set<string>;
  /** Continuations whose project may go back to its stamped settled status. */
  restorableContinuationJobIds: Set<string>;
  /** Operations this stop does not own, and therefore may not revoke. */
  retainedOperationIds: Set<string>;
};

/**
 * Runs {@link continuationStopDisposition} over every continuation one stop
 * claimed, inside that stop's transaction and under the Project and job claims
 * it already holds.
 *
 * The query is here rather than at the call site because the classifier's
 * inputs *are* the query: it decides on the durable `generationJobId` relation,
 * so which rows reach a disposition and which fall through to the legacy rule
 * below is one decision spelled in two halves.
 */
export async function classifyStoppedContinuationsTx(
  tx: Pick<Prisma.TransactionClient, "bookEditOperation">,
  projectId: string,
  stoppedJobs: ReadonlyArray<ContinuationStopJob>
): Promise<StoppedContinuationClassification> {
  const handoffJobIds = new Set<string>();
  const restorableContinuationJobIds = new Set<string>();
  const retainedOperationIds = new Set<string>();
  const jobsById = new Map(
    stoppedJobs.flatMap((job) => (job.type === "CONTINUE_BOOK" ? [[job.id, job] as const] : []))
  );
  if (jobsById.size === 0) {
    return { handoffJobIds, restorableContinuationJobIds, retainedOperationIds };
  }
  const operations = await tx.bookEditOperation.findMany({
    where: { projectId, kind: "CONTINUE_BOOK", generationJobId: { in: [...jobsById.keys()] } },
    select: {
      id: true,
      projectId: true,
      generationJobId: true,
      kind: true,
      status: true,
      classifier: true,
      publicationRevision: true
    }
  });
  const classifiedJobIds = new Set<string>();
  for (const operation of operations) {
    const job = operation.generationJobId ? jobsById.get(operation.generationJobId) : undefined;
    if (!job) {
      continue;
    }
    classifiedJobIds.add(job.id);
    const disposition = continuationStopDisposition(projectId, job, operation);
    if (disposition === "handoff") {
      handoffJobIds.add(job.id);
      retainedOperationIds.add(operation.id);
    } else if (disposition === "restore") {
      restorableContinuationJobIds.add(job.id);
    }
  }
  // A row whose operation predates the `generationJobId` relation — the legacy
  // shape every other lookup in the stop still carries a payload id for — or
  // whose operation is gone reaches no durable classifier, and fail-closed is
  // the wrong default: it marks a finished book FAILED over a continuation that
  // never started. Those keep the rule the classifier replaced — QUEUED never
  // reached the worker, so its EDITING transition is the only state to undo.
  for (const [jobId, job] of jobsById) {
    if (!classifiedJobIds.has(jobId) && job.status === "QUEUED") {
      restorableContinuationJobIds.add(jobId);
    }
  }
  return { handoffJobIds, restorableContinuationJobIds, retainedOperationIds };
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
