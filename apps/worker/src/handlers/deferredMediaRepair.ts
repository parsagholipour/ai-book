import { pageQualityReportSchema, type BookGenerationStrategy, type BookPlan, type CreateProjectInput } from "@book-maker/core";

export type DeferredMediaRepairContext = {
  input: CreateProjectInput; plan: BookPlan; strategy: Pick<BookGenerationStrategy, "shouldIllustratePage">;
};
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const emptyArray = (value: unknown) => Array.isArray(value) && value.length === 0;

/** A prose rewriter cannot create an illustration asset. Legacy failures remain repairable. */
export function onlyDeferredMediaRemains(page: { index: number; markdown?: string; qualityReport?: unknown }, context?: DeferredMediaRepairContext): boolean {
  if (!context || !page.markdown?.trim()) return false;
  const raw = record(page.qualityReport);
  // Require explicit evidence, rather than schema defaults filling a partial
  // report into a pass. Later local/style/grounding failures invalidate this proof.
  if (raw.approved !== true || raw.groundedOk !== true || !["verified", "not_applicable"].includes(String(raw.groundingStatus)) ||
    (raw.groundingAvailability !== undefined && !["verified", "not_applicable"].includes(String(raw.groundingAvailability))) ||
    !emptyArray(raw.issues) || !emptyArray(raw.requiredRevisions) || !emptyArray(raw.unsupportedClaims) ||
    (raw.qualityAdvisories !== undefined && !emptyArray(raw.qualityAdvisories))) return false;
  const checks = record(raw.checks);
  if (!["placeholderFree", "promptLeakFree", "titleClean", "repetitionOk", "progressionOk", "styleNatural"].every((key) => checks[key] === true)) return false;
  const parsed = pageQualityReportSchema.safeParse(page.qualityReport);
  if (!parsed.success || !["verified", "not_applicable"].includes(parsed.data.groundingStatus ?? "")) return false;
  const deferred = parsed.data.deferredMedia;
  if (!deferred || deferred.stage !== "before_illustrations" || deferred.pageIndex !== page.index ||
    deferred.draftMarkdown !== page.markdown || deferred.brief !== context.input.prompt || !deferred.requirements.length ||
    !context.strategy.shouldIllustratePage(context.input, context.plan, page.index)) return false;
  return deferred.requirements.every((requirement) => requirement.kind === "interior_illustration" && requirement.pageIndex === page.index &&
    requirement.requirementQuote.trim().length > 0 && context.input.prompt.includes(requirement.requirementQuote) &&
    requirement.quote.trim().length >= 12 && page.markdown!.includes(requirement.quote));
}
