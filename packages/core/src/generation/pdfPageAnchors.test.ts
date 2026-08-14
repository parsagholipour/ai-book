import { describe, expect, it } from "vitest";
import { defaultConfig } from "md-to-pdf/dist/lib/config.js";
import { getHtml } from "md-to-pdf/dist/lib/get-html.js";
import { compileBookMarkdownWithPageAnchors, type CompileMarkdownInput } from "./markdown.js";
import { liftChapterAnchorsOntoHeadings } from "./pdfDocument.js";
import {
  appendBookPageAnchorLinkNav,
  bookPageAnchorLinkNav,
  injectBookPageAnchorMarkers,
  neutralizeRenderedReservedIds,
  placeBookPageAnchorIds
} from "./pdfPageAnchors.js";

/** Renders exactly as `buildBookPdfDocument` does — marked@4.3.0 through md-to-pdf. */
function render(markdown: string): string {
  return getHtml(markdown, { ...defaultConfig, document_title: "", body_class: [] });
}

/**
 * The layout-relevant residue of a document: markers unwrapped, every id and
 * comment removed. Two documents equal under this normalization produce the
 * same boxes — no stylesheet here selects on ids, which is what the chapter
 * anchor lift already relies on.
 */
function normalized(html: string): string {
  return html
    .replace(/<!--(?:bp-\d+|bp-sources)-->\n?/g, "")
    .replace(/<span id="(?:bp-\d+|bp-sources)">([^<]*)<\/span>/g, "$1")
    .replace(/<span id="(?:bp-\d+|bp-sources)"><\/span>/g, "")
    .replace(/\sid\s*=\s*"[^"]*"/g, "")
    // Whitespace between blocks and trailing collapsible whitespace inside a
    // block are removed at layout; removing a comment leaves both behind.
    .replace(/\s+(<\/(?:p|h[1-6]|li|blockquote)>)/g, "$1")
    .replace(/(<\/(?:p|h[1-6]|ul|ol|li|blockquote|pre|table|div|section)>)\s+/g, "$1");
}

function injectedHtml(markdown: string, anchors: Parameters<typeof injectBookPageAnchorMarkers>[1]): string {
  return placeBookPageAnchorIds(neutralizeRenderedReservedIds(render(injectBookPageAnchorMarkers(markdown, anchors))));
}

/** The renderer's own order: inject, render, neutralize, lift, place. */
function bookHtml(compiled: ReturnType<typeof compileBookMarkdownWithPageAnchors>): string {
  return placeBookPageAnchorIds(
    liftChapterAnchorsOntoHeadings(
      neutralizeRenderedReservedIds(render(injectBookPageAnchorMarkers(compiled.markdown, compiled)))
    )
  );
}

describe("injectBookPageAnchorMarkers + placeBookPageAnchorIds", () => {
  it("marks a mid-paragraph page boundary without splitting the paragraph", () => {
    const markdown = "Last line of page one.\nFirst line of page two, still the same paragraph.";
    const offset = markdown.indexOf("First");
    const html = injectedHtml(markdown, { pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }] });

    // One paragraph either way, with the first word carrying the destination.
    expect(html).toContain('<span id="bp-2">First</span>');
    expect(html.match(/<p>/g)).toHaveLength(1);
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });

  it("lifts a page that opens with a heading onto the heading itself", () => {
    const markdown = "Prose ending page three.\n### A subheading opening page four\n\nBody after it.";
    const offset = markdown.indexOf("### ");
    const html = injectedHtml(markdown, { pageAnchors: [{ pageIndex: 4, destName: "bp-4", markdownOffset: offset }] });

    expect(html).toMatch(/<h3 id="bp-4">/);
    expect(html).not.toContain('<span id="bp-4">');
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });

  it("moves an image-led page's id onto the img", () => {
    const markdown = "Prose ending page one.\n\n![An illustration](proj/page-2.png)\n\nProse of page two.";
    const offset = markdown.indexOf("![");
    const html = injectedHtml(markdown, { pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }] });

    expect(html).toMatch(/<img[^>]*id="bp-2"/);
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });

  it("uses a comment before block syntax that follows a blank line", () => {
    const markdown = "Prose of page one.\n\n> A quotation opening page two.\n\nMore prose.";
    const offset = markdown.indexOf("> A");
    const injected = injectBookPageAnchorMarkers(markdown, {
      pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }]
    });
    expect(injected).toContain("<!--bp-2-->\n> A");

    const html = placeBookPageAnchorIds(render(injected));
    expect(html).toMatch(/<blockquote id="bp-2">/);
    expect(html).not.toContain("<!--bp-2-->");
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });

  it("uses a comment after a fence close, where no paragraph can continue", () => {
    const markdown = "```\ncode of page one\n```\n### Heading of page two\n\nBody.";
    const offset = markdown.indexOf("### ");
    const html = injectedHtml(markdown, { pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }] });

    expect(html).toMatch(/<h3 id="bp-2">/);
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });

  it("keeps a fence-opening page intact", () => {
    const markdown = "Prose of page one.\n\n```\nconst code = true;\n```\n\nAfter.";
    const offset = markdown.indexOf("```");
    const html = injectedHtml(markdown, { pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }] });

    expect(html).toMatch(/<pre id="bp-2">/);
    expect(html).toContain("const code = true;");
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });

  it("marks the Sources heading through the comment shape", () => {
    const markdown = "Final page prose.\n## Sources\n- [A](https://a.example)";
    const html = injectedHtml(markdown, { pageAnchors: [], sourcesOffset: markdown.indexOf("## Sources") });

    expect(html).toMatch(/<h2 id="bp-sources">/);
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });

  it("rides inside a blockquote that straddles the boundary", () => {
    const markdown = "> The first quoted line ends page one.\n> The second quoted line opens page two.";
    const offset = markdown.indexOf("> The second") ;
    const html = injectedHtml(markdown, { pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }] });

    // One blockquote either way — a marker line between the quote lines would
    // split it into two boxes with a second border bar.
    expect(html.match(/<blockquote>/g)).toHaveLength(1);
    expect(html).toContain('<span id="bp-2">The</span>');
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });

  it("rides inside a list that straddles the boundary", () => {
    const markdown = "- first item ends page one\n- second item opens page two\n- third item";
    const offset = markdown.indexOf("- second") ;
    const html = injectedHtml(markdown, { pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }] });

    expect(html.match(/<ul>/g)).toHaveLength(1);
    expect(html).toContain('<span id="bp-2">second</span>');
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });

  it("drops the anchor rather than corrupt a table that straddles the boundary", () => {
    const markdown = "| a | b |\n| - | - |\n| r1 | r1 |\n| r2 | r2 |\n| r3 | r3 |";
    const offset = markdown.indexOf("| r2");
    const injected = injectBookPageAnchorMarkers(markdown, {
      pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }]
    });

    // No marker shape is neutral inside a table; the page stays unanchored and
    // the map builder fails soft to no map.
    expect(injected).toBe(markdown);
    expect(normalized(placeBookPageAnchorIds(render(injected)))).toBe(normalized(render(markdown)));
  });

  it("neutralizes manuscript-authored reserved ids without moving a byte", () => {
    const markdown = 'Prose with a planted <a id="bp-2"></a> anchor inside it.\nSecond page opens here.';
    const offset = markdown.indexOf("Second");
    const injected = injectBookPageAnchorMarkers(markdown, {
      pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }]
    });

    // The manuscript's id is renamed (same length, so the offsets held) and
    // the real marker is the only holder of the destination name.
    expect(injected).toContain('id="xp-2"');
    expect(injected.match(/id="bp-2"/g)).toHaveLength(1);
    expect(placeBookPageAnchorIds(render(injected))).toContain('<span id="bp-2">Second</span>');
  });

  it("handles a strongly-RTL boundary the same way", () => {
    const markdown = "پایان صفحهٔ نخست کتاب است.\nآغاز صفحهٔ دوم در همان بند ادامه می‌یابد.";
    const offset = markdown.indexOf("آغاز");
    const html = injectedHtml(markdown, { pageAnchors: [{ pageIndex: 2, destName: "bp-2", markdownOffset: offset }] });

    expect(html).toContain('<span id="bp-2">آغاز</span>');
    expect(normalized(html)).toBe(normalized(render(markdown)));
  });
});

describe("compileBookMarkdownWithPageAnchors", () => {
  const input: CompileMarkdownInput = {
    plan: {
      title: "The Test Book",
      subtitle: "",
      premise: "A premise.",
      audience: "Readers",
      chapters: [
        { index: 1, title: "One", summary: "First", targetPages: 2 },
        { index: 2, title: "Two", summary: "Second", targetPages: 2 }
      ],
      characters: [],
      questions: []
    } as unknown as CompileMarkdownInput["plan"],
    pages: [
      { index: 1, title: "Page 1", markdown: "First page prose, paragraph one.\n\nParagraph two." },
      { index: 2, title: "Page 2", markdown: "Second page prose continues the chapter." },
      { index: 3, title: "Page 3", markdown: "Third page prose opens chapter two." },
      { index: 4, title: "Page 4", markdown: "Fourth page prose ends the book." }
    ]
  };

  it("keeps compileBookMarkdown byte-identical while naming an anchor per page", () => {
    const compiled = compileBookMarkdownWithPageAnchors(input);
    // Four pages over two planned chapters earn `sections` presentation, so
    // pages 1 and 3 are located by their existing chapter anchors.
    expect(compiled.pageAnchors.map((anchor) => anchor.destName)).toEqual([
      "chapter-1",
      "bp-2",
      "chapter-2",
      "bp-4"
    ]);
    for (const anchor of compiled.pageAnchors) {
      if (anchor.destName.startsWith("chapter-")) {
        expect(anchor.markdownOffset).toBeUndefined();
        continue;
      }
      const at = compiled.markdown.slice(anchor.markdownOffset ?? 0);
      expect(at.startsWith(anchor.pageIndex === 2 ? "Second page prose" : "Fourth page prose")).toBe(true);
    }
  });

  it("locates chapter-opening pages by their existing chapter anchors", () => {
    const chaptered: CompileMarkdownInput = {
      ...input,
      pages: Array.from({ length: 8 }, (_, i) => ({
        index: i + 1,
        title: `Page ${i + 1}`,
        markdown: `Body of page ${i + 1}, long enough to be a page of prose in a chaptered book.`
      })),
      readerChapters: [
        { index: 1, title: "Opening", summary: "s", startPageIndex: 1, endPageIndex: 4 },
        { index: 2, title: "Closing", summary: "s", startPageIndex: 5, endPageIndex: 8 }
      ]
    };
    const compiled = compileBookMarkdownWithPageAnchors(chaptered);
    expect(compiled.hasContents).toBe(true);
    const byPage = new Map(compiled.pageAnchors.map((anchor) => [anchor.pageIndex, anchor]));
    expect(byPage.get(1)?.destName).toBe("chapter-1");
    expect(byPage.get(5)?.destName).toBe("chapter-2");
    expect(byPage.get(2)?.destName).toBe("bp-2");
    expect(byPage.get(2)?.markdownOffset).toBeDefined();
    // A chapter opener carries no insertion point — its id is already written —
    // but it does say where, so the renderer can tell it from a copy in a page.
    for (const anchor of [byPage.get(1), byPage.get(5)]) {
      expect(anchor?.markdownOffset).toBeUndefined();
      expect(compiled.markdown.startsWith(`<a id="${anchor?.destName}"></a>`, anchor?.existingIdOffset ?? -1)).toBe(
        true
      );
    }

    // End to end through the real renderer: inject, render, place — the text
    // is unchanged and every non-chapter page resolved to a real element.
    const injected = injectBookPageAnchorMarkers(compiled.markdown, compiled);
    const html = placeBookPageAnchorIds(render(injected));
    expect(normalized(html)).toBe(normalized(render(compiled.markdown)));
    for (let page = 2; page <= 8; page += 1) {
      if (page === 5) {
        continue;
      }
      expect(html).toContain(`id="bp-${page}"`);
    }
  });

  it("reports the sources offset and cover flag", () => {
    const withExtras: CompileMarkdownInput = {
      ...input,
      cover: { imagePath: "proj/cover.jpg" },
      category: "EDUCATION" as CompileMarkdownInput["category"],
      researchSources: [{ title: "Source A", url: "https://example.org/a", summary: "About A" }],
      includeSources: true
    };
    const compiled = compileBookMarkdownWithPageAnchors(withExtras);
    expect(compiled.hasCoverPage).toBe(true);
    expect(compiled.sourcesOffset).toBeDefined();
    expect(compiled.markdown.slice(compiled.sourcesOffset ?? 0).startsWith("## ")).toBe(true);
  });
});

describe("neutralizeRenderedReservedIds", () => {
  /** Eight pages over two printed chapters, with page three's text under test. */
  function chapteredBook(pageThree: string): ReturnType<typeof compileBookMarkdownWithPageAnchors> {
    return compileBookMarkdownWithPageAnchors({
      plan: {
        title: "The Test Book",
        subtitle: "",
        premise: "A premise.",
        audience: "Readers",
        chapters: [
          { index: 1, title: "Opening", summary: "First", targetPages: 4 },
          { index: 2, title: "Closing", summary: "Second", targetPages: 4 }
        ],
        characters: [],
        questions: []
      } as unknown as CompileMarkdownInput["plan"],
      pages: Array.from({ length: 8 }, (_, i) => ({
        index: i + 1,
        title: `Page ${i + 1}`,
        markdown:
          i === 2 ? pageThree : `Body of page ${i + 1}, long enough to be a page of prose in a chaptered book.`
      })),
      readerChapters: [
        { index: 1, title: "Opening", summary: "s", startPageIndex: 1, endPageIndex: 4 },
        { index: 2, title: "Closing", summary: "s", startPageIndex: 5, endPageIndex: 8 }
      ]
    });
  }

  it("keeps chapter two's destination on chapter two when a page reads like its heading", () => {
    // `## Chapter 2` inside a page is a slug marked writes for itself — it is
    // nowhere in the markdown to be renamed, and it prints two pages before the
    // real opener, which is where Chrome would resolve every `#chapter-2`.
    const compiled = chapteredBook("Body of page 3, prose first.\n\n## Chapter 2\n\nThe manuscript's own heading.");
    const html = bookHtml(compiled);

    expect(html.match(/id="chapter-2"/g)).toHaveLength(1);
    expect(html).toMatch(/<h2 id="chapter-2">[^<]*Closing<\/h2>/);
    expect(html).toContain('<h2 id="xhapter-2">Chapter 2</h2>');
    // Renaming an id moves no box: the same document, lifted but unmarked.
    expect(normalized(html)).toBe(normalized(liftChapterAnchorsOntoHeadings(render(compiled.markdown))));
  });

  it("renames a manuscript's own chapter anchor and keeps the compiled one", () => {
    const compiled = chapteredBook(
      'Body of page 3 with a planted <a id="chapter-2"></a> anchor.\n\n## A subheading\n\nMore prose.'
    );
    const html = bookHtml(compiled);

    expect(html.match(/id="chapter-2"/g)).toHaveLength(1);
    expect(html).toMatch(/<h2 id="chapter-2">[^<]*Closing<\/h2>/);
    // Left standing rather than lifted, and empty either way — no box moves.
    expect(html).toContain('<a id="xhapter-2"></a>');
    expect(html).toMatch(/<h2 id="[^"]*">A subheading<\/h2>/);
  });

  it("renames a manuscript's anchor even where it copies the compiled shape", () => {
    // Empty `<a id>` immediately before a `## ` heading is what the compiler
    // writes, and a manuscript authored in markdown reaches for the same
    // convention — markdown has no attribute syntax of its own.
    const compiled = chapteredBook(
      'Body of page 3.\n\n<a id="chapter-2"></a>\n\n## A chapter of its own\n\nMore prose.'
    );
    const html = bookHtml(compiled);

    expect(html.match(/id="chapter-2"/g)).toHaveLength(1);
    expect(html).toMatch(/<h2 id="chapter-2">[^<]*Closing<\/h2>/);
    expect(html).toContain('<a id="xhapter-2"></a>');
  });

  it("leaves a reserved name alone inside a fenced code sample", () => {
    // Escaped as code text by marked, so it is no id at all — renaming it would
    // print `xhapter-2` in a book that is teaching HTML.
    const compiled = chapteredBook(
      'Body of page 3, on anchors:\n\n```html\n<a id="chapter-2"></a>\n```\n\nAfter the sample.'
    );
    const html = bookHtml(compiled);

    // highlight.js wraps the pieces, so the value is what survives contiguously.
    expect(html).toContain("&quot;chapter-2&quot;");
    expect(html).toMatch(/<h2 id="chapter-2">[^<]*Closing<\/h2>/);
  });

  it("renames nothing when an offset no longer holds the anchor it claims", () => {
    const compiled = chapteredBook('Body of page 3 with a planted <a id="chapter-2"></a> anchor.');
    const stale = {
      ...compiled,
      pageAnchors: compiled.pageAnchors.map((anchor) =>
        anchor.existingIdOffset === undefined ? anchor : { ...anchor, existingIdOffset: anchor.existingIdOffset + 1 }
      )
    };
    const injected = injectBookPageAnchorMarkers(compiled.markdown, stale);

    // Both copies stand. Guessing which one is the compiler's could rename the
    // chapter's own id, and that takes its Contents link with it — the one
    // outcome worse than a stolen destination.
    expect(injected.match(/id="chapter-2"/g)).toHaveLength(2);
  });

  it("leaves the renderer's own marks alone", () => {
    const compiled = chapteredBook("Body of page 3, ordinary prose.");
    const html = bookHtml(compiled);

    // A book with nothing competing for a name renders byte-for-byte as it did
    // before the guard existed — no id it holds is a candidate.
    const rendered = render(injectBookPageAnchorMarkers(compiled.markdown, compiled));
    expect(neutralizeRenderedReservedIds(rendered)).toBe(rendered);

    // Every page still resolved: chapter openers on their headings, the rest on
    // the marks injected for them.
    expect(html).toMatch(/<h2 id="chapter-1">/);
    expect(html).toMatch(/<h2 id="chapter-2">/);
    for (const page of [2, 3, 4, 6, 7, 8]) {
      expect(html).toContain(`id="bp-${page}"`);
    }
    expect(html).not.toContain("xhapter-");
    expect(html).not.toContain('id="xp-');
  });

  it("leaves a heading that only resembles a destination name alone", () => {
    // `chapter-2-the-return` collides with nothing, and a manuscript's own
    // link to it has to keep working.
    const compiled = chapteredBook("Body of page 3.\n\n## Chapter 2: The Return\n\n[Back](#chapter-2-the-return)");
    const html = bookHtml(compiled);

    expect(html).toContain('<h2 id="chapter-2-the-return">');
    expect(html).toContain('href="#chapter-2-the-return"');
    expect(html.match(/id="chapter-2"/g)).toHaveLength(1);
  });

  it("cannot be triggered by prose or a code sample, which marked escapes", () => {
    const markdown = [
      "A fence about anchors:",
      "",
      "```html",
      '<a id="chapter-2"></a>',
      "```",
      "",
      'And inline `id="bp-3"` in prose, and id="chapter-4" as plain text.'
    ].join("\n");
    const html = render(markdown);

    expect(neutralizeRenderedReservedIds(html)).toBe(html);
  });
});

describe("bookPageAnchorLinkNav", () => {
  it("links every planned destination invisibly", () => {
    const nav = bookPageAnchorLinkNav(
      [
        { pageIndex: 1, destName: "chapter-1" },
        { pageIndex: 2, destName: "bp-2" }
      ],
      { hasContents: true, hasSources: true }
    );
    expect(nav).toContain('style="display:none"');
    expect(nav).toContain('href="#chapter-1"');
    expect(nav).toContain('href="#bp-2"');
    expect(nav).toContain('href="#book-contents-title"');
    expect(nav).toContain('href="#bp-sources"');

    const html = appendBookPageAnchorLinkNav("<html><body><p>x</p></body></html>", nav);
    expect(html.indexOf(nav)).toBeLessThan(html.indexOf("</body>"));
  });

  it("returns nothing for an empty plan", () => {
    expect(bookPageAnchorLinkNav([], { hasContents: false, hasSources: false })).toBe("");
  });
});
