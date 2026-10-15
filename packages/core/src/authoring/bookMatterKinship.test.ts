import { describe, expect, it } from "vitest";
import { normalizeBookMatterChatAnswer, type BookMatterChatCurrent, type BookMatterChatField } from "./bookMatterChatEdit.js";
import { normalizeReviewedMatterAnswer } from "./testing/reviewedMatterAnswer.js";

const current: BookMatterChatCurrent = {
  authorName: null, dedication: null, aboutAuthor: null, authorWebsite: null,
  copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false
};

function compose(bookLanguage: string, message: string, text: string, field: BookMatterChatField = "dedication") {
  return normalizeBookMatterChatAnswer(
    { outcome: "change", changes: [{ field, action: "set", text, requestedBy: message }] },
    { message, current, bookLanguage }
  );
}

const translations = [
  ["en", "For Mom", "For Dad"],
  ["es", "Para Mamá", "Para Papá"],
  ["fr", "Pour Maman", "Pour Papa"],
  ["de", "Für Mama", "Für Papa"],
  ["it", "Per Mamma", "Per Papà"],
  ["pt", "Para Mamãe", "Para Papai"],
  ["nl", "Voor Mama", "Voor Papa"],
  ["tr", "Canım Anneme", "Canım Babama"],
  ["ru", "Для Мамы", "Для Папы"],
  ["uk", "Для Мами", "Для Тата"],
  ["el", "Για τη Μαμά", "Για τον Μπαμπά"],
  ["pl", "Dla Mamy", "Dla Taty"],
  ["sv", "Till Mamma", "Till Pappa"],
  ["no", "Til Mamma", "Til Pappa"],
  ["da", "Til Mor", "Til Far"],
  ["vi", "Dành cho Mẹ", "Dành cho Bố"]
] as const;

describe("localized kinship in composed matter", () => {
  it.each([
    ["fa", "به مادرم تقدیم کن", "به پدرم تقدیم کن"],
    ["ar", "أهد الكتاب إلى أمي", "أهد الكتاب إلى أبي"],
    ["zh", "请把这本书献给我的妈妈。", "请把这本书献给我的爸爸。"],
    ["zh-TW", "請把這本書獻給我的媽媽。", "請把這本書獻給我的爸爸。"],
    ["ja", "この本を私の母に捧げてください", "この本を私の父に捧げてください"],
    ["ko", "이 책을 제 어머니께 헌정해 주세요", "이 책을 제 아버지께 헌정해 주세요"],
    ["hi", "यह किताब मेरी माँ को समर्पित करो", "यह किताब मेरे पिता को समर्पित करो"],
    ["ur", "یہ کتاب میری ماں کے نام کر دیں", "یہ کتاب میرے والد کے نام کر دیں"],
    ["he", "הקדש את הספר לאמא שלי", "הקדש את הספר לאבא שלי"],
    ["th", "อุทิศหนังสือเล่มนี้ให้แม่ของฉัน", "อุทิศหนังสือเล่มนี้ให้พ่อของฉัน"]
  ])("grounds a cased book's dedication from an uncased %s request", (_language, motherRequest, fatherRequest) => {
    for (const [language, mother, father] of [["es", "Para Mamá", "Para Papá"], ["en", "For Mom", "For Dad"]] as const) {
      expect(compose(language, motherRequest, mother)).toEqual({ kind: "change", patch: { dedication: mother } });
      expect(compose(language, fatherRequest, father)).toEqual({ kind: "change", patch: { dedication: father } });
      expect(compose(language, motherRequest, father)).toMatchObject({ kind: "refused", problem: { kind: "not_given" } });
      expect(compose(language, fatherRequest, mother)).toMatchObject({ kind: "refused", problem: { kind: "not_given" } });
    }
  });

  it.each([
    "أهد الكتاب إلى إيمي",
    "این کتاب را به مادرمهر تقدیم کن",
    "この本を私の母校に捧げてください",
    "请把这本书献给我的母校。"
  ])("does not turn a name or a compound into a mother: %s", (message) => {
    expect(compose("es", message, "Para Mamá")).toMatchObject({ kind: "refused", problem: { kind: "not_given" } });
  });

  it.each(translations)("grounds the same relation when translated into %s", (language, mother, father) => {
    expect(compose(language, "Dedicate it to my mom", mother)).toEqual({ kind: "change", patch: { dedication: mother } });
    expect(compose(language, "Dedicate it to my dad", father)).toEqual({ kind: "change", patch: { dedication: father } });
  });

  it.each([
    ["es", "Dedica el libro a mi madre", "Para Mamá"],
    ["fr", "Dédiez-le à ma mère", "Pour Maman"],
    ["it", "Dedica il libro a mia madre", "Per Mamma"],
    ["ru", "Посвяти книгу моей маме", "Для Мамы"],
    ["uk", "Присвяти книгу моїй мамі", "Для Мами"],
    ["pl", "Dedykuję książkę mojej matce", "Dla Mamy"],
    ["tr", "Kitabı anneme ithaf et", "Canım Anneciğime"],
    ["pt", "Dedique o livro à minha mãe", "Para Mamãe"],
    ["nl", "Draag het boek op aan mijn moeder", "Voor Mama"],
    ["el", "Αφιέρωσε το βιβλίο στη μητέρα μου", "Για τη Μαμά"],
    ["sv", "Tillägna boken min mor", "Till Mamma"],
    ["no", "Dediser boken til min mor", "Til Mamma"],
    ["da", "Dediker bogen til min moder", "Til Mor"],
    ["vi", "Dành tặng cuốn sách cho mẹ tôi", "Dành cho Má"],
    ["Spanish", "Dedicate it to my mom", "Para Mamá"],
    ["fr-CA", "Dedicate it to my mom", "Pour Maman"]
  ])("grounds synonyms and grammatical forms in %s", (language, message, text) => {
    expect(compose(language, message, text)).toEqual({ kind: "change", patch: { dedication: text } });
  });

  it.each(translations.filter(([language]) => language !== "de"))(
    "does not infer a different relation or add a named person in %s", (language, mother, father) => {
      for (const text of [father, `${mother} Alexandra`, `${mother} 2027`, `${mother} example.com`]) {
        expect(compose(language, "Dedicate it to my mom", text)).toMatchObject({ kind: "refused", problem: { kind: "not_given" } });
      }
    }
  );

  it.each(["authorName", "copyrightHolder", "imprint"] as const)("does not translate kinship into identity field %s", (field) => {
    const cue = { authorName: "author", copyrightHolder: "copyright holder", imprint: "publisher" }[field];
    expect(compose("es", `Set the ${cue} to my mother`, "Mamá", field)).toMatchObject({ kind: "refused", problem: { kind: "not_given", field } });
  });

  it("does not infer Turkish mother from a supplied proper name Anne", () => {
    expect(compose("tr", "Dedicate this to Anne", "Canım Anneme")).toMatchObject({ kind: "refused", problem: { kind: "not_given" } });
    expect(compose("tr", "Dedicate it to my friend Anne", "Canım Anneme")).toMatchObject({ kind: "refused", problem: { kind: "not_given" } });
  });

  it("does not apply another language's kinship vocabulary", () => {
    expect(compose("en", "Dedicate it to my mom", "For Mamá")).toMatchObject({ kind: "refused", problem: { kind: "not_given" } });
  });

  it("accepts translated parent terms in a biography after complete-text review", () => {
    expect(normalizeReviewedMatterAnswer({ outcome: "change", changes: [
      { field: "aboutAuthor", action: "set", text: "Elle a appris de Maman." }
    ] }, { current, bookLanguage: "fr", message: "In my biography say I learned from my mother" }))
      .toEqual({ kind: "change", patch: { aboutAuthor: "Elle a appris de Maman." } });
    expect(compose("fr", "In my biography say I learned from my father", "Elle a appris de Maman.", "aboutAuthor"))
      .toMatchObject({ kind: "refused", problem: { kind: "not_given", field: "aboutAuthor" } });
  });
});
