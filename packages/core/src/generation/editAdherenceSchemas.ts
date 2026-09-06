import { z } from "zod";

/**
 * The bounds every adherence-review reply is held to, and the schemas that
 * hold it there.
 *
 * Split out of `editAdherenceHierarchy.ts` when the clipping rule pushed that
 * file past its size budget — and it is the right seam anyway: these are the
 * numbers the prompts (`editAdherencePrompts.ts`) state and the budgets the
 * hierarchy sizes its output against, so all three files read them from here.
 * A bound on a *string* is enforced by cutting (`clipEvidenceText`), because
 * it is an output budget; a bound on a *list* stays a refusal, because the
 * overflow slot is the leaf's backpressure signal (→ CLAUDE.md, "Whole-set
 * edit adherence").
 */

export const MAX_LEAF_INPUTS_PER_CALL = 16;
export const MAX_REDUCER_INPUTS_PER_CALL = 2;

export const EDIT_ADHERENCE_EVIDENCE_CAPACITY = 8;
/**
 * One slot above the capacity the prompts advertise, and deliberately never
 * offered to the provider. A list clipped by its ceiling and a list that simply
 * used every slot it was given are otherwise the same length, so refusing both
 * refuses an edit that was applied correctly. Reaching this slot is the
 * observable overflow: the model needed more room than it was told it had, and
 * its evidence is incomplete however it filled `evidenceComplete` in.
 */
export const EVIDENCE_OVERFLOW_CEILING = EDIT_ADHERENCE_EVIDENCE_CAPACITY + 1;
/**
 * One evidence fact's length, and what happens past it. It was 180 and a
 * refusal: on the first live run after the prompts named their keys
 * (2026-09-06), 35 of 179 facts ran longer — the longest 293 — and every leaf
 * carrying one failed its parse, its repair, and then the whole review, so the
 * verdict came back `unverified` again over a limit the prompt never stated.
 * The bound is a token budget, not a signal, so a longer fact is now cut to
 * it (`clipEvidenceText`) and the prompt says so; the ceiling is what the
 * reply's output budget is sized against.
 */
export const MAX_EVIDENCE_ITEM_LENGTH = 240;
export const MAX_LEAF_PAGE_INDEXES = 64;
/** One operation-level verdict's bounds, whichever call produced it. */
export const MAX_VERDICT_PROSE_ITEMS = 30;
export const MAX_VERDICT_PROSE_LENGTH = 500;
export const MAX_VERDICT_REVISION_INDEXES = 100;
export const MAX_INPUT_ID_LENGTH = 160;

/**
 * How many negative facts the final call may account for. Possible omissions
 * and contradictions never pass through a reducer, so this grows with the
 * manuscript at up to `EDIT_ADHERENCE_EVIDENCE_CAPACITY` of each per leaf. It
 * was 48, sized against an echo of 69-character ids at 40 output tokens apiece;
 * at the width below, 96 negatives *and* 96 resolved omissions measure 2,340
 * tokens rather than 3,783, so an oversized final call is refused by what
 * actually fits — `assertMessagesFit` — not by a count sized for a gone cost.
 */
export const MAX_FINAL_NEGATIVE_FACTS = 96;

/**
 * **A fact id is transcribed character for character by the model that accepts
 * it, so its width is an output budget.** The id must be unique inside one
 * review and a function of the node, kind, text and lineage behind it; 64 bits
 * of the SHA-256 is both, and `assertUniqueFactIds` fails closed on the
 * collision truncation makes possible at around one in 10^16. The full digest
 * only bought price — measured against cl100k_base and o200k_base, which agree:
 * `"fact-<64 hex>",` costs 40 output tokens and `"fact-<16 hex>",` costs 13.
 */
export const FACT_ID_HEX_LENGTH = 16;

export const evidenceStringSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => clipEvidenceText(value, MAX_EVIDENCE_ITEM_LENGTH));
export const factIdSchema = z.string().regex(new RegExp(`^fact-[a-f0-9]{${FACT_ID_HEX_LENGTH}}$`));
export const finalProseSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => clipEvidenceText(value, MAX_VERDICT_PROSE_LENGTH));

/** A fact past its budget keeps its opening and says it was cut, rather than failing the review. */
export function clipEvidenceText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
export const inputIdSchema = z.string().trim().min(1).max(MAX_INPUT_ID_LENGTH);

export const leafEvidenceResponseSchema = z
  .object({
    acceptedInputIds: z.array(inputIdSchema).min(1).max(MAX_LEAF_INPUTS_PER_CALL),
    evidenceComplete: z.boolean(),
    observedChanges: evidenceStringsSchema(),
    requirementEvidence: evidenceStringsSchema(),
    possibleOmissions: evidenceStringsSchema(),
    contradictions: evidenceStringsSchema(),
    pageIndexes: z.array(z.number().int()).max(MAX_LEAF_PAGE_INDEXES)
  })
  .strict();

export const reducedEvidenceFactSchema = z
  .object({
    text: evidenceStringSchema,
    // Every accepted node holds at most the advertised capacity per category,
    // because an overflowing one never becomes a node, so a summary of both
    // reducer inputs can name at most twice that many source facts.
    sourceFactIds: z.array(factIdSchema).min(1).max(EDIT_ADHERENCE_EVIDENCE_CAPACITY * 2)
  })
  .strict();

export const reducerEvidenceResponseSchema = z
  .object({
    acceptedInputIds: z.array(inputIdSchema).min(2).max(MAX_REDUCER_INPUTS_PER_CALL),
    evidenceComplete: z.boolean(),
    observedChanges: z.array(reducedEvidenceFactSchema).max(EVIDENCE_OVERFLOW_CEILING),
    requirementEvidence: z.array(reducedEvidenceFactSchema).max(EVIDENCE_OVERFLOW_CEILING)
  })
  .strict();

export const finalResponseSchema = z
  .object({
    satisfied: z.boolean(),
    confidence: z.number().min(0).max(1),
    missingRequirements: z.array(finalProseSchema).max(MAX_VERDICT_PROSE_ITEMS),
    contradictions: z.array(finalProseSchema).max(MAX_VERDICT_PROSE_ITEMS),
    pageIndexesToRevise: z.array(z.number().int().positive()).max(MAX_VERDICT_REVISION_INDEXES),
    acceptedEvidenceId: inputIdSchema,
    coverageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    acceptedNegativeFactIds: z.array(factIdSchema).max(MAX_FINAL_NEGATIVE_FACTS),
    resolvedPossibleOmissionIds: z.array(factIdSchema).max(MAX_FINAL_NEGATIVE_FACTS)
  })
  .strict();

export function evidenceStringsSchema() {
  return z.array(evidenceStringSchema).max(EVIDENCE_OVERFLOW_CEILING);
}
