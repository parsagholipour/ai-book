import { chapteredBookGenerationStrategy } from "./chaptered.js";
import {
  batchWindowStrategy,
  chapterWholePassStrategy,
  draftThenPolishStrategy,
  pageMapSequentialStrategy,
  researchGroundedStrategy,
  researchMapDraftPolishStrategy
} from "./advanced.js";
import { DEFAULT_BOOK_GENERATION_STRATEGY_ID } from "./ids.js";
import type { BookGenerationStrategy } from "./types.js";
import { wholeBookSinglePassStrategy } from "./wholeBook.js";

export type { BookGenerationStrategy } from "./types.js";
export {
  batchWindowStrategy,
  chapterWholePassStrategy,
  draftThenPolishStrategy,
  pageMapSequentialStrategy,
  researchGroundedStrategy,
  researchMapDraftPolishStrategy
} from "./advanced.js";
export { chapteredBookGenerationStrategy } from "./chaptered.js";
export { wholeBookSinglePassStrategy } from "./wholeBook.js";
export * from "./ids.js";
export * from "./router.js";

export const bookGenerationStrategies = [
  chapteredBookGenerationStrategy,
  wholeBookSinglePassStrategy,
  pageMapSequentialStrategy,
  chapterWholePassStrategy,
  batchWindowStrategy,
  draftThenPolishStrategy,
  researchGroundedStrategy,
  researchMapDraftPolishStrategy
] as const satisfies readonly BookGenerationStrategy[];

export function getBookGenerationStrategy(id: string = DEFAULT_BOOK_GENERATION_STRATEGY_ID): BookGenerationStrategy {
  const strategy = bookGenerationStrategies.find((candidate) => candidate.id === id);
  if (!strategy) {
    throw new Error(`Unknown book generation strategy: ${id}`);
  }
  return strategy;
}
