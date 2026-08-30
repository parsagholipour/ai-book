import { z } from "zod";

import type { ChatMessage, TextModelAdapter } from "../adapters/types.js";
import { isCancellationError } from "../adapters/retry.js";
import {
  applyExactReplacement,
  exactReplacementInstructionMatches,
  type ExactReplacement
} from "./exactReplacement.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";
import {
  adherenceMessagesFit,
  MAX_VERDICT_PROSE_ITEMS,
  MAX_VERDICT_PROSE_LENGTH,
  MAX_VERDICT_REVISION_INDEXES,
  reviewHierarchically,
  WHOLE_SET_REVIEW_MAX_TOKENS
} from "./editAdherenceHierarchy.js";

export type EditAdherencePage = {
  index: number;
  title: string;
  markdown: string;
  summary: string;
};

/**
 * **Whether anything actually established this verdict.** `unsatisfied` and
 * `unverified` are opposite instructions to a caller and used to arrive as the
 * same object: a reviewer that read the pages and refused them names the pages
 * and what is wrong with them, while a review that never completed — one
 * transient 500, a truncated body, a coverage assertion — knows nothing about
 * either and only fails closed. Two callers were recovering the difference by
 * matching the shape of `failClosedVerdict`, which works only because that one
 * verdict skips `normalizeVerdict` and because their candidate set happens to
 * equal `changedIndexes`; one of them answers the throw by *deleting* the pages
 * it just drafted. So the module states it. A computed exact replacement is
 * `reviewed`: it is the most certain verification here, not the absence of one.
 */
export type EditAdherenceBasis = "reviewed" | "unverified";

export type EditAdherenceVerdict = {
  satisfied: boolean;
  confidence: number;
  missingRequirements: string[];
  contradictions: string[];
  pageIndexesToRevise: number[];
  basis: EditAdherenceBasis;
};

/** What a reviewer found, before this module says what basis it was found on. */
export type EditAdherenceFindings = Omit<EditAdherenceVerdict, "basis">;

export type ReviewAppliedBookEditOptions = {
  instruction: string;
  beforePages: EditAdherencePage[];
  afterPages: EditAdherencePage[];
  textModel: TextModelAdapter;
  /** A literal edit is computable and must never spend a provider call. */
  exactReplacement?: ExactReplacement | undefined;
};

const verdictProseSchema = z.string().trim().min(1).max(MAX_VERDICT_PROSE_LENGTH);

export const editAdherenceVerdictSchema = z
  .object({
    satisfied: z.boolean(),
    confidence: z.number().min(0).max(1),
    missingRequirements: z.array(verdictProseSchema).max(MAX_VERDICT_PROSE_ITEMS),
    contradictions: z.array(verdictProseSchema).max(MAX_VERDICT_PROSE_ITEMS),
    pageIndexesToRevise: z.array(z.number().int().positive()).max(MAX_VERDICT_REVISION_INDEXES)
  })
  .strict();

const WHOLE_SET_SYSTEM_MESSAGE = [
  "You are an instruction-adherence checker for an already approved book edit.",
  "Judge only whether the after pages fully perform the approved instruction when compared with the before pages.",
  "Do not judge morality, safety, taste, advisability, writing style, or whether you would have chosen this edit.",
  "Review the changed page set jointly, because one requirement may be distributed across several pages.",
  "A material omission, contradiction, substitution, or silent softening means satisfied is false.",
  "missingRequirements, contradictions and pageIndexesToRevise are the repair order a satisfied=false verdict carries: name the concrete unmet requirements, the contradictions, and the after pages that can repair them. Leave all three empty when satisfied is true — nothing else is read from a satisfied verdict, and this review has no field for optional improvements.",
  "Return only the required JSON object."
].join(" ");

/**
 * Reviews only whether the approved edit instruction was applied. It is not a
 * second content-policy or editorial-opinion gate: ordinary page QA owns prose
 * quality, while this reviewer protects the reader's explicit request.
 */
export async function reviewAppliedBookEdit(
  options: ReviewAppliedBookEditOptions
): Promise<EditAdherenceVerdict> {
  if (
    options.exactReplacement &&
    exactReplacementInstructionMatches(options.instruction, options.exactReplacement)
  ) {
    return normalizeVerdict(
      reviewExactReplacement(options.beforePages, options.afterPages, options.exactReplacement),
      options.afterPages.map((page) => page.index)
    );
  }

  const changedIndexes = options.afterPages.map((page) => page.index);
  try {
    const wholeSetMessages = wholeSetReviewMessages(options);
    const verdict = adherenceMessagesFit(wholeSetMessages)
      ? await reviewWholeSet(options, wholeSetMessages)
      : await reviewHierarchically(options);
    return normalizeVerdict(verdict, changedIndexes);
  } catch (error) {
    if (isCancellationError(error)) {
      throw error;
    }
    return failClosedVerdict(changedIndexes);
  }
}

function wholeSetReviewMessages(options: ReviewAppliedBookEditOptions): ChatMessage[] {
  return [
    { role: "system", content: WHOLE_SET_SYSTEM_MESSAGE },
    {
      role: "user",
      content: JSON.stringify({
        reviewPhase: "global-whole-set",
        approvedInstruction: options.instruction,
        beforePages: options.beforePages,
        afterPages: options.afterPages
      })
    }
  ];
}

async function reviewWholeSet(
  options: ReviewAppliedBookEditOptions,
  messages: ChatMessage[]
): Promise<EditAdherenceFindings> {
  const result = await generateJsonWithRetry(options.textModel, {
    purpose: "review-edit-adherence",
    temperature: 0,
    // Computed from what this call's own schema forces, exactly as every
    // hierarchical call's is: a flat 1,200 fits neither a verbose verdict nor a
    // non-Latin one, and here truncation is the whole review rather than one
    // leaf of it. One bounded JSON repair re-asks about the same candidate
    // before a malformed or truncated response becomes an unverified verdict;
    // leaving this at zero made callers revise otherwise-correct pages merely
    // because the first response ended mid-object.
    maxTokens: WHOLE_SET_REVIEW_MAX_TOKENS,
    repairAttempts: 1,
    schema: editAdherenceVerdictSchema,
    messages
  });
  return editAdherenceVerdictSchema.parse(result.data);
}

function failClosedVerdict(changedIndexes: number[]): EditAdherenceVerdict {
  return {
    basis: "unverified",
    satisfied: false,
    confidence: 0,
    missingRequirements: ["The complete edit could not be verified against the approved instruction."],
    contradictions: [],
    pageIndexesToRevise: uniqueIndexes(changedIndexes.filter((index) => Number.isInteger(index) && index > 0))
  };
}

function reviewExactReplacement(
  beforePages: EditAdherencePage[],
  afterPages: EditAdherencePage[],
  replacement: ExactReplacement
): EditAdherenceFindings {
  const beforeByIndex = new Map(beforePages.map((page) => [page.index, page]));
  const invalid = afterPages.flatMap((after) => {
    const before = beforeByIndex.get(after.index);
    if (!before) {
      return [after.index];
    }
    const expectedMarkdown = applyExactReplacement(before.markdown, replacement);
    const expectedTitle = applyExactReplacement(before.title, replacement);
    const expectedSummary = applyExactReplacement(before.summary, replacement);
    return after.markdown === expectedMarkdown && after.title === expectedTitle && after.summary === expectedSummary
      ? []
      : [after.index];
  });
  const satisfied = invalid.length === 0 && afterPages.length === beforePages.length;
  return {
    satisfied,
    confidence: 1,
    missingRequirements: satisfied ? [] : [`Replace every exact occurrence of “${replacement.from}”.`],
    contradictions: [],
    pageIndexesToRevise: satisfied ? [] : uniqueIndexes(invalid.length > 0 ? invalid : afterPages.map((page) => page.index))
  };
}

/**
 * **`satisfied` is the verdict; the other three fields are the repair order it
 * carries when the answer is no.** They used to be ANDed into the answer, so a
 * reviewer that said yes and then volunteered one remark — a very ordinary
 * shape for a schema that offers a string array and no other place to put a
 * thought — was silently read as saying no. Nothing distinguishes "the callback
 * on page 7 could be stronger" from "page 7 never reveals the key" in a
 * `string[]`, and that is the reason the list may not be read as a verdict: it
 * is one model's remark vetoing the same model's answer, in the same response,
 * with no independent signal in it. The reader pays for that guess twice —
 * every flagged page is redrafted up to `attempts < 3`, and a reviewer that
 * volunteers one remark a round ends at `EDIT_ADHERENCE_FAILED`, which discards
 * a correctly applied edit and refunds it. The prompt now says outright that a
 * satisfied verdict carries no repair order, so an empty one is what it asks
 * for and clearing a stray one costs nothing. `pagesReview.ts` settles the same
 * conflict the same way and further — it *promotes* a rejection whose issues
 * all read as non-blocking, and clears the lists when it does. What may still
 * outrank the boolean is evidence **code** owns, never prose the same call
 * volunteered: `decideGlobalVerdict` keeps its unresolved omissions and its
 * immutable contradictions, and they arrive here already folded in.
 */
function normalizeVerdict(verdict: EditAdherenceFindings, changedIndexes: number[]): EditAdherenceVerdict {
  if (verdict.satisfied) {
    return { ...verdict, basis: "reviewed", missingRequirements: [], contradictions: [], pageIndexesToRevise: [] };
  }
  const validChangedIndexes = uniqueIndexes(changedIndexes.filter((index) => Number.isInteger(index) && index > 0));
  const allowed = new Set(validChangedIndexes);
  const indexes = uniqueIndexes(verdict.pageIndexesToRevise.filter((index) => allowed.has(index)));
  return {
    ...verdict,
    basis: "reviewed",
    missingRequirements: uniqueStrings(verdict.missingRequirements),
    contradictions: uniqueStrings(verdict.contradictions),
    pageIndexesToRevise: indexes.length > 0 ? indexes : validChangedIndexes
  };
}

function uniqueIndexes(indexes: number[]): number[] {
  return [...new Set(indexes)].sort((left, right) => left - right);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
