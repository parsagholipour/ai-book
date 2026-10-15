import {
  bookMatterProseReviewCandidates,
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatContext
} from "../bookMatterChatEdit.js";
import { acceptBookMatterGroundingReview } from "../bookMatterProseGrounding.js";

/** Model an explicit positive reviewer verdict in tests of downstream normalization. */
export function normalizeReviewedMatterAnswer(answer: BookMatterChatAnswer, context: BookMatterChatContext) {
  const candidates = bookMatterProseReviewCandidates(answer, context);
  const proseReview = acceptBookMatterGroundingReview({
    verdicts: candidates.map((_, id) => ({ id, supported: true }))
  }, candidates, context);
  return normalizeBookMatterChatAnswer(answer, { ...context, proseReview });
}
