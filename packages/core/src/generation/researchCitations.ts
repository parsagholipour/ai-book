/**
 * The research a book can show its reader: every stored row that carries a
 * link, once per address, titled the way the printed Sources list titles it.
 *
 * The compile prints these as the Sources back matter and the app lists them
 * under the finished book, so both read this one rule — the same book naming a
 * different set of sources in its PDF and on its card would be the citation-map
 * split of old again (`./CLAUDE.md`).
 */

export type ReaderFacingResearchSource = {
  /** The row's own title, or the site's host when that title is unusable. */
  title: string;
  /** The site without `www.`, or null when the address does not parse. */
  host: string | null;
  url: string;
};

/** Words that mark a title as the model's instructions rather than a page's name. */
export const PROMPT_LEAK_PATTERNS = [
  /global visual style/i,
  /continuity rules:/i,
  /image prompt/i,
  /avoid text inside images/i,
  /return json/i,
  /pageinstruction/i,
  /production instructions/i,
  /for an ai book/i,
  /research this for/i,
  /book generation/i,
  /generation plan/i
];

export function readerFacingResearchSources(
  sources: ReadonlyArray<{ title: string; url?: string | null | undefined }>
): ReaderFacingResearchSource[] {
  const seen = new Set<string>();
  const result: ReaderFacingResearchSource[] = [];
  for (const source of sources) {
    const url = source.url?.trim();
    if (!url) {
      continue;
    }
    const key = normalizeSourceUrl(url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ title: sanitizeResearchTitle(source.title, url), host: sourceHost(url), url });
  }
  return result;
}

function sanitizeResearchTitle(title: string, url: string): string {
  const clean = title.trim().replace(/\s+/g, " ");
  if (!clean || clean.length > 120 || PROMPT_LEAK_PATTERNS.some((pattern) => pattern.test(clean))) {
    return sourceHost(url) || "Source";
  }
  return clean;
}

function sourceHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function normalizeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}
