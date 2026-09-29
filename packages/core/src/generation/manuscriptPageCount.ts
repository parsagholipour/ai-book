import { pageCountConstraintSchema, type PageCountConstraint } from "../schemas/manuscriptRequirements.js";
import type { CoverageEvidenceContext } from "./manuscriptCoverage.js";

type Requirement = { quote: string; expectedCount?: number | undefined; pageCountConstraint?: PageCountConstraint | undefined;
  scope?: { quote: string; extent: string } | undefined };
type Verdict = { status: "fulfilled" | "missing" | "unverified"; reason: string };
const unknown = (): Verdict => ({ status: "unverified", reason: "The story-page quantity or its minimum/maximum/exact meaning was not grounded in the source requirement." });

/** Conservative migration of old scalar inventories. Match the complete count
 * clause, never a label, a nearby number, or an arbitrary substring of prose. */
function quotedConstraint(source: string): PageCountConstraint | undefined {
  const text = source.trim().replace(/[.!]$/u, "").replace(/^(?:plan|write|use|deliver|provide|create|produce|preserve|include)\s+/iu, "");
  const range = /^([1-9]\d*)\s*(?:[-–—]|to)\s*([1-9]\d*) (?:story )?pages(?:,? never fewer than ([1-9]\d*))?$/iu.exec(text)
    ?? /^between ([1-9]\d*) and ([1-9]\d*) (?:story )?pages$/iu.exec(text);
  if (range && (!range[3] || Number(range[3]) === Number(range[1])))
    return { kind: "range", minimum: Number(range[1]), maximum: Number(range[2]) };
  const bound = /^(exactly|at least|no fewer than|never fewer than|a minimum of|at most|no more than|up to|a maximum of) ([1-9]\d*)(?: (?:complete )?(?:text-only )?(?:story )?pages?)?$/iu.exec(text);
  if (bound) return { kind: bound[1]!.toLowerCase() === "exactly" ? "exact"
    : /least|fewer|minimum/iu.test(bound[1]!) ? "minimum" : "maximum", count: Number(bound[2]) };
  if (/^one (?:story )?page$/iu.test(text)) return { kind: "exact", count: 1 };
  const exact = /^([1-9]\d*) (?:complete )?(?:text-only )?(?:story )?pages?$/iu.exec(text);
  return exact ? { kind: "exact", count: Number(exact[1]) } : undefined;
}

function bounds(constraint: PageCountConstraint) {
  return constraint.kind === "range" ? [constraint.minimum, constraint.maximum] as const
    : [constraint.kind === "maximum" ? 1 : constraint.count, constraint.kind === "minimum" ? Infinity : constraint.count] as const;
}
function sameMeaning(claim: PageCountConstraint, source: PageCountConstraint): boolean {
  // A range can be inventoried as separate lower and upper obligations.
  if (source.kind === "range" && claim.kind === "minimum") return claim.count === source.minimum;
  if (source.kind === "range" && claim.kind === "maximum") return claim.count === source.maximum;
  const [low, high] = bounds(claim), [sourceLow, sourceHigh] = bounds(source);
  return low === sourceLow && high === sourceHigh;
}

function sourceConstraint(requirement: Requirement) {
  // The enclosing source scope retains governing qualifiers omitted from a
  // short quote, e.g. quote="33 story pages", scope="at most 33 story pages".
  const scope = requirement.scope?.quote;
  return (scope?.includes(requirement.quote) ? quotedConstraint(scope) : undefined) ?? quotedConstraint(requirement.quote);
}

/** Add bounds to recognized old range/min/max rows. Leave old exact original-
 * target rows scalar: their established configured allowance remains compatible. */
export function normalizePageCountRequirement<T extends { kind: string } & Requirement>(requirement: T): T {
  if (requirement.kind !== "page_count" || requirement.pageCountConstraint) return requirement;
  const constraint = sourceConstraint(requirement);
  if (!constraint || constraint.kind === "exact") return requirement;
  const numbers = constraint.kind === "range" ? [constraint.minimum, constraint.maximum] : [constraint.count];
  return requirement.expectedCount !== undefined && !numbers.includes(requirement.expectedCount) ? requirement
    : { ...requirement, pageCountConstraint: constraint };
}

export function pageCountRequirementVerdict(requirement: Requirement, context?: CoverageEvidenceContext): Verdict {
  if (!context) return { status: "unverified", reason: "Actual story-page facts were not supplied." };
  if (requirement.scope && requirement.scope.extent !== "whole_book") return unknown();
  const parsed = sourceConstraint(requirement);
  const expected = requirement.expectedCount;
  const configured = context.storyPageCountBounds;
  const legacyTarget = !requirement.pageCountConstraint && expected !== undefined && parsed?.kind === "exact" && parsed.count === expected &&
    (expected === context.requestedStoryPages || expected === context.targetStoryPages);
  let constraint = requirement.pageCountConstraint ?? parsed;
  if (legacyTarget) constraint = configured
    ? { kind: "range", minimum: configured.minimumPages, maximum: configured.maximumPages }
    : { kind: "exact", count: expected };
  const valid = pageCountConstraintSchema.safeParse(constraint);
  if (!valid.success) return unknown();
  constraint = valid.data;
  const [minimum, maximum] = bounds(constraint);
  if (minimum > maximum) return unknown();
  if (!legacyTarget) {
    if (parsed && !sameMeaning(constraint, parsed)) return unknown();
    const source = requirement.scope?.quote.includes(requirement.quote) ? requirement.scope.quote : requirement.quote;
    const counts = constraint.kind === "range" ? [constraint.minimum, constraint.maximum] : [constraint.count];
    if ((!parsed && counts.some(count => !new RegExp(`(?<![\\p{L}\\p{N}])${count}(?![\\p{L}\\p{N}])`, "u").test(source))) ||
      (requirement.expectedCount !== undefined && !counts.includes(requirement.expectedCount))) return unknown();
  }
  // Enforce the customer floor and selected map separately from the source bound.
  // A 33-page maximum cannot approve 32 pages from a selected 33-page manuscript.
  if (configured && (!Number.isSafeInteger(configured.minimumPages) || !Number.isSafeInteger(configured.maximumPages) ||
    configured.minimumPages < 1 || configured.maximumPages < configured.minimumPages)) return unknown();
  const indexes = [...context.storyPageIndexes].sort((a, b) => a - b);
  const low = Math.max(minimum, context.requestedStoryPages ?? 1, configured?.minimumPages ?? 1);
  const high = Math.min(maximum, configured?.maximumPages ?? Infinity);
  const fulfilled = indexes.length >= low && indexes.length <= high && indexes.every((index, offset) => index === offset + 1);
  const description = constraint.kind === "range" ? `${constraint.minimum}–${constraint.maximum}`
    : `${constraint.kind === "minimum" ? "at least" : constraint.kind === "maximum" ? "at most" : "exactly"} ${constraint.count}`;
  return { status: fulfilled ? "fulfilled" : "missing", reason: `The manuscript has ${indexes.length} story-page records; the requirement permits ${description}.` +
    (configured ? ` The configured delivery requires ${configured.minimumPages === configured.maximumPages ? configured.minimumPages : `${configured.minimumPages}–${configured.maximumPages}`} uniquely numbered pages from 1.` : " Page indexes must be unique and consecutive from 1.") +
    " Front matter is excluded." };
}

export const PAGE_COUNT_CONSTRAINT_GUIDANCE = "For page_count include pageCountConstraint:{kind:exact|minimum|maximum,count} or {kind:range,minimum,maximum}, preserving the operator and every bound from the exact source quote/scope. Keep a range as one requirement, not two exact counts. expectedCount is for illustration counts and legacy page rows; omit it on new page_count rows. Never turn a maximum into an exact count or infer the operator from the label. Unknown or conditional quantities must remain unresolved rather than inventing a bound.";
