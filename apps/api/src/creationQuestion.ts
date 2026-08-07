import { z } from "zod";

/**
 * A single-answer question is still capped at four, which is what fits above the
 * keyboard; a multi-answer question is allowed the six a real set of themes or
 * topics needs, because the reader reads them as a list rather than a fork.
 */
export const CREATION_QUESTION_OPTION_MAX = 6;

/**
 * The clarifying question a creation-chat turn may ask, and the rule that keeps
 * its shape honest. Split out of `mobileCreation.ts` because the plan-question
 * side of the app answers to the same three shapes and this is the file that
 * defines them for the chat.
 */
export const creationTurnQuestionSchema = z
  .object({
    prompt: z.string().trim().min(1).max(280),
    // The shape of the answer, declared by the model and enforced by
    // `normalizeCreationQuestion`. It defaults to "choice" so drafts stored
    // before the field existed keep parsing.
    answerKind: z
      .enum(["choice", "multi", "open"])
      .default("choice")
      .describe(
        'Use "open" when the answer is a value only this user can supply - a name, a title, a place, a number, a date: ask it in one plain sentence, leave options empty, and let them type it. Use "choice" when exactly one of two to four complete answers can be true. Use "multi" when the user can honestly pick several of the options at once and you can honour every pick.'
      ),
    options: z
      .array(z.string().trim().min(1).max(80))
      .max(CREATION_QUESTION_OPTION_MAX)
      .default([])
      .describe(
        'Tappable answers, each a complete reply the user could send as-is. Must be empty when answerKind is "open". Never an option that only describes how the user will answer ("I will type it here", "a Persian name").'
      ),
    allowCustom: z.boolean().default(true)
  })
  .strict();

export type MobileCreationTurnQuestion = z.infer<typeof creationTurnQuestionSchema>;

/**
 * A question whose answer is a value only the user knows cannot have tappable
 * answers. The interviewer used to be required to supply 2-4 of them for every
 * question, so for "what name should go on the book?" it invented options that
 * described *how* to answer ("I'll write a Persian name"); the tap taught it
 * nothing and it asked the same thing again on the next turn. An open question
 * therefore drops its options entirely, and a question left with fewer than two
 * real options is open by definition - one choice is not a choice, and neither
 * is one option to combine.
 */
export function normalizeCreationQuestion(
  question: MobileCreationTurnQuestion | null
): MobileCreationTurnQuestion | null {
  if (!question) {
    return null;
  }
  const options = question.options.map((option) => option.trim()).filter(Boolean);
  if (question.answerKind === "open" || options.length < 2) {
    return { prompt: question.prompt, answerKind: "open", options: [], allowCustom: true };
  }
  return { ...question, options };
}
