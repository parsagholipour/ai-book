import {
  PAGE_QA_TRIGGER_REASONS,
  type PageQaTriggerReason,
  type PageQaProviderCallMetadata
} from "../adapters/types.js";
import { hasSmartUnslopCandidates } from "./smartUnslop.js";

const QA_TRIGGER_PROVENANCE = Symbol("page-qa-trigger-provenance");

type TriggerStamped = {
  [QA_TRIGGER_PROVENANCE]?: readonly PageQaTriggerReason[] | undefined;
};

type RewriteReport = TriggerStamped & {
  groundedOk?: boolean | undefined;
  unsupportedClaims?: readonly string[] | undefined;
  issues?: readonly string[] | undefined;
  requiredRevisions?: readonly string[] | undefined;
  notes?: string | undefined;
  checks?: { styleNatural?: boolean | undefined } | undefined;
  stylePenalty?: number | undefined;
};

/**
 * Carries machine provenance beside a report without putting it in JSON,
 * persisted quality reports, or model prompts. Enumerable symbols survive the
 * report spreads used by the enrichment gates; JSON serialization ignores it.
 */
export function withPageQaTriggerReasons<T extends object>(
  report: T,
  reasons: readonly PageQaTriggerReason[]
): T {
  const existing = (report as TriggerStamped)[QA_TRIGGER_PROVENANCE] ?? [];
  return {
    ...report,
    [QA_TRIGGER_PROVENANCE]: orderedReasons([...existing, ...reasons])
  };
}

/** Resolve the bounded trigger set for one rejected page candidate. */
export function pageQaTriggerReasonsForReport(report: RewriteReport): PageQaTriggerReason[] {
  const reasons = new Set<PageQaTriggerReason>(report[QA_TRIGGER_PROVENANCE] ?? []);
  const feedback = [...(report.issues ?? []), ...(report.requiredRevisions ?? []), report.notes ?? ""].join(" ");

  if (report.groundedOk === false || (report.unsupportedClaims?.length ?? 0) > 0) {
    reasons.add("claim_grounding");
  }
  if (typeof report.stylePenalty === "number" && report.stylePenalty > 0) {
    reasons.add("style");
  }
  if (hasSmartUnslopCandidates(report)) {
    reasons.add("smart_unslop");
  }
  if (/\bLocal quality checks rejected the page\b/i.test(report.notes ?? "")) {
    reasons.add("local_check");
  }
  if (/\b(?:reserved (?:closing )?beat|restages? (?:a |the )?reserved|reserve the closing synthesis)\b/i.test(feedback)) {
    reasons.add("reserved_beat");
  }
  if (/\bUnpaid promise on the final page\b/i.test(feedback)) {
    reasons.add("story_contradiction");
  }
  if (reasons.size === 0) {
    reasons.add("model_review");
  }
  return orderedReasons(reasons);
}

export function pageQaProviderCallMetadata(options: {
  report: RewriteReport;
  candidateNumber?: number | undefined;
  additionalReasons?: readonly PageQaTriggerReason[] | undefined;
}): PageQaProviderCallMetadata {
  const qaCandidateNumber = Math.max(2, Math.floor(options.candidateNumber ?? 2));
  return {
    qaTriggerReasons: orderedReasons([
      ...pageQaTriggerReasonsForReport(options.report),
      ...(options.additionalReasons ?? [])
    ]),
    qaCandidateNumber,
    qaRewriteNumber: qaCandidateNumber - 1
  };
}

function orderedReasons(reasons: Iterable<PageQaTriggerReason>): PageQaTriggerReason[] {
  const selected = new Set(reasons);
  return PAGE_QA_TRIGGER_REASONS.filter((reason) => selected.has(reason));
}
