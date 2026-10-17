import {
  characterReferenceCastFromDraft,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type DraftPictureSource
} from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { characterReferenceNameKey } from "./characterReferenceFileNames.js";

/**
 * Who a plan version draws reference sheets for, when its own draft decided it.
 *
 * The fourth piece cut out of `characterReferences.ts`, beside the naming rules,
 * the file lifetimes and the settlement: the cast is the one input every caller
 * of the sheet pass has to agree on, or a set settled by one of them reads as
 * incomplete to the next and the cast is drawn again. Today's rule
 * (`characterReferenceCast`) is a function of the plan and the input, so every
 * caller computed it alike. The short-book rule
 * (`characterReferenceCastFromDraft`) is a function of the draft's image
 * prompts too, which no page job, cover job or chat picture has in hand — so the
 * pass that drafted the book decides it once and writes it on
 * `PlanVersion.characterReferenceCast`, and every caller reads the answer back
 * in the same query that reads the refusals.
 *
 * Written before the first sheet is drawn, with a compare-and-set where the
 * column is still NULL: a resumed run, or a second delivery racing the first,
 * finds the answer already there and uses it rather than deciding again. Once
 * written it never changes for the life of the plan version, which is what lets
 * a fast read taken outside the lock and the read under it agree. A replan, a
 * continuation and a revision are new rows, NULL, and draw the whole cast as
 * before.
 */

export type CharacterReferenceCastDecisionOptions = {
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: Pick<BookGenerationStrategy, "shouldIllustratePage">;
  /** The whole-book draft's pages — every page, not only the ones still to save. */
  pages: readonly DraftPictureSource[];
};

/**
 * Store the draft's decision unless the row already holds one.
 *
 * The slot predicate is the strategy's own, the one `enqueueDraftPageIllustrations`
 * asks, so a page counts as a picture exactly when it is queued as one. A book
 * with nothing to decide — its pages are not illustrated — writes nothing and
 * keeps today's rule. `updateMany` because the plan version may already be gone
 * (an undo removes the one it approved), which the render pass settles on its
 * own; a decision nobody will read is not worth failing the book for.
 */
export async function recordCharacterReferenceCastDecision(options: CharacterReferenceCastDecisionOptions): Promise<void> {
  const cast = characterReferenceCastFromDraft(options.input, options.plan, options.pages, options.strategy.shouldIllustratePage);
  if (!cast) {
    return;
  }
  await prisma.planVersion.updateMany({
    where: { id: options.planId, characterReferenceCast: { equals: Prisma.DbNull } },
    data: { characterReferenceCast: cast.map((character) => character.name) }
  });
}

/**
 * The stored decision's names, or `undefined` for no decision.
 *
 * NULL is no decision, and so is anything that is not an array: a document this
 * module did not write is read in the direction that costs sheets rather than
 * the one that loses them. `[]` is a decision, and it is kept distinct.
 */
export function parseCharacterReferenceCastDecision(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : []));
}

/**
 * The cast a caller draws: today's, narrowed to the characters a stored
 * decision names. Plan order is kept, a stored name no plan character matches
 * is dropped, and the decision can only narrow — never add a character today's
 * rule would not draw. Names compare through `characterReferenceNameKey`, the
 * key the settlement check compares a sheet's character by.
 */
export function castForCharacterReferenceDecision<Character extends { name: string }>(
  cast: readonly Character[],
  decision: readonly string[] | undefined
): Character[] {
  if (!decision) {
    return [...cast];
  }
  const decided = new Set(decision.map(characterReferenceNameKey));
  return cast.filter((character) => decided.has(characterReferenceNameKey(character.name)));
}
