import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../../App.js";
import { PRIVACY_DOCUMENT } from "./LegalPages.js";
import { legalPageHtml, PRERENDERED_LEGAL_PAGES, prerenderLegalPages, renderLegalPageMarkup } from "./legalPrerender.js";

/** What `vite build` makes of index.html: the script moves into the head, hashed. */
const BUILT_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      name="description"
      content="Tomeza turns ideas into practical AI-assisted books. Read Tomeza legal and account-deletion information."
    />
    <title>Tomeza</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-def456.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

describe("prerendered legal pages", () => {
  it("writes one static page per legal route with its text inside the SPA's own document", () => {
    const files = prerenderLegalPages(BUILT_TEMPLATE);

    expect(files.map((file) => file.fileName)).toEqual([
      "terms/index.html",
      "privacy/index.html",
      "account-deletion/index.html"
    ]);
    const privacy = files.find((file) => file.fileName === "privacy/index.html")!.html;
    // The policy text is in the response, not only in what the script renders.
    expect(privacy).toMatch(/<div id="root"><div class="legal-site">[\s\S]*<h1>Privacy Policy<\/h1>/);
    expect(privacy).toContain("Photos of people, including children");
    expect(privacy).toContain("<title>Privacy Policy · Tomeza</title>");
    expect(privacy).toContain(
      '<meta name="description" content="How Tomeza collects, uses, shares, retains, and protects data." />'
    );
    expect(privacy).toContain('<link rel="canonical" href="https://tomeza.ravanix.app/privacy" />');
    // Still the SPA: same bundle and stylesheet, so the script takes over once it loads.
    expect(privacy).toContain('<script type="module" crossorigin src="/assets/index-abc123.js"></script>');
    expect(privacy).toContain('<link rel="stylesheet" crossorigin href="/assets/index-def456.css">');
    expect(privacy).not.toContain("<title>Tomeza</title>");
    expect(privacy).not.toContain("Tomeza turns ideas into practical AI-assisted books");

    const terms = files.find((file) => file.fileName === "terms/index.html")!.html;
    expect(terms).toContain("<h1>Terms and Conditions</h1>");
    const deletion = files.find((file) => file.fileName === "account-deletion/index.html")!.html;
    expect(deletion).toContain("Request account deletion");
  });

  it("fills the repository's real index.html, so a reshaped template fails here rather than in the build", () => {
    const source = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");

    const html = legalPageHtml(source, PRIVACY_DOCUMENT, "<p>policy</p>");

    expect(html).toContain('<div id="root"><p>policy</p></div>');
    expect(html).toContain("<title>Privacy Policy · Tomeza</title>");
  });

  it("refuses a template it cannot fill instead of shipping an empty shell", () => {
    const withoutRoot = BUILT_TEMPLATE.replace('<div id="root"></div>', '<div id="app"></div>');
    const twoTitles = BUILT_TEMPLATE.replace("</head>", "<title>Again</title></head>");

    expect(() => prerenderLegalPages(withoutRoot)).toThrow(/root element exactly once/);
    expect(() => prerenderLegalPages(twoTitles)).toThrow(/<title> exactly once in the built index.html, found 2/);
  });

  it("keeps a `$` in the markup literal", () => {
    const html = legalPageHtml(BUILT_TEMPLATE, PRIVACY_DOCUMENT, "<p>costs $& and $1</p>");

    expect(html).toContain('<div id="root"><p>costs $& and $1</p></div>');
  });

  it("prerenders exactly what the SPA renders at each of those paths", () => {
    for (const { document, Page } of PRERENDERED_LEGAL_PAGES) {
      const spa = renderToStaticMarkup(
        <MemoryRouter initialEntries={[document.path]}>
          <App />
        </MemoryRouter>
      );

      expect(spa).toBe(renderLegalPageMarkup(document, Page));
    }
  });
});
