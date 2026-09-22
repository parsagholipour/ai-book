import type { RunLogger } from "../providers/runLogging.js";

/** Start durable writes as decisions occur, then drain them even on cancellation. */
export function createDossierRunTrace(
  runLog: Pick<RunLogger, "append"> | undefined,
  context: { chapterIndex: number; projectId?: string; retrievalStage: string; queryOffset?: number }
) {
  const writes: Promise<void>[] = [];
  return {
    log(event: string, detail: Record<string, unknown>): void {
      const name = `generation.composed_chapters.${event}`;
      const data = { ...detail, ...context };
      console.warn("Dossier step", { event: name, ...data });
      writes.push((async () => {
        try { await runLog?.append(name, data); }
        catch { /* Diagnostic I/O cannot discard retrieved evidence. */ }
      })());
    },
    async flush(): Promise<void> { await Promise.all(writes); }
  };
}
