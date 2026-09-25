import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { coverArtSourceFor } from "./coverSource.js";
import { interiorIllustrationSlotCount } from "./illustrationSlots.js";

/** Character canon is supplied separately; unused artwork instructions are not prose context. */
export function writerArtworkContext(input: CreateProjectInput, plan: BookPlan) {
  return coverArtSourceFor(input.mediaSettings) === "ai" || interiorIllustrationSlotCount(input) > 0
    ? { illustrationPlan: plan.illustrationPlan } : {};
}
