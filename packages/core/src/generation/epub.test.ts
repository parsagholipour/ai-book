import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateBookEpub } from "./epub.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let imageStorageDir: string;

beforeAll(async () => {
  imageStorageDir = await mkdtemp(join(tmpdir(), "epub-test-images-"));
  await mkdir(join(imageStorageDir, "proj1"), { recursive: true });
  await writeFile(join(imageStorageDir, "proj1", "page-1.png"), PNG_1X1);
});

afterAll(async () => {
  await rm(imageStorageDir, { recursive: true, force: true });
});

const SAMPLE_MARKDOWN = [
  "![Cover for The Clockmaker](http://localhost:4001/assets/images/proj1/page-1.png)",
  "",
  "# The Clockmaker",
  "",
  "An opening note before the chapters & a stray <tag>.",
  "",
  "## Chapter One: Springs",
  "",
  "The first chapter text.",
  "",
  "![A workshop](http://localhost:4001/assets/images/proj1/page-1.png)",
  "",
  "## Chapter Two: Gears",
  "",
  "The second chapter text.",
  "",
  "![Missing remote](https://example.com/external.png)"
].join("\n");

async function buildSampleEpub(): Promise<JSZip> {
  const bytes = await generateBookEpub(SAMPLE_MARKDOWN, {
    title: "The Clockmaker",
    author: "Test Author",
    language: "en",
    imageStorageDir,
    publicApiUrl: "http://localhost:4001"
  });
  return JSZip.loadAsync(bytes);
}

describe("generateBookEpub", () => {
  it("produces a structurally valid EPUB archive", async () => {
    const zip = await buildSampleEpub();

    expect(await zip.file("mimetype")!.async("string")).toBe("application/epub+zip");
    const container = await zip.file("META-INF/container.xml")!.async("string");
    expect(container).toContain('full-path="OEBPS/content.opf"');

    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>The Clockmaker</dc:title>");
    expect(opf).toContain("<dc:creator>Test Author</dc:creator>");
    expect(opf).toContain("<dc:language>en</dc:language>");
    expect(opf).toContain('properties="nav"');
    expect(opf).toContain('properties="cover-image"');
  });

  it("splits chapters on level-2 headings and lists them in the nav", async () => {
    const zip = await buildSampleEpub();

    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain("Chapter One: Springs");
    expect(nav).toContain("Chapter Two: Gears");

    const front = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(front).toContain("The Clockmaker");
    const chapterOne = await zip.file("OEBPS/chapter-2.xhtml")!.async("string");
    expect(chapterOne).toContain("The first chapter text.");
    const chapterTwo = await zip.file("OEBPS/chapter-3.xhtml")!.async("string");
    expect(chapterTwo).toContain("The second chapter text.");
  });

  it("carries a compiled title page into the front matter as XHTML", async () => {
    // The title page is raw HTML inside the Markdown, so it reaches an EPUB
    // through `marked` rather than through a Markdown construct — and it must
    // not start a chapter of its own, which only `##` may do.
    const bytes = await generateBookEpub(
      [
        '<section class="book-title-page">',
        '  <h1 class="book-title-page__title">The Clockmaker</h1>',
        '  <p class="book-title-page__byline">by Test Author</p>',
        "</section>",
        "",
        "## Chapter One: Springs",
        "",
        "The first chapter text."
      ].join("\n"),
      {
        title: "The Clockmaker",
        author: "Test Author",
        language: "en",
        imageStorageDir,
        publicApiUrl: "http://localhost:4001"
      }
    );
    const zip = await JSZip.loadAsync(bytes);

    const front = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(front).toContain('<section class="book-title-page">');
    expect(front).toContain('<p class="book-title-page__byline">by Test Author</p>');
    const chapterOne = await zip.file("OEBPS/chapter-2.xhtml")!.async("string");
    expect(chapterOne).toContain("The first chapter text.");
    expect(chapterOne).not.toContain("book-title-page");
  });

  it("packages local images and strips unresolvable ones", async () => {
    const zip = await buildSampleEpub();

    const imageFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith("OEBPS/images/") && !zip.files[name]!.dir
    );
    expect(imageFiles).toHaveLength(1);

    const chapterTwo = await zip.file("OEBPS/chapter-3.xhtml")!.async("string");
    expect(chapterTwo).not.toContain("example.com/external.png");

    const chapterOne = await zip.file("OEBPS/chapter-2.xhtml")!.async("string");
    expect(chapterOne).toContain('src="images/image-1.png"');
  });

  it("emits self-closed void elements for XHTML compatibility", async () => {
    const zip = await buildSampleEpub();
    const chapterOne = await zip.file("OEBPS/chapter-2.xhtml")!.async("string");
    expect(chapterOne).toMatch(/<img[^>]*\/>/);
    expect(chapterOne).not.toMatch(/<img[^>]*[^/]>/);
  });

  it("gives a Persian book a real language code, RTL pagination and a localized nav", async () => {
    // "Persian" is seven letters, so the old BCP-47 regex rejected it and every
    // such book shipped <dc:language>en</dc:language>.
    const bytes = await generateBookEpub("## \u0641\u0635\u0644 \u06cc\u06a9\n\n\u0627\u06cc\u0646 \u06cc\u06a9 \u0622\u0632\u0645\u0627\u06cc\u0634 \u0627\u0633\u062a.", {
      title: "\u06a9\u062a\u0627\u0628 \u0645\u0627\u0647",
      language: "Persian",
      imageStorageDir,
      publicApiUrl: "http://localhost:4001"
    });
    const zip = await JSZip.loadAsync(bytes);

    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:language>fa</dc:language>");
    // The one thing a reading system cannot infer from CSS.
    expect(opf).toContain('<spine page-progression-direction="rtl">');

    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapter).toContain('xml:lang="fa"');
    expect(chapter).toContain('dir="rtl"');

    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain("<h1>\u0641\u0647\u0631\u0633\u062a</h1>");

    const css = await zip.file("OEBPS/styles.css")!.async("string");
    expect(css).toContain("direction: rtl");
    // No italic face exists, so Chrome must not be allowed to fake one.
    expect(css).toContain("font-style: normal");
  });

  it("reads a stored code as readily as a stored label", async () => {
    for (const language of ["fa", "Farsi", "Persian"]) {
      const bytes = await generateBookEpub("Text.", {
        title: "T",
        language,
        imageStorageDir,
        publicApiUrl: "http://localhost:4001"
      });
      const opf = await (await JSZip.loadAsync(bytes)).file("OEBPS/content.opf")!.async("string");
      expect(opf, language).toContain("<dc:language>fa</dc:language>");
    }
  });

  it("falls back to a single chapter when no headings exist", async () => {
    const bytes = await generateBookEpub("Just one paragraph of text.", {
      title: "Tiny Book",
      imageStorageDir,
      publicApiUrl: "http://localhost:4001"
    });
    const zip = await JSZip.loadAsync(bytes);
    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapter).toContain("Just one paragraph of text.");
    expect(zip.file("OEBPS/chapter-2.xhtml")).toBeNull();
  });
});
