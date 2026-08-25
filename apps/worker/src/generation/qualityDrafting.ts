import {
  generateBestOfPageDrafts,
  pageCandidateCount,
  polishPageTemperature,
  type CreateProjectInput,
  type PageDraft,
  type PolishPageOptions,
  type ProviderSet
} from "@book-maker/core";
import { applyPlanThinkingBoost, loadQualityContext } from "./qualitySettings.js";

export async function polishPageWithQualityGates(options: {
  polishPageDraft: (opts: PolishPageOptions) => Promise<PageDraft>;
  polishOptions: PolishPageOptions;
  providers: ProviderSet;
  input: CreateProjectInput;
}): Promise<PageDraft> {
  const quality = await loadQualityContext(options.input);
  applyPlanThinkingBoost(options.providers.text, quality.enabled("planThinkingBoost"));
  const candidateCount = pageCandidateCount(
    options.input,
    options.polishOptions.pageIndex,
    quality.enabled("bestOfPolish")
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
