import { z } from "zod";

const pageCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const pageCountConstraintSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact"), count: pageCount }),
  z.strictObject({ kind: z.literal("minimum"), count: pageCount }),
  z.strictObject({ kind: z.literal("maximum"), count: pageCount }),
  z.strictObject({ kind: z.literal("range"), minimum: pageCount, maximum: pageCount })
]);
export type PageCountConstraint = z.infer<typeof pageCountConstraintSchema>;

/** A label never supplies a quantifier. Scope is grounded separately in the brief. */
export const requirementScopeSchema = z.object({
  extent: z.enum(["whole_book", "each_page", "each_chapter", "specified", "unresolved"]),
  quote: z.string().min(1)
});
export type RequirementScope = z.infer<typeof requirementScopeSchema>;
export const briefRequirementSchema = z.object({
  text: z.string().min(1), quote: z.string(),
  kind: z.enum(["content", "table", "structure", "title", "page_count", "illustration", "media_absence", "character", "visual", "prohibition"]),
  scope: requirementScopeSchema.optional(),
  prohibitionScope: z.literal("named_main_characters").optional(),
  expectedTitle: z.string().optional(), expectedCount: z.number().int().nonnegative().optional(),
  pageCountConstraint: pageCountConstraintSchema.optional(),
  illustrationScope: z.enum(["all_story_pages", "configured_pages"]).optional(),
  mediaScope: z.enum(["story_pages", "cover", "all", "character_references"]).optional(),
  sourceQuoteIssue: z.enum(["empty", "not_in_brief"]).optional(), originalQuote: z.string().optional()
});
export const manuscriptRequirementInventorySchema = z.object({
  version: z.literal(1).optional(),
  complete: z.boolean(), requirements: z.array(briefRequirementSchema).max(64),
  status: z.enum(["available", "unavailable"]), brief: z.string(), unavailableReason: z.string().optional()
});
export type ManuscriptRequirementInventory = z.infer<typeof manuscriptRequirementInventorySchema>;

/** Reuse failed/partial attempts too: a retry must not silently redefine the contract. */
export function matchingRequirementInventory(inventory: ManuscriptRequirementInventory | undefined, brief: string) {
  return inventory?.version === 1 && inventory.brief === brief ? inventory : undefined;
}
