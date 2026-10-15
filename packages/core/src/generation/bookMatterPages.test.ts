import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { BOOK_MATTER_LIMITS, parseBookMatter } from "../schemas/bookMatter.js";
import {
  bookCarriesTomezaCredit,
  bookMatterSheetCount,
  escapeMarkdownText,
  formatBookMatter,
  TOMEZA_CREDIT_HEAD_BYTES,
  tomezaCreditInManuscriptHead,
  type BookMatterForCompile
} from "./bookMatterPages.js";
import { markdownLabels } from "./markdownLabels.js";
import { assertBookLikeMarkdown, compileBookMarkdownWithPageAnchors, findBookLikeMarkdownIssues, type MarkdownPage } from "./markdown.js";
import { prepareDocxSource } from "./docxAssets.js";
import { lexDocxMarkdown } from "./docxMath.js";
import { prepareMarkdownMath } from "./markdownMath.js";
import { aboutAuthorLayout, matterSheetLayout } from "./matterSheetLayout.js";

const pages: MarkdownPage[] = [
  { index: 1, title: "First", markdown: "The first page." },
  { index: 2, title: "Second", markdown: "The second page." }
];

function plan() {
  return {
    ...makeFallbackPlan({
      prompt: "A story about a careful clockmaker.",
      category: "STORY",
      targetPages: 2,
      complexity: 5,
      temperature: 0.8,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven",
        includeCover: true,
        coverTemplate: "auto",
        finalReview: true,
        toneProfile: "neutral" as const
      }
    }),
    title: "The Clockmaker",
    subtitle: "A patient trade"
  };
}

function matter(overrides: Partial<BookMatterForCompile> = {}): BookMatterForCompile {
  return { year: 2026, madeWithCredit: false, ...overrides };
}

function compile(input: { authorName?: string; matter?: BookMatterForCompile; language?: string; research?: boolean }) {
  return compileBookMarkdownWithPageAnchors({
    plan: plan(),
    pages,
    category: "SCIENCE",
    ...(input.language ? { language: input.language } : {}),
    ...(input.authorName ? { authorName: input.authorName } : {}),
    ...(input.matter ? { matter: input.matter } : {}),
    ...(input.research ? { researchSources: [{ title: "Clocks", url: "https://example.com/clocks", summary: "" }] } : {})
  });
}

describe("the matter sheet", () => {
  it("prints nothing beyond the title page for a book with no matter", () => {
    const { markdown } = compile({ authorName: "Ada", matter: matter() });
    // A byline alone is a holder: the © line needs nothing else.
    expect(markdown).toContain("© 2026 Ada");

    const bare = compile({ matter: matter() }).markdown;
    expect(bare).not.toContain("book-matter-sheet");
    expect(bare).not.toContain("About the Author");
  });

  it("sets the dedication and the publication details on one sheet, between the title page and the text", () => {
    const { markdown } = compile({
      authorName: "Ada Lovelace",
      matter: matter({
        dedication: "For Sara,\nwho asked for a dragon.\n\nAnd for Babbage.",
        imprint: "Analytical Press",
        isbn: "978-0-00-000000-0",
        allRightsReserved: true
      })
    });

    const sheet = markdown.slice(markdown.indexOf('<section class="book-matter-sheet">'));
    expect(markdown.indexOf("book-title-page")).toBeLessThan(markdown.indexOf("book-matter-sheet"));
    expect(markdown.indexOf("book-matter-sheet")).toBeLessThan(markdown.indexOf("The first page."));
    expect(sheet).toContain("<p>For Sara,<br />who asked for a dragon.</p>");
    expect(sheet).toContain("<p>And for Babbage.</p>");
    expect(sheet).toContain("<p>© 2026 Ada Lovelace</p>");
    expect(sheet).toContain("<p>All rights reserved.</p>");
    expect(sheet).toContain("<p>Analytical Press</p>");
    expect(sheet).toContain("<p>ISBN 978-0-00-000000-0</p>");
    expect(findBookLikeMarkdownIssues(markdown)).toEqual([]);
  });

  it("is one HTML block, so marked never reads a line of it as markdown", () => {
    const { markdown } = compile({ authorName: "Ada", matter: matter({ dedication: "One\n\nTwo" }) });
    const start = markdown.indexOf('<section class="book-matter-sheet">');
    const block = markdown.slice(start, markdown.indexOf("</section>", start) + "</section>".length);
    expect(block).not.toMatch(/\n\s*\n/);
    const html = marked.parse(block, { async: false });
    expect(html).not.toContain("&lt;p&gt;");
    expect(html).toContain("<p>One</p>");
  });

  it("keeps every one-line field on one line, so a blank line in one cannot end the block and open markdown", () => {
    const smuggled = "\n\n![x](https://evil.example/x.png)\n\n# Heading";
    const { markdown } = compileBookMarkdownWithPageAnchors({
      plan: { ...plan(), title: `The Clockmaker${smuggled}`, subtitle: "A patient trade\r\n\r\n[link](https://evil.example)" },
      pages,
      authorName: `Bob${smuggled}`,
      matter: matter({
        copyrightHolder: `Bob Ltd${smuggled}`,
        imprint: "Press\n \n**bold**",
        isbn: "978\t\n\n<b>1</b>",
        dedication: "For Sara\r\r![y](https://evil.example/y.png)"
      })
    });
    for (const open of ['<section class="book-title-page">', '<section class="book-matter-sheet">']) {
      const start = markdown.indexOf(open);
      expect(start, open).toBeGreaterThanOrEqual(0);
      const block = markdown.slice(start, markdown.indexOf("</section>", start) + "</section>".length);
      expect(block, open).not.toMatch(/\n[ \t]*\n/);
      expect(marked.lexer(block).map((token) => token.type), open).toEqual(["html"]);
      const html = marked.parse(block, { async: false });
      expect(html, open).not.toMatch(/<img|<a |<h1>|<strong>|<b>/);
    }
    expect(markdown).toContain(
      '<h1 class="book-title-page__title">The Clockmaker ![x](https://evil.example/x.png) # Heading</h1>'
    );
    expect(markdown).toContain('<p class="book-title-page__subtitle">A patient trade [link](https://evil.example)</p>');
    expect(markdown).toContain('<p class="book-title-page__byline">by Bob ![x](https://evil.example/x.png) # Heading</p>');
    expect(markdown).toContain("<p>© 2026 Bob Ltd ![x](https://evil.example/x.png) # Heading</p>");
    expect(markdown).toContain("<p>Press **bold**</p>");
    expect(markdown).toContain("<p>ISBN 978 &lt;b&gt;1&lt;/b&gt;</p>");
    // The dedication keeps its paragraphs, whichever line ending made them.
    expect(markdown).toContain("<p>For Sara</p>\n    <p>![y](https://evil.example/y.png)</p>");
    expect(findBookLikeMarkdownIssues(markdown)).toEqual([]);

    const source = prepareDocxSource(markdown);
    expect(source.titlePage?.byline).toBe("by Bob ![x](https://evil.example/x.png) # Heading");
    expect(source.matterSheet?.publication).toContain("Press **bold**");
  });

  it("leaves a no-break or ideographic space the reader typed alone", () => {
    const { markdown } = compile({ authorName: "山田　太郎", matter: matter({ imprint: "Éditions du Port" }) });
    expect(markdown).toContain("by 山田　太郎");
    expect(markdown).toContain("<p>Éditions du Port</p>");
  });

  it("asserts no rights for nobody: the rights line needs a holder", () => {
    const { markdown } = compile({ matter: matter({ allRightsReserved: true, isbn: "123" }) });
    expect(markdown).not.toContain("All rights reserved.");
    expect(markdown).not.toContain("©");
    expect(markdown).toContain("<p>ISBN 123</p>");
  });

  it("sets the © year in the book's own digits, and leaves a Latin-script book's bytes alone", () => {
    expect(compile({ language: "fa", authorName: "آدا", matter: matter() }).markdown).toContain("<p>© ۲۰۲۶ آدا</p>");
    expect(compile({ language: "ar", authorName: "آدا", matter: matter() }).markdown).toContain("<p>© ٢٠٢٦ آدا</p>");
    // An ISBN is the reader's, printed as typed.
    expect(compile({ language: "fa", authorName: "آدا", matter: matter({ isbn: "978-600" }) }).markdown).toContain("<p>ISBN 978-600</p>");
    for (const language of ["en", "fr", "he", "zh"]) {
      expect(compile({ language, authorName: "Ada", matter: matter() }).markdown, language).toContain("<p>© 2026 Ada</p>");
    }
    const english = (language?: string) =>
      formatBookMatter({
        title: "T",
        authorName: "Ada",
        matter: matter({ allRightsReserved: true, isbn: "1" }),
        afterCover: false,
        labels: markdownLabels("en"),
        ...(language ? { language } : {})
      });
    expect(english("en")).toEqual(english());
    expect(english().matterSheet).toContain("<p>© 2026 Ada</p>");
  });

  it("prefers the copyright holder to the byline", () => {
    const { markdown } = compile({ authorName: "Ada", matter: matter({ copyrightHolder: "The Lovelace Estate" }) });
    expect(markdown).toContain("© 2026 The Lovelace Estate");
    expect(markdown).not.toContain("© 2026 Ada");
  });

  it("escapes everything the reader typed", () => {
    const { markdown } = compile({
      authorName: "Ada",
      matter: matter({ dedication: "<script>alert(1)</script> & co", imprint: '"Quoted" <b>Press</b>' })
    });
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(markdown).toContain("&quot;Quoted&quot; &lt;b&gt;Press&lt;/b&gt;");
  });
});

describe("the free tier's credit", () => {
  it("sits at the foot of the title page when there is no matter sheet", () => {
    const { markdown } = compile({ matter: matter({ madeWithCredit: true }) });
    expect(markdown).toContain('<p class="book-title-page__imprint">Made with Tomeza</p>');
    expect(markdown).not.toContain("book-matter-sheet");
  });

  it("joins the publication details when there is a sheet, and costs no extra page", () => {
    const { markdown } = compile({ authorName: "Ada", matter: matter({ madeWithCredit: true }) });
    expect(markdown).not.toContain("book-title-page__imprint");
    expect(markdown).toContain('<p class="book-matter-sheet__credit">Made with Tomeza</p>');
  });

  it("is absent on a paid book", () => {
    const { markdown } = compile({ authorName: "Ada", matter: matter({ madeWithCredit: false }) });
    expect(markdown).not.toContain("Tomeza");
  });

  it("speaks the book's language", () => {
    const { markdown } = compile({ language: "fa", matter: matter({ madeWithCredit: true }) });
    expect(markdown).toContain("ساخته‌شده با Tomeza");
  });
});

describe("whether a published book carries the credit", () => {
  it("reads it in either place it is set, in any language", () => {
    expect(bookCarriesTomezaCredit(compile({ matter: matter({ madeWithCredit: true }) }).markdown)).toBe(true);
    expect(bookCarriesTomezaCredit(compile({ authorName: "Ada", matter: matter({ madeWithCredit: true }) }).markdown)).toBe(true);
    expect(bookCarriesTomezaCredit(compile({ language: "fa", matter: matter({ madeWithCredit: true }) }).markdown)).toBe(true);
  });

  it("is false for a paid book and for a book compiled before the matter pages", () => {
    expect(bookCarriesTomezaCredit(compile({ authorName: "Ada", matter: matter({ madeWithCredit: false }) }).markdown)).toBe(false);
    expect(bookCarriesTomezaCredit(compile({}).markdown)).toBe(false);
  });

  it("cannot be spelled by the reader: their words are escaped before they print", () => {
    const spelled = '<p class="book-matter-sheet__credit">Made with Tomeza</p> <p class="book-title-page__imprint">x</p>';
    const { markdown } = compile({
      authorName: spelled,
      matter: matter({ dedication: spelled, imprint: spelled, aboutAuthor: spelled, madeWithCredit: false })
    });
    expect(markdown).toContain("Made with Tomeza");
    expect(bookCarriesTomezaCredit(markdown)).toBe(false);
  });
});

describe("whether a published book carries the credit, read off its opening bytes", () => {
  /** The first `TOMEZA_CREDIT_HEAD_BYTES` of a published file, as the API's ranged read returns them. */
  function fromHead(markdown: string): boolean | undefined {
    const bytes = Buffer.from(markdown);
    const head = bytes.subarray(0, TOMEZA_CREDIT_HEAD_BYTES).toString("utf8");
    return tomezaCreditInManuscriptHead(head, bytes.length <= TOMEZA_CREDIT_HEAD_BYTES);
  }
  /** A 600-page book's worth of text after the front matter. */
  const longBook = (markdown: string) => `${markdown}\n${"The clock ticked on through the long night. ".repeat(60_000)}`;
  const titled = (title: string, input: { authorName?: string; matter: BookMatterForCompile }) =>
    compileBookMarkdownWithPageAnchors({
      plan: { ...plan(), title },
      pages,
      category: "SCIENCE",
      matter: input.matter,
      ...(input.authorName ? { authorName: input.authorName } : {})
    }).markdown;

  it("answers as the whole file does for every front matter the schema bounds", () => {
    const books = [
      compile({ matter: matter({ madeWithCredit: true }) }).markdown,
      compile({ authorName: "Ada", matter: matter({ madeWithCredit: true }) }).markdown,
      compile({ language: "fa", authorName: "آدا", matter: matter({ madeWithCredit: true }) }).markdown,
      // The widest matter sheet: every character of the longest dedication escaped to six bytes.
      compile({
        authorName: "Ada",
        matter: matter({ dedication: '"'.repeat(BOOK_MATTER_LIMITS.dedication), madeWithCredit: true })
      }).markdown,
      compile({ authorName: "Ada", matter: matter({ madeWithCredit: false }) }).markdown,
      compile({ matter: matter() }).markdown,
      // Compiled before the matter pages: a cover, then the text.
      "![Cover for The Clockmaker](http://localhost:4001/assets/images/p/cover.jpg)\nThe first page."
    ];
    for (const book of books) {
      for (const published of [book, longBook(book)]) {
        expect(fromHead(published)).toBe(bookCarriesTomezaCredit(published));
      }
    }
    expect(books.map((book) => fromHead(longBook(book)))).toEqual([true, true, true, true, false, false, false]);
  });

  it("leaves a front matter longer than the head to the whole file", () => {
    // Only the plan's title has no limit: a title page that runs past the head.
    const onTitlePage = longBook(titled("Clock ".repeat(20_000).trim(), { matter: matter({ madeWithCredit: true }) }));
    expect(fromHead(onTitlePage)).toBeUndefined();
    expect(bookCarriesTomezaCredit(onTitlePage)).toBe(true);

    // A title page that closes 20 bytes before the head ends, so the matter sheet's opening is cut.
    const withSheet = (title: string) => titled(title, { authorName: "Ada", matter: matter({ madeWithCredit: true }) });
    const closeAt = withSheet("x").indexOf("</section>");
    const cut = longBook(withSheet("x".repeat(TOMEZA_CREDIT_HEAD_BYTES - 20 - closeAt + 1)));
    expect(cut.indexOf("</section>")).toBe(TOMEZA_CREDIT_HEAD_BYTES - 20);
    expect(fromHead(cut)).toBeUndefined();
    expect(bookCarriesTomezaCredit(cut)).toBe(true);

    // A title of whitespace prints no title page but a heading of it, and the sheet comes after.
    const blank = longBook(titled(" \u0085\u3000".repeat(30_000), { authorName: "Ada", matter: matter({ madeWithCredit: true }) }));
    expect(blank).not.toContain("book-title-page");
    expect(fromHead(blank)).toBeUndefined();
    expect(bookCarriesTomezaCredit(blank)).toBe(true);
  });
});

describe("About the Author", () => {
  it("is the last thing in the book, after the Sources, and carries no back-matter anchor of its own", () => {
    const compiled = compile({ authorName: "Ada", research: true, matter: matter({ aboutAuthor: "Ada writes about engines." }) });
    const { markdown } = compiled;
    expect(markdown.indexOf("## Sources")).toBeLessThan(markdown.indexOf("## About the Author"));
    expect(markdown.trimEnd().endsWith("Ada writes about engines\\.")).toBe(true);
    // The back matter starts where the Sources do.
    expect(markdown.slice(compiled.sourcesOffset)).toMatch(/^## Sources/);
  });

  it("carries the back-matter anchor when no Sources print", () => {
    const compiled = compile({ authorName: "Ada", matter: matter({ aboutAuthor: "Ada writes." }) });
    expect(compiled.markdown.slice(compiled.sourcesOffset)).toMatch(/^## About the Author/);
  });

  it("opens with the marker the stylesheet starts a fresh sheet on", () => {
    const { markdown } = compile({ matter: matter({ aboutAuthor: "Bio.", authorWebsite: "ada.example" }) });
    const html = marked.parse(markdown.slice(markdown.indexOf("## About")), { async: false });
    expect(html).toMatch(/<h2[^>]*>About the Author<\/h2>\s*<div class="book-about-author"><\/div>/);
    expect(html).toContain("ada.example");
  });

  it("prints the biography as text, never as markdown", () => {
    const bio = "# Not a heading\n> not a quote\n1. not a list\n===\n<b>not bold</b> $x$ [link](https://evil.example) bp-3";
    const { markdown } = compile({ matter: matter({ aboutAuthor: bio }) });
    const html = marked.parse(markdown.slice(markdown.indexOf("## About")), { async: false });
    expect(html).not.toMatch(/<h1|<blockquote|<ol|<b>|<a /);
    expect(html).toContain("# Not a heading");
    expect(html).toContain("[link](https://evil.example)");
    expect(findBookLikeMarkdownIssues(markdown)).toEqual([]);
  });

  it("is set at the size it is counted at, and every line the reader wrote prints", () => {
    const short = Array.from({ length: 60 }, (_, index) => `A short paragraph ${index}.`).join("\n\n");
    const { markdown } = compile({ authorName: "Ada", matter: matter({ aboutAuthor: short, authorWebsite: "ada.example" }) });
    const printed = [...short.split("\n\n").map((paragraph) => [paragraph]), ["ada.example"]];
    const layout = aboutAuthorLayout(printed);
    expect(layout).toMatchObject({ tier: "longest", sheets: 2 });
    expect(markdown).toContain(`<div class="${layout.className}"></div>`);
    const html = marked.parse(markdown.slice(markdown.indexOf("## About")), { async: false });
    expect(html).toMatch(/<h2[^>]*>About the Author<\/h2>\s*<div class="book-about-author book-about-author--longest"><\/div>/);
    expect(html.match(/<p>/g)).toHaveLength(61);
  });

  it("is written in one shape, so the count reads back the paragraphs marked renders", () => {
    // Past the schema: CRLF, a line of spaces, a tab-indented line that would open a code block.
    const { markdown } = compile({ matter: matter({ aboutAuthor: "  One\r\n \r\n\tTwo\r\n    Three  \n\n\n" }) });
    const about = markdown.slice(markdown.indexOf("## About"));
    expect(about.slice(about.indexOf("</div>") + "</div>".length)).toBe("\n\nOne\n\nTwo  \nThree");
    const html = marked.parse(about, { async: false });
    expect(html).not.toContain("<pre");
    expect(html).toContain("<p>Two<br>Three</p>");
  });

  it("is headed in the book's language", () => {
    const { markdown } = compile({ language: "fa", matter: matter({ aboutAuthor: "نویسنده" }) });
    expect(markdown).toContain("## دربارهٔ نویسنده");
  });
});

describe("the Word export reads the matter back", () => {
  it("takes the title page's imprint and the matter sheet out of the HTML", () => {
    const withCredit = prepareDocxSource(compile({ matter: matter({ madeWithCredit: true }) }).markdown);
    expect(withCredit.titlePage?.imprint).toBe("Made with Tomeza");
    expect(withCredit.matterSheet).toBeUndefined();

    const source = prepareDocxSource(
      compile({
        authorName: "Ada & Co",
        matter: matter({ dedication: "For Sara,\nwho asked.", madeWithCredit: true, isbn: "1" })
      }).markdown
    );
    expect(source.matterSheet).toEqual({
      dedication: ["For Sara,\nwho asked."],
      publication: ["© 2026 Ada & Co", "ISBN 1"],
      credit: "Made with Tomeza"
    });
    expect(source.segments.map((segment) => (segment.kind === "markdown" ? segment.text : "")).join("")).not.toContain(
      "book-matter-sheet"
    );
  });
});

describe("what the matter pages cost the book", () => {
  it("counts the sheets the paid count never held, which the PDF fitter puts on top of it", () => {
    // A coverless book's title sheet with a byline always counted among the paid sheets…
    expect(bookMatterSheetCount(compile({ authorName: "Ada" }).markdown)).toBe(0);
    // …but one with no byline opened on an inline `# Title`, so its sheet is new.
    expect(bookMatterSheetCount(compile({}).markdown)).toBe(1);
    expect(bookMatterSheetCount(compile({ matter: matter({ madeWithCredit: true }) }).markdown)).toBe(1);
    expect(bookMatterSheetCount(compile({ authorName: "Ada", matter: matter() }).markdown)).toBe(1);
    expect(bookMatterSheetCount(compile({ authorName: "Ada", matter: matter({ aboutAuthor: "Bio." }) }).markdown)).toBe(2);
    // A book compiled before the matter pages: a coverless title sheet with a byline, nothing new.
    expect(bookMatterSheetCount('<section class="book-title-page">\n  <h1 class="book-title-page__title">T</h1>\n  <p class="book-title-page__byline">by Ada</p>\n</section>\n\nText.')).toBe(0);
    expect(bookMatterSheetCount("# T\n\nText.")).toBe(0);
    const covered = compileBookMarkdownWithPageAnchors({
      plan: plan(),
      pages,
      cover: { imagePath: "/assets/images/book/cover.png" },
      authorName: "Ada",
      matter: matter({ aboutAuthor: "Bio." })
    });
    expect(bookMatterSheetCount(covered.markdown)).toBe(3);
  });

  it("counts every sheet a long dedication prints, and sets it at the size it was counted at", () => {
    const poem = Array.from({ length: 40 }, (_, line) => `For the ones who stayed up with me, night ${line}`).join("\n");
    const oneWordLines = Array.from({ length: 1000 }, () => "a").join("\n");
    for (const dedication of ["For Sara.", "Lorem ipsum dolor sit amet. ".repeat(70).trim(), poem, oneWordLines]) {
      const { markdown } = compile({ authorName: "Ada", matter: matter({ dedication, imprint: "Analytical Press", madeWithCredit: true }) });
      const layout = matterSheetLayout({
        dedication: dedication.split(/\n{2,}/).map((paragraph) => paragraph.split("\n")),
        publication: ["© 2026 Ada", "Analytical Press"],
        credit: "Made with Tomeza"
      });
      expect(markdown, dedication.slice(0, 20)).toContain(`<section class="${layout.className}">`);
      expect(bookMatterSheetCount(markdown), dedication.slice(0, 20)).toBe(layout.sheets);
      // Never clipped: every line the reader wrote is in the sheet.
      const sheet = markdown.slice(markdown.indexOf("<section class=\"book-matter-sheet"));
      expect(sheet.split("<br />").length, dedication.slice(0, 20)).toBe(dedication.split("\n").length);
    }
    expect(matterSheetLayout({ dedication: [Array.from({ length: 1000 }, () => "a")], publication: [], credit: undefined }).sheets).toBe(16);
  });

  it("counts every sheet a long biography prints, read back out of the markdown", () => {
    const list = Array.from({ length: 300 }, (_, index) => (index % 3 ? "word" : "Engines")).join("\n");
    const short = Array.from({ length: 30 }, (_, index) => `A short paragraph ${index}.`).join("\n\n");
    for (const [bio, sheets] of [
      ["Bio.", 1],
      [short, 1],
      [list, 5]
    ] as const) {
      // A byline: a coverless title sheet with one is among the paid sheets; the © line is the matter sheet.
      const { markdown } = compile({ authorName: "Ada", matter: matter({ aboutAuthor: bio }) });
      expect(bookMatterSheetCount(markdown), bio.slice(0, 12)).toBe(1 + sheets);
    }
    // Every escape undone: read as `\&`, thirty lines of sixty ampersands set a size smaller than they print.
    const ampersands = Array.from({ length: 30 }, () => "&".repeat(60)).join("\n");
    const { markdown } = compile({ authorName: "Ada", matter: matter({ aboutAuthor: ampersands }) });
    expect(markdown).toContain("\\&\\&");
    const layout = aboutAuthorLayout([ampersands.split("\n")]);
    expect(markdown).toContain(`<div class="${layout.className}"></div>`);
    expect(bookMatterSheetCount(markdown)).toBe(1 + layout.sheets);
  });

  it("reads the reader's escaped words back at their printed length", () => {
    // Read as the `&amp;` each `&` is escaped to, every line would wrap four times and run onto a second sheet.
    const dedication = Array.from({ length: 30 }, () => "&".repeat(60)).join("\n");
    const { markdown } = compile({ matter: matter({ dedication }) });
    expect(markdown).toContain('<section class="book-matter-sheet book-matter-sheet--longest">');
    // The coverless title sheet with no byline, and the one matter sheet.
    expect(bookMatterSheetCount(markdown)).toBe(1 + 1);
  });

  it("reads the document's opening as written, so a coverless book's first page may open on a rule", () => {
    const opening = { plan: plan(), pages: [{ index: 1, title: "First", markdown: "---\n\nThe first page, after a rule." }] };
    expect(() => compileBookMarkdownWithPageAnchors(opening)).not.toThrow();
    expect(() => compileBookMarkdownWithPageAnchors({ ...opening, authorManuscript: true })).not.toThrow();
    expect(findBookLikeMarkdownIssues(compileBookMarkdownWithPageAnchors(opening).markdown)).toEqual([]);
    // A real leading frontmatter block is still one, whoever wrote the text.
    expect(findBookLikeMarkdownIssues("---\ntitle: x\n---\n\nText.")).toEqual(["frontmatter block"]);
    expect(findBookLikeMarkdownIssues("\n---\ntitle: x\n---\n\nText.", { authorManuscript: true })).toEqual(["frontmatter block"]);
  });

  it("never fails a compile over the reader's own words, and still catches a leak in the text", () => {
    const { markdown } = compile({
      authorName: "generatedAt Ada",
      matter: matter({ imprint: "GeneratedAt Press", authorWebsite: "generatedat.com", aboutAuthor: "pages: 12\n\ngeneratedAt" })
    });
    expect(findBookLikeMarkdownIssues(markdown)).toEqual([]);
    expect(() => assertBookLikeMarkdown(markdown)).not.toThrow();
    // Set a size smaller, its marker carries a modifier, and it is still the reader's.
    const long = compile({
      matter: matter({ aboutAuthor: ["generatedAt", ...Array.from({ length: 60 }, (_, index) => `Line ${index}`)].join("\n\n") })
    }).markdown;
    expect(long).toContain('<div class="book-about-author book-about-author--longest"></div>');
    expect(findBookLikeMarkdownIssues(long)).toEqual([]);

    expect(() =>
      compileBookMarkdownWithPageAnchors({
        plan: plan(),
        pages: [{ index: 1, title: "First", markdown: "generatedAt: 2026" }],
        matter: matter()
      })
    ).toThrow(/generatedAt/);
  });
});

describe("parseBookMatter", () => {
  it("keeps what a page can print and drops the rest", () => {
    expect(
      parseBookMatter({
        dedication: "  For Sara  \r\n\r\n\r\n\r\nand Ben ",
        aboutAuthor: "   ",
        isbn: 9780,
        imprint: "x".repeat(500),
        allRightsReserved: "yes",
        unknown: "dropped"
      })
    ).toEqual({ dedication: "For Sara\n\nand Ben", imprint: "x".repeat(120) });
    expect(parseBookMatter({ allRightsReserved: true })).toEqual({ allRightsReserved: true });
    expect(parseBookMatter(null)).toEqual({});
    expect(parseBookMatter("text")).toEqual({});
  });
});

describe("escapeMarkdownText", () => {
  it("escapes every ASCII punctuation mark but the two that open math, and nothing else", () => {
    expect(escapeMarkdownText("a-b.c")).toBe("a\\-b\\.c");
    expect(escapeMarkdownText("دربارهٔ نویسنده")).toBe("دربارهٔ نویسنده");
    expect(escapeMarkdownText(String.raw`(x) [y] \(z\) \[w\] $v$`)).toBe(String.raw`(x\) [y\] \\(z\\\) \\[w\\\] \$v\$`);
    // No escape it writes opens TeX: every backslash in it starts a pair the math pass steps over.
    expect(escapeMarkdownText(String.raw`\(a\) \[b\] $$c$$ (d) [e]`)).not.toMatch(/(?<!\\)(?:\\\\)*\\[([]/);
  });
});

describe("the reader's words are never read as math", () => {
  const typed = {
    title: String.raw`Proofs $t$ and \(tt\)`,
    subtitle: String.raw`On $s$ and \[ss\]`,
    authorName: String.raw`Pen $x$ Name \(pp\)`,
    matter: matter({
      dedication: String.raw`For \(dd\) and $d$ [sq]`,
      imprint: String.raw`Imprint $i$ \(ii\)`,
      copyrightHolder: "Holder $h$",
      isbn: "$9$",
      aboutAuthor: String.raw`Ada (born 1815) wrote \(y\) and $b$ and [sic] and \[z\].`,
      authorWebsite: "site.example/$w$/(v)",
      madeWithCredit: true
    })
  };
  const compiled = () =>
    compileBookMarkdownWithPageAnchors({
      plan: { ...plan(), title: typed.title, subtitle: typed.subtitle },
      pages: [{ index: 1, title: "First", markdown: "Real math: $a^2$." }],
      authorName: typed.authorName,
      matter: typed.matter
    }).markdown;

  it("renders the body's math and none of the matter's, in the PDF and EPUB pass", () => {
    const markdown = compiled();
    const math = prepareMarkdownMath(markdown);
    const html = math.restore(marked.parse(math.markdown, { async: false }));
    expect(html.match(/<math\b/g)).toHaveLength(1);
    for (const literal of ["Proofs $t$ and \\(tt\\)", "Pen $x$ Name \\(pp\\)", "For \\(dd\\) and $d$ [sq]", "Imprint $i$ \\(ii\\)"]) {
      expect(html).toContain(literal);
    }
    expect(html).toContain(String.raw`Ada (born 1815) wrote \(y\) and $b$ and [sic] and \[z\].`);
    expect(html).toContain("site.example/$w$/(v)");
  });

  it("gives the Word export's lexer no math in the About the Author page", () => {
    const markdown = compiled();
    const tokens = lexDocxMarkdown(markdown.slice(markdown.indexOf("## About")));
    const types: string[] = [];
    marked.walkTokens(tokens, (token) => void types.push(token.type));
    expect(types).not.toContain("bookMath");
    expect(types).not.toContain("bookMathBlock");
  });
});
