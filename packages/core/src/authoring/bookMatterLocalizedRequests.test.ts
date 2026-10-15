import { describe, expect, it } from "vitest";

import {
  BOOK_MATTER_CHAT_LANGUAGES,
  normalizeBookMatterChatAnswer,
  type BookMatterChatCurrent,
  type BookMatterChatLanguage
} from "./bookMatterChatEdit.js";

const current: BookMatterChatCurrent = {
  authorName: null, dedication: null, aboutAuthor: null, authorWebsite: null,
  copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false
};

const cases: Record<BookMatterChatLanguage, { field: string; value: string; request: string; joined: string }> = {
  en: { field: "Add a dedication", value: "For my mother", request: "Also change the cover", joined: "and" },
  ar: { field: "أضف إهداء", value: "إلى أمي", request: "أيضاً غيّر الغلاف", joined: "و" },
  zh: { field: "添加献辞", value: "献给母亲", request: "另外修改封面", joined: "并且" },
  fr: { field: "Ajoute une dédicace", value: "Pour ma mère", request: "Change aussi la couverture", joined: "et" },
  de: { field: "Füge eine Widmung hinzu", value: "Für meine Mutter", request: "Ändere das Cover", joined: "und" },
  hi: { field: "समर्पण जोड़ें", value: "मेरी माँ के लिए", request: "कृपया कवर बदलें", joined: "और" },
  it: { field: "Aggiungi una dedica", value: "Per mia madre", request: "Cambia anche la copertina", joined: "e" },
  ja: { field: "献辞を追加", value: "母へ", request: "表紙を変更してください", joined: "そして" },
  ko: { field: "헌사를 추가", value: "어머니께", request: "표지를 바꿔 주세요", joined: "그리고" },
  fa: { field: "تقدیم‌نامه را اضافه کن", value: "تقدیم به مادرم", request: "جلد را عوض کن", joined: "و" },
  pt: { field: "Adicione uma dedicatória", value: "Para minha mãe", request: "Mude também a capa", joined: "e" },
  ru: { field: "Добавь посвящение", value: "Моей маме", request: "Также измени обложку", joined: "и" },
  es: { field: "Añade una dedicatoria", value: "Para mi madre", request: "También cambia la portada", joined: "y" },
  tr: { field: "Bir ithaf ekle", value: "Anneme", request: "Kapağı değiştir", joined: "ve" },
  ur: { field: "انتساب شامل کریں", value: "میری والدہ کے نام", request: "سرورق تبدیل کریں", joined: "اور" }
};

const otherTargets: Record<BookMatterChatLanguage, readonly [string, string]> = {
  en: ["Rewrite chapter 2", "Change the title"],
  ar: ["أعد كتابة الفصل ٢", "غيّر عنوان الكتاب"],
  zh: ["重写第2章", "更改书名"],
  fr: ["Réécris le chapitre 2", "Change le titre du livre"],
  de: ["Überarbeite Kapitel 2", "Ändere den Buchtitel"],
  hi: ["अध्याय २ को दोबारा लिखें", "पुस्तक का शीर्षक बदलें"],
  it: ["Riscrivi il capitolo 2", "Cambia il titolo del libro"],
  ja: ["第2章を書き直してください", "本のタイトルを変更してください"],
  ko: ["2장을 다시 써 주세요", "책 제목을 바꿔 주세요"],
  fa: ["فصل ۲ را بازنویسی کن", "عنوان کتاب را عوض کن"],
  pt: ["Reescreva o capítulo 2", "Mude o título do livro"],
  ru: ["Перепиши главу 2", "Измени название книги"],
  es: ["Reescribe el capítulo 2", "Cambia el título del libro"],
  tr: ["2. sayfayı değiştir", "Kitabın başlığını değiştir"],
  ur: ["باب ۲ دوبارہ لکھیں", "کتاب کا عنوان تبدیل کریں"]
};

function decide(message: string, value: string, language: BookMatterChatLanguage) {
  return normalizeBookMatterChatAnswer({
    outcome: "change", changes: [{ field: "dedication", action: "set", text: value, requestedBy: message }], unhandled: null
  }, { message, current, bookLanguage: language });
}

describe("translated requests beside a matter change", () => {
  it.each(BOOK_MATTER_CHAT_LANGUAGES)("names numbered prose and book-title edits in %s", (language) => {
    const { field, value, joined } = cases[language];
    for (const request of otherTargets[language]) {
      for (const separator of [". ", ` ${joined} `]) {
        const message = `${field}: ${value}${separator}${request}.`;
        expect(decide(message, value, language)).toEqual({ kind: "change", patch: { dedication: value }, unhandledUnquoted: true });
        expect(decide(message, `${value}${separator}${request}.`, language)).toEqual({
          kind: "refused", problem: { kind: "runs_on", field: "dedication" }, unhandledUnquoted: true
        });
      }
    }
  });

  it.each([
    ["hi", "समर्पण जोड़ें: मेरी माँ के लिए। कृपया कवर बदलें।", "मेरी माँ के लिए।"],
    ["ur", "انتساب شامل کریں: میری والدہ کے نام۔ سرورق تبدیل کریں۔", "میری والدہ کے نام۔"],
    ["zh", "添加献辞：献给母亲。请修改封面。", "献给母亲。"],
    ["ja", "献辞を追加：母へ。表紙を変更してください。", "母へ。"]
  ] as const)("reads native %s sentence boundaries", (language, message, value) => {
    expect(decide(message, value, language)).toEqual({ kind: "change", patch: { dedication: value }, unhandledUnquoted: true });
    expect(decide(message, message.slice(message.search(/[:：]/) + 1).trim(), language)).toEqual({
      kind: "refused", problem: { kind: "runs_on", field: "dedication" }, unhandledUnquoted: true
    });
  });

  it.each(BOOK_MATTER_CHAT_LANGUAGES)("names a separate %s cover edit even when the composer omits it", (language) => {
    const { field, value, request } = cases[language];
    const message = `${field}: ${value}. ${request}.`;
    expect(decide(message, `${value}.`, language)).toEqual({
      kind: "change", patch: { dedication: `${value}.` }, unhandledUnquoted: true
    });
  });

  it.each(BOOK_MATTER_CHAT_LANGUAGES)("refuses a %s request copied into the dedication", (language) => {
    const { field, value, request } = cases[language];
    const message = `${field}: ${value}. ${request}.`;
    expect(decide(message, `${value}. ${request}.`, language)).toEqual({
      kind: "refused", problem: { kind: "runs_on", field: "dedication" }, unhandledUnquoted: true
    });
  });

  it.each(BOOK_MATTER_CHAT_LANGUAGES)("separates a joined %s cover request", (language) => {
    const { field, value, request, joined } = cases[language];
    const message = `${field}: ${value} ${joined} ${request}.`;
    expect(decide(message, value, language)).toEqual({
      kind: "change", patch: { dedication: value }, unhandledUnquoted: true
    });
  });

  it.each([
    ["zh", "添加献辞：献给母亲并且请修改封面。", "献给母亲"],
    ["ja", "献辞を追加：母へ、そして表紙を変更してください。", "母へ"],
    ["es", "Añade una dedicatoria: Para mi madre y también cambia la portada.", "Para mi madre"],
    ["ar", "أضف إهداء: إلى أمي، غير الغلاف.", "إلى أمي"]
  ] as const)("finds the explicit %s joined request without spaces around its punctuation", (language, message, value) => {
    expect(decide(message, value, language)).toEqual({ kind: "change", patch: { dedication: value }, unhandledUnquoted: true });
  });

  it("keeps scans bounded on repeated translated conjunctions and leads", () => {
    const run = (count: number) => {
      const message = `Añade una dedicatoria: Para mi madre ${"y también ".repeat(count)}x`;
      const started = performance.now();
      expect(decide(message, "Para mi madre", "es")).toEqual({ kind: "change", patch: { dedication: "Para mi madre" } });
      return performance.now() - started;
    };
    run(50);
    const short = run(100);
    const long = run(1000);
    expect(long).toBeLessThan(Math.max(500, short * 20));
  });

  it.each(BOOK_MATTER_CHAT_LANGUAGES)("keeps quoted %s instructions as literal dedication text", (language) => {
    const { field, request } = cases[language];
    expect(decide(`${field}: «${request}.»`, `${request}.`, language)).toEqual({
      kind: "change", patch: { dedication: `${request}.` }
    });
  });

  it.each([
    ["es", "Para mi madre. Sigue dibujando en la portada de tu vida."],
    ["fr", "Pour ma mère. Continue à dessiner sur la couverture de ta vie."],
    ["de", "Für meine Mutter. Lies jedes Kapitel und träume weiter."],
    ["it", "Per mia madre. Continua a disegnare e a leggere ogni pagina."],
    ["pt", "Para minha mãe. Continue a desenhar e ler cada página."],
    ["ru", "Моей маме. Продолжай рисовать и читать каждую страницу."],
    ["tr", "Anneme. Her sayfayı oku ve hayal kurmaya devam et."],
    ["ar", "إلى أمي. استمري في الرسم واقرئي كل صفحة."],
    ["hi", "मेरी माँ के लिए. हर पृष्ठ पढ़ते रहो और सपने देखते रहो."],
    ["zh", "献给母亲。愿你继续画画，翻开每一页。"],
    ["ja", "母へ。絵を描き続け、すべてのページを楽しんでください。"],
    ["ko", "어머니께. 계속 그림을 그리고 모든 페이지를 즐기세요."],
    ["fa", "تقدیم به مادرم. هر صفحه را بخوان و به رویاپردازی ادامه بده."],
    ["ur", "میری والدہ کے نام. ہر صفحہ پڑھیں اور خواب دیکھتے رہیں."]
  ] as const)("keeps legitimate %s dedication prose", (language, value) => {
    expect(decide(`${cases[language].field}: ${value}`, value, language)).toEqual({ kind: "change", patch: { dedication: value } });
  });

  it.each([
    ["es", "También trabaja en portadas y cambia sus diseños cada año."],
    ["fr", "Elle change la couverture de ses carnets chaque année."],
    ["de", "Sie zeichnet Cover und ändert ihre Entwürfe oft."],
    ["it", "Cambia le copertine dei suoi quaderni ogni anno."],
    ["pt", "Muda as capas dos seus cadernos todos os anos."],
    ["ru", "Она меняет обложки своих блокнотов каждый год."],
    ["tr", "Defterlerinin kapaklarını her yıl değiştirir."],
    ["ar", "تغير أغلفة دفاترها كل عام."],
    ["hi", "वह हर साल अपनी नोटबुक का कवर बदलती है।"],
    ["zh", "她每年都会修改笔记本的封面。"],
    ["ja", "毎年ノートの表紙を変更しています。"],
    ["ko", "매년 공책의 표지를 바꿉니다."],
    ["fa", "او هر سال جلد دفترهایش را عوض می‌کند."],
    ["ur", "وہ ہر سال اپنی نوٹ بک کا سرورق تبدیل کرتی ہیں."]
  ] as const)("keeps legitimate %s biography prose", (language, value) => {
    const message = `Bio: ${value}`;
    expect(normalizeBookMatterChatAnswer({
      outcome: "change", changes: [{ field: "aboutAuthor", action: "set", text: value, requestedBy: message }]
    }, { message, current, bookLanguage: language })).toEqual({ kind: "change", patch: { aboutAuthor: value } });
  });

  it.each([
    ["es", "Hazla más corta"], ["fr", "Rends-la plus courte"], ["de", "Mach sie kürzer"],
    ["it", "Rendila più breve"], ["pt", "Deixe mais curta"], ["ru", "Сделай короче"],
    ["tr", "Daha kısa yap"], ["ar", "اجعلها أقصر"], ["hi", "इसे छोटा करें"],
    ["zh", "让它更短"], ["ja", "短くしてください"], ["ko", "더 짧게 해 주세요"],
    ["fa", "کوتاه‌ترش کن"], ["ur", "اسے مختصر کریں"]
  ] as const)("keeps a %s refinement of the dedication", (language, refine) => {
    const { field, value } = cases[language];
    expect(decide(`${field}: ${value}. ${refine}.`, value, language)).toEqual({ kind: "change", patch: { dedication: value } });
  });
});
