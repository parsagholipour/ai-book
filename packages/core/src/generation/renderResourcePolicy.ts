import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "puppeteer";

/**
 * What a book render is allowed to load.
 *
 * Printing from `file://` is what made the export fast — the HTML, the CSS and
 * every illustration are read straight off disk instead of crossing CDP — but it
 * also handed the manuscript the renderer's own file access. A page opened from
 * `file://` may load `file://` subresources, and a manuscript is user text:
 * imports arrive as raw prose and an exact-replacement edit writes literal text
 * into a page. Markdown passes raw HTML through, so
 * `<iframe src="file:///etc/passwd">` printed the server's password file into
 * the book, and `/proc/self/environ` would have printed its provider keys. The
 * HTTP-origin renderer this replaced blocked that for free: `file://` is not
 * reachable from an `http://` document.
 *
 * So the origin's permissions are replaced with an explicit allowlist. Chrome
 * reports every load *this page* makes through the interception hook —
 * navigations, frames, images, CSS `url()`, `@import`, anything a script starts
 * later — so this is a choke point in a way that scrubbing HTML is not.
 *
 * Interception is per-page, though, and a page the document opens for itself is
 * a page this was never installed on. PDF rendering therefore disables
 * JavaScript before navigation, PDF/EPUB markup strips executable attributes,
 * and `browserPool.ts` closes unexpected targets on sight. Those layers cover
 * the first popup navigation that a per-page hook cannot observe.
 *
 * Nothing legitimate is turned away: the fonts are `data:` URIs, the stylesheets
 * are inlined into the document, and the only files a book reads are its own
 * illustrations. Remote URLs are refused along with the rest, which also takes
 * the renderer out of reach of the network it sits in — a book that asked for
 * `http://169.254.169.254/…` would otherwise have printed the instance's cloud
 * credentials the same way.
 */
export type RenderResourcePolicy = {
  /** The document written for this render. The only navigation that may happen. */
  documentPath: string;
  /** Directory holding this book's illustrations. Nothing outside it may be read. */
  assetRoot: string;
};

export function isAllowedRenderResource(url: string, policy: RenderResourcePolicy): boolean {
  // The embedded fonts, and Chrome's own placeholder icon for whatever this
  // policy just refused.
  if (url.startsWith("data:")) {
    return true;
  }
  if (url === "about:blank") {
    return true;
  }
  if (!url.startsWith("file:")) {
    return false;
  }

  let path: string;
  try {
    path = resolve(fileURLToPath(url));
  } catch {
    return false;
  }
  if (path === resolve(policy.documentPath)) {
    return true;
  }

  const relativePath = relative(resolve(policy.assetRoot), path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return false;
  }
  // Never a dotfile. The render documents are written as `.book-render-*.html`
  // into the storage directory, so this is what stops one book from framing a
  // concurrent compile's — and it keeps a stray `.env` out of reach.
  return !basename(path).startsWith(".");
}

/**
 * Installs {@link isAllowedRenderResource} on a page, before it navigates.
 *
 * Pages are created per render and closed with it, so the listener neither
 * accumulates nor outlives the policy it was built for.
 */
export async function applyRenderResourcePolicy(page: Page, policy: RenderResourcePolicy): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const settled = isAllowedRenderResource(request.url(), policy)
      ? request.continue()
      : request.abort("blockedbyclient");
    // A request whose page went away is already resolved; the render fails on
    // its own, and an unhandled rejection here would take the process with it.
    settled.catch(() => undefined);
  });
}
