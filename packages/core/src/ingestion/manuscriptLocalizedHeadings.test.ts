import { describe, expect, it } from "vitest";
import { parseManuscript, type ManuscriptImportFormat } from "./manuscriptImport.js";

const CHAPTERS = [
  { language: "French", first: "Chapitre 1", second: "Chapitre 2", about: "À propos de l’auteur" },
  { language: "German", first: "Kapitel I", second: "Kapitel II", about: "Über den Autor" },
  { language: "Spanish", first: "Capítulo 1", second: "Capítulo 2", about: "Sobre el autor" },
  { language: "Portuguese", first: "Capítulo 1", second: "Capítulo 2", about: "Sobre o autor" },
  { language: "Italian", first: "Capitolo 1", second: "Capitolo 2", about: "L’autore" },
  { language: "Russian", first: "Глава 1", second: "Глава 2", about: "Об авторе" },
  { language: "Turkish", first: "Bölüm 1", second: "Bölüm 2", about: "Yazar hakkında" },
  { language: "Persian ordinals", first: "فصل اول", second: "فصل دوم", about: "دربارهٔ نویسنده" },
  { language: "Persian numerals", first: "فصل ۱", second: "فصل ۲", about: "دربارهٔ نویسنده" },
  ...["یازدهم", "دوازدهم", "نوزدهم", "بیستم", "بیست و یکم", "نود و نهم", "صدم", "صد و یکم", "نهصد و نود و نهم"].map((number) => ({
    language: `Persian written ${number}`, first: "فصل دهم", second: `فصل ${number}`, about: "دربارهٔ نویسنده"
  })),
  ...["deux", "onze", "vingt et un", "vingt-deux", "trente-neuvième", "quatre-vingt-dix-neuf", "cent un", "centième"].map((number) => ({
    language: `French written ${number}`, first: "Chapitre premier", second: `Chapitre ${number}`, about: "À propos de l’auteur"
  })),
  ...["dos", "once", "veintitrés", "treinta y dos", "vigésimo primero", "nonagésimo noveno", "centésimo"].map((number) => ({
    language: `Spanish written ${number}`, first: "Capítulo primero", second: `Capítulo ${number}`, about: "Sobre el autor"
  })),
  ...[
    "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf",
    "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig",
    "einundzwanzig", "dreißig", "einunddreissig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig",
    "neunundneunzig", "hundert", "einhunderteins", "zweihundertelf", "neunhundertneunundneunzig"
  ].map((number) => ({
    language: `German cardinal ${number}`, first: "Erstes Kapitel", second: `Kapitel ${number}`, about: "Über den Autor"
  })),
  ...[
    "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci", "undici", "dodici",
    "tredici", "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove", "venti",
    "ventuno", "ventitré", "ventotto", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta",
    "novantanove", "cento", "centouno", "centotto", "centottanta", "duecentoundici", "novecentonovantanove"
  ].map((number) => ({
    language: `Italian cardinal ${number}`, first: "Capitolo primo", second: `Capitolo ${number}`, about: "L’autore"
  })),
  ...[
    "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять", "одиннадцать",
    "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать",
    "девятнадцать", "двадцать один", "тридцать два", "сорок три", "пятьдесят четыре", "шестьдесят пять",
    "семьдесят шесть", "восемьдесят семь", "девяносто восемь", "сто один", "двести одиннадцать", "триста",
    "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот девяносто девять"
  ].map((number) => ({
    language: `Russian cardinal ${number}`, first: "Глава первая", second: `Глава ${number}`, about: "Об авторе"
  })),
  ...[
    "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on", "on bir", "on iki",
    "on üç", "on dört", "on beş", "on altı", "on yedi", "on sekiz", "on dokuz", "yirmi bir", "otuz iki",
    "kırk üç", "elli dört", "altmış beş", "yetmiş altı", "seksen yedi", "doksan sekiz", "yüz bir",
    "iki yüz on bir", "dokuz yüz doksan dokuz"
  ].map((number) => ({
    language: `Turkish cardinal ${number}`, first: "Birinci bölüm", second: `Bölüm ${number}`, about: "Yazar hakkında"
  })),
  { language: "German later ordinal", first: "Erstes Kapitel", second: "Einundzwanzigstes Kapitel", about: "Über den Autor" },
  { language: "German eszett ordinal", first: "Dreißigstes Kapitel", second: "Einunddreißigstes Kapitel", about: "Über den Autor" },
  { language: "Portuguese later ordinal", first: "Capítulo primeiro", second: "Capítulo vigésimo segundo", about: "Sobre o autor" },
  { language: "Italian later ordinal", first: "Capitolo primo", second: "Capitolo ventunesimo", about: "L’autore" },
  { language: "Russian later ordinal", first: "Глава первая", second: "Глава двадцать первая", about: "Об авторе" },
  { language: "Turkish later ordinal", first: "Birinci bölüm", second: "Yirmi üçüncü bölüm", about: "Yazar hakkında" },
  { language: "Arabic later ordinal", first: "الفصل الأول", second: "الفصل الحادي والعشرون", about: "عن المؤلف" },
  { language: "French punctuated", first: "Chapitre 1.", second: "Chapitre 2.", about: "À propos de l’auteur" },
  { language: "Persian punctuated", first: "فصل اول:", second: "فصل دوم:", about: "دربارهٔ نویسنده" },
  { language: "Japanese punctuated", first: "第一章。", second: "第二章。", about: "著者について" },
  { language: "Arabic", first: "الفصل الأول", second: "الفصل الثاني", about: "عن المؤلف" },
  { language: "Urdu", first: "باب ۱", second: "باب ۲", about: "مصنف کے بارے میں" },
  { language: "Hindi", first: "अध्याय १", second: "अध्याय २", about: "लेखक के बारे में" },
  { language: "Chinese", first: "第一章", second: "第二章", about: "关于作者" },
  { language: "Japanese", first: "第一章", second: "第二章", about: "著者について" },
  { language: "Chinese attached title", first: "第一章", second: "第二章归乡", about: "关于作者" },
  { language: "Traditional Chinese attached title", first: "第一章", second: "第二章歸鄉", about: "關於作者" },
  { language: "Japanese attached kanji title", first: "第一章", second: "第二章帰り道", about: "著者について" },
  { language: "Japanese attached hiragana title", first: "第一章", second: "第二章ふるさと", about: "著者について" },
  { language: "Japanese attached katakana title", first: "第一章", second: "第二章クリスマス", about: "著者について" },
  { language: "Korean", first: "제1장", second: "제2장", about: "저자 소개" },
  { language: "Hebrew", first: "פרק א׳", second: "פרק ב׳", about: "על המחבר" }
];

function manuscript(lines: string[], format: "text" | "rtf"): { data: Buffer; format: ManuscriptImportFormat } {
  // Test the RTF splitter with literal UTF-8, as supported by stripRtf.
  return {
    format,
    data: Buffer.from(format === "text" ? lines.join("\n\n") : `{\\rtf1 ${lines.join("\\par\\par ")}}`)
  };
}

describe.each(["text", "rtf"] as const)("localized %s manuscript boundaries", (format) => {
  it("keeps the reported Italian cardinal chapter two in the manuscript", async () => {
    const parsed = await parseManuscript(manuscript([
      "Capitolo primo", "La viaggiatrice apre la porta.", "L’autore", "Questa scena fa parte della storia.",
      "Capitolo due", "La viaggiatrice raggiunge il mare."
    ], format));

    expect(parsed.matter?.aboutAuthor).toBeUndefined();
    expect(parsed.sections.at(-1)).toEqual({ title: "Capitolo due", text: "La viaggiatrice raggiunge il mare." });
    expect(parsed.text).toContain("Questa scena fa parte della storia.");
    expect(parsed.text).toContain("La viaggiatrice raggiunge il mare.");
  });

  it("keeps the reported Persian chapter eleven in the manuscript", async () => {
    const parsed = await parseManuscript(manuscript([
      "فصل دهم", "متن فصل دهم باید در کتاب بماند.", "دربارهٔ نویسنده", "این بخش از داستان است.",
      "فصل یازدهم", "متن فصل یازدهم هم باید در کتاب بماند."
    ], format));

    expect(parsed.matter?.aboutAuthor).toBeUndefined();
    expect(parsed.sections.at(-1)).toEqual({ title: "فصل یازدهم", text: "متن فصل یازدهم هم باید در کتاب بماند." });
    expect(parsed.text).toContain("این بخش از داستان است.");
    expect(parsed.text).toContain("متن فصل یازدهم هم باید در کتاب بماند.");
  });

  it.each(CHAPTERS)("preserves mid-book matter followed by a $language chapter", async ({ first, second, about }) => {
    const parsed = await parseManuscript(manuscript([
      first, "The traveller opened the gate.", about, "This scene belongs in the story.", second, "The traveller reached the sea."
    ], format));

    expect(parsed.matter?.aboutAuthor).toBeUndefined();
    expect(parsed.matterRemoved ?? []).not.toContain("about_author");
    expect(parsed.sections).toEqual([
      { title: first, text: "The traveller opened the gate." },
      { title: about, text: "This scene belongs in the story." },
      { title: second, text: "The traveller reached the sea." }
    ]);
  });

  it.each(CHAPTERS)("still extracts a genuine trailing $language biography", async ({ first, second, about }) => {
    const parsed = await parseManuscript(manuscript([
      first, "The traveller opened the gate.", second, "The traveller reached the sea.", about, "The author lives by the sea."
    ], format));

    expect(parsed.sections.map((section) => section.title)).toEqual([first, second]);
    expect(parsed.matter?.aboutAuthor).toBe("The author lives by the sea.");
    expect(parsed.matterRemoved).toEqual(["about_author"]);
  });

  it("keeps sentences beginning with chapter words and East Asian ordinals in their paragraphs", async () => {
    const lines = [
      "Chapitre 2 raconte cette histoire.",
      "Chapitre onze raconte cette histoire !",
      "Chapitre vingt-deux raconte cette histoire !",
      "Chapitre trente-neuvième: elle raconte cette histoire.",
      "Capítulo treinta y dos cuenta esta historia?",
      "Kapitel einundzwanzig erzählt diese Geschichte!",
      "Capitolo ventitré racconta questa storia?",
      "Глава двадцать один рассказывает эту историю!",
      "Bölüm on bir bu hikâyeyi anlatıyor!",
      "Kapitel elf: sie erzählt diese Geschichte.",
      "Capitolo due: lei racconta questa storia.",
      "Глава одиннадцать: она рассказывает эту историю.",
      "Bölüm on bir: bu hikâyeyi anlatıyor.",
      "فصل یازدهم دربارهٔ یک سفر است",
      "Chapitre 2: elle raconte cette histoire.",
      "Chapitre 2 raconte cette histoire !",
      "Capítulo 2 cuenta esta historia?",
      "Capítulo: ¿Quién eres?",
      "فصل الشتاء قصير",
      "第一歩を踏み出した。",
      "第二章讲述了她的归乡。",
      "第二章讲述了她的归乡！",
      "第二章讲述了她的归乡吗？",
      "第二章では旅が続く。",
      "第二章では旅が続く！",
      "第二章では旅が続く？",
      "제2장에서 이야기가 계속된다.",
      "제2장에서 이야기가 계속된다?"
    ];
    const parsed = await parseManuscript(manuscript(["Chapter One", ...lines], format));
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]?.title).toBe("Chapter One");
    for (const line of lines) expect(parsed.text).toContain(line);
  });

  it.each([
    "Chapitre 2 : Le retour", "Chapitre vingt-deux - Le retour", "Kapitel einundzwanzig — Die Rückkehr",
    "Capitolo ventitré: Il ritorno", "Глава одиннадцать — Возвращение", "Bölüm on bir: Dönüş",
    "فصل دوم — بازگشت", "第二章　帰り道", "제2장 돌아오는 길"
  ])("preserves the next chapter's subtitle: %s", async (title) => {
    const parsed = await parseManuscript(manuscript([
      "Chapter One", "The traveller opened the gate.", "About the Author", "This is still the story.", title, "The traveller returned."
    ], format));
    expect(parsed.sections.at(-1)).toEqual({ title, text: "The traveller returned." });
    expect(parsed.matter?.aboutAuthor).toBeUndefined();
  });

  it.each([
    "Capítulo 2: ¿Quién eres?",
    "Capítulo 2: ¡Corre!",
    "Chapitre 2 : Qui es-tu ?",
    "Kapitel II: Wer bist du?",
    "Глава 2: Кто ты?",
    "فصل دوم: تو کیستی؟",
    "الفصل الثاني: من أنت؟",
    "अध्याय २: तुम कौन हो?",
    "第二章：你是谁？",
    "第二章　走れ！",
    "제2장 누구세요?"
  ])("keeps the punctuated chapter %s out of preceding matter", async (title) => {
    const parsed = await parseManuscript(manuscript([
      "Capítulo 1", "La viajera abrió la puerta.", "Sobre el autor", "Esta escena pertenece a la historia.", title, "La viajera regresó a casa."
    ], format));

    expect(parsed.matter?.aboutAuthor).toBeUndefined();
    expect(parsed.matterRemoved ?? []).not.toContain("about_author");
    expect(parsed.sections).toEqual([
      { title: "Capítulo 1", text: "La viajera abrió la puerta." },
      { title: "Sobre el autor", text: "Esta escena pertenece a la historia." },
      { title, text: "La viajera regresó a casa." }
    ]);
  });

  it("retains a form feed beside a chapter heading as the preceding matter boundary", async () => {
    const lines = ["Chapitre 1", "The traveller opened the gate.", "À propos de l’auteur", "This is still the story.", "Chapitre 2", "The traveller returned."];
    const input = manuscript(lines, format);
    input.data = Buffer.from(input.data.toString().replace("Chapitre 2", format === "text" ? "\fChapitre 2" : "\\page Chapitre 2"));
    const parsed = await parseManuscript(input);
    expect(parsed.sections.map((section) => section.title)).toEqual(["Chapitre 1", "À propos de l’auteur", "Chapitre 2"]);
    expect(parsed.matter?.aboutAuthor).toBeUndefined();
    expect(parsed.text).not.toContain("\uFDD0");
  });
});
