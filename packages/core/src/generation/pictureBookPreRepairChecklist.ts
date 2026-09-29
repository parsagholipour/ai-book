import { normalizeMediaAbsence } from "./manuscriptCoverageMedia.js";
import { requestsDialogue, dialogueWitnessConcern } from "./dialogueWitness.js";
import { z } from "zod";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { matchingRequirementInventory } from "../schemas/manuscriptRequirements.js";
import { pictureBookRequirementDependencies } from "./pictureBookRequirementDependencies.js";
import type { PictureBookPageReview } from "./pictureBookReviewValidation.js";

export const pictureBookRequirementChecksSchema = z.array(z.strictObject({
  requirementIndex: z.number().int().nonnegative(), evidence: z.string().trim().min(1).max(300).nullable()
})).max(64);

/** Reuse only grounded prose obligations with explicit per-page scope. A partial
 * inventory still supplies its known obligations; media/counts belong elsewhere. */
export function pictureBookPageRequirements(input: CreateProjectInput, plan?: BookPlan) {
  const inventory = matchingRequirementInventory(plan?.requirementInventory, input.prompt);
  const seen = new Set<string>();
  const requirements = (inventory?.requirements ?? []).map(normalizeMediaAbsence).flatMap(requirement => {
    if (!requirement.scope || requirement.scope.extent !== "each_page" ||
      !["content", "structure", "character", "prohibition"].includes(requirement.kind) || requirement.sourceQuoteIssue ||
      !requirement.quote.trim() || !input.prompt.includes(requirement.quote) || !input.prompt.includes(requirement.scope.quote) ||
      seen.has(requirement.quote)) return [];
    seen.add(requirement.quote);
    return [{ requirementIndex: seen.size - 1, quote: requirement.quote, scopeQuote: requirement.scope.quote }];
  });
  const dependencies = pictureBookRequirementDependencies(requirements);
  return requirements.map(({ scopeQuote: _, ...requirement }) => ({ ...requirement,
    ...(dependencies.has(requirement.requirementIndex) ? { failedByRequirementIndexes: dependencies.get(requirement.requirementIndex)! } : {}) }));
}

export function pictureBookChecklistErrors(options: { input: CreateProjectInput; plan?: BookPlan; enabled: boolean },
  markdown: string, checks: z.infer<typeof pictureBookRequirementChecksSchema> | undefined,
  findings: NonNullable<PictureBookPageReview["findings"]>): string[] {
  const requirements = options.enabled ? pictureBookPageRequirements(options.input, options.plan) : [];
  if (!requirements.length) return checks?.length ? ["No per-page requirement checklist was requested."] : [];
  if (!checks || checks.length !== requirements.length || new Set(checks.map(check => check.requirementIndex)).size !== requirements.length ||
    checks.some(check => !requirements.some(requirement => requirement.requirementIndex === check.requirementIndex)))
    return ["requirementChecks must assess every pageRequirements index exactly once before repair."];
  return requirements.flatMap(requirement => {
    const check = checks.find(item => item.requirementIndex === requirement.requirementIndex)!;
    const failureQuotes = [requirement.quote, ...requirements.filter(child => requirement.failedByRequirementIndexes?.includes(child.requirementIndex)).map(child => child.quote)];
    const missing = findings.some(finding => finding.domain === "prose" && finding.basis === "missing_requirement" &&
      failureQuotes.includes(finding.requirementQuote ?? ""));
    if (check.evidence === null) return missing ? [] : [`Missing requirement ${requirement.requirementIndex} needs a grounded missing_requirement finding on this page.`];
    if (!markdown.includes(check.evidence) || missing) return [`Requirement ${requirement.requirementIndex} needs exact current-page evidence and a consistent finding verdict.`];
    // A compound requirement may cite its scene evidence while a contained,
    // separately checked dialogue obligation supplies the same page's speech.
    // Do not force a redundant witness retry when that narrower proof is valid.
    if (!requestsDialogue(requirement.quote)) return [];
    const hasSpecificWitness = requirements.some(other => other !== requirement && requirement.quote.includes(other.quote) &&
      requestsDialogue(other.quote) && checks.some(item => item.requirementIndex === other.requirementIndex &&
        item.evidence !== null && markdown.includes(item.evidence) && !dialogueWitnessConcern(markdown, item.evidence)) &&
      !findings.some(finding => finding.domain === "prose" && finding.basis === "missing_requirement" && finding.requirementQuote === other.quote));
    const concern = hasSpecificWitness ? undefined : dialogueWitnessConcern(markdown, check.evidence);
    return concern ? [`Requirement ${requirement.requirementIndex}: ${concern}`] : [];
  });
}
