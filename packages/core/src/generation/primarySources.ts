import { isStopOrAbortError } from "../adapters/retry.js";

/**
 * Source-document discovery and text extraction for the material-first dossier.
 * The three catalogue adapters retain their public-domain filters. Optional web
 * discovery supplies document URLs; only fetched document text becomes evidence,
 * never a search provider's summary. The worker owns bounded network access and
 * PDF extraction through the injected fetcher. This module performs no IO itself.
 */

export type PrimarySourceHost = "wikisource" | "gutenberg" | "archive" | "web";

export type PrimarySourceCandidate = {
  host: PrimarySourceHost;
  title: string;
  /** The page a reader would open. */
  url: string;
  /** Where the plain text is fetched from. */
  textUrl: string;
  author: string;
  year: string;
};

export type PrimarySourceFetch = (url: string) => Promise<{ status: number; text: string; contentType?: string }>;
/** Discovery supplies addresses only. A provider summary can never become a source passage. */
export type PrimarySourceSearch = (query: string) => Promise<Array<{ title: string; url: string }>>;

export function publicSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
      !host.includes(".") || /^(?:\d+\.){3}\d+$/.test(host) || host.includes(":") ||
      /(?:^|\.)(?:localhost|local|internal|test)$/.test(host)) return undefined;
    url.hash = "";
    return url.href;
  } catch { return undefined; }
}

async function discoverSourceDocuments(query: string, search: PrimarySourceSearch, limit: number): Promise<PrimarySourceCandidate[]> {
  const found = await search(query);
  const candidates = found.flatMap((source): PrimarySourceCandidate[] => {
    const url = publicSourceUrl(source.url);
    return url ? [{ host: "web", title: source.title, url, textUrl: url, author: "", year: "" }] : [];
  });
  // Search grounding is citation order, not document priority. A direct paper at
  // position four used to disappear behind three summaries before it was fetched.
  // These are fetch priorities only; the passage reviewer must establish provenance.
  const priority = (candidate: PrimarySourceCandidate) => {
    const url = new URL(candidate.url);
    return (/\.pdf$/i.test(url.pathname) ? 4 : 0) +
      (/(?:^|\.)(?:gov|edu)(?:\.[a-z]{2})?$|\.ac\.[a-z]{2}$/i.test(url.hostname) ? 2 : 0) +
      (/\/(?:docs|documentation|standards|publications|papers|pubs)\//i.test(url.pathname) ? 1 : 0);
  };
  return [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()]
    .sort((a, b) => priority(b) - priority(a)).slice(0, limit);
}

export const PRIMARY_TEXT_MAX_CHARS = 600_000;
const ARCHIVE_PUBLIC_DOMAIN_BEFORE = 1930;

function wikisourceHost(language: string): string {
  const code = language.trim().toLowerCase().split(/[-_]/)[0] || "en";
  return `${code}.wikisource.org`;
}

function gutendexLanguage(language: string): string {
  return language.trim().toLowerCase().split(/[-_]/)[0] || "en";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/**
 * One request in flight per host, spaced by `HOST_MIN_INTERVAL_MS`, with one
 * retry after a 429: Wikimedia's API asks for serial requests and answered
 * nine chapter builds in parallel with "too many requests" for every search,
 * which left a whole book's dossier at three archive.org documents.
 */
// Two seconds between Wikimedia requests (about 30 a minute) and a twenty-
// second pause after a 429, twice: 300 ms and one 3 s retry drew 194
// refusals in five minutes from three books' dossiers.
//
// A catalogue search is waited for `searchTimeoutMs` and no longer, and a
// catalogue that times out `outageAfterTimeouts` searches running is skipped
// for `outageSkipMs`. The third 100-page Balanced book (2026-09-19) spent 249
// of its 1,633 seconds fetching four documents for two excerpts, because every
// episode search waited on the slowest host: Gutendex answered a 301 in
// 10–19 s and the redirected request in 21–30 s while Wikisource took 0.5 s
// and archive.org 1 s, so each search ran to the worker's 15 s request
// timeout, twice. Ten seconds is twenty times the healthy hosts' latency,
// and the third search onward pays nothing for a host that is down.
const throttle = { intervalMs: 2000, backoffMs: 20_000, retries: 2, searchTimeoutMs: 10_000, outageAfterTimeouts: 2, outageSkipMs: 5 * 60_000 };
const hostQueues = new Map<string, Promise<unknown>>();
const hostLastAt = new Map<string, number>();
/** Consecutive search timeouts per catalogue, and until when the catalogue is skipped. */
const hostOutages = new Map<PrimarySourceHost, { timeouts: number; skipUntil: number }>();

/** Tests set the cadence to nothing and forget any outage; production never calls this. */
export function configurePrimarySourceThrottle(options: Partial<typeof throttle>): void {
  Object.assign(throttle, options);
  hostOutages.clear();
}

type HostSearchOutcome = "answered" | "timed_out" | "skipped" | "failed";

/**
 * One catalogue's search, bounded: `timed_out` after `searchTimeoutMs` (the
 * request itself runs on to the fetcher's own timeout and its answer is
 * dropped), `skipped` while the catalogue is in an outage, `failed` on a
 * thrown error. The bound covers a throttled host's queue wait too, which is
 * at most two other chapters' requests ahead of it: three chapter dossiers
 * build at once, two seconds apart.
 */
async function boundedHostSearch(
  host: PrimarySourceHost, run: () => Promise<PrimarySourceCandidate[]>
): Promise<{ host: PrimarySourceHost; outcome: HostSearchOutcome; candidates: PrimarySourceCandidate[]; ms: number; error?: unknown }> {
  const started = Date.now();
  const outage = hostOutages.get(host);
  if (outage && outage.skipUntil > started) return { host, outcome: "skipped", candidates: [], ms: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => { timer = setTimeout(() => resolve("timed_out"), throttle.searchTimeoutMs); });
  try {
    const result = await Promise.race([run(), timeout]);
    if (result === "timed_out") {
      const timeouts = (outage?.timeouts ?? 0) + 1;
      hostOutages.set(host, { timeouts, skipUntil: timeouts >= throttle.outageAfterTimeouts ? Date.now() + throttle.outageSkipMs : 0 });
      return { host, outcome: "timed_out", candidates: [], ms: Date.now() - started };
    }
    hostOutages.delete(host);
    return { host, outcome: "answered", candidates: result, ms: Date.now() - started };
  } catch (error) {
    return { host, outcome: "failed", candidates: [], ms: Date.now() - started, error };
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Only Wikimedia asks for serial requests; the other hosts answer in parallel and a slow one must not queue the rest. */
const THROTTLED_HOST = /wikisource\.org$|wikipedia\.org$|wikimedia\.org$/i;

export async function throttledFetch(fetchImpl: PrimarySourceFetch, url: string): ReturnType<PrimarySourceFetch> {
  const host = hostOf(url);
  if (!THROTTLED_HOST.test(host)) {
    return fetchImpl(url);
  }
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        const wait = throttle.intervalMs - (Date.now() - (hostLastAt.get(host) ?? 0));
        if (wait > 0) await sleep(wait);
        hostLastAt.set(host, Date.now());
        const response = await fetchImpl(url);
        if (response.status !== 429 || attempt >= throttle.retries) return response;
        await sleep(throttle.backoffMs);
      }
    });
  hostQueues.set(host, run);
  return run;
}

async function fetchJson(fetchImpl: PrimarySourceFetch, url: string): Promise<unknown> {
  const response = await throttledFetch(fetchImpl, url);
  if (response.status !== 200) return undefined;
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    return undefined;
  }
}

export async function searchWikisource(query: string, options: { fetch: PrimarySourceFetch; language: string; limit: number }): Promise<PrimarySourceCandidate[]> {
  const host = wikisourceHost(options.language);
  // Encyclopaedias and dictionaries are the commonest hits and the least
  // primary; the search excludes them by title.
  const search = `${query} -intitle:Encyclopædia -intitle:Encyclopaedia -intitle:Encyclopedia -intitle:Dictionary -intitle:Cyclopedia`;
  const url = `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(search)}&srlimit=${options.limit}&format=json&maxlag=5`;
  const json = record(await fetchJson(options.fetch, url));
  const hits = (record(json?.query)?.search as unknown[] | undefined) ?? [];
  return hits.flatMap((hit) => {
    const title = str(record(hit)?.title);
    if (!title || /^(Page|Index|Author|Portal|Category|Template|Wikisource):/.test(title)) return [];
    return [
      {
        host: "wikisource" as const,
        title,
        url: `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        // The rendered page: `prop=extracts` returns a line or two for a
        // transcluded work, `parse` returns the whole thing.
        textUrl: `https://${host}/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text%7Clinks&format=json&disabletoc=1&maxlag=5`,
        author: "",
        year: ""
      }
    ];
  });
}

export async function searchGutenberg(query: string, options: { fetch: PrimarySourceFetch; language: string; limit: number }): Promise<PrimarySourceCandidate[]> {
  // `/books/` with the slash: without it Gutendex answers a 301 to the slashed
  // address, which cost a second request — and a second 10–19 s — per search.
  const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}&languages=${gutendexLanguage(options.language)}`;
  const json = record(await fetchJson(options.fetch, url));
  const results = (json?.results as unknown[] | undefined) ?? [];
  return results.slice(0, options.limit).flatMap((entry) => {
    const book = record(entry);
    const formats = record(book?.formats) ?? {};
    const textUrl =
      str(formats["text/plain; charset=utf-8"]) || str(formats["text/plain; charset=us-ascii"]) || str(formats["text/plain"]) ||
      str(Object.entries(formats).find(([key, value]) => key.startsWith("text/plain") && typeof value === "string")?.[1]);
    const id = str(book?.id);
    const title = str(book?.title);
    if (!textUrl || !title) return [];
    const author = record((book?.authors as unknown[] | undefined)?.[0]);
    const birth = str(author?.birth_year);
    return [
      {
        host: "gutenberg" as const,
        title,
        url: id ? `https://www.gutenberg.org/ebooks/${id}` : textUrl,
        textUrl,
        author: str(author?.name),
        year: birth ? `b. ${birth}` : ""
      }
    ];
  });
}

export async function searchArchive(query: string, options: { fetch: PrimarySourceFetch; limit: number }): Promise<PrimarySourceCandidate[]> {
  const q = `(${query}) AND mediatype:texts`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=date&fl%5B%5D=licenseurl&rows=${options.limit * 2}&output=json`;
  const json = record(await fetchJson(options.fetch, url));
  const docs = (record(json?.response)?.docs as unknown[] | undefined) ?? [];
  const candidates: PrimarySourceCandidate[] = [];
  // archive.org's full-text search answers "Magna Carta" with a 1504
  // Aristotle; a hit stays only when its title shares a word with the query.
  const queryTerms = query.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]{5,}/g) ?? [];
  for (const entry of docs) {
    const doc = record(entry);
    const identifier = str(doc?.identifier);
    const title = str(doc?.title);
    if (!identifier || !title) continue;
    const titleFolded = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    if (queryTerms.length > 0 && !queryTerms.some((term) => titleFolded.includes(term))) continue;
    const date = str(doc?.date);
    const year = Number.parseInt(date.slice(0, 4), 10);
    const licence = str(doc?.licenseurl);
    const publicDomain = (Number.isFinite(year) && year < ARCHIVE_PUBLIC_DOMAIN_BEFORE) || /publicdomain|creativecommons/i.test(licence);
    if (!publicDomain) continue;
    const creator = Array.isArray(doc?.creator) ? str(doc?.creator[0]) : str(doc?.creator);
    candidates.push({
      host: "archive",
      title,
      url: `https://archive.org/details/${identifier}`,
      textUrl: `https://archive.org/download/${identifier}/${identifier}_djvu.txt`,
      author: creator,
      year: Number.isFinite(year) ? String(year) : ""
    });
    if (candidates.length >= options.limit) break;
  }
  return candidates;
}

/**
 * All three hosts for one query, deduplicated by text URL, Wikisource first (it holds documents,
 * the others hold books). Each catalogue is waited for `searchTimeoutMs` at most; web discovery
 * is a model call with its own budget and is waited for whole. `log` receives one `search`
 * event per query with every host's outcome and latency.
 */
export async function searchPrimarySources(
  query: string,
  options: {
    fetch: PrimarySourceFetch; language: string; limit?: number | undefined; search?: PrimarySourceSearch | undefined;
    log?: ((event: string, detail: Record<string, unknown>) => void) | undefined;
  }
): Promise<PrimarySourceCandidate[]> {
  const limit = options.limit ?? 3;
  const { fetch, language } = options;
  const searches: Array<() => ReturnType<typeof boundedHostSearch>> = [
    ...(options.search ? [async () => {
      const started = Date.now();
      try { return { host: "web" as const, outcome: "answered" as const, candidates: await discoverSourceDocuments(query, options.search!, limit), ms: Date.now() - started }; }
      catch (error) { return { host: "web" as const, outcome: "failed" as const, candidates: [], ms: Date.now() - started, error }; }
    }] : []),
    () => boundedHostSearch("wikisource", () => searchWikisource(query, { fetch, language, limit })),
    () => boundedHostSearch("gutenberg", () => searchGutenberg(query, { fetch, language, limit })),
    () => boundedHostSearch("archive", () => searchArchive(query, { fetch, limit }))
  ];
  const results = await Promise.all(searches.map((search) => search()));
  const seen = new Set<string>();
  const merged: PrimarySourceCandidate[] = [];
  for (const result of results) {
    if (result.outcome === "failed" && isStopOrAbortError(result.error)) throw result.error;
    for (const candidate of result.candidates) {
      if (seen.has(candidate.textUrl)) continue;
      seen.add(candidate.textUrl);
      merged.push(candidate);
    }
  }
  options.log?.("search", {
    query,
    hosts: Object.fromEntries(results.map((result) => [result.host, {
      outcome: result.outcome, ms: result.ms, candidates: result.candidates.length,
      ...(result.error ? { error: result.error instanceof Error ? result.error.message : String(result.error) } : {})
    }]))
  });
  return merged;
}

/** Gutenberg's header and licence footer, the repository's own text and not the work's. */
export function stripGutenbergBoilerplate(text: string): string {
  const start = text.search(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  const end = text.search(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i);
  let body = text;
  if (start >= 0) body = body.slice(body.indexOf("\n", start) + 1);
  if (end >= 0) {
    const cut = body.search(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i);
    if (cut >= 0) body = body.slice(0, cut);
  }
  return body;
}

/** OCR artefacts an archive.org text carries: a word broken by a line-end hyphen, stray carets and pipes. */
export function cleanOcrText(text: string): string {
  return text
    .replace(/(\p{Ll})-\s*\n\s*(\p{Ll})/gu, "$1$2")
    .replace(/(\p{Ll})- (\p{Ll})/gu, "$1$2")
    .replace(/[\^|]/g, "");
}

export function normalizePrimaryText(text: string): string {
  return text
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/<[^>]{1,200}>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(?:p|div|h[1-6]|blockquote|section|table)\b[^>]*>/gi, "\n\n")
    .replace(/<(?:br|\/li|\/tr|\/dd|\/dt)\b[^>]*>/gi, "\n")
    .replace(/<\/(?:td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type WikisourceParse = { title: string; text: string; subpages: string[] };

function wikisourceParse(json: unknown): WikisourceParse | undefined {
  const parse = record(record(json)?.parse);
  if (!parse) return undefined;
  const title = str(parse.title);
  const html = str(record(parse.text)?.["*"]);
  const links = (parse.links as unknown[] | undefined) ?? [];
  const subpages = links.flatMap((link) => {
    const name = str(record(link)?.["*"]);
    return name.startsWith(`${title}/`) && !/\/(?:Preface|Contents|Index|Notes|Appendix|Errata)\b/i.test(name) ? [name] : [];
  });
  return { title, text: htmlToText(html), subpages };
}

const WIKISOURCE_SUBPAGES = 3;
const WIKISOURCE_TOC_WORDS = 400;

/**
 * The page header Wikisource renders above a work — navigation arrows,
 * "related portals", "sister projects", "Wikidata item" — arrives as a run
 * of short blocks, or fused onto the first paragraph when the header is a
 * table. Blocks are dropped only when they carry a header marker; a long
 * first block loses its marker prefix and keeps its prose.
 */
const HEADER_MARKER = /[←→]|sister projects|related portals|related author|Wikidata item|Commons category/i;
const HEADER_PREFIX = /^(?:[^\n]{0,400}?\b(?:Wikidata item|Commons category|sister projects\s*:|related portals\s*:|related author\s*:)\s*[,:;]?\s*)+/i;

export function stripWikisourceHeader(text: string): string {
  const blocks = text.split(/\n\s*\n/);
  let start = 0;
  while (start < blocks.length && start < 8) {
    const block = blocks[start]!;
    const words = block.split(/\s+/).filter(Boolean).length;
    if (!HEADER_MARKER.test(block)) break;
    if (words >= 30) {
      blocks[start] = block.replace(HEADER_PREFIX, "").replace(/^[^\n]{0,200}?→\s*/, "").trim();
      break;
    }
    start += 1;
  }
  return blocks.slice(start).join("\n\n");
}

const ENGLISH_STOPWORDS = new Set(["the", "and", "of", "to", "in", "that", "was", "is", "with", "for", "his", "by", "were", "had", "not", "from", "which", "this", "were", "they"]);

/**
 * Whether a text is in the book's language, for the one language the check
 * knows: an English book's dossier drew a sixteenth-century French arrêt from
 * archive.org, in long-s OCR, attributed to its author. Other languages pass.
 */
export function textLooksLikeLanguage(text: string, language: string): boolean {
  if (!/^en\b/i.test(language.trim())) return true;
  const tokens = text.toLowerCase().slice(0, 20_000).match(/[a-z']+/g) ?? [];
  if (tokens.length < 50) return false;
  let hits = 0;
  for (const token of tokens) if (ENGLISH_STOPWORDS.has(token)) hits += 1;
  return hits / tokens.length >= 0.06;
}

/** Archive identifiers do not determine filenames: resolve a missing OCR file from the item's own manifest. */
async function archiveTextFallback(candidate: PrimarySourceCandidate, fetchImpl: PrimarySourceFetch): Promise<{ status: number; text: string }> {
  const unavailable = { status: 404, text: "" };
  let item: URL;
  try { item = new URL(candidate.url); } catch { return unavailable; }
  if (item.hostname !== "archive.org" || !/^\/details\/[^/]+\/?$/.test(item.pathname)) return unavailable;
  const identifier = item.pathname.split("/")[2]!;
  const metadata = record(await fetchJson(fetchImpl, `https://archive.org/metadata/${identifier}`));
  if (!metadata || metadata.is_dark || !Array.isArray(metadata.files)) return unavailable;
  const files = metadata.files.flatMap((entry) => {
    const file = record(entry);
    const name = str(file?.name);
    if (file?.private || !name || /[\\/]/.test(name) || !(/_djvu\.txt$/i.test(name) || (file?.format === "Text" && /\.txt$/i.test(name)))) return [];
    return [name];
  }).sort((a, b) => Number(/_djvu\.txt$/i.test(b)) - Number(/_djvu\.txt$/i.test(a)) || a.localeCompare(b));
  for (const name of files.slice(0, 2)) {
    const url = `https://archive.org/download/${identifier}/${encodeURIComponent(name)}`;
    if (url === candidate.textUrl) continue;
    const response = await throttledFetch(fetchImpl, url);
    if (response.status === 200 && response.text) return response;
  }
  return unavailable;
}

/** The document's text, capped, with the repository's own boilerplate removed; empty when the host has no plain text for it. */
export async function fetchPrimaryText(
  candidate: PrimarySourceCandidate,
  fetchImpl: PrimarySourceFetch,
  maxChars: number = PRIMARY_TEXT_MAX_CHARS
): Promise<string> {
  let response = await throttledFetch(fetchImpl, candidate.textUrl);
  if (candidate.host === "archive" && response.status === 404) response = await archiveTextFallback(candidate, fetchImpl);
  if (response.status !== 200 || !response.text) return "";
  let text = response.text;
  if (candidate.host === "web") {
    if (response.contentType?.includes("html") || /^\s*(?:<!doctype|<html)/i.test(text)) text = htmlToText(text);
    return normalizePrimaryText(text).slice(0, maxChars);
  }
  if (candidate.host === "wikisource") {
    let parsed: WikisourceParse | undefined;
    try {
      parsed = wikisourceParse(JSON.parse(text));
    } catch {
      return "";
    }
    if (!parsed) return "";
    text = stripWikisourceHeader(parsed.text);
    // A work split into chapters is a table of contents at its own title;
    // the first few chapters are fetched behind it.
    if (text.split(/\s+/).length < WIKISOURCE_TOC_WORDS && parsed.subpages.length > 0) {
      const host = new URL(candidate.textUrl).host;
      const parts: string[] = [];
      for (const subpage of parsed.subpages.slice(0, WIKISOURCE_SUBPAGES)) {
        const sub = await throttledFetch(fetchImpl, `https://${host}/w/api.php?action=parse&page=${encodeURIComponent(subpage)}&prop=text&format=json&disabletoc=1&maxlag=5`);
        if (sub.status !== 200) continue;
        try {
          const subParsed = wikisourceParse(JSON.parse(sub.text));
          if (subParsed?.text) parts.push(subParsed.text);
        } catch {
          continue;
        }
      }
      if (parts.length > 0) text = parts.join("\n\n");
    }
  } else if (candidate.host === "gutenberg") {
    text = stripGutenbergBoilerplate(text);
  } else if (candidate.host === "archive") {
    text = cleanOcrText(text);
  }
  return normalizePrimaryText(text).slice(0, maxChars);
}
