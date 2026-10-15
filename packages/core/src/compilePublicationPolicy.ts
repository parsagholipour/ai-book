import {
  DETACHED_FROM_PROJECT_LIFECYCLE,
  EXPORT_PUBLICATION_PROJECT_STATUS,
  EXPORT_REPAIR_FORMAT,
  exportPublicationProjectStatusFromPayload,
  exportRepairFormatFromPayload,
  FREE_EDIT_RECOMPILE,
  isDetachedFromProjectLifecycle,
  isFreeEditRecompile,
  isMarkdownRecompileWithoutVerdict,
  isPresentationOnlyRecompile,
  MARKDOWN_RECOMPILE_WITHOUT_VERDICT,
  PRE_EDIT_PROJECT_STATUS,
  preEditProjectStatus,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS,
  presentationRecompileFallbackStatus,
  skipsFinalReview,
  type ExportPublicationProjectStatus,
  type ExportRepairFormat,
  type SettledProjectStatus
} from "./jobScope.js";
import type { ExportFormat } from "./generation/exportFormats.js";

/** Every compile behavior that changes QA, verdict ownership, or publication. */
export type CompilePublicationPolicy = {
  review: { skipFinalReview: boolean; withoutQualityVerdict: boolean };
  expectedProjectStatus: ExportPublicationProjectStatus | null;
  /**
   * Who answers for the compile's exit. `outcome` is the paid book's own;
   * `freeEdit` — any edit's recompile on a delivered book, free or paid
   * (`editRecompilePolicy`) — compiles, reviews and publishes exactly like it
   * but fails or stops alone back to `fallbackStatus` (`FREE_EDIT_RECOMPILE`);
   * `presentation` also leaves the verdict and publishes `fallbackStatus`;
   * `detached` owns nothing at all.
   */
  ownership:
    | { kind: "outcome" }
    | { kind: "freeEdit"; fallbackStatus: SettledProjectStatus }
    | { kind: "presentation"; fallbackStatus: SettledProjectStatus }
    | { kind: "detached"; repairFormat: ExportRepairFormat | null };
};

export type LegacyCompileOptions = {
  skipFinalReview?: boolean;
  withoutQualityVerdict?: boolean;
};

/** Recover every flag that changes QA, publication, verdict, or settlement. */
export function compilePublicationPolicyFromPayload(payload: unknown): CompilePublicationPolicy {
  const ownership: CompilePublicationPolicy["ownership"] = isDetachedFromProjectLifecycle(payload)
    ? { kind: "detached", repairFormat: exportRepairFormatFromPayload(payload) }
    : isPresentationOnlyRecompile(payload)
      ? { kind: "presentation", fallbackStatus: presentationRecompileFallbackStatus(payload) }
      : isFreeEditRecompile(payload)
        ? { kind: "freeEdit", fallbackStatus: preEditProjectStatus(payload) }
        : { kind: "outcome" };
  return {
    review: {
      skipFinalReview: skipsFinalReview(payload),
      withoutQualityVerdict: isMarkdownRecompileWithoutVerdict(payload)
    },
    expectedProjectStatus: exportPublicationProjectStatusFromPayload(payload),
    ownership
  };
}

/**
 * The recompile an edit of a delivered book queues, free or paid: published
 * over EDITING, reviewed as `review` says, owning the verdict but never the
 * book's failure, and putting `fallbackStatus` back if it fails or is stopped.
 *
 * A paid chat edit's charge is settled by the edit itself — its attempt goes
 * SUCCEEDED in the transaction that publishes the pages — so the render after
 * it has nothing of the charge to answer for, exactly as a free edit's has
 * nothing. It used to be an ordinary outcome compile carrying the edit's
 * attempt: one failed render marked the delivered, readable book FAILED while
 * the edit's charge correctly stood. The ownership kind is still spelled
 * `freeEdit` (with the `FREE_EDIT_RECOMPILE` payload key and the `of` identity
 * code) because those are in stored payloads and dedupe keys; read it as "an
 * edit's recompile", which is free whatever the edit cost.
 */
export function editRecompilePolicy(
  fallbackStatus: SettledProjectStatus,
  review: CompilePublicationPolicy["review"] = { skipFinalReview: true, withoutQualityVerdict: false }
): CompilePublicationPolicy {
  return {
    review: { ...review },
    expectedProjectStatus: "EDITING",
    ownership: { kind: "freeEdit", fallbackStatus }
  };
}

/**
 * The recompile every free edit queues — a manual save, Undo, Redo, a Studio
 * publish or takeover: skip-review, published over EDITING, owning the verdict
 * but not the paid book's failure, and putting `fallbackStatus` back if it
 * fails or is stopped.
 */
export function freeEditRecompilePolicy(fallbackStatus: SettledProjectStatus): CompilePublicationPolicy {
  return editRecompilePolicy(fallbackStatus);
}

export function legacyCompilePolicy(options: LegacyCompileOptions): CompilePublicationPolicy {
  return {
    review: {
      skipFinalReview: options.skipFinalReview === true,
      withoutQualityVerdict: options.withoutQualityVerdict === true
    },
    expectedProjectStatus: null,
    // Detached compiles are deliberately unavailable through the legacy
    // shorthand: the handler requires an exact repair format, so callers must
    // construct the deep policy that can carry it.
    ownership: { kind: "outcome" }
  };
}

function fallbackPublicationStatus(
  policy: CompilePublicationPolicy,
  projectStatus: string
): ExportPublicationProjectStatus {
  const parsed = exportPublicationProjectStatusFromPayload({
    [EXPORT_PUBLICATION_PROJECT_STATUS]: projectStatus
  });
  if (parsed) return parsed;
  if (policy.review.skipFinalReview) return "EDITING";
  return projectStatus === "COMPLETE" ? "COMPLETE" : "GENERATING";
}

/** Materialize defaults so payloads and dedupe identity describe the same job. */
export function normalizedCompilePublicationPolicy(
  policy: CompilePublicationPolicy,
  projectStatus: string
): CompilePublicationPolicy & { expectedProjectStatus: ExportPublicationProjectStatus } {
  return {
    ...policy,
    review: { ...policy.review },
    ownership: { ...policy.ownership },
    expectedProjectStatus: policy.expectedProjectStatus ?? fallbackPublicationStatus(policy, projectStatus)
  };
}

export function compilePolicyPayload(
  policy: CompilePublicationPolicy,
  projectStatus: string
): Record<string, unknown> {
  const normalized = normalizedCompilePublicationPolicy(policy, projectStatus);
  return {
    [EXPORT_PUBLICATION_PROJECT_STATUS]: normalized.expectedProjectStatus,
    ...(normalized.review.skipFinalReview ? { skipFinalReview: true } : {}),
    ...(normalized.review.withoutQualityVerdict ? { [MARKDOWN_RECOMPILE_WITHOUT_VERDICT]: true } : {}),
    ...(normalized.ownership.kind === "presentation"
      ? {
          [PRESENTATION_ONLY_RECOMPILE]: true,
          [PRESENTATION_RECOMPILE_FALLBACK_STATUS]: normalized.ownership.fallbackStatus
        }
      : {}),
    ...(normalized.ownership.kind === "freeEdit"
      ? {
          [FREE_EDIT_RECOMPILE]: true,
          [PRE_EDIT_PROJECT_STATUS]: normalized.ownership.fallbackStatus
        }
      : {}),
    ...(normalized.ownership.kind === "detached"
      ? {
          [DETACHED_FROM_PROJECT_LIFECYCLE]: true,
          ...(normalized.ownership.repairFormat
            ? { [EXPORT_REPAIR_FORMAT]: normalized.ownership.repairFormat }
            : {})
        }
      : {})
  };
}

/**
 * One letter per repairable format. The letters for the PDF and EPUB predate
 * the registry and are part of live dedupe keys, so they never move.
 */
const REPAIR_FORMAT_CODE: Record<ExportFormat, string> = { pdf: "p", epub: "e", docx: "d" };

const publicationStatusCode: Record<ExportPublicationProjectStatus, string> = {
  GENERATING: "g",
  EDITING: "e",
  COMPLETE: "c",
  REVIEW_REQUIRED: "r"
};

/** A compact, complete, stable identity for policy-aware open-job matching. */
export function compilePublicationPolicyIdentity(
  policy: CompilePublicationPolicy,
  projectStatus: string
): string {
  const normalized = normalizedCompilePublicationPolicy(policy, projectStatus);
  const ownership = normalized.ownership.kind === "outcome"
    ? "oo"
    : normalized.ownership.kind === "presentation"
      ? `op${normalized.ownership.fallbackStatus === "REVIEW_REQUIRED" ? "r" : "c"}`
      : normalized.ownership.kind === "freeEdit"
        ? `of${normalized.ownership.fallbackStatus === "REVIEW_REQUIRED" ? "r" : "c"}`
        : `od${normalized.ownership.repairFormat ? REPAIR_FORMAT_CODE[normalized.ownership.repairFormat] : "n"}`;
  return [
    `r${normalized.review.skipFinalReview ? 1 : 0}`,
    `v${normalized.review.withoutQualityVerdict ? 1 : 0}`,
    `s${publicationStatusCode[normalized.expectedProjectStatus]}`,
    ownership
  ].join("");
}

/**
 * The durable identity for one compile intent.
 *
 * Revision and policy are always present. A worker fan-in also adds the page
 * fingerprint, so a final-QA repair that changes page revisions can enqueue
 * its successor without weakening exact-duplicate idempotency.
 */
export function compilePublicationDedupeKey(options: {
  projectId: string;
  planId: string;
  contentRevision: number;
  policy: CompilePublicationPolicy;
  projectStatus: string;
  contentFingerprint?: string;
}): string {
  return [
    "compile-export",
    options.projectId,
    options.planId,
    `revision-${options.contentRevision}`,
    `policy-${compilePublicationPolicyIdentity(options.policy, options.projectStatus)}`,
    ...(options.contentFingerprint ? [`pages-${options.contentFingerprint}`] : [])
  ].join(":");
}
