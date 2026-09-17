import {
  BOOK_PDF_PAGE_MAP_VERSION,
  bookPdfCoverNumbering,
  parseStoredBookPdfNumbering,
  type BookPdfCoverNumbering,
  type PersistableBookPdfPageMap,
  type ExportRepairFormat,
  type ExportPublicationProjectStatus
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { claimAppliedEditPublication } from "./editProjectStatus.js";
import { characterPreparationDedupeKey } from "./characterPreparation.js";
import {
  artifactPublications,
  discardSupersededArtifacts,
  formatsTouchedByPublication,
  installArtifacts,
  pendingExportDigests,
  provenancePublications,
  restoreSupersededArtifacts,
  type ArtifactPublication,
  type CompanionsProduced,
  type PendingExportPaths
} from "./exportArtifacts.js";

export { discardPendingExports, pendingExportPaths, type PendingExportPaths } from "./exportArtifacts.js";
import { payloadWithExportPublicationEvidence } from "./exportPublicationEvidence.js";

/**
 * Publishing a compiled book, and the one race it exists for.
 *
 * `staleGenerationJobReason` refuses to *start* a compile whose manuscript has
 * already moved on, but that is a single point in time and the work behind it
 * takes minutes: final QA, reader chapters, a Chromium render. A compile queued
 * as an export repair runs against a project that is COMPLETE — nothing stops
 * the reader editing the book underneath it, and an edit bumps
 * `contentRevision`, deletes the compiled files, sets the project EDITING and
 * queues its own recompile. The stale compile then wrote its pre-edit files
 * over the fresh ones and set COMPLETE over EDITING, so a book could sit
 * finished with the wrong PDF for good.
 *
 * Candidates are rendered in scoped local scratch. The final revision claim
 * holds the project row lock while exportArtifacts uploads one artifact at a
 * time to S3, so an edit or competing publication cannot interleave with it.
 * The transaction exposes the completed status only after every upload.
 *
 * SQL cannot undo object storage. Before replacing each artifact, publication
 * makes a server-side copy to a unique predecessor key. Any failed upload or
 * rejected transaction restores predecessors in reverse order; first-time
 * uploads are deleted instead. A request marked as attempted is rolled back
 * even if its response failed, since the remote write may have succeeded.
 * Backups remain until Prisma confirms the commit, then are deleted. Abandoned
 * backups and local renderer scratch are collected by separate age-based sweeps.
 *
 * Declining to write the status is safe because every `contentRevision` bump
 * queues its own compile — `queueUserEditExportRecompile`, `applyBookEdit` and
 * `continueBook` all do — so the project is never left waiting on the compile
 * that stood down.
 *
 * The revision alone is not the whole claim, because an edit takes the project
 * EDITING *first* and bumps the revision *last*: `applyBookEdit` sets the status
 * before it rewrites a single page and increments only once every page is saved,
 * and `continueBook` does the same across a whole appended chapter. For the
 * minutes in between, a repair compiled for the pre-edit revision still matches
 * the revision — so its status write landed COMPLETE on a book that was being
 * rewritten under it, retiring the app's edit progress and telling the reader a
 * half-applied edit was finished.
 *
 * A publication also records *what* it published: the digest of each installed
 * artifact, beside it, under the revision this compile claimed. That record is
 * the only thing tying downloaded bytes back to a compile — every one of them
 * is served from the same filename, and two compiles of one manuscript can
 * differ by no bytes at all — so without it a download landing mid-publication
 * is filed under whichever revision the client last heard about. See
 * `exportProvenance.ts` in `packages/core`.
 *
 * Which is why a repair does not write the status at all. It is queued only for
 * a project that is already COMPLETE or REVIEW_REQUIRED
 * (`ensureExportRepairQueued`), it rebuilds a file rather than the book, and it
 * runs with `skipFinalReview` — so its deterministic-only verdict is not the
 * project's verdict either, and letting it speak could only ever overwrite a
 * REVIEW_REQUIRED the full compile earned. Its claim keeps the row lock and the
 * revision check, and adds the statuses it is allowed to find: anything else
 * means the book moved on and this compile is not the one to publish it.
 */

export type ExportPublicationResult = {
  published: boolean;
  /** Publication claim matched, but a page/cover image job still owns fan-in. */
  blockedByOpenImageJobs: boolean;
  /** Optional derivative row committed with the export, ready for Redis dispatch. */
  characterPreparationJobId: string | null;
};

/**
 * Whether the manuscript has moved on since this compile was queued.
 *
 * Only an early exit: it saves a doomed compile its reader-chapter call and its
 * Chromium render. The decision that matters is the compare-and-set in
 * `publishCompiledExports`, because an edit can land at any point after this.
 */
export async function exportPublicationSuperseded(
  projectId: string,
  contentRevision: number | null
): Promise<boolean> {
  if (contentRevision === null) {
    return false;
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { contentRevision: true }
  });
  return project !== null && project.contentRevision !== contentRevision;
}

/**
 * The statuses a compile that owns no status may publish over.
 *
 * They are the two a repair is queued for. GENERATING and EDITING are the
 * cases this list exists to refuse: both mean somebody else is writing the book
 * right now, and both can hold the revision this compile matched.
 */
const DETACHED_PUBLISHABLE_STATUSES = ["COMPLETE", "REVIEW_REQUIRED"] as const;

/**
 * How long the publication transaction may hold the project row.
 *
 * The work inside it is one compare-and-set and three object writes within a single
 * directory — metadata operations, microseconds — so this is an outage bound
 * rather than a budget: storage that has stopped answering must fail the
 * compile rather than pin a lock every edit to this book has to take. The wait
 * is for a pool connection instead, and matches Prisma's own pool timeout, so a
 * busy worker queues for one as it did when this was a bare `updateMany`.
 */
const PUBLICATION_TRANSACTION_TIMEOUT_MS = 30_000;
const PUBLICATION_TRANSACTION_MAX_WAIT_MS = 10_000;

/**
 * What replaces the stored ranges when a PDF is published without a current
 * measurement of it.
 *
 * Only the cover-skip survives, because only the cover-skip is still true: the
 * bytes being installed came out of a renderer that resets the page counter on
 * the cover sheet whatever else went wrong, while their pagination is unknown
 * and the stored ranges were measured from a different render. That is the
 * same trade `persistablePdfPageMapAfterRender` makes for a failed measurement
 * — chrome keeps matching the footer, chat drops back to model indexes — and
 * the ranges are gone either way, which is the part the invariant is about.
 *
 * The cover-skip comes from the map the caller offered when it offered one at
 * all, and otherwise from the row itself, read here under the lock this
 * transaction already holds — the one place that read cannot race the file it
 * describes. A row no parser can read a cover-skip out of is a row every
 * reader already refuses, so it is left alone rather than replaced by a guess.
 */
async function degradedPdfNumbering(
  tx: Prisma.TransactionClient,
  projectId: string,
  offered: PersistableBookPdfPageMap | undefined
): Promise<BookPdfCoverNumbering | undefined> {
  if (offered) {
    return bookPdfCoverNumbering(offered.hasCoverPage);
  }
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { pdfPageMap: true }
  });
  const stored = parseStoredBookPdfNumbering(project?.pdfPageMap);
  return stored ? bookPdfCoverNumbering(stored.hasCoverPage) : undefined;
}

async function settlePublishedGenerationAttempt(
  tx: Prisma.TransactionClient,
  projectId: string,
  attemptId: string | null
): Promise<void> {
  if (!attemptId) {
    return;
  }
  const settled = await tx.generationAttempt.updateMany({
    where: { id: attemptId, projectId, status: { in: ["QUEUED", "ACTIVE"] } },
    data: {
      status: "SUCCEEDED",
      finishedAt: new Date(),
      error: null,
      refundPending: false
    }
  });
  if (settled.count === 1) {
    return;
  }
  const existing = await tx.generationAttempt.findUnique({
    where: { id: attemptId },
    select: { projectId: true, status: true }
  });
  if (existing?.projectId === projectId && existing.status === "SUCCEEDED") {
    return;
  }
  throw new Error("Export publication could not settle its generation attempt");
}

async function settlePublishedEditOperation(
  tx: Prisma.TransactionClient,
  projectId: string,
  editOperationId: string | null
): Promise<void> {
  if (!editOperationId) {
    return;
  }
  const settled = await tx.bookEditOperation.updateMany({
    where: { id: editOperationId, projectId, status: { in: ["QUEUED", "ACTIVE"] } },
    data: { status: "APPLIED", appliedAt: new Date() }
  });
  if (settled.count === 1) {
    return;
  }
  const existing = await tx.bookEditOperation.findUnique({
    where: { id: editOperationId },
    select: { projectId: true, status: true }
  });
  if (existing?.projectId === projectId && existing.status === "APPLIED") {
    return;
  }
  throw new Error("Export publication could not settle its edit operation");
}

async function claimCharacterPreparationJob(
  tx: Prisma.TransactionClient,
  options: {
    projectId: string;
    planId: string;
    attemptId: string | null;
  }
): Promise<string | null> {
  const existingCharacters = await tx.voiceCharacter.count({
    where: {
      projectId: options.projectId,
      planVersionId: options.planId,
      status: { not: "REJECTED" }
    }
  });
  if (existingCharacters > 0) {
    return null;
  }
  const openJob = await tx.generationJob.findFirst({
    where: {
      projectId: options.projectId,
      type: "PREPARE_CHARACTER_CANDIDATES",
      status: { in: ["QUEUED", "ACTIVE"] },
      payload: { path: ["planId"], equals: options.planId }
    },
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });
  if (openJob) {
    return openJob.id;
  }

  const dedupeKey = characterPreparationDedupeKey(options.projectId, options.planId, options.attemptId);
  const claimed = await tx.generationJob.upsert({
    where: { dedupeKey },
    create: {
      projectId: options.projectId,
      type: "PREPARE_CHARACTER_CANDIDATES",
      status: "QUEUED",
      progress: 0,
      message: "Queued",
      dedupeKey,
      // The paid attempt scopes the idempotency key, but this is derivative
      // work after that attempt has already succeeded. Relating the row back
      // to the attempt would let a later character-provider failure try to
      // fail/refund the delivered book and stop its sibling jobs.
      ownsQualityVerdict: false,
      payload: { planId: options.planId } as Prisma.InputJsonValue
    },
    update: {},
    select: { id: true, status: true }
  });
  return claimed.status === "QUEUED" || claimed.status === "ACTIVE" ? claimed.id : null;
}

/**
 * Claims the project for this compile, then moves its artifacts into place.
 *
 * Both happen under one transaction, so the claim cannot go stale before the
 * files it authorises are published, and no reader sees the status this compile
 * writes until every one of them is on disk. A loser publishes no files at all.
 * A object write that fails rolls the status write back *and* puts the artifacts it
 * already moved back, leaving the project exactly where the compile found it for
 * the failure path to settle — the storage half of that is `installArtifacts`
 * and `restoreSupersededArtifacts`, since SQL cannot undo a object write.
 *
 * A compile whose payload carries no revision (older rows) claims
 * unconditionally, which is exactly what it did before — except that a detached
 * one still has to find a publishable status, since that guard is the only one
 * it has left.
 */
export async function publishCompiledExports(options: {
  projectId: string;
  /** Durable row claimed ACTIVE by this Bull delivery. */
  generationJobId: string;
  pending: PendingExportPaths;
  /** The companions are best-effort; a compile publishes without any of them. */
  companionsProduced: CompanionsProduced;
  /** A detached repair replaces only the file the caller found unreadable. */
  repairFormat?: ExportRepairFormat | null;
  /**
   * The repair found no published manuscript and rebuilt one from the durable
   * project pages. Install it with the requested derivative so later repairs
   * have an exact `book.md` source again.
   */
  publishReconstructedMarkdown?: boolean;
  contentRevision: number | null;
  /**
   * Where each model page landed in the PDF this publication installs.
   * Omitted only for a companion-only repair. A version-2 persistable map —
   * measured, including one whose `pages` is empty, or a cover-numbering stub —
   * is stamped as-is. Empty `pages` is not "was never a measurement": that row
   * still has totals, cover-skip and furniture starts. A missing or version-1
   * map is *degraded* to the stub rather than refused, because preserving a
   * legacy or stale map across newly rendered bytes is forbidden, and a book
   * on disk may not be failed over the metadata beside it.
   */
  pdfPageMap?: PersistableBookPdfPageMap | undefined;
  expectedProjectStatus: ExportPublicationProjectStatus;
  status: "COMPLETE" | "REVIEW_REQUIRED";
  /**
   * Whether this compile's verdict is the *project's* verdict — true for the
   * compile that ends a generation or applies an edit, false for a repair
   * rebuilding a file on a book that is already finished and already paid for.
   */
  ownsProjectStatus: boolean;
  /** Paid-attempt settlement committed with the artifact verdict. */
  generationAttemptId?: string | null;
  /** Edit settlement committed with the artifact verdict. */
  editOperationId?: string | null;
  /** Present only for a paid, non-presentation compile. */
  characterPreparation?: { planId: string; attemptId: string | null } | null;
}): Promise<ExportPublicationResult> {
  const repairFormat = options.repairFormat ?? null;
  const generationAttemptId = options.generationAttemptId ?? null;
  const editOperationId = options.editOperationId ?? null;
  const characterPreparation = options.characterPreparation ?? null;
  const pdfPageMapIsCurrent = options.pdfPageMap?.version === BOOK_PDF_PAGE_MAP_VERSION;
  // Version 2 is current whether it has ranges, empty `pages`, or is a
  // cover-numbering stub. What it may never do is leave version-1 ranges
  // standing over bytes they were not measured from. Refusing to publish was
  // the wrong way to say that. `compile-export` owns the project's outcome
  // and carries no retry budget, so a throw here reaches `markFailed`: a book
  // whose pages are already written goes FAILED and refunded — or its edit is
  // settled as a failure — over a few hundred bytes of metadata beside it.
  // "No compile may fail, publish differently, or retry over the map" is the
  // documented rule (`packages/core/src/generation/CLAUDE.md`), and it is the
  // same call the provenance record in this file already makes. So a missing
  // or version-1 map degrades to the stub — which is what clears the ranges
  // the rule is actually about — and says so.
  const publishesPdf = repairFormat === null || repairFormat === "pdf";
  const degradesPdfPageMap = publishesPdf && !pdfPageMapIsCurrent;
  if (degradesPdfPageMap) {
    console.warn("Publishing a PDF without a current page map; storing cover numbering instead.", {
      projectId: options.projectId,
      generationJobId: options.generationJobId,
      repairFormat,
      mapVersion: options.pdfPageMap?.version ?? null,
      mapRanges: options.pdfPageMap?.pages.length ?? null
    });
  }
  // A null attempt is the legacy project/plan key — an edit's recompile uses it
  // deliberately, so only a *named* attempt has to be the one being published.
  if (characterPreparation?.attemptId && characterPreparation.attemptId !== generationAttemptId) {
    throw new Error("Character preparation attempt must match the published export attempt");
  }
  const digests = await pendingExportDigests({ ...options, repairFormat });
  let publications: ArtifactPublication[] = [];
  let publicationStarted = false;
  let restoredInsideTransaction = false;
  let published: boolean;
  let blockedByOpenImageJobs = false;
  let characterPreparationJobId: string | null = null;
  try {
    published = await prisma.$transaction(
      async (tx) => {
        // Lock the project first. The stop path uses the same order before it
        // terminalizes open jobs, preventing a deadlock and making publication
        // vs cancellation one winner-takes-all decision.
        const projectClaim = await tx.project.updateMany({
          where: {
            id: options.projectId,
            ...(options.contentRevision === null ? {} : { contentRevision: options.contentRevision }),
            // A text-edit publication commits its manuscript before it unlinks
            // the old shared files, stamping the barrier with the revision it
            // published. Only a barrier at *this claim's* revision is that gap:
            // the CAS above pins the row to `options.contentRevision`, so any
            // other value was left by a tail that died without a redelivery.
            // Recovery sweeps an abandoned *current* barrier only after its
            // operation lease expires; refusing an older value here would still
            // stand later revisions down unnecessarily until that delayed pass.
            // Both `OR` arms are load-bearing: Prisma compiles a bare
            // `{ not: n }` to `<> $1`, UNKNOWN — and so no match — for the null
            // barrier every healthy project has. A payload with no revision has
            // nothing to compare against and stays strict.
            ...(options.contentRevision === null
              ? { exportInvalidationRevision: null }
              : { OR: [
                  { exportInvalidationRevision: null },
                  { exportInvalidationRevision: { not: options.contentRevision } }
                ] }),
            status: options.ownsProjectStatus
              ? options.expectedProjectStatus
              : { in: [...DETACHED_PUBLISHABLE_STATUSES] }
          },
          data: { contentRevision: { increment: 0 } }
        });
        if (projectClaim.count !== 1) {
          return false;
        }

        // Stop takes every open GenerationJob lock before it touches a linked
        // BookEditOperation. Claim this compile row in the same order before
        // the edit-publication fence below; terminalization still happens only
        // after every publication precondition passes.
        const publicationJobLock = await tx.generationJob.updateMany({
          where: {
            id: options.generationJobId,
            projectId: options.projectId,
            type: "COMPILE_EXPORT",
            status: "ACTIVE",
            ...(generationAttemptId ? { attemptId: generationAttemptId } : {}),
            ...(options.contentRevision === null ? {} : { contentRevision: options.contentRevision })
          },
          data: { dispatchAttempts: { increment: 0 } }
        });
        if (publicationJobLock.count !== 1) {
          return false;
        }

        // An edit moves EDITING first and its revision last. The revision CAS
        // above therefore cannot distinguish this edit's render from a newer
        // edit or presentation lifecycle that has only just opened. Bind an
        // edit compile to the APPLIED operation/revision generation too; the
        // current compile row is allowed because it is the handoff being
        // published, while any other later lifecycle makes this render stand
        // down before touching files or status.
        if (
          editOperationId &&
          options.expectedProjectStatus === "EDITING" &&
          !(await claimAppliedEditPublication(
            tx,
            options.projectId,
            editOperationId,
            "COMPLETE",
            [options.generationJobId]
          ))
        ) {
          return false;
        }

        // The project lock orders this count against final-QA repair
        // publication, whose first statement takes the same lock. A preflight
        // count cannot do that: independent READ COMMITTED snapshots can see
        // zero jobs and then the sibling's repaired page. Here either the
        // repair committed first and its durable job blocks the object writes, or
        // this publication won first and the repair waits until these files
        // describe the manuscript that existed before it.
        const openImageJobs = await tx.generationJob.count({
          where: {
            projectId: options.projectId,
            type: "GENERATE_IMAGE",
            status: { in: ["QUEUED", "ACTIVE"] }
          }
        });
        if (openImageJobs > 0) {
          blockedByOpenImageJobs = true;
          return false;
        }

        // Bind the filesystem move to the durable ACTIVE row. Marking it
        // COMPLETED in this transaction closes both race directions: a stop
        // that won already makes this claim miss, while a stop that follows the
        // commit sees no open row to fail or refund.
        const publicationJob = await tx.generationJob.findUnique({
          where: { id: options.generationJobId },
          select: { payload: true }
        });
        const publicationCommittedAt = new Date();
        const jobClaim = await tx.generationJob.updateMany({
          where: {
            id: options.generationJobId,
            projectId: options.projectId,
            type: "COMPILE_EXPORT",
            status: "ACTIVE",
            ...(generationAttemptId ? { attemptId: generationAttemptId } : {}),
            ...(options.contentRevision === null ? {} : { contentRevision: options.contentRevision })
          },
          data: {
            status: "COMPLETED",
            progress: 100,
            message: "Export published",
            finishedAt: publicationCommittedAt,
            payload: payloadWithExportPublicationEvidence(
              publicationJob?.payload,
              publicationCommittedAt
            ) as Prisma.InputJsonValue
          }
        });
        if (jobClaim.count !== 1) {
          return false;
        }
        if (options.ownsProjectStatus) {
          await tx.project.update({ where: { id: options.projectId }, data: { status: options.status } });
        }
        await settlePublishedGenerationAttempt(tx, options.projectId, generationAttemptId);
        await settlePublishedEditOperation(tx, options.projectId, editOperationId);
        characterPreparationJobId = characterPreparation
          ? await claimCharacterPreparationJob(tx, {
              projectId: options.projectId,
              planId: characterPreparation.planId,
              attemptId: characterPreparation.attemptId
            })
          : null;

        const revision = options.contentRevision ??
          (await tx.project.findUnique({
            where: { id: options.projectId },
            select: { contentRevision: true }
          }))?.contentRevision;
        if (revision === undefined) {
          throw new Error("Export publication lost its claimed project revision");
        }
        if (publishesPdf) {
          // Before the object writes: a object write failure rolls this back with the rest
          // of the claim, leaving the previous map describing the file
          // `restoreSupersededArtifacts` puts back.
          const pdfDigest = digests.get("pdf")?.digest;
          const publishedPageMap = pdfPageMapIsCurrent
            ? options.pdfPageMap
            : await degradedPdfNumbering(tx, options.projectId, options.pdfPageMap);
          if (publishedPageMap) {
            await tx.project.update({
              where: { id: options.projectId },
              data: {
                pdfPageMap: {
                  ...publishedPageMap,
                  contentRevision: revision,
                  ...(pdfDigest ? { pdfDigest } : {})
                } as unknown as Prisma.InputJsonValue
              }
            });
          }
        }
        const exportPublications = artifactPublications({
          ...options,
          repairFormat,
          publishReconstructedMarkdown: options.publishReconstructedMarkdown === true
        });
        const metadataPublications = await provenancePublications({
          projectId: options.projectId,
          pending: options.pending,
          contentRevision: revision,
          digests,
          formatsTouched: formatsTouchedByPublication(repairFormat)
        });
        publications = [...exportPublications, ...metadataPublications];
        publicationStarted = true;
        try {
          await installArtifacts(publications);
        } catch (error) {
          await restoreSupersededArtifacts(publications);
          restoredInsideTransaction = true;
          throw error;
        }
        return true;
      },
      { timeout: PUBLICATION_TRANSACTION_TIMEOUT_MS, maxWait: PUBLICATION_TRANSACTION_MAX_WAIT_MS }
    );
  } catch (error) {
    // Prisma can reject after the callback returned (commit failure/timeout).
    // The predecessor files must therefore remain parked until this await has
    // confirmed the SQL commit; only then is it safe to discard them.
    if (publicationStarted && !restoredInsideTransaction) {
      await restoreSupersededArtifacts(publications);
    }
    throw error;
  }
  if (published) {
    await discardSupersededArtifacts(publications);
  }
  return {
    published,
    blockedByOpenImageJobs,
    characterPreparationJobId: published ? characterPreparationJobId : null
  };
}
