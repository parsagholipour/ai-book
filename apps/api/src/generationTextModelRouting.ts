import {
  compiledGenerationTextModelRouting,
  createLiveGenerationTextModel,
  generationTextModelOptions,
  resolveGenerationTextModelRouting,
  type AppConfig,
  type TextModelAdapter
} from "@book-maker/core";
import { prisma } from "@book-maker/db";

/** Fast inline API decisions share the same live revision as worker calls. */
export function createLiveFastJudgmentsTextModel(config: AppConfig): TextModelAdapter {
  const compiled = compiledGenerationTextModelRouting(config, generationTextModelOptions(config));
  return createLiveGenerationTextModel(config, {
    fastJudgments: true,
    loadRouting: async () => {
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
    }
  });
}
