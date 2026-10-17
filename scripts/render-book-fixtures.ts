/**
 * Renders the PDF fixture corpus, so a change to book typography can be looked
 * at before and after rather than argued about.
 *
 * Deliberately not a test. Nothing here asserts; it writes PDFs and prints how
 * long each took. The permanent guards are `pdf.test.ts`'s recorded page count
 * and `pdfDocument.test.ts`'s stylesheet digests — this is what you run when one
 * of those fires, or before touching `pdfCss.ts`, `pdfDocument.ts` or the
 * `md-to-pdf` pin, because a page count is one number and a book is a shape.
 *
 *   pnpm render:fixtures --baseline HEAD out/before
 *   pnpm render:fixtures out/after
 *   pnpm render:fixtures --compare out/before out/after
 *
 * `--baseline <ref>` checks that ref out into a throwaway git worktree, lends it
 * this checkout's installed dependencies, copies *this* file over the one the ref
 * carries and renders there — so both sides share the fixture corpus and only the
 * typography differs. It replaces a `git stash` recipe that could not work: the
 * change under test is routinely what adds the `render:fixtures` script and the
 * `packages/core` exports this file imports, so stashing it takes the harness's
 * own footing away, and `git stash -u` takes the harness with it.
 *
 * Add `--install` when the change moves a dependency — the `md-to-pdf` pin is the
 * one that matters — because borrowed `node_modules` are this tree's, so the
 * baseline would otherwise render against the very version being compared. It
 * runs `pnpm install --frozen-lockfile` against the ref's own lockfile instead,
 * which is slow and needs the network the first time.
 *
 * The comparison checks page counts first — the cheapest signal that margins or
 * the base stylesheet drifted — then rasterises every page at 100 dpi, reports
 * any page whose raster changed size, and counts differing pixels on the rest.
 * Byte-comparing PDFs proves nothing: `/CreationDate`, `/ID` and font-subset
 * ordering differ run to run.
 *
 * Needs poppler-utils (`pdfinfo`, `pdftoppm`) for `--compare`.
 *
 * `--docx` writes a Word file beside each PDF, for eyeballing only: nothing
 * compares them, and LibreOffice headless (`--convert-to pdf`) is the cheapest
 * way to learn whether one is malformed.
 */

import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(HARNESS_PATH));

/**
 * `packages/core` is imported dynamically and typed by hand because a baseline
 * render runs this file against an *older* checkout of it, where an export it
 * names may not exist yet — `closeSharedBrowser` did not, one commit ago. A
 * static named import of a missing export is a link error, thrown before a line
 * of this file runs, which is the failure mode the baseline mode exists to avoid.
 */
type FixtureCore = {
  generateBookPdf: (
    markdown: string,
    options: {
      imageStorageDir: string;
      publicApiUrl: string;
      outputPath: string;
      language: string;
      projectId: string;
    }
  ) => Promise<unknown>;
  /** Absent on a checkout older than the Word export. */
  generateBookDocx?: (
    markdown: string,
    options: {
      title: string;
      imageStorageDir: string;
      publicApiUrl: string;
      outputPath: string;
      language: string;
      projectId: string;
    }
  ) => Promise<unknown>;
  closeSharedBrowser?: () => Promise<void>;
  installSharedBrowserSignalHandlers?: () => () => void;
};

async function loadCore(): Promise<FixtureCore> {
  return (await import("../packages/core/src/index.js")) as unknown as FixtureCore;
}

/**
 * The compiler's front and back matter, as the checkout being rendered writes
 * it. The matter fixtures are built by `formatBookMatter` on each side rather
 * than copied out of it, so a change to where the matter prints (2026-10-17:
 * the publication lines moved from their own sheet to the title page's foot)
 * is compared as the old book against the new one, not as new markup under an
 * old stylesheet. A pure stylesheet change still sees identical markup on both
 * sides. Imported by module path, typed by hand, for the reason `loadCore` is.
 */
type FixtureMatterInput = {
  title: string;
  subtitle?: string;
  authorName?: string;
  afterCover: boolean;
  language: string;
  matter: {
    year: number;
    madeWithCredit: boolean;
    dedication?: string;
    aboutAuthor?: string;
    authorWebsite?: string;
    copyrightHolder?: string;
    imprint?: string;
    isbn?: string;
    allRightsReserved?: boolean;
  };
};
type FixtureMatter = (input: FixtureMatterInput) => { titlePage: string; matterSheet: string; aboutAuthor: string };

async function loadMatter(): Promise<FixtureMatter> {
  const pages = (await import("../packages/core/src/generation/bookMatterPages.js")) as unknown as {
    formatBookMatter: (input: FixtureMatterInput & { labels: unknown }) => ReturnType<FixtureMatter>;
  };
  const markdown = (await import("../packages/core/src/generation/markdown.js")) as unknown as {
    markdownLabels: (language?: string) => unknown;
  };
  return (input) => pages.formatBookMatter({ ...input, labels: markdown.markdownLabels(input.language) });
}

/** A book as the compiler lays it out: cover, title page, matter sheet, text, About the Author. */
function matterBook(matter: FixtureMatter, input: FixtureMatterInput, body: string): string {
  const { titlePage, matterSheet, aboutAuthor } = matter(input);
  return [input.afterCover ? `![Book cover](${image("cover.svg")})` : "", titlePage, matterSheet, body, aboutAuthor]
    .filter(Boolean)
    .join("\n\n");
}

/** Every publication field at its limit (`BOOK_MATTER_LIMITS`), the credit, a long title and subtitle. */
const LONGEST_FOOT: Omit<FixtureMatterInput, "afterCover" | "language"> = {
  title: "The Quiet Engine and Its Several Discontents: A Field Guide to Machines That Would Rather Not Be Built",
  subtitle: "Being a study of the stubborn, the reluctant and the merely tired among the great inventions of the age",
  authorName: "Ada Augusta King, Countess of Lovelace, with Charles Babbage and the Analytical Society",
  matter: {
    year: 2026,
    madeWithCredit: true,
    copyrightHolder:
      "The Estate of Ada Augusta King, Countess of Lovelace, and the Trustees of the Analytical Engine Preservation Society of London",
    allRightsReserved: true,
    imprint: "Lantern & Lathe Press, an imprint of the Society for the Diffusion of Useful and Mechanical Knowledge",
    isbn: "978-0-306-40615-7",
    aboutAuthor: "Ada Lovelace writes about engines, and the people who would rather they stayed quiet.",
    authorWebsite: "ada.example/engines-and-the-people-who-would-rather-they-stayed-quiet"
  }
};

const PUBLIC_API_URL = "http://localhost:4001";
const FIXTURE_PROJECT = "fixture";

function paragraphs(count: number, prefix: string): string {
  const body =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
      6
    );
  return Array.from(
    { length: count },
    (_, index) => `## ${prefix} ${index + 1}\n\nThis is the body of ${prefix.toLowerCase()} ${index + 1}. ${body}`
  ).join("\n\n");
}

function image(file: string): string {
  return `${PUBLIC_API_URL}/assets/images/${FIXTURE_PROJECT}/${file}`;
}

/**
 * One fixture per thing that has broken, or could. Between them they cover the
 * cascade (`markdown.css` → highlight theme → ours), both text directions, a
 * script with no Latin fallback, the illustration path, the cover page, and the
 * dense Contents variant.
 */
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";

/** A figure block as the composed pass stores it: the tag and one line of JSON. */
function figureFence(spec: Record<string, unknown>): string {
  return "```figure\n" + JSON.stringify(spec) + "\n```";
}

const FIXTURES: ReadonlyArray<{ name: string; language: string; markdown: string | ((matter: FixtureMatter) => string) }> = [
  {
    name: "text-only-en",
    language: "en",
    markdown: `# The Quiet Engine\n\nAn opening note.\n\n${paragraphs(12, "Chapter")}`
  },
  {
    name: "illustrated-en",
    language: "en",
    markdown: `# The Painted Hours\n\nAn opening note.\n\n${Array.from(
      { length: 8 },
      (_, index) =>
        `## Chapter ${index + 1}\n\n![Illustration](${image("art.svg")})\n\nBody text for chapter ${index + 1}. ${"Some prose to fill the page. ".repeat(24)}`
    ).join("\n\n")}`
  },
  {
    name: "persian-rtl",
    language: "Farsi",
    markdown: `# کتاب ماه\n\nاین یک آزمایش است.\n\n${Array.from(
      { length: 10 },
      (_, index) =>
        `## فصل ${index + 1}\n\n${"این متن آزمایشی برای بررسی چیدمان راست‌به‌چپ است و باید در چند خط بشکند. ".repeat(12)}\n\n> نقل قول کوتاه.\n\n- مورد اول\n- مورد دوم`
    ).join("\n\n")}`
  },
  {
    name: "cjk",
    language: "zh",
    markdown: `# 静默的引擎\n\n开篇说明。\n\n${Array.from(
      { length: 8 },
      (_, index) => `## 第${index + 1}章\n\n${"这是用于测试排版的示例文本，需要跨越多行显示。".repeat(20)}`
    ).join("\n\n")}`
  },
  {
    name: "rich-blocks",
    language: "en",
    markdown: [
      "# Rich Blocks",
      "",
      "## Everything At Once",
      "",
      "A paragraph before the fence.",
      "",
      "```js",
      "const answer = 42;",
      "function compute(input) {",
      "  return input.map((value) => value * answer);",
      "}",
      "```",
      "",
      "| Column A | Column B | Column C |",
      "| --- | ---: | :---: |",
      "| one | 1 | x |",
      "| two | 22 | yy |",
      "| three | 333 | zzz |",
      "",
      "> A blockquote that runs on for a little while so it wraps onto a second line at least once.",
      "",
      "1. First item",
      "   - nested a",
      "   - nested b",
      "2. Second item",
      "   1. nested one",
      "   2. nested two",
      "",
      "Some `inline code` and a [link](https://example.com) and *emphasis* and **strong**.",
      "",
      "---",
      "",
      paragraphs(4, "Section")
    ].join("\n")
  },
  {
    name: "cover-first",
    language: "en",
    markdown: `![Book cover](${image("cover.svg")})\n\n# The Covered Book\n\nOpening.\n\n${paragraphs(6, "Chapter")}`
  },
  {
    // The coverless front matter — `formatBookMatter` in bookMatterPages.ts, reproduced
    // verbatim because the harness renders markdown rather than compiling a book.
    // It is a *fixed-height, clipped* sheet whose stack is centred by auto
    // margins, so it is the one piece of furniture where a stylesheet edit can
    // silently lose a line rather than move a break; nothing else in the corpus
    // names `pdf-title`, which is why an earlier version of this list let a
    // title-sheet change through unseen.
    name: "title-page-en",
    language: "en",
    markdown: [
      '<section class="book-title-page">',
      '  <h1 class="book-title-page__title">The Quiet Engine and Its Several Discontents</h1>',
      '  <p class="book-title-page__subtitle">A study of machines that would rather not</p>',
      '  <p class="book-title-page__byline">by Ada Lovelace</p>',
      "</section>",
      "",
      paragraphs(6, "Chapter")
    ].join("\n")
  },
  {
    // Every page of book matter, as `formatBookMatter` writes it: the title page
    // *behind* a cover (`pdf-front`: counted, unnumbered, no second counter
    // reset) with the publication lines at its foot, the dedication on a sheet
    // of its own, and About the Author opening a fresh sheet off its marker.
    name: "matter-pages",
    language: "en",
    markdown: (matter) =>
      matterBook(
        matter,
        {
          title: "The Quiet Engine",
          subtitle: "A study of machines that would rather not",
          authorName: "Ada Lovelace",
          afterCover: true,
          language: "en",
          matter: {
            year: 2026,
            madeWithCredit: true,
            dedication: "For Sara,\nwho asked for a dragon.",
            allRightsReserved: true,
            isbn: "978-0-00-000000-0",
            aboutAuthor: "Ada Lovelace writes about engines, and the people who would rather they stayed quiet.",
            authorWebsite: "ada.example"
          }
        },
        paragraphs(3, "Chapter")
      )
  },
  {
    // The same matter as a book compiled before 2026-10-17 carries it: the
    // dedication and the publication lines sharing one sheet. A repair can
    // still render published bytes like these, so they must print as they did.
    name: "matter-pages-legacy",
    language: "en",
    markdown: [
      `![Book cover](${image("cover.svg")})`,
      '<section class="book-title-page book-title-page--after-cover">',
      '  <h1 class="book-title-page__title">The Quiet Engine</h1>',
      '  <p class="book-title-page__subtitle">A study of machines that would rather not</p>',
      '  <p class="book-title-page__byline">by Ada Lovelace</p>',
      "</section>",
      '<section class="book-matter-sheet">',
      '  <div class="book-matter-sheet__dedication">',
      "    <p>For Sara,<br />who asked for a dragon.</p>",
      "  </div>",
      '  <div class="book-matter-sheet__publication">',
      "    <p>© 2026 Ada Lovelace</p>",
      "    <p>All rights reserved.</p>",
      "    <p>ISBN 978-0-00-000000-0</p>",
      '    <p class="book-matter-sheet__credit">Made with Tomeza</p>',
      "  </div>",
      "</section>",
      "",
      paragraphs(3, "Chapter")
    ].join("\n")
  },
  {
    // "The Last Table" (2026-10-17): a cover, a byline and the two © lines, no
    // dedication. The book that printed a whole sheet for those two lines.
    name: "the-last-table",
    language: "en",
    markdown: (matter) =>
      matterBook(
        matter,
        {
          title: "The Last Table",
          subtitle: "A Short Story",
          authorName: "Parsa Gholipour",
          afterCover: true,
          language: "en",
          matter: { year: 2026, madeWithCredit: false, allRightsReserved: true }
        },
        paragraphs(3, "Chapter")
      )
  },
  {
    // The title page's worst case: a long title and subtitle, a long byline and
    // every publication field at its limit, coverless (`pdf-title`, the clipped
    // fixed-height sheet). The foot must print whole under the stack.
    name: "title-foot-longest",
    language: "en",
    markdown: (matter) => matterBook(matter, { ...LONGEST_FOOT, afterCover: false, language: "en" }, paragraphs(2, "Chapter"))
  },
  {
    name: "title-foot-longest-cover",
    language: "en",
    markdown: (matter) => matterBook(matter, { ...LONGEST_FOOT, afterCover: true, language: "en" }, paragraphs(2, "Chapter"))
  },
  {
    // A dedication too long for the house 13pt, set one size down exactly as
    // `formatBookMatter` writes it (`matterSheetLayout` picks the size), so it
    // keeps to the one sheet `bookMatterSheetCount` counts for it.
    name: "long-dedication",
    language: "en",
    markdown: (matter) =>
      matterBook(
        matter,
        {
          title: "The Quiet Engine",
          authorName: "Ada Lovelace",
          afterCover: false,
          language: "en",
          matter: {
            year: 2026,
            madeWithCredit: false,
            dedication: `For Sara, who asked for a dragon.\n\n${LOREM.repeat(15).trim()}`,
            allRightsReserved: true,
            isbn: "978-0-00-000000-0"
          }
        },
        paragraphs(2, "Chapter")
      )
  },
  {
    // About the Author too long for its house size, as `formatBookMatter`
    // writes it: sixty one-line paragraphs and a website, which
    // `aboutAuthorLayout` sets at its smallest size and counts as two sheets
    // (`bookMatterSheetCount`). The biography is set in points on
    // `@page pdf-back`, so these two sheets are the same at any fitter step.
    name: "long-about-author",
    language: "en",
    markdown: [
      '<section class="book-title-page">',
      '  <h1 class="book-title-page__title">The Quiet Engine</h1>',
      '  <p class="book-title-page__byline">by Ada Lovelace</p>',
      "</section>",
      "",
      paragraphs(2, "Chapter"),
      "",
      "## About the Author",
      "",
      '<div class="book-about-author book-about-author--longest"></div>',
      "",
      Array.from({ length: 60 }, (_, index) => `A short paragraph ${index + 1}\\.`).join("\n\n"),
      "",
      "ada\\.example"
    ].join("\n")
  },
  {
    // The matter pages of a right-to-left book, as `formatBookMatter` writes
    // them: the © year in the book's own digits, the rights line and the
    // credit in its language, and its About the Author at the house size.
    name: "matter-pages-fa",
    language: "fa",
    markdown: (matter) =>
      matterBook(
        matter,
        {
          title: "ساعت‌ساز",
          subtitle: "پیشه‌ای صبور",
          authorName: "آدا لاولیس",
          afterCover: false,
          language: "fa",
          matter: {
            year: 2026,
            madeWithCredit: true,
            dedication: "برای سارا،\nکه اژدها خواست.",
            allRightsReserved: true,
            aboutAuthor: "آدا لاولیس دربارهٔ ماشین‌ها می‌نویسد و با دو گربه در لندن زندگی می‌کند.",
            authorWebsite: "ada.example"
          }
        },
        `## فصل ۱\n\n${"این متن آزمایشی برای بررسی چیدمان راست‌به‌چپ است و باید در چند خط بشکند. ".repeat(12)}`
      )
  },
  {
    // The longest title page in a right-to-left book: every publication field
    // and the credit in Persian, coverless.
    name: "title-foot-fa",
    language: "fa",
    markdown: (matter) =>
      matterBook(
        matter,
        {
          title: "ساعت‌ساز و چند نارضایتی دیگرش: راهنمای میدانی ماشین‌هایی که ترجیح می‌دادند ساخته نشوند",
          subtitle: "پژوهشی دربارهٔ لجوج‌ها، بی‌میل‌ها و صرفاً خسته‌ها در میان اختراع‌های بزرگ روزگار",
          authorName: "آدا آگوستا کینگ، کنتس لاولیس، همراه با چارلز ببیج",
          afterCover: false,
          language: "fa",
          matter: {
            year: 2026,
            madeWithCredit: true,
            copyrightHolder: "بنیاد آدا آگوستا کینگ، کنتس لاولیس، و امنای انجمن نگهداری ماشین تحلیلی لندن و همهٔ وارثان قانونی ایشان",
            allRightsReserved: true,
            imprint: "نشر فانوس و تراش، از انتشارات انجمن گسترش دانش سودمند و مکانیکی در سراسر جهان",
            isbn: "978-0-306-40615-7"
          }
        },
        `## فصل ۱\n\n${"این متن آزمایشی برای بررسی چیدمان راست‌به‌چپ است و باید در چند خط بشکند. ".repeat(12)}`
      )
  },
  {
    name: "fifteen-chapters",
    language: "en",
    markdown: `# The Long Index\n\n<div class="book-contents book-contents--dense">\n<p class="book-contents__eyebrow">Contents</p>\n<h2>Contents</h2>\n<div class="book-contents__ornament"></div>\n<ul class="book-contents__list">\n${Array.from(
      { length: 15 },
      (_, index) =>
        `<li class="book-contents__item"><a class="book-contents__link" href="#c${index + 1}"><span class="book-contents__chapter">Chapter ${index + 1}</span><span class="book-contents__name">A Chapter Title Number ${index + 1}</span><span class="book-contents__leader"></span><span class="book-contents__page">${index * 2 + 3}</span></a></li>`
    ).join("\n")}\n</ul>\n</div>\n\n${paragraphs(15, "Chapter")}`
  },
  {
    name: "figures",
    language: "en",
    markdown: [
      "# Figures At Work",
      "",
      "## Chapter 1",
      "",
      LOREM.repeat(4).trim(),
      "",
      figureFence({
        kind: "bar",
        title: "Share of the workforce in farming",
        categories: ["1900", "1950", "2000"],
        series: [
          { name: "United States", values: [41, 12, 2] },
          { name: "France", values: [43, 27, 4] }
        ],
        unit: "%",
        source: "Decennial censuses",
        caption: "Farm work as a share of all employment."
      }),
      "",
      LOREM.repeat(3).trim(),
      "",
      figureFence({
        kind: "line",
        title: "Grain price index, 1800 to 1850",
        categories: ["1800", "1810", "1820", "1830", "1840", "1850"],
        series: [
          { name: "Wheat", values: [100, 128, 96, 88, 104, 91] },
          { name: "Rye", values: [100, 117, 90, 82, 97, 85] }
        ],
        source: "Regional market records",
        caption: "Indexed to 1800."
      }),
      "",
      "## Chapter 2",
      "",
      LOREM.repeat(2).trim(),
      "",
      figureFence({
        kind: "bar",
        title: "Estimated operation counts for four lookup designs as record volume grows",
        categories: ["1,000 records", "10,000 records", "100,000 records"],
        series: [
          { name: "Linear scan, one request", values: [1000, 10000, 100000] },
          { name: "Repeated scan, 10,000 requests", values: [10000000, 100000000, 1000000000] },
          { name: "Sort then query, 10,000 requests", values: [109657, 142877, 1760964] },
          { name: "Hash index, 10,000 requests", values: [11000, 110000, 1100000] }
        ],
        unit: "estimated comparisons or operations",
        source: "Worked customer-record service example",
        caption: "Illustrative growth, not a benchmark."
      }),
      "",
      LOREM.repeat(2).trim(),
      "",
      figureFence({
        kind: "pie",
        title: "Where the harvest went",
        categories: ["Sold at market", "Kept for seed", "Paid in rent", "Eaten at home"],
        series: [{ name: "Share", values: [42, 11, 19, 28] }],
        unit: "%",
        source: "An estate ledger",
        caption: "One estate's harvest, an illustrative year."
      }),
      "",
      figureFence({
        kind: "bar",
        orientation: "horizontal",
        title: "Days from harvest to market by county",
        categories: ["Upper valley parishes", "Lower valley parishes", "Coastal towns", "Highland farms"],
        series: [{ name: "Days", values: [12, 9, 4, 21] }],
        source: "Carriers' waybills"
      }),
      "",
      LOREM.repeat(3).trim(),
      "",
      figureFence({
        kind: "flow",
        title: "How a cart is admitted at the north gate",
        nodes: [
          { id: "a", label: "Cart arrives", shape: "start" },
          { id: "b", label: "Ledger checked" },
          { id: "c", label: "Toll paid?", shape: "decision" },
          { id: "d", label: "Sent to the tollhouse" },
          { id: "e", label: "Admitted", shape: "end" }
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "d", label: "No" },
          { from: "d", to: "b" },
          { from: "c", to: "e", label: "Yes" }
        ],
        source: "The gate procedure",
        caption: "A cart waits until its toll is on the ledger."
      }),
      "",
      LOREM.repeat(2).trim(),
      "",
      figureFence({
        "kind": "flow",
        "title": "Choosing a graph procedure",
        "nodes": [
                {
                        "id": "start",
                        "label": "Graph question",
                        "shape": "start"
                },
                {
                        "id": "reach",
                        "label": "Reachability or hops?",
                        "shape": "decision"
                },
                {
                        "id": "bfs",
                        "label": "Use BFS",
                        "shape": "step"
                },
                {
                        "id": "cycle",
                        "label": "Cycle or prerequisites?",
                        "shape": "decision"
                },
                {
                        "id": "dfs",
                        "label": "Use DFS",
                        "shape": "step"
                },
                {
                        "id": "dag",
                        "label": "Acyclic dependency order",
                        "shape": "decision"
                },
                {
                        "id": "topo",
                        "label": "Use topological order",
                        "shape": "step"
                },
                {
                        "id": "weighted",
                        "label": "Weighted route",
                        "shape": "decision"
                },
                {
                        "id": "shortest",
                        "label": "Use shortest path",
                        "shape": "step"
                },
                {
                        "id": "end",
                        "label": "Validate changing graph",
                        "shape": "end"
                }
        ],
        "edges": [
                {
                        "from": "start",
                        "to": "reach"
                },
                {
                        "from": "reach",
                        "to": "bfs",
                        "label": "Yes"
                },
                {
                        "from": "reach",
                        "to": "cycle",
                        "label": "No"
                },
                {
                        "from": "cycle",
                        "to": "dfs",
                        "label": "Cycle"
                },
                {
                        "from": "cycle",
                        "to": "dag",
                        "label": "Prerequisites"
                },
                {
                        "from": "dag",
                        "to": "topo",
                        "label": "Yes"
                },
                {
                        "from": "dag",
                        "to": "weighted",
                        "label": "No"
                },
                {
                        "from": "weighted",
                        "to": "shortest",
                        "label": "Yes"
                },
                {
                        "from": "bfs",
                        "to": "end"
                },
                {
                        "from": "dfs",
                        "to": "end"
                },
                {
                        "from": "topo",
                        "to": "end"
                },
                {
                        "from": "shortest",
                        "to": "end"
                }
        ],
        "source": "The graph decision procedure",
        "caption": "Illustrative; the graph must be checked again when service relationships change."
      }),
      "",
      LOREM.repeat(2).trim()
    ].join("\n")
  }
];

/**
 * Flat SVGs rather than photographs: a pixel diff should report layout, not
 * codec noise. The explicit width and height matter — an illustration lays out
 * at its intrinsic aspect ratio, so the dimensions are part of what is being
 * pinned.
 */
async function writeFixtureImages(directory: string): Promise<void> {
  await mkdir(join(directory, FIXTURE_PROJECT), { recursive: true });
  const flat = (width: number, height: number, fill: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="${fill}"/></svg>`;
  await writeFile(join(directory, FIXTURE_PROJECT, "art.svg"), flat(600, 800, "#c8503c"), "utf8");
  await writeFile(join(directory, FIXTURE_PROJECT, "cover.svg"), flat(1800, 2400, "#1e3c8c"), "utf8");
}

async function renderAll(outputDir: string, options: { docx?: boolean } = {}): Promise<void> {
  const core = await loadCore();
  const matter = await loadMatter();
  if (options.docx && !core.generateBookDocx) {
    throw new Error("this checkout of packages/core has no Word export to render");
  }
  const removeSignalHandlers = core.installSharedBrowserSignalHandlers?.() ?? (() => undefined);
  await mkdir(outputDir, { recursive: true });
  const imageStorageDir = await mkdtemp(join(tmpdir(), "book-fixture-images-"));
  try {
    await writeFixtureImages(imageStorageDir);
    for (const fixture of FIXTURES) {
      const startedAt = Date.now();
      const markdown = typeof fixture.markdown === "string" ? fixture.markdown : fixture.markdown(matter);
      await core.generateBookPdf(markdown, {
        imageStorageDir,
        publicApiUrl: PUBLIC_API_URL,
        outputPath: join(outputDir, `${fixture.name}.pdf`),
        language: fixture.language,
        projectId: FIXTURE_PROJECT
      });
      if (options.docx) {
        await core.generateBookDocx!(markdown, {
          title: fixture.name,
          imageStorageDir,
          publicApiUrl: PUBLIC_API_URL,
          outputPath: join(outputDir, `${fixture.name}.docx`),
          language: fixture.language,
          projectId: FIXTURE_PROJECT
        });
      }
      console.log(`${fixture.name.padEnd(24)} ${Date.now() - startedAt} ms`);
    }
    console.log(`\n${FIXTURES.length} fixtures → ${outputDir}`);
  } finally {
    try {
      await rm(imageStorageDir, { recursive: true, force: true });
    } finally {
      try {
        // Keep trapping signals until the pooled Chromium is actually gone.
        // Optional because an old baseline closed its own browser per render.
        await core.closeSharedBrowser?.();
      } finally {
        removeSignalHandlers();
      }
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
}

/**
 * pnpm keeps this workspace's dependencies isolated per package rather than
 * hoisted, so the fonts and puppeteer a render needs live in
 * `packages/core/node_modules`, not at the root. The worktree gets a symlink to
 * each one that exists: resolution walks up from the module's own path, and
 * these are read-only for the length of a render.
 *
 * Returns the links it made, because they point at the real install and are
 * unlinked before the worktree is torn down rather than trusted to a recursive
 * delete's treatment of symlinks.
 */
async function lendInstalledDependencies(worktree: string): Promise<string[]> {
  const candidates = ["."];
  for (const group of ["apps", "packages"]) {
    if (!(await exists(join(REPO_ROOT, group)))) continue;
    for (const entry of await readdir(join(REPO_ROOT, group))) candidates.push(join(group, entry));
  }
  const linked: string[] = [];
  for (const candidate of candidates) {
    const source = join(REPO_ROOT, candidate, "node_modules");
    if (!(await exists(source))) continue;
    const target = join(worktree, candidate, "node_modules");
    if (await exists(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target, "junction");
    linked.push(target);
  }
  if (linked.length === 0) {
    throw new Error("nothing installed to lend the baseline — run `pnpm install`, or pass --install");
  }
  return linked;
}

/**
 * Renders the corpus from another commit, without disturbing this working tree.
 *
 * The harness is copied in rather than taken from the ref: the fixtures are the
 * control, so a ref whose corpus differs — or which has no corpus at all,
 * because the change under test is what added it — would report its own text as
 * layout drift.
 */
async function renderBaseline(ref: string, outputDir: string, install: boolean): Promise<void> {
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`);
  const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  if (!(await exists(tsx))) throw new Error(`no ${tsx} to run the baseline with — run \`pnpm install\``);

  // git refuses to plant a worktree on a path that already exists, and mkdtemp
  // creates one, so the temporary directory is its parent.
  const scratch = await mkdtemp(join(tmpdir(), "book-fixture-baseline-"));
  const worktree = join(scratch, "checkout");
  let linked: string[] = [];
  try {
    git("worktree", "add", "--detach", worktree, commit);
    await mkdir(join(worktree, "scripts"), { recursive: true });
    await copyFile(HARNESS_PATH, join(worktree, "scripts", basename(HARNESS_PATH)));
    if (install) {
      execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, stdio: "inherit" });
    } else {
      linked = await lendInstalledDependencies(worktree);
    }
    console.log(
      `baseline ${ref} = ${commit.slice(0, 12)}` +
        `${install ? "  (installed from its own lockfile)" : "  (dependencies borrowed from this checkout)"}\n`
    );
    execFileSync(tsx, [join(worktree, "scripts", basename(HARNESS_PATH)), outputDir], {
      cwd: worktree,
      stdio: "inherit"
    });
  } finally {
    for (const link of linked) await unlink(link).catch(() => {});
    try {
      git("worktree", "remove", "--force", worktree);
    } catch {
      console.warn(`could not remove the baseline worktree; \`git worktree remove --force ${worktree}\``);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

function pageCount(pdf: string): number {
  const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
  return Number(/^Pages:\s+(\d+)$/m.exec(info)?.[1] ?? -1);
}

type Raster = { width: number; height: number; pixels: Buffer };

async function readPpm(path: string): Promise<Raster> {
  const bytes = await readFile(path);
  let offset = 0;
  const tokens: string[] = [];
  while (tokens.length < 4) {
    while (/\s/.test(String.fromCharCode(bytes[offset] ?? 0))) offset += 1;
    if (bytes[offset] === 35) {
      while (offset < bytes.length && bytes[offset] !== 10) offset += 1;
      continue;
    }
    const start = offset;
    while (offset < bytes.length && !/\s/.test(String.fromCharCode(bytes[offset] ?? 0))) offset += 1;
    tokens.push(bytes.subarray(start, offset).toString("ascii"));
  }
  return {
    width: Number(tokens[1]),
    height: Number(tokens[2]),
    pixels: bytes.subarray(offset + 1)
  };
}

/**
 * Differing pixels as a fraction, with a tolerance: antialiasing is not layout.
 *
 * Null when the two pages are not the same size, which is drift on its own and
 * cannot be measured: rows missing from the bottom are never visited by a count
 * taken from the shorter page, and a column removed from the side shifts every
 * row against its neighbour, so the fraction stops describing the layout.
 */
function differingFraction(before: Raster, after: Raster): number | null {
  if (before.width !== after.width || before.height !== after.height) return null;
  const count = before.width * before.height;
  let differing = 0;
  for (let pixel = 0; pixel < count; pixel += 1) {
    const at = pixel * 3;
    if (
      Math.abs((before.pixels[at] ?? 0) - (after.pixels[at] ?? 0)) > 8 ||
      Math.abs((before.pixels[at + 1] ?? 0) - (after.pixels[at + 1] ?? 0)) > 8 ||
      Math.abs((before.pixels[at + 2] ?? 0) - (after.pixels[at + 2] ?? 0)) > 8
    ) {
      differing += 1;
    }
  }
  return differing / count;
}

async function compare(beforeDir: string, afterDir: string): Promise<number> {
  let drifted = 0;
  const files = (await readdir(beforeDir)).filter((file) => file.endsWith(".pdf")).sort();
  for (const file of files) {
    const name = basename(file, ".pdf");
    const before = join(beforeDir, file);
    const after = join(afterDir, file);
    const beforePages = pageCount(before);
    const afterPages = pageCount(after);
    if (beforePages !== afterPages) {
      console.log(`${name.padEnd(18)} PAGE COUNT ${beforePages} -> ${afterPages}   *** DRIFT ***`);
      drifted += 1;
      continue;
    }

    const beforeRaster = await mkdtemp(join(tmpdir(), "cmp-before-"));
    const afterRaster = await mkdtemp(join(tmpdir(), "cmp-after-"));
    try {
      execFileSync("pdftoppm", ["-r", "100", before, join(beforeRaster, "p")]);
      execFileSync("pdftoppm", ["-r", "100", after, join(afterRaster, "p")]);
      const beforePpms = (await readdir(beforeRaster)).sort();
      const afterPpms = (await readdir(afterRaster)).sort();
      let worst = 0;
      let worstPage = 0;
      let resized = false;
      for (let index = 0; index < beforePpms.length; index += 1) {
        const beforePage = await readPpm(join(beforeRaster, beforePpms[index]!));
        const afterPage = await readPpm(join(afterRaster, afterPpms[index]!));
        const fraction = differingFraction(beforePage, afterPage);
        if (fraction === null) {
          console.log(
            `${name.padEnd(18)} PAGE SIZE page ${index + 1} ` +
              `${beforePage.width}x${beforePage.height} -> ${afterPage.width}x${afterPage.height}` +
              `   *** DRIFT ***`
          );
          resized = true;
          break;
        }
        if (fraction > worst) {
          worst = fraction;
          worstPage = index + 1;
        }
      }
      if (resized) {
        drifted += 1;
        continue;
      }
      const percent = worst * 100;
      const verdict = percent > 0.5 ? "*** DRIFT ***" : percent > 0.02 ? "(minor)" : "identical";
      if (percent > 0.5) drifted += 1;
      console.log(
        `${name.padEnd(18)} ${String(beforePages).padStart(3)}p  worst page ${worstPage} ${percent.toFixed(4)}%  ${verdict}`
      );
    } finally {
      await rm(beforeRaster, { recursive: true, force: true });
      await rm(afterRaster, { recursive: true, force: true });
    }
  }
  console.log(drifted === 0 ? "\nOK: no layout drift" : `\n${drifted} fixture(s) drifted`);
  return drifted;
}

const argv = process.argv.slice(2);
const install = argv.includes("--install");
const docx = argv.includes("--docx");
const [first, ...rest] = argv.filter((argument) => argument !== "--install" && argument !== "--docx");
if (first === "--compare") {
  const [beforeDir, afterDir] = rest;
  if (!beforeDir || !afterDir) {
    throw new Error("usage: render-book-fixtures.ts --compare <beforeDir> <afterDir>");
  }
  process.exitCode = (await compare(beforeDir, afterDir)) === 0 ? 0 : 1;
} else if (first === "--baseline") {
  const [ref, outputDir] = rest;
  if (!ref) {
    throw new Error("usage: render-book-fixtures.ts --baseline <ref> [outDir] [--install]");
  }
  // Resolved here: the render runs with the worktree as its working directory.
  await renderBaseline(ref, resolvePath(outputDir ?? "output/book-fixtures-before"), install);
} else {
  await renderAll(first ?? "output/book-fixtures", { docx });
  await writeFile(
    join(first ?? "output/book-fixtures", "README.txt"),
    "Rendered by `pnpm render:fixtures`. Compare two of these directories with\n" +
      "`pnpm render:fixtures --compare <before> <after>`.\n",
    "utf8"
  );
}
