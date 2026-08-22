import {
  bestOfCandidateCount,
  firstPageCandidateCount,
  generateBestOfPageDrafts,
  polishPageTemperature,
  type CreateProjectInput,
  type PageDraft,
  type PolishPageOptions,
  type ProviderSet
} from "@book-maker/core";
import { applyPlanThinkingBoost, loadQualityContext } from "./qualitySettings.js";

/**
 * Two independent doors into best-of polish, combined with `Math.max` so they
 * never multiply.
 *
 * The operator door is the `bestOfPolish` quality gate — compiled default
 * ultra, but whatever tiers an operator has checked — opened only as wide as
 * the project's `draftCandidates` (clamped to 1-3, so the gate on its own
 * changes nothing while that sits at its default of 1).
 *
 * The page-1 door is `firstPageCandidateCount`, decided by the model tier
 * alone with no flag to set. **Fast's first-page count is 1**, so a fast book
 * never best-ofs through this door at all — it reaches best-of only when an
 * operator has put `fast` on the gate above.
 */
export async function polishPageWithQualityGates(options: {
  polishPageDraft: (opts: PolishPageOptions) => Promise<PageDraft>;
  polishOptions: PolishPageOptions;
  providers: ProviderSet;
  input: CreateProjectInput;
}): Promise<PageDraft> {
  const quality = await loadQualityContext(options.input);
  applyPlanThinkingBoost(options.providers.text, quality.enabled("planThinkingBoost"));
  const candidateCount = Math.max(
    quality.enabled("bestOfPolish") ? bestOfCandidateCount(options.input) : 1,
    firstPageCandidateCount(options.input, options.polishOptions.pageIndex)
  );
  if (candidateCount <= 1) {
    return options.polishPageDraft(options.polishOptions);
  }
  return generateBestOfPageDrafts({
    draftPage: (opts) => options.polishPageDraft({ ...options.polishOptions, input: opts.input }),
    // Best-of's ladder descends from the temperature it is handed, so hand it
    // the temperature a candidate-free polish runs at — `polishPageTemperature`
    // is the clamp `polishPageDraft` applies to itself. The book's raw 0.8 is
    // above the ceiling, and passing it would clamp the top rungs together.
    baseOptions: {
      ...options.polishOptions,
      input: {
        ...options.polishOptions.input,
        temperature: polishPageTemperature(options.polishOptions.input)
      }
    },
    candidateCount,
    judgeModel: options.providers.text
  });
}
