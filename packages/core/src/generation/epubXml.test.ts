import JSZip from "jszip";
import { afterAll, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { closeSharedBrowser, withRenderPage } from "./browserPool.js";
import { generateBookEpub } from "./epub.js";
import { compileBookMarkdownWithPageAnchors } from "./markdown.js";

afterAll(closeSharedBrowser);

const plan = makeFallbackPlan({
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
});

/** Every XML document of the archive, by name. */
async function xmlDocuments(epub: Buffer): Promise<Array<{ name: string; source: string }>> {
  const zip = await JSZip.loadAsync(epub);
  return Promise.all(
    Object.keys(zip.files)
      .filter((name) => /\.(?:xhtml|opf|ncx|xml)$/.test(name))
      .map(async (name) => ({ name, source: await zip.file(name)!.async("string") }))
  );
}

/** Each document through the browser's XML parser, which refuses what a reading system refuses. */
async function parseStrictly(documents: Array<{ name: string; source: string }>) {
  return withRenderPage((page) =>
    page.evaluate(
      (sources) =>
        sources.map(({ name, source }) => {
          const document = new DOMParser().parseFromString(source, name.endsWith(".xhtml") ? "application/xhtml+xml" : "application/xml");
          return {
            name,
            error: document.querySelector("parsererror")?.textContent ?? null,
            text: document.documentElement.textContent ?? "",
            code: [...document.querySelectorAll("code")].map((code) => code.textContent ?? "")
          };
        }),
      documents
    )
  );
}

it("writes well-formed XHTML when bibliography URLs have query separators", async () => {
  const url = "https://www.open.edu/openlearn/mod/oucontent/view.php?id=48322&section=1.3";
  const zip = await JSZip.loadAsync(await generateBookEpub([
    "# Sources", `[Open University](${url})`,
    '<p>R&amp;D costs &#163;5&nbsp;&amp;&nbsp;&#x20AC;6. A & B.</p>'
  ].join("\n\n"), { title: "Sources", imageStorageDir: "/tmp", publicApiUrl: "http://localhost:4001" }));
  const xhtml = await zip.file("OEBPS/chapter-1.xhtml")!.async("string");
  await withRenderPage(async (page) => {
    const parsed = await page.evaluate((source) => {
      const document = new DOMParser().parseFromString(source, "application/xhtml+xml");
      return { error: document.querySelector("parsererror")?.textContent, href: document.querySelector("a")?.getAttribute("href"), text: document.documentElement.textContent };
    }, xhtml);
    expect(parsed.error).toBeUndefined();
    expect(parsed.href).toBe(url);
    expect(parsed.text).toContain("R&D costs £5\u00a0&\u00a0€6. A & B.");
  });
}, 30_000);

it("writes well-formed XML when the matter and the pages carry characters XML 1.0 forbids", async () => {
  // A dedication pasted from Word carries U+000B for every Shift+Enter. Written
  // past the schema's cleaning — or typed into a page, which has none — it
  // reached the chapter XHTML verbatim and no reader would open the file.
  const { markdown } = compileBookMarkdownWithPageAnchors({
    plan: { ...plan, title: "The\u000bClock\u0001maker" },
    authorName: "Ada\u0001",
    pages: [{ index: 1, title: "One", markdown: "The first\u000b page\u0001 of\uFFFE the\uD800 book." }],
    matter: {
      year: 2026,
      madeWithCredit: false,
      dedication: "For Mom,\u000bwho taught me\u0001 to read\uFFFE.\uD800",
      aboutAuthor: "Ada writes\u000b books\u0001.\uFFFF",
      imprint: "Clockwork\u0001 Press"
    }
  });
  const documents = await xmlDocuments(
    await generateBookEpub(markdown, {
      title: "The\u000bClockmaker",
      author: "Ada\u0001",
      language: "en",
      imageStorageDir: "/tmp",
      publicApiUrl: "http://localhost:4001"
    })
  );
  expect(documents.map(({ name }) => name)).toContain("OEBPS/chapter-1.xhtml");
  const parsed = await parseStrictly(documents);
  expect(parsed.filter(({ error }) => error !== null)).toEqual([]);
  const text = parsed.map((document) => document.text).join("\n");
  expect(text).toContain("For Mom,who taught me to read.");
  expect(text).toContain("Ada writes books.");
  expect(text).toContain("The first page of the book.");
  expect(text).toContain("Clockwork Press");
}, 30_000);

it("writes well-formed XML when page text spells a forbidden character as a numeric reference", async () => {
  // marked passes `&#11;` through as an entity and `toXhtml` keeps every
  // numeric reference, so the chapter carried a reference XML refuses exactly
  // as it refuses the raw U+000B. A code block shows the same spelling as
  // text — marked writes its ampersand as `&amp;` — and must print it.
  const { markdown } = compileBookMarkdownWithPageAnchors({
    plan,
    pages: [
      {
        index: 1,
        title: "One",
        markdown: [
          "Vertical &#11;tab, hex &#x0b;tab, upper &#x0B;tab, padded &#0000011;tab, null &#0;here.",
          "Nonchar &#xFFFE;gone, surrogate &#xD800;gone, &#56320;gone, past the end &#x110000;gone, &#9999999;gone.",
          // XML has no `&#X`: toXhtml escapes it, so it prints as typed.
          "Capital &#X0B;X.",
          '<p title="caf&#233;&#11;&#99999999999999999999;">Raw &#x1F600;&#x0b; html.</p>',
          "Kept: caf&#233; &#x1F600; &#xe9; &#0233; &#160; &#9;.",
          "```\nshow &#11; and &#xFFFE; literally\n```",
          "Inline `&#xD800;` too."
        ].join("\n\n")
      }
    ]
  });
  const documents = await xmlDocuments(
    await generateBookEpub(markdown, { title: "References", language: "en", imageStorageDir: "/tmp", publicApiUrl: "http://localhost:4001" })
  );
  const parsed = await parseStrictly(documents);
  expect(parsed.filter(({ error }) => error !== null)).toEqual([]);
  const source = documents.map((document) => document.source).join("\n");
  // Every reference to an allowed code point goes through byte for byte.
  expect(source).toContain("Kept: caf&#233; &#x1F600; &#xe9; &#0233; &#160; &#9;.");
  expect(source).toContain('title="caf&#233;"');
  expect(source).toContain("Raw &#x1F600; html.");
  const text = parsed.map((document) => document.text).join("\n");
  expect(text).toContain("Vertical tab, hex tab, upper tab, padded tab, null here.");
  expect(text).toContain("Nonchar gone, surrogate gone, gone, past the end gone, gone.");
  expect(text).toContain("Capital &#X0B;X.");
  expect(text).toContain("Kept: café 😀 é é \u00a0 \t.");
  expect(parsed.flatMap((document) => document.code)).toEqual(["show &#11; and &#xFFFE; literally\n", "&#xD800;"]);
}, 30_000);
