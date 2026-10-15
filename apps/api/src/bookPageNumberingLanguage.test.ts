import { describe, expect, it } from "vitest";
import { CONVERSATION_LANGUAGES, type ConversationLanguage } from "@book-maker/core";
import { classifyProjectChatMessage, type BookEditIntent } from "./bookEditIntent.js";
import {
  furniturePageIntentFromMessage, readerPageNumbering, withoutFurniturePageEdit, type ReaderPageNumbering
} from "./bookPageNumbering.js";
import { fakeDecideModel, fakeFailingTextModel } from "./testing/bookEditIntentFixtures.js";

const pages = [{ id: "page-1", index: 1, title: "One", summary: "", previewText: "A clockmaker walked into the village." }];
const intent: BookEditIntent = {
  kind: "page_rewrite",
  confidence: 0.9,
  reasoning: "Change printed page one.",
  affectedPageIndexes: [1],
  assistantMessage: "نام را تغییر می‌دهم.",
  responseLanguage: "fa",
  scope: "explicit_pages",
  impact: "small_text",
  clarification: "none"
};

describe("conversation language when a page edit targets furniture", () => {
  it("retains the router's language when sending front matter to its composer", () => {
    const numbering = readerPageNumbering({
      version: 2,
      totalPdfPages: 4,
      hasCoverPage: true,
      pages: [{ index: 1, startPdfPage: 4, endPdfPage: 4 }]
    });
    expect(withoutFurniturePageEdit(intent, "نام نویسنده در صفحه ۱ را به علی تغییر بده", pages, numbering)).toMatchObject({
      kind: "book_matter",
      responseLanguage: "fa"
    });
  });

  it("retains the router's language when replacing an edit with a furniture answer", () => {
    const numbering = readerPageNumbering({
      version: 2,
      totalPdfPages: 4,
      hasCoverPage: true,
      contentsStartPdfPage: 2,
      pages: [{ index: 1, startPdfPage: 3, endPdfPage: 4 }]
    });
    expect(withoutFurniturePageEdit(intent, "صفحه ۱ را درست کن", pages, numbering)).toMatchObject({
      kind: "answer",
      responseLanguage: "fa",
      assistantMessage: expect.stringContaining("فهرست")
    });
  });
});

const contentsNumbering = readerPageNumbering({
  version: 2, totalPdfPages: 6, hasCoverPage: true, contentsStartPdfPage: 2, backMatterStartPdfPage: 5,
  pages: [{ index: 1, startPdfPage: 3, endPdfPage: 4 }]
});
const frontNumbering = readerPageNumbering({
  version: 2, totalPdfPages: 6, hasCoverPage: true, contentsStartPdfPage: 4,
  pages: [{ index: 1, startPdfPage: 5, endPdfPage: 6 }]
});
const contentsWords: Record<ConversationLanguage, string> = {
  en: "table of contents", ar: "جدول المحتويات", zh: "目录", da: "indholdsfortegnelsen", nl: "inhoudsopgave",
  fa: "فهرست", fr: "table des matières", de: "Inhaltsverzeichnis", el: "πίνακας περιεχομένων", he: "תוכן העניינים",
  hi: "विषय-सूची", it: "indice", ja: "目次", ko: "목차", no: "innholdsfortegnelsen", pl: "spis treści",
  pt: "sumário", ru: "оглавление", es: "índice", sv: "innehållsförteckningen", th: "สารบัญ",
  tr: "içindekiler", uk: "зміст", ur: "فہرستِ مضامین", vi: "mục lục"
};

function answer(numbering: ReaderPageNumbering, page: number, language: ConversationLanguage, structural = false) {
  return withoutFurniturePageEdit({
    ...intent,
    kind: structural ? "restructure_pages" : "page_rewrite",
    responseLanguage: language,
    ...(structural ? { structuralEdit: { action: "delete" as const, pageIndexes: [page], pageCount: 0, anchorPageIndex: 0 } } : {})
  }, `fix page ${page}`, pages, numbering);
}

describe("furniture replies in every supported conversation language", () => {
  it.each(CONVERSATION_LANGUAGES)("answers Contents in %s with the printed range", (language) => {
    // The request spelling deliberately differs from the selected language:
    // only the validated model language chooses this copy.
    const reply = answer(contentsNumbering, 1, language);
    expect(reply).toMatchObject({ kind: "answer", responseLanguage: language, affectedPageIndexes: [] });
    expect(reply.assistantMessage).toContain(contentsWords[language]);
    expect(reply.assistantMessage).toContain("1");
    expect(reply.assistantMessage).toContain("2–3");
    expect(reply.assistantMessage).not.toMatch(/\{(?:page|range)\}/);
  });

  const localizedZones = [
    { name: "title", page: 1, numbering: { ...frontNumbering, frontMatter: [{ page: 1, holds: "title_page" as const }] } },
    { name: "sheet", page: 1, numbering: { ...frontNumbering, frontMatter: [{ page: 1, holds: "matter_sheet" as const }] } },
    { name: "ambiguous front matter", page: 1, numbering: { ...frontNumbering, frontMatter: [] } },
    { name: "sources", page: 4, numbering: { ...contentsNumbering, backMatter: { sources: true, aboutAuthor: false } } },
    { name: "biography", page: 4, numbering: { ...contentsNumbering, backMatter: { sources: false, aboutAuthor: true } } },
    { name: "both back matter sections", page: 4, numbering: { ...contentsNumbering, backMatter: { sources: true, aboutAuthor: true } } },
    { name: "unknown back matter", page: 4, numbering: contentsNumbering },
    { name: "outside", page: 20, numbering: contentsNumbering },
    { name: "legacy cover", page: 1, numbering: readerPageNumbering({
      version: 1, totalPdfPages: 3, hasCoverPage: true, pages: [{ index: 1, startPdfPage: 2, endPdfPage: 3 }]
    }) }
  ];

  it.each(CONVERSATION_LANGUAGES.filter((language) => language !== "en"))(
    "localizes all other furniture zones in %s", (language) => {
      for (const fixture of localizedZones) {
        const reply = answer(fixture.numbering, fixture.page, language, true);
        expect(reply, fixture.name).toMatchObject({ kind: "answer", responseLanguage: language, affectedPageIndexes: [] });
        expect(reply.assistantMessage, fixture.name).not.toBe(answer(fixture.numbering, fixture.page, "en", true).assistantMessage);
        expect(reply.assistantMessage, fixture.name).not.toMatch(/Printed page|The story runs|\{(?:page|range)\}/);
        if (fixture.name !== "legacy cover") expect(reply.assistantMessage, fixture.name).toContain(String(fixture.page));
      }
    }
  );

  it.each(["delete", "move"] as const)("describes a Persian front-matter %s without promising to apply it", (action) => {
    const reply = withoutFurniturePageEdit({
      ...intent, kind: "restructure_pages",
      structuralEdit: { action, pageIndexes: [1], pageCount: 0, anchorPageIndex: 1 }
    }, "صفحه ۱ را جابه‌جا کن", pages, {
      ...frontNumbering, frontMatter: [{ page: 1, holds: "title_page" }]
    });
    expect(reply).toMatchObject({ kind: "answer", responseLanguage: "fa", affectedPageIndexes: [] });
    expect(reply.assistantMessage).toContain("هر کتاب این صفحه را نگه می‌دارد");
    expect(reply.assistantMessage).toContain("4–5");
    expect(reply).not.toHaveProperty("structuralEdit");
  });

  it("keeps Persian back-matter labels faithful to the published sections", () => {
    const bio = answer({ ...contentsNumbering, backMatter: { sources: false, aboutAuthor: true } }, 4, "fa").assistantMessage;
    const sources = answer({ ...contentsNumbering, backMatter: { sources: true, aboutAuthor: false } }, 4, "fa").assistantMessage;
    const both = answer({ ...contentsNumbering, backMatter: { sources: true, aboutAuthor: true } }, 4, "fa").assistantMessage;
    const unknown = answer(contentsNumbering, 4, "fa").assistantMessage;
    expect(bio).toContain("دربارهٔ نویسنده");
    expect(bio).not.toContain("منابع");
    expect(sources).toContain("فهرست منابع");
    expect(sources).not.toContain("نویسنده");
    expect(both).toContain("منابع و دربارهٔ نویسنده");
    expect(unknown).toContain("صفحات پایانی");
    expect(unknown).not.toMatch(/منابع|نویسنده/);
  });

  it("keeps English copy on the model-free path without a selected conversation language", () => {
    const reply = furniturePageIntentFromMessage("صفحه ۱ را درست کن", pages, contentsNumbering);
    expect(reply?.assistantMessage).toBe(answer(contentsNumbering, 1, "en").assistantMessage);
  });
});

describe("furniture replies without a working router", () => {
  it.each([
    ["missing", "fa", "صفحه ۱ را درست کن"],
    ["throwing", "fa", "صفحه ۱ را درست کن"],
    ["missing", "nl", "Maak pagina 1 korter"],
    ["throwing", "nl", "Maak pagina 1 korter"]
  ] as const)("retains %s-router conversation language %s", async (router, conversationLanguage, message) => {
    const reply = await classifyProjectChatMessage({
      message,
      stage: "complete",
      pages,
      pageNumbering: contentsNumbering,
      conversationLanguage,
      ...(router === "throwing" ? { textModel: fakeFailingTextModel() } : {})
    });
    expect(reply).toMatchObject({ kind: "answer", responseLanguage: conversationLanguage, affectedPageIndexes: [] });
    expect(reply.assistantMessage).toContain(contentsWords[conversationLanguage]);
    expect(reply.assistantMessage).toContain("2–3");
    expect(reply.assistantMessage).not.toContain("Printed page");
  });

  it.each(["missing", "throwing"])("uses English with a %s router and no established language", async (router) => {
    const reply = await classifyProjectChatMessage({
      message: "صفحه ۱ را درست کن",
      stage: "complete",
      pages,
      pageNumbering: contentsNumbering,
      ...(router === "throwing" ? { textModel: fakeFailingTextModel() } : {})
    });
    expect(reply).toMatchObject({ kind: "answer", affectedPageIndexes: [] });
    expect(reply.assistantMessage).toContain(contentsWords.en);
    expect(reply).not.toHaveProperty("responseLanguage");
  });
});

describe("furniture replies from a router that named no language", () => {
  it("answers in the established conversation language", async () => {
    const textModel = fakeDecideModel({
      action: "propose_edit",
      confidence: 0.9,
      reasoning: "Rewrite printed page one.",
      assistantMessage: "I’ll rewrite page 1.",
      clarification: "none",
      pageIndexes: [1],
      chapterIndex: null,
      targetLanguage: null,
      editTarget: "pages",
      editStyle: "rewrite"
    });
    const reply = await classifyProjectChatMessage({
      message: "صفحه ۱ را درست کن",
      stage: "complete",
      pages,
      pageNumbering: contentsNumbering,
      conversationLanguage: "fa",
      textModel
    });
    expect(textModel.generateWithTools).toHaveBeenCalledTimes(1);
    expect(reply).toMatchObject({ kind: "answer", responseLanguage: "fa", affectedPageIndexes: [] });
    expect(reply.assistantMessage).toContain(contentsWords.fa);
    expect(reply.assistantMessage).not.toContain("Printed page");
  });

  it("falls back to the established conversation language when the router named none", () => {
    const { responseLanguage: _omitted, ...unnamed } = intent;
    const title = { ...frontNumbering, frontMatter: [{ page: 1, holds: "title_page" as const }] };
    const deletion = withoutFurniturePageEdit({
      ...unnamed, kind: "restructure_pages",
      structuralEdit: { action: "delete", pageIndexes: [1], pageCount: 0, anchorPageIndex: 1 }
    }, "delete page 1", pages, title, "fa");
    expect(deletion).toMatchObject({ kind: "answer", responseLanguage: "fa" });
    expect(deletion.assistantMessage).toContain("هر کتاب این صفحه را نگه می‌دارد");
    expect(deletion.assistantMessage).not.toContain("Printed page");
    expect(withoutFurniturePageEdit(unnamed, "fix page 1", pages, contentsNumbering, "fa")).toMatchObject({
      kind: "answer", responseLanguage: "fa", assistantMessage: expect.stringContaining("فهرست")
    });
    expect(withoutFurniturePageEdit(unnamed, "change the author on page 1", pages, title, "fa")).toMatchObject({
      kind: "book_matter", responseLanguage: "fa"
    });
    // The router's own choice still wins over the history's.
    expect(withoutFurniturePageEdit({ ...unnamed, responseLanguage: "nl" }, "fix page 1", pages, contentsNumbering, "fa"))
      .toMatchObject({ responseLanguage: "nl", assistantMessage: expect.stringContaining(contentsWords.nl) });
    // With neither, the reply stays English and claims no language.
    const english = withoutFurniturePageEdit(unnamed, "fix page 1", pages, contentsNumbering);
    expect(english.assistantMessage).toContain("Printed page 1");
    expect(english).not.toHaveProperty("responseLanguage");
  });
});
