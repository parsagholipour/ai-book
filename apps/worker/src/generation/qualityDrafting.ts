import {
  bestOfCandidateCount,
  generateBestOfPageDrafts,
  type CreateProjectInput,
  type PageDraft,
  type PolishPageOptions,
  type ProviderSet
} from "@book-maker/core";
import { applyPlanThinkingBoost, loadQualityContext } from "./qualitySettings.js";

/**
 * Ultra best-of polish: sample two polish drafts when the live gate is on and
 * the project's draftCandidates is > 1. Fast/Balanced/Premium never enter —
 * their presets keep draftCandidates at 1, and even an admin override of 2 is
 * still gated here.
 */
export async function polishPageWithQualityGates(options: {
  polishPageDraft: (opts: PolishPageOptions) => Promise<PageDraft>;
  polishOptions: PolishPageOptions;
  providers: ProviderSet;
  input: CreateProjectInput;
}): Promise<PageDraft> {
  const quality = await loadQualityContext(options.input);
  applyPlanThinkingBoost(options.providers.text, quality.enabled("planThinkingBoost"));
  const candidateCount = quality.enabled("bestOfPolish") ? bestOfCandidateCount(options.input) : 1;
  if (candidateCount <= 1) {
    return options.polishPageDraft(options.polishOptions);
  }
  return generateBestOfPageDrafts({
    draftPage: (opts) => options.polishPageDraft({ ...options.polishOptions, input: opts.input }),
    baseOptions: options.polishOptions,
    candidateCount,
    judgeModel: options.providers.text
  });
}
