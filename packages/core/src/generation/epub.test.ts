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
  await writeFile(
    join(imageStorageDir, "proj1", "cover.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'
  );
  // Another reader's book, in the same shared storage directory. It has to be a
  // real readable file, or "not packaged" proves nothing.
  await mkdir(join(imageStorageDir, "proj2"), { recursive: true });
  await writeFile(join(imageStorageDir, "proj2", "private.png"), PNG_1X1);
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

  it("packages no file from outside the image storage directory", async () => {
    // This resolver used to be a copy of the PDF's without its containment
    // check, and the filename group matches slashes — so a manuscript (imports
    // and exact-replacement edits are user text) could name any file on the
    // server and have it packaged into the download as an illustration.
    const markdown = [
      "# The Book",
      "",
      "![a](/assets/images/proj1/../../../../../../etc/passwd)",
      "![b](/assets/images/proj1/..%2F..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd)",
      "![c](/assets/images/proj1/nested/../../../etc/hostname)"
    ].join("\n");

    const zip = await JSZip.loadAsync(
      await generateBookEpub(markdown, {
        title: "The Book",
        language: "en",
        imageStorageDir,
        publicApiUrl: "http://localhost:4001"
      })
    );

    const imageFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith("OEBPS/images/") && !zip.files[name]!.dir
    );
    expect(imageFiles).toEqual([]);
  });

  it("packages no illustration belonging to another project", async () => {
    // Containment stops the manuscript leaving the storage directory, but every
    // project's illustrations live inside it. The PDF's cross-project reads died
    // at the renderer's per-project allowlist; nothing renders an EPUB, so this
    // path read the file itself and shipped another reader's artwork in the
    // download to whoever knew the path.
    const markdown = [
      "# The Book",
      "",
      "![mine](http://localhost:4001/assets/images/proj1/page-1.png)",
      "![theirs](http://localhost:4001/assets/images/proj2/private.png)",
      "![theirs again](/assets/images/proj1/..%2Fproj2%2Fprivate.png)"
    ].join("\n");

    const zip = await JSZip.loadAsync(
      await generateBookEpub(markdown, {
        title: "The Book",
        language: "en",
        imageStorageDir,
        publicApiUrl: "http://localhost:4001",
        projectId: "proj1"
      })
    );

    const imageFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith("OEBPS/images/") && !zip.files[name]!.dir
    );
    expect(imageFiles).toEqual(["OEBPS/images/image-1.png"]);
    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapter).toContain('src="images/image-1.png"');
    expect(chapter).not.toContain("private.png");
    expect(chapter).not.toContain("proj2");
  });

  it("drops elements that would make a reader's device fetch a local file", async () => {
    const zip = await JSZip.loadAsync(
      await generateBookEpub('# The Book\n\n<iframe src="file:///etc/passwd"></iframe>\n\nProse.', {
        title: "The Book",
        language: "en",
        imageStorageDir,
        publicApiUrl: "http://localhost:4001"
      })
    );

    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapter).toContain("Prose.");
    expect(chapter).not.toContain("/etc/passwd");
  });

  it("does not package executable manuscript attributes", async () => {
    const zip = await JSZip.loadAsync(
      await generateBookEpub(
        [
          "# The Book",
          "",
          '<img class="figure" src="missing.png" alt="Missing" onerror="window.open(\'https://example.com/probe\')">',
          '<a class="unsafe" href="java&#x73;cript:alert(1)" onclick="alert(2)">unsafe</a>',
          '<a class="safe" href="#part" title="Keep me">safe</a>',
          '<div id="part" onload="alert(3)">Prose.</div>'
        ].join("\n"),
        {
          title: "The Book",
          language: "en",
          imageStorageDir,
          publicApiUrl: "http://localhost:4001"
        }
      )
    );

    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapter).not.toMatch(/\son[a-z]*\s*=/i);
    expect(chapter).not.toContain("java&#x73;cript:");
    expect(chapter).not.toContain("window.open");
    expect(chapter).toContain('class="figure" src="missing.png" alt="Missing"');
    expect(chapter).toContain('<a class="safe" href="#part" title="Keep me">safe</a>');
    expect(chapter).toContain("Prose.");
  });

  it("stores illustrations rather than deflating them, and still deflates the text", async () => {
    // Illustrations arrive already entropy-coded, so deflating them spends real
    // CPU — in pure-JS pako — to save nothing. The assertion reads the archive's
    // own central directory rather than JSZip's `_`-prefixed internals, because
    // this is a property of the file we ship.
    const bytes = await generateBookEpub(SAMPLE_MARKDOWN, {
      title: "The Clockmaker",
      language: "en",
      imageStorageDir,
      publicApiUrl: "http://localhost:4001"
    });
    const methods = zipCompressionMethods(bytes);

    expect(methods.get("OEBPS/images/image-1.png")).toBe(ZIP_STORED);
    // `mimetype` has always been stored; it is the proof the per-entry override
    // the images now use works at all.
    expect(methods.get("mimetype")).toBe(ZIP_STORED);
    // And the rest still compresses: dropping the archive default from level 9
    // to 6 must not have turned into "no compression".
    expect(methods.get("OEBPS/content.opf")).toBe(ZIP_DEFLATED);
    expect(methods.get("OEBPS/chapter-1.xhtml")).toBe(ZIP_DEFLATED);
  });

  it("numbers images by first appearance, so the cover stays image-1", async () => {
    // The reads run concurrently, but `contentOpf` marks the *first* packaged
    // image as `properties="cover-image"` — so completion order must never
    // decide the numbering. The two files differ by extension to make the
    // ordering observable.
    const markdown = [
      "![Cover](http://localhost:4001/assets/images/proj1/cover.svg)",
      "",
      "## Chapter One",
      "",
      "![A workshop](http://localhost:4001/assets/images/proj1/page-1.png)"
    ].join("\n");

    for (let run = 0; run < 3; run += 1) {
      const zip = await JSZip.loadAsync(
        await generateBookEpub(markdown, {
          title: "The Clockmaker",
          language: "en",
          imageStorageDir,
          publicApiUrl: "http://localhost:4001"
        })
      );
      const opf = await zip.file("OEBPS/content.opf")!.async("string");
      expect(opf, `run ${run}`).toContain('<item id="image-1" href="images/image-1.svg"');
      expect(opf, `run ${run}`).toContain('media-type="image/svg+xml" properties="cover-image"');
      expect(opf, `run ${run}`).toContain('<item id="image-2" href="images/image-2.png"');
    }
  });

  it("does not let $-sequences in alt text rewrite the document", async () => {
    // The rewrite used to go through `String.replace`'s pattern syntax, where
    // `$&` in the replacement expands to the whole match.
    const zip = await JSZip.loadAsync(
      await generateBookEpub(
        "## Chapter One\n\n![see $& and $' here](http://localhost:4001/assets/images/proj1/page-1.png)",
        { title: "T", language: "en", imageStorageDir, publicApiUrl: "http://localhost:4001" }
      )
    );

    const chapter = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(chapter).toContain('src="images/image-1.png"');
    expect(chapter).toContain("see $&amp; and $&#39; here");
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

const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

/**
 * The compression method each entry was written with, read from the archive's
 * central directory.
 *
 * Straight from the bytes rather than from JSZip, because "the images are
 * stored" is a property of the EPUB a reading system receives, not of the
 * library that happened to build it.
 */
function zipCompressionMethods(archive: Buffer): Map<string, number> {
  const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
  const methods = new Map<string, number>();
  for (let offset = 0; offset + 46 <= archive.length; offset += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const method = archive.readUInt16LE(offset + 10);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    methods.set(archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"), method);
    offset += 46 + nameLength + extraLength + commentLength - 1;
  }
  return methods;
}
