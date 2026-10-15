import { describe, expect, it } from "vitest";
import {
  backMatterContentsForProject,
  bookPageMapForProject,
  bookPdfNumberingForProject,
  frontMatterForPrompt,
  furniturePageIntentFromMessage,
  modelPageForReaderContext,
  numberingForProject,
  readerPageNumbering
} from "./bookPageNumbering.js";
import { pageIndexesFromMessage } from "./bookEditMessage.js";
import { bookPdfCoverNumbering } from "@book-maker/core";

const map = {
  version: 2,
  totalPdfPages: 10,
  hasCoverPage: true,
  contentsStartPdfPage: 2,
  pages: [
    { index: 1, startPdfPage: 3, endPdfPage: 4 },
    { index: 2, startPdfPage: 4, endPdfPage: 5 },
    { index: 3, startPdfPage: 6, endPdfPage: 9 }
  ],
  contentRevision: 7
};

describe("front-matter page identity", () => {
  // Rendered from a coverless book: an unnumbered title, a dedication that
  // spans physical sheets 2–3, then prose. The same ranges could describe an
  // illustrated cover followed by a title and a one-sheet dedication.
  const dedicationMap = {
    version: 2 as const,
    totalPdfPages: 4,
    hasCoverPage: true,
    pages: [{ index: 1, startPdfPage: 4, endPdfPage: 4 }],
    contentRevision: 1
  };
  const row = {
    pdfPageMap: dedicationMap,
    contentRevision: 1,
    authorName: null,
    bookMatter: { dedication: Array.from({ length: 100 }, (_, index) => `To ${index}`).join("\n") }
  };
  const pages = [{ id: "page-1", index: 1, title: "One", summary: "", previewText: "A clockmaker walked into the village." }];

  it("keeps the first page ambiguous when a dedication spans several sheets", () => {
    const numbering = numberingForProject(row);
    expect(numbering.frontMatter).toEqual([
      { page: 1, holds: "title_or_matter" },
      { page: 2, holds: "matter_sheet" }
    ]);
    expect(frontMatterForPrompt(numbering)?.[0]).toEqual({
      page: 1,
      holds: "front matter — the title page, or the dedication and publication page"
    });
    const answer = furniturePageIntentFromMessage("delete page 1", pages, numbering)?.assistantMessage;
    expect(answer).toContain("is the book’s front matter");
    expect(answer).toContain("the dedication");
    expect(answer).not.toContain("is the book’s title page");
  });

  it("does not name an old PDF's pages using matter removed during editing", () => {
    const numbering = numberingForProject({
      ...row,
      contentRevision: 2,
      status: "EDITING",
      bookMatter: null
    });
    expect(numbering.frontMatter).toEqual([
      { page: 1, holds: "title_or_matter" },
      { page: 2, holds: "title_or_matter" }
    ]);
  });

  it("keeps unstamped maps neutral because current matter may describe a later edit", () => {
    const { contentRevision: _revision, ...unstamped } = dedicationMap;
    expect(numberingForProject({ ...row, pdfPageMap: unstamped, bookMatter: null }).frontMatter).toEqual([
      { page: 1, holds: "title_or_matter" },
      { page: 2, holds: "title_or_matter" }
    ]);
  });
});

describe("bookPageMapForProject", () => {
  it("uses the stored map only while its revision is the project's", () => {
    expect(bookPageMapForProject({ pdfPageMap: map, contentRevision: 7 })).toBeDefined();
    // A settled project whose map is from another compile must not translate.
    expect(bookPageMapForProject({ pdfPageMap: map, contentRevision: 8 })).toBeUndefined();
    expect(bookPageMapForProject({ pdfPageMap: map, contentRevision: 8, status: "COMPLETE" })).toBeUndefined();
    // A never-edited book is stamped 0; that stamp must gate too.
    const fresh = { ...map, contentRevision: 0 };
    expect(bookPageMapForProject({ pdfPageMap: fresh, contentRevision: 0 })).toBeDefined();
    expect(bookPageMapForProject({ pdfPageMap: fresh, contentRevision: 1 })).toBeUndefined();
    expect(bookPageMapForProject({ pdfPageMap: null, contentRevision: 7 })).toBeUndefined();
    expect(bookPageMapForProject({ pdfPageMap: { junk: true }, contentRevision: 7 })).toBeUndefined();
  });

  it("does not treat a cover-numbering stub as a translatable map", () => {
    const stub = { ...bookPdfCoverNumbering(true), contentRevision: 7 };
    expect(bookPageMapForProject({ pdfPageMap: stub, contentRevision: 7 })).toBeUndefined();
    expect(bookPdfNumberingForProject({ pdfPageMap: stub, contentRevision: 7 })).toEqual({
      version: 2,
      hasCoverPage: true,
      contentRevision: 7
    });
    // Chat stays on model indexes; chrome still learns to skip the cover.
    expect(numberingForProject({ pdfPageMap: stub, contentRevision: 7 }).displayPage(1)).toBe(1);
    expect(bookPdfNumberingForProject({ pdfPageMap: stub, contentRevision: 8, status: "COMPLETE" })).toBeUndefined();
    expect(bookPdfNumberingForProject({ pdfPageMap: stub, contentRevision: 8, status: "EDITING" })).toBeDefined();
  });

  it("still translates through a measured map that came back with no ranges", () => {
    // Only the stub's own marker retires a row from chat. A map whose ranges
    // measured empty is still a true statement about the published file, so it
    // keeps the cover skip and refuses page targets instead of vanishing.
    const rangeless = { ...map, pages: [] as [], backMatterStartPdfPage: 9 };

    expect(bookPageMapForProject({ pdfPageMap: rangeless, contentRevision: 7 })).toMatchObject({
      totalPdfPages: 10,
      backMatterStartPdfPage: 9
    });
    expect(numberingForProject({ pdfPageMap: rangeless, contentRevision: 7 }).displayPage(1)).toBe(1);
  });

  it("keeps a behind map during EDITING so typed page numbers still match the stale PDF", () => {
    const pages = [1, 2, 3].map((index) => ({
      id: `page-${index}`,
      index,
      title: `The ${index} Winds`,
      summary: "",
      previewText: ""
    }));
    // Cover is unnumbered and Contents is printed 1, so model page 1 is on
    // printed 2–3. Without the map, "page 2" would be model index 2.
    const numbering = numberingForProject({ pdfPageMap: map, contentRevision: 8, status: "EDITING" });
    expect(numbering.pdfPageMap).toBeDefined();
    expect(numbering.mapContentRevision).toBe(7);
    expect(pageIndexesFromMessage("rewrite page 2", pages, { pdfPageMap: numbering.pdfPageMap })).toEqual([1]);
    expect(bookPageMapForProject({ pdfPageMap: map, contentRevision: 8, status: "GENERATING" })).toBeUndefined();
  });
});

describe("readerPageNumbering", () => {
  it("shows printed pages with a map and model indexes without", () => {
    const numbering = readerPageNumbering(bookPageMapForProject({ pdfPageMap: map, contentRevision: 7 }));
    expect(numbering.displayPage(1)).toBe(2);
    expect(numbering.displayPages([1])).toEqual([2, 3]);
    // Adjacent model pages share printed page 3; the union dedupes it.
    expect(numbering.displayPages([1, 2])).toEqual([2, 3, 4]);
    // A page the map has never seen keeps its raw index.
    expect(numbering.displayPages([99])).toEqual([99]);

    const fallback = readerPageNumbering(undefined);
    expect(fallback.displayPage(1)).toBe(1);
    expect(fallback.displayPages([2, 1, 2])).toEqual([1, 2]);
  });

  it("names both ends of a model page that prints across two sheets", () => {
    // Model page 1 is printed 2–3, so the number a reader calls it by and the
    // number something lands *after* it on are different sheets. Every "after
    // page N" anchor renders through the end for that reason.
    const numbering = readerPageNumbering(bookPageMapForProject({ pdfPageMap: map, contentRevision: 7 }));
    expect(numbering.displayPage(1)).toBe(2);
    expect(numbering.displayPageEnd(1)).toBe(3);
    // Model page 3 runs 5–8; a single-sheet page has the two ends agree.
    expect(numbering.displayPageEnd(3)).toBe(8);
    expect(numbering.displayPage(2)).toBe(3);
    expect(numbering.displayPageEnd(2)).toBe(4);

    // Both degraded paths stay on the model index, byte for byte.
    expect(numbering.displayPageEnd(99)).toBe(99);
    expect(readerPageNumbering(undefined).displayPageEnd(1)).toBe(1);
  });

  it("separates a page the map cannot place from a book that has no map", () => {
    const numbering = readerPageNumbering(bookPageMapForProject({ pdfPageMap: map, contentRevision: 7 }));
    // The page the map does hold answers the same number either way.
    expect(numbering.printedPageEnd(1)).toBe(3);
    // A page measured from no file — a mid-edit addition — has no printed sheet
    // at all, and `displayPageEnd`'s model index would be read as one.
    expect(numbering.printedPageEnd(99)).toBeUndefined();
    expect(numbering.displayPageEnd(99)).toBe(99);
    // No map in force is not a failure to translate: that book's chat speaks
    // model indexes throughout, so the index is the number it has always given.
    expect(readerPageNumbering(undefined).printedPageEnd(99)).toBe(99);
  });

  it("does not skip the cover on a version-1 map", () => {
    const numbering = readerPageNumbering(
      bookPageMapForProject({ pdfPageMap: { ...map, version: 1 }, contentRevision: 7 })
    );
    // Sheet 2's footer said Page 2; translating it as printed 1 would be a sheet off.
    expect(numbering.displayPage(1)).toBe(3);
    expect(numbering.displayPages([1])).toEqual([3, 4]);
  });
});

describe("furniturePageIntentFromMessage", () => {
  const numbering = readerPageNumbering(bookPageMapForProject({ pdfPageMap: map, contentRevision: 7 }));
  const pages = [1, 2, 3].map((index) => ({
    id: `page-${index}`,
    index,
    title: `The ${index} Winds`,
    summary: "",
    previewText: ""
  }));

  it("answers a contents-page reference instead of leaving it to the whole-book widening", () => {
    const intent = furniturePageIntentFromMessage("fix page 1", pages, numbering);
    expect(intent?.kind).toBe("answer");
    expect(intent?.clarification).toBe("none");
    expect(intent?.assistantMessage).toContain("table of contents");
    expect(intent?.assistantMessage).toContain("pages 2–8");
  });

  it("answers out-of-range references and does not treat the cover as page 1", () => {
    const contents = furniturePageIntentFromMessage("edit page 1", pages, numbering)?.assistantMessage;
    expect(contents).toContain("table of contents");
    // A version-2 cover has no printed number, so no number a reader can speak
    // reaches it: printed 1 is the first *numbered* sheet, which is the Contents.
    expect(contents).not.toContain("cover");
    expect(furniturePageIntentFromMessage("rewrite page 40", pages, numbering)?.assistantMessage).toContain(
      "doesn’t have a printed page 40"
    );
    expect(furniturePageIntentFromMessage("صفحه ۱ را درست کن", pages, numbering)?.assistantMessage).toContain(
      "table of contents"
    );
  });

  it("answers the cover on a version-1 map, whose footer and chrome do call it page 1", () => {
    // Version-1 PDFs counted the cover, so printedPageOffset is 0 and the reader
    // sees "Page 1" on the cover sheet. The cover arm is that book's live path;
    // without it the default would claim the book has no printed page 1.
    const legacy = readerPageNumbering(
      bookPageMapForProject({ pdfPageMap: { ...map, version: 1 }, contentRevision: 7 })
    );
    const cover = furniturePageIntentFromMessage("fix page 1", pages, legacy);
    expect(cover?.kind).toBe("answer");
    expect(cover?.clarification).toBe("none");
    expect(cover?.assistantMessage).toContain("book’s cover");
    // Physical numbering throughout: the story runs on sheets 3–9 and says so.
    expect(cover?.assistantMessage).toContain("pages 3–9");
    // The sheet after it is still the Contents, one number later than on v2.
    expect(furniturePageIntentFromMessage("fix page 2", pages, legacy)?.assistantMessage).toContain(
      "table of contents"
    );
  });

  it("stands aside whenever the message can be routed as content", () => {
    // A number that reaches prose routes normally.
    expect(furniturePageIntentFromMessage("fix page 5", pages, numbering)).toBeNull();
    // A quoted passage can be found regardless of the number.
    expect(furniturePageIntentFromMessage('on page 2, replace "storm" with "gale"', pages, numbering)).toBeNull();
    // No spoken number at all.
    expect(furniturePageIntentFromMessage("make the ending warmer", pages, numbering)).toBeNull();
    // Without a map the numbers are model indexes and route as before.
    expect(furniturePageIntentFromMessage("fix page 2", pages, readerPageNumbering(undefined))).toBeNull();
  });

  it("only exempts quoted words that locate body text from the furniture guard", () => {
    const withProse = pages.map((page) => ({ ...page, previewText: "The storm gathered over the hills." }));
    expect(furniturePageIntentFromMessage('on page 1, make "storm" more dramatic', withProse, numbering)).toBeNull();
    const replacement = furniturePageIntentFromMessage('change page 1 to "A new list"', withProse, numbering);
    expect(replacement?.kind).toBe("answer");
    expect(replacement?.assistantMessage).toContain("table of contents");
  });
});

describe("naming the back matter", () => {
  // Printed 9–10 are the back matter: the map records where it starts, and
  // nothing about what it holds.
  const withBackMatter = { ...map, totalPdfPages: 11, backMatterStartPdfPage: 10 };
  const pages = [1, 2, 3].map((index) => ({
    id: `page-${index}`,
    index,
    title: `The ${index} Winds`,
    summary: "",
    previewText: ""
  }));
  const linked = [{ title: "Sleep research", url: "https://example.com/sleep", summary: "Background." }];
  const book = (fields: { research?: typeof linked; bookMatter?: unknown; category?: string; mediaSettings?: unknown }) =>
    numberingForProject({
      pdfPageMap: withBackMatter,
      contentRevision: 7,
      research: [],
      bookMatter: null,
      category: "HISTORY",
      mediaSettings: {},
      ...fields
    });
  const answer = (numbering: ReturnType<typeof numberingForProject>) =>
    furniturePageIntentFromMessage("fix page 9", pages, numbering)?.assistantMessage ?? "";

  it("calls it the Sources list only when the book prints one", () => {
    const sources = answer(book({ research: linked }));
    expect(sources).toContain("Printed page 9 is the Sources list at the back of the book.");
    expect(sources).toContain("remove the sources list");
    expect(sources).not.toContain("About the Author");
  });

  it("calls it the About the Author page when the bio is all that prints there", () => {
    // 2026-10-06: the bio's page answered "that's the Sources list — say
    // remove the sources list", about a book with no sources at all.
    const bio = answer(book({ bookMatter: { aboutAuthor: "Ana writes about sleep." } }));
    expect(bio).toContain("Printed page 9 is the About the Author page at the back of the book.");
    expect(bio).toContain("Title & credits");
    expect(bio).not.toMatch(/sources/i);
    // Linked sources the book does not print are not printed.
    const unprinted = answer(
      book({ research: linked, mediaSettings: { includeSources: false }, bookMatter: { aboutAuthor: "Ana." } })
    );
    expect(unprinted).toContain("is the About the Author page");
    expect(unprinted).not.toMatch(/sources/i);
  });

  it("names both when both print, since one start cannot say which page is which", () => {
    const both = answer(book({ research: linked, bookMatter: { aboutAuthor: "Ana writes about sleep." } }));
    expect(both).toContain("the Sources list and the About the Author page");
    expect(both).toContain("remove the sources list");
    expect(both).toContain("Title & credits");
  });

  it("names the pages neutrally when it cannot tell what they hold", () => {
    const unknown = answer(readerPageNumbering(bookPageMapForProject({ pdfPageMap: withBackMatter, contentRevision: 7 })));
    expect(unknown).toContain("Printed page 9 is one of the pages at the end of the book");
    expect(unknown).not.toMatch(/sources|about the author/i);
    // The row says neither prints (a stale map mid-edit): still neutral, never Sources.
    expect(answer(book({}))).toContain("one of the pages at the end of the book");
  });

  it("reads what prints the way the compile decides it, and only from a row that was loaded", () => {
    const row = { contentRevision: 7, research: linked, bookMatter: null, mediaSettings: {} };
    expect(backMatterContentsForProject({ ...row, category: "HISTORY" })).toEqual({ sources: true, aboutAuthor: false });
    // A guide prints Sources only when the reader asked for them.
    expect(backMatterContentsForProject({ ...row, category: "BUSINESS" })).toEqual({ sources: false, aboutAuthor: false });
    expect(
      backMatterContentsForProject({ ...row, category: "BUSINESS", mediaSettings: { includeSources: true } })
    ).toEqual({ sources: true, aboutAuthor: false });
    // A source without a link is never printed.
    expect(
      backMatterContentsForProject({ ...row, category: "HISTORY", research: [{ title: "Notes", url: null, summary: "" }] })
    ).toEqual({ sources: false, aboutAuthor: false });
    expect(
      backMatterContentsForProject({ ...row, category: "STORY", research: [], bookMatter: { aboutAuthor: "Ana." } })
    ).toEqual({ sources: false, aboutAuthor: true });
    // A caller that did not load the fields gets no answer, not a wrong one.
    expect(backMatterContentsForProject({ contentRevision: 7 })).toBeUndefined();
    expect(backMatterContentsForProject({ contentRevision: 7, research: linked })).toBeUndefined();
  });
});

describe("modelPageForReaderContext", () => {
  // The map as a publication stamps it: the revision it claimed *and* the
  // sha256 of the exact PDF it measured.
  const publishedMap = { ...map, pdfDigest: "pdf-a" };
  const numbering = readerPageNumbering(bookPageMapForProject({ pdfPageMap: publishedMap, contentRevision: 7 }));
  const openPdfA = { contentRevision: 7, pdfDigest: "pdf-a" };

  it("translates a physical PDF page from the compile the map describes", () => {
    // readerContext.pdfPage is pdfrx's sheet, not the printed footer number.
    expect(modelPageForReaderContext(numbering, { pdfPage: 3, ...openPdfA }, 7)).toBe(1);
    expect(modelPageForReaderContext(numbering, { pdfPage: 5, ...openPdfA }, 7)).toBe(2);
  });

  it("uses the map's stamp, not the project's revision, so EDITING still resolves", () => {
    const editing = numberingForProject({ pdfPageMap: publishedMap, contentRevision: 8, status: "EDITING" });
    // The reader is still holding revision 7; the project has moved on.
    expect(modelPageForReaderContext(editing, { pdfPage: 3, ...openPdfA }, 8)).toBe(1);
    // After publish, a stale cache must not be read through the new map.
    expect(
      modelPageForReaderContext(numbering, { pdfPage: 3, contentRevision: 6, pdfDigest: "pdf-a" }, 7)
    ).toBeUndefined();
  });

  it("refuses a sheet from a PDF the map in force did not measure", () => {
    // A repair republishes the same contentRevision over different bytes and
    // stamps the new map with it, so the revisions agree while the files do
    // not. Sheet 5 of the open file is model page 2 in *that* PDF; translating
    // it through the replacement's map aims the edit at whatever page 5 holds
    // in the other one.
    const repaired = readerPageNumbering(
      bookPageMapForProject({ pdfPageMap: { ...publishedMap, pdfDigest: "pdf-b" }, contentRevision: 7 })
    );
    expect(repaired.mapPdfDigest).toBe("pdf-b");
    expect(modelPageForReaderContext(repaired, { pdfPage: 5, ...openPdfA }, 7)).toBeUndefined();
    // A client that names no file at all is the same refusal, not a fallback.
    expect(modelPageForReaderContext(numbering, { pdfPage: 5, contentRevision: 7 }, 7)).toBeUndefined();
  });

  it("ignores a printed page when there is no map", () => {
    expect(modelPageForReaderContext(readerPageNumbering(undefined), { pdfPage: 3, ...openPdfA }, 7)).toBeUndefined();
  });

  it("refuses a legacy map that identifies no PDF, whatever the revisions say", () => {
    // A map published before the digest existed cannot say which bytes it
    // measured, so nothing here can establish that the reader's sheet came
    // from them. The message's own printed page numbers still route as before.
    const unstamped = {
      version: 2,
      totalPdfPages: 10,
      hasCoverPage: true,
      contentsStartPdfPage: 2,
      pages: map.pages
    };
    const legacy = readerPageNumbering(bookPageMapForProject({ pdfPageMap: unstamped, contentRevision: 7 }));
    expect(legacy.mapContentRevision).toBeUndefined();
    expect(legacy.mapPdfDigest).toBeUndefined();
    expect(modelPageForReaderContext(legacy, { pdfPage: 3, contentRevision: 7 }, 7)).toBeUndefined();
    expect(modelPageForReaderContext(legacy, { pdfPage: 3, ...openPdfA }, 7)).toBeUndefined();
  });

  it("still refuses a stale revision when the digests are the ones that agree", () => {
    // Both halves of the assertion are load-bearing: a stamped map that the
    // reader's declared revision disagrees with is a different publication.
    expect(
      modelPageForReaderContext(numbering, { pdfPage: 3, contentRevision: 6, pdfDigest: "pdf-a" }, 6)
    ).toBeUndefined();
  });
});
