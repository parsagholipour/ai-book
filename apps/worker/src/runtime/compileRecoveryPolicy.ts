import {
  chapterHeadingStylePreference,
  compilePublicationPolicyFromPayload,
  includeSourcesPreference,
  MARKDOWN_RECOMPILE_WITHOUT_VERDICT,
  type CompilePublicationPolicy,
  type SettledProjectStatus
} from "@book-maker/core";
import { prisma, type BookEditOperationKind } from "@book-maker/db";
import { exportPublicationCommittedAt } from "../generation/exportPublicationEvidence.js";

/**
 * Recovering the compile intent for a revision whose compile row is missing.
 *
 * `dispatch.ts` queues work; this module answers the one question it cannot
 * answer from its arguments — what a compile for *this* manuscript was supposed
 * to be, when the caller that knew is gone. Every lane below is a different
 * durable record of that intent, ordered strongest first, and each returns null
 * rather than guessing: an unknown EDITING project is not permission to run
 * full QA or to publish a book as COMPLETE. It deliberately holds no queue
 * handle, so the policy can be exercised without a broker.
 */

/** The policy each edit handler uses when its own compile is first queued. */
function compileRecoveryPolicyFromEdit(kind: BookEditOperationKind): CompilePublicationPolicy {
  switch (kind) {
    case "ADD_IMAGE":
    case "MOVE_IMAGE":
    case "REMOVE_IMAGE":
      return compilePublicationPolicyFromPayload({
        skipFinalReview: true,
        [MARKDOWN_RECOMPILE_WITHOUT_VERDICT]: true
      });
    case "LOCAL_PATCH":
    case "PAGE_REWRITE":
    case "CHAPTER_REGENERATE":
    case "MANUAL_EDIT":
      return compilePublicationPolicyFromPayload({ skipFinalReview: true });
    case "PLAN_REVISION":
    case "BOOK_REPLAN":
    case "RESTRUCTURE_PAGES":
      return compilePublicationPolicyFromPayload({});
    case "CONTINUE_BOOK":
      // A continuation publishes its manuscript while the project remains
      // EDITING, and its checkpointed tail and any delayed reconciliation have
      // to name the same publication owner. Pinning puts that on the policy
      // rather than leaving it to be re-derived: an unpinned policy takes its
      // `expectedProjectStatus` from whichever project status the recovering
      // reader happens to observe, so a tail that enqueued at EDITING and a
      // sweep that observed anything else would build two dedupe identities
      // for one compile. It is not a GENERATING default that is being avoided
      // — `fallbackPublicationStatus` parses the observed status first and
      // answers EDITING for an EDITING project. Which is also why the arm
      // above stays unpinned: a replan copy's tail is the only thing that
      // settles it, so a status the tail never saw is one the derived policy
      // should follow rather than refuse to publish over.
      return compilePublicationPolicyFromPayload({
        exportPublicationProjectStatus: "EDITING"
      });
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * Recovers the compile intent already durably attached to this revision.
 *
 * Both live fan-in and delayed reconciliation use this selector so a later
 * detached repair cannot hide the outcome/presentation compile that owns the
 * project transition. GENERATING is the one state with an unambiguous default
 * when no compile row exists yet.
 */
function currentRevisionCompileRecoveryPolicy(project: {
  status: string;
  contentRevision: number;
  jobs: readonly { contentRevision: number | null; payload: unknown }[];
}): CompilePublicationPolicy | null {
  const currentRevisionJobs = project.jobs.filter((job) =>
    job.contentRevision === project.contentRevision
  );
  const priorCompile = currentRevisionJobs.find((job) =>
    compilePublicationPolicyFromPayload(job.payload).ownership.kind !== "detached"
  ) ?? currentRevisionJobs[0];
  if (priorCompile) {
    return compilePublicationPolicyFromPayload(priorCompile.payload);
  }
  return project.status === "GENERATING" ? compilePublicationPolicyFromPayload({}) : null;
}

export function strandedCompileRecoveryPolicy(project: {
  status: string;
  contentRevision: number;
  mediaSettings: unknown;
  jobs: readonly {
    contentRevision: number | null;
    payload: unknown;
    status?: string;
    ownsQualityVerdict?: boolean;
    qualityReport?: unknown;
  }[];
  editOperations: readonly { kind: BookEditOperationKind; status: string }[];
}): CompilePublicationPolicy | null {
  const currentRevisionPolicy = currentRevisionCompileRecoveryPolicy(project);
  if (currentRevisionPolicy) {
    return currentRevisionPolicy;
  }
  const edit = project.editOperations[0];
  if (edit) {
    return edit.status === "APPLIED" ? compileRecoveryPolicyFromEdit(edit.kind) : null;
  }

  // Presentation preferences used to commit the EDITING transition and the
  // revision bump before creating their compile row, and deliberately created
  // no BookEditOperation. A crash in that one historical gap therefore has no
  // current-revision intent to read. A presentation compile for the immediately
  // preceding revision is the one durable signal that carries both facts this
  // recovery must not guess: this is still a model-free, verdict-preserving
  // reprint, and the exact settled status it must restore. Do not generalize a
  // prior outcome/edit compile into this path; an unknown EDITING state is not
  // permission to run full QA or publish it as COMPLETE.
  const presentationPredecessor = project.jobs.find((job) =>
    job.contentRevision === project.contentRevision - 1 &&
    compilePublicationPolicyFromPayload(job.payload).ownership.kind === "presentation"
  );
  if (presentationPredecessor) {
    const policy = compilePublicationPolicyFromPayload(presentationPredecessor.payload);
    return {
      ...policy,
      review: { ...policy.review },
      expectedProjectStatus: "EDITING",
      ownership: { ...policy.ownership }
    };
  }

  // The first presentation edit has no earlier presentation payload to copy.
  // It is still distinguishable from an arbitrary EDITING row when the
  // immediately preceding revision has a completed verdict-owning compile
  // and the project now carries one of the presentation-only preferences
  // that old route wrote. That compile's report is the same durable verdict
  // that decided its settled publication status: blocked meant
  // REVIEW_REQUIRED; passed/review_recommended meant COMPLETE. A malformed or
  // absent old report cannot justify COMPLETE, so the one-time legacy lane
  // conservatively leaves the reader in REVIEW_REQUIRED while preserving the
  // prior verdict (the recovered compile itself owns no quality verdict).
  const outcomePredecessor = project.jobs.find((job) =>
    job.contentRevision === project.contentRevision - 1 &&
    job.status === "COMPLETED" &&
    job.ownsQualityVerdict === true &&
    compilePublicationPolicyFromPayload(job.payload).ownership.kind === "outcome"
  );
  if (outcomePredecessor && hasPresentationPreference(project.mediaSettings)) {
    return {
      review: { skipFinalReview: true, withoutQualityVerdict: false },
      expectedProjectStatus: "EDITING",
      ownership: {
        kind: "presentation",
        fallbackStatus: settledStatusFromQualityReport(outcomePredecessor.qualityReport) ?? "REVIEW_REQUIRED"
      }
    };
  }
  return null;
}

type StrandedProject = {
  id: string;
  status: string;
  contentRevision: number;
  currentPlanId: string | null;
  mediaSettings: unknown;
};

/**
 * Loads only the two revisions that can explain a stranded transition.
 *
 * BookEditOperation predates revision stamping, so recency within that table
 * alone is not ownership. A current edit must have applied after revision
 * N-1's last durably recorded project-owning publication; anything older was
 * already represented by that publication. A terminal job is not that proof:
 * superseded compiles stand down as COMPLETED too. If no publication marker
 * exists, the operation is ambiguous and only the legacy presentation checks
 * below get a chance to recover the project.
 */
export async function loadStrandedCompileRecoveryPolicy(
  project: StrandedProject
): Promise<{ policy: CompilePublicationPolicy } | null> {
  const revisions = project.contentRevision > 0
    ? [project.contentRevision, project.contentRevision - 1]
    : [project.contentRevision];
  const jobs = await prisma.generationJob.findMany({
    where: {
      projectId: project.id,
      type: "COMPILE_EXPORT",
      contentRevision: { in: revisions }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      contentRevision: true,
      payload: true,
      status: true,
      ownsQualityVerdict: true,
      qualityReport: true
    }
  });

  // A current-revision compile is the durable intent and wins before any
  // inference from an unversioned edit operation or predecessor.
  const currentRevisionPolicy = currentRevisionCompileRecoveryPolicy({ ...project, jobs });
  if (currentRevisionPolicy) {
    return { policy: currentRevisionPolicy };
  }

  const boundary = jobs
    .filter((job) =>
      job.contentRevision === project.contentRevision - 1 &&
      job.status === "COMPLETED" &&
      compilePublicationPolicyFromPayload(job.payload).ownership.kind !== "detached"
    )
    .map((job) => exportPublicationCommittedAt(job.payload))
    .filter((committedAt): committedAt is Date => committedAt !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const [currentEditCandidate, unfinishedCurrentEdit] = await Promise.all([
    boundary
      ? prisma.bookEditOperation.findFirst({
          where: {
            projectId: project.id,
            status: "APPLIED",
            appliedAt: { gte: boundary }
          },
          orderBy: [{ appliedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          select: { kind: true, status: true, appliedAt: true }
        })
      : Promise.resolve(null),
    prisma.bookEditOperation.findFirst({
      where: {
        projectId: project.id,
        status: { in: ["QUEUED", "ACTIVE"] },
        ...(boundary ? { createdAt: { gte: boundary } } : {})
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true }
    })
  ]);
  const currentEdit = currentEditCandidate?.appliedAt && boundary &&
      currentEditCandidate.appliedAt.getTime() > boundary.getTime()
    ? currentEditCandidate
    : null;
  // Equal millisecond timestamps cannot establish which side of the revision
  // boundary an unversioned operation belongs to. Preserve the unknown state.
  if (unfinishedCurrentEdit || (currentEditCandidate && !currentEdit)) {
    return null;
  }

  const policy = strandedCompileRecoveryPolicy({
    ...project,
    jobs,
    editOperations: currentEdit ? [currentEdit] : []
  }) ?? (await forkedPublicationRecoveryPolicy(project));
  return policy ? { policy } : null;
}

/**
 * The APPLIED operation that published this project from another book's chat.
 *
 * `book_replan` is the one edit that regenerates a project it does not belong
 * to. `queueChatBookReplanCopy` files the operation against the *source* book —
 * `projectId` and `sourceProjectId` both name it, deliberately, because the
 * source is the manuscript being revised and the chat it was asked in — and
 * forks a second `Project` for the result; `publishReplannedBook` then leaves
 * that fork EDITING at the revision it stamps on the operation. Nothing on the
 * operation names the fork. The only link pointing at it is `generationJobId`,
 * which `linkReplanSuccessor` re-targets at the successor `generate-book` row
 * on the copy.
 *
 * So every lane above, scoped to the stranded project's own rows, finds nothing
 * for a replan copy — and that is not just the crash case. An illustrated
 * replan's tail queues the cover and the page illustrations and then gets
 * "waiting" from its own compile step, so it writes no compile row at all; the
 * image fan-in that fires when the last picture lands is optionless and had no
 * edit to recover an intent from. The copy the reader paid for stayed EDITING,
 * with no PDF and nothing left that could build one.
 *
 * `publicationRevision` is what makes this exact rather than one more recency
 * heuristic: it is stamped in the same transaction that increments the fork's
 * `contentRevision`, so an operation naming any other revision published a
 * manuscript this project no longer has. Paired with a successor job on this
 * project it identifies one operation, and the `not` keeps a book from
 * recovering its own edits through this lane — those are the boundary-fenced
 * lanes' business, and an operation reaching both must be read there.
 */
export async function forkedPublicationRecoveryPolicy(project: {
  id: string;
  contentRevision: number;
}): Promise<CompilePublicationPolicy | null> {
  const operation = await prisma.bookEditOperation.findFirst({
    where: {
      status: "APPLIED",
      projectId: { not: project.id },
      publicationRevision: project.contentRevision,
      generationJob: { projectId: project.id }
    },
    orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
    select: { kind: true }
  });
  return operation ? compileRecoveryPolicyFromEdit(operation.kind) : null;
}

function hasPresentationPreference(mediaSettings: unknown): boolean {
  return includeSourcesPreference(mediaSettings) !== undefined ||
    chapterHeadingStylePreference(mediaSettings) !== undefined;
}

function settledStatusFromQualityReport(qualityReport: unknown): SettledProjectStatus | null {
  if (!qualityReport || typeof qualityReport !== "object" || Array.isArray(qualityReport)) {
    return null;
  }
  const state = (qualityReport as Record<string, unknown>).state;
  if (state === "blocked") return "REVIEW_REQUIRED";
  return state === "passed" || state === "review_recommended" ? "COMPLETE" : null;
}
