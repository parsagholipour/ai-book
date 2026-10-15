import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  ACCOUNT_DELETION_DOCUMENT,
  AccountDeletionPage,
  legalDocumentTitle,
  PRIVACY_DOCUMENT,
  PrivacyPage,
  TERMS_DOCUMENT,
  TermsPage,
  type LegalDocument
} from "./LegalPages.js";

/**
 * Build-time static copies of the public legal pages.
 *
 * Play's reviewers, crawlers and readers without JavaScript used to get the
 * console's empty `<div id="root"></div>` at /privacy. The web build now writes
 * `privacy/index.html`, `terms/index.html` and `account-deletion/index.html`
 * next to the SPA's `index.html`: the same built document — same stylesheet,
 * same script — with the page's markup already inside the root and its own
 * title, description and canonical URL. Nginx's `try_files $uri $uri/` and
 * `@fastify/static` both answer `/privacy` with `privacy/index.html`, and when
 * the script loads, `createRoot` replaces the markup with the identical SPA
 * render. Run by the `prerender-legal-pages` plugin in `vite.config.ts`, never
 * by the browser bundle.
 */
export const PRERENDERED_LEGAL_PAGES: readonly { document: LegalDocument; Page: ComponentType }[] = [
  { document: TERMS_DOCUMENT, Page: TermsPage },
  { document: PRIVACY_DOCUMENT, Page: PrivacyPage },
  { document: ACCOUNT_DELETION_DOCUMENT, Page: AccountDeletionPage }
];

export type PrerenderedFile = {
  /** Relative to the build's output directory, e.g. `privacy/index.html`. */
  fileName: string;
  html: string;
};

export function prerenderLegalPages(template: string): PrerenderedFile[] {
  return PRERENDERED_LEGAL_PAGES.map(({ document, Page }) => ({
    fileName: `${document.path.slice(1)}/index.html`,
    html: legalPageHtml(template, document, renderLegalPageMarkup(document, Page))
  }));
}

export function renderLegalPageMarkup(document: LegalDocument, Page: ComponentType): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[document.path]}>
      <Page />
    </MemoryRouter>
  );
}

const ROOT_ELEMENT = /<div id="root">\s*<\/div>/;
const TITLE_ELEMENT = /<title>[^<]*<\/title>/;
const DESCRIPTION_META = /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/;

/**
 * Puts one page into the built `index.html`. Each anchor must appear exactly
 * once: a template that has drifted fails the build rather than shipping a
 * shell with no policy text in it, which is the failure this exists to end.
 */
export function legalPageHtml(template: string, document: LegalDocument, markup: string): string {
  const description = escapeHtml(document.description);
  let html = replaceOnce(template, ROOT_ELEMENT, `<div id="root">${markup}</div>`, "the empty root element");
  html = replaceOnce(html, TITLE_ELEMENT, `<title>${escapeHtml(legalDocumentTitle(document))}</title>`, "<title>");
  html = replaceOnce(
    html,
    DESCRIPTION_META,
    `<meta name="description" content="${description}" />\n    ` +
      `<link rel="canonical" href="${escapeHtml(document.canonicalUrl)}" />`,
    'the <meta name="description"> tag'
  );
  return html;
}

function replaceOnce(source: string, pattern: RegExp, replacement: string, label: string): string {
  const matches = source.match(new RegExp(pattern.source, "g")) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Cannot prerender the legal pages: expected ${label} exactly once in the built index.html, found ${matches.length}.`
    );
  }
  // A function replacement, so a `$` in the markup is never read as a pattern.
  return source.replace(pattern, () => replacement);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
