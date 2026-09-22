import { describe, expect, it } from "vitest";
import { cleanOcrText, configurePrimarySourceThrottle, textLooksLikeLanguage, fetchPrimaryText, searchArchive, searchGutenberg, searchPrimarySources, searchWikisource, stripGutenbergBoilerplate, stripWikisourceHeader, throttledFetch } from "./primarySources.js";

configurePrimarySourceThrottle({ intervalMs: 0, backoffMs: 50, retries: 1 });

const responses = new Map<string, unknown>();
const fakeFetch = async (url: string) => {
  for (const [key, value] of responses) {
    if (url.includes(key)) return { status: 200, text: typeof value === "string" ? value : JSON.stringify(value) };
  }
  return { status: 404, text: "" };
};

describe("primarySources", () => {
  it("keeps a direct original paper returned after summaries within the fetch budget", async () => {
    const results = await searchPrimarySources("RSA original paper", { language: "en", limit: 3,
      fetch: async () => ({ status: 404, text: "" }),
      search: async () => [
        { title: "Student summary", url: "https://example.edu/student/summary.html" },
        { title: "Catalogue", url: "https://example.org/catalogue" },
        { title: "Reference", url: "https://example.org/reference" },
        { title: "Original paper", url: "https://example.edu/pubs/RSA78.pdf" },
        { title: "Duplicate", url: "https://example.edu/pubs/RSA78.pdf" }
      ] });
    expect(results).toHaveLength(3);
    expect(results[0]?.url).toBe("https://example.edu/pubs/RSA78.pdf");
  });
  it("searches the three hosts and keeps only public-domain archive items", async () => {
    responses.set("wikisource.org/w/api.php?action=query&list=search", {
      query: { search: [{ title: "The Secret History of the Mongols" }, { title: "Page:Something.djvu/12" }] }
    });
    responses.set("gutendex.com", {
      results: [
        { id: 25717, title: "Decline and Fall, Vol. 1", authors: [{ name: "Gibbon, Edward", birth_year: 1737 }], formats: { "text/plain; charset=utf-8": "https://www.gutenberg.org/ebooks/25717.txt.utf-8" } },
        { id: 1, title: "No text", authors: [], formats: { "text/html": "x" } }
      ]
    });
    responses.set("archive.org/advancedsearch.php", {
      response: {
        docs: [
          { identifier: "old1", title: "Old chronicle", creator: ["Anon"], date: "1858-01-01" },
          { identifier: "new1", title: "Modern chronicle study", creator: "Someone", date: "1998-01-01" },
          { identifier: "cc1", title: "Licensed chronicle", date: "2005", licenseurl: "https://creativecommons.org/publicdomain/zero/1.0/" },
          { identifier: "off", title: "Aristotle", date: "1504" }
        ]
      }
    });
    const wiki = await searchWikisource("secret history", { fetch: fakeFetch, language: "en", limit: 3 });
    expect(wiki.map((c) => c.title)).toEqual(["The Secret History of the Mongols"]);
    const requested: string[] = [];
    const gutenberg = await searchGutenberg("gibbon", { fetch: async (url) => { requested.push(url); return fakeFetch(url); }, language: "en", limit: 3 });
    expect(gutenberg).toHaveLength(1);
    expect(gutenberg[0]!.author).toBe("Gibbon, Edward");
    // The slashed address answers directly; the unslashed one is a 301 that cost a second 10–19 s request.
    expect(requested).toEqual(["https://gutendex.com/books/?search=gibbon&languages=en"]);
    const archive = await searchArchive("chronicle", { fetch: fakeFetch, limit: 3 });
    expect(archive.map((c) => c.title)).toEqual(["Old chronicle", "Licensed chronicle"]);
    const all = await searchPrimarySources("chronicle", { fetch: fakeFetch, language: "en" });
    expect(all.map((c) => c.host)).toEqual(["wikisource", "gutenberg", "archive", "archive"]);
  });

  it("strips Gutenberg boilerplate and reads a Wikisource extract", async () => {
    const gutenbergText = "Header\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\nThe body.\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\nLicence";
    expect(stripGutenbergBoilerplate(gutenbergText).trim()).toBe("The body.");
    responses.set("page=T&prop=text", { parse: { title: "T", text: { "*": "<div><p>Then Tem&#252;jin said:</p><p>Let us go.</p><ul><li><a>T/Chapter 1</a></li></ul></div>" }, links: [{ "*": "T/Chapter 1" }, { "*": "Elsewhere" }] } });
    responses.set("page=T%2FChapter%201", { parse: { title: "T/Chapter 1", text: { "*": "<p>" + "word ".repeat(50) + "</p>" }, links: [] } });
    const text = await fetchPrimaryText(
      { host: "wikisource", title: "T", url: "u", textUrl: "https://en.wikisource.org/w/api.php?action=parse&page=T&prop=text%7Clinks&format=json", author: "", year: "" },
      fakeFetch
    );
    // A short page with subpages is a table of contents: the chapter behind it is what comes back.
    expect(text.startsWith("word word")).toBe(true);
    responses.delete("page=T%2FChapter%201");
    responses.set("page=T&prop=text", { parse: { title: "T", text: { "*": "<p>Then Tem&#252;jin said:</p><p>Let us go.</p>" }, links: [] } });
    expect(await fetchPrimaryText({ host: "wikisource", title: "T", url: "u", textUrl: "https://en.wikisource.org/w/api.php?action=parse&page=T&prop=text%7Clinks&format=json", author: "", year: "" }, fakeFetch)).toBe("Then Temüjin said:\n\nLet us go.");
  });

  it("strips the Wikisource header whether it comes as short blocks or fused onto the first paragraph", () => {
    const fused = "← Wannsee Protocol ( 1942 ) translated by U. S. Government → related portals : Holocaust sister projects : Commons category , Wikidata item The Wannsee Protocol was the record of the meeting, and this sentence carries the paragraph past thirty words so that it is prose and not a header block at all.";
    expect(stripWikisourceHeader(fused).startsWith("The Wannsee Protocol was the record")).toBe(true);
    const blocks = "← Previous chapter\n\nrelated portals : Holocaust\n\nA short first paragraph.\n\nThe rest.";
    expect(stripWikisourceHeader(blocks)).toBe("A short first paragraph.\n\nThe rest.");
    expect(stripWikisourceHeader("Then Temüjin said:\n\nLet us go.")).toBe("Then Temüjin said:\n\nLet us go.");
  });

  it("recognises English text and refuses long-s French OCR", () => {
    const english = "The king and the barons met in the meadow, and the charter was sealed with the seal of the king, which was carried to the abbey by his clerks. ".repeat(4);
    const french = "'Ejpere (amy Lecteur) qu enlifant foigneufèment cet arreft enfemble ces annotations y tu auras occafion de louer la iuftice. ".repeat(6);
    expect(textLooksLikeLanguage(english, "en")).toBe(true);
    expect(textLooksLikeLanguage(french, "en")).toBe(false);
    expect(textLooksLikeLanguage(french, "fr")).toBe(true);
  });

  it("joins OCR line-break hyphens and drops carets", () => {
    expect(cleanOcrText("a literal transla- tion of the ^text")).toBe("a literal translation of the text");
    expect(cleanOcrText("well-known")).toBe("well-known");
  });

  it("waits a bounded time for each catalogue and skips one that keeps timing out", async () => {
    configurePrimarySourceThrottle({ intervalMs: 0, searchTimeoutMs: 40, outageAfterTimeouts: 2, outageSkipMs: 150 });
    let gutendexRequests = 0;
    const events: Array<Record<string, unknown>> = [];
    const slowGutendex = async (url: string) => {
      if (!url.includes("gutendex.com")) return fakeFetch(url);
      gutendexRequests += 1;
      // Gutendex answers in 20–30 s live; here well past the bound, with a book the dossier must never see.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { status: 200, text: JSON.stringify({ results: [{ id: 9, title: "Late book", authors: [], formats: { "text/plain": "https://www.gutenberg.org/ebooks/9.txt" } }] }) };
    };
    const search = () => searchPrimarySources("chronicle", { fetch: slowGutendex, language: "en", log: (event, detail) => events.push({ event, ...detail }) });
    const started = Date.now();
    const first = await search();
    expect(Date.now() - started).toBeLessThan(300);
    expect(first.map((c) => c.host)).toEqual(["wikisource", "archive", "archive"]);
    expect(events[0]).toMatchObject({ event: "search", query: "chronicle", hosts: {
      wikisource: { outcome: "answered", candidates: 1 }, gutenberg: { outcome: "timed_out", candidates: 0 }, archive: { outcome: "answered", candidates: 2 }
    } });
    // The second timeout opens the outage; the third search does not ask at all.
    await search();
    await search();
    expect(gutendexRequests).toBe(2);
    expect(events[2]).toMatchObject({ hosts: { gutenberg: { outcome: "skipped", ms: 0 } } });
    // Once the outage has lapsed the catalogue is asked again, and an answer within the bound closes it.
    await new Promise((resolve) => setTimeout(resolve, 160));
    const fastGutendex = async (url: string) => url.includes("gutendex.com") ? fakeFetch(url) : slowGutendex(url);
    const recovered = await searchPrimarySources("chronicle", { fetch: fastGutendex, language: "en", log: (event, detail) => events.push({ event, ...detail }) });
    expect(recovered.map((c) => c.host)).toEqual(["wikisource", "gutenberg", "archive", "archive"]);
    expect(events.at(-1)).toMatchObject({ hosts: { gutenberg: { outcome: "answered", candidates: 1 } } });
    configurePrimarySourceThrottle({ intervalMs: 0, backoffMs: 50, retries: 1, searchTimeoutMs: 10_000, outageAfterTimeouts: 2, outageSkipMs: 5 * 60_000 });
  });

  it("serialises requests per host and retries after a 429", async () => {
    const calls: number[] = [];
    let first = true;
    const fetchImpl = async (url: string) => {
      calls.push(Date.now());
      if (url.includes("limited") && first) {
        first = false;
        return { status: 429, text: "" };
      }
      return { status: 200, text: "ok" };
    };
    const started = Date.now();
    const [a, b] = await Promise.all([throttledFetch(fetchImpl, "https://en.wikisource.org/limited"), throttledFetch(fetchImpl, "https://en.wikisource.org/second")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});

it("retrieves public archive OCR when its filename differs from the item identifier", async () => {
  const calls: string[] = [];
  const text = await fetchPrimaryText({ host: "archive", title: "The Casement Report", author: "Roger Casement", year: "1904", url: "https://archive.org/details/the-casement-report", textUrl: "https://archive.org/download/the-casement-report/the-casement-report_djvu.txt" }, async (url) => {
    calls.push(url);
    if (url === "https://archive.org/metadata/the-casement-report") return { status: 200, text: JSON.stringify({ files: [{ name: "caesement report_djvu.txt", format: "DjVuTXT" }] }) };
    if (url === "https://archive.org/download/the-casement-report/caesement%20report_djvu.txt") return { status: 200, text: "The commissioner recorded the testimony." };
    return { status: 404, text: "" };
  });
  expect(text).toBe("The commissioner recorded the testimony.");
  expect(calls).toContain("https://archive.org/metadata/the-casement-report");
});

it("keeps unavailable archive items empty and never treats private files or metadata as source prose", async () => {
  for (const metadata of [
    { files: [] },
    { files: [{ name: "private_djvu.txt", format: "DjVuTXT", private: true }] },
    { is_dark: true, files: [{ name: "hidden_djvu.txt", format: "DjVuTXT" }] }
  ]) {
    const urls: string[] = [];
    const text = await fetchPrimaryText({ host: "archive", title: "Unavailable", author: "", year: "1904", url: "https://archive.org/details/item", textUrl: "https://archive.org/download/item/item_djvu.txt" }, async (url) => {
      urls.push(url);
      return url.includes("/metadata/") ? { status: 200, text: JSON.stringify(metadata) } : { status: 404, text: "" };
    });
    expect(text).toBe("");
    expect(urls).toHaveLength(2);
  }
});
