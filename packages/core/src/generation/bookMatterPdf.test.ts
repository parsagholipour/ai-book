import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { bookMatterSheetCount, type BookMatterForCompile } from "./bookMatterPages.js";
import { closeSharedBrowser } from "./browserPool.js";
import { compileBookMarkdownWithPageAnchors } from "./markdown.js";
import { generateBookPdf, generateBookPdfWithPageMap } from "./pdf.js";

afterAll(async () => {
  // A live browser holds the event loop open; without this vitest never exits.
  await closeSharedBrowser();
});

function hasCommand(command: string): boolean {
  try {
    execFileSync(command, ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const itIfPdfTools = hasCommand("pdfinfo") && hasCommand("pdftotext") ? it : it.skip;

const plan = (title = "The Clockmaker", subtitle = "A patient trade") => ({
  ...makeFallbackPlan({
    prompt: "A story about a careful clockmaker.",
    category: "STORY",
    targetPages: 1,
    complexity: 5,
    temperature: 0.8,
    language: "en",
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven",
      includeCover: false,
      coverTemplate: "auto",
      finalReview: true,
      toneProfile: "neutral" as const
    }
  }),
  title,
  subtitle
});

describe("the matter pages in the PDF", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function scratch(): Promise<string> {
    const dir = join(tmpdir(), `book-matter-pdf-${randomUUID()}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function sheets(markdown: string, dir: string): Promise<number> {
    const outputPath = join(dir, `${randomUUID()}.pdf`);
    await generateBookPdf(markdown, { imageStorageDir: dir, publicApiUrl: "http://localhost:4001", outputPath });
    return Number(/^Pages:\s+(\d+)$/m.exec(execFileSync("pdfinfo", [outputPath], { encoding: "utf8" }))?.[1]);
  }

  itIfPdfTools(
    "prints the publication lines whole under a title the clip has to cut",
    async () => {
      // The © line, the rights line, the publisher, the ISBN and the credit sit at the
      // title page's foot. The title stack clips its own tail, never the foot: a clipped
      // © line is a book with no © line.
      const dir = await scratch();
      const outputPath = join(dir, "book.pdf");
      const { markdown } = compileBookMarkdownWithPageAnchors({
        plan: plan(Array.from({ length: 60 }, (_, index) => `Interminable Title Clause ${index + 1}`).join(", ")),
        pages: [{ index: 1, title: "One", markdown: "First page of the story." }],
        authorName: "Ada Lovelace",
        matter: {
          year: 2026,
          madeWithCredit: true,
          copyrightHolder: "The Estate of Ada Augusta King, Countess of Lovelace, and the Trustees of the Analytical Engine Society",
          allRightsReserved: true,
          imprint: "Lantern & Lathe Press, an imprint of the Society for the Diffusion of Useful Knowledge",
          isbn: "978-0-306-40615-7"
        }
      });
      expect(markdown).not.toContain("book-matter-sheet");
      await generateBookPdf(markdown, { imageStorageDir: dir, publicApiUrl: "http://localhost:4001", outputPath });

      const page = (n: number) => execFileSync("pdftotext", ["-f", String(n), "-l", String(n), outputPath, "-"], { encoding: "utf8" });
      const titlePage = page(1).replace(/\s+/g, " ");
      expect(titlePage).toContain("Interminable Title Clause 1,");
      expect(titlePage).toContain("© 2026 The Estate of Ada Augusta King");
      expect(titlePage).toContain("All rights reserved.");
      expect(titlePage).toContain("ISBN 978-0-306-40615-7");
      expect(titlePage).toContain("Made with Tomeza");
      expect(titlePage).not.toMatch(/\bPage\s+\d+\b/);
      expect(page(2)).toContain("First page of the story.");
      expect(page(2)).toMatch(/\bPage\s+1\b/);
    },
    30_000
  );

  itIfPdfTools(
    "prints exactly the sheets bookMatterSheetCount counts, for a dedication of any length",
    async () => {
      const dir = await scratch();
      const prose = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ".repeat(25).slice(0, 2000);
      const dedications = [
        "For Sara,\nwho asked for a dragon.",
        prose,
        prose.toUpperCase(),
        Array.from({ length: 100 }, (_, line) => `For the one at ${line}`).join("\n"),
        // Read per code point at half an em, this was set at the house size and printed a sheet more.
        "🎉".repeat(1000),
        "For Sara 🐉 who asked for a dragon 🐲✨ and got three 🎉🎉🎉. ".repeat(33).trim(),
        // Read with an ideographic space at an ordinary space's 0.28em, each of these was set a size
        // too large and printed two sheets counted as one.
        Array.from("献给我的母亲，她教会了我耐心和勇气。".repeat(70))
          .map((character, index) => (index % 3 === 2 ? `${character}\u3000` : character))
          .join("")
          .slice(0, 1200),
        Array.from({ length: 32 }, () => Array.from("献给我的母亲她教会了我耐心和勇气献给我").join("\u3000\u3000")).join("\n")
      ];
      for (const dedication of dedications) {
        const matter: BookMatterForCompile = {
          year: 2026,
          madeWithCredit: true,
          dedication,
          copyrightHolder: "Ada Lovelace",
          allRightsReserved: true,
          imprint: "Analytical Press",
          isbn: "978-0-00-000000-0"
        };
        const { markdown } = compileBookMarkdownWithPageAnchors({
          plan: plan(),
          pages: [{ index: 1, title: "One", markdown: "The first page." }],
          matter
        });
        const start = markdown.indexOf('<section class="book-matter-sheet');
        const without = markdown.slice(0, start) + markdown.slice(markdown.indexOf("</section>", start) + "</section>".length);
        const printed = (await sheets(markdown, dir)) - (await sheets(without, dir));
        expect(printed, dedication.slice(0, 24)).toBe(bookMatterSheetCount(markdown) - bookMatterSheetCount(without));
      }
    },
    60_000
  );

  itIfPdfTools(
    "prints exactly the sheets bookMatterSheetCount counts, for a biography of any length",
    async () => {
      const dir = await scratch();
      const short = (count: number) => Array.from({ length: count }, (_, index) => `A short paragraph ${index}.`).join("\n\n");
      const biographies = [
        "Ada Lovelace writes about engines and the people who would rather they stayed quiet. ".repeat(17).trim(),
        short(30),
        short(60),
        Array.from({ length: 200 }, (_, index) => (index % 3 ? "word" : "Engines")).join("\n"),
        Array.from({ length: 150 }, (_, index) => ["😀 🐉", "❤️ 🇮🇷", "👨‍👩‍👧 1️⃣"][index % 3]).join("\n")
      ];
      const book = (aboutAuthor?: string) =>
        compileBookMarkdownWithPageAnchors({
          plan: plan(),
          pages: [{ index: 1, title: "One", markdown: "The first page." }],
          authorName: "Ada Lovelace",
          matter: { year: 2026, madeWithCredit: false, ...(aboutAuthor ? { aboutAuthor, authorWebsite: "ada.example" } : {}) }
        }).markdown;
      const without = book();
      const base = await sheets(without, dir);
      for (const biography of biographies) {
        const markdown = book(biography);
        const counted = bookMatterSheetCount(markdown) - bookMatterSheetCount(without);
        expect((await sheets(markdown, dir)) - base, biography.slice(0, 24)).toBe(counted);
      }
    },
    60_000
  );

  itIfPdfTools(
    "fits a book's text the same with and without a biography that runs on",
    async () => {
      const dir = await scratch();
      const lorem = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ".repeat(4).trim();
      const book = (aboutAuthor?: string) =>
        compileBookMarkdownWithPageAnchors({
          plan: plan(),
          pages: Array.from({ length: 6 }, (_, index) => ({ index: index + 1, title: `P${index + 1}`, markdown: [lorem, lorem, lorem, lorem].join("\n\n") })),
          authorName: "Ada Lovelace",
          matter: { year: 2026, madeWithCredit: false, ...(aboutAuthor ? { aboutAuthor } : {}) }
        }).markdown;
      // Counted as one sheet in the body's type, a biography like this shrank a six-page book's
      // text to pay for the sheets it really printed.
      const biography = Array.from({ length: 60 }, (_, index) => `A short paragraph ${index}.`).join("\n\n");
      const fit = async (markdown: string, targetPageCount: number) =>
        (await generateBookPdfWithPageMap(markdown, { imageStorageDir: dir, publicApiUrl: "http://localhost:4001", targetPageCount })).pagination;
      const adjustments: number[] = [];
      for (const target of [5, 4]) {
        const plain = await fit(book(), target);
        const withBio = await fit(book(biography), target);
        expect(withBio?.adjustment, `target ${target}`).toBe(plain?.adjustment);
        expect(withBio?.matched, `target ${target}`).toBe(plain?.matched);
        adjustments.push(plain?.adjustment ?? Number.NaN);
      }
      // One book whose text fits its target as set, one the fitter has to compress.
      expect(adjustments[0]).toBe(0);
      expect(adjustments[1]).toBeGreaterThan(0);
    },
    60_000
  );

  itIfPdfTools(
    "gives a coverless book's new title sheet its own room instead of the text's",
    async () => {
      const dir = await scratch();
      const { markdown } = compileBookMarkdownWithPageAnchors({
        plan: plan(),
        pages: [{ index: 1, title: "One", markdown: "The first page." }]
      });
      // One page of text paid for: counted inside it, the title sheet left the fitter shrinking the
      // type toward a one-sheet file it could never reach.
      const { pagination } = await generateBookPdfWithPageMap(markdown, {
        imageStorageDir: dir,
        publicApiUrl: "http://localhost:4001",
        targetPageCount: 1
      });
      expect(pagination).toMatchObject({ targetPages: 2, actualPages: 2, adjustment: 0, matched: true });
    },
    30_000
  );

  itIfPdfTools(
    "prints a reader's dollar signs and backslashes as text, and only the book's own math as math",
    async () => {
      const dir = await scratch();
      const { markdown } = compileBookMarkdownWithPageAnchors({
        plan: plan(String.raw`Proofs $t$ and \(tt\)`, "On $s$"),
        pages: [{ index: 1, title: "One", markdown: "Real math: $a^2$." }],
        authorName: String.raw`Pen $x$ Name \(pp\)`,
        matter: {
          year: 2026,
          madeWithCredit: false,
          dedication: String.raw`For \(dd\) and $d$ [sq]`,
          imprint: String.raw`Imprint $i$ \(ii\)`,
          aboutAuthor: String.raw`Ada (born 1815) wrote \(y\) and $b$ and [sic] and \[z\].`,
          authorWebsite: "site.example/$w$/(v)"
        }
      });
      const outputPath = join(dir, "book.pdf");
      await generateBookPdf(markdown, { imageStorageDir: dir, publicApiUrl: "http://localhost:4001", outputPath });
      const text = execFileSync("pdftotext", [outputPath, "-"], { encoding: "utf8" });
      for (const literal of [
        String.raw`Proofs $t$ and \(tt\)`,
        "On $s$",
        String.raw`by Pen $x$ Name \(pp\)`,
        String.raw`For \(dd\) and $d$ [sq]`,
        String.raw`Imprint $i$ \(ii\)`,
        String.raw`Ada (born 1815) wrote \(y\) and $b$ and [sic] and \[z\].`,
        "site.example/$w$/(v)"
      ]) {
        expect(text).toContain(literal);
      }
      expect(text).not.toContain("$a^2$");
    },
    30_000
  );
});
