import { widenedOutputBudget } from "../adapters/outputBudget.js";
import { PartialOutputPreview } from "../adapters/partialOutputPreview.js";
import { ProseOutputRepetitionError, ProseRepetitionGuard } from "../adapters/proseRepetition.js";
import { isCancellationError } from "../adapters/retry.js";
import { assertTextAttemptAvailable, withTextAttemptBudget } from "../adapters/textAttemptBudget.js";
import { bindTextModelCall, type GenerateTextOptions, type TextModelAdapter, type TextResult } from "../adapters/types.js";
import { isOutputBudgetExhausted } from "./generateJsonWithRetry.js";

/** One fresh chapter attempt for unusable output, inside the physical request
 * allowance shared with transport retries and fallback. A length retry with a
 * usable earlier draft opts out: preserving that draft is its recovery. */
export async function generateChapterProse(
  model: TextModelAdapter,
  options: GenerateTextOptions,
  recover = true
): Promise<TextResult> {
  let next = withTextAttemptBudget(options);
  const bound = await bindTextModelCall(model, options.purpose);
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    assertTextAttemptAvailable(next);
    let guard = new ProseRepetitionGuard();
    let preview = new PartialOutputPreview();
    try {
      const result = await bound.adapter.generateText({
        ...next,
        onProviderRequest: async request => {
          // Network retries and fallback start a distinct response stream.
          guard = new ProseRepetitionGuard();
          preview = new PartialOutputPreview();
          await options.onProviderRequest?.(request);
        },
        onOutputTextChunk: async chunk => {
          options.signal?.throwIfAborted();
          preview.append(chunk);
          try { guard.append(chunk); }
          catch (error) {
            if (error instanceof ProseOutputRepetitionError) Object.assign(error, {
              context: { reason: "repeated_prose", partialOutput: preview.snapshot() }
            });
            throw error;
          }
          await options.onOutputTextChunk?.(chunk);
        }
      });
      options.signal?.throwIfAborted();
      // Some adapters return text without calling the streaming observer.
      const completed = new ProseRepetitionGuard();
      completed.append(result.text);
      completed.finish();
      return result;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isCancellationError(error) || !recover || attempt > 0) throw error;
      if (error instanceof ProseOutputRepetitionError) {
        next = { ...next, temperature: Math.min(options.temperature ?? 0.7, 0.3), messages: [
          { role: "system", content: "The previous response repeated the same passage and was discarded. Write a fresh complete chapter from the original brief. Develop each assigned section once, then stop at the chapter's ending. Do not continue or reproduce the repeated passage." },
          ...options.messages
        ] };
      } else if (isOutputBudgetExhausted(error) && next.maxTokens !== undefined && !next.textAttemptBudget!.outputWidened) {
        const maxTokens = widenedOutputBudget(error, next.maxTokens);
        if (maxTokens === undefined) throw error;
        next.textAttemptBudget!.outputWidened = true;
        next = { ...next, maxTokens };
      } else throw error;
    }
  }
}
