import {
  compilePublicationPolicyFromPayload,
  compilePublicationPolicyIdentity
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { exportPublicationCommittedAt } from "../generation/exportPublicationEvidence.js";

type CompilePredecessor = {
  id: string;
  projectId: string | null;
  type: string;
  status: string;
  contentRevision: number | null;
  dedupeKey: string | null;
  attemptId: string | null;
};

type CompileIdentity = { dedupeKey: string; attemptIdOverride: string | null };

function predecessorIdentity(options: {
  projectId: string;
  contentRevision: number;
  baseDedupeKey: string;
}, predecessor: CompilePredecessor): (CompileIdentity & { spendsCurrentIdentity: boolean }) | null {
  if (
    predecessor.projectId !== options.projectId || predecessor.type !== "COMPILE_EXPORT" ||
    predecessor.status !== "COMPLETED" || predecessor.contentRevision !== options.contentRevision
  ) return null;
  const attemptSuffix = predecessor.attemptId ? `:attempt:${predecessor.attemptId}` : "";
  const dedupeStem = predecessor.dedupeKey && (!attemptSuffix || predecessor.dedupeKey.endsWith(attemptSuffix))
    ? predecessor.dedupeKey.slice(0, predecessor.dedupeKey.length - attemptSuffix.length)
    : null;
  const successorPrefix = `${options.baseDedupeKey}:successor-of-`;
  const spendsCurrentIdentity = dedupeStem === options.baseDedupeKey ||
    (dedupeStem?.startsWith(successorPrefix) === true && !dedupeStem.slice(successorPrefix.length).includes(":"));
  return {
    dedupeKey: spendsCurrentIdentity
      ? `${options.baseDedupeKey}:successor-of-${predecessor.id}`
      : options.baseDedupeKey,
    attemptIdOverride: predecessor.attemptId,
    spendsCurrentIdentity
  };
}

/**
 * Returns a successor only when this completed row spent the exact current
 * revision, policy, and page-fingerprint identity. Callers still decide
 * whether the row is unpublished and relevant to their fan-in policy.
 */
export function compileSuccessorIdentityFromCompletedJob(options: {
  projectId: string;
  contentRevision: number;
  baseDedupeKey: string;
  predecessor: CompilePredecessor;
}): CompileIdentity | null {
  const identity = predecessorIdentity(options, options.predecessor);
  if (!identity?.spendsCurrentIdentity) return null;
  return {
    dedupeKey: identity.dedupeKey,
    attemptIdOverride: identity.attemptIdOverride
  };
}

/** Finds the latest relevant unpublished row that spent the current identity. */
export function recoveredCompileSuccessorIdentity(options: {
  projectId: string;
  contentRevision: number;
  baseDedupeKey: string;
  policyIdentity: string;
  projectStatus: string;
  jobs: readonly (CompilePredecessor & { payload: unknown })[];
}): CompileIdentity | null {
  for (const predecessor of options.jobs) {
    const policy = compilePublicationPolicyFromPayload(predecessor.payload);
    if (
      exportPublicationCommittedAt(predecessor.payload) !== null || policy.ownership.kind === "detached" ||
      compilePublicationPolicyIdentity(policy, options.projectStatus) !== options.policyIdentity
    ) continue;
    const identity = compileSuccessorIdentityFromCompletedJob({ ...options, predecessor });
    if (identity) return identity;
  }
  return null;
}

/** Derives one bounded, attempt-stable successor identity from a completed compile. */
export async function compileIdentityAfterCompletion(options: {
  projectId: string;
  contentRevision: number;
  baseDedupeKey: string;
  completedPredecessorId?: string;
}): Promise<{ dedupeKey: string; attemptIdOverride?: string | null }> {
  if (!options.completedPredecessorId) return { dedupeKey: options.baseDedupeKey };
  const predecessor = await prisma.generationJob.findUnique({
    where: { id: options.completedPredecessorId },
    select: {
      id: true,
      projectId: true,
      type: true,
      status: true,
      contentRevision: true,
      dedupeKey: true,
      attemptId: true
    }
  });
  if (!predecessor) return { dedupeKey: options.baseDedupeKey };
  const identity = predecessorIdentity(options, predecessor);
  return identity
    ? { dedupeKey: identity.dedupeKey, attemptIdOverride: identity.attemptIdOverride }
    : { dedupeKey: options.baseDedupeKey };
}
