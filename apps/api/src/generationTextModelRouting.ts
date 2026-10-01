import {
  compiledGenerationTextModelRouting,
  createLiveGenerationTextModel,
  generationTextModelOptions,
  resolveGenerationTextModelRouting,
  type AppConfig,
  type GenerationTextModelRouting,
  type ModelTier,
  type TextModelAdapter
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * The live routing revision (the operator's Quality tab), read at each logical
 * call so an inline API call and a worker call made at the same moment answer
 * to the same models. Exported for the inline decision route
 * (`userTextModeration.ts`), whose fast-decision model is the same Quality-tab
 * choice the worker's screens read.
 */
export function liveRoutingLoader(config: AppConfig): () => Promise<GenerationTextModelRouting> {
  const compiled = compiledGenerationTextModelRouting(config, generationTextModelOptions(config));
  return async () => {
    try {
      const row = await prisma.generationQualityRevision.findFirst({
        orderBy: { version: "desc" },
        select: { settings: true }
      });
      return resolveGenerationTextModelRouting(row?.settings, compiled);
    } catch (error) {
      // This helper is used below route composition, where no request logger
      // is available. Report the read failure before failing closed: using
      // compiled defaults here would silently override the Quality tab.
      console.warn("generation text routing settings read failed", {
        event: "generation_text_routing.settings_read_failed",
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
      });
      throw error;
    }
  };
}

/** Fast inline API decisions share the same live revision as worker calls. */
export function createLiveFastJudgmentsTextModel(config: AppConfig): TextModelAdapter {
  return createLiveGenerationTextModel(config, { fastJudgments: true, loadRouting: liveRoutingLoader(config) });
}

/**
 * An inline call that writes for a book, on that book's quality tier: the
 * Writing Studio's quick assists. The tier picks the writer (or, for a
 * purpose in `MECHANICAL_TEXT_PURPOSES`, the judge) the book's own generation
 * would use, so a premium book's rewrite is premium prose.
 */
export function createLiveTieredTextModel(config: AppConfig, tier: ModelTier): TextModelAdapter {
  return createLiveGenerationTextModel(config, { tier, loadRouting: liveRoutingLoader(config) });
}
