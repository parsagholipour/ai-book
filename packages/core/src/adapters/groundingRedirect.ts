/**
 * Google Search grounding never hands back the page it cited. Every
 * `groundingChunk.web.uri` is a `vertexaisearch.cloud.google.com/
 * grounding-api-redirect/...` wrapper, and that is wrong for us twice over: a
 * reader tapping a source in the creation chat sees Google's host instead of
 * the publisher's, and the wrapper expires — the Sources section is recompiled
 * from stored `ResearchSource` rows forever, so a link that dies within weeks
 * rots the back matter of a finished book.
 *
 * Unwrapping happens once, at ingest, because that is the only moment the
 * wrapper is certain to still resolve. Everything downstream — the chat
 * transcript, the stored row, the compiled Sources list — then holds a real
 * address. Failure is never fatal: an unresolved source keeps its wrapper,
 * which is a worse link but still the right page, and dropping it instead
 * would lose a citation the book is expected to carry.
 */

const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

/** Budget for one wrapper, spent across every hop of its chain. */
const DEFAULT_URL_TIMEOUT_MS = 3_000;
/**
 * Budget for a whole batch. A healthy redirect answers in well under a second,
 * so this only ever binds when Google is not answering at all — and the
 * creation chat unwraps inside its own 25s search timeout, where overrunning
 * would cost the entire search rather than one plain-looking link.
 */
const DEFAULT_BATCH_BUDGET_MS = 6_000;
const DEFAULT_CONCURRENCY = 6;
const MAX_HOPS = 4;
/** Enough of an interstitial to find its redirect, not enough to download a page. */
const HTML_SNIFF_BYTES = 8_192;

const RESOLVER_USER_AGENT = "Mozilla/5.0 (compatible; TomezaResearchBot/1.0)";

/**
 * Interstitials carry the destination in markup rather than in a header. Only
 * the first capture group of each is read.
 */
const HTML_REDIRECT_PATTERNS = [
  /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'\s>]+)/i,
  /location\.replace\(\s*["']([^"']+)["']/i,
  /(?:window\.)?location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i
];

export type GroundingRedirectOptions = {
  /** Per-URL budget across its hops. */
  timeoutMs?: number | undefined;
  /** Ceiling for the whole batch; anything unresolved when it passes keeps its wrapper. */
  budgetMs?: number | undefined;
  concurrency?: number | undefined;
};

/** True for the search-grounding wrappers, not for ordinary Google links. */
export function isGroundingRedirectUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return host === GROUNDING_REDIRECT_HOST || host.endsWith(`.${GROUNDING_REDIRECT_HOST}`);
}

/**
 * Follows one wrapper to the page it stands for. Returns `undefined` — never
 * throws, and never returns the wrapper back — so a caller can treat "no
 * answer" as "keep what you had".
 */
export async function resolveGroundingRedirect(
  url: string,
  options: { timeoutMs?: number | undefined } = {}
): Promise<string | undefined> {
  if (!isGroundingRedirectUrl(url)) {
    return undefined;
  }
  const deadline = Date.now() + Math.max(0, options.timeoutMs ?? DEFAULT_URL_TIMEOUT_MS);
  let current = url;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return undefined;
    }
    const next = await followRedirectOnce(current, remaining);
    if (!next || next === current) {
      return undefined;
    }
    if (!isGroundingRedirectUrl(next)) {
      // The first address outside the wrapper is the publisher's own. Following
      // the site's further redirects would only trade it for a consent screen,
      // a paywall or a tracking URL.
      return next;
    }
    current = next;
  }
  return undefined;
}

/**
 * Batch form: resolves the wrappers in a research result and returns sources
 * with direct URLs. Identical wrappers are fetched once, work is capped by
 * {@link GroundingRedirectOptions.concurrency}, and the batch stops handing
 * out work once its budget is gone.
 */
export async function resolveGroundingRedirects<T extends { url?: string | undefined }>(
  sources: readonly T[],
  options: GroundingRedirectOptions = {}
): Promise<T[]> {
  const queue = [
    ...new Set(sources.map((source) => source.url).filter((url): url is string => isGroundingRedirectUrl(url)))
  ];
  if (queue.length === 0) {
    return [...sources];
  }

  const deadline = Date.now() + Math.max(0, options.budgetMs ?? DEFAULT_BATCH_BUDGET_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_URL_TIMEOUT_MS);
  const direct = new Map<string, string>();
  const workerCount = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, queue.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (let wrapped = queue.shift(); wrapped; wrapped = queue.shift()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return;
        }
        const resolved = await resolveGroundingRedirect(wrapped, {
          timeoutMs: Math.min(timeoutMs, remaining)
        });
        if (resolved) {
          direct.set(wrapped, resolved);
        }
      }
    })
  );

  return sources.map((source) => {
    const resolved = source.url ? direct.get(source.url) : undefined;
    return resolved ? { ...source, url: resolved } : source;
  });
}

async function followRedirectOnce(url: string, timeoutMs: number): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": RESOLVER_USER_AGENT
      }
    });
  } catch {
    return undefined;
  }

  const location = response.headers.get("location");
  if (location) {
    await discardBody(response);
    return absoluteHttpUrl(location, url);
  }

  // A 200 is not yet a failure: some clients get an interstitial that carries
  // the destination in markup instead of a Location header.
  const target = await htmlRedirectTarget(response);
  return target ? absoluteHttpUrl(target, url) : undefined;
}

async function htmlRedirectTarget(response: Response): Promise<string | undefined> {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("html")) {
    await discardBody(response);
    return undefined;
  }
  const html = await readBodyPrefix(response, HTML_SNIFF_BYTES);
  for (const pattern of HTML_REDIRECT_PATTERNS) {
    const target = pattern.exec(html)?.[1]?.trim();
    if (target) {
      return decodeHtmlEntities(target);
    }
  }
  return undefined;
}

async function readBodyPrefix(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    // A truncated interstitial is still worth scanning.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, maxBytes);
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing left to release.
  }
}

function absoluteHttpUrl(candidate: string, base: string): string | undefined {
  try {
    const resolved = new URL(candidate, base);
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
      return undefined;
    }
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&#0*38;/g, "&");
}
