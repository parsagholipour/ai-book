import { updateJobProgress } from "../runtime/jobLifecycle.js";
import { MAX_PAGE_REVISE_RESTARTS } from "./tuning.js";
import type { BookGenerationStrategy, PageDraft, RevisePageOptions } from "@book-maker/core";

/** Run a page revision again when a provider fails before returning a draft. */
export async function revisePageDraftWithRestart(options: {
  strategy: BookGenerationStrategy;
  reviseOptions: RevisePageOptions;
  context: string;
  generationJobId?: string | undefined;
  progress?: number | undefined;
  maxRestarts?: number | undefined;
}): Promise<PageDraft> {
  const maxRestarts = options.maxRestarts ?? MAX_PAGE_REVISE_RESTARTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRestarts + 1; attempt += 1) {
    try {
      return await options.strategy.revisePageDraft(options.reviseOptions);
    } catch (error) {
      lastError = error;
      if (attempt > maxRestarts) {
        throw error;
      }

      await updateJobProgress(options.generationJobId, {
        ...(options.progress !== undefined ? { progress: options.progress } : {}),
        message: `${options.context} revise failed; restarting with the generated page and revision (${attempt + 1}/${
          maxRestarts + 1
        }).`
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${options.context} revise failed.`);
}
