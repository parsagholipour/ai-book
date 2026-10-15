import { describe, expect, it } from "vitest";

import { bookMatterChatAnswerSchema, bookMatterMessageHasSeparateRequest, normalizeBookMatterChatAnswer } from "./bookMatterChatEdit.js";
import { bookMatterFieldsNamedIn, instructsTheChange, looselyQuotedFrom, looseQuotable, namesField, normalizeIsbn, quotedFrom } from "./bookMatterWords.js";

describe("ISBNs", () => {
  it.each([
    ["978-0-306-40615-7", "978-0-306-40615-7"],
    ["ISBN-13: 978 0 306 40615 7", "978 0 306 40615 7"],
    ["0-8044-2957-X", "0-8044-2957-X"],
    ["۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷", "۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷"],
    // A 10 or 13 a digit follows is the number's, not the label's.
    ["ISBN 1040123457", "1040123457"],
    ["ISBN 1302015435", "1302015435"]
  ])("reads %j", (typed, printed) => {
    expect(normalizeIsbn(typed)?.printed).toBe(printed);
  });

  it("separates the supplied spelling from the normalized checksum and grounding value", () => {
    expect(normalizeIsbn("ISBN-۱۳: ۹۷۸–۰–۳۰۶–۴۰۶۱۵–۷")).toEqual({
      printed: "۹۷۸–۰–۳۰۶–۴۰۶۱۵–۷",
      compact: "9780306406157"
    });
  });

  it.each(["978-0-306-40615-8", "12345", "978030640615", "0-8044-2957-1"])("refuses %j", (typed) => {
    expect(normalizeIsbn(typed)).toBeNull();
  });
});

describe("the fields a message names", () => {
  it.each([
    ["remove my ex's name from the dedication", ["dedication"]],
    ["change the author name to Sam Lee", ["authorName"]],
    ["change the publisher to X", ["imprint"]],
    ["remove all rights reserved", ["allRightsReserved"]],
    ["add an ISBN 978…", ["isbn"]],
    ["remove the About the Author page", ["aboutAuthor"]],
    ["it would be lovely if the book honoured my mum", []],
    ["change the copyright holder to Sam Lee", ["copyrightHolder"]],
    ["تقدیمش کن به مادرم", ["dedication"]],
    ["بیوگرافی من را بنویس", ["aboutAuthor"]],
    ["ناشر را عوض کن", ["imprint"]],
    ["صاحب حق نشر را سام کن", ["copyrightHolder"]],
    ["کلیه حقوق محفوظ است را بردار", ["allRightsReserved"]],
    ["اسمم را سام بگذار", ["authorName"]],
    ["اجعل الإهداء إلى أمي", ["dedication"]],
    ["dedica el libro a mi madre", ["dedication"]],
    ["dedícalo a mi mamá", ["dedication"]],
    ["著作権者を山田にして", ["copyrightHolder"]],
    ["the ISBN is 978-0-306-40615-7", ["isbn"]]
  ])("%j names %j", (message, fields) => {
    expect([...bookMatterFieldsNamedIn(message)].sort()).toEqual([...fields].sort());
  });

  // The review's probe: each of these was sent to `book_matter`, quoted
  // correctly by the composer, and dropped because no cue named the byline.
  it.each([
    "change author to Sam Lee",
    "Author: Sam Lee",
    "use Sam Lee as the author",
    "put Sam Lee as author",
    "change the writer to Sam Lee",
    "replace the author with Sam Lee",
    "list me as the book's author",
    "the author should be Sam Lee",
    "Writer: Sam Lee",
    "نویسنده رو بذار سام لی",
    "نویسنده: سام لی",
    "سام لی رو به عنوان نویسنده بذار",
    "نویسنده‌ی کتاب رو عوض کن",
    "غيّر المؤلف إلى سام لي",
    "المؤلف: سام لي",
    "ضع سام لي كمؤلف",
    // The second review's probe: each named nothing.
    "make the author Sam Lee",
    "make me the author",
    "Ana Ruiz is the author",
    "add Ana as co-author",
    "the book is by Sam Lee",
    "credit the book to Sam Lee",
    "I'm the author",
    "make Sam Lee the author",
    "the author of this book is Sam Lee",
    "credit Sam Lee as the author",
    "the book's by Sam Lee"
  ])("%j names the byline", (message) => {
    expect([...bookMatterFieldsNamedIn(message)]).toEqual(["authorName"]);
  });

  // "author" here is the About the Author page, a note, or page content —
  // never the byline.
  it.each([
    ["change the About the Author page", ["aboutAuthor"]],
    ["about the author: I teach math", ["aboutAuthor"]],
    ["about the author is too long", ["aboutAuthor"]],
    ["update the about the author to say I teach math", ["aboutAuthor"]],
    ["rewrite the author bio", ["aboutAuthor"]],
    ["change the author bio to say I teach math", ["aboutAuthor"]],
    ["the author's bio should mention Ohio", ["aboutAuthor"]],
    ["remove the author's note", ["aboutAuthor"]],
    ["change the author page", ["aboutAuthor"]],
    ["add a note from the author to readers", []],
    ["Note to the author: redo the cover", []],
    ["make the writer sound more confident on page 3", []],
    ["change the writer's voice", []],
    ["put the author photo on the back", []],
    ["dedicate it to the author", ["dedication"]],
    ["درباره نویسنده رو بنویس", ["aboutAuthor"]],
    ["درباره‌ی نویسنده رو عوض کن", ["aboutAuthor"]],
    ["بیوگرافی نویسنده را عوض کن", ["aboutAuthor"]],
    ["یادداشت نویسنده رو حذف کن", []],
    ["عن المؤلف: أنا معلم", ["aboutAuthor"]],
    ["كلمة المؤلف: شكرا", []],
    // "author" as a comparison, inside a compound, or the author of something else.
    ["write it as the author would", []],
    ["rewrite page 2 as the writer intended", []],
    ["remove the writers block scene", []],
    ["cut the authors event chapter", []],
    ["she is the author of two novels", []],
    ["She co-authored a textbook", []],
    ["make the main character a writer", []],
    ["make the author more likable", []],
    ["the book is by far the best thing I've written", []],
    ["change the author website to sam.dev", ["authorWebsite"]],
    ["Bio: I am a writer and teacher", ["aboutAuthor"]],
    ["نویسنده رو معرفی کن", ["aboutAuthor"]],
    ["نویسنده‌ی کتاب را معرفی کن", ["aboutAuthor"]]
  ])("%j does not name the byline", (message, fields) => {
    expect([...bookMatterFieldsNamedIn(message)].sort()).toEqual([...fields].sort());
  });

  // The round-6 review's probe: each was composed correctly and dropped,
  // because no cue named the byline. The unseen set is in the measured suite.
  it.each([
    "put Sam Lee on the title page",
    "put my name, Sam Lee, on the cover",
    "publish it as Sam Lee",
    "I want to publish it under the name Sam Lee",
    "under my pen name Sam Lee",
    "the book should be credited to Sam Lee",
    "the author needs to be Sam Lee",
    "the author must be Sam Lee",
    "list me as Sam Lee",
    "make it by Sam Lee",
    "سارا احمدی نویسنده کتاب است",
    "نویسنده‌ی کتاب سارا باشه",
    "cambia el autor a Sam Lee",
    "Autor: Sam Lee",
    "change l'auteur en Sam Lee",
    "Autorin: Sam Lee",
    "l'autore è Sam Lee",
    "o autor é Sam Lee",
    "mude o autor para Sam Lee"
  ])("%j names the byline", (message) => {
    expect([...bookMatterFieldsNamedIn(message)]).toEqual(["authorName"]);
  });

  // The new shapes' look-alikes, written with them and run once: a picture,
  // a format, a list, a deadline, the publisher, the author's voice, and
  // "author" in another language's About the Author, note, copyright or bio.
  it.each([
    ["put a picture on the title page", []],
    ["put a map on the title page", []],
    ["publish it as an ebook", []],
    ["publish it as a paperback", []],
    ["publish it as a PDF", []],
    ["list the chapters", []],
    ["list them as bullet points", []],
    ["make it by Friday", []],
    ["make it by next week", []],
    ["credited to the publisher", ["imprint"]],
    ["the book should be credited to the publisher", ["imprint"]],
    ["the author needs to be funnier", []],
    ["the author must be more careful with facts on page 4", []],
    ["credit the illustrator in the back", []],
    ["put Max on the cover", []],
    ["sobre la autora: soy maestra", ["aboutAuthor"]],
    ["quita la nota de la autora", []],
    ["es autora de tres novelas", []],
    ["los derechos de autor son míos", ["copyrightHolder"]],
    ["dedícalo al autor", ["dedication"]],
    ["à propos de l'auteure", ["aboutAuthor"]],
    ["elle est l'auteure de deux romans", []],
    ["droits d'auteur", ["copyrightHolder"]],
    ["über den Autor", ["aboutAuthor"]],
    ["Sie arbeitet als Autorin in Berlin", []],
    ["Ich arbeite als Autor", []],
    ["sull'autore", ["aboutAuthor"]],
    ["nota dell'autore", []],
    ["è autrice di due romanzi", []],
    ["diritti d'autore", ["copyrightHolder"]],
    ["sobre o autor", ["aboutAuthor"]],
    ["é autora de dois livros", []],
    ["direitos autorais", ["copyrightHolder"]],
    ["او نویسنده‌ی کتاب کودک است", []],
    ["من نویسنده‌ی کتاب‌های کودک هستم", []],
    ["درباره‌ی نویسنده‌ی کتاب است", ["aboutAuthor"]]
  ])("%j does not name the byline in the new shapes", (message, fields) => {
    expect([...bookMatterFieldsNamedIn(message)].sort()).toEqual([...fields].sort());
  });
});

describe("the loose cue words of the © holder and the website", () => {
  // Round 8: "owner", a bare "web" and a bare "site" named the © holder and the
  // website in 20 of 20 biography and dedication phrases written to test it.
  it.each([
    ["change the owner to Ruiz Media", ["copyrightHolder"]],
    ["Owner: Ruiz Media", ["copyrightHolder"]],
    ["the owner should be my company", ["copyrightHolder"]],
    ["make my company, Ruiz Media, the owner", ["copyrightHolder"]],
    ["I want my company to be the owner", ["copyrightHolder"]],
    ["the rights owner is Ruiz Media", ["copyrightHolder"]],
    ["list Ruiz Media as the owner", ["copyrightHolder"]],
    ["take the site off", ["authorWebsite"]],
    ["remove the web address", ["authorWebsite"]],
    ["drop the site link", ["authorWebsite"]],
    ["Site: anaruiz.com", ["authorWebsite"]],
    ["add my website", ["authorWebsite"]],
    ["change my site to anaruiz.net", ["authorWebsite"]]
  ])("%j names %j", (message, fields) => {
    expect([...bookMatterFieldsNamedIn(message)].sort()).toEqual([...fields].sort());
  });

  it.each([
    "I'm a small business owner",
    "a proud dog owner",
    "the owner of a small farm",
    "the bookshop owner who let me read for free",
    "my dad, the owner of a hardware store",
    "to be the owner of a bakery someday",
    "she worked as the owner's assistant",
    "a web designer by trade",
    "the web of friends who held me up",
    "an archaeological site in Peru",
    "she manages the site for our town library",
    "a construction site manager"
  ])("%j names neither", (message) => {
    expect([...bookMatterFieldsNamedIn(message)]).toEqual([]);
  });
});

describe("the round-7 byline cues, for a message that changes more than one field", () => {
  // A message that changes one field needs no cue (`bookMatterAskedFor.ts`);
  // these let a byline ride beside a second change.
  it.each([
    "Add Sam Lee as an author too",
    "add me as a second author",
    "Use my real name, Sam Lee",
    "use my full name",
    "I'd like it credited to Sam Lee",
    "Sign it as Sam Lee",
    "Sam Lee wrote this book",
    "نویسنده سارا احمدی باشه",
    "سارا احمدی رو نویسنده کن",
    "Escrito por Lucía Gómez",
    "Écrit par Claire Martin",
    "Geschrieben von Jonas Weber",
    "Scritto da Marco Rossi",
    "El libro es de Lucía Gómez",
    "das Buch ist von Jonas Weber",
    "Jonas Weber als zweiter Autor",
    "با نام سارا احمدی منتشرش کن"
  ])("%j names the byline", (message) => {
    expect([...bookMatterFieldsNamedIn(message)]).toEqual(["authorName"]);
  });

  it.each([
    "el libro es de aventuras",
    "das Buch ist von Anfang an spannend",
    "As an author, I love mysteries",
    "she works as a writer",
    "cast him as a writer in chapter 2",
    "the hero wrote it in her diary",
    "I wrote this book for my kids",
    "شخصیت اصلی رو نویسنده کن",
    "نویسنده خیلی مهربان به نظر برسه",
    "use her name, Rosa"
  ])("%j does not", (message) => {
    expect(bookMatterFieldsNamedIn(message).has("authorName")).toBe(false);
  });
});

/**
 * Every entry point that reads a message with a regular expression, on 10,000
 * characters built to make one backtrack: a long run after each cue word, runs
 * of spaces and separators, and mixed scripts. "Remove the title page. Use her
 * name " and 4,960 letters once took 97 s on the event loop, which no time box
 * around the model call can interrupt. Each input is first read at 1,000
 * characters, so a pattern gone super-linear fails here rather than hanging
 * (the original took 6 s at 1,000). Round 8 added runs a capital starts inside
 * — after "’", "'", "-" or a combining mark — which made every name word of
 * "X wrote this book" read to the end of the run: 1.3 s at 10,000. Each time
 * is the better of two reads, so a garbage-collection pause is not what fails.
 * The limits (200 ms at 1,000, 1 s at 10,000) are wide on purpose: `pnpm check`
 * runs this suite beside three others, where a read that takes 35 ms idle took
 * 1.2 s, while every pattern that ever stalled took seconds.
 */
describe("reading an adversarial message", () => {
  const cues = [
    "", "Remove the title page. Use her name ", "use my real name ", "keep my ", "make me sound ", "Author: ", "the author ", "Sam Lee as ", "Put Sam ",
    "publish it as ", "credited to ", "Sign it as ", "El libro es de ", "dedicate it to ", "Bio: ", "the ISBN is ", "www.", "http://", "copyright ", "all rights ",
    "نویسنده ", "به اسم ", "سارا رو ", "حقوق ", "المؤلف ", "Autor: ", "comme ", "als ", "and also ", "I also ", "Mia, ", "S. J. ", "never ",
    "written by ", "Change the dedication to: ", "as a co-author ", "make Ruiz Media ", "the owner ", "my site ",
    // A field's name and "to" with no colon, and the long field names it is read after.
    "change my bio to ", "Change the about ", "the about the author ", "my web ", "copyright holder ", "You can ",
    // A field named by the value it prints, and a rename spelled out.
    "Remove Lantern Press ", "Change Ana Ruiz to ", "take Ruiz Media off ",
    "Yazar adını ", "Yazarın ismini ", "Yazar olarak ", "Kalem adımı ", "Mahlasımı ",
    "Biyografimi ", "Telif haklarının ", "Yayınevini ", "İnternet sitemi ", "Tüm hakları "
  ];
  const runs = [
    "a", "Aa ", " ", "\t\n ", " ,", "a.", "a-", "1-", ":", "also ", "and make ", "never ", "I also ", "my kids and ", "«", "S. ", "aب", "ب ", "را ", "@", "/",
    // Leads after a subject, an aside or a request, and a book reference spoken to the dedicatee.
    "stories also make ", "then make ", ", like a,", "a, also make ", "you could also redo the cover ", "the pictures in this book ", "dedication to ", ", Ab and Ab, also make ", "and my kids also make ",
    // A printed value said over and over.
    "Lantern Press ", "Ana Ruiz "
  ];
  // A capital joined to the letter, mark or punctuation before it, runs of colons and full stops between
  // scripts, and a cue's stem with no space after it ("авторск…" once read to the end of the run).
  const joined = ["Ab’", "’Ab", "'Aé’", "b\u0301A", "Ab-", "A\u0301’", "’’Aa", "-Aa’", "\u200cIé ", "Aa \u200c", ".1.ی", ":ب«", "a\nو:", "Ab ", "авторск-"];
  const message = (cue: string, run: string, length: number) => `${cue}${run.repeat(Math.ceil(length / run.length))}`.slice(0, length - 1) + ")";
  const current = { authorName: "Ana Ruiz", dedication: "For Mom", aboutAuthor: null, authorWebsite: null, copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false };
  const composed = (text: string) =>
    bookMatterChatAnswerSchema.parse({
      outcome: "change",
      unhandled: text.slice(-4000),
      changes: [
        { field: "dedication", action: "set", text: text.slice(0, 4000), requestedBy: text.slice(0, 4000) },
        { field: "aboutAuthor", action: "set", text: text.slice(-4000), requestedBy: text.slice(-4000) },
        { field: "authorName", action: "remove", text: null, requestedBy: text.slice(0, 4000) },
        { field: "authorWebsite", action: "set", text: text.slice(0, 4000), requestedBy: text.slice(0, 60) },
        { field: "isbn", action: "set", text: text.slice(0, 4000), requestedBy: text.slice(0, 60) }
      ]
    });
  const composedAlone = (text: string) =>
    bookMatterChatAnswerSchema.parse({ outcome: "change", changes: [{ field: "aboutAuthor", action: "set", text: text.slice(0, 4000), requestedBy: text.slice(0, 4000) }] });
  // Every field printing something, read from the message, so the value and the run of a long biography are looked for in it.
  const valued = (text: string) => ({
    authorName: "Ana Ruiz",
    dedication: text.slice(0, 2000),
    aboutAuthor: text.slice(-1500),
    authorWebsite: "www.anaruiz.com",
    copyrightHolder: "Ruiz Media",
    imprint: "Lantern Press",
    isbn: "978-0-306-40615-7",
    allRightsReserved: false
  });
  const byValue = (text: string) =>
    bookMatterChatAnswerSchema.parse({
      outcome: "change",
      changes: [
        { field: "imprint", action: "remove", text: null, requestedBy: text.slice(0, 4000) },
        { field: "copyrightHolder", action: "remove", text: null, requestedBy: text.slice(-4000) },
        { field: "authorName", action: "set", text: text.slice(0, 120), requestedBy: text.slice(0, 4000) },
        { field: "aboutAuthor", action: "set", text: text.slice(-4000), requestedBy: text.slice(0, 4000) },
        { field: "dedication", action: "remove", text: null, requestedBy: text.slice(-4000) }
      ]
    });
  const entries: ReadonlyArray<readonly [string, (text: string) => unknown]> = [
    ["bookMatterFieldsNamedIn", bookMatterFieldsNamedIn],
    ["namesField", (text) => namesField(text, "isbn")],
    ["bookMatterMessageHasSeparateRequest", bookMatterMessageHasSeparateRequest],
    ["instructsTheChange", instructsTheChange],
    ["normalizeIsbn", normalizeIsbn],
    ["normalizeBookMatterChatAnswer", (text) => normalizeBookMatterChatAnswer(composed(text), { message: text, current, readerTurns: [text.slice(0, 600)], lastTurnFields: ["dedication"] })],
    ["normalizeBookMatterChatAnswer, one change", (text) => normalizeBookMatterChatAnswer(composedAlone(text), { message: text, current, lastTurnFields: ["aboutAuthor"] })],
    ["normalizeBookMatterChatAnswer, by value", (text) => normalizeBookMatterChatAnswer(byValue(text), { message: text, current: valued(text), lastTurnFields: ["aboutAuthor"] })]
  ];
  const once = (read: (text: string) => unknown, text: string) => {
    const started = performance.now();
    read(text);
    return performance.now() - started;
  };
  const timed = (read: (text: string) => unknown, text: string, limit: number) => {
    const first = once(read, text);
    return first < limit ? first : Math.min(first, once(read, text));
  };

  // Letters and whitespace after every cue; every run alone, after a field's colon and after a dedication request.
  const inputs = [
    ...cues.flatMap((cue) => ["a", " ", "\t\n "].map((run) => [cue, run] as const)),
    ...runs.flatMap((run) => ["", "Bio: ", "dedicate it to my mom "].map((cue) => [cue, run] as const)),
    ...joined.flatMap((run) => ["", "written by ", "Change the dedication to: ", "sign it as ", "as a co-author ", "به اسم "].map((cue) => [cue, run] as const))
  ];

  it.each(entries)("%s stays linear", (_name, read) => {
    // V8 compiles a regular expression to machine code on its first heavy use; read every
    // input short first, so that one-time compile is not what is measured.
    for (const [cue, run] of inputs) read(message(cue, run, 200));
    for (const [cue, run] of inputs) {
      expect(timed(read, message(cue, run, 1_000), 200), `${JSON.stringify(cue)} + ${JSON.stringify(run)} at 1,000`).toBeLessThan(200);
      expect(timed(read, message(cue, run, 10_000), 1_000), `${JSON.stringify(cue)} + ${JSON.stringify(run)} at 10,000`).toBeLessThan(1_000);
    }
  }, 120_000);
});

describe("a quote of the reader's words", () => {
  it("matches whole words in order, whatever the punctuation, case or spacing", () => {
    expect(quotedFrom("Make page 2 shorter", "Dedicate it to my mom.  Also, make page 2 shorter!")).toBe(true);
    expect(quotedFrom("all rights", "make the overall rights clearer")).toBe(false);
    expect(quotedFrom("山田出版", "出版社を山田出版にして")).toBe(true);
    expect(quotedFrom("  ", "anything")).toBe(false);
  });
});

describe("a clause retold in a printed text", () => {
  it("reads inflections and pronouns loosely, and nothing else", () => {
    const printed = looseQuotable("She writes poetry and makes quilts. He fixes old boats, carries her own songs and stopped running.");
    for (const clause of ["make quilts", "write poetry", "fix old boats", "carry my own songs", "stop running"]) {
      expect(looselyQuotedFrom(clause, printed), clause).toBe(true);
    }
    for (const clause of ["redo the cover", "make poetry", "fix new boats"]) {
      expect(looselyQuotedFrom(clause, printed), clause).toBe(false);
    }
  });
});
