import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { classifyWithDegradedHeuristics } from "./bookEditHeuristics.js";
import { classifyProjectChatMessage } from "./bookEditIntent.js";
import {
  asksToRemoveTitlePage,
  bookMatterForRouter,
  isTitlePageRemoval,
  isWholeBookTitleRename,
  mentionsBookMatter
} from "./bookEditMatter.js";
import { decideActionSchema, routerSystemPrompt } from "./bookEditRouterPrompt.js";
import { numberingForProject } from "./bookPageNumbering.js";
import {
  chapters,
  fakeDecideModel,
  fakeFailingTextModel,
  manyPages,
  pages,
  type DecideArgs
} from "./testing/bookEditIntentFixtures.js";

/**
 * A book's matter pages in the chat — the byline, the dedication, About the
 * Author, the website, the © holder, the publisher, the ISBN, "All rights
 * reserved" — are one free `book_matter` intent. The router decides it with the
 * book's matter in view; the model-free detector only says *whether* when the
 * router is down. Neither writes the words: that is the composer's, at apply
 * time (`mobile/bookMatterChatEdits.test.ts`).
 */

/** Every request the reviewer showed being garbled or priced, and the rest of the matter pages. */
const MATTER_REQUESTS = [
  "change the dedication to mention my sister too",
  "dedicate it to my mom and redo the cover",
  "replace the dedication with a poem",
  "Dedicate it to my mom. Also, make page 2 shorter",
  "remove my ex's name from the dedication",
  "cut the dedication down to one line",
  "remove the About the Author page",
  "remove all rights reserved",
  "add an ISBN 978-0-306-40615-7",
  "change the publisher to Lantern Press",
  "change the author name to Sam Lee",
  "Dedicate this book to my mother",
  "I want the book dedicated to my dad",
  "add a dedication: For my sources of strength, Mom and Dad",
  "remove the dedication",
  "use my pen name, S. Lee",
  "update my author bio: I teach chemistry in Ohio",
  "change the copyright holder to Lantern Press LLC",
  "can you add my ISBN?",
  "remove the title page",
  "add my website sam.dev to the About the Author page",
  "add a dedication: For my mom",
  "change the publisher to Lantern",
  "set the ISBN to 978-0-306-40615-7",
  // A page named in another sentence, or beside words only the matter has.
  "Change the publisher to Lantern. Also, make page 2 shorter",
  "Make page 2 warmer. Dedication: For Mom",
  "Set the ISBN on page 2 to 978-0-306-40615-7",
  // Review finding 7: a page named in another request of the same sentence.
  "Change the publisher to Lantern and make page 2 shorter",
  "Change the publisher to Lantern, make page 2 shorter",
  "Make page 2 shorter and change the publisher to Lantern",
  "Change the publisher to Lantern and page 2 should be shorter",
  "Change my pen name to Sam Lee, then rewrite page 3"
];

const LOCALIZED_MATTER_REQUESTS = [
  "Rewrite the dedicatoria for my mother throughout the book",
  "Remove la biografía del autor",
  "Add a dedicatoria: Para mi madre",
  "Could you please update la biografía del autor?",
  "Change the ناشر to لانترن",
  "تقدیم‌نامه را به مادرم تقدیم کن",
  "Añade una dedicatoria para mi madre",
  "著者紹介を短くして"
];

/**
 * Review finding 7: a page named by its number makes the matter's vocabulary
 * page content in that sentence, and with the router down these were matter
 * edits that failed ("couldn't change that right now").
 */
const PAGE_CONTENT_REQUESTS = [
  "Rewrite page 4 so the publisher sounds meaner",
  "Rewrite page 4 to mention the dedication scene",
  "On page 4, make the imprint's owner kinder",
  "Rewrite pages 3–5 so the publisher is kinder",
  "rewrite the fourth page so the author's name is spelled the way the narrator says it",
  "Rewrite page 4 so it talks about the author's childhood",
  "Rewrite page 4 to mention my website",
  "Rewrite page 4 so the copyright holder's rights are clearer",
  "Rewrite página 4 so the ناشر sounds meaner",
  "Rewrite page 4 to discuss la biografía del autor",
  "delete page 4 — the title page is enough",
  // One request each, though a comma or an "and" sits inside it.
  "Rewrite page 4, so the publisher sounds meaner",
  "Rewrite page 4 so the hero, not the publisher, wins",
  "Make the hero and the publisher kinder on page 4",
  "In pages 3–5, make the publisher kinder"
];

describe("the model-free matter detector", () => {
  it.each(MATTER_REQUESTS)("reads %j as a matter request", (message) => {
    expect(mentionsBookMatter(message)).toBe(true);
  });

  it.each(LOCALIZED_MATTER_REQUESTS)("reads localized %j as a matter request", (message) => {
    expect(mentionsBookMatter(message)).toBe(true);
  });

  it.each([
    "What does la dedicatoria say?",
    "¿Qué dice la dedicatoria?",
    "تقدیم‌نامه برای کیست؟",
    "著者紹介には何が書かれていますか？",
    "Rewrite page 4 so the ناشر sounds meaner",
    "Rewrite página 4 so the ناشر sounds meaner",
    "صفحه ۴ را طوری بازنویسی کن که ناشر مهربان‌تر باشد",
    "Rewrite page 4 to discuss la biografía del autor",
    "Rewrite the scene so the ناشر sounds meaner",
    "Make the ناشر in chapter 2 meaner",
    "Make the publisher kinder in capítulo 2",
    "Write a chapter about la biografía del autor",
    "Add a dedicatoria scene where the knights pledge their swords",
    "Write a page about la dedicatoria"
  ])("leaves localized prose or question %j alone", (message) => {
    expect(mentionsBookMatter(message)).toBe(false);
  });

  it.each([
    // Review finding 9: bare "dedicated" is a character's, not the book's.
    "make the hero more dedicated to her training",
    "show how dedicated the team is in chapter 4",
    // Dedicating part of the book is content.
    "dedicate a chapter to my grandmother",
    "dedicate page 3 to the volunteers",
    // A dedication *in* the story.
    "add a dedication scene where the knights pledge their swords",
    "rewrite page 4 so the dedication ceremony is shorter",
    "add a page about the dedication of the new temple",
    "make her dedication to music clearer",
    "write a page about a dedication",
    // Questions change nothing.
    "who is the book dedicated to?",
    "what does the dedication say?",
    "does it have an ISBN?",
    // Publishing inside the story.
    "make the publisher in chapter 2 meaner",
    // Nothing about the matter at all.
    "make page 3 funnier",
    "rename the book to Dinner, Sorted",
    ...PAGE_CONTENT_REQUESTS
  ])("leaves %j alone", (message) => {
    expect(mentionsBookMatter(message)).toBe(false);
  });

  it("lets a rename whose title holds a matter word past the guard, and not one that also changes the matter", () => {
    for (const message of [
      "Rename the book to 'The Dedication'",
      "Rename the book to Letters to My Publisher",
      "Change the title to The ISBN Mystery",
      "Change the title to The Dedication: A Novel",
      "Change the title to “Love, Loss and the Publisher”"
    ]) {
      expect(mentionsBookMatter(message), message).toBe(true);
      expect(isWholeBookTitleRename(message), message).toBe(true);
    }
    for (const message of [
      "rename the book to Moonrise and add a dedication to my mom",
      "change the title to Moonrise and the dedication to my mom",
      "Change the title to 'Moonrise' and the dedication to 'For Mom'",
      "Change the title to Moonrise. Dedication: For Mom",
      "Change the title to Moonrise, and put my pen name as Sam",
      // Unquoted, a break inside the title is where a second request would start.
      "Change the title to Love, Loss and the Publisher",
      "add a dedication: For my mom"
    ]) {
      expect(isWholeBookTitleRename(message), message).toBe(false);
    }
  });
});

describe("a title page removal", () => {
  it.each([
    "remove the title page",
    "Can you delete the title page from my book?",
    "delete the title page from my book",
    "I don't want a title page",
    "get rid of the title page please",
    "remove this book's title page entirely",
    "take the title page out",
    "No title page, please",
    "make it without a title page",
    "remove the title page\n\nFollow-up from the user: yes, the whole page"
  ])("is %j", (message) => {
    expect(isTitlePageRemoval(message)).toBe(true);
  });

  it.each([
    "change the title page author name to Sam",
    "remove the title page and add a dedication to my mom",
    "remove page 1",
    // Something taken *from* the title page is a matter edit for the composer.
    "remove my name from the title page",
    "take my name off the title page",
    "remove the subtitle from the title page",
    "delete page 2 — the title page is enough",
    "I don't want my name on the title page",
    "I don't want the title page to show my name",
    "remove the title page's subtitle",
    // A refusal, a report, and a request that also changes another matter page.
    "please don't remove the title page",
    "there's no title page in the PDF",
    "change the dedication to my mom and remove the title page",
    "remove the title page and the dedication",
    // Review finding 3: a byline in the composer's bare-"author" phrasings is
    // a change for the composer, never a bare removal answered by asking for
    // the name the reader just gave.
    "change the author to Sam and drop the title page",
    "Author: Sam Lee. Remove the title page.",
    "use Sam Lee as the author and remove the title page",
    // A negation waits for its verb across words that are not one.
    "Please don't, under any circumstances, remove the title page"
  ])("is not %j", (message) => {
    expect(isTitlePageRemoval(message)).toBe(false);
  });
});

describe("a title page removal inside a compound message", () => {
  it.each([
    "remove the title page and change the author name to Sam",
    "Drop the title page, dedicate it to my mom and redo the cover",
    "change the author to Sam and drop the title page",
    "Author: Sam Lee. Remove the title page.",
    "use Sam Lee as the author and remove the title page",
    "don't change the dedication, remove the title page",
    "Don't change the dedication, but remove the title page",
    // A clause with no verb of its own shares the removal before it (review finding 9).
    "Remove the dedication and the title page",
    "Remove the dedication, the subtitle and the title page",
    "make it without the dedication and the title page"
  ])("asks for it in %j", (message) => {
    expect(asksToRemoveTitlePage(message)).toBe(true);
  });

  it.each([
    // A negation split off by a comma still governs the verb it was waiting for (review finding 9).
    "Please don't, under any circumstances, remove the title page, and change the author to Sam",
    "Never, ever drop the title page; just change the author to Sam",
    "don't remove the title page, just change the author name to Sam",
    "Please don't remove the dedication and the title page",
    // A list of places something is taken from, not of things to take out.
    "remove my name from the dedication and the title page",
    "remove my name from the title page and add a dedication: For Mom",
    "delete the title page logo and change the author name to Sam",
    "Remove the dedication and the title page should stay",
    "change the author name to Sam"
  ])("does not ask for it in %j", (message) => {
    expect(asksToRemoveTitlePage(message)).toBe(false);
  });
});

const matterRouterArgs: DecideArgs = {
  action: "propose_edit",
  confidence: 0.92,
  reasoning: "The reader wants the book's matter changed.",
  assistantMessage: "I’ll change that on the title and credits pages.",
  clarification: "none",
  pageIndexes: [],
  chapterIndex: null,
  targetLanguage: null,
  editTarget: "book_matter"
};
const matterRouter = (overrides: Partial<DecideArgs> = {}) => fakeDecideModel({ ...matterRouterArgs, ...overrides });

/** A router that would quote a whole-book rewrite if it were asked. */
const rewriteRouter = () =>
  fakeDecideModel({
    action: "propose_edit",
    confidence: 0.95,
    reasoning: "Rewrite.",
    assistantMessage: "I’ll rewrite the book.",
    clarification: "none",
    pageIndexes: [],
    chapterIndex: null,
    targetLanguage: null,
    editTarget: "whole_book",
    editStyle: "rewrite"
  });

describe("a matter request in the finished-book chat", () => {
  it("is routed by the router, which is shown what the book's matter prints now", async () => {
    const model = matterRouter();
    const bookMatter = bookMatterForRouter({
      authorName: "Ana Ruiz",
      bookMatter: { dedication: "For Mom, Dad and Alex", isbn: "978-0-306-40615-7" },
      mediaSettings: {}
    });
    const intent = await classifyProjectChatMessage({
      message: "remove my ex's name from the dedication",
      stage: "complete",
      pages,
      chapters,
      textModel: model,
      bookMatter
    });
    expect(intent).toMatchObject({ kind: "book_matter", scope: "none", affectedPageIndexes: [], clarification: "none" });
    // The router chooses *that*; it is never asked for the words.
    expect(intent).not.toHaveProperty("dedication");
    const call = vi.mocked(model.generateWithTools).mock.calls[0]![0];
    // The model-free reading rides along as the router's hint.
    expect(JSON.parse(call.messages.at(-1)!.content).heuristicIntent.kind).toBe("book_matter");
    expect(JSON.parse(call.messages.at(-1)!.content).bookMatter).toEqual({
      authorName: "Ana Ruiz",
      dedication: "For Mom, Dad and Alex",
      isbn: "978-0-306-40615-7",
      allRightsReserved: false
    });
  });

  it("is never read by a fast path that would garble it", async () => {
    for (const message of [
      // The Sources recogniser saw "sources"; the exact-replacement parser saw "replace X with Y".
      "add a dedication: For my sources of strength, Mom and Dad",
      "replace the dedication with a poem",
      "change the dedication to mention my sister too"
    ]) {
      const model = matterRouter();
      const intent = await classifyProjectChatMessage({ message, stage: "complete", pages, chapters, textModel: model });
      expect(intent.kind, message).toBe("book_matter");
      expect(model.generateWithTools, message).toHaveBeenCalledTimes(1);
    }
  });

  it("is a matter edit, never a priced page edit, when the router is down", async () => {
    for (const message of MATTER_REQUESTS) {
      for (const clarifyExhausted of [false, true]) {
        const intent = await classifyProjectChatMessage({
          message,
          stage: "complete",
          pages,
          chapters,
          textModel: fakeFailingTextModel(),
          clarifyExhausted
        });
        expect(intent, message).toMatchObject({ kind: "book_matter", scope: "none", affectedPageIndexes: [] });
      }
    }
    // And with no model at all.
    expect(classifyWithDegradedHeuristics("remove the About the Author page", "complete", pages).kind).toBe("book_matter");
  });

  it("keeps a localized matter request free when the router is unavailable", async () => {
    for (const message of LOCALIZED_MATTER_REQUESTS) {
      for (const textModel of [fakeFailingTextModel(), undefined]) {
        for (const clarifyExhausted of [false, true]) {
          const intent = await classifyProjectChatMessage({ message, stage: "complete", pages, textModel, clarifyExhausted });
          expect(intent, message).toMatchObject({ kind: "book_matter", scope: "none", affectedPageIndexes: [] });
        }
      }
    }
  });

  it("leaves a page named by its number to the page edits, with the router down or absent", async () => {
    const book = manyPages(6);
    for (const message of PAGE_CONTENT_REQUESTS.filter((request) => /^rewrite/i.test(request))) {
      const pageIndexes = message.includes("3–5") ? [3, 4, 5] : [4];
      for (const textModel of [fakeFailingTextModel(), undefined]) {
        const intent = await classifyProjectChatMessage({ message, stage: "complete", pages: book, chapters, textModel });
        expect(intent, message).toMatchObject({ kind: "page_rewrite", affectedPageIndexes: pageIndexes });
      }
    }
    expect(classifyWithDegradedHeuristics("Rewrite page 4 so the publisher sounds meaner", "complete", book)).toMatchObject({
      kind: "page_rewrite",
      affectedPageIndexes: [4]
    });
    // The real matter requests beside them are still the matter edit's.
    for (const message of [
      "add a dedication: For my mom",
      "change the publisher to Lantern",
      "remove all rights reserved",
      "set the ISBN to 978-0-306-40615-7",
      "Change the publisher to Lantern. Also, make page 2 shorter",
      "Change the publisher to Lantern and make page 2 shorter"
    ]) {
      expect(classifyWithDegradedHeuristics(message, "complete", book).kind, message).toBe("book_matter");
    }
  });

  it("leaves content about a dedication to the page edits", async () => {
    expect(classifyWithDegradedHeuristics("make the hero more dedicated to her training", "complete", pages).kind).not.toBe(
      "book_matter"
    );
    expect(classifyWithDegradedHeuristics("dedicate a chapter to my grandmother", "complete", pages).kind).not.toBe("book_matter");
  });

  it("is not demoted into a question the router wrote as a confirmation", async () => {
    const intent = await classifyProjectChatMessage({
      message: "could the book honour my mum somehow",
      stage: "complete",
      pages,
      textModel: matterRouter({ confidence: 0.5 })
    });
    expect(intent).toMatchObject({ kind: "book_matter", clarification: "none" });
  });

  it("is not recognised before the book exists", async () => {
    const intent = await classifyProjectChatMessage({ message: "dedicate it to my mom", stage: "plan_ready", pages: [] });
    expect(intent.kind).not.toBe("book_matter");
  });

  it("is a target the router may pick, with no words of its own to fill in", () => {
    const schema = z.toJSONSchema(decideActionSchema(["answer", "propose_edit"])) as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.properties.editTarget!.enum).toContain("book_matter");
    expect(schema.properties.editTarget!.enum).not.toContain("dedication");
    expect(schema.properties).not.toHaveProperty("dedication");
    const prompt = routerSystemPrompt("complete", true, false, true);
    expect(prompt).toMatch(/editTarget book_matter/);
    expect(prompt).toMatch(/Never write the new words yourself/);
    expect(prompt).toMatch(/frontMatter/);
  });

  it("keeps a whole-book rewrite router away from it", async () => {
    // The router is the one deciding, so a wrong router is a wrong answer — but
    // a matter request never reaches a fast path that prices it first.
    const model = rewriteRouter();
    await classifyProjectChatMessage({ message: "remove all rights reserved", stage: "complete", pages, textModel: model });
    expect(model.generateWithTools).toHaveBeenCalledTimes(1);
  });
});

/**
 * Review finding 8. On a covered book the title page and the dedication sheet
 * are printed pages 1 and 2, ahead of the Contents, and hold no prose.
 */
describe("front matter in the chat", () => {
  // Sheet 1 the cover, 2 the title page (printed 1), 3 the matter sheet
  // (printed 2), 4 the Contents (printed 3), the text from sheet 5.
  const map = {
    version: 2 as const,
    totalPdfPages: 9,
    hasCoverPage: true,
    contentsStartPdfPage: 4,
    backMatterStartPdfPage: 9,
    pages: [
      { index: 1, startPdfPage: 5, endPdfPage: 6 },
      { index: 2, startPdfPage: 7, endPdfPage: 8 }
    ],
    contentRevision: 3
  };
  const row = {
    pdfPageMap: map,
    contentRevision: 3,
    research: [],
    category: "STORY",
    mediaSettings: {},
    authorName: "Ana Ruiz",
    bookMatter: { dedication: "For Mom" }
  };

  it("keeps the first front-matter page ambiguous and identifies later matter sheets", () => {
    expect(numberingForProject(row).frontMatter).toEqual([
      { page: 1, holds: "title_or_matter" },
      { page: 2, holds: "matter_sheet" }
    ]);
    // A coverless book's title page is its unnumbered first sheet, and a book
    // whose map came before its row changed cannot say which its one page is.
    const coverless = { ...map, totalPdfPages: 8, contentsStartPdfPage: 3, backMatterStartPdfPage: 8, pages: [
      { index: 1, startPdfPage: 4, endPdfPage: 5 },
      { index: 2, startPdfPage: 6, endPdfPage: 7 }
    ] };
    expect(numberingForProject({ ...row, pdfPageMap: coverless }).frontMatter).toEqual([{ page: 1, holds: "title_or_matter" }]);
    // No matter sheet: the one front-matter page is the title page.
    expect(
      numberingForProject({ ...row, pdfPageMap: coverless, authorName: null, bookMatter: null }).frontMatter
    ).toEqual([{ page: 1, holds: "title_page" }]);
  });

  it("tells the router what the front-matter pages hold", async () => {
    const { editTarget: _target, ...answer } = { ...matterRouterArgs, action: "answer" };
    const model = fakeDecideModel(answer);
    await classifyProjectChatMessage({
      message: "make the ending warmer",
      stage: "complete",
      pages,
      textModel: model,
      pageNumbering: numberingForProject(row)
    });
    const context = JSON.parse(vi.mocked(model.generateWithTools).mock.calls[0]![0].messages.at(-1)!.content).readerPageContext;
    expect(context.frontMatter).toEqual([
      { page: 1, holds: expect.stringMatching(/^front matter — the title page .*, or the dedication page$/) },
      { page: 2, holds: "the dedication page" }
    ]);
  });

  it("turns a page edit the router aimed at front matter into the matter edit", async () => {
    for (const [message, pageIndexes] of [
      ["change page 2 to say For Mom and Dad", [2]],
      ['Change page 1 to "by Sam Lee"', [1]],
      ["Change page ۲ to “For Mom and Dad”", [2]],
      ["rewrite page 1", [1]],
      ["make page 1 shorter", []]
    ] as const) {
      const intent = await classifyProjectChatMessage({
        message,
        stage: "complete",
        pages,
        pageNumbering: numberingForProject(row),
        textModel: fakeDecideModel({
          action: "propose_edit",
          confidence: 0.9,
          reasoning: "Copied the printed page.",
          assistantMessage: "I’ll rewrite that page.",
          clarification: "none",
          pageIndexes: [...pageIndexes],
          chapterIndex: null,
          targetLanguage: null,
          editTarget: "pages",
          editStyle: "rewrite"
        })
      });
      expect(intent, message).toMatchObject({ kind: "book_matter", affectedPageIndexes: [] });
    }
  });

  it.each([
    {
      message: 'On page 1, make the passage "Rabbit hops to the starting line" more vivid.',
      pageIndexes: [1]
    },
    {
      message: 'Change page 1 to "by Sam Lee" and make page 4 more vivid.',
      pageIndexes: [1]
    },
    {
      message: 'Change page 1 to "by Sam Lee"',
      pageIndexes: [2],
      readerSelection: { pageIndex: 2 }
    }
  ])("preserves a body target for $message", async ({ message, pageIndexes, ...selection }) => {
    const intent = await classifyProjectChatMessage({
      message,
      stage: "complete",
      pages,
      ...selection,
      pageNumbering: numberingForProject(row),
      textModel: fakeDecideModel({
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "The request identifies body prose.",
        assistantMessage: "I’ll rewrite that passage.",
        clarification: "none",
        pageIndexes,
        chapterIndex: null,
        targetLanguage: null,
        editTarget: "pages",
        editStyle: "rewrite"
      })
    });
    expect(intent).toMatchObject({ kind: "page_rewrite", affectedPageIndexes: pageIndexes });
  });

  it.each(["rewrite page 3", 'Change page 3 to "A new list"'])("answers %j aimed at the Contents instead of pricing it", async (message) => {
    const intent = await classifyProjectChatMessage({
      message,
      stage: "complete",
      pages,
      pageNumbering: numberingForProject(row),
      textModel: fakeDecideModel({
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Copied.",
        assistantMessage: "I’ll rewrite page 3.",
        clarification: "none",
        pageIndexes: [3],
        chapterIndex: null,
        targetLanguage: null,
        editTarget: "pages",
        editStyle: "rewrite"
      })
    });
    expect(intent).toMatchObject({ kind: "answer" });
    expect(intent.assistantMessage).toMatch(/table of contents/);
  });

  it("answers a delete of a front-matter page rather than clearing the sheet", async () => {
    const intent = await classifyProjectChatMessage({
      message: "delete page 2",
      stage: "complete",
      pages,
      pageNumbering: numberingForProject(row),
      textModel: fakeDecideModel({
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Copied.",
        assistantMessage: "I’ll delete page 2.",
        editInstruction: "Delete page 2.",
        clarification: "none",
        pageIndexes: [2],
        chapterIndex: null,
        targetLanguage: null,
        editTarget: "delete_pages"
      })
    });
    expect(intent).toMatchObject({ kind: "answer" });
    expect(intent.assistantMessage).toMatch(/^Printed page 2 holds the dedication\./);
  });

  it("leaves an insert at the front of the book alone", async () => {
    const intent = await classifyProjectChatMessage({
      message: "add a new page after page 2",
      stage: "complete",
      pages,
      pageNumbering: numberingForProject(row),
      textModel: fakeDecideModel({
        action: "propose_edit",
        confidence: 0.9,
        reasoning: "Insert at the front.",
        assistantMessage: "I’ll add a page at the front.",
        editInstruction: "Write a new opening page.",
        clarification: "none",
        pageIndexes: [],
        chapterIndex: null,
        targetLanguage: null,
        editTarget: "insert_pages"
      })
    });
    expect(intent.kind).toBe("restructure_pages");
  });

  it("names the page without a model, and says what can change there", async () => {
    const titlePage = await classifyProjectChatMessage({
      message: "make page 1 shorter",
      stage: "complete",
      pages,
      pageNumbering: numberingForProject(row)
    });
    expect(titlePage.kind).toBe("answer");
    expect(titlePage.assistantMessage).toMatch(/^Printed page 1 is the book’s front matter/);
    expect(titlePage.assistantMessage).toMatch(/rename the book to/);
    const sheet = await classifyProjectChatMessage({
      message: "change page 2",
      stage: "complete",
      pages,
      pageNumbering: numberingForProject(row)
    });
    expect(sheet.assistantMessage).toMatch(/^Printed page 2 holds the dedication\./);
  });

  it("reads a printed page number beside a matter word as the page it prints, with the router down", async () => {
    const classify = (message: string) =>
      classifyProjectChatMessage({
        message,
        stage: "complete",
        pages,
        pageNumbering: numberingForProject(row),
        textModel: fakeFailingTextModel()
      });
    // Printed page 4 is the text's first page here.
    expect(await classify("Rewrite page 4 so the publisher sounds meaner")).toMatchObject({
      kind: "page_rewrite",
      affectedPageIndexes: [1]
    });
    // Printed page 2 is the dedication's sheet, and the furniture reader answers it first.
    const sheet = await classify("Rewrite page 2 so the publisher sounds meaner");
    expect(sheet.kind).not.toBe("page_rewrite");
    expect(sheet.assistantMessage).toMatch(/^Printed page 2 holds the dedication\./);
  });
});

/**
 * The model-free matter recognisers read every message before any model does,
 * so a pattern that backtracks is an outage. Each is read on 10,000 characters
 * built to make one backtrack — a long run after each cue, runs of spaces,
 * separators and negations, mixed scripts — first at 1,000, so a pattern gone
 * super-linear fails here rather than hanging (review round 7: core's "use her
 * name …" took 97 s on 5,000 letters).
 */
describe("the matter recognisers on an adversarial message", () => {
  const cues = [
    "", "Remove the title page. Use her name ", "remove the title page ", "please don't, ", "take the title page ", "no title page ", "the dedication ",
    "dedicate it to ", "Author: ", "and also ", "can you ", "on page 4, ", "rename the book to ", "never ", "Is it ok? ", "have the ", "do "
  ];
  const runs = [
    "a", "Aa ", " ", "\t\n ", " ,", "a.", "1 ", "also ", "never ", "don't ", "remove the ", "title page ", "page 1 ", "«", "aب", "then make ",
    "and the title page ", "a? ", "is it。"
  ];
  const message = (cue: string, run: string, length: number, tail: string) =>
    `${cue}${run.repeat(Math.ceil(length / run.length))}`.slice(0, length - tail.length) + tail;
  const timed = (read: (text: string) => unknown, text: string) => {
    const started = performance.now();
    read(text);
    return performance.now() - started;
  };

  it.each([
    ["isTitlePageRemoval", isTitlePageRemoval],
    ["asksToRemoveTitlePage", asksToRemoveTitlePage],
    ["mentionsBookMatter", mentionsBookMatter]
  ] as const)("%s stays linear", (_name, read) => {
    // V8 compiles a regular expression to machine code on its first heavy use; read every
    // input short first, so that one-time compile is not what is measured.
    for (const cue of cues) for (const run of runs) for (const tail of [")", ". remove the title page"]) read(message(cue, run, 200, tail));
    for (const cue of cues) {
      for (const run of runs) {
        for (const tail of [")", ". remove the title page"]) {
          const said = `${JSON.stringify(cue)} + ${JSON.stringify(run)} + ${JSON.stringify(tail)}`;
          expect(timed(read, message(cue, run, 1_000, tail)), `${said} at 1,000`).toBeLessThan(200);
          expect(timed(read, message(cue, run, 10_000, tail)), `${said} at 10,000`).toBeLessThan(1_000);
        }
      }
    }
  }, 120_000);
});
