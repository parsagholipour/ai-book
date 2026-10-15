import { describe, expect, it } from "vitest";

import {
  BOOK_MATTER_CHAT_LANGUAGES,
  bookMatterChatAnswerSchema,
  bookMatterChatMessages,
  bookMatterMessageHasSeparateRequest,
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatCurrent
} from "./bookMatterChatEdit.js";
import { normalizeReviewedMatterAnswer } from "./testing/reviewedMatterAnswer.js";

const current: BookMatterChatCurrent = {
  authorName: "Ana Ruiz",
  dedication: "For Mom",
  aboutAuthor: null,
  authorWebsite: null,
  copyrightHolder: null,
  imprint: null,
  isbn: null,
  allRightsReserved: false
};

type Change = BookMatterChatAnswer["changes"][number];
const answer = (changes: Change[], extra: Partial<BookMatterChatAnswer> = {}): BookMatterChatAnswer =>
  bookMatterChatAnswerSchema.parse({ outcome: "change", changes, ...extra });
const decide = (message: string, changes: Change[], extra: Partial<BookMatterChatAnswer> = {}) =>
  normalizeBookMatterChatAnswer(answer(changes, extra), { message, current });
const decideReviewed = (message: string, changes: Change[]) =>
  normalizeReviewedMatterAnswer(answer(changes), { message, current });

describe("the matter composer's answer", () => {
  it("parses a whole answer and refuses one with no outcome", () => {
    expect(bookMatterChatAnswerSchema.safeParse({}).success).toBe(false);
    expect(bookMatterChatAnswerSchema.parse({ outcome: "none" })).toEqual({ outcome: "none", changes: [] });
    expect(
      bookMatterChatAnswerSchema.safeParse({ outcome: "change", changes: [{ field: "title", action: "set", text: "X" }] }).success
    ).toBe(false);
  });

  it("keeps supported response languages and drops a malformed hint without losing the edit", () => {
    for (const responseLanguage of BOOK_MATTER_CHAT_LANGUAGES) {
      expect(bookMatterChatAnswerSchema.parse({ outcome: "none", responseLanguage }).responseLanguage).toBe(responseLanguage);
    }
    expect(bookMatterChatAnswerSchema.parse({ outcome: "none", responseLanguage: "print the book" }).responseLanguage).toBeUndefined();
  });

  it("keeps the revised dedication the model worked the sister into", () => {
    const message = "change the dedication to mention my sister too";
    expect(
      decideReviewed(message, [{ field: "dedication", action: "set", text: "For Mom and my sister", requestedBy: message }])
    ).toEqual({ kind: "change", patch: { dedication: "For Mom and my sister" } });
  });

  it("reads remove as null, and the rights line as a boolean", () => {
    expect(
      decide("remove the About the Author page and all rights reserved", [
        { field: "aboutAuthor", action: "remove", requestedBy: "remove the About the Author page" },
        { field: "allRightsReserved", action: "remove", requestedBy: "all rights reserved" }
      ])
    ).toEqual({ kind: "change", patch: { aboutAuthor: null, allRightsReserved: false } });
    expect(
      decide("print all rights reserved", [{ field: "allRightsReserved", action: "set", requestedBy: "print all rights reserved" }])
    ).toEqual({ kind: "change", patch: { allRightsReserved: true } });
  });

  it("strips a field the request never named", () => {
    const message = "change the author name to Sam Lee";
    expect(
      decide(message, [
        { field: "authorName", action: "set", text: "Sam Lee", requestedBy: message },
        { field: "copyrightHolder", action: "set", text: "Sam Lee", requestedBy: message }
      ])
    ).toEqual({ kind: "change", patch: { authorName: "Sam Lee" } });
  });

  it("strips a second change whose quoted request is not in the message, and holds an only change to the reader's facts", () => {
    const message = "ناشر را لانترن کن";
    const imprint = { field: "imprint" as const, action: "set" as const, text: "لانترن", requestedBy: message };
    expect(
      normalizeBookMatterChatAnswer(
        answer([imprint, { field: "copyrightHolder", action: "set", text: "لانترن", requestedBy: "make the copyright holder Lantern" }]),
        { message, current }
      )
    ).toEqual({ kind: "change", patch: { imprint: "لانترن" } });
    // The only change, of the only field the message names, is kept whatever it quoted;
    // what it prints is still held to the reader's words.
    expect(
      normalizeBookMatterChatAnswer(
        answer([{ field: "imprint", action: "set", text: "Lantern", requestedBy: "make the publisher Lantern" }]),
        { message, current }
      )
    ).toEqual({ kind: "refused", problem: { kind: "not_given", field: "imprint" } });
  });

  it("reads a field named in Persian, and drops what a Persian request never named, quoted or not", () => {
    const message = "تقدیم‌نامه را به مادرم تقدیم کن";
    const dedication = { field: "dedication" as const, action: "set" as const, text: "تقدیم به مادرم", requestedBy: message };
    // The review's probe: a rights claim and a deleted bio rode along unquoted.
    expect(
      normalizeBookMatterChatAnswer(
        answer([
          dedication,
          { field: "allRightsReserved", action: "set", text: null },
          { field: "aboutAuthor", action: "remove", text: null, requestedBy: "  " }
        ]),
        { message, current }
      )
    ).toEqual({ kind: "change", patch: { dedication: "تقدیم به مادرم" } });
    // Quoting the dedication request does not ask for them either.
    expect(
      normalizeBookMatterChatAnswer(
        answer([
          dedication,
          { field: "allRightsReserved", action: "set", text: null, requestedBy: message },
          { field: "aboutAuthor", action: "remove", text: null, requestedBy: message }
        ]),
        { message, current }
      )
    ).toEqual({ kind: "change", patch: { dedication: "تقدیم به مادرم" } });
    const rights = "عبارت کلیه حقوق محفوظ است را اضافه کن";
    expect(
      normalizeBookMatterChatAnswer(answer([{ field: "allRightsReserved", action: "set", text: null, requestedBy: rights }]), {
        message: rights,
        current
      })
    ).toEqual({ kind: "change", patch: { allRightsReserved: true } });
  });

  it("drops a change that quotes nothing beside one that was asked for, or words that name another field", () => {
    // Alone, and of the one field the message names, an unquoted change is the one asked for.
    expect(decide("dedicate it to my mom", [{ field: "dedication", action: "set", text: "For my mom" }])).toEqual({
      kind: "change",
      patch: { dedication: "For my mom" }
    });
    expect(
      decide("dedicate it to my mom", [
        { field: "dedication", action: "set", text: "For my mom", requestedBy: "dedicate it to my mom" },
        { field: "imprint", action: "set", text: "my mom" }
      ])
    ).toEqual({ kind: "change", patch: { dedication: "For my mom" } });
    // Alone, but of a field the message never names, it is not.
    expect(decide("dedicate it to my mom", [{ field: "imprint", action: "set", text: "my mom", requestedBy: "dedicate it to my mom" }])).toEqual({
      kind: "none",
      reason: "not_matter"
    });
    // "copyright" names the holder, never "All rights reserved".
    const holder = "change the copyright holder to Sam Lee";
    expect(
      decide(holder, [
        { field: "copyrightHolder", action: "set", text: "Sam Lee", requestedBy: holder },
        { field: "allRightsReserved", action: "set", text: null, requestedBy: holder }
      ])
    ).toEqual({ kind: "change", patch: { copyrightHolder: "Sam Lee" } });
    // A quote is whole words of the message: "all rights" is not in "overall rights".
    expect(
      decide("make the overall rights clearer in the dedication", [
        { field: "allRightsReserved", action: "set", text: null, requestedBy: "all rights" }
      ])
    ).toEqual({ kind: "none", reason: "not_matter" });
  });

  it("takes the field from the request a clarifying question was about", () => {
    const message = "change the publisher\n\nFollow-up from the user: Lantern";
    // The answer's quote names nothing; beside a second change, the request the question was about names the field.
    const imprint = [
      { field: "imprint" as const, action: "set" as const, text: "Lantern", requestedBy: "Lantern" },
      { field: "copyrightHolder" as const, action: "set" as const, text: "Lantern", requestedBy: "Lantern" }
    ];
    expect(
      normalizeBookMatterChatAnswer(answer(imprint), { message, current, originalRequest: "change the publisher" })
    ).toEqual({ kind: "change", patch: { imprint: "Lantern" } });
    expect(normalizeBookMatterChatAnswer(answer(imprint), { message, current })).toEqual({ kind: "none", reason: "not_matter" });
    // A typed ISBN names the ISBN on its own.
    const isbn = "add an ISBN\n\nFollow-up from the user: 978-0-306-40615-7";
    expect(
      decide(isbn, [{ field: "isbn", action: "set", text: "978-0-306-40615-7", requestedBy: "978-0-306-40615-7" }])
    ).toEqual({ kind: "change", patch: { isbn: "978-0-306-40615-7" } });
  });

  it("quotes the part of the message left for another edit only in the reader's words, and reports a paraphrase without quoting it", () => {
    const message = "Dedicate it to my mom. Also, make page 2 shorter";
    const dedication = [{ field: "dedication" as const, action: "set" as const, text: "For my mom", requestedBy: "Dedicate it to my mom" }];
    expect(decide(message, dedication, { unhandled: "make page 2 shorter" })).toEqual({
      kind: "change",
      patch: { dedication: "For my mom" },
      unhandled: "make page 2 shorter"
    });
    // The model's paraphrase is not the reader's words, but the left-over is still there.
    expect(decide(message, dedication, { unhandled: "shorten the second page" })).toEqual({
      kind: "change",
      patch: { dedication: "For my mom" },
      unhandledUnquoted: true
    });
  });

  it("finds a second request the model never reported, and asks about the left-over when it asks its question", () => {
    const dedication = (requestedBy: string) => [{ field: "dedication" as const, action: "set" as const, text: "For my mom", requestedBy }];
    for (const message of [
      "dedicate it to my mom and redo the cover",
      "Dedicate it to my mom. Make page 2 shorter.",
      "dedicate it to my mom, regenerate the cover",
      "Redo the cover and dedicate it to my mom",
      "can you dedicate it to my mom? also could you rewrite chapter 3"
    ]) {
      expect(decide(message, dedication("dedicate it to my mom")), message).toEqual({
        kind: "change",
        patch: { dedication: "For my mom" },
        unhandledUnquoted: true
      });
    }
    const persian = "تقدیم‌نامه را به مادرم تقدیم کن و جلد را عوض کن";
    expect(
      normalizeBookMatterChatAnswer(
        answer([{ field: "dedication", action: "set", text: "تقدیم به مادرم", requestedBy: "تقدیم‌نامه را به مادرم تقدیم کن" }]),
        { message: persian, current }
      )
    ).toEqual({ kind: "change", patch: { dedication: "تقدیم به مادرم" }, unhandledUnquoted: true });

    const poem = "replace the dedication with a poem and redo the cover";
    expect(
      normalizeBookMatterChatAnswer(bookMatterChatAnswerSchema.parse({ outcome: "question", question: "Which poem?" }), { message: poem, current })
    ).toEqual({ kind: "question", question: "Which poem?", unhandledUnquoted: true });
    expect(
      normalizeBookMatterChatAnswer(
        bookMatterChatAnswerSchema.parse({ outcome: "question", question: "Which poem?", unhandled: "redo the cover" }),
        { message: poem, current }
      )
    ).toEqual({ kind: "question", question: "Which poem?", unhandled: "redo the cover" });
    expect(bookMatterMessageHasSeparateRequest("remove the title page and redo the cover")).toBe(true);
  });

  it("reads no second request into one request's own words", () => {
    for (const [message, changes] of [
      ["change the dedication to mention my mom and make it rhyme", [{ field: "dedication", action: "set", text: "For my mom", requestedBy: "change the dedication" }]],
      ["change the dedication to: For Mom. Make every day count.", [{ field: "dedication", action: "set", text: "For Mom. Make every day count.", requestedBy: "change the dedication" }]],
      ['make the dedication "For Mom. Keep going."', [{ field: "dedication", action: "set", text: "For Mom. Keep going.", requestedBy: "make the dedication" }]],
      ["dedicate it to my mom and print all rights reserved", [
        { field: "dedication", action: "set", text: "For my mom", requestedBy: "dedicate it to my mom" },
        { field: "allRightsReserved", action: "set", text: null, requestedBy: "print all rights reserved" }
      ]],
      ["Can you remove the dedication please? Thanks!", [{ field: "dedication", action: "remove", text: null, requestedBy: "remove the dedication" }]],
      ["change the author name to Sam Lee and keep the rest", [{ field: "authorName", action: "set", text: "Sam Lee", requestedBy: "change the author name to Sam Lee" }]],
      ["remove the dedication\n\nFollow-up from the user: apply it", [{ field: "dedication", action: "remove", text: null, requestedBy: "remove the dedication" }]],
      ["به پدر و مادرم تقدیم کن", [{ field: "dedication", action: "set", text: "تقدیم به پدر و مادرم", requestedBy: "به پدر و مادرم تقدیم کن" }]]
    ] as Array<[string, Change[]]>) {
      expect(Object.keys(decide(message, changes)), message).toEqual(["kind", "patch"]);
    }
  });

  it("refuses an ISBN that is not one, or that the reader never typed", () => {
    const typed = "the ISBN is 978-0-306-40615-7";
    expect(decide(typed, [{ field: "isbn", action: "set", text: "ISBN 978-0-306-40615-7", requestedBy: typed }])).toEqual({
      kind: "change",
      patch: { isbn: "978-0-306-40615-7" }
    });
    const bad = "the ISBN is 978-0-306-40615-8";
    expect(decide(bad, [{ field: "isbn", action: "set", text: "978-0-306-40615-8", requestedBy: bad }])).toEqual({
      kind: "refused",
      problem: { kind: "invalid_isbn" }
    });
    expect(decide("add an ISBN", [{ field: "isbn", action: "set", text: "9780306406157", requestedBy: "add an ISBN" }])).toEqual({
      kind: "refused",
      problem: { kind: "not_given", field: "isbn" }
    });
  });

  it.each([
    ["fa", "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷", "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷"],
    ["ar", "٩٧٨-٠-٣٠٦-٤٠٦١٥-٧", "٩٧٨-٠-٣٠٦-٤٠٦١٥-٧"],
    ["hi", "९७८ ० ३०६ ४०६१५ ७", "९७८ ० ३०६ ४०६१५ ७"],
    ["bn", "৯৭৮-০-৩০৬-৪০৬১৫-৭", "৯৭৮-০-৩০৬-৪০৬১৫-৭"],
    ["th", "๙๗๘-๐-๓๐๖-๔๐๖๑๕-๗", "๙๗๘-๐-๓๐๖-๔๐๖๑๕-๗"],
    ["ja", "９７８-０-３０６-４０６１５-７", "９７８-０-３０６-４０６１５-７"],
    ["fa", "ISBN-۱۳: ۹۷۸–۰–۳۰۶–۴۰۶۱۵–۷", "۹۷۸–۰–۳۰۶–۴۰۶۱۵–۷"],
    ["en", "ISBN-10: 0‑8044‑2957‑x", "0‑8044‑2957‑x"]
  ])("preserves the supplied %s ISBN digits and separators: %s", (bookLanguage, supplied, printed) => {
    const message = `Set the ISBN to ${supplied}`;
    expect(
      normalizeBookMatterChatAnswer(answer([{ field: "isbn", action: "set", text: supplied, requestedBy: message }]), {
        message,
        current,
        bookLanguage
      })
    ).toEqual({ kind: "change", patch: { isbn: printed } });
  });

  it("still checks the checksum and grounding of an ISBN written with native digits", () => {
    const invalid = "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۸";
    const message = `Set the ISBN to ${invalid}`;
    expect(decide(message, [{ field: "isbn", action: "set", text: invalid, requestedBy: message }])).toEqual({
      kind: "refused",
      problem: { kind: "invalid_isbn" }
    });
    expect(decide("add an ISBN", [{ field: "isbn", action: "set", text: "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷", requestedBy: "add an ISBN" }])).toEqual({
      kind: "refused",
      problem: { kind: "not_given", field: "isbn" }
    });
  });

  it("refuses a publisher, holder or name that is not in the reader's words", () => {
    const message = "change the publisher to Lantern";
    expect(decide(message, [{ field: "imprint", action: "set", text: "Lantern Books", requestedBy: message }])).toEqual({
      kind: "refused",
      problem: { kind: "not_given", field: "imprint" }
    });
    expect(decide(message, [{ field: "imprint", action: "set", text: "Lantern", requestedBy: message }])).toEqual({
      kind: "change",
      patch: { imprint: "Lantern" }
    });
    // The current byline is the reader's own word for the holder.
    const holder = "put my author name on the copyright line";
    expect(
      decide(holder, [{ field: "copyrightHolder", action: "set", text: "Ana Ruiz", requestedBy: holder }])
    ).toEqual({ kind: "change", patch: { copyrightHolder: "Ana Ruiz" } });
  });

  it("matches a name, publisher or holder on whole words, and a script without spaces inside the text", () => {
    const sunrise = "change the publisher to the one from Sunrise that pressed my first book";
    expect(decide(sunrise, [{ field: "imprint", action: "set", text: "Sun Press", requestedBy: sunrise }])).toEqual({
      kind: "refused",
      problem: { kind: "not_given", field: "imprint" }
    });
    const japanese = "出版社を山田出版にして";
    expect(decide(japanese, [{ field: "imprint", action: "set", text: "山田出版", requestedBy: japanese }])).toEqual({
      kind: "change",
      patch: { imprint: "山田出版" }
    });
    // Arabic and Persian keyboards spell yeh differently; it is one letter to the reader.
    const persian = "ناشر را علي کن";
    expect(decide(persian, [{ field: "imprint", action: "set", text: "علی", requestedBy: persian }])).toEqual({
      kind: "change",
      patch: { imprint: "علی" }
    });
  });

  it("prints only a website the reader typed, as a whole address", () => {
    const parsa = "add my website — I'm Parsa, a developer";
    expect(decide(parsa, [{ field: "authorWebsite", action: "set", text: "parsa.dev", requestedBy: "add my website" }])).toEqual({
      kind: "refused",
      problem: { kind: "not_given", field: "authorWebsite" }
    });
    const typed = "add my website sam.dev";
    expect(decide(typed, [{ field: "authorWebsite", action: "set", text: "sam.dev/about", requestedBy: typed }])).toEqual({
      kind: "refused",
      problem: { kind: "not_given", field: "authorWebsite" }
    });
    expect(decide(typed, [{ field: "authorWebsite", action: "set", text: "https://www.sam.dev/", requestedBy: typed }])).toEqual({
      kind: "change",
      patch: { authorWebsite: "sam.dev" }
    });
    const path = "my website is sam.dev/books";
    expect(decide(path, [{ field: "authorWebsite", action: "set", text: "sam.dev", requestedBy: path }])).toEqual({
      kind: "change",
      patch: { authorWebsite: "sam.dev" }
    });
  });

  it("refuses a name in a dedication the reader never gave, and keeps every one they did", () => {
    const mom = "dedicate it to my mom";
    const refused = { kind: "refused", problem: { kind: "not_given", field: "dedication" } };
    for (const text of [
      "For my mother, Maria Elena Ruiz, who taught me to read",
      "For my mom. This one is for Maria too.",
      "For my mom. Maria, this one is yours.",
      "For Mom and Dad"
    ]) {
      expect(decide(mom, [{ field: "dedication", action: "set", text, requestedBy: mom }]), text).toEqual(refused);
    }
    expect(decide("dedicate it to my doctor", [{ field: "dedication", action: "set", text: "For Dr. Smith who saved me", requestedBy: "dedicate it to my doctor" }])).toEqual(refused);
    for (const [message, text] of [
      ["mention my sister in the dedication too", "For Mom and my sister"],
      ["dedicate it to my mother", "For Mom"],
      ['change the dedication to "For Maria Elena, with love."', "For Maria Elena, with love."],
      ["dedicate it to Dr. Smith", "For Dr. Smith"],
      [mom, "Para mi mamá"],
      [mom, "Моей маме"],
      ["تقدیم‌نامه را به مادرم تقدیم کن", "تقدیم به مادرم"]
    ] as Array<[string, string]>) {
      expect(decideReviewed(message, [{ field: "dedication", action: "set", text, requestedBy: message }]), text).toEqual({
        kind: "change",
        patch: { dedication: text }
      });
    }
    // German capitalises every noun, so a capital there is no sign of a name.
    expect(
      normalizeBookMatterChatAnswer(answer([{ field: "dedication", action: "set", text: "Für meine Mama", requestedBy: mom }]), {
        message: mom,
        current,
        bookLanguage: "de"
      })
    ).toEqual({ kind: "change", patch: { dedication: "Für meine Mama" } });
  });

  it("refuses a biography that adds a fact, and keeps one made of the reader's", () => {
    const facts = "write my bio: I was born in Ohio, I teach chemistry and I have written two novels";
    const bio = (text: string, message = facts, reviewed = false) =>
      (reviewed ? decideReviewed : decide)(message, [{ field: "aboutAuthor", action: "set", text, requestedBy: "write my bio" }]);
    expect(bio("Born in Ohio, Ana Ruiz teaches chemistry. She has written two novels.", facts, true)).toEqual({
      kind: "change",
      patch: { aboutAuthor: "Born in Ohio, Ana Ruiz teaches chemistry. She has written two novels." }
    });
    for (const text of [
      "Ana Ruiz teaches chemistry in Ohio. A Harvard graduate, she has written two novels.",
      "An award-winning teacher, Ana Ruiz trained at Stanford."
    ]) {
      expect(bio(text), text).toEqual({ kind: "refused", problem: { kind: "not_given", field: "aboutAuthor" } });
    }
    // A sentence's first word stays exempt from the capital heuristic, but a
    // novel biographical claim still needs an independent semantic review.
    expect(bio("Award-winning teacher Ana Ruiz teaches chemistry in Ohio.").kind).toBe("refused");
    // A number is a whole number the reader typed: 20 is not in 2020.
    expect(bio("Ana Ruiz has taught chemistry for 20 years.", "write my bio: I've taught chemistry since 2020")).toEqual({
      kind: "refused",
      problem: { kind: "not_given", field: "aboutAuthor" }
    });
  });

  it("keeps a no-break or ideographic space in a one-line field, and folds a line break", () => {
    const nbsp = String.fromCharCode(0xa0);
    const ideographic = String.fromCharCode(0x3000);
    for (const name of [`Ana${nbsp}Ruiz`, `山田${ideographic}太郎`]) {
      const message = `change the author name to ${name}`;
      expect(decide(message, [{ field: "authorName", action: "set", text: name, requestedBy: message }])).toEqual({
        kind: "change",
        patch: { authorName: name }
      });
    }
    const message = "change the author name to Sam Lee";
    expect(decide(message, [{ field: "authorName", action: "set", text: "Sam\nLee", requestedBy: message }])).toEqual({
      kind: "change",
      patch: { authorName: "Sam Lee" }
    });
  });

  it("refuses a number in a biography the reader never gave", () => {
    const message = "write my bio: I teach chemistry in Ohio";
    expect(
      decide(message, [
        { field: "aboutAuthor", action: "set", text: "Ana Ruiz has taught chemistry in Ohio for 20 years.", requestedBy: message }
      ])
    ).toEqual({ kind: "refused", problem: { kind: "not_given", field: "aboutAuthor" } });
    expect(
      decideReviewed(message, [{ field: "aboutAuthor", action: "set", text: "Ana Ruiz teaches chemistry in Ohio.", requestedBy: message }])
    ).toEqual({ kind: "change", patch: { aboutAuthor: "Ana Ruiz teaches chemistry in Ohio." } });
  });

  it("holds every field to its printed length", () => {
    const message = `dedication: ${"x".repeat(2_001)}`;
    expect(decide(message, [{ field: "dedication", action: "set", text: "x".repeat(2_001), requestedBy: "dedication" }])).toEqual({
      kind: "refused",
      problem: { kind: "too_long", field: "dedication", length: 2_001, limit: 2_000 }
    });
  });

  it("prints a website the way the reader typed it", () => {
    const message = "add my website sam.dev";
    expect(decide(message, [{ field: "authorWebsite", action: "set", text: "https://sam.dev/", requestedBy: message }])).toEqual({
      kind: "change",
      patch: { authorWebsite: "sam.dev" }
    });
  });

  it("keeps a byline change asked for the way people ask, and none asked of the About the Author page", () => {
    for (const [message, text] of [
      ["change author to Sam Lee", "Sam Lee"],
      ["Author: Sam Lee", "Sam Lee"],
      ["use Sam Lee as the author", "Sam Lee"],
      ["put Sam Lee as author", "Sam Lee"],
      ["change the writer to Sam Lee", "Sam Lee"],
      ["نویسنده رو بذار سام لی", "سام لی"],
      ["غيّر المؤلف إلى سام لي", "سام لي"],
      ["make the author Sam Lee", "Sam Lee"],
      ["Sam Lee is the author", "Sam Lee"],
      ["add Sam Lee as co-author", "Ana Ruiz and Sam Lee"],
      ["the book is by Sam Lee", "Sam Lee"],
      ["credit the book to Sam Lee", "Sam Lee"]
    ] as Array<[string, string]>) {
      expect(decide(message, [{ field: "authorName", action: "set", text, requestedBy: message }]), message).toEqual({
        kind: "change",
        patch: { authorName: text }
      });
    }
    // These name About the Author, so a byline change is not the one they asked for.
    for (const message of [
      "update the about the author to say I'm Sam Lee",
      "the author's note should be signed Sam Lee",
      "about the author: Sam Lee"
    ]) {
      expect(decide(message, [{ field: "authorName", action: "set", text: "Sam Lee", requestedBy: message }]), message).toEqual({
        kind: "none",
        reason: "not_matter"
      });
    }
    // These name no field: the router sent them here, so an only change stands, and the
    // reply names it; beside a second change neither is asked for.
    for (const message of ["rewrite page 2 as the author would, Sam Lee", "remove the writers block scene Sam Lee wrote"]) {
      const byline = { field: "authorName" as const, action: "set" as const, text: "Sam Lee", requestedBy: message };
      expect(decide(message, [byline]), message).toEqual({ kind: "change", patch: { authorName: "Sam Lee" } });
      expect(decide(message, [byline, { field: "copyrightHolder", action: "set", text: "Sam Lee", requestedBy: message }]), message).toEqual({
        kind: "none",
        reason: "not_matter"
      });
    }
  });

  it.each([
    ["en", "and", "Add Sam Lee as coauthor"],
    ["es", "y", "Añade Sam Lee como coautor"],
    ["fr", "et", "Ajoute Sam Lee comme coauteur"],
    ["de", "und", "Füge Sam Lee als Koautor hinzu"],
    ["it", "e", "Aggiungi Sam Lee come coautore"],
    ["pt", "e", "Adicione Sam Lee como coautor"],
    ["nl", "en", "Voeg Sam Lee toe als coauteur"],
    ["tr", "ve", "Sam Lee adlı kişiyi ortak yazar olarak ekle"],
    ["ru", "и", "Добавь Sam Lee в качестве соавтора"],
    ["uk", "і", "Додай Sam Lee як співавтора"],
    ["uk", "й", "Додай Sam Lee як співавтора"],
    ["uk", "та", "Додай Sam Lee як співавтора"],
    ["pl", "i", "Dodaj Sam Lee jako współautora"],
    ["el", "και", "Πρόσθεσε τον Sam Lee ως συνσυγγραφέα"],
    ["sv", "och", "Lägg till Sam Lee som medförfattare"],
    ["no", "og", "Legg til Sam Lee som medforfatter"],
    ["da", "og", "Tilføj Sam Lee som medforfatter"],
    ["fa", "و", "Sam Lee را به عنوان نویسنده اضافه کن"],
    ["ar", "و", "أضف Sam Lee كمؤلف مشارك"],
    ["ur", "اور", "Sam Lee کو شریک مصنف کے طور پر شامل کریں"],
    ["he", "ו", "הוסף את Sam Lee כמחבר שותף"],
    ["hi", "और", "Sam Lee को सहलेखक के रूप में जोड़ें"],
    ["zh", "和", "添加 Sam Lee 为共同作者"],
    ["ja", "と", "Sam Lee を共著者として追加して"],
    ["ko", "및", "Sam Lee 를 공동 저자로 추가해 주세요"],
    ["th", "และ", "เพิ่ม Sam Lee เป็นผู้เขียนร่วม"],
    ["vi", "và", "Thêm Sam Lee làm đồng tác giả"]
  ])("joins grounded coauthors in %s with %s without inventing a name", (bookLanguage, joiner, message) => {
    const byline = (text: string) => normalizeBookMatterChatAnswer(
      answer([{ field: "authorName", action: "set", text, requestedBy: message }]),
      { message, current, bookLanguage }
    );
    const text = `Ana Ruiz ${joiner} Sam Lee`;
    expect(byline(text)).toEqual({ kind: "change", patch: { authorName: text } });
    expect(byline(`Ana Ruiz ${joiner} Sam Rivers`)).toEqual({
      kind: "refused", problem: { kind: "not_given", field: "authorName" }
    });
    expect(byline(joiner)).toEqual({
      kind: "refused", problem: { kind: "not_given", field: "authorName" }
    });
  });

  it("does not read an invented middle initial as a localized conjunction", () => {
    const message = "Add Sam Lee as coauthor";
    for (const bookLanguage of ["en", "es", "pl"]) {
      for (const text of ["Sam E. Lee", "Sam I. Lee", ...(bookLanguage === "en" ? ["Sam e Lee", "Sam i Lee"] : [])]) {
        expect(normalizeBookMatterChatAnswer(
          answer([{ field: "authorName", action: "set", text, requestedBy: message }]),
          { message, current, bookLanguage }
        )).toEqual({ kind: "refused", problem: { kind: "not_given", field: "authorName" } });
      }
    }
  });

  it.each(["Spanish", "es-MX"])("only adds a localized connector between grounded names for %s", (bookLanguage) => {
    const message = "Añade Ismael Lee como coautor";
    const byline = (text: string) => normalizeBookMatterChatAnswer(
      answer([{ field: "authorName", action: "set", text, requestedBy: message }]),
      { message, current, bookLanguage }
    );
    expect(byline("Ana Ruiz e Ismael Lee")).toEqual({
      kind: "change", patch: { authorName: "Ana Ruiz e Ismael Lee" }
    });
    for (const text of ["e Ana Ruiz", "Ana Ruiz e", "Ana Ruiz e e Ismael Lee"]) {
      expect(byline(text)).toEqual({ kind: "refused", problem: { kind: "not_given", field: "authorName" } });
    }
  });

  it("reads what follows a field's colon as the field's words, and still sees a request spoken to the editor there", () => {
    const message = "Add a dedication: For my mom. Also redo the cover.";
    const dedication = (text: string) => [{ field: "dedication" as const, action: "set" as const, text, requestedBy: "Add a dedication" }];
    // The model reported nothing left over; the cover is still named back.
    expect(decide(message, dedication("For my mom"))).toEqual({ kind: "change", patch: { dedication: "For my mom" }, unhandledUnquoted: true });
    // The model printed the whole tail: the reader's words, but not words to print.
    expect(decide(message, dedication("For my mom. Also redo the cover."))).toEqual({
      kind: "refused",
      problem: { kind: "runs_on", field: "dedication" },
      unhandledUnquoted: true
    });
    expect(bookMatterMessageHasSeparateRequest(message)).toBe(true);
    expect(bookMatterMessageHasSeparateRequest("Add a dedication: For my mom\nredo the cover")).toBe(true);
    // The fake composer's first garble, now refused rather than printed.
    expect(
      decide("dedicate it to my mom and redo the cover", [
        { field: "dedication", action: "set", text: "For my mom and redo the cover", requestedBy: "dedicate it to my mom" }
      ])
    ).toEqual({ kind: "refused", problem: { kind: "runs_on", field: "dedication" }, unhandledUnquoted: true });
    // A dedication's own lines after the colon are still the dedication's.
    for (const [said, text] of [
      ["change the dedication to: For Mom. Make every day count.", "For Mom. Make every day count."],
      ["dedication: For Dr. Smith, who saved my life", "For Dr. Smith, who saved my life"],
      ["add a dedication: For my kids. Keep reading, keep dreaming.", "For my kids. Keep reading, keep dreaming."]
    ] as Array<[string, string]>) {
      expect(decide(said, [{ field: "dedication", action: "set", text, requestedBy: said }]), said).toEqual({ kind: "change", patch: { dedication: text } });
    }
  });

  it("reads a dedication's own lines about drawing or pictures as the dedication, after a colon, a line break or neither", () => {
    // The review's probe: each was refused as `runs_on` because "drawing" or
    // "pictures" made its line a request about the book's pictures.
    for (const [said, text] of [
      ["Add a dedication: For my daughter. Keep drawing.", "For my daughter. Keep drawing."],
      ["Dedication: For young artists. Draw pictures every day.", "For young artists. Draw pictures every day."],
      ["Add a dedication: For Ana. Keep the pictures in your heart.", "For Ana. Keep the pictures in your heart."],
      ["Dedication:\nFor my daughter\nKeep drawing", "For my daughter\nKeep drawing"],
      ["Dedication:\n\nFor my son\n\nUse your imagination. Change the world.", "For my son\n\nUse your imagination. Change the world."],
      ["dedicate it to my daughter. Keep drawing.", "For my daughter. Keep drawing."],
      ["dedicate it to my kids, keep making art", "For my kids. Keep making art."]
    ] as Array<[string, string]>) {
      expect(decide(said, [{ field: "dedication", action: "set", text, requestedBy: said }]), said).toEqual({ kind: "change", patch: { dedication: text } });
    }
  });

  it("still sees a request spoken to the editor after a colon, and one that leads with then or also", () => {
    const dedication = (said: string, text: string) => decide(said, [{ field: "dedication", action: "set", text, requestedBy: said }]);
    for (const said of [
      "Dedication: For my mom. Please redo the cover.",
      "Dedication:\nFor my mom\nAlso make page 2 shorter",
      "Dedication: For my mom. Then fix the typos.",
      "Add a dedication: For my mom. Can you rewrite chapter 3 too?",
      "Dedication: For my mom. Draw the pictures in the book again."
    ]) {
      expect(dedication(said, "For my mom"), said).toEqual({ kind: "change", patch: { dedication: "For my mom" }, unhandledUnquoted: true });
      expect(bookMatterMessageHasSeparateRequest(said), said).toBe(true);
    }
    // "then" stays on its clause, so the lead is read: printed whole, the value runs on.
    expect(dedication("dedicate it to my mom then fix the typos", "For my mom then fix the typos")).toEqual({
      kind: "refused",
      problem: { kind: "runs_on", field: "dedication" },
      unhandledUnquoted: true
    });
    expect(dedication("dedicate it to my mom, also fix the typos", "For my mom")).toEqual({
      kind: "change",
      patch: { dedication: "For my mom" },
      unhandledUnquoted: true
    });
  });

  it("names nothing left over when a biography retells the reader's own words", () => {
    const bio = (said: string, text: string) => decideReviewed(said, [{ field: "aboutAuthor", action: "set", text, requestedBy: said }]);
    for (const [said, text] of [
      // After a field-naming colon only a request spoken to the editor is one.
      ["Bio: I'm a nurse. I write poetry and make quilts.", "Ana Ruiz is a nurse. She writes poetry and makes quilts."],
      ["Bio: I garden, cook and write children's books.", "Ana Ruiz gardens, cooks and writes children's books."],
      ["Bio: I build furniture and fix old boats.", "Ana Ruiz builds furniture and fixes old boats."],
      ["Bio: I build furniture and fix old boats.", "Ana Ruiz restores old boats and builds furniture."],
      // Without a colon, a clause the bio printed — inflected, pronouns swapped — is content.
      ["update my bio to say I build furniture and fix old boats", "Ana Ruiz builds furniture and fixes old boats."],
      ["write my bio, I teach yoga and write my own songs", "Ana Ruiz teaches yoga and writes her own songs."],
      ["change my bio to say I keep bees, make jam and draw comics", "Ana Ruiz keeps bees, makes jam and draws comics."],
      ["my bio should say I'm a pilot who keeps chickens and fixed up an old farmhouse", "Ana Ruiz is a pilot who keeps chickens and fixed up an old farmhouse."]
    ] as Array<[string, string]>) {
      expect(bio(said, text), said).toEqual({ kind: "change", patch: { aboutAuthor: text } });
    }
    expect(bio("Bio: I'm a nurse. Also redo the cover.", "Ana Ruiz is a nurse.")).toEqual({
      kind: "change",
      patch: { aboutAuthor: "Ana Ruiz is a nurse." },
      unhandledUnquoted: true
    });
    // A clause the bio did not print is still a request of its own.
    expect(bio("update my bio to say I build furniture and fix the typos on page 3", "Ana Ruiz builds furniture.")).toMatchObject({ unhandledUnquoted: true });
  });

  it("reads the reader's own I also … as content, and a refinement of the change as no request of its own", () => {
    const set = (field: "dedication" | "aboutAuthor", said: string, text: string, reviewed = false) =>
      (reviewed ? normalizeReviewedMatterAnswer : normalizeBookMatterChatAnswer)(answer([{ field, action: "set", text, requestedBy: said }]), { message: said, current: { ...current, dedication: null } });
    // The round-6 review's probe: a spurious note on each, and the two dedications refused as `runs_on`.
    for (const [field, said, text] of [
      ["aboutAuthor", "Bio: I'm a teacher. I also write poetry.", "Ana Ruiz is a teacher. She also writes poetry."],
      ["aboutAuthor", "Write my bio, I'm a florist and I also give workshops", "Ana Ruiz is a florist who also gives workshops."],
      ["aboutAuthor", "Bio: I'm a nurse. I also make quilts, draw maps, illustrate zines, translate poems and keep bees.", "Ana Ruiz is a nurse who makes quilts, draws maps, illustrates zines, translates poems and keeps bees."],
      ["dedication", "Dedication: For Grandpa, who taught me to fish. I also keep your old hat.", "For Grandpa, who taught me to fish. I also keep your old hat."],
      ["dedication", "Dedication: For Grandma. We also keep your garden growing.", "For Grandma. We also keep your garden growing."],
      ["dedication", "Dedicate it to my mom. Also add my dad.", "For my mom and dad"],
      ["dedication", "dedicate it to my mom, then add my dad too", "For my mom and dad"],
      ["aboutAuthor", "write my bio: I teach math. Use her name, Rosa", "Rosa teaches math."],
      ["aboutAuthor", "write my bio, I teach math. Use third person", "Ana Ruiz teaches math."],
      ["aboutAuthor", "write my bio, I'm 34 and teach math. Keep my age out of it", "Ana Ruiz teaches math."],
      // Round-6 P2: "please / will you" among a dedication's own words is the dedication's.
      ["dedication", "Dedication: For my daughter. Please keep drawing.", "For my daughter. Please keep drawing."],
      ["dedication", "Dedication: For Mom. Will you keep dreaming for me?", "For Mom. Will you keep dreaming for me?"],
      ["dedication", "Dedication: For Grandpa. Please write to me.", "For Grandpa. Please write to me."]
    ] as Array<["dedication" | "aboutAuthor", string, string]>) {
      expect(set(field, said, text, true), said).toEqual({ kind: "change", patch: { [field]: text } });
    }
    // A request of another kind is still named — and a refinement that names
    // nothing the change printed, or a word the rest of the message gave it, is one.
    for (const [field, said, text] of [
      ["dedication", "Dedicate it to my mom. Also make the villain scarier.", "For my mom"],
      ["dedication", "Dedicate it to my mom. Also add my dad as a character", "For my mom and dad"],
      ["aboutAuthor", "Bio: I love dogs. Also add a dog.", "Ana Ruiz loves dogs."],
      ["dedication", "Dedicate it to my mom. Also use a scary voice for the villain", "For my mom"],
      ["dedication", "Dedication: For my mom. Then fix the typos.", "For my mom"],
      ["dedication", "Dedication: For my mom. Please fix the typos.", "For my mom"],
      ["aboutAuthor", "write my bio, I'm a nurse and then fix the typos", "Ana Ruiz is a nurse."],
      ["aboutAuthor", "Bio: I'm a nurse. I also want you to redo the cover.", "Ana Ruiz is a nurse."]
    ] as Array<["dedication" | "aboutAuthor", string, string]>) {
      expect(set(field, said, text, true), said).toEqual({ kind: "change", patch: { [field]: text }, unhandledUnquoted: true });
    }
    // A value that pastes a request spoken to the editor is still refused.
    for (const [field, said, text] of [
      ["dedication", "Dedication: For my mom. Also add my dad.", "For my mom. Also add my dad."],
      ["aboutAuthor", "Bio: I teach math. Also use third person.", "I teach math. Also use third person."],
      ["dedication", "Dedication: For my mom. Please redo the cover.", "For my mom. Please redo the cover."]
    ] as Array<["dedication" | "aboutAuthor", string, string]>) {
      expect(set(field, said, text), said).toMatchObject({ kind: "refused", problem: { kind: "runs_on", field } });
    }
    expect(bookMatterMessageHasSeparateRequest("Dedication: For Grandpa, who taught me to fish. I also keep your old hat.")).toBe(false);
  });

  it("reads a name's initials as part of it, and a field named only by its colon as the matter", () => {
    // Round 7: "S." split "use S. J. Lee there" into a request "use S" the change never printed.
    const message = "use S. J. Lee there and on the copyright line too";
    const changes: Change[] = [
      { field: "authorName", action: "set", text: "S. J. Lee", requestedBy: "use S. J. Lee there" },
      { field: "copyrightHolder", action: "set", text: "S. J. Lee", requestedBy: "on the copyright line too" }
    ];
    // A follow-up to a byline change: "there" is the byline the last reply set.
    expect(
      normalizeBookMatterChatAnswer(answer(changes), { message, current: { ...current, authorName: "Sam Lee" }, lastTurnFields: ["authorName"] })
    ).toEqual({ kind: "change", patch: { authorName: "S. J. Lee", copyrightHolder: "S. J. Lee" } });
    // And the old byline a change replaces is the reader's word for it.
    const replace = "Replace Ana Ruiz with Sam Lee and remove the dedication";
    expect(
      decide(replace, [
        { field: "authorName", action: "set", text: "Sam Lee", requestedBy: "Replace Ana Ruiz with Sam Lee" },
        { field: "dedication", action: "remove", requestedBy: "remove the dedication" }
      ])
    ).toEqual({ kind: "change", patch: { authorName: "Sam Lee", dedication: null } });
    // A sentence that ends on an initial still ends before a request of its own.
    expect(bookMatterMessageHasSeparateRequest("Dedicate it to my son J. Make page 2 shorter.")).toBe(true);
    // "Author:" names the byline only with its colon, and the split used to read it without.
    expect(bookMatterMessageHasSeparateRequest("Author: J. R. Ellis. Redo the cover.")).toBe(true);
    expect(bookMatterMessageHasSeparateRequest("Author: J. R. Ellis.")).toBe(false);
  });

  it("reads None., N/A and their like as nothing left over", () => {
    const message = "dedicate it to my mom";
    const dedication = [{ field: "dedication" as const, action: "set" as const, text: "For my mom", requestedBy: message }];
    for (const unhandled of ["None.", "none", "N/A", "n/a.", "Nothing.", "null", "", "(none)", "Nothing else."]) {
      expect(decide(message, dedication, { unhandled }), unhandled).toEqual({ kind: "change", patch: { dedication: "For my mom" } });
    }
  });

  it("reads a message of thousands of colons in linear time", () => {
    // The review's probe blocked the event loop for 4.8 s: one backward
    // search per colon, each quadratic in the text before it.
    for (const message of [
      `dedication ${"a".repeat(2_400)}.${":".repeat(2_580)}`,
      `dedication ${"a".repeat(4_800)}.${":".repeat(5_180)}`,
      "a:".repeat(5_000),
      "make.".repeat(2_000)
    ]) {
      const started = performance.now();
      bookMatterMessageHasSeparateRequest(message);
      decide(message, [{ field: "dedication", action: "set", text: "For my mom", requestedBy: "dedication" }]);
      expect(performance.now() - started, message.slice(0, 20)).toBeLessThan(1_000);
    }
  });

  it("reads a subject before also as its own sentence, a line about the book to the dedicatee as the dedication, and change … to as a colon", () => {
    // The round-8 review's probe: each was refused as `runs_on`, and sending the same words again was refused again.
    const set = (field: "dedication" | "aboutAuthor" | "imprint", said: string, text: string, reviewed = false) =>
      (reviewed ? normalizeReviewedMatterAnswer : normalizeBookMatterChatAnswer)(answer([{ field, action: "set", text, requestedBy: said }]), { message: said, current: { ...current, dedication: null } });
    for (const [field, said, text] of [
      ["aboutAuthor", "Bio: Ana Ruiz is a nurse in Leeds. She and her husband also make cheese on weekends.", "Ana Ruiz is a nurse in Leeds. She and her husband also make cheese on weekends."],
      ["aboutAuthor", "Bio: Ana and her husband Tom also make wooden toys.", "Ana and her husband Tom also make wooden toys."],
      ["aboutAuthor", "Bio: I'm a nurse. The two of them also keep bees.", "Ana Ruiz is a nurse. The two of them also keep bees."],
      ["dedication", "Dedication: For my team. Coffee and kindness also keep us going.", "For my team. Coffee and kindness also keep us going."],
      ["dedication", "Dedication: For my kids. Good stories also make good people.", "For my kids. Good stories also make good people."],
      ["dedication", "Dedication: For the nurses. Nurses like you also make miracles happen.", "For the nurses. Nurses like you also make miracles happen."],
      ["dedication", "dedicate it to my grandma, who taught me that books also make friends", "For my grandma, who taught me that books also make friends."],
      ["dedication", "Dedication: For Mia. Keep the pictures in this book close to your heart.", "For Mia. Keep the pictures in this book close to your heart."],
      ["dedication", "Change the dedication to For my students. Please keep asking questions.", "For my students. Please keep asking questions."],
      ["aboutAuthor", "Change my bio to I'm a nurse and my kids also draw", "Ana Ruiz is a nurse, and her kids also draw."],
      // Found after the measured set passed: an appositive between commas, and a new subject after "and".
      ["aboutAuthor", "write my bio, my kids, Ava and Leo, also draw dragons", "Her kids, Ava and Leo, also draw dragons."],
      ["aboutAuthor", "write my bio, my parents, both teachers, also make me read", "Her parents, both teachers, also make her read."],
      ["dedication", "dedicate it to my mom and my kids also draw", "For my mom. My kids also draw."]
    ] as Array<["dedication" | "aboutAuthor", string, string]>) {
      expect(set(field, said, text, true), said).toEqual({ kind: "change", patch: { [field]: text } });
    }
    // Still the editor's: a request "you can also" make of the book, and one after "change … to".
    for (const [field, said, text] of [
      ["dedication", "Dedication: For you. You can also redo the cover.", "For you. You can also redo the cover."],
      ["dedication", "Change the dedication to For my mom. Also redo the cover.", "For my mom. Also redo the cover."],
      ["imprint", "change the publisher to Lantern then make page 2 shorter", "Lantern then make page 2 shorter"],
      ["dedication", "dedicate it to my mom and dad then fix the typos", "For my mom and dad then fix the typos"]
    ] as Array<["dedication" | "imprint", string, string]>) {
      expect(set(field, said, text), said).toEqual({ kind: "refused", problem: { kind: "runs_on", field }, unhandledUnquoted: true });
      expect(bookMatterMessageHasSeparateRequest(said), said).toBe(true);
    }
    expect(set("dedication", "change the dedication to my mom and fix the typos", "For my mom")).toMatchObject({ unhandledUnquoted: true });
  });

  it("passes a question through, and reads a reasonless none as nothing to change", () => {
    expect(
      normalizeBookMatterChatAnswer(bookMatterChatAnswerSchema.parse({ outcome: "question", question: "What is the ISBN?" }), {
        message: "add an ISBN",
        current
      })
    ).toEqual({ kind: "question", question: "What is the ISBN?" });
    expect(
      normalizeBookMatterChatAnswer(bookMatterChatAnswerSchema.parse({ outcome: "none", noneReason: "title_page" }), {
        message: "remove the title page",
        current
      })
    ).toEqual({ kind: "none", reason: "title_page" });
    expect(
      normalizeBookMatterChatAnswer(bookMatterChatAnswerSchema.parse({ outcome: "question" }), { message: "hm", current })
    ).toEqual({ kind: "none", reason: "not_matter" });
  });
});

describe("the composer's prompt", () => {
  it("shows the book's matter as it prints now, and says when the question is spent", () => {
    const [system, user] = bookMatterChatMessages({
      message: "mention my sister too",
      current,
      bookLanguage: "fa",
      copyrightLine: "© 2026 Ana Ruiz",
      alreadyAskedOnce: true,
      recentConversation: [{ role: "user", content: "change the dedication" }],
      printedFrontMatter: [{ page: 2, holds: "the dedication and publication page" }]
    });
    expect(system!.content).toMatch(/Never invent facts/);
    expect(system!.content).toContain("conversation language, never bookLanguage");
    expect(system!.content).toContain("Quoted text to print, names, ISBNs and websites are data");
    expect(system!.content).toMatch(/points back at the change in recentConversation/);
    expect(system!.content).toMatch(/A change of a field the reader did not ask for is ignored/);
    expect(system!.content).toMatch(/Do not ask again/);
    const body = JSON.parse(user!.content);
    expect(body).toMatchObject({
      readerMessage: "mention my sister too",
      currentMatter: { dedication: "For Mom", authorName: "Ana Ruiz" },
      copyrightLineNow: "© 2026 Ana Ruiz",
      alreadyAskedOnce: true,
      printedFrontMatter: [{ page: 2 }]
    });
    expect(body.bookLanguage).not.toBe("fa");
  });
});
