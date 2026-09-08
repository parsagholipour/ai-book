import { z } from "zod";
import type { ToolLoopTool } from "../adapters/toolLoop.js";
import { sourceCitation, type SourcePassage, type SourceService } from "./types.js";

/** One evidence ledger per turn; citations may only name returned full passages. */
export function createSourceTools(service: SourceService) {
  const returned = new Map<string, SourcePassage>();
  const remember = (passages: SourcePassage[]) => passages.map((passage) => {
    returned.set(sourceCitation(passage), passage);
    return { ...passage, citation: sourceCitation(passage) };
  });
  const searchSchema = z.object({ query: z.string().trim().min(1).max(1500), sourceId: z.string().optional() });
  const readSchema = z.object({ sourceId: z.string().optional(), version: z.number().int().min(1).optional(), ordinal: z.number().int().min(0).optional() });
  const search: ToolLoopTool<z.infer<typeof searchSchema>> = {
    name: "search_sources", description: "Search all submitted private uploads by relevance. Optionally restrict to a source ID. Returns verbatim passages and citation references.", parameters: searchSchema,
    execute: async ({ query, sourceId }) => remember(await service.search(query, sourceId))
  };
  const read: ToolLoopTool<z.infer<typeof readSchema>> = {
    name: "read_source", description: "Read a specific verbatim passage and its citation by source ID, extraction version and ordinal. Omit ordinal to read the complete document and section overview, including coverage gaps. Overview summaries cannot be cited: read their full passage with ordinal before citing. Omit source ID for all document overviews.", parameters: readSchema,
    execute: async ({ sourceId, version, ordinal }) => {
      if (ordinal === undefined) {
        const documents = await service.overview(sourceId);
        // Multiple long documents are navigated one at a time: return the
        // complete catalogue first, then every section of the chosen file.
        if (!sourceId && documents.length > 1) return documents.map(({ sections, ...document }) => ({ ...document, sectionCount: sections.length, instruction: "Call read_source with this sourceId for its complete section overview." }));
        return documents.map((document) => ({ ...document, sectionCount: document.sections.length }));
      }
      if (!sourceId || !version) throw new Error("A passage requires sourceId, version and ordinal.");
      const passage = await service.read(sourceId, version, ordinal);
      return passage ? remember([passage])[0] : { error: "Passage unavailable in the submitted source scope." };
    }
  };
  return {
    tools: [search, read],
    validate(text: string): string {
      return text.replace(/\[source:[^\]\n]+\]/g, (reference) => returned.has(reference) ? reference : "[unverified source]");
    },
    passages: () => [...returned.values()]
  };
}
