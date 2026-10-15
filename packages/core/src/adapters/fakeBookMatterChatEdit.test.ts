import { describe, expect, it } from "vitest";
import {
  BOOK_MATTER_CHAT_PURPOSE,
  bookMatterChatAnswerSchema,
  bookMatterChatMessages,
  normalizeBookMatterChatAnswer,
  type BookMatterChatCurrent
} from "../authoring/bookMatterChatEdit.js";
import { FakeTextModelAdapter } from "./fake.js";
import { BOOK_MATTER_GROUNDING_PURPOSE, bookMatterGroundingAnswerSchema } from "../authoring/bookMatterProseGrounding.js";

const current: BookMatterChatCurrent = {
  authorName: "Ada",
  dedication: "For Mom",
  aboutAuthor: null,
  authorWebsite: null,
  copyrightHolder: null,
  imprint: null,
  isbn: null,
  allRightsReserved: false
};

async function answer(message: string, bookLanguage = "en") {
  const adapter = new FakeTextModelAdapter();
  const result = await adapter.generateJson({
    purpose: BOOK_MATTER_CHAT_PURPOSE,
    schema: bookMatterChatAnswerSchema,
    messages: bookMatterChatMessages({ message, current, bookLanguage })
  });
  return normalizeBookMatterChatAnswer(result.data, { message, current });
}

describe("the MOCK_AI book-matter composer", () => {
  it("explicitly declines semantic grounding it cannot perform", async () => {
    const result = await new FakeTextModelAdapter().generateJson({
      purpose: BOOK_MATTER_GROUNDING_PURPOSE,
      schema: bookMatterGroundingAnswerSchema,
      messages: []
    });
    expect(result.data).toEqual({ verdicts: [] });
  });
  it("answers in a shape the normalizer accepts, so a dry run reaches the apply path", async () => {
    expect(await answer("dedicate it to my mom")).toEqual({ kind: "change", patch: { dedication: "For my mom" } });
    expect(await answer("Please dedicate this book to Grandma Rose, thanks!")).toEqual({
      kind: "change",
      patch: { dedication: "For Grandma Rose" }
    });
    expect(await answer('make the dedication "For Sara, always"')).toEqual({
      kind: "change",
      patch: { dedication: "For Sara, always" }
    });
    expect(await answer("remove the dedication")).toEqual({ kind: "change", patch: { dedication: null } });
    expect(await answer("the ISBN is 978-0-306-40615-7")).toEqual({ kind: "change", patch: { isbn: "978-0-306-40615-7" } });
    expect((await answer("change the dedication to mention my sister too")).kind).toBe("question");
  });

  it("asks rather than guessing where a recipient ends, which is how it printed “For my mom and redo the cover”", async () => {
    for (const message of [
      "dedicate it to my mom and redo the cover",
      "dedicate it to my mom also redo the cover",
      "dedicate it to my mom then make the title shorter",
      "dedicate it to my mom redo the cover",
      "Dedicate it to my mom. Redo the cover.",
      "dedicate it to my mom, regenerate the cover",
      "dedicate it to my mom in Spanish",
      "dedicate it to my sister too",
      "Dedicate it to Dr. Smith",
      "dedicate it to my mom and dad",
      "redo the cover and dedicate it to my mom",
      "replace the dedication with a poem"
    ]) {
      expect(await answer(message), message).toMatchObject({ kind: "question" });
    }
  });

  it("never removes a whole dedication for a request to edit part of it", async () => {
    for (const message of [
      "remove my ex's name from the dedication",
      "delete the second line of the dedication",
      "remove the dedication's last line",
      "remove the dedication from the paperback only"
    ]) {
      expect(await answer(message), message).toMatchObject({ kind: "question" });
    }
  });

  it("prints a quote only when the quote is the whole dedication", async () => {
    for (const message of [
      'change the dedication to mention "Sara" too',
      'make the dedication "For Sara" in French',
      'dedicate it to "Mom"',
      'the dedication is "For Mom" — make it "For Mom and Dad"'
    ]) {
      expect(await answer(message), message).toMatchObject({ kind: "question" });
    }
  });

  it("names back a separate request after the matter part exactly as typed, and changes nothing for it", async () => {
    expect(await answer('make the dedication "For Sara, always" and redo the cover')).toEqual({
      kind: "change",
      patch: { dedication: "For Sara, always" },
      unhandled: "redo the cover"
    });
    expect(await answer("remove the dedication and then make the title shorter")).toEqual({
      kind: "change",
      patch: { dedication: null },
      unhandled: "make the title shorter"
    });
    expect(await answer("The ISBN is 978-0-306-40615-7. Also redo page 4")).toEqual({
      kind: "change",
      patch: { isbn: "978-0-306-40615-7" },
      unhandled: "redo page 4"
    });
    expect(await answer("Can you remove the dedication please? Thanks!")).toEqual({
      kind: "change",
      patch: { dedication: null }
    });
  });

  it("writes the English short form only on an English book, and prints a quote on any", async () => {
    expect((await answer("dedicate it to my mom", "fa")).kind).toBe("question");
    expect(await answer('make the dedication "تقدیم به مادرم"', "fa")).toEqual({
      kind: "change",
      patch: { dedication: "تقدیم به مادرم" }
    });
  });

  it("asks for an ISBN it was not given and leaves a wrong one to the normalizer", async () => {
    expect((await answer("add an ISBN")).kind).toBe("question");
    expect(await answer("the ISBN is 978-0-306-40615-8")).toEqual({ kind: "refused", problem: { kind: "invalid_isbn" } });
  });
});
