import { arabicScriptFold, normalizeIsbn } from "../authoring/bookMatterWords.js";
import { normalizeNumerals } from "../generation/replanSettings.js";
import { BOOK_MATTER_LIMITS } from "../schemas/bookMatter.js";

/**
 * The words an imported manuscript's own front and back matter is recognised
 * by — headings, bylines, © statements, the legal boilerplate of a copyright
 * page, dedication openings — in the languages the book compiler labels its
 * own matter in (`markdownLabels.ts`). Danish, Dutch, Greek, Norwegian,
 * Polish, Swedish, Thai, Ukrainian and Vietnamese carry only the words that
 * compiler prints (About the Author, the rights line, the byline word), so a
 * book exported in one re-imports; Hebrew has the fuller lists. Pure and
 * model-free; what is done with a recognised section is decided in
 * `manuscriptMatter.ts`.
 *
 * Every heading list is matched against a whole folded line (`^…$`), never
 * searched for inside one: "About the Author" is matter, "About the Author's
 * Mother" is a chapter.
 */

/**
 * A line as the heading lists read it: compatibility-folded, one Arabic-script
 * spelling, Western digits, lower case, Latin accents off, one apostrophe, and
 * the punctuation around it (`## `, `:`, `~ … ~`) dropped.
 */
export function foldMatterText(text: string): string {
  // A trailing run is read from where it starts (`(?<!…)`), never from each of
  // its characters: a run of stops inside a line was read to its end from each.
  return foldInner(text).replace(/^[\p{P}\p{S}\s]+|(?<![\p{P}\p{S}\s])[\p{P}\p{S}\s]+$/gu, "");
}

/** {@link foldMatterText} with the punctuation inside and around the text kept — for sentences. */
export function foldInner(text: string): string {
  return foldMatterCharacters(text).replace(/\s+/g, " ").trim();
}

/**
 * Every step below but the lower-casing and the backtick leaves ASCII as it
 * is. A manuscript's first and last pages are folded a line at a time, and the
 * three normalizations a line costs were most of a long import's parse.
 */
const ASCII = /^[\x00-\x7f]*$/;

function foldMatterCharacters(text: string): string {
  if (ASCII.test(text)) return text.toLowerCase().replaceAll("`", "'");
  return normalizeNumerals(arabicScriptFold(text.normalize("NFKC")))
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/ı/g, "i")
    .replace(/[’‘`´ʼ′]/g, "'")
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "");
}

/** One heading list, folded the way the line is (so "й" and "ü" are written as spelled). */
function headings(latin: readonly string[], other: readonly string[]): RegExp {
  return new RegExp(`^(?:${[...latin, ...other].map((pattern) => foldInner(pattern)).join("|")})$`, "u");
}

export type MatterHeadingKind = "about" | "dedication" | "copyright" | "contents" | "title" | "passover";

/**
 * - `about` — About the Author: lifted into the book's matter, or kept in the
 *   pages and the profile's bio left out.
 * - `dedication` — lifted into the book's matter.
 * - `copyright` — the fields the matter sheet prints are lifted off it.
 * - `contents` — the compiler prints its own.
 * - `title` — a title page, half title or cover page: the compiler prints its own.
 * - `passover` — front or back matter the compiler does not print (acknowledgments,
 *   "Also by", an epigraph): kept as the author's text, and not where the
 *   front or back matter ends.
 */
const HEADINGS: Record<MatterHeadingKind, RegExp> = {
  about: headings(
    [
      "about the authors?",
      "about the writer",
      "meet the authors?",
      "(?:the )?author(?:'s)? bio(?:graphy)?",
      "a propos de l'(?:auteur|auteure|autrice)",
      "a propos des auteurs",
      "biographie de l'(?:auteur|auteure|autrice)",
      "uber (?:den autor|die autorin|die autoren|den verfasser|die verfasserin)",
      "zum autor",
      "zur autorin",
      "(?:sobre|acerca de) (?:el autor|la autora|los autores)",
      "acerca del autor",
      "biografia del autor",
      "sobre (?:o autor|a autora|os autores)",
      "l'autore",
      "l'autrice",
      "sull'(?:autore|autrice)",
      "nota biografica",
      "biografia dell'(?:autore|autrice)",
      "об авторе",
      "об авторах",
      "сведения об авторе",
      "yazar hakkinda",
      "om forfatteren",
      "om forfattaren",
      "over de auteur",
      "o autorze",
      "ve tac gia"
    ],
    [
      "عن (?:المؤلف|المولف|الكاتب|المؤلفة|الكاتبة)",
      "نبذة عن (?:المؤلف|المولف|الكاتب|المؤلفة|الكاتبة)",
      "حول المؤلف",
      "درباره(?: ?ی)? (?:نویسنده|مولف|مؤلف)",
      "معرفی نویسنده",
      "زندگی ?نامه(?: ?ی)? نویسنده",
      "مصنف کے بارے میں",
      "مصنف کا تعارف",
      "تعارف مصنف",
      "लेखक के बारे में",
      "लेखक (?:का )?परिचय",
      "关于作者",
      "關於作者",
      "作者简介",
      "作者簡介",
      "作者介绍",
      "作者介紹",
      "著者について",
      "著者紹介",
      "著者略歴",
      "作者について",
      "作者紹介",
      "저자 소개",
      "작가 소개",
      "지은이 소개",
      "저자에 대하여",
      "저자에 대해",
      "작가에 대하여",
      "על (?:המחבר|המחברת|הסופר|הסופרת)",
      "אודות (?:המחבר|המחברת)",
      "σχετικά με τον συγγραφέα",
      "про автора",
      "เกี่ยวกับผู้เขียน"
    ]
  ),
  dedication: headings(
    ["dedications?", "dedicace", "widmung", "dedicatoria", "dedica", "посвящение", "ithaf"],
    ["(?:ال)?اهداء", "تقدیم(?: ?نامه)?", "انتساب", "समर्पण", "献词", "獻詞", "题献", "題獻", "献辞", "献呈", "헌사", "헌정", "הקדשה"]
  ),
  copyright: headings(
    [
      "copyrights?",
      "copyright (?:page|notice|information|info)",
      "legal notices?",
      "droits d'auteur",
      "mentions legales",
      "impressum",
      "urheberrecht",
      "derechos de autor",
      "aviso legal",
      "direitos autorais",
      "diritti d'autore",
      "авторские права",
      "выходные данные",
      "telif hakki",
      "kunye"
    ],
    [
      "حقوق (?:النشر|الطبع|الطبع والنشر|التأليف)",
      "حق (?:نشر|چاپ)",
      "حقوق نشر",
      "شناسنامه(?: ?ی)?(?: کتاب)?",
      "حقوق اشاعت",
      "कॉपीराइट",
      "सर्वाधिकार",
      "版权(?:页|信息|声明)?",
      "版權(?:頁|資訊|聲明)?",
      "奥付",
      "著作権",
      "版権",
      "판권(?: ?면)?",
      "저작권",
      "זכויות יוצרים"
    ]
  ),
  contents: headings(
    [
      "contents",
      "table of contents",
      "toc",
      "table des matieres",
      "sommaire",
      "inhalt",
      "inhaltsverzeichnis",
      "indice",
      "contenidos?",
      "tabla de contenidos?",
      "sumario",
      "sommario",
      "содержание",
      "оглавление",
      "icindekiler"
    ],
    ["(?:ال)?(?:محتويات|فهرس)", "فهرست(?: ?ی)?(?: مطالب)?", "فہرست(?: مضامین)?", "विषय[ -]?सूची", "अनुक्रमणिका", "目录", "目錄", "目次", "목차", "차례", "תוכן (?:ה)?עניינים"]
  ),
  title: headings(
    [
      "title ?page",
      "title",
      "half[ -]?title(?: page)?",
      "full title(?: page)?",
      "(?:front )?cover",
      "page de titre",
      "couverture",
      "titelseite",
      "titelblatt",
      "umschlag",
      "pagina de titulo",
      "portada",
      "cubierta",
      "folha de rosto",
      "pagina de rosto",
      "capa",
      "frontespizio",
      "copertina",
      "титульный лист",
      "обложка",
      "kapak"
    ],
    ["(?:ال)?غلاف", "صفحه(?: ?ی)? عنوان", "封面", "扉页", "扉頁", "表紙", "표지", "כריכה"]
  ),
  passover: headings(
    [
      "acknowledge?ments?",
      "also by .{2,80}",
      "(?:other |more )?books by .{2,80}",
      "more (?:books )?(?:from|by) .{2,80}",
      "by the same author",
      "praise for .{2,120}",
      "epigraph",
      "author'?s note",
      "a note from the author",
      "notes? (?:to|for) (?:the )?readers?",
      "remerciements",
      "du meme auteur",
      "danksagung",
      "vom selben autor",
      "von derselben autorin",
      "agradecimientos",
      "del mismo autor",
      "agradecimentos",
      "do mesmo autor",
      "ringraziamenti",
      "dello stesso autore",
      "благодарности",
      "tesekkurler?"
    ],
    ["شكر وتقدير", "سپاس ?گزاری", "قدردانی", "致谢", "致謝", "鸣谢", "謝辞", "감사의 글", "תודות"]
  )
};

const HEADING_ORDER: readonly MatterHeadingKind[] = ["about", "dedication", "copyright", "contents", "title", "passover"];

/** The matter a heading names, or `null` for every other heading. */
export function matterHeadingKind(heading: string): MatterHeadingKind | null {
  if (heading.length > 140) return null;
  const folded = foldMatterText(heading);
  if (!folded) return null;
  return HEADING_ORDER.find((kind) => HEADINGS[kind].test(folded)) ?? null;
}

/** A heading that opens the body of a book, never its title page. */
const BODY_HEADING =
  /^(?:(?:chapter|part|book|volume|vol|prologue|epilogue|interlude|act|introduction|foreword|preface|afterword|appendix|chapitre|kapitel|teil|capitulo|capitolo|parte|глава|часть|bolum|فصل|بخش|باب|अध्याय)(?![\p{L}\p{N}])|第|\d{1,3}(?:[.:)]|$)|(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})(?:[.:)]|$))/u;

export function isBodyHeading(heading: string): boolean {
  return BODY_HEADING.test(foldInner(heading));
}

/**
 * A line that could be a book's title on its title page: short, with a
 * letter, not a sentence. A title may end in "?" or "!"; it does not end in a
 * full stop, a comma or a colon.
 */
export function isTitleLike(line: string): boolean {
  const text = line.trim();
  return (
    text.length > 0 &&
    text.length <= 120 &&
    /\p{L}/u.test(text) &&
    !/[.,;:،؛。．，；：۔।॥]$/u.test(text) &&
    text.split(/\s+/).length <= 15 &&
    parseCopyrightStatement(text) === null
  );
}

const GENRE_LEAD = /^(?:(?:an?|the)\s+\p{L}+(?:\s+\p{L}+)?|novel|memoir|poems|stories|essays|tales)$/iu;
const BY = String.raw`(?:by|par|von|por|di|door|av|af)`;
const PLAIN_BYLINE = new RegExp(String.raw`^(?:(?:written|text|story|words)\s+)?${BY}\s+(?<name>\S.*)$`, "iu");
const ILLUSTRATION_CREDIT = new RegExp(String.raw`^(?:illustrated|illustrations|pictures)\s+${BY}\s+\S`, "iu");
const LED_BYLINE = new RegExp(String.raw`^(?<lead>.{1,40}?)\s+${BY}\s+(?<name>\S.*)$`, "iu");
const LABELLED_BYLINE =
  /^(?:author|autor|auteur|autore|autora|autorin|автор|yazar|yazan|نویسنده|المؤلف|مصنف|लेखक|作者|著者|저자|지은이)\s*[:：]\s*(?<name>\S.*)$/iu;
// These noun labels print without a colon in our exports (`markdownLabels`).
// Their remainder needs creator metadata: uncased scripts cannot distinguish
// a person's name from a sentence merely through capital letters.
const PUBLISHED_BYLINE = /^(?:автор|autor|συγγραφέας|tác giả|โดย|yazan|लेखक|作者|著者|저자)\s+(?<name>\S.*)$/iu;
const RTL_BYLINE = /^(?:نوشته(?:[\u200C ]?ی|ٔ)?|به قلم|بقلم|تأليف|تاليف|تحریر|מאת)\s+(?<name>\S.*)$/u;
const SUFFIX_BYLINE = /^(?<name>\S.*?)\s*(?:著|지음|द्वारा)$/u;

/** A credit that stays in the manuscript because book matter has no illustrator field. */
export function isIllustrationCredit(line: string): boolean {
  return ILLUSTRATION_CREDIT.test(line.trim());
}

/** "by Jane Doe", "A Novel by Jane Doe", "Author: Jane Doe", "نوشتهٔ …", "山田太郎 著" — the name, and a genre lead. */
export function parseByline(line: string, knownAuthors: readonly string[] = []): { name: string; lead?: string } | null {
  const text = line.trim().replace(/\s+/g, " ");
  if (!text || text.length > 140) return null;
  const plain = text.match(PLAIN_BYLINE);
  const led = plain ? null : text.match(LED_BYLINE);
  const latin = plain ?? led;
  if (latin?.groups) {
    const lead = latin.groups.lead?.trim();
    if (lead !== undefined && !GENRE_LEAD.test(lead)) return null;
    const name = cleanName(latin.groups.name!);
    // Creator metadata corroborates names whose chosen spelling is lowercase.
    return name && (matchesKnownAuthor(name, knownAuthors) || hasBylineNameEvidence(name))
      ? { name, ...(lead ? { lead } : {}) } : null;
  }
  for (const pattern of [LABELLED_BYLINE, RTL_BYLINE, SUFFIX_BYLINE]) {
    const match = text.match(pattern);
    const name = match?.groups ? cleanName(match.groups.name!) : null;
    if (name) return { name };
  }
  const published = text.match(PUBLISHED_BYLINE);
  const name = published?.groups ? cleanName(published.groups.name!) : null;
  if (name && matchesKnownAuthor(name, knownAuthors)) {
    return { name };
  }
  return null;
}

function matchesKnownAuthor(name: string, knownAuthors: readonly string[]): boolean {
  return knownAuthors.some((author) => foldMatterText(author) === foldMatterText(name));
}

function cleanName(raw: string): string | null {
  const name = raw.trim().replace(/[.,;:]+$/u, "").trim();
  return name.length >= 2 && name.length <= BOOK_MATTER_LIMITS.authorName && /\p{L}/u.test(name) && !/\d|https?:|www\.|@|©/iu.test(name) ? name : null;
}

const BYLINE_NAME_PARTICLES = new Set(
  "al el bin bint ibn da das de del della delle dello den der des di do dos du la las le les los ten ter van von zu zur af av y e et en and fils 't ’t".split(" ")
);

/** Bare "by" is also a preposition: one named character cannot make its whole sentence an author. */
function hasBylineNameEvidence(name: string): boolean {
  if (!/[\p{Lu}\p{Lt}]/u.test(name) && /\p{Ll}/u.test(name)) return false;
  return name.split(/\s+/).every((word) => {
    const bare = word.replace(/[,;:]$/u, "");
    if (BYLINE_NAME_PARTICLES.has(bare)) return true;
    if (/^(?:\p{L}\p{M}*\.)+$/u.test(bare)) return true;
    // Capitals are evidence per word, not just per line. Uncased scripts,
    // combining marks and mixed-case names (d’Alembert, e. e. Cummings) survive.
    return /[\p{Lu}\p{Lt}]/u.test(bare) || !/\p{Ll}/u.test(bare);
  });
}

const NOT_NAME_WORDS = new Set(
  "a an the of and novel novella memoir story stories book books guide poems poetry tale tales volume edition collection series trilogy saga chronicles press publishing publishers edition part chapter".split(" ")
);

/** "Jane Doe", "J. R. R. Tolkien", "JANE DOE": two to five capitalised words, none of them a common one. */
export function isNameLike(line: string): boolean {
  const words = line.trim().split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((word, index) => {
    const bare = word.replace(/[.,]$/, "");
    if (NOT_NAME_WORDS.has(bare.toLowerCase())) return false;
    if (index > 0 && /^(?:de|da|van|von|der|del|la|le|di|du|bin|al|el|y)$/.test(bare)) return true;
    return /^\p{Lu}[\p{L}'’.-]*$/u.test(bare);
  });
}

const PUBLISHER_WORD =
  /(?<![\p{L}\p{N}])(?:press|books|publishing|publishers?|publications|verlag|editorial|editora|edizioni|издательство|yayinlari|yayinevi|انتشارات|نشر|دار)(?![\p{L}\p{N}])/u;

/** "Lantern Press" at the foot of a title page. */
export function isImprintLike(line: string): boolean {
  return line.length <= 120 && PUBLISHER_WORD.test(foldInner(line));
}

/** A © statement: its holder and its year(s), as written, and whether it also reserved all rights. */
export type CopyrightStatement = { holder?: string; year?: string; scoped: boolean; rights: boolean };

const RIGHTS_PHRASE = new RegExp(
  [
    "all rights reserved",
    "tous droits reserves",
    "alle rechte vorbehalten",
    "todos los derechos reservados",
    "todos os direitos reservados",
    "tutti i diritti (?:sono )?riservati",
    "все права защищены",
    "tum haklari saklidir",
    "alle rettigheder forbeholdes",
    "alle rettigheter forbeholdt",
    "alla rattigheter forbehallna",
    "alle rechten voorbehouden",
    "wszelkie prawa zastrzezone",
    foldInner("усі права захищено"),
    foldInner("με επιφύλαξη παντός δικαιώματος"),
    foldInner("bảo lưu mọi quyền"),
    "สงวนลิขสิทธิ์",
    foldInner("جميع الحقوق محفوظة"),
    foldInner("(?:همه|کلیه|تمامی)(?: ?ی)? حقوق محفوظ(?: است)?"),
    foldInner("جملہ حقوق محفوظ(?: ہیں)?"),
    "सर्वाधिकार सुरक्षित",
    "版权所有",
    "版權所有",
    "無断転載を禁(?:じます|ず)",
    "無断転載禁止",
    "모든 권리 보유",
    "판권 소유",
    "כל הזכויות שמורות"
  ].join("|"),
  "u"
);

// Recognize Persian scopes and exceptions as notices to keep, never as the
// plain formula the matter sheet can reproduce.
const RIGHTS_NOTICE = new RegExp(
  `${RIGHTS_PHRASE.source}|${foldInner("(?:همه|کلیه|تمامی)(?: ?ی)? حقوق.{0,60}?محفوظ(?: است)?")}`,
  "u"
);

/** A whole rights reservation the matter sheet can reprint, without an attached clause. */
export function isRightsSentence(sentence: string): boolean {
  const folded = foldInner(sentence).replace(/^[\p{P}\s]+/u, "");
  const match = folded.match(RIGHTS_PHRASE);
  return match !== null && match.index === 0 && /^[\p{P}\s]*$/u.test(folded.slice(match[0].length));
}

/** Strip only a complete reservation; an attached clause keeps the notice in the manuscript. */
function withoutRightsPhrase(sentence: string): { text: string; rights: boolean } | null {
  const folded = foldInner(sentence);
  const match = folded.match(RIGHTS_NOTICE);
  if (!match) return { text: sentence, rights: false };
  if (!isRightsSentence(match[0])) return null;
  const start = originalMatterPrefixEnd(sentence, folded.slice(0, match.index!).trimEnd());
  const end = originalMatterPrefixEnd(sentence, folded.slice(0, match.index! + match[0].length));
  if (start === null || end === null) return { text: sentence, rights: false };
  const before = sentence.slice(0, start).replace(/(?<![,.;:،؛、。\s])[,.;:،؛、。\s]+$/u, "");
  const after = sentence.slice(end).replace(/^[.。]\s*/u, "").trim();
  if (!/^[\p{P}\s]*$/u.test(after)) {
    // Some notices put the rights phrase between the year and a named holder.
    // Accept that shape only with name evidence, never append a qualification
    // to a holder already printed before the phrase.
    const prefix = before.match(COPYRIGHT_LEAD)?.groups?.rest?.match(YEAR_FIRST);
    if (
      prefix?.groups?.holder?.trim() !== "" ||
      !/^[\p{Lu}\p{Lt}]/u.test(after) ||
      !hasBylineNameEvidence(after)
    ) return null;
  }
  return { text: [before, after].filter(Boolean).join(" ").trim(), rights: true };
}

const COPYRIGHT_SCOPE =
  String.raw`text|story|words|illustrations?|artwork|art|cover(?: art| design| illustration| image)?|photos?|photographs?|photography|translation|design|maps?|foreword|introduction|interior design|images?`;
const COPYRIGHT_LEAD = new RegExp(
  String.raw`^(?:(?<scope>${COPYRIGHT_SCOPE})\s+)?(?<sign>(?:copyright|copr\.)(?:\s*(?:©|ⓒ|\(c\)))?|©|ⓒ|\(c\))\s*(?<rest>.*)$`,
  "iu"
);
const YEARS = String.raw`\d{4}(?:\s*(?:[-–—,]|and|&)\s*\d{4}){0,3}`;
const YEAR_FIRST = new RegExp(String.raw`^(?<years>${YEARS})\s*,?\s*(?:by\s+)?(?<holder>.*?)$`, "iu");
// The holder ends where a run of commas and spaces begins, or after its first
// character. A holder ending inside a run reaches the years the run's start
// already tried, so the lazy holder never stopped there first — and each such
// stop read the rest of the run again, quadratic in a run of ", , , ,".
const HOLDER_FIRST = new RegExp(String.raw`^(?:by\s+)?(?<holder>.+?)(?:(?<![,\s])|(?<=^(?:by\s+)?.))[,\s]+(?<years>${YEARS})$`, "iu");

/**
 * "Copyright © 2023 Jane Doe", "© Jane Doe, 2023", "Text © 2019–2023 by Jane
 * Doe": the holder and the year(s) as written. `scoped` when it is the
 * illustrator's or the photographer's ©, not the book's. `null` for anything
 * else — "Copyright law protects…" has no © and no year.
 */
export function parseCopyrightStatement(sentence: string): CopyrightStatement | null {
  const notice = withoutRightsPhrase(normalizeNumerals(sentence.trim().replace(/\s+/g, " ")));
  if (!notice) return null;
  const { text, rights } = notice;
  const lead = text.match(COPYRIGHT_LEAD);
  if (!lead?.groups) return null;
  const scope = lead.groups.scope?.trim();
  const symbol = /©|ⓒ|\(c\)/i.test(lead.groups.sign!);
  const rest = lead.groups.rest!.replace(/(?<![.\s])[.\s]+$/u, "").trim();
  const yearFirst = rest.match(YEAR_FIRST);
  const holderFirst = yearFirst ? null : rest.match(HOLDER_FIRST);
  const years = (yearFirst ?? holderFirst)?.groups?.years?.replace(/\s+/g, " ").trim();
  // "Copyright law protects…": neither a © nor a year.
  if (!years && !symbol) return null;
  const rawHolder = (yearFirst ?? holderFirst)?.groups?.holder ?? rest.replace(/^by\s+/i, "");
  const holder = rawHolder.replace(/^by\s+/i, "").replace(/(?<![,.;:\s])[,.;:\s]+$/u, "").trim();
  if (holder && (holder.length > 160 || !/\p{L}/u.test(holder) || /©|ⓒ|https?:|www\./iu.test(holder) || holder.split(/\s+/).length > 12)) {
    return null;
  }
  if (!holder && !years) return null;
  return {
    ...(holder ? { holder } : {}),
    ...(years && years.length <= 24 ? { year: years } : {}),
    scoped: scope !== undefined && !/^(?:text|story|words)$/i.test(scope),
    rights
  };
}

/** An ISBN line with a valid check digit, as the page prints it (the label off). */
export function parseIsbnLine(sentence: string): string | null {
  const printed = sentence.trim();
  // `\s*(?:[:#：]\s*)?` is `\s*[:#：]?\s*` without the second way to split a
  // run of spaces that has no colon in it.
  const match = normalizeNumerals(printed).match(
    /^(?:e-?)?(?:isbn|شابک)(?:[-\s]?1[03])?\s*(?:[:#：]\s*)?(?<number>[0-9Xx][0-9Xx\s‐-―-]{8,20}[0-9Xx])\s*(?:\([^)]{0,40}\))?\.?$/diu
  );
  // Numeral folding preserves offsets; take the number's spelling from the
  // page so validation does not replace the digits the author printed.
  const range = match?.indices?.groups?.number;
  const number = range ? printed.slice(range[0], range[1]) : null;
  const isbn = number ? normalizeIsbn(number) : null;
  return isbn && isbn.printed.length <= 24 ? isbn.printed : null;
}

const IMPRINT_LINE =
  /^(?:published by|publisher\s*[:：]|publie par|editeur\s*[:：]|verlag\s*[:：]|erschienen (?:im|bei)|publicado por|editorial\s*[:：]|editora\s*[:：]|pubblicato da|editore\s*[:：]|издательство\s*[:：]?|yayinevi\s*[:：]|yayinci\s*[:：]|ناشر\s*[:：]|الناشر\s*[:：]|出版社\s*[:：]|出版\s*[:：]|発行所\s*[:：]|펴낸곳\s*[:：]|출판사\s*[:：]|הוצאה לאור\s*[:：]?)\s*/u;

const MATTER_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** {@link foldMatterCharacters} of one grapheme, remembered: a page repeats few of them. */
const FOLDED_GRAPHEMES = new Map<string, string>();

function foldedGrapheme(segment: string): string {
  let folded = FOLDED_GRAPHEMES.get(segment);
  if (folded === undefined) {
    if (FOLDED_GRAPHEMES.size >= 4096) FOLDED_GRAPHEMES.clear();
    folded = foldMatterCharacters(segment);
    FOLDED_GRAPHEMES.set(segment, folded);
  }
  return folded;
}

/**
 * Map a folded, trimmed prefix back to the original text, including trailing
 * whitespace or marks the fold removes. A folded length is not a source offset:
 * compatibility forms and decomposed accents can change the number of characters.
 */
function originalMatterPrefixEnd(text: string, prefix: string): number | null {
  let length = 0;
  let space = false;
  let end: number | null = prefix ? null : 0;
  const read = (segment: string, index: number): boolean => {
    for (const character of foldedGrapheme(segment)) {
      if (/\s/u.test(character)) space = true;
      else {
        length += character.length + (space && length > 0 ? 1 : 0);
        space = false;
      }
    }
    if (length > prefix.length) return false;
    if (length === prefix.length) end = index + segment.length;
    return true;
  };
  // ASCII's one cluster of two characters is CR LF, two spaces either way, so
  // reading it a character at a time lands on the same end without a segmenter.
  if (ASCII.test(text)) {
    for (let index = 0; index < text.length && read(text[index]!, index); index += 1);
  } else {
    for (const { segment, index } of MATTER_GRAPHEMES.segment(text)) if (!read(segment, index)) break;
  }
  // The scan only counts lengths; verify the actual fold once at the boundary.
  return end !== null && foldInner(text.slice(0, end)) === prefix ? end : null;
}

/** "Published by Lantern Press", "Publisher: Lantern Press" — the imprint as written. */
export function parseImprintLine(sentence: string): string | null {
  const folded = foldInner(sentence);
  const match = folded.match(IMPRINT_LINE);
  if (!match) return null;
  const labelEnd = originalMatterPrefixEnd(sentence, match[0].trim());
  if (labelEnd === null) return null;
  const rest = sentence.slice(labelEnd);
  const name = rest.replace(/^[:：]\s*/u, "").replace(/(?<![.\s])[.\s]+$/u, "").trim();
  return name && name.length <= 120 && /\p{L}/u.test(name) ? name : null;
}

/**
 * The legal boilerplate of a copyright page — the reproduction clause, the
 * fiction and advice disclaimers, cataloguing data, printing and edition
 * lines, moral rights, trademarks, permission-request lines. Dropped only with
 * the whole page it sits on; one sentence of anything else keeps the page.
 */
const BOILERPLATE = [
  // Reproduction and permissions.
  /no part of this (?:book|publication|work|ebook)|may not be (?:reproduced|copied|used)|(?:be )?reproduced,? (?:or )?(?:stored|transmitted|distributed)|stored in a retrieval system|transmitted in any form|without (?:the )?(?:prior |express )?(?:written )?(?:permission|consent)|brief quotations|fair use|photocopying|scanning,? uploading|unauthori[sz]ed (?:reproduction|distribution|copying|use)|piracy/,
  /^(?:for (?:permission|permissions|information|inquiries|bulk|special sales)|to request permission|permission requests?)/,
  // Fiction and advice disclaimers.
  /works? of fiction|products? of the author'?s imagination|used fictitiously|resemblance to (?:actual|real)|(?:purely|entirely) coincidental|any similarity to/,
  /disclaim|no (?:representations|warranties)|not (?:intended|meant) (?:as|to)|for (?:informational|educational) purposes|not (?:responsible|liable)|consult (?:a|your) (?:physician|doctor|professional|attorney)/,
  // Cataloguing, printing, editions.
  /^(?:library of congress|cataloging|cataloguing|british library|a cip|cip data|lccn|control number|national library|(?:die )?deutsche nationalbibliothek|bibliografische information|depot legal|deposito legal)/,
  /^(?:printed (?:in|by|and bound)|manufactured in|first (?:edition|published|printing|paperback|ebook|e-book|hardcover)|(?:second|third|fourth|fifth|\d+(?:st|nd|rd|th)) (?:edition|printing)|this (?:edition|ebook)|edition \d|(?:ebook|e-book|paperback|hardcover|kindle) edition|version \d|printing \d|\d{4} (?:edition|printing))/,
  /^(?:\d{1,2}\s+){4,}\d{1,2}$/,
  /moral rights?|has been asserted|have been asserted|right .{0,40} to be identified as the author/,
  /trademarks?(?![\p{L}])/u,
  // French, German, Spanish, Portuguese, Italian, Russian, Turkish.
  /reproduction (?:meme partielle|interdite)|toute (?:reproduction|representation)|propriete intellectuelle|loi du 11 mars 1957|oeuvre de fiction|pure coincidence|^imprime (?:en|au|par)|^premiere edition|achevé d'imprimer|acheve d'imprimer/,
  /nachdruck|vervielfaltigung|ohne (?:schriftliche )?(?:genehmigung|zustimmung)|frei erfunden|rein zufallig|^gedruckt in|^(?:erste|\d+\.) auflage/,
  /reproduccion (?:total o parcial|prohibida)|queda (?:rigurosamente )?prohibida|sin (?:el )?(?:permiso|autorizacion)|obra de ficcion|pura coincidencia|^impreso en|^primera edicion/,
  /reproducao|sem (?:a )?(?:previa )?autorizacao|obra de ficcao|mera coincidencia|^impresso (?:no|em)|^primeira edicao/,
  /riproduzione|senza (?:il )?(?:permesso|autorizzazione)|opera di fantasia|puramente casuale|^stampato in|^prima edizione/,
  /воспроизвед|без (?:письменного )?разрешения|^отпечатано|^первое издание/,
  /cogaltil|izin alinmadan|^(?:\d+\. )?(?:basim|baski)/,
  // Persian, Arabic, Urdu, Hindi, Chinese, Japanese, Korean, Hebrew.
  new RegExp(foldInner("تکثیر|بدون اجازه|نوبت چاپ|چاپ (?:اول|نخست)|تیراژ|لا يجوز|اعادة (?:انتاج|نشر)|الطبعة الاولى|پہلا ایڈیشن"), "u"),
  /पुनरुत्पादन|अनुमति के बिना|प्रथम संस्करण|मुद्रित/,
  /未经.{0,12}(?:许可|許可|同意)|不得.{0,8}(?:复制|複製|转载|轉載)|翻印必究|^(?:第.版|初版)|^印刷/,
  /無断|複製|転載|^(?:初版|第.刷)|^印刷/,
  /무단|복제|전재|^(?:초판|인쇄)/,
  /אין לשכפל|להעתיק|לצלם|^הדפסה/
];

export function isBoilerplateSentence(sentence: string): boolean {
  const folded = foldInner(sentence);
  // A rights formula with more words may hold a credit, scope or exception.
  // Broad reproduction patterns must not discard that unmatched text.
  if (RIGHTS_NOTICE.test(folded) && !isRightsSentence(sentence)) return false;
  return BOILERPLATE.some((pattern) => pattern.test(folded));
}

/**
 * "First published in 2023 by Lantern Press" names a publisher, which is not boilerplate to lose.
 *
 * This reads what `^first published\b.*?\bby\s+(?<name>\S.*?)(?:\s+in\s+(?:\d{4}|[\p{Lu}][\p{L} ]+))?\.?$`
 * (`iu`) matched. As a regex, every " in X" after a name read the rest of its
 * run of letters again, quadratic in a line of " in Bcd in Bcd …".
 */
export function firstPublishedImprint(sentence: string): string | null {
  const text = sentence.trim();
  if (!FIRST_PUBLISHED.test(text)) return null;
  const ending = publishedEnding(text);
  LINE_BREAK.lastIndex = FIRST_PUBLISHED_LENGTH;
  // What precedes `by` is `.*?`, which stops at a line break.
  const reach = LINE_BREAK.exec(text)?.index ?? text.length;
  // A name that failed reads every end up to the next line break, so a later
  // `by` whose name starts before that break has no end left to find.
  let failed = -1;
  PUBLISHED_BY.lastIndex = FIRST_PUBLISHED_LENGTH;
  for (let by = PUBLISHED_BY.exec(text); by && by.index < reach; by = PUBLISHED_BY.exec(text)) {
    const start = PUBLISHED_BY.lastIndex;
    if (start < failed) continue;
    LINE_BREAK.lastIndex = start;
    const limit = LINE_BREAK.exec(text)?.index ?? text.length;
    const end = publishedNameEnd(text, start, limit, ending);
    if (end === undefined) {
      failed = limit;
      continue;
    }
    const name = text.slice(start, end).trim();
    return name && name.length <= 120 && /\p{L}/u.test(name) ? name : null;
  }
  return null;
}

const FIRST_PUBLISHED = /^first published\b/iu;
const FIRST_PUBLISHED_LENGTH = "first published".length;
const PUBLISHED_BY = /\bby\s+(?=\S)/giu;
const LINE_BREAK = /[\n\r\u2028\u2029]/g;
const SPACES = /\s+/uy;
const IN_WORD = /in/iuy;
const YEAR = /\d{4}/y;
// Under `iu`, as in the pattern, `\p{Lu}` folds case: "in london" ends a name too.
const CAPITAL = /\p{Lu}/iuy;

/** Where a © line's own ending starts: a final stop, and the run of letters and spaces before it. */
function publishedEnding(text: string): { close: number; lastRun: number } {
  const close = text.endsWith(".") ? text.length - 1 : text.length;
  return { close, lastRun: /(?<![\p{L} ])[\p{L} ]+$/iu.exec(text.slice(0, close))?.index ?? close };
}

/**
 * Where the lazy name from `start` stops: the first end, before the next line
 * break, after which the rest is `\.?$`, or ` in ` and a year or a capitalised
 * run of letters and spaces to the end — that run being the text's own last
 * one, found once.
 */
function publishedNameEnd(text: string, start: number, limit: number, ending: { close: number; lastRun: number }): number | undefined {
  const plain = (end: number) => end === text.length || (end === text.length - 1 && text[end] === ".");
  for (let end = start + 1; end <= limit; end += 1) {
    if (plain(end)) return end;
    SPACES.lastIndex = end;
    if (!SPACES.test(text)) continue;
    // A name ending inside this run of spaces reads the same ` in …` as one
    // ending where it starts, so only the start is tried.
    const run = SPACES.lastIndex;
    IN_WORD.lastIndex = run;
    if (IN_WORD.test(text)) {
      SPACES.lastIndex = IN_WORD.lastIndex;
      if (SPACES.test(text)) {
        const word = SPACES.lastIndex;
        YEAR.lastIndex = word;
        if (YEAR.test(text) && plain(YEAR.lastIndex)) return end;
        CAPITAL.lastIndex = word;
        if (CAPITAL.test(text) && word >= ending.lastRun && CAPITAL.lastIndex < ending.close) return end;
      }
    }
    end = Math.min(run, limit + 1) - 1;
  }
  return undefined;
}

/**
 * Explicit dedication or memorial wording can identify a short leading block
 * without a heading. An inferred recipient needs both a separate page and
 * recipient evidence: every EPUB chapter is a separate page, including one
 * beginning "For three days it rained".
 */
const DEDICATION_OPENING = new RegExp(
  [
    "^(?:this book is |it is )?dedicated to",
    "^in (?:loving )?memory of",
    "^in memoriam",
    "^(?:a|en) (?:la )?memoire de",
    "^in (?:liebevoller )?erinnerung an",
    "^gewidmet",
    "^(?:a|em|en) (?:la )?memoria de",
    "^dedicad[oa] a",
    "^(?:alla|in) memoria di",
    "^dedicat[oa] a",
    "^посвящается",
    "^памяти ",
    foldInner("^تقدیم به"),
    foldInner("^تقدیم "),
    foldInner("^اهدي"),
    foldInner("کے نام$"),
    "को समर्पित",
    "^(?:献给|獻給)",
    "(?:に捧ぐ|に捧げる)",
    "에게 바(?:칩니다|친다)",
    "^(?:לזכר|מוקדש ל)"
  ].join("|"),
  "u"
);

const DEDICATION_RECIPIENT = new RegExp(
  `^(?:${[
    "(?:for|to) (?:my|our) (?:(?:beloved|dear|late) )?(?:mother|father|mom|mum|dad|parents|family|wife|husband|partner|children|son|daughter|sister|brother|grandmother|grandfather|friends|readers|teachers)",
    "(?:for|to) the (?:readers|teachers|archivists)",
    "(?:pour|a) (?:ma mere|mon pere|mes parents|ma famille|mes enfants|mes amis|notre famille)",
    "fur (?:meine mutter|meinen vater|meine eltern|meine familie|meine kinder|meine freunde)",
    "(?:para|a) (?:mi madre|mi padre|mis padres|mi familia|mis hijos|mis amigos)",
    "(?:para|a|ao|aos|as) (?:minha mae|meu pai|meus pais|minha familia|meus filhos|meus amigos)",
    "(?:per|a|ai|alle|al) (?:mia madre|mio padre|miei genitori|mia famiglia|miei figli|miei amici)",
    "(?:моей матери|моему отцу|моим родителям|моей семье|моим детям|моим друзьям)",
    "(?:الى|إلى) (?:أمي|أبي|والدتي|والدي|عائلتي|أطفالي|أصدقائي)"
  ].map(foldInner).join("|")})$`,
  "u"
);

const DEDICATION_MESSAGE = new RegExp(
  `^(?:${[
    "who|whose|with (?:love|gratitude|thanks)",
    "qui|avec (?:amour|gratitude)",
    "der|die|das|mit (?:liebe|dank)",
    "que|quien|quienes|con (?:amor|gratitud)|com (?:amor|gratidao)",
    "che|con (?:amore|gratitudine)",
    "который|которая|которые|с (?:любовью|благодарностью)",
    "الذي|التي|الذين|بكل (?:حب|امتنان)"
  ].map(foldInner).join("|")})(?![\\p{L}\\p{N}])`,
  "u"
);

function hasDedicationRecipient(line: string): boolean {
  // Require a complete recipient phrase before any dedication message. A
  // possessive alone would still swallow "For my mother it was too late".
  const separator = line.search(/[,،:：]/u);
  const recipient = separator < 0 ? line : line.slice(0, separator);
  // A comma can begin an independent narrative clause; require a relative
  // dedication message or thanks. A colon explicitly introduces the message.
  if (separator >= 0 && /[,،]/u.test(line[separator]!)) {
    const message = foldInner(line.slice(separator + 1));
    if (!DEDICATION_MESSAGE.test(message) || /[.!?。！？۔]\s*\S/u.test(message)) return false;
  }
  const phrase = recipient.trim().replace(/(?<![.!?。！？۔])[.!?。！？۔]+$/u, "").trim();
  if (DEDICATION_RECIPIENT.test(foldInner(phrase))) return true;
  const name = phrase.match(/^(?:for|to|pour|à|für|para|a|ao|per)\s+(.+)$/iu)?.[1];
  return !!name && (isNameLike(name) || /^\p{Lu}[\p{L}\p{M}'’-]+$/u.test(name));
}

export function opensLikeDedication(line: string, standalone: boolean): boolean {
  const folded = foldInner(line);
  return (DEDICATION_OPENING.test(folded) || (standalone && hasDedicationRecipient(line))) && !/^["“”«„'‘]/u.test(line.trim());
}

/** A quotation and its attribution: an epigraph, which is the author's and stays. */
export function looksLikeEpigraph(lines: readonly string[]): boolean {
  const total = lines.reduce((sum, line) => sum + line.length, 0);
  if (lines.length === 0 || lines.length > 8 || total > 900) return false;
  return /^["“”«„'‘]/u.test(lines[0]!.trim()) || lines.some((line) => /^[—–―-]{1,2}\s*\p{L}/u.test(line.trim()));
}
