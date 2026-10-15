import { describe, expect, it } from "vitest";

import {
  bookMatterChatAnswerSchema,
  bookMatterProseReviewCandidates,
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatContext,
  type BookMatterChatCurrent,
  type BookMatterChatField
} from "./bookMatterChatEdit.js";
import { acceptBookMatterGroundingReview } from "./bookMatterProseGrounding.js";

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
const answer = (changes: Change[]): BookMatterChatAnswer => bookMatterChatAnswerSchema.parse({ outcome: "change", changes });

/**
 * These fixtures measure field selection. Their expected prose is independently
 * reviewed as supported; unwanted changes receive no positive verdict. Prose
 * grounding itself (including failed reviews) is tested in the grounding suite.
 */
function normalizeReviewedFixture(answer: BookMatterChatAnswer, context: BookMatterChatContext, expected: Record<string, string | boolean | null>) {
  const candidates = bookMatterProseReviewCandidates(answer, context);
  const proseReview = acceptBookMatterGroundingReview({ verdicts: candidates.map((candidate, id) => ({
    id, supported: expected[candidate.field] === candidate.text
  })) }, candidates, context);
  return normalizeBookMatterChatAnswer(answer, { ...context, proseReview });
}

/**
 * The fourth set, for the round-7 rework of which fields the reader asked for,
 * written before the rework and run once without changing the code after it.
 * The gate exists because a Persian dedication request came back with "All
 * rights reserved" switched on and the biography deleted; it used to keep a
 * change only when its quoted words named its field, and so also dropped every
 * follow-up that says "it" and about one byline in three. Each case is what a
 * good composer answers, `requestedBy` copied from the message; `lastTurn` is
 * what the reply before it changed.
 */
describe("which fields the reader asked for, unseen", () => {
  type Patch = Record<string, string | boolean | null>;
  type Turn = readonly [lastTurn: BookMatterChatField[], now: Partial<BookMatterChatCurrent>, message: string, changes: Change[], patch: Patch];
  const put = (field: BookMatterChatField, text: string | null, requestedBy: string): Change => ({ field, action: "set", text, requestedBy });
  const cut = (field: BookMatterChatField, requestedBy: string): Change => ({ field, action: "remove", text: null, requestedBy });
  const decideTurn = ([lastTurn, now, message, changes, expected]: Turn) =>
    normalizeReviewedFixture(answer(changes), { message, current: { ...current, ...now }, bookLanguage: "en", lastTurnFields: lastTurn }, expected);

  const mom = { dedication: "For my mom" };
  const bio = { aboutAuthor: "Ana Ruiz teaches chemistry in Ohio." };
  const sam = { authorName: "Sam Lee" };
  const followUps: Turn[] = [
    [["dedication"], mom, "Mention my sister in it too", [put("dedication", "For my mom and my sister", "Mention my sister in it too")], { dedication: "For my mom and my sister" }],
    [["dedication"], { dedication: "For my mom.\nThank you for everything, always." }, "cut it to one line", [put("dedication", "For my mom.", "cut it to one line")], { dedication: "For my mom." }],
    [["dedication"], { dedication: "For my mom, who taught me to read and never once stopped believing in me." }, "Make it shorter", [put("dedication", "For my mom, who taught me to read.", "Make it shorter")], { dedication: "For my mom, who taught me to read." }],
    [["dedication"], mom, "Add my dad too", [put("dedication", "For my mom and dad", "Add my dad too")], { dedication: "For my mom and dad" }],
    [["dedication"], mom, "Remove it", [cut("dedication", "Remove it")], { dedication: null }],
    [["dedication"], { dedication: "For Mom" }, "Change Mom to Mother", [put("dedication", "For Mother", "Change Mom to Mother")], { dedication: "For Mother" }],
    [["dedication"], mom, "make it read 'To Ana'", [put("dedication", "To Ana", "make it read 'To Ana'")], { dedication: "To Ana" }],
    [["dedication"], mom, "actually say grandma instead", [put("dedication", "For my grandma", "actually say grandma instead")], { dedication: "For my grandma" }],
    [["dedication"], mom, "can you add 'with love' at the end", [put("dedication", "For my mom, with love", "can you add 'with love' at the end")], { dedication: "For my mom, with love" }],
    [["dedication"], { dedication: "For my mom and dad" }, "No, just my dad", [put("dedication", "For my dad", "No, just my dad")], { dedication: "For my dad" }],
    [["dedication"], { dedication: "For my mom.\nThank you for everything." }, "drop the second line", [put("dedication", "For my mom.", "drop the second line")], { dedication: "For my mom." }],
    [["dedication"], mom, "and my brother Leo", [put("dedication", "For my mom and my brother Leo", "and my brother Leo")], { dedication: "For my mom and my brother Leo" }],
    [["dedication"], mom, "make it sound warmer", [put("dedication", "For my mom, with all my love.", "make it sound warmer")], { dedication: "For my mom, with all my love." }],
    [["dedication"], mom, "Take that back out", [cut("dedication", "Take that back out")], { dedication: null }],
    [["dedication"], mom, "she passed last year, make it in memory of her", [put("dedication", "In memory of my mom", "make it in memory of her")], { dedication: "In memory of my mom" }],
    [["aboutAuthor"], { aboutAuthor: "I teach chemistry in Ohio." }, "Make it third person", [put("aboutAuthor", "Ana Ruiz teaches chemistry in Ohio.", "Make it third person")], bio],
    [["aboutAuthor"], bio, "Also add that I have two cats", [put("aboutAuthor", "Ana Ruiz teaches chemistry in Ohio. She has two cats.", "Also add that I have two cats")], { aboutAuthor: "Ana Ruiz teaches chemistry in Ohio. She has two cats." }],
    [["aboutAuthor"], bio, "make it shorter", [put("aboutAuthor", "Ana Ruiz teaches chemistry.", "make it shorter")], { aboutAuthor: "Ana Ruiz teaches chemistry." }],
    [["aboutAuthor"], bio, "mention I'm a mom of three", [put("aboutAuthor", "Ana Ruiz teaches chemistry in Ohio. She is a mom of three.", "mention I'm a mom of three")], { aboutAuthor: "Ana Ruiz teaches chemistry in Ohio. She is a mom of three." }],
    [["aboutAuthor"], bio, "take out the part about Ohio", [put("aboutAuthor", "Ana Ruiz teaches chemistry.", "take out the part about Ohio")], { aboutAuthor: "Ana Ruiz teaches chemistry." }],
    [["aboutAuthor"], bio, "Remove it", [cut("aboutAuthor", "Remove it")], { aboutAuthor: null }],
    [["aboutAuthor"], bio, "use first person instead", [put("aboutAuthor", "I teach chemistry in Ohio.", "use first person instead")], { aboutAuthor: "I teach chemistry in Ohio." }],
    [["aboutAuthor"], bio, "add that I run marathons", [put("aboutAuthor", "Ana Ruiz teaches chemistry in Ohio and runs marathons.", "add that I run marathons")], { aboutAuthor: "Ana Ruiz teaches chemistry in Ohio and runs marathons." }],
    [["authorName"], sam, "Actually make it S. J. Lee", [put("authorName", "S. J. Lee", "Actually make it S. J. Lee")], { authorName: "S. J. Lee" }],
    [["authorName"], sam, "add my middle name, Jordan", [put("authorName", "Sam Jordan Lee", "add my middle name, Jordan")], { authorName: "Sam Jordan Lee" }],
    [["authorName"], sam, "undo that, go back to Ana Ruiz", [put("authorName", "Ana Ruiz", "go back to Ana Ruiz")], { authorName: "Ana Ruiz" }],
    [["imprint"], { imprint: "Lantern Press" }, "make it Lantern Books instead", [put("imprint", "Lantern Books", "make it Lantern Books instead")], { imprint: "Lantern Books" }],
    [["imprint"], { imprint: "Lantern Press" }, "take it off", [cut("imprint", "take it off")], { imprint: null }],
    [["imprint"], { imprint: "Lantern Press" }, "all caps please", [put("imprint", "LANTERN PRESS", "all caps please")], { imprint: "LANTERN PRESS" }],
    [["copyrightHolder"], { copyrightHolder: "Ruiz Media" }, "make it Ruiz Media LLC", [put("copyrightHolder", "Ruiz Media LLC", "make it Ruiz Media LLC")], { copyrightHolder: "Ruiz Media LLC" }],
    [["authorWebsite"], { authorWebsite: "anaruiz.com" }, "make it anaruiz.net instead", [put("authorWebsite", "anaruiz.net", "make it anaruiz.net instead")], { authorWebsite: "anaruiz.net" }],
    [["isbn"], { isbn: "0-8044-2957-X" }, "sorry, wrong one: 978-0-306-40615-7", [put("isbn", "978-0-306-40615-7", "978-0-306-40615-7")], { isbn: "978-0-306-40615-7" }],
    [["allRightsReserved"], {}, "put it back", [put("allRightsReserved", null, "put it back")], { allRightsReserved: true }],
    [["allRightsReserved"], { allRightsReserved: true }, "hmm, take that line off again", [cut("allRightsReserved", "take that line off again")], { allRightsReserved: false }],
    [["dedication"], mom, "Add my dad too, and change the publisher to Lantern", [put("dedication", "For my mom and dad", "Add my dad too"), put("imprint", "Lantern", "change the publisher to Lantern")], { dedication: "For my mom and dad", imprint: "Lantern" }],
    [["aboutAuthor"], bio, "make it shorter and add my website, anaruiz.com", [put("aboutAuthor", "Ana Ruiz teaches chemistry.", "make it shorter"), put("authorWebsite", "anaruiz.com", "add my website, anaruiz.com")], { aboutAuthor: "Ana Ruiz teaches chemistry.", authorWebsite: "anaruiz.com" }],
    [["authorName"], sam, "use S. J. Lee there and on the copyright line too", [put("authorName", "S. J. Lee", "use S. J. Lee there"), put("copyrightHolder", "S. J. Lee", "on the copyright line too")], { authorName: "S. J. Lee", copyrightHolder: "S. J. Lee" }],
    [["dedication"], mom, "Remove it and add All rights reserved", [cut("dedication", "Remove it"), put("allRightsReserved", null, "add All rights reserved")], { dedication: null, allRightsReserved: true }],
    [["dedication"], mom, "Mention my sister in it too. Also, the ISBN is 978-0-306-40615-7", [put("dedication", "For my mom and my sister", "Mention my sister in it too"), put("isbn", "978-0-306-40615-7", "the ISBN is 978-0-306-40615-7")], { dedication: "For my mom and my sister", isbn: "978-0-306-40615-7" }],
    [["aboutAuthor"], { aboutAuthor: "I teach chemistry in Ohio." }, "Make it third person, and the publisher is Lantern Press", [put("aboutAuthor", "Ana Ruiz teaches chemistry in Ohio.", "Make it third person"), put("imprint", "Lantern Press", "the publisher is Lantern Press")], { ...bio, imprint: "Lantern Press" }]
  ];

  it("holds at least thirty follow-ups", () => {
    expect(followUps.length).toBeGreaterThanOrEqual(30);
  });

  it.each(followUps)("keeps the follow-up to %j in %j: %j", (...turn) => {
    expect(decideTurn(turn)).toEqual({ kind: "change", patch: turn[4] });
  });

  const byline = (message: string, name: string, requestedBy = message): Turn => [[], {}, message, [put("authorName", name, requestedBy)], { authorName: name }];
  const bylines: Turn[] = [
    byline("I want my name on the book to be Sam Lee", "Sam Lee"),
    byline("Sam Lee is my pen name, use that", "Sam Lee"),
    byline("Put my real name on it: Samuel Lee", "Samuel Lee"),
    byline("change Ana Ruiz to Sam Lee", "Sam Lee"),
    byline("Swap Ana Ruiz for Sam Lee please", "Sam Lee"),
    byline("I go by Sam Lee now", "Sam Lee"),
    byline("please credit Sam Lee", "Sam Lee"),
    byline("this book is Sam Lee's", "Sam Lee"),
    byline("Sam Lee wrote it, not Ana", "Sam Lee"),
    byline("byline: Sam Lee", "Sam Lee"),
    byline("My name is Sam Lee, put that on the book", "Sam Lee"),
    byline("can the book say Sam Lee instead of Ana Ruiz", "Sam Lee"),
    byline("I'm Sam Lee, not Ana Ruiz", "Sam Lee"),
    byline("add my co-writer Jo Park", "Ana Ruiz and Jo Park"),
    byline("include Jo Park as an author", "Ana Ruiz and Jo Park"),
    byline("Jo Park and I wrote this together", "Ana Ruiz and Jo Park"),
    byline("make the name on the cover S. Lee", "S. Lee"),
    byline("use Dr. Sam Lee", "Dr. Sam Lee"),
    byline("Replace my name with Sam Lee", "Sam Lee"),
    byline("It's by Sam Lee", "Sam Lee"),
    byline("Mark the author as Sam Lee", "Sam Lee"),
    byline("the name should be Sam Lee", "Sam Lee"),
    byline("go with Sam Lee for the name", "Sam Lee"),
    byline("Please print Sam Lee as the writer", "Sam Lee"),
    byline("list the author as Sam Lee", "Sam Lee"),
    byline("Under the title it should say Sam Lee", "Sam Lee"),
    byline("Sam Lee, not Ana Ruiz, please", "Sam Lee"),
    byline("اسم نویسنده رو سام لی بذار", "سام لی"),
    byline("به جای آنا بنویس سام لی", "سام لی"),
    byline("من سام لی هستم، اسمم رو عوض کن", "سام لی"),
    byline("اسم من رو سام لی کن", "سام لی"),
    byline("کتاب رو به اسم سام لی کن", "سام لی"),
    byline("نام نویسنده: سام لی", "سام لی"),
    byline("این کتاب نوشته‌ی سام لی است", "سام لی"),
    byline("سام لی رو جای آنا روئیز بذار", "سام لی"),
    byline("لطفا اسم سام لی رو روی کتاب بزن", "سام لی"),
    byline("pon mi nombre: Lucía Gómez", "Lucía Gómez"),
    byline("el nombre del autor es Lucía Gómez", "Lucía Gómez"),
    byline("quiero que salga Lucía Gómez como autora", "Lucía Gómez"),
    byline("cambia Ana Ruiz por Lucía Gómez", "Lucía Gómez"),
    byline("firma el libro como Lucía Gómez", "Lucía Gómez"),
    byline("que diga Lucía Gómez en la portada", "Lucía Gómez"),
    byline("mi seudónimo es Lucía Gómez", "Lucía Gómez"),
    byline("mon nom de plume est Claire Martin", "Claire Martin"),
    byline("mettez Claire Martin à la place d'Ana Ruiz", "Claire Martin"),
    byline("le livre est signé Claire Martin", "Claire Martin"),
    byline("je veux que le nom soit Claire Martin", "Claire Martin"),
    byline("remplace Ana Ruiz par Claire Martin", "Claire Martin"),
    byline("c'est Claire Martin qui l'a écrit", "Claire Martin"),
    byline("mein Name ist Jonas Weber, bitte so drucken", "Jonas Weber"),
    byline("Autorenname: Jonas Weber", "Jonas Weber"),
    byline("statt Ana Ruiz bitte Jonas Weber", "Jonas Weber"),
    byline("Verfasser ist Jonas Weber", "Jonas Weber"),
    byline("schreib Jonas Weber auf das Titelblatt", "Jonas Weber"),
    byline("unter dem Namen Jonas Weber veröffentlichen", "Jonas Weber"),
    byline("il mio nome è Marco Rossi, mettilo sul libro", "Marco Rossi"),
    byline("metti Marco Rossi al posto di Ana Ruiz", "Marco Rossi"),
    byline("firmato Marco Rossi", "Marco Rossi"),
    byline("il nome dell'autore è Marco Rossi", "Marco Rossi"),
    byline("pubblicalo come Marco Rossi", "Marco Rossi"),
    byline("meu nome é João Silva, coloque no livro", "João Silva"),
    byline("troque Ana Ruiz por João Silva", "João Silva"),
    byline("assine como João Silva", "João Silva"),
    byline("o nome do autor é João Silva", "João Silva"),
    byline("quero publicar como João Silva", "João Silva"),
    byline("اسم المؤلف سام لي", "سام لي"),
    byline("ضع اسمي سام لي على الكتاب", "سام لي"),
    byline("الكتاب من تأليف سام لي", "سام لي"),
    [[], {}, "Sam Lee should be the author and the copyright holder", [put("authorName", "Sam Lee", "Sam Lee should be the author"), put("copyrightHolder", "Sam Lee", "the copyright holder")], { authorName: "Sam Lee", copyrightHolder: "Sam Lee" }],
    [[], {}, "use my real name Sam Lee, and the publisher is Lantern", [put("authorName", "Sam Lee", "use my real name Sam Lee"), put("imprint", "Lantern", "the publisher is Lantern")], { authorName: "Sam Lee", imprint: "Lantern" }],
    [[], {}, "Escrito por Lucía Gómez, editorial Lantern", [put("authorName", "Lucía Gómez", "Escrito por Lucía Gómez"), put("imprint", "Lantern", "editorial Lantern")], { authorName: "Lucía Gómez", imprint: "Lantern" }],
    [[], {}, "Replace Ana Ruiz with Sam Lee and remove the dedication", [put("authorName", "Sam Lee", "Replace Ana Ruiz with Sam Lee"), cut("dedication", "remove the dedication")], { authorName: "Sam Lee", dedication: null }],
    [[], {}, "Sign it as Sam Lee and add All rights reserved", [put("authorName", "Sam Lee", "Sign it as Sam Lee"), put("allRightsReserved", null, "add All rights reserved")], { authorName: "Sam Lee", allRightsReserved: true }],
    [[], {}, "écrit par Claire Martin, et le copyright au nom de Claire Martin", [put("authorName", "Claire Martin", "écrit par Claire Martin"), put("copyrightHolder", "Claire Martin", "le copyright au nom de Claire Martin")], { authorName: "Claire Martin", copyrightHolder: "Claire Martin" }],
    [[], {}, "Jonas Weber als zweiter Autor, und Verlag: Lantern", [put("authorName", "Ana Ruiz und Jonas Weber", "Jonas Weber als zweiter Autor"), put("imprint", "Lantern", "Verlag: Lantern")], { authorName: "Ana Ruiz und Jonas Weber", imprint: "Lantern" }],
    [[], {}, "Geschrieben von Jonas Weber; Copyright: Jonas Weber", [put("authorName", "Jonas Weber", "Geschrieben von Jonas Weber"), put("copyrightHolder", "Jonas Weber", "Copyright: Jonas Weber")], { authorName: "Jonas Weber", copyrightHolder: "Jonas Weber" }]
  ];

  it("holds at least sixty bylines in six languages", () => {
    expect(bylines.length).toBeGreaterThanOrEqual(60);
  });

  it.each(bylines)("keeps the byline asked for in %j %j as %j", (...turn) => {
    expect(decideTurn(turn)).toEqual({ kind: "change", patch: turn[4] });
  });

  const alone = (message: string, change: Change, now: Partial<BookMatterChatCurrent> = {}): Turn => [[], now, message, [change], { [change.field]: change.text ?? null }];
  const unnamed: Turn[] = [
    alone("For my mom, who taught me to read", put("dedication", "For my mom, who taught me to read.", "For my mom, who taught me to read")),
    alone("To everyone who ever lent me a book", put("dedication", "To everyone who ever lent me a book.", "To everyone who ever lent me a book")),
    alone("Lantern Press is putting it out", put("imprint", "Lantern Press", "Lantern Press is putting it out")),
    alone("It's coming out from Lantern Press", put("imprint", "Lantern Press", "It's coming out from Lantern Press")),
    alone("Ruiz Media owns the rights", put("copyrightHolder", "Ruiz Media", "Ruiz Media owns the rights")),
    alone("you can find me at anaruiz.com", put("authorWebsite", "anaruiz.com", "you can find me at anaruiz.com")),
    alone("978-0-306-40615-7", put("isbn", "978-0-306-40615-7", "978-0-306-40615-7")),
    alone("I teach chemistry in Ohio and have two kids", put("aboutAuthor", "Ana Ruiz teaches chemistry in Ohio and has two kids.", "I teach chemistry in Ohio and have two kids")),
    alone("I'm a nurse in Leeds who writes on weekends", put("aboutAuthor", "Ana Ruiz is a nurse in Leeds who writes on weekends.", "I'm a nurse in Leeds who writes on weekends")),
    alone("say something about me: retired pilot, keeps bees", put("aboutAuthor", "Ana Ruiz is a retired pilot who keeps bees.", "say something about me: retired pilot, keeps bees")),
    alone("the rights belong to my company, Ruiz Media", put("copyrightHolder", "Ruiz Media", "the rights belong to my company, Ruiz Media")),
    alone("In memory of my grandfather", put("dedication", "In memory of my grandfather.", "In memory of my grandfather")),
    alone("for Leo and Ava", put("dedication", "For Leo and Ava", "for Leo and Ava")),
    alone("my company Ruiz Media should own it", put("copyrightHolder", "Ruiz Media", "my company Ruiz Media should own it")),
    alone("Lantern Books puts out all my books", put("imprint", "Lantern Books", "Lantern Books puts out all my books")),
    alone("I'm a chemistry teacher, write something about that", put("aboutAuthor", "Ana Ruiz is a chemistry teacher.", "I'm a chemistry teacher, write something about that")),
    alone("take out my ex's name, Mark", put("dedication", "For Mom", "take out my ex's name, Mark"), { dedication: "For Mom and Mark" }),
    alone("Ruiz Media holds it, not me", put("copyrightHolder", "Ruiz Media", "Ruiz Media holds it, not me")),
    alone("find me online at anaruiz.com", put("authorWebsite", "anaruiz.com", "find me online at anaruiz.com")),
    alone("with all my love, to Dad", put("dedication", "With all my love, to Dad.", "with all my love, to Dad")),
    alone("برای مادرم، که همیشه کنارم بود", put("dedication", "برای مادرم، که همیشه کنارم بود", "برای مادرم، که همیشه کنارم بود")),
    alone("ققنوس چاپش می‌کنه", put("imprint", "ققنوس", "ققنوس چاپش می‌کنه")),
    alone("Para mi madre, que me enseñó a leer", put("dedication", "Para mi madre, que me enseñó a leer.", "Para mi madre, que me enseñó a leer")),
    alone("Pour ma grand-mère", put("dedication", "Pour ma grand-mère", "Pour ma grand-mère"))
  ];

  it("holds at least twenty requests that never name their field", () => {
    expect(unnamed.length).toBeGreaterThanOrEqual(20);
  });

  it.each(unnamed)("keeps the one change asked for in %j %j as %j", (...turn) => {
    expect(decideTurn(turn)).toEqual({ kind: "change", patch: turn[4] });
  });

  // A removal nobody named stays blocked by design, even when it is what the
  // reader meant. (Written as a pair; "the thing about me at the back" turned
  // out to name About the Author — "about me" is its cue — and is kept, and
  // since round 9 "the one for my mom" names the dedication "For my mom" by the
  // words it prints, and is kept too.)
  it("still refuses a removal nobody named", () => {
    const turn = alone("lose the bit at the back where I talk about myself", cut("aboutAuthor", "lose the bit at the back where I talk about myself"), bio);
    expect(decideTurn(turn)).toEqual({ kind: "none", reason: "not_matter" });
  });

  it.each([
    alone("get rid of the thing about me at the back", cut("aboutAuthor", "get rid of the thing about me at the back"), bio),
    alone("lose the line at the very front, the one for my mom", cut("dedication", "lose the line at the very front, the one for my mom"), mom)
  ])("keeps a removal its cue or its printed words name: %j %j %j", (...turn) => {
    expect(decideTurn(turn)).toEqual({ kind: "change", patch: turn[4] });
  });

  // The shape of the incident: a change beside the one asked for, which no
  // cue in the message and nothing the last reply changed asks for.
  const bioNow = { aboutAuthor: "Ana Ruiz teaches chemistry in Ohio.", authorWebsite: "anaruiz.com", imprint: "Lantern", isbn: "0-8044-2957-X" };
  const riders: Turn[] = [
    [[], {}, "Dedicate it to my mom", [put("dedication", "For my mom", "Dedicate it to my mom"), put("allRightsReserved", null, "Dedicate it to my mom")], { dedication: "For my mom" }],
    [[], bioNow, "Dedicate it to my mom", [put("dedication", "For my mom", "Dedicate it to my mom"), cut("aboutAuthor", "")], { dedication: "For my mom" }],
    [[], {}, "Dedicate it to my mom", [put("dedication", "For my mom", "Dedicate it to my mom"), put("copyrightHolder", "my mom", "Dedicate it to my mom")], { dedication: "For my mom" }],
    [[], {}, "change the publisher to Lantern", [put("imprint", "Lantern", "change the publisher to Lantern"), put("copyrightHolder", "Lantern", "change the publisher to Lantern")], { imprint: "Lantern" }],
    [[], {}, "change the author name to Sam Lee", [put("authorName", "Sam Lee", "change the author name to Sam Lee"), put("copyrightHolder", "Sam Lee", "change the author name to Sam Lee")], { authorName: "Sam Lee" }],
    [[], {}, "change the copyright holder to Sam Lee", [put("copyrightHolder", "Sam Lee", "change the copyright holder to Sam Lee"), put("allRightsReserved", null, "change the copyright holder to Sam Lee")], { copyrightHolder: "Sam Lee" }],
    [[], bioNow, "the ISBN is 978-0-306-40615-7", [put("isbn", "978-0-306-40615-7", "the ISBN is 978-0-306-40615-7"), cut("imprint", "the ISBN is 978-0-306-40615-7")], { isbn: "978-0-306-40615-7" }],
    [[], bioNow, "write my bio: I teach chemistry", [put("aboutAuthor", "Ana Ruiz teaches chemistry.", "write my bio: I teach chemistry"), cut("authorWebsite", "write my bio")], { aboutAuthor: "Ana Ruiz teaches chemistry." }],
    [[], bioNow, "remove the dedication", [cut("dedication", "remove the dedication"), cut("aboutAuthor", "remove the dedication")], { dedication: null }],
    [[], bioNow, "این کتاب را به پدرم تقدیم کن", [put("dedication", "تقدیم به پدرم", "این کتاب را به پدرم تقدیم کن"), put("allRightsReserved", null, ""), cut("aboutAuthor", "این کتاب را به پدرم تقدیم کن")], { dedication: "تقدیم به پدرم" }],
    [["aboutAuthor"], bioNow, "Dedicate it to my dad", [put("dedication", "For my dad", "Dedicate it to my dad"), put("aboutAuthor", "Ana Ruiz teaches chemistry.", "Dedicate it to my dad")], { dedication: "For my dad" }],
    [["aboutAuthor"], bioNow, "Dedicate it to my dad", [put("dedication", "For my dad", "Dedicate it to my dad"), cut("aboutAuthor", "Dedicate it to my dad")], { dedication: "For my dad" }],
    [["allRightsReserved"], {}, "change the publisher to Lantern", [put("imprint", "Lantern", "change the publisher to Lantern"), put("allRightsReserved", null, "change the publisher to Lantern")], { imprint: "Lantern" }],
    [["authorName"], sam, "Add my sister to the dedication", [put("dedication", "For Mom and my sister", "Add my sister to the dedication"), put("authorName", "Ana Ruiz", "Add my sister to the dedication")], { dedication: "For Mom and my sister" }],
    [[], { dedication: "For my mom, always.", aboutAuthor: "Ana Ruiz teaches chemistry in Ohio." }, "Make it shorter", [put("dedication", "For my mom.", "Make it shorter"), put("aboutAuthor", "Ana Ruiz teaches chemistry.", "Make it shorter")], {}],
    [[], {}, "Sam Lee wrote this book", [put("authorName", "Sam Lee", "Sam Lee wrote this book"), put("copyrightHolder", "Sam Lee", "Sam Lee wrote this book")], { authorName: "Sam Lee" }],
    [[], {}, "add All rights reserved", [put("allRightsReserved", null, "add All rights reserved"), put("copyrightHolder", "Ana Ruiz", "add All rights reserved")], { allRightsReserved: true }],
    [[], {}, "my website is anaruiz.com", [put("authorWebsite", "anaruiz.com", "my website is anaruiz.com"), put("aboutAuthor", "Find Ana Ruiz at anaruiz.com.", "my website is anaruiz.com")], { authorWebsite: "anaruiz.com" }],
    [[], {}, "Escrito por Lucía Gómez", [put("authorName", "Lucía Gómez", "Escrito por Lucía Gómez"), put("copyrightHolder", "Lucía Gómez", "Escrito por Lucía Gómez")], { authorName: "Lucía Gómez" }],
    [[], bioNow, "dedica el libro a mi madre", [put("dedication", "Para mi madre", "dedica el libro a mi madre"), put("allRightsReserved", null, "dedica el libro a mi madre"), cut("aboutAuthor", "dedica el libro a mi madre")], { dedication: "Para mi madre" }],
    [[], bioNow, "put Lantern Press as the publisher", [put("imprint", "Lantern Press", "put Lantern Press as the publisher"), cut("isbn", "put Lantern Press as the publisher")], { imprint: "Lantern Press" }],
    [["dedication"], { ...bioNow, ...mom }, "Mention my sister in it too", [put("dedication", "For my mom and my sister", "Mention my sister in it too"), put("aboutAuthor", "Ana Ruiz teaches chemistry in Ohio. She has a sister.", "Mention my sister in it too")], { dedication: "For my mom and my sister" }],
    [["dedication"], { ...bioNow, ...mom }, "Remove it", [cut("dedication", "Remove it"), cut("aboutAuthor", "Remove it")], { dedication: null }],
    [[], {}, "Use my real name, Sam Lee", [put("authorName", "Sam Lee", "Use my real name, Sam Lee"), put("copyrightHolder", "Sam Lee", "Use my real name, Sam Lee")], { authorName: "Sam Lee" }],
    [["imprint"], { imprint: "Lantern Press" }, "make it Lantern Books instead", [put("imprint", "Lantern Books", "make it Lantern Books instead"), put("copyrightHolder", "Lantern Books", "make it Lantern Books instead")], { imprint: "Lantern Books" }]
  ];

  it("holds at least twenty answers that change a field nobody asked for", () => {
    expect(riders.length).toBeGreaterThanOrEqual(20);
  });

  it.each(riders)("drops what rode along with %j %j in %j", (...turn) => {
    const decision = decideTurn(turn);
    const asked = turn[3].find((change) => change.field in turn[4]);
    const kept = decision.kind === "change" ? decision.patch : {};
    // Never a field the reader did not ask for — and the one they did, as asked.
    expect(Object.keys(kept).filter((field) => !(field in turn[4]))).toEqual([]);
    if (asked) expect(kept, "the asked field").toEqual(turn[4]);
  });
});

/**
 * The fifth set, for round 8, written before the fix and run once against it:
 * a follow-up whose own words spell another field's cue ("owner", "publishing",
 * "web", "dedicated", "about me", "my name"…) used to be dropped — 1 of 40
 * biography facts and 0 of 30 dedication lines kept — and a rider quoting such
 * a word, or the whole message, kept. The decision is read for its field and
 * value; the Persian "اضافه کن: …" lines also carry a left-over flag, which is
 * the left-over check's (recorded), not this gate's.
 */
describe("a field's own words that spell another field's cue, unseen", () => {
  type Turn = readonly [lastTurn: BookMatterChatField[], now: Partial<BookMatterChatCurrent>, message: string, changes: Change[], patch: Record<string, string | boolean | null>];
  const put = (field: BookMatterChatField, text: string | null, requestedBy: string): Change => ({ field, action: "set", text, requestedBy });
  const cut = (field: BookMatterChatField, requestedBy: string): Change => ({ field, action: "remove", text: null, requestedBy });
  const decideTurn = ([lastTurn, now, message, changes, expected]: Turn) => {
    const decision = normalizeReviewedFixture(answer(changes), { message, current: { ...current, ...now }, bookLanguage: "en", lastTurnFields: lastTurn }, expected);
    return decision.kind === "change" ? { kind: decision.kind, patch: decision.patch } : decision;
  };

  const BIO = "Ana Ruiz teaches chemistry in Ohio.";
  const FA_BIO = "آنا روئیز در اوهایو شیمی درس می‌دهد.";
  const bio = { aboutAuthor: BIO };
  const mom = { dedication: "For my mom" };
  const faBio = { authorName: "آنا روئیز", aboutAuthor: FA_BIO };
  const afterBio = (message: string, added: string, base = BIO, now: Partial<BookMatterChatCurrent> = bio): Turn =>
    [["aboutAuthor"], now, message, [put("aboutAuthor", `${base} ${added}`, message)], { aboutAuthor: `${base} ${added}` }];
  const afterDedication = (message: string, text: string, now: Partial<BookMatterChatCurrent> = mom): Turn =>
    [["dedication"], now, message, [put("dedication", text, message)], { dedication: text }];

  const followUps: Turn[] = [
    afterBio("add that I'm also a proud dog owner", "She is also a proud dog owner."),
    afterBio("mention that I co-own a bakery and I'm its majority owner", "She co-owns a bakery and is its majority owner."),
    afterBio("say that I worked in publishing for a decade", "She worked in publishing for a decade."),
    afterBio("add that my first essays were published by a small magazine", "Her first essays were published by a small magazine."),
    afterBio("mention I used to be a publisher's assistant", "She used to be a publisher's assistant."),
    afterBio("add that I build websites for local charities", "She builds websites for local charities."),
    afterBio("mention that I'm a web designer by trade", "She is a web designer by trade."),
    afterBio("add that I lead digs at an archaeological site in Peru every summer", "Every summer she leads digs at an archaeological site in Peru."),
    afterBio("say I'm a dedicated volunteer firefighter", "She is a dedicated volunteer firefighter."),
    afterBio("add that I've dedicated my life to teaching", "She has dedicated her life to teaching."),
    afterBio("mention that everyone mispronounces my name", "Everyone mispronounces her name."),
    afterBio("add that my maiden name is García", "Her maiden name is García."),
    afterBio("say that I also write under a pen name", "She also writes under a pen name."),
    afterBio("add that I was a co-author on a NASA study", "She was a co-author on a NASA study."),
    afterBio("add that I'm also a copyright lawyer", "She is also a copyright lawyer."),
    afterBio("mention that I run the editorial team at our local paper", "She runs the editorial team at her local paper."),
    afterBio("say I'm the proud owner of three rescue cats", "She is the proud owner of three rescue cats."),
    afterBio("mention I teach a workshop on self-publishing", "She teaches a workshop on self-publishing."),
    afterBio("add that I manage the site for our town library", "She manages the site for her town library."),
    afterBio("add that I'm an editor at a publishing house", "She is an editor at a publishing house."),
    afterBio("mention that my real name is Anastasia", "Her real name is Anastasia."),
    afterBio("add that I'm dedicated to my students", "She is dedicated to her students."),
    afterBio("mention that I sold my first web app at nineteen", "She sold her first web app at nineteen."),
    afterBio("mention that my students once made a short film about me", "Her students once made a short film about her."),
    afterBio("add that I'm the owner of a small farm", "She is the owner of a small farm."),
    afterBio("add that I spent twenty years as a publisher", "She spent twenty years as a publisher."),
    afterBio("mention that I'm a part owner of a bookstore", "She is a part owner of a bookstore."),
    afterBio("add that I also run a website about rock climbing", "She also runs a website about rock climbing."),
    afterBio("say that I have a pen name for my mystery novels", "She has a pen name for her mystery novels."),
    afterBio("add that I'm a former publishing executive", "She is a former publishing executive."),
    afterBio("add that I host a site for young chemists", "She hosts a site for young chemists."),
    afterBio("mention that I'm a restaurant owner on weekends", "On weekends she is a restaurant owner."),
    afterBio("add that I was born in Lima and my birth name is Ana Quispe", "She was born in Lima, and her birth name is Ana Quispe."),
    afterBio("mention that I'm a copyright consultant for museums", "She is a copyright consultant for museums."),
    afterBio("add that I built my school's web portal", "She built her school's web portal."),
    afterBio("اضافه کن که در انتشارات ققنوس هم کار کرده‌ام", "او در انتشارات ققنوس هم کار کرده است.", FA_BIO, faBio),
    afterBio("بنویس که یک سایت آموزشی هم دارم", "او یک سایت آموزشی هم دارد.", FA_BIO, faBio),
    afterBio("اضافه کن که ناشر هم هستم", "او ناشر هم هست.", FA_BIO, faBio),
    afterBio("اضافه کن که کتاب قبلی‌ام را به شاگردانم تقدیم کردم", "او کتاب قبلی‌اش را به شاگردانش تقدیم کرده است.", FA_BIO, faBio),
    afterBio("بگو که در یک وبلاگ درباره‌ی شیمی می‌نویسم", "او در یک وبلاگ درباره‌ی شیمی می‌نویسد.", FA_BIO, faBio),
    afterDedication("add 'who always asked about me' after mom", "For my mom, who always asked about me"),
    afterDedication("say she never stopped worrying about me", "For my mom, who never stopped worrying about me"),
    afterDedication("add 'the owner of my heart'", "For my mom, the owner of my heart"),
    afterDedication("add 'and to my publisher, Lantern Press, for believing in this book'", "For my mom, and to my publisher, Lantern Press, for believing in this book"),
    afterDedication("also thank my editor at Lantern Publishing", "For my mom, and thank you to my editor at Lantern Publishing"),
    afterDedication("mention my sister too, who built my website", "For my mom and my sister, who built my website"),
    afterDedication("add 'and to Grandpa, who read me biographies every night'", "For my mom, and to Grandpa, who read me biographies every night"),
    afterDedication("add 'for everyone who believed in me before anyone knew my name'", "For my mom, and for everyone who believed in me before anyone knew my name"),
    afterDedication("add 'and to my husband, my co-author in life'", "For my mom, and to my husband, my co-author in life"),
    afterDedication("add 'who wrote my first bio in crayon'", "For my mom, who wrote my first bio in crayon"),
    afterDedication("add 'and to Leo, the best copyright lawyer I know'", "For my mom, and to Leo, the best copyright lawyer I know"),
    afterDedication("add 'and to the bookshop owner who let me read for free'", "For my mom, and to the bookshop owner who let me read for free"),
    afterDedication("add 'and to everyone at my publishing house'", "For my mom, and to everyone at my publishing house"),
    afterDedication("change it to 'For my mom, my first publisher'", "For my mom, my first publisher"),
    afterDedication("add 'and to my kids, who always ask about me'", "For my mom, and to my kids, who always ask about me"),
    afterDedication("add 'and to the web of friends who held me up'", "For my mom, and to the web of friends who held me up"),
    afterDedication("add my dad, the proud owner of a hardware store", "For my mom and my dad, the proud owner of a hardware store"),
    afterDedication("add 'and to Ms. Park, who let me use the school's web lab'", "For my mom, and to Ms. Park, who let me use the school's web lab"),
    afterDedication("mention my brother, who runs a site for lost dogs", "For my mom and my brother, who runs a site for lost dogs"),
    afterDedication("add 'who taught me that all rights come with duties'", "For my mom, who taught me that all rights come with duties"),
    afterDedication("add 'and to my agent, who found me a publisher'", "For my mom, and to my agent, who found me a publisher"),
    afterDedication("add 'and to Nana, who gave me my name'", "For my mom, and to Nana, who gave me my name"),
    afterDedication("add 'and to my mentor, a true web pioneer'", "For my mom, and to my mentor, a true web pioneer"),
    afterDedication("add 'and to the publishers who said no'", "For my mom, and to the publishers who said no"),
    afterDedication("add 'who read every draft written by me'", "For my mom, who read every draft written by me"),
    afterDedication("اضافه کن: و به ناشرم که به این کتاب ایمان داشت", "تقدیم به مادرم، و به ناشرم که به این کتاب ایمان داشت", { dedication: "تقدیم به مادرم" }),
    afterDedication("اضافه کن: و به پدرم که سایت خانوادگی‌مان را ساخت", "تقدیم به مادرم، و به پدرم که سایت خانوادگی‌مان را ساخت", { dedication: "تقدیم به مادرم" }),
    afterDedication("اضافه کن: و به انتشارات ققنوس", "تقدیم به مادرم و به انتشارات ققنوس", { dedication: "تقدیم به مادرم" }),
    afterDedication("بنویس: و به همه‌ی کسانی که درباره من نگران بودند", "تقدیم به مادرم و به همه‌ی کسانی که درباره من نگران بودند", { dedication: "تقدیم به مادرم" }),
    afterDedication("اضافه کن: و به خواهرم که بیوگرافی همه‌ی ما را نوشت", "تقدیم به مادرم و به خواهرم که بیوگرافی همه‌ی ما را نوشت", { dedication: "تقدیم به مادرم" }),
    // Beside a second field the message really names.
    [["aboutAuthor"], bio, "add that I'm also a proud dog owner, and the publisher is Lantern Books", [put("aboutAuthor", `${BIO} She is also a proud dog owner.`, "add that I'm also a proud dog owner"), put("imprint", "Lantern Books", "the publisher is Lantern Books")], { aboutAuthor: `${BIO} She is also a proud dog owner.`, imprint: "Lantern Books" }],
    [["dedication"], mom, "add 'who always asked about me', and my website is anaruiz.com", [put("dedication", "For my mom, who always asked about me", "add 'who always asked about me'"), put("authorWebsite", "anaruiz.com", "my website is anaruiz.com")], { dedication: "For my mom, who always asked about me", authorWebsite: "anaruiz.com" }],
    [["aboutAuthor"], bio, "mention that I worked in publishing for a decade. Also the ISBN is 978-0-306-40615-7", [put("aboutAuthor", `${BIO} She worked in publishing for a decade.`, "mention that I worked in publishing for a decade"), put("isbn", "978-0-306-40615-7", "the ISBN is 978-0-306-40615-7")], { aboutAuthor: `${BIO} She worked in publishing for a decade.`, isbn: "978-0-306-40615-7" }],
    [["dedication"], { ...mom, allRightsReserved: true }, "add 'and to everyone at my publishing house', and remove all rights reserved", [put("dedication", "For my mom, and to everyone at my publishing house", "add 'and to everyone at my publishing house'"), cut("allRightsReserved", "remove all rights reserved")], { dedication: "For my mom, and to everyone at my publishing house", allRightsReserved: false }],
    [["aboutAuthor"], bio, "add that I'm a web designer by trade and change the copyright holder to Ruiz Media", [put("aboutAuthor", `${BIO} She is a web designer by trade.`, "add that I'm a web designer by trade"), put("copyrightHolder", "Ruiz Media", "change the copyright holder to Ruiz Media")], { aboutAuthor: `${BIO} She is a web designer by trade.`, copyrightHolder: "Ruiz Media" }],
    [["aboutAuthor"], faBio, "اضافه کن که ناشر هم هستم و شابک ۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷ است", [put("aboutAuthor", `${FA_BIO} او ناشر هم هست.`, "اضافه کن که ناشر هم هستم"), put("isbn", "978-0-306-40615-7", "شابک ۹۷۸-۰-۳۰۶-۴۰۶۱۵-۷ است")], { aboutAuthor: `${FA_BIO} او ناشر هم هست.`, isbn: "978-0-306-40615-7" }]
  ];

  it("holds at least sixty follow-ups whose words spell another field's cue", () => {
    expect(followUps.length).toBeGreaterThanOrEqual(60);
  });

  it.each(followUps)("keeps the follow-up to %j in %j: %j", (...turn) => {
    expect(decideTurn(turn)).toEqual({ kind: "change", patch: turn[4] });
  });

  // The same words in a first request that never names its field: the only change is kept.
  const alone = (message: string, change: Change): Turn => [[], {}, message, [change], { [change.field]: change.text ?? null }];
  it.each([
    alone("For my mom, who always worried about me", put("dedication", "For my mom, who always worried about me", "For my mom, who always worried about me")),
    alone("To the bookshop owner who let me read for free", put("dedication", "To the bookshop owner who let me read for free", "To the bookshop owner who let me read for free")),
    alone("I'm a small business owner in Leeds who writes on weekends", put("aboutAuthor", "Ana Ruiz is a small business owner in Leeds who writes on weekends.", "I'm a small business owner in Leeds who writes on weekends")),
    alone("I spent ten years in publishing before I started writing", put("aboutAuthor", "Ana Ruiz spent ten years in publishing before she started writing.", "I spent ten years in publishing before I started writing")),
    alone("I'm a dedicated nurse in Leeds and a mother of two", put("aboutAuthor", "Ana Ruiz is a dedicated nurse in Leeds and a mother of two.", "I'm a dedicated nurse in Leeds and a mother of two")),
    alone("I design websites and write mysteries at night", put("aboutAuthor", "Ana Ruiz designs websites and writes mysteries at night.", "I design websites and write mysteries at night")),
    alone("To Leo, the best copyright lawyer I know", put("dedication", "To Leo, the best copyright lawyer I know", "To Leo, the best copyright lawyer I know")),
    alone("For everyone who knew my name before the world did", put("dedication", "For everyone who knew my name before the world did", "For everyone who knew my name before the world did")),
    alone("For my publisher, who never gave up on me", put("dedication", "For my publisher, who never gave up on me", "For my publisher, who never gave up on me")),
    alone("من ناشر هستم و در تهران زندگی می‌کنم", put("aboutAuthor", "آنا روئیز ناشر است و در تهران زندگی می‌کند.", "من ناشر هستم و در تهران زندگی می‌کنم"))
  ])("keeps the one change asked for in %j %j %j", (...turn) => {
    expect(decideTurn(turn)).toEqual({ kind: "change", patch: turn[4] });
  });

  // The loose cue words still name their field when they ask for it, beside a second change.
  const bioSite = { ...bio, authorWebsite: "anaruiz.com", imprint: "Lantern", isbn: "0-8044-2957-X" };
  it.each<Turn>([
    [[], {}, "change the owner to Ruiz Media and the publisher to Lantern", [put("copyrightHolder", "Ruiz Media", "change the owner to Ruiz Media"), put("imprint", "Lantern", "the publisher to Lantern")], { copyrightHolder: "Ruiz Media", imprint: "Lantern" }],
    [[], mom, "make my company, Ruiz Media, the owner, and remove the dedication", [put("copyrightHolder", "Ruiz Media", "make my company, Ruiz Media, the owner"), cut("dedication", "remove the dedication")], { copyrightHolder: "Ruiz Media", dedication: null }],
    [[], {}, "Owner: Ruiz Media. Publisher: Lantern.", [put("copyrightHolder", "Ruiz Media", "Owner: Ruiz Media"), put("imprint", "Lantern", "Publisher: Lantern")], { copyrightHolder: "Ruiz Media", imprint: "Lantern" }],
    [[], {}, "the rights owner is Ruiz Media, and add my website anaruiz.com", [put("copyrightHolder", "Ruiz Media", "the rights owner is Ruiz Media"), put("authorWebsite", "anaruiz.com", "add my website anaruiz.com")], { copyrightHolder: "Ruiz Media", authorWebsite: "anaruiz.com" }],
    [[], {}, "set the owner to me and remove all rights reserved", [put("copyrightHolder", "Ana Ruiz", "set the owner to me"), cut("allRightsReserved", "remove all rights reserved")], { copyrightHolder: "Ana Ruiz", allRightsReserved: false }],
    [[], bioSite, "remove my website and make the bio shorter", [cut("authorWebsite", "remove my website"), put("aboutAuthor", "Ana Ruiz teaches chemistry.", "make the bio shorter")], { authorWebsite: null, aboutAuthor: "Ana Ruiz teaches chemistry." }],
    [[], bioSite, "take the site off and change the publisher to Lantern Books", [cut("authorWebsite", "take the site off"), put("imprint", "Lantern Books", "change the publisher to Lantern Books")], { authorWebsite: null, imprint: "Lantern Books" }],
    [[], bioSite, "remove the web address and the ISBN", [cut("authorWebsite", "remove the web address"), cut("isbn", "the ISBN")], { authorWebsite: null, isbn: null }],
    [[], bioSite, "drop the site link, and the publisher too", [cut("authorWebsite", "drop the site link"), cut("imprint", "the publisher too")], { authorWebsite: null, imprint: null }],
    [[], {}, "add an about me: I teach chemistry. And dedicate it to my mom", [put("aboutAuthor", "Ana Ruiz teaches chemistry.", "add an about me: I teach chemistry"), put("dedication", "For my mom", "dedicate it to my mom")], { aboutAuthor: "Ana Ruiz teaches chemistry.", dedication: "For my mom" }],
    [[], { ...bio, ...mom }, "remove the about me page and the dedication", [cut("aboutAuthor", "remove the about me page"), cut("dedication", "the dedication")], { aboutAuthor: null, dedication: null }],
    [[], bio, "delete the about me section and add All rights reserved", [cut("aboutAuthor", "delete the about me section"), put("allRightsReserved", null, "add All rights reserved")], { aboutAuthor: null, allRightsReserved: true }],
    [[], {}, "about me: retired pilot, keeps bees. Publisher: Lantern.", [put("aboutAuthor", "Ana Ruiz is a retired pilot who keeps bees.", "about me: retired pilot, keeps bees"), put("imprint", "Lantern", "Publisher: Lantern")], { aboutAuthor: "Ana Ruiz is a retired pilot who keeps bees.", imprint: "Lantern" }],
    [[], bio, "get rid of the stuff about me at the back and add my site anaruiz.com", [cut("aboutAuthor", "get rid of the stuff about me at the back"), put("authorWebsite", "anaruiz.com", "add my site anaruiz.com")], { aboutAuthor: null, authorWebsite: "anaruiz.com" }],
    // Written after the first run, for the shapes the rule reads: a request beside a field it echoes.
    [[], {}, "Dedicate it to my publisher, Lantern Press, and make Lantern Press the publisher", [put("dedication", "For my publisher, Lantern Press", "Dedicate it to my publisher, Lantern Press"), put("imprint", "Lantern Press", "make Lantern Press the publisher")], { dedication: "For my publisher, Lantern Press", imprint: "Lantern Press" }],
    [["aboutAuthor"], bio, "add that I worked in publishing for a decade, and the publisher is Lantern Books", [put("aboutAuthor", `${BIO} She worked in publishing for a decade.`, "add that I worked in publishing for a decade"), put("imprint", "Lantern Books", "the publisher is Lantern Books")], { aboutAuthor: `${BIO} She worked in publishing for a decade.`, imprint: "Lantern Books" }]
  ])("keeps both changes named by %j %j in %j", (...turn) => {
    expect(decideTurn(turn)).toEqual({ kind: "change", patch: turn[4] });
  });

  // Riders: a byline removal quoting the whole message or a fragment of it, a
  // field whose quote is a cue word the asked change prints, and a lone change
  // of the last turn's field for a message about another one.
  const bioNow = { aboutAuthor: BIO, authorWebsite: "anaruiz.com", imprint: "Lantern", isbn: "0-8044-2957-X" };
  const W1 = "Write my bio: Ana Ruiz teaches chemistry in Ohio and keeps bees";
  const W2 = "بیوگرافی: آنا روئیز در اوهایو شیمی درس می‌دهد و زنبور نگه می‌دارد";
  const riders: Turn[] = [
    [[], bioNow, W1, [put("aboutAuthor", "Ana Ruiz teaches chemistry in Ohio and keeps bees.", W1), cut("authorName", W1)], { aboutAuthor: "Ana Ruiz teaches chemistry in Ohio and keeps bees." }],
    [[], { ...bioNow, ...faBio }, W2, [put("aboutAuthor", "آنا روئیز در اوهایو شیمی درس می‌دهد و زنبور نگه می‌دارد.", W2), cut("authorName", W2)], { aboutAuthor: "آنا روئیز در اوهایو شیمی درس می‌دهد و زنبور نگه می‌دارد." }],
    [[], {}, "Dedicate the book to Ana Ruiz's mother, Rosa", [put("dedication", "For Rosa", "Dedicate the book to Ana Ruiz's mother, Rosa"), cut("authorName", "Dedicate the book to Ana Ruiz's mother, Rosa")], { dedication: "For Rosa" }],
    [[], {}, "the copyright holder should be Ana Ruiz Media LLC", [put("copyrightHolder", "Ana Ruiz Media LLC", "the copyright holder should be Ana Ruiz Media LLC"), cut("authorName", "the copyright holder should be Ana Ruiz Media LLC")], { copyrightHolder: "Ana Ruiz Media LLC" }],
    [[], {}, "change the publisher to Ana Ruiz Books", [put("imprint", "Ana Ruiz Books", "change the publisher to Ana Ruiz Books"), cut("authorName", "change the publisher to Ana Ruiz Books")], { imprint: "Ana Ruiz Books" }],
    [[], bioNow, "Biografía: Ana Ruiz enseña química en Ohio", [put("aboutAuthor", "Ana Ruiz enseña química en Ohio.", "Biografía: Ana Ruiz enseña química en Ohio"), cut("authorName", "Biografía: Ana Ruiz enseña química en Ohio")], { aboutAuthor: "Ana Ruiz enseña química en Ohio." }],
    [[], bioNow, "Ana Ruiz teaches chemistry in Ohio — put that in the about the author", [put("aboutAuthor", BIO, "Ana Ruiz teaches chemistry in Ohio — put that in the about the author"), cut("authorName", "Ana Ruiz teaches chemistry in Ohio — put that in the about the author")], { aboutAuthor: BIO }],
    [["aboutAuthor"], bioNow, "add that Ana Ruiz also keeps bees", [put("aboutAuthor", `${BIO} She also keeps bees.`, "add that Ana Ruiz also keeps bees"), cut("authorName", "add that Ana Ruiz also keeps bees")], { aboutAuthor: `${BIO} She also keeps bees.` }],
    [[], bioNow, W1, [cut("authorName", W1)], {}],
    [["authorName"], bioNow, "Write my bio: Ana Ruiz teaches chemistry", [cut("authorName", "Write my bio: Ana Ruiz teaches chemistry")], {}],
    [[], bioNow, "Write my bio: Ana Ruiz teaches chemistry in Ohio", [put("aboutAuthor", BIO, "Write my bio: Ana Ruiz teaches chemistry in Ohio"), cut("authorName", "Ana Ruiz")], { aboutAuthor: BIO }],
    [[], { ...bioNow, ...faBio }, "بیوگرافی: آنا روئیز در اوهایو شیمی درس می‌دهد", [put("aboutAuthor", FA_BIO, "بیوگرافی: آنا روئیز در اوهایو شیمی درس می‌دهد"), cut("authorName", "آنا روئیز")], { aboutAuthor: FA_BIO }],
    [[], {}, "Dedicate it to my aunt, Ana Ruiz", [put("dedication", "For my aunt, Ana Ruiz", "Dedicate it to my aunt, Ana Ruiz"), cut("authorName", "Ana Ruiz")], { dedication: "For my aunt, Ana Ruiz" }],
    [["aboutAuthor"], bioNow, "add that I'm also a proud dog owner", [put("aboutAuthor", `${BIO} She is also a proud dog owner.`, "add that I'm also a proud dog owner"), put("copyrightHolder", "Ana Ruiz", "owner")], { aboutAuthor: `${BIO} She is also a proud dog owner.` }],
    [["dedication"], mom, "add 'and to my publisher, Lantern Press, for believing in this book'", [put("dedication", "For my mom, and to my publisher, Lantern Press, for believing in this book", "add 'and to my publisher, Lantern Press, for believing in this book'"), put("imprint", "Lantern Press", "my publisher, Lantern Press")], { dedication: "For my mom, and to my publisher, Lantern Press, for believing in this book" }],
    [["dedication"], { ...bioNow, ...mom }, "add 'who always asked about me'", [put("dedication", "For my mom, who always asked about me", "add 'who always asked about me'"), cut("aboutAuthor", "about me")], { dedication: "For my mom, who always asked about me" }],
    [["aboutAuthor"], bioNow, "mention that I'm a web designer by trade", [put("aboutAuthor", `${BIO} She is a web designer by trade.`, "mention that I'm a web designer by trade"), cut("authorWebsite", "web designer")], { aboutAuthor: `${BIO} She is a web designer by trade.` }],
    [["aboutAuthor"], bioNow, "say that I worked in publishing for a decade", [put("aboutAuthor", `${BIO} She worked in publishing for a decade.`, "say that I worked in publishing for a decade"), cut("imprint", "publishing")], { aboutAuthor: `${BIO} She worked in publishing for a decade.` }],
    [["dedication"], { ...mom, copyrightHolder: "Ruiz Media" }, "add 'the owner of my heart'", [put("dedication", "For my mom, the owner of my heart", "add 'the owner of my heart'"), put("copyrightHolder", "Ana Ruiz", "the owner")], { dedication: "For my mom, the owner of my heart" }],
    [["aboutAuthor"], bioNow, "add that I'm also a copyright lawyer", [put("aboutAuthor", `${BIO} She is also a copyright lawyer.`, "add that I'm also a copyright lawyer"), put("allRightsReserved", null, "copyright")], { aboutAuthor: `${BIO} She is also a copyright lawyer.` }],
    [["aboutAuthor"], bioNow, "add that I'm also a copyright lawyer", [put("aboutAuthor", `${BIO} She is also a copyright lawyer.`, "add that I'm also a copyright lawyer"), put("copyrightHolder", "Ana Ruiz", "copyright")], { aboutAuthor: `${BIO} She is also a copyright lawyer.` }],
    [["dedication"], { ...bioNow, ...mom }, "add 'and to Grandpa, who read me biographies every night'", [put("dedication", "For my mom, and to Grandpa, who read me biographies every night", "add 'and to Grandpa, who read me biographies every night'"), cut("aboutAuthor", "biographies")], { dedication: "For my mom, and to Grandpa, who read me biographies every night" }],
    [[], bioNow, "For my mom, who always worried about me", [put("dedication", "For my mom, who always worried about me", "For my mom, who always worried about me"), cut("aboutAuthor", "about me")], { dedication: "For my mom, who always worried about me" }],
    [["aboutAuthor"], bioNow, "Dedicate it to my dad", [put("aboutAuthor", BIO, "Dedicate it to my dad")], {}],
    [["aboutAuthor"], bioNow, "Dedicate it to my dad", [cut("aboutAuthor", "Dedicate it to my dad")], {}],
    [["dedication"], mom, "change the publisher to Lantern", [put("dedication", "For my mom", "change the publisher to Lantern")], {}],
    [["authorName"], { authorName: "Sam Lee" }, "Dedicate it to Ana Ruiz", [put("authorName", "Ana Ruiz", "Dedicate it to Ana Ruiz")], {}],
    [["imprint"], { imprint: "Lantern Press" }, "the copyright holder is Ruiz Media", [put("imprint", "Ruiz Media", "the copyright holder is Ruiz Media")], {}],
    [["aboutAuthor"], bioNow, "my website is anaruiz.net", [put("aboutAuthor", `${BIO} Find her at anaruiz.net.`, "my website is anaruiz.net")], {}],
    [["dedication"], { ...bioNow, ...mom }, "remove the about the author page", [cut("dedication", "remove the about the author page")], {}],
    [["aboutAuthor"], bioNow, "the ISBN is 978-0-306-40615-7", [put("aboutAuthor", BIO, "the ISBN is 978-0-306-40615-7")], {}],
    [[], bioNow, "این کتاب را به مادرم تقدیم کن", [put("dedication", "تقدیم به مادرم", "این کتاب را به مادرم تقدیم کن"), put("allRightsReserved", null, "این کتاب را به مادرم تقدیم کن"), cut("aboutAuthor", "این کتاب را به مادرم تقدیم کن")], { dedication: "تقدیم به مادرم" }],
    [["aboutAuthor"], bioNow, "تقدیمش کن به پدرم", [put("dedication", "تقدیم به پدرم", "تقدیمش کن به پدرم"), cut("aboutAuthor", "تقدیمش کن به پدرم")], { dedication: "تقدیم به پدرم" }],
    [[], {}, "Sam Lee wrote this book and dedicate it to my mom", [put("authorName", "Sam Lee", "Sam Lee wrote this book"), put("dedication", "For my mom", "dedicate it to my mom"), put("copyrightHolder", "Sam Lee", "Sam Lee wrote this book")], { authorName: "Sam Lee", dedication: "For my mom" }],
    [[], bioNow, "Use my real name, Sam Lee", [put("authorName", "Sam Lee", "Use my real name, Sam Lee"), cut("aboutAuthor", "Use my real name, Sam Lee")], { authorName: "Sam Lee" }],
    [[], { allRightsReserved: true }, "remove all rights reserved and change the publisher to Lantern", [cut("allRightsReserved", "remove all rights reserved"), put("imprint", "Lantern", "change the publisher to Lantern"), put("copyrightHolder", "Lantern", "change the publisher to Lantern")], { allRightsReserved: false, imprint: "Lantern" }],
    [["allRightsReserved"], { allRightsReserved: true }, "Write my bio: I teach chemistry", [put("aboutAuthor", "Ana Ruiz teaches chemistry.", "Write my bio: I teach chemistry"), cut("allRightsReserved", "Write my bio: I teach chemistry")], { aboutAuthor: "Ana Ruiz teaches chemistry." }],
    [["aboutAuthor"], bioNow, "Dedicate it to my dad", [put("dedication", "For my dad", "Dedicate it to my dad"), put("aboutAuthor", `${BIO} She dedicates this book to her dad.`, "Dedicate it to my dad")], { dedication: "For my dad" }],
    // Written after the first run: a rider that prints the request's own words, and one quoting the whole follow-up.
    [[], {}, "change the publisher to Lantern", [put("imprint", "Lantern", "change the publisher to Lantern"), put("dedication", "For my publisher Lantern", "change the publisher to Lantern")], { imprint: "Lantern" }],
    [["aboutAuthor"], bioNow, "add that I'm also a proud dog owner", [put("aboutAuthor", `${BIO} She is also a proud dog owner.`, "add that I'm also a proud dog owner"), put("copyrightHolder", "Ana Ruiz", "add that I'm also a proud dog owner")], { aboutAuthor: `${BIO} She is also a proud dog owner.` }]
  ];

  it("holds at least thirty answers with a rider", () => {
    expect(riders.length).toBeGreaterThanOrEqual(30);
  });

  it.each(riders)("drops what rode along with %j %j in %j", (...turn) => {
    const decision = normalizeReviewedFixture(answer(turn[3]), { message: turn[2], current: { ...current, ...turn[1] }, bookLanguage: "en", lastTurnFields: turn[0] }, turn[4]);
    const kept = decision.kind === "change" ? decision.patch : {};
    expect(kept).toEqual(turn[4]);
  });
});

/**
 * The sixth set, for round 9: a field named by the value the book prints in it
 * now. Removals that named their field only by its value were dropped ("Remove
 * Lantern Press", "Remove 'For Mom'": 5 of 37 kept), and so was every byline
 * rename quoted whole beside another field's word ("Change Ana Ruiz to Ana Park,
 * my publisher prefers it": 0 of 18). Written before the change and run once
 * before and once after it: 34 of 37 and 18 of 18 kept. The three still dropped
 * are recorded below — a quote that names another field ("from the copyright
 * page") and a two-request message quoted whole for both changes. Of 24 riders
 * that quote a field's value incidentally none leaks through value naming; the
 * one that leaks, before and after, rides on a cue ("pen name") the asked
 * biography prints, and is recorded.
 *
 * The same measuring turned up removal riders quoting the whole message whose
 * only cue is a word the asked dedication or biography prints ("add that I'm
 * also a copyright lawyer" deleted the © holder, and dropped the biography as
 * claimed): 14 of 16 leaked, then 12 of 12 in a second set written after the
 * counted rule and run once. Now none, while 8 of 8 and 12 of 12 legitimate
 * removals whose cue a co-change also prints are kept.
 */
describe("a field named by the value it prints, unseen", () => {
  type Patch = Record<string, string | boolean | null>;
  type Turn = readonly [lastTurn: BookMatterChatField[], now: Partial<BookMatterChatCurrent>, message: string, changes: Change[], patch: Patch];
  const put = (field: BookMatterChatField, text: string | null, requestedBy: string): Change => ({ field, action: "set", text, requestedBy });
  const cut = (field: BookMatterChatField, requestedBy: string): Change => ({ field, action: "remove", text: null, requestedBy });
  const NOW: BookMatterChatCurrent = {
    authorName: "Ana Ruiz",
    dedication: "For Mom",
    aboutAuthor: "Ana Ruiz teaches chemistry in Ohio and keeps bees.",
    authorWebsite: "www.anaruiz.com",
    copyrightHolder: "Ruiz Media",
    imprint: "Lantern Press",
    isbn: "978-0-306-40615-7",
    allRightsReserved: false
  };
  const B = NOW.aboutAuthor!;
  const FA_BIO = "آنا روئیز در اوهایو شیمی درس می‌دهد.";
  const FA = { authorName: "آنا روئیز", imprint: "نشر چشمه", dedication: "تقدیم به مادرم", copyrightHolder: "آنا روئیز", aboutAuthor: FA_BIO };
  const ES = { imprint: "Linterna Libros", dedication: "Para mi madre", copyrightHolder: "Ruiz Medios" };
  const decideTurn = ([lastTurn, now, message, changes, expected]: Turn) => {
    const decision = normalizeReviewedFixture(answer(changes), { message, current: { ...NOW, ...now }, bookLanguage: "en", lastTurnFields: lastTurn }, expected);
    return decision.kind === "change" ? decision.patch : {};
  };
  const turn = (now: Partial<BookMatterChatCurrent>, message: string, changes: Change[], patch: Patch, lastTurn: BookMatterChatField[] = []): Turn => [lastTurn, now, message, changes, patch];
  const whole = (message: string, field: BookMatterChatField, now: Partial<BookMatterChatCurrent> = {}): Turn => turn(now, message, [cut(field, message)], { [field]: null });

  const valueNamed: Turn[] = [
    whole("Remove Lantern Press", "imprint"),
    whole("take Ruiz Media off the book", "copyrightHolder"),
    whole("Remove 'For Mom'", "dedication"),
    whole("Lantern Press shouldn't be in there anymore", "imprint"),
    whole("Get rid of Ruiz Media, I closed the company", "copyrightHolder"),
    whole("delete 'For Mom', it feels too private now", "dedication"),
    whole("Take Ana Ruiz off the cover and the title page, I'd rather stay anonymous", "authorName"),
    turn({}, "Please remove Lantern Press and Ruiz Media", [cut("imprint", "Please remove Lantern Press and Ruiz Media"), cut("copyrightHolder", "Please remove Lantern Press and Ruiz Media")], { imprint: null, copyrightHolder: null }),
    turn({}, "Remove Lantern Press and add All rights reserved", [cut("imprint", "Remove Lantern Press"), put("allRightsReserved", null, "add All rights reserved")], { imprint: null, allRightsReserved: true }),
    turn({}, "Change Lantern Press to Moss Books and add All rights reserved", [put("imprint", "Moss Books", "Change Lantern Press to Moss Books"), put("allRightsReserved", null, "add All rights reserved")], { imprint: "Moss Books", allRightsReserved: true }),
    turn({}, "Swap Ruiz Media for Moss Media, and dedicate it to my dad", [put("copyrightHolder", "Moss Media", "Swap Ruiz Media for Moss Media"), put("dedication", "For my dad", "dedicate it to my dad")], { copyrightHolder: "Moss Media", dedication: "For my dad" }),
    turn({}, "drop 'For Mom' and add my website, anaruiz.net", [cut("dedication", "drop 'For Mom'"), put("authorWebsite", "anaruiz.net", "add my website, anaruiz.net")], { dedication: null, authorWebsite: "anaruiz.net" }),
    whole("Lantern Press is gone, remove it", "imprint"),
    whole("Remove www.anaruiz.com", "authorWebsite"),
    whole("remove 9780306406157 please", "isbn"),
    turn({}, "Change 'For Mom' to 'For Mom and Dad' and set the publisher to Moss Books", [put("dedication", "For Mom and Dad", "Change 'For Mom' to 'For Mom and Dad'"), put("imprint", "Moss Books", "set the publisher to Moss Books")], { dedication: "For Mom and Dad", imprint: "Moss Books" }),
    turn({}, "Replace Ruiz Media with Ana Ruiz and remove Lantern Press", [put("copyrightHolder", "Ana Ruiz", "Replace Ruiz Media with Ana Ruiz"), cut("imprint", "remove Lantern Press")], { copyrightHolder: "Ana Ruiz", imprint: null }),
    turn({}, "Rename Lantern Press to Lantern Books, and my website is anaruiz.net now", [put("imprint", "Lantern Books", "Rename Lantern Press to Lantern Books"), put("authorWebsite", "anaruiz.net", "my website is anaruiz.net now")], { imprint: "Lantern Books", authorWebsite: "anaruiz.net" }),
    whole("نشر چشمه رو حذف کن", "imprint", FA),
    whole("«تقدیم به مادرم» رو بردار", "dedication", FA),
    turn(FA, "آنا روئیز رو به سارا احمدی تغییر بده و نشر چشمه رو هم حذف کن", [put("authorName", "سارا احمدی", "آنا روئیز رو به سارا احمدی تغییر بده"), cut("imprint", "نشر چشمه رو هم حذف کن")], { authorName: "سارا احمدی", imprint: null }),
    whole("نشر چشمه رو از کتاب بردار، دیگه با اونا کار نمی‌کنم", "imprint", FA),
    whole("quita Linterna Libros", "imprint", ES),
    whole("borra «Para mi madre»", "dedication", ES),
    turn(ES, "cambia Ruiz Medios por Ana Ruiz y añade todos los derechos reservados", [put("copyrightHolder", "Ana Ruiz", "cambia Ruiz Medios por Ana Ruiz"), put("allRightsReserved", null, "añade todos los derechos reservados")], { copyrightHolder: "Ana Ruiz", allRightsReserved: true }),
    whole("elimina a Ana Ruiz de la portada", "authorName", ES),
    whole("I don't want Ruiz Media on there", "copyrightHolder"),
    turn({}, "Lose 'For Mom' and the website", [cut("dedication", "Lose 'For Mom'"), cut("authorWebsite", "the website")], { dedication: null, authorWebsite: null }),
    turn({}, "remove the 'For Mom' line and change Lantern Press to Moss Books", [cut("dedication", "remove the 'For Mom' line"), put("imprint", "Moss Books", "change Lantern Press to Moss Books")], { dedication: null, imprint: "Moss Books" }),
    turn({}, "change Ana Ruiz to A. Ruiz and remove 'For Mom'", [put("authorName", "A. Ruiz", "change Ana Ruiz to A. Ruiz"), cut("dedication", "remove 'For Mom'")], { authorName: "A. Ruiz", dedication: null }),
    turn({ dedication: "For my mom, who taught me to read and never once stopped believing in me." }, "Remove 'who taught me to read' and add All rights reserved", [put("dedication", "For my mom, who never once stopped believing in me.", "Remove 'who taught me to read'"), put("allRightsReserved", null, "add All rights reserved")], { dedication: "For my mom, who never once stopped believing in me.", allRightsReserved: true }),
    turn({}, "Take out 'and keeps bees' and change the publisher to Moss Books", [put("aboutAuthor", "Ana Ruiz teaches chemistry in Ohio.", "Take out 'and keeps bees'"), put("imprint", "Moss Books", "change the publisher to Moss Books")], { aboutAuthor: "Ana Ruiz teaches chemistry in Ohio.", imprint: "Moss Books" }),
    turn({}, "Moss Media instead of Ruiz Media, and remove 'For Mom'", [put("copyrightHolder", "Moss Media", "Moss Media instead of Ruiz Media"), cut("dedication", "remove 'For Mom'")], { copyrightHolder: "Moss Media", dedication: null }),
    turn({}, "no more Lantern Press, and change the copyright holder to Moss Media", [cut("imprint", "no more Lantern Press"), put("copyrightHolder", "Moss Media", "change the copyright holder to Moss Media")], { imprint: null, copyrightHolder: "Moss Media" })
  ];
  // Still dropped: a quote that names another field, and every change of a two-request message quoting it whole.
  const valueNamedDropped: Turn[] = [
    turn({}, "Remove Lantern Press from the copyright page", [cut("imprint", "Remove Lantern Press from the copyright page")], {}),
    turn({}, "Remove Lantern Press and add All rights reserved", [cut("imprint", "Remove Lantern Press and add All rights reserved"), put("allRightsReserved", null, "Remove Lantern Press and add All rights reserved")], { allRightsReserved: true }),
    turn({}, "Lose 'For Mom' and the website", [cut("dedication", "Lose 'For Mom' and the website"), cut("authorWebsite", "Lose 'For Mom' and the website")], { authorWebsite: null })
  ];

  it("holds at least thirty value-named changes", () => {
    expect(valueNamed.length + valueNamedDropped.length).toBeGreaterThanOrEqual(30);
  });

  it.each(valueNamed)("keeps the change named by its value in %j %j: %j", (...one) => {
    expect(decideTurn(one)).toEqual(one[4]);
  });

  it.each(valueNamedDropped)("records the value-named change still dropped in %j %j: %j", (...one) => {
    expect(decideTurn(one)).toEqual(one[4]);
  });

  const rename = (message: string, field: BookMatterChatField, text: string, now: Partial<BookMatterChatCurrent> = {}): Turn => turn(now, message, [put(field, text, message)], { [field]: text });
  const renames: Turn[] = [
    rename("Change Ana Ruiz to Ana Park, my publisher prefers it", "authorName", "Ana Park"),
    rename("Replace Ana Ruiz with Sam Lee, that's the name on my copyright filings too", "authorName", "Sam Lee"),
    rename("Swap Ana Ruiz for A. R. Ruiz, it's how I sign my website posts", "authorName", "A. R. Ruiz"),
    rename("Use Ana Park instead of Ana Ruiz, since my bio already says Ana Park", "authorName", "Ana Park"),
    rename("Ana Park, not Ana Ruiz — the dedication is to my husband's family and I use his name now", "authorName", "Ana Park"),
    rename("Make it Ana Ruiz-Park instead of Ana Ruiz; the publisher asked for the full name", "authorName", "Ana Ruiz-Park"),
    rename("Change Lantern Press to Moss Books, the copyright stays with me", "imprint", "Moss Books"),
    rename("Replace Ruiz Media with Ruiz Studio, it's the company in my bio", "copyrightHolder", "Ruiz Studio"),
    rename("Ana Ruiz should become Ana R. Park, matching my author website", "authorName", "Ana R. Park"),
    rename("Change Ana Ruiz to Ana Park, my married name, and keep the dedication as it is", "authorName", "Ana Park"),
    rename("آنا روئیز رو به آنا پارک تغییر بده، ناشرم این‌طوری می‌خواد", "authorName", "آنا پارک", { authorName: "آنا روئیز" }),
    rename("به جای آنا روئیز بنویس سارا احمدی، توی بیوگرافی هم همین اسم هست", "authorName", "سارا احمدی", { authorName: "آنا روئیز" }),
    rename("cambia Ana Ruiz por Ana Park, mi editorial lo prefiere", "authorName", "Ana Park"),
    rename("pon Ana Park en lugar de Ana Ruiz, como en mi biografía", "authorName", "Ana Park"),
    rename("Change Ruiz Media to Moss Media, Moss bought the rights from my publisher", "copyrightHolder", "Moss Media"),
    rename("Ana Ruiz → Ana Park please, it's also what my website says", "authorName", "Ana Park"),
    rename("Ana Park instead of Ana Ruiz, and don't touch the bio", "authorName", "Ana Park"),
    rename("Lantern Press is now Lantern House, the ISBN stays the same", "imprint", "Lantern House")
  ];

  it("holds at least fifteen renames quoted whole beside another field's word", () => {
    expect(renames.length).toBeGreaterThanOrEqual(15);
  });

  it.each(renames)("keeps the rename spelled out in %j %j: %j", (...one) => {
    expect(decideTurn(one)).toEqual(one[4]);
  });

  // Riders that quote a field's current value incidentally.
  const BIO1 = "Write my bio: I was an editor at Lantern Press for ten years";
  const DED1 = "For the Lantern Press book club, who read every draft";
  const rider = (now: Partial<BookMatterChatCurrent>, message: string, changes: Change[], patch: Patch): Turn => turn(now, message, changes, patch);
  const valueRiders: Turn[] = [
    rider({}, BIO1, [put("aboutAuthor", "Ana Ruiz was an editor at Lantern Press for ten years.", BIO1), cut("imprint", BIO1)], { aboutAuthor: "Ana Ruiz was an editor at Lantern Press for ten years." }),
    rider({}, BIO1, [put("aboutAuthor", "Ana Ruiz was an editor for ten years.", BIO1), cut("imprint", BIO1)], { aboutAuthor: "Ana Ruiz was an editor for ten years." }),
    rider({}, BIO1, [put("aboutAuthor", "Ana Ruiz was an editor at Lantern Press for ten years.", BIO1), cut("imprint", "Lantern Press")], { aboutAuthor: "Ana Ruiz was an editor at Lantern Press for ten years." }),
    rider({}, "Dedicate it to everyone at Lantern Press", [put("dedication", "For everyone at Lantern Press", "Dedicate it to everyone at Lantern Press"), cut("imprint", "Dedicate it to everyone at Lantern Press")], { dedication: "For everyone at Lantern Press" }),
    rider({}, "Dedicate it to the team at Ruiz Media", [put("dedication", "For the team at Ruiz Media", "Dedicate it to the team at Ruiz Media"), cut("copyrightHolder", "Dedicate it to the team at Ruiz Media")], { dedication: "For the team at Ruiz Media" }),
    rider({}, "Add to my bio that I founded Ruiz Media", [put("aboutAuthor", `${B} She founded Ruiz Media.`, "Add to my bio that I founded Ruiz Media"), cut("copyrightHolder", "Add to my bio that I founded Ruiz Media")], { aboutAuthor: `${B} She founded Ruiz Media.` }),
    rider({}, DED1, [put("dedication", DED1, DED1), cut("imprint", DED1)], { dedication: DED1 }),
    rider({}, "Write my bio: Ana Ruiz teaches chemistry at a school in Ohio", [put("aboutAuthor", "Ana Ruiz teaches chemistry at a school in Ohio.", "Write my bio: Ana Ruiz teaches chemistry at a school in Ohio"), cut("authorName", "Write my bio: Ana Ruiz teaches chemistry at a school in Ohio")], { aboutAuthor: "Ana Ruiz teaches chemistry at a school in Ohio." }),
    rider({}, "Dedicate the book to Ana Ruiz's students", [put("dedication", "For Ana Ruiz's students", "Dedicate the book to Ana Ruiz's students"), cut("authorName", "Dedicate the book to Ana Ruiz's students")], { dedication: "For Ana Ruiz's students" }),
    rider({}, "The copyright holder is Ana Ruiz, not Ruiz Media", [put("copyrightHolder", "Ana Ruiz", "The copyright holder is Ana Ruiz, not Ruiz Media"), cut("authorName", "The copyright holder is Ana Ruiz, not Ruiz Media")], { copyrightHolder: "Ana Ruiz" }),
    rider({ copyrightHolder: "Ana Ruiz" }, "Change the copyright holder from Ana Ruiz to Ruiz Media", [put("copyrightHolder", "Ruiz Media", "Change the copyright holder from Ana Ruiz to Ruiz Media"), put("authorName", "Ruiz Media", "Change the copyright holder from Ana Ruiz to Ruiz Media")], { copyrightHolder: "Ruiz Media" }),
    rider({}, "Write my bio: I wrote this for Mom after she retired", [put("aboutAuthor", "Ana Ruiz wrote this for her mom after she retired.", "Write my bio: I wrote this for Mom after she retired"), cut("dedication", "Write my bio: I wrote this for Mom after she retired")], { aboutAuthor: "Ana Ruiz wrote this for her mom after she retired." }),
    rider({}, "I write for Mom and for every teacher in Ohio", [put("aboutAuthor", "Ana Ruiz writes for her mom and for every teacher in Ohio.", "I write for Mom and for every teacher in Ohio"), cut("dedication", "I write for Mom and for every teacher in Ohio")], { aboutAuthor: "Ana Ruiz writes for her mom and for every teacher in Ohio." }),
    rider(FA, "بیوگرافی: ده سال در نشر چشمه ویراستار بودم", [put("aboutAuthor", "آنا روئیز ده سال در نشر چشمه ویراستار بود.", "بیوگرافی: ده سال در نشر چشمه ویراستار بودم"), cut("imprint", "بیوگرافی: ده سال در نشر چشمه ویراستار بودم")], { aboutAuthor: "آنا روئیز ده سال در نشر چشمه ویراستار بود." }),
    rider(ES, "Biografía: trabajé diez años en Linterna Libros", [put("aboutAuthor", "Ana Ruiz trabajó diez años en Linterna Libros.", "Biografía: trabajé diez años en Linterna Libros"), cut("imprint", "Biografía: trabajé diez años en Linterna Libros")], { aboutAuthor: "Ana Ruiz trabajó diez años en Linterna Libros." }),
    rider({ isbn: null }, "Dedicate it to my editor at Lantern Press, and the ISBN is 978-0-306-40615-7", [put("dedication", "For my editor at Lantern Press", "Dedicate it to my editor at Lantern Press"), put("isbn", "978-0-306-40615-7", "the ISBN is 978-0-306-40615-7"), cut("imprint", "Dedicate it to my editor at Lantern Press, and the ISBN is 978-0-306-40615-7")], { dedication: "For my editor at Lantern Press", isbn: "978-0-306-40615-7" }),
    rider({}, "Write my bio: Ana Ruiz runs Ruiz Media and Lantern Press", [put("aboutAuthor", "Ana Ruiz runs Ruiz Media and Lantern Press.", "Write my bio: Ana Ruiz runs Ruiz Media and Lantern Press"), cut("copyrightHolder", "Write my bio: Ana Ruiz runs Ruiz Media and Lantern Press"), cut("imprint", "Write my bio: Ana Ruiz runs Ruiz Media and Lantern Press"), cut("authorName", "Write my bio: Ana Ruiz runs Ruiz Media and Lantern Press")], { aboutAuthor: "Ana Ruiz runs Ruiz Media and Lantern Press." }),
    rider({}, "Dedicate it to Ana Ruiz's grandmother, Rosa Park", [put("dedication", "For Rosa Park", "Dedicate it to Ana Ruiz's grandmother, Rosa Park"), put("authorName", "Rosa Park", "Dedicate it to Ana Ruiz's grandmother, Rosa Park")], { dedication: "For Rosa Park" }),
    rider({}, "Copyright: Ruiz Media, which also owns Lantern Press", [put("copyrightHolder", "Ruiz Media", "Copyright: Ruiz Media"), cut("imprint", "Copyright: Ruiz Media, which also owns Lantern Press")], { copyrightHolder: "Ruiz Media" }),
    rider(ES, "Para el club de lectura de Linterna Libros", [put("dedication", "Para el club de lectura de Linterna Libros", "Para el club de lectura de Linterna Libros"), cut("imprint", "Para el club de lectura de Linterna Libros")], { dedication: "Para el club de lectura de Linterna Libros" }),
    rider(ES, "Para el club de lectura de Linterna Libros", [put("dedication", "Para el club de lectura de Linterna Libros", "Para el club de lectura de Linterna Libros"), cut("imprint", "Linterna Libros")], { dedication: "Para el club de lectura de Linterna Libros" }),
    rider({}, "Dedicate the book to Ana Ruiz's students", [put("dedication", "For Ana Ruiz's students", "Dedicate the book to Ana Ruiz's students"), put("authorName", "Ana Ruiz", "Dedicate the book to Ana Ruiz's students"), cut("copyrightHolder", "Dedicate the book to Ana Ruiz's students")], { dedication: "For Ana Ruiz's students" })
  ];

  it("holds at least fifteen riders quoting a field's value", () => {
    expect(valueRiders.length).toBeGreaterThanOrEqual(15);
  });

  it.each(valueRiders)("drops the value-quoting rider beside %j %j: %j", (...one) => {
    expect(decideTurn(one)).toEqual(one[4]);
  });

  // Recorded. The rider is blocked, but an asked dedication that names no field
  // is no longer the message's only change, so it goes too (as before round 9).
  it("drops an unnamed dedication beside a rider that quotes it whole", () => {
    expect(decideTurn(rider({}, DED1, [put("dedication", "For the book club, who read every draft", DED1), cut("imprint", DED1)], {}))).toEqual({});
  });

  // Recorded, before and after round 9: a set rider whose quote's cue the asked change prints.
  it("keeps a byline rider whose only cue is the biography's 'pen name'", () => {
    const message = "Add to my bio: Ana Ruiz is the pen name of Rosa Park";
    const one = rider({}, message, [put("aboutAuthor", "Ana Ruiz is the pen name of Rosa Park.", message), put("authorName", "Rosa Park", message)], {});
    expect(decideTurn(one)).toEqual({ aboutAuthor: "Ana Ruiz is the pen name of Rosa Park.", authorName: "Rosa Park" });
  });

  // Recorded: a lone removal the composer took from a message that names no
  // field only mentions the value, which a lone change of the field the
  // message names nothing else beside stands as (the reply names it).
  it.each([
    turn({}, BIO1, [cut("imprint", BIO1)], {}),
    turn({}, "Write my bio: Ana Ruiz teaches chemistry at a school in Ohio", [cut("authorName", "Write my bio: Ana Ruiz teaches chemistry at a school in Ohio")], {}),
    turn({}, DED1, [cut("imprint", DED1)], { imprint: null }),
    turn({}, "Copyright: Ruiz Media, which also owns Lantern Press", [cut("imprint", "which also owns Lantern Press"), put("copyrightHolder", "Ruiz Media", "Copyright: Ruiz Media")], { imprint: null, copyrightHolder: "Ruiz Media" })
  ])("records a lone or fragment removal by value in %j %j: %j", (...one) => {
    expect(decideTurn(one)).toEqual(one[4]);
  });

  // Removal riders quoting the whole message, whose only cue is a word the asked change newly prints.
  const bioRider = (message: string, added: string, field: BookMatterChatField, lastTurn: BookMatterChatField[] = ["aboutAuthor"]): Turn =>
    turn({}, message, [put("aboutAuthor", `${B} ${added}`, message), cut(field, message)], { aboutAuthor: `${B} ${added}` }, lastTurn);
  const dedicationRider = (message: string, text: string, field: BookMatterChatField, lastTurn: BookMatterChatField[] = []): Turn =>
    turn({}, message, [put("dedication", text, message), cut(field, message)], { dedication: text }, lastTurn);
  const cueRiders: Turn[] = [
    bioRider("add that I'm also a copyright lawyer", "She is also a copyright lawyer.", "copyrightHolder"),
    bioRider("say that I worked in publishing for years", "She worked in publishing for years.", "imprint"),
    bioRider("mention that I build websites for charities", "She builds websites for charities.", "authorWebsite"),
    bioRider("add that I ran a small publishing house", "She ran a small publishing house.", "imprint"),
    bioRider("add that I wrote a biography of my grandmother", "She wrote a biography of her grandmother.", "aboutAuthor"),
    bioRider("add that I edit a copyright newsletter", "She edits a copyright newsletter.", "copyrightHolder"),
    bioRider("mention that I'm the publisher of a local magazine", "She is the publisher of a local magazine.", "imprint"),
    bioRider("add that I host a website about bees", "She hosts a website about bees.", "authorWebsite"),
    turn({}, "Write my bio: I worked in publishing for years", [put("aboutAuthor", "Ana Ruiz worked in publishing for years.", "Write my bio: I worked in publishing for years"), cut("imprint", "Write my bio: I worked in publishing for years")], { aboutAuthor: "Ana Ruiz worked in publishing for years." }),
    turn({}, "Bio: I'm a copyright lawyer in Leeds", [put("aboutAuthor", "Ana Ruiz is a copyright lawyer in Leeds.", "Bio: I'm a copyright lawyer in Leeds"), cut("copyrightHolder", "Bio: I'm a copyright lawyer in Leeds")], { aboutAuthor: "Ana Ruiz is a copyright lawyer in Leeds." }),
    dedicationRider("Dedicate it to my publisher", "For my publisher", "imprint"),
    dedicationRider("Dedicate it to my web designer, Leo", "For my web designer, Leo", "authorWebsite"),
    dedicationRider("add 'and to my publisher, who believed in me'", "For Mom, and to my publisher, who believed in me", "imprint", ["dedication"]),
    dedicationRider("Dedicate it to the copyright team at the library", "For the copyright team at the library", "copyrightHolder"),
    dedicationRider("Dedication: for everyone who built the website with me", "For everyone who built the website with me", "authorWebsite"),
    dedicationRider("dedica el libro a mi editorial", "Para mi editorial", "imprint"),
    // The second set, written after the counted rule and run once.
    bioRider("add that I teach a copyright course", "She teaches a copyright course.", "copyrightHolder"),
    bioRider("add that I worked at the national ISBN agency", "She worked at the national ISBN agency.", "isbn"),
    dedicationRider("add 'and to my first publisher'", "For Mom, and to my first publisher", "imprint", ["dedication"]),
    dedicationRider("Dedicate it to the imprint team at Moss", "For the imprint team at Moss", "imprint"),
    turn({}, "Bio: I design websites for bakeries", [put("aboutAuthor", "Ana Ruiz designs websites for bakeries.", "Bio: I design websites for bakeries"), cut("authorWebsite", "Bio: I design websites for bakeries")], { aboutAuthor: "Ana Ruiz designs websites for bakeries." }),
    bioRider("say that I wrote under a pen name for years", "She wrote under a pen name for years.", "authorName"),
    turn({ authorName: "آنا روئیز", aboutAuthor: FA_BIO }, "اضافه کن که ناشر کتاب‌های کودک هم هستم", [put("aboutAuthor", `${FA_BIO} او ناشر کتاب‌های کودک هم هست.`, "اضافه کن که ناشر کتاب‌های کودک هم هستم"), cut("imprint", "اضافه کن که ناشر کتاب‌های کودک هم هستم")], { aboutAuthor: `${FA_BIO} او ناشر کتاب‌های کودک هم هست.` }, ["aboutAuthor"]),
    turn({}, "Biografía: soy editora en una editorial pequeña", [put("aboutAuthor", "Ana Ruiz es editora en una editorial pequeña.", "Biografía: soy editora en una editorial pequeña"), cut("imprint", "Biografía: soy editora en una editorial pequeña")], { aboutAuthor: "Ana Ruiz es editora en una editorial pequeña." }),
    dedicationRider("Dedication: to every publisher who said no", "To every publisher who said no", "imprint"),
    bioRider("add that I'm the copyright officer at my university", "She is the copyright officer at her university.", "copyrightHolder"),
    bioRider("add that my author website won an award", "Her author website won an award.", "authorWebsite")
  ];

  it.each(cueRiders)("drops the removal riding on the asked change's own words in %j %j: %j", (...one) => {
    expect(decideTurn(one)).toEqual(one[4]);
  });

  // Recorded: blocked, and the unnamed dedication beside it goes too.
  it("drops an unnamed dedication beside a removal riding on its words", () => {
    const message = "For my mom, who ran a tiny publishing house";
    expect(decideTurn(turn({}, message, [put("dedication", "For my mom, who ran a tiny publishing house", message), cut("imprint", message)], {}))).toEqual({});
  });

  // Removals named by a cue word that a co-change also prints: the message says it once more.
  const both = (now: Partial<BookMatterChatCurrent>, message: string, removed: BookMatterChatField, field: BookMatterChatField, text: string, lastTurn: BookMatterChatField[] = [], quotes: readonly [string, string] = [message, message]): Turn =>
    turn(now, message, [cut(removed, quotes[0]), put(field, text, quotes[1])], { [removed]: null, [field]: text }, lastTurn);
  const cueRemovals: Turn[] = [
    both({}, "remove my website and add to my bio that I build websites", "authorWebsite", "aboutAuthor", `${B} She builds websites.`),
    both({}, "Remove the publisher and dedicate it to my publisher's founder", "imprint", "dedication", "For my publisher's founder"),
    both({}, "remove the publisher, and add to my bio that I used to work in publishing", "imprint", "aboutAuthor", `${B} She used to work in publishing.`, [], ["remove the publisher", "add to my bio that I used to work in publishing"]),
    both({}, "take the copyright holder off and mention in my bio that I'm a copyright lawyer", "copyrightHolder", "aboutAuthor", `${B} She is a copyright lawyer.`, [], ["take the copyright holder off", "mention in my bio that I'm a copyright lawyer"]),
    both({}, "take the copyright holder off and mention in my bio that I'm a copyright lawyer", "copyrightHolder", "aboutAuthor", `${B} She is a copyright lawyer.`),
    turn({}, "remove the website", [cut("authorWebsite", "remove the website"), put("aboutAuthor", B, "remove the website")], { authorWebsite: null }, ["aboutAuthor"]),
    whole("delete the publisher", "imprint"),
    both({}, "Remove the website and dedicate it to the web team", "authorWebsite", "dedication", "For the web team", [], ["Remove the website", "dedicate it to the web team"]),
    // The second set, written after the counted rule and run once.
    both({}, "remove the ISBN, and add to my bio that I once worked at the ISBN agency", "isbn", "aboutAuthor", `${B} She once worked at the ISBN agency.`),
    both({}, "drop the copyright holder and dedicate the book to my copyright professor", "copyrightHolder", "dedication", "For my copyright professor"),
    both({}, "Delete the publisher. Bio: I'm a publisher too", "imprint", "aboutAuthor", "Ana Ruiz is a publisher too."),
    both({}, "take the website off, and in the dedication thank the website crew", "authorWebsite", "dedication", "For Mom, and thank you to the website crew", ["dedication"]),
    both({}, "remove my pen name and say in my bio that I used to write under a pen name", "authorName", "aboutAuthor", `${B} She used to write under a pen name.`),
    both({}, "remove my website and update my bio to say I no longer run a website", "authorWebsite", "aboutAuthor", `${B} She no longer runs a website.`),
    both({}, "remove the publisher, and my bio should say I'm a publisher", "imprint", "aboutAuthor", "Ana Ruiz is a publisher.", [], ["remove the publisher", "my bio should say I'm a publisher"]),
    both({ authorName: "آنا روئیز", aboutAuthor: FA_BIO }, "ناشر رو حذف کن و توی بیوگرافی بنویس که ناشر هم هستم", "imprint", "aboutAuthor", `${FA_BIO} او ناشر هم هست.`),
    both({}, "quita la editorial y en mi biografía pon que trabajo en una editorial", "imprint", "aboutAuthor", "Ana Ruiz trabaja en una editorial."),
    turn({ aboutAuthor: "Ana Ruiz teaches chemistry. Visit her website for more." }, "now remove the website", [cut("authorWebsite", "now remove the website"), put("aboutAuthor", "Ana Ruiz teaches chemistry. Visit her website for more.", "now remove the website")], { authorWebsite: null }, ["aboutAuthor"]),
    turn({ dedication: "For my publisher" }, "remove the publisher", [cut("imprint", "remove the publisher"), put("dedication", "For my publisher", "remove the publisher")], { imprint: null }, ["dedication"]),
    both({}, "take off the copyright holder, and the dedication should read: For everyone who taught me about copyright", "copyrightHolder", "dedication", "For everyone who taught me about copyright")
  ];

  it.each(cueRemovals)("keeps the removal its cue names beside a change that prints the cue in %j %j: %j", (...one) => {
    expect(decideTurn(one)).toEqual(one[4]);
  });
});
