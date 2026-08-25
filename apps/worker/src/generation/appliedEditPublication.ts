import type { SettledProjectStatus } from "@book-maker/core";
import { prisma, type Prisma } from "@book-maker/db";
import { invalidateProjectExports } from "./bookHelpers.js";
import {
  claimAppliedEditPublication,
  restoreEditProjectStatus
} from "./editProjectStatus.js";
import type { CompileDispatchOutcome } from "../runtime/dispatch.js";

type PublicationTransactionOptions = {
  maxWait?: number;
  timeout?: number;
};

type PublicationIdentity = {
  planVersionId: string;
};

type RevisionedPublicationIdentity = PublicationIdentity & {
  publicationRevision: number;
};

type AppliedEditPublicationBase = {
  projectId: string;
  operationId: string;
  fallbackStatus: SettledProjectStatus;
  /** Prefer the job's stamped plan; otherwise resolve the project's current plan under the claim. */
  planVersionId?: string | undefined;
  missingPlanMessage: string;
  enqueueFailureMessage: string;
  transactionOptions?: PublicationTransactionOptions;
  /** Variant fence that must still hold under the project/operation claim. */
  afterClaim?: (tx: Prisma.TransactionClient) => Promise<void>;
};

type UnrevisionedAppliedEditPublication = AppliedEditPublicationBase & {
  publicationRevision?: undefined;
  enqueue: (identity: PublicationIdentity) => Promise<CompileDispatchOutcome>;
};

type RevisionedAppliedEditPublication = AppliedEditPublicationBase & {
  publicationRevision: {
    resolve: (tx: Prisma.TransactionClient) => Promise<number | null>;
    missingMessage: string;
  };
  enqueue: (identity: RevisionedPublicationIdentity) => Promise<CompileDispatchOutcome>;
};

export type AppliedEditPublicationOptions =
  | UnrevisionedAppliedEditPublication
  | RevisionedAppliedEditPublication;

type AppliedEditPublicationOwner = Pick<
  AppliedEditPublicationBase,
  "projectId" | "operationId" | "fallbackStatus"
>;

async function restoreClaimedPublication(options: AppliedEditPublicationOwner): Promise<void> {
  await prisma
    .$transaction((tx) =>
      restoreEditProjectStatus(
        tx,
        options.projectId,
        options.operationId,
        options.fallbackStatus
      )
    )
    .catch(() => undefined);
}

/** Queue a tail whose claim and invalidation were already completed. */
export async function enqueueAppliedEditPublication<Identity extends PublicationIdentity>(
  options: AppliedEditPublicationOwner & {
    identity: Identity;
    enqueueFailureMessage: string;
    enqueue: (identity: Identity) => Promise<CompileDispatchOutcome>;
  }
): Promise<void> {
  let dispatched: CompileDispatchOutcome;
  try {
    dispatched = await options.enqueue(options.identity);
  } catch (error) {
    console.error(options.enqueueFailureMessage, error);
    dispatched = "not-ready";
  }

  if (dispatched === "not-ready") {
    await restoreClaimedPublication(options);
  }
}

/**
 * Publish one already-APPLIED edit's idempotent export tail.
 *
 * The claim is the gate for every later effect. Plan/revision resolution and
 * export invalidation stay under its project/operation locks; a variant lease
 * assertion runs there too. Enqueue failure cannot fail the delivered edit,
 * and fallback restoration proves ownership again so it cannot retire a newer
 * edit's lifecycle.
 */
export async function publishAppliedEditTail(
  options: AppliedEditPublicationOptions
): Promise<void> {
  const publication = await prisma.$transaction(async (tx) => {
    const claimed = await claimAppliedEditPublication(
      tx,
      options.projectId,
      options.operationId,
      options.fallbackStatus
    );
    if (!claimed) return null;

    await options.afterClaim?.(tx);

    const [project, publicationRevision] = await Promise.all([
      options.planVersionId === undefined
        ? tx.project.findUnique({
            where: { id: options.projectId },
            select: { currentPlanId: true }
          })
        : Promise.resolve(null),
      options.publicationRevision?.resolve(tx) ?? Promise.resolve(null)
    ]);
    const planVersionId = options.planVersionId ?? project?.currentPlanId;
    if (!planVersionId) {
      console.error(options.missingPlanMessage);
      await restoreEditProjectStatus(
        tx,
        options.projectId,
        options.operationId,
        options.fallbackStatus
      ).catch(() => undefined);
      return null;
    }

    if (options.publicationRevision && publicationRevision === null) {
      throw new Error(options.publicationRevision.missingMessage);
    }

    await invalidateProjectExports(options.projectId);
    return options.publicationRevision
      ? { planVersionId, publicationRevision: publicationRevision as number }
      : { planVersionId };
  }, options.transactionOptions);
  if (!publication) return;

  if (options.publicationRevision) {
    await enqueueAppliedEditPublication({
      ...options,
      identity: publication as RevisionedPublicationIdentity,
      enqueue: options.enqueue
    });
  } else {
    await enqueueAppliedEditPublication({
      ...options,
      identity: publication,
      enqueue: options.enqueue
    });
  }
}
