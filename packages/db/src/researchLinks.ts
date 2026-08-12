import { isGroundingRedirectUrl, resolveGroundingRedirects } from "@book-maker/core";
import { prisma } from "./client.ts";

type StoredResearchSource = {
  id: string;
  title: string;
  url: string | null;
  summary: string;
};

type ResearchCitation = {
  title: string;
  url?: string | undefined;
  summary: string;
};

/**
 * Turns stored research rows into the citations the Sources section is built
 * from, unwrapping any Google grounding redirect still held by a row.
 *
 * New rows arrive already unwrapped — {@link GeminiResearchAdapter} resolves at
 * ingest — so this only ever fires for research gathered before that, or for a
 * wrapper whose first unwrap failed. The correction is written back because a
 * grounding redirect expires: resolving it now, while it still works, is what
 * stops the same book compiling a dead link on some later recompile.
 *
 * It lives here rather than beside the worker's compile because the API renders
 * the same book inline when a compiled file is missing. That path built its own
 * citations and skipped the unwrap, so one book's Sources list named Google or
 * not depending on which process happened to render it.
 *
 * Nothing here is allowed to fail an export. A wrapper that will not resolve
 * stays as it is, which is the same link the book had before.
 */
export async function researchCitationsForExport(sources: StoredResearchSource[]): Promise<ResearchCitation[]> {
  const wrapped = sources.filter((source) => isGroundingRedirectUrl(source.url));
  if (wrapped.length === 0) {
    return sources.map(toCitation);
  }

  const originalUrls = new Map(wrapped.map((source) => [source.id, source.url]));
  const unwrapped = await resolveGroundingRedirects(
    wrapped.map((source) => ({ id: source.id, url: source.url ?? undefined }))
  );
  const direct = new Map<string, string>();
  for (const entry of unwrapped) {
    if (entry.url && entry.url !== originalUrls.get(entry.id)) {
      direct.set(entry.id, entry.url);
    }
  }
  await persistDirectUrls(direct);

  return sources.map((source) => toCitation({ ...source, url: direct.get(source.id) ?? source.url }));
}

async function persistDirectUrls(direct: Map<string, string>): Promise<void> {
  await Promise.all(
    [...direct].map(async ([id, url]) => {
      try {
        await prisma.researchSource.update({ where: { id }, data: { url } });
      } catch {
        // The citation in this export is already correct; a row that vanished
        // or a write that lost a race is not worth failing a compile over.
      }
    })
  );
}

function toCitation(source: { title: string; url: string | null; summary: string }): ResearchCitation {
  return {
    title: source.title,
    url: source.url ?? undefined,
    summary: source.summary
  };
}
