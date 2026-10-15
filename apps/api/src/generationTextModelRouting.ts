import {
  compiledGenerationTextModelRouting,
  createLiveGenerationTextModel,
  generationTextModelOptions,
  resolveGenerationTextModelRouting,
  routedProvidersWithoutCredentials,
  unkeyedRoutedProviderMessage,
  type AppConfig,
  type GenerationTextModelRouting,
  type ModelTier,
  type TextModelAdapter
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { withContentSafetyRule } from "./contentSafety.js";

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

/**
 * Fast inline API decisions share the same live revision as worker calls.
 * Both factories here are the only way the API builds a text model, so both
 * carry the operator's sexual-content rule (`contentSafety.ts`).
 */
export function createLiveFastJudgmentsTextModel(config: AppConfig): TextModelAdapter {
  return withContentSafetyRule(createLiveGenerationTextModel(config, { fastJudgments: true, loadRouting: liveRoutingLoader(config) }));
}

/**
 * An inline call that writes for a book, on that book's quality tier: the
 * Writing Studio's quick assists. The tier picks the writer (or, for a
 * purpose in `MECHANICAL_TEXT_PURPOSES`, the judge) the book's own generation
 * would use, so a premium book's rewrite is premium prose.
 */
export function createLiveTieredTextModel(config: AppConfig, tier: ModelTier): TextModelAdapter {
  return withContentSafetyRule(createLiveGenerationTextModel(config, { tier, loadRouting: liveRoutingLoader(config) }));
}

type BootLog = {
  warn(details: Record<string, unknown>, message: string): void;
};

/**
 * A saved Quality-tab route stays saved when its provider's key is removed
 * (`resolveGenerationTextModelRouting`), so its calls fail at generation time.
 * The production check requires the keys the *default* routing can select and
 * refuses to boot without them; this one is a warning, because the operator
 * moves a route from the console, and the console needs the API running.
 */
export async function warnAboutUnkeyedSavedRouting(config: AppConfig, log: BootLog): Promise<void> {
  if (config.MOCK_AI) {
    return;
  }
  try {
    const routing = await liveRoutingLoader(config)();
    for (const gap of routedProvidersWithoutCredentials(config, routing)) {
      log.warn(
        {
          event: "generation_text_routing.provider_unkeyed",
          provider: gap.provider,
          variables: gap.variables,
          routeCount: gap.routes.length
        },
        unkeyedRoutedProviderMessage(gap)
      );
    }
  } catch (error) {
    log.warn(
      { err: error, event: "generation_text_routing.provider_check_failed" },
      "Could not check the saved model routing for providers without a key"
    );
  }
}
