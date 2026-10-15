import { describe, expect, it } from "vitest";

import {
  bookMatterProseReviewCandidates,
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatContext,
  type BookMatterChatCurrent
} from "./bookMatterChatEdit.js";
import { acceptBookMatterGroundingReview, bookMatterGroundingMessages } from "./bookMatterProseGrounding.js";

const current: BookMatterChatCurrent = {
  authorName: null,
  dedication: null,
  aboutAuthor: null,
  authorWebsite: null,
  copyrightHolder: null,
  imprint: null,
  isbn: null,
  allRightsReserved: false
};

function decide(bookLanguage: string, message: string, text: string, field: "dedication" | "aboutAuthor" = "dedication") {
  return normalizeBookMatterChatAnswer({
    outcome: "change", changes: [{ field, action: "set", text, requestedBy: message }]
  }, { current, bookLanguage, message });
}

describe("names in composed matter without a distinctive capital", () => {
  it.each([
    ["fa", "کتاب را به مادرم تقدیم کن", "تقدیم به مادرم، مریم احمدی"],
    ["ar", "أهد الكتاب إلى أمي", "إلى أمي، فاطمة أحمد"],
    ["zh", "把这本书献给我的母亲", "献给我的母亲王丽"],
    ["ja", "この本を私の母に捧げてください", "私の母、山田花子に捧ぐ。"],
    ["ko", "이 책을 제 어머니께 헌정해주세요", "제 어머니 김영희께 바칩니다."],
    ["de", "Widme das Buch meiner Mutter", "Für meine Mutter, Maria Schneider."]
  ])("requires grounding for a name the reader never gave in %s", (language, message, text) => {
    expect(decide(language, message, text)).toEqual({ kind: "refused", problem: { kind: "not_given", field: "dedication" } });
  });

  it.each([
    ["fa", "زندگی‌نامه‌ام را بنویس، من معلم هستم", "مریم احمدی معلم است."],
    ["ar", "اكتب نبذتي، أنا معلمة", "فاطمة أحمد معلمة."],
    ["zh", "写作者简介，我是一名教师", "王丽是一名教师。"],
    ["ja", "著者紹介を書いてください。私は教師です", "山田花子は教師です。"],
    ["de", "Schreibe meine Biografie, ich unterrichte Chemie", "Maria Schneider unterrichtet Chemie."]
  ])("does not exempt a biography's first name in %s", (language, message, text) => {
    expect(decide(language, message, text, "aboutAuthor")).toEqual({ kind: "refused", problem: { kind: "not_given", field: "aboutAuthor" } });
  });

  it.each([
    ["fa", "کتاب را به مادرم تقدیم کن", "تقدیم به مادرم"],
    ["ar", "أهد الكتاب إلى أمي", "إلى أمي"],
    ["fa", "تقدیم‌نامه: تقدیم به مادرم، مریم احمدی", "تقدیم به مادرم، مریم احمدی"],
    ["ar", "الإهداء: إلى أمي، فاطمة أحمد", "إلى أمي، فاطمة أحمد"],
    ["zh", "献词：献给我的母亲王丽", "献给我的母亲王丽"],
    ["ja", "献辞：私の母、山田花子に捧ぐ。", "私の母、山田花子に捧ぐ。"],
    ["de", "Widme das Buch meiner Mutter", "Für meine Mutter."]
  ])("keeps a grounded dedication in %s", (language, message, text) => {
    expect(decide(language, message, text)).toMatchObject({ kind: "change", patch: { dedication: text } });
  });
});

describe("independent review of novel multilingual prose", () => {
  const composed = (text: string, field: "dedication" | "aboutAuthor" = "dedication"): BookMatterChatAnswer => ({
    outcome: "change", changes: [{ field, action: "set", text }]
  });
  const reviewed = (answer: BookMatterChatAnswer, context: BookMatterChatContext, verdicts: unknown = { verdicts: [{ id: 0, supported: true }] }) =>
    acceptBookMatterGroundingReview(verdicts, bookMatterProseReviewCandidates(answer, context), context);

  it.each([
    ["en", "Dedicate it to my mother", "For my mother. Alice, thank you for everything."],
    ["en", "Dedicate it to my mother", "For my mother.\nalice, thank you for everything."],
    ["en", "Dedicate it to my mother", "May, thank you for everything."],
    ["es", "Dedícalo a mi madre", "Para mi madre. Alicia, gracias por todo."],
    ["fr", "Dédie-le à ma mère", "Pour ma mère. Alice, merci pour tout."],
    ["ru", "Посвяти книгу моей маме", "Моей маме. Алиса, спасибо за всё."]
  ])("reviews the complete %s dedication when a sentence introduces an unsupplied name", (bookLanguage, message, text) => {
    const answer = composed(text);
    const context = { message, bookLanguage, current };
    expect(bookMatterProseReviewCandidates(answer, context)).toEqual([{ field: "dedication", text }]);
    expect(normalizeBookMatterChatAnswer(answer, context))
      .toEqual({ kind: "refused", problem: { kind: "not_given", field: "dedication" } });
    expect(normalizeBookMatterChatAnswer(answer, {
      ...context, proseReview: reviewed(answer, context, { verdicts: [{ id: 0, supported: false }] })
    }).kind).toBe("refused");
  });

  it.each([
    ["en", "Dedicate it to my mother", "For my mother. Thank you for everything."],
    ["en", "Dedicate it to my mother", "Gratitude to my mother, always."],
    ["es", "Dedícalo a mi madre", "Para mi madre, con todo mi amor."],
    ["fr", "Dédie-le à ma mère", "Pour ma mère, avec amour."]
  ])("accepts conventional %s dedication wording after an affirmative review", (bookLanguage, message, text) => {
    const answer = composed(text);
    const context = { message, bookLanguage, current };
    expect(bookMatterProseReviewCandidates(answer, context)).toEqual([{ field: "dedication", text }]);
    expect(normalizeBookMatterChatAnswer(answer, context).kind).toBe("refused");
    expect(normalizeBookMatterChatAnswer(answer, { ...context, proseReview: reviewed(answer, context) }))
      .toEqual({ kind: "change", patch: { dedication: text } });
  });

  it.each([
    ["en", "Write my bio: I am a teacher", "Maria is a licensed neurosurgeon."],
    ["en", "Write my bio: I am a teacher", "She is a licensed neurosurgeon."],
    ["es", "Escribe mi biografía: soy docente", "María es neurocirujana certificada."],
    ["fr", "Écris ma biographie : je suis professeur", "Marie est neurochirurgienne diplômée."]
  ])("requires complete-text review for novel %s biographies regardless of capitals", (bookLanguage, message, text) => {
    const answer = composed(text, "aboutAuthor");
    const context = { message, bookLanguage, current };
    expect(bookMatterProseReviewCandidates(answer, context)).toEqual([{ field: "aboutAuthor", text }]);
    expect(normalizeBookMatterChatAnswer(answer, context))
      .toEqual({ kind: "refused", problem: { kind: "not_given", field: "aboutAuthor" } });
    expect(normalizeBookMatterChatAnswer(answer, {
      ...context, proseReview: reviewed(answer, context, { verdicts: [{ id: 0, supported: false }] })
    }).kind).toBe("refused");
  });

  it("accepts a natural English biography only after complete-text review", () => {
    const context = { message: "Write my bio: I am a teacher", bookLanguage: "en", current };
    const text = "She teaches.";
    const answer = composed(text, "aboutAuthor");
    expect(bookMatterProseReviewCandidates(answer, context)).toEqual([{ field: "aboutAuthor", text }]);
    expect(normalizeBookMatterChatAnswer(answer, { ...context, proseReview: reviewed(answer, context) }))
      .toEqual({ kind: "change", patch: { aboutAuthor: text } });
  });

  it("does not review a biography copied from the reader or current matter", () => {
    const text = "Maria is a teacher.";
    const answer = composed(text, "aboutAuthor");
    for (const context of [
      { message: `Set my bio to: ${text}`, current },
      { message: "Use my supplied bio", current, readerTurns: [text] },
      { message: "Keep my bio", current: { ...current, aboutAuthor: text } }
    ]) {
      expect(bookMatterProseReviewCandidates(answer, context)).toEqual([]);
      expect(normalizeBookMatterChatAnswer(answer, context).kind).not.toBe("refused");
    }
  });

  it("does not review a complete dedication supplied by the reader or current matter", () => {
    const text = "Alice, thank you for everything.";
    const answer = composed(text);
    for (const context of [
      { message: `Set the dedication to: ${text}`, current, bookLanguage: "en" },
      { message: "Use my supplied dedication", current, readerTurns: [text], bookLanguage: "en" },
      { message: "Keep my dedication", current: { ...current, dedication: text }, bookLanguage: "en" }
    ]) {
      expect(bookMatterProseReviewCandidates(answer, context)).toEqual([]);
      expect(normalizeBookMatterChatAnswer(answer, context)).toEqual({ kind: "change", patch: { dedication: text } });
    }
  });

  it.each([
    ["fa", "کتاب را به مادرم تقدیم کن", "با عشق و سپاس، تقدیم به مادرم."],
    ["ar", "أهد الكتاب إلى أمي", "إلى أمي الغالية، بكل الحب والامتنان."],
    ["zh", "把这本书献给我的母亲", "谨以此书向亲爱的母亲表达感谢。"],
    ["ja", "この本を私の母に捧げてください", "大好きなお母さんへ、愛と感謝を込めて。"],
    ["ko", "이 책을 제 어머니께 헌정해주세요", "사랑하는 어머니께 감사의 마음을 담아."],
    ["de", "widme es meiner Mutter", "Meiner Mutter gewidmet. Danke für alles."],
    ["fa", "Dedicate this to my mother", "با عشق و سپاس، تقدیم به مادرم."]
  ])("keeps natural %s composing and translation after complete-text review", (bookLanguage, message, text) => {
    const answer = composed(text);
    const context = { message, bookLanguage, current };
    expect(bookMatterProseReviewCandidates(answer, context)).toEqual([{ field: "dedication", text }]);
    expect(normalizeBookMatterChatAnswer(answer, { ...context, proseReview: reviewed(answer, context) }))
      .toEqual({ kind: "change", patch: { dedication: text } });
  });

  it.each([
    ["fa", "زندگی‌نامه‌ام را بنویس: من مریم احمدی هستم و شیمی درس می‌دهم", "مریم احمدی معلم شیمی است."],
    ["ar", "اكتب نبذتي: اسمي فاطمة أحمد وأدرس الكيمياء", "فاطمة أحمد معلمة كيمياء."],
    ["zh", "写作者简介：我叫王丽，我教化学", "王丽是一位化学教师。"],
    ["de", "Schreibe meine Biografie: Ich heiße Maria Schneider und unterrichte Chemie", "Maria Schneider ist Chemielehrerin."]
  ])("keeps a supplied name in naturally composed %s biography", (bookLanguage, message, text) => {
    const answer = composed(text, "aboutAuthor");
    const context = { message, bookLanguage, current };
    expect(normalizeBookMatterChatAnswer(answer, { ...context, proseReview: reviewed(answer, context) }))
      .toEqual({ kind: "change", patch: { aboutAuthor: text } });
  });

  const context = { message: "کتاب را به مادرم تقدیم کن", bookLanguage: "fa", current };
  const text = "با عشق و سپاس، تقدیم به مادرم.";
  const answer = composed(text);

  it("binds a review to the exact field, text, message, history and current matter", () => {
    const proseReview = reviewed(answer, context);
    expect(normalizeBookMatterChatAnswer(composed(`${text} مریم احمدی`), { ...context, proseReview }).kind).toBe("refused");
    expect(normalizeBookMatterChatAnswer(composed(text, "aboutAuthor"), { ...context, message: "زندگی‌نامه بنویس", proseReview }).kind).toBe("refused");
    for (const changed of [
      { ...context, message: "کتاب را به پدرم تقدیم کن" },
      { ...context, readerTurns: ["من مریم احمدی هستم"] },
      { ...context, current: { ...current, dedication: "تقدیم به پدرم" } },
      { ...context, bookLanguage: "ar" }
    ]) expect(normalizeBookMatterChatAnswer(answer, { ...changed, proseReview }).kind).toBe("refused");
    expect(normalizeBookMatterChatAnswer(answer, { ...context, proseReview: { kind: "book_matter_prose_review" } }).kind).toBe("refused");
  });

  it.each([
    {},
    { verdicts: [] },
    { verdicts: [{ id: 0, supported: false }] },
    { verdicts: [{ id: 0, supported: true }, { id: 0, supported: true }] },
    { verdicts: [{ id: 1, supported: true }] },
    { verdicts: [{ id: 0, supported: "true" }] }
  ])("refuses an incomplete, negative or malformed review: %j", (verdicts) => {
    expect(normalizeBookMatterChatAnswer(answer, { ...context, proseReview: reviewed(answer, context, verdicts) }).kind).toBe("refused");
  });

  it("does not approve one field when the other candidate has no verdict", () => {
    const bothContext = { ...context, message: "تقدیم‌نامه و زندگی‌نامه را بنویس" };
    const both: BookMatterChatAnswer = { outcome: "change", changes: [
      { field: "dedication", action: "set", text, requestedBy: "تقدیم‌نامه" },
      { field: "aboutAuthor", action: "set", text: "او معلم شیمی است.", requestedBy: "زندگی‌نامه" }
    ] };
    expect(bookMatterProseReviewCandidates(both, bothContext)).toHaveLength(2);
    expect(normalizeBookMatterChatAnswer(both, { ...bothContext, proseReview: reviewed(both, bothContext) }).kind).toBe("refused");
  });

  it("still enforces literal numbers and addresses even when the reviewer approves", () => {
    for (const extra of ["سال ۲۰۲۶", "maryam.example.com"]) {
      const withFact = composed(`${text} ${extra}`);
      expect(normalizeBookMatterChatAnswer(withFact, { ...context, proseReview: reviewed(withFact, context) }).kind).toBe("refused");
    }
  });

  it("shows complete candidate text and source facts, without a composer entity list", () => {
    const messages = bookMatterGroundingMessages([{ field: "dedication", text }], context);
    expect(JSON.parse(messages[1]!.content)).toEqual({
      readerMessage: context.message, readerTurns: [], currentMatter: current, bookLanguage: "fa",
      candidates: [{ id: 0, field: "dedication", text }]
    });
    expect(messages[0]!.content).toContain("ALL named people");
  });

  it("skips semantic review for supplied text and mechanically grounded short dedications", () => {
    for (const [message, candidate] of [
      ["تقدیم‌نامه: تقدیم به مادرم، مریم احمدی", "تقدیم به مادرم، مریم احمدی"],
      ["کتاب را به مادرم تقدیم کن", "تقدیم به مادرم"]
    ]) expect(bookMatterProseReviewCandidates(composed(candidate!), { ...context, message: message! })).toEqual([]);
  });

  it.each([
    ["en", "Dedicate it to my mother", "For Mom"],
    ["en", "Dedicate it to my mom", "For my mother."],
    ["es", "Dedícalo a mi madre", "Para Mamá"],
    ["fr", "Dédie-le à ma mère", "Pour Maman"],
    ["de", "Widme es meiner Mutter", "Für meine Mutter."],
    ["it", "Dedicalo a mia madre", "Per Mamma"],
    ["ru", "Посвяти книгу моей маме", "Для Мамы"],
    ["tr", "Kitabı anneme ithaf et", "Canım Anneme"]
  ])("skips review only for the complete provable short %s dedication", (bookLanguage, message, text) => {
    const context = { message, bookLanguage, current };
    expect(bookMatterProseReviewCandidates(composed(text), context)).toEqual([]);
    expect(normalizeBookMatterChatAnswer(composed(text), context)).toEqual({ kind: "change", patch: { dedication: text } });
    const expanded = `${text}\nAlice, thank you for everything.`;
    expect(bookMatterProseReviewCandidates(composed(expanded), context)).toEqual([{ field: "dedication", text: expanded }]);
    expect(normalizeBookMatterChatAnswer(composed(expanded), context).kind).toBe("refused");
  });

  it("reviews novel biographies with international URLs and keeps literal address checks", () => {
    const address = "https://例子.公司/著者";
    const source = { ...context, bookLanguage: "en", message: `Write my bio: I write novels. My website is ${address}` };
    const biography = (text: string): BookMatterChatAnswer => ({ outcome: "change", changes: [
      { field: "aboutAuthor", action: "set", text, requestedBy: source.message }
    ] });
    const plain = biography(`I write novels. Visit ${address}。`);
    expect(bookMatterProseReviewCandidates(plain, source)).toHaveLength(1);
    expect(normalizeBookMatterChatAnswer(plain, { ...source, proseReview: reviewed(plain, source) }).kind).toBe("change");
    const withName = biography(`I write novels. Visit ${address}。王丽`);
    expect(bookMatterProseReviewCandidates(withName, source)).toHaveLength(1);
    expect(normalizeBookMatterChatAnswer(withName, source).kind).toBe("refused");
  });
});
