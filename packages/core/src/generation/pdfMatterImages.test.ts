import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatBookMatter } from "./bookMatterPages.js";
import { markdownLabels } from "./markdownLabels.js";
import { prepareMarkdownForPdfDocument } from "./pdf.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PDF illustration preparation around literal matter", () => {
  it.each([
    { size: "short", bio: "For my mom" },
    { size: "long", bio: Array.from({ length: 60 }, () => "For my mom").join("\n\n") }
  ])("keeps every matter field literal while localizing cover and body images ($size biography)", async ({ bio }) => {
    const imageStorageDir = await mkdtemp(join(tmpdir(), "book-pdf-literal-matter-"));
    directories.push(imageStorageDir);
    await mkdir(join(imageStorageDir, "owned"));
    await writeFile(join(imageStorageDir, "owned", "image.png"), "readable image");
    await mkdir(join(imageStorageDir, "other"));
    await writeFile(join(imageStorageDir, "other", "image.png"), "another project's image");

    const literal = "![my mom](http://localhost:4001/assets/images/owned/image.png)";
    const matter = formatBookMatter({
      title: `Letters ${literal}`,
      subtitle: `Memories ${literal}`,
      authorName: `Author ${literal}`,
      matter: {
        dedication: `For ${literal}`,
        copyrightHolder: `Holder ${literal}`,
        imprint: `Publisher ${literal}`,
        aboutAuthor: `${bio} ${literal}`,
        authorWebsite: `Website ${literal}`,
        year: 2026,
        madeWithCredit: false
      },
      afterCover: true,
      labels: markdownLabels("en")
    });
    const body = "![Body](http://localhost:4001/assets/images/owned/image.png)";
    const unowned = "![Other](http://localhost:4001/assets/images/other/image.png)";
    const prepared = await prepareMarkdownForPdfDocument(
      ["![Cover](http://localhost:4001/assets/images/owned/image.png)", matter.titlePage, matter.matterSheet,
        "## Chapter One", body, unowned, matter.aboutAuthor].join("\n\n"),
      { imageStorageDir, publicApiUrl: "http://localhost:4001", projectId: "owned" }
    );

    expect(prepared).toContain(matter.titlePage);
    expect(prepared).toContain(matter.matterSheet);
    expect(prepared).toContain(matter.aboutAuthor);
    expect(prepared).toContain('<img src="owned/image.png" alt="Cover"');
    expect(prepared).toContain("![Body](owned/image.png)");
    expect(prepared).toContain(unowned);
  });

  it("preserves escaped image syntax in body text", async () => {
    const imageStorageDir = await mkdtemp(join(tmpdir(), "book-pdf-escaped-image-"));
    directories.push(imageStorageDir);
    await mkdir(join(imageStorageDir, "owned"));
    await writeFile(join(imageStorageDir, "owned", "image.png"), "readable image");
    const literal = "\\![literal](http://localhost:4001/assets/images/owned/image.png)";
    const prepared = await prepareMarkdownForPdfDocument(`## Chapter One\n\n${literal}`, {
      imageStorageDir, publicApiUrl: "http://localhost:4001", projectId: "owned"
    });
    expect(prepared).toContain(literal);
  });
});
