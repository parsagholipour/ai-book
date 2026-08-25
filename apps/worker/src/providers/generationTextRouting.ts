import {
  compiledGenerationTextModelRouting,
  generationTextModelOptions,
  resolveGenerationTextModelRouting,
  type GenerationTextModelRouting
} from "@book-maker/core";
import { prisma } from "@book-maker/db";
import { config } from "../runtime/config.js";
import type { RunLogger } from "./runLogging.js";

/** Loads the latest quality revision; a read failure stops rather than changing models. */
export function loadLiveGenerationTextRouting(logger: RunLogger): () => Promise<GenerationTextModelRouting> {
  const compiled = compiledGenerationTextModelRouting(config, generationTextModelOptions(config));
  return () =>
    loadGenerationTextRoutingSnapshot({
      compiled,
      load: async () => {
        const row = await prisma.generationQualityRevision.findFirst({
          orderBy: { version: "desc" },
          select: { settings: true }
        });
        return row?.settings;
      },
      log: (error) =>
        logger
          .append("text.routing.settings_read_failed", {
            error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }
          })
          .then(() => undefined)
    });
}

export async function loadGenerationTextRoutingSnapshot(options: {
  compiled: GenerationTextModelRouting;
  load: () => Promise<unknown>;
  log: (error: unknown) => Promise<void>;
}): Promise<GenerationTextModelRouting> {
  try {
    return resolveGenerationTextModelRouting(await options.load(), options.compiled);
  } catch (error) {
    await options.log(error).catch(() => undefined);
    throw error;
  }
}
