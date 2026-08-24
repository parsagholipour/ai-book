import {
  DETACHED_FROM_PROJECT_LIFECYCLE,
  EXPORT_PUBLICATION_PROJECT_STATUS,
  EXPORT_REPAIR_FORMAT,
  exportPublicationProjectStatusFromPayload,
  exportRepairFormatFromPayload,
  isDetachedFromProjectLifecycle,
  isMarkdownRecompileWithoutVerdict,
  isPresentationOnlyRecompile,
  MARKDOWN_RECOMPILE_WITHOUT_VERDICT,
  PRESENTATION_ONLY_RECOMPILE,
  PRESENTATION_RECOMPILE_FALLBACK_STATUS,
  presentationRecompileFallbackStatus,
  skipsFinalReview,
  type ExportPublicationProjectStatus,
  type ExportRepairFormat,
  type SettledProjectStatus
} from "./jobScope.js";

/** Every compile behavior that changes QA, verdict ownership, or publication. */
export type CompilePublicationPolicy = {
  review: { skipFinalReview: boolean; withoutQualityVerdict: boolean };
  expectedProjectStatus: ExportPublicationProjectStatus | null;
  ownership:
    | { kind: "outcome" }
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
      : `od${normalized.ownership.repairFormat === "pdf" ? "p" : normalized.ownership.repairFormat === "epub" ? "e" : "n"}`;
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
