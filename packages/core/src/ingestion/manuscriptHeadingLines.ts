import { foldInner } from "./manuscriptMatterWords.js";

const ENGLISH_HEADING =
  /^(?:(?:chapter|part|book|prologue|epilogue|interlude|act)\b[^\n]{0,80}|[IVXLC]+\.\s[^\n]{0,80}|\d{1,3}\.\s[^\n]{0,80})$/i;

const NUMBER = String.raw`(?:\d{1,3}|[ivxlcdm]+)`;
// A numbered chapter may have a subtitle. Require punctuation before a
// subtitle in spaced scripts, so "Chapitre 2 raconte…" stays prose.
const SUBTITLE = String.raw`(?:\s*[:.：、–—-]\s*\S.*)?`;
// An unspaced hyphen inside vingt-deux belongs to the number. Treating it as
// a subtitle separator would split "Chapitre vingt-deux raconte… !" as a title.
const WRITTEN_SUBTITLE = String.raw`(?:\s*[:.：、–—]\s*\S.*|\s+-\s*\S.*|\s*-\s+\S.*)?`;
const NUMBERED_LABELS = [
  "chapitre|partie|livre", "kapitel|teil|buch", "capitulo|parte|libro|livro", "capitolo",
  "глава|часть|книга", "bolum|kisim|kitap", "(?:ال)?فصل|(?:ال)?باب|بخش", "अध्याय|भाग", "פרק|חלק", "장"
];

// Chapter numbers may be cardinal, ordinal or compound (vingt et un, بیست و
// یکم). Accept only a bounded sequence of number words, never arbitrary words
// after a chapter label: فصل الشتاء (winter) and numbered prose stay content.
// This is a lexical heading grammar, not an arithmetic number validator.
function numberWords(words: string, separator = String.raw`[\s-]+`): string {
  return `(?:${words})(?:${separator}(?:${words})){0,5}`;
}

const FRENCH_NUMBERS = numberWords([
  "un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize",
  "vingts?|trente|quarante|cinquante|soixante|septante|huitante|nonante|cents?|mille",
  "premier|deuxieme|second|troisieme|quatrieme|cinquieme|sixieme|septieme|huitieme|neuvieme|dixieme|unieme",
  "(?:onz|douz|treiz|quatorz|quinz|seiz|vingt|trent|quarant|cinquant|soixant|septant|huitant|nonant|cent|mill)ieme"
].join("|"), String.raw`[\s-]+(?:et[\s-]+)?`);

const IBERIAN_UNITS = "primero|primeiro|segundo|tercero|terceiro|cuarto|quarto|quinto|sexto|septimo|setimo|octavo|oitavo|noveno|nono";
const IBERIAN_ORDINALS = `(?:decimo|vigesimo|trigesimo|cuadragesimo|quadragesimo|quincuagesimo|quinquagesimo|sexagesimo|septuagesimo|setuagesimo|octogesimo|nonagesimo|centesimo)(?:${IBERIAN_UNITS})?`;
const IBERIAN_NUMBERS = numberWords([
  IBERIAN_UNITS, IBERIAN_ORDINALS, "undecimo|duodecimo",
  "uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince",
  "dieci(?:seis|siete|ocho|nueve)|veinti(?:uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)",
  "veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|mil",
  "um|dois|quatro|sete|oito|nove|dez|onze|treze|catorze|quatorze|quinze|dezasseis|dezesseis|dezassete|dezessete|dezoito|dezanove|dezenove",
  "vinte|trinta|quarenta|cinquenta|sessenta|oitenta|cem|cento|duzentos|trezentos|quatrocentos|quinhentos|seiscentos|setecentos|oitocentos|novecentos"
].join("|"), String.raw`[\s-]+(?:(?:y|e)[\s-]+)?`);

const PERSIAN_UNITS = "یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه";
const PERSIAN_TEENS = "ده|یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده";
const PERSIAN_TENS = "بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود";
const PERSIAN_HUNDREDS = "صد|یکصد|دویست|سیصد|چهارصد|پانصد|ششصد|هفتصد|هشتصد|نهصد";
const PERSIAN_NUMBERS = numberWords([
  "اول|نخست|یکم|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|صدم|سی ?ام",
  PERSIAN_UNITS, `(?:${PERSIAN_TEENS}|${PERSIAN_TENS}|${PERSIAN_HUNDREDS})(?:م)?`
].join("|"), String.raw`\s+و\s+`);

const GERMAN_TENS = "zwanzig|drei(?:ss|ß)ig|vierzig|funfzig|sechzig|siebzig|achtzig|neunzig";
const GERMAN_UNITS = "zwei|drei|vier|funf|sechs|sieben|acht|neun";
const GERMAN_CARDINALS_UNDER_HUNDRED = [
  `eins|${GERMAN_UNITS}|zehn|elf|zwolf|(?:drei|vier|funf|sech|sieb|acht|neun)zehn`,
  `(?:(?:ein|${GERMAN_UNITS})und)?(?:${GERMAN_TENS})`
].join("|");
const GERMAN_NUMBERS = [
  `(?:${GERMAN_CARDINALS_UNDER_HUNDRED})|(?:(?:ein|${GERMAN_UNITS})?hundert)(?:${GERMAN_CARDINALS_UNDER_HUNDRED})?`,
  "(?:erste|zweite|dritte|vierte|funfte|sechste|siebte|achte|neunte|zehnte|elfte|zwolfte)[rs]?",
  "(?:drei|vier|funf|sech|sieb|acht|neun)zehnte[rs]?",
  `(?:(?:ein|zwei|drei|vier|funf|sechs|sieben|acht|neun)und)?(?:${GERMAN_TENS})ste[rs]?`,
  "(?:ein)?hundertste[rs]?"
].join("|");

const ITALIAN_UNITS = "due|tre|quattro|cinque|sei|sette|nove";
const ITALIAN_CARDINALS_UNDER_HUNDRED = [
  `uno|otto|${ITALIAN_UNITS}|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove`,
  `(?:venti|(?:trent|quarant|cinquant|sessant|settant|ottant|novant)a)(?:${ITALIAN_UNITS})?`,
  "(?:vent|trent|quarant|cinquant|sessant|settant|ottant|novant)(?:uno|otto)"
].join("|");
// Hundred compounds may elide the final o before uno / otto / ottanta.
const ITALIAN_HUNDREDS = `(?:${ITALIAN_UNITS}|otto)?cent(?:o|(?=un|ott))`;
const ITALIAN_NUMBERS = [
  `(?:${ITALIAN_CARDINALS_UNDER_HUNDRED})|(?:${ITALIAN_HUNDREDS})(?:${ITALIAN_CARDINALS_UNDER_HUNDRED})?`,
  "primo|secondo|terzo|quarto|quinto|sesto|settimo|ottavo|nono|decimo",
  "undicesimo|dodicesimo|tredicesimo|quattordicesimo|quindicesimo|sedicesimo|diciassettesimo|diciottesimo|diciannovesimo",
  "(?:vent|trent|quarant|cinquant|sessant|settant|ottant|novant)(?:esimo|unesimo|ottesimo|(?:i|a)(?:duesimo|treesimo|quattresimo|cinquesimo|seiesimo|settesimo|novesimo))",
  "centesimo"
].join("|");

const RUSSIAN_NUMBERS = numberWords([
  "один|два|три|четыре|пять|шесть|семь|восемь|девять|десять",
  "(?:один|две|три|четыр|пят|шест|сем|восем|девят)надцать",
  "двести|триста|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот",
  "первая|вторая|третья|четвертая|пятая|шестая|седьмая|восьмая|девятая|десятая",
  "(?:один|две|три|четыр|пят|шест|сем|восем|девят)надцатая",
  "двадцатая|тридцатая|сороковая|пятидесятая|шестидесятая|семидесятая|восьмидесятая|девяностая|сотая",
  "двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто"
].join("|"));

const TURKISH_NUMBERS = numberWords([
  "bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz",
  "birinci|ikinci|ucuncu|dorduncu|besinci|altinci|yedinci|sekizinci|dokuzuncu|onuncu",
  "yirminci|otuzuncu|kirkinci|ellinci|altmisinci|yetmisinci|sekseninci|doksaninci|yuzuncu",
  "on|yirmi|otuz|kirk|elli|altmis|yetmis|seksen|doksan|yuz"
].join("|"));

const ARABIC_NUMBERS = numberWords(
  "(?:ال)?(?:أول|ثاني|ثالث|رابع|خامس|سادس|سابع|ثامن|تاسع|عاشر|حادي|عشر|عشرون|عشرين|ثلاثون|ثلاثين|أربعون|أربعين|خمسون|خمسين|ستون|ستين|سبعون|سبعين|ثمانون|ثمانين|تسعون|تسعين|مائة|مئة)",
  String.raw`\s+(?:و\s*)?`
);

const WRITTEN_NUMBER_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["chapitre", FRENCH_NUMBERS],
  ["kapitel", GERMAN_NUMBERS],
  ["capitulo", IBERIAN_NUMBERS],
  ["capitolo", ITALIAN_NUMBERS],
  ["глава", RUSSIAN_NUMBERS],
  ["bolum", TURKISH_NUMBERS],
  ["فصل|بخش|باب", PERSIAN_NUMBERS],
  ["(?:ال)?فصل|(?:ال)?باب", ARABIC_NUMBERS],
  ["باب", "پہلا|دوسرا|تیسرا|چوتھا|پانچواں|چھٹا|ساتواں|آٹھواں|نواں|دسواں"],
  ["अध्याय|भाग", "प्रथम|द्वितीय|तृतीय|चतुर्थ|पंचम|षष्ठ|सप्तम|अष्टम|नवम|दशम|पहला|दूसरा"],
  ["פרק|חלק", "[א-ת]{1,3}[׳'״\"]?|ראשון|שני|שלישי|רביעי|חמישי|שישי|שביעי|שמיני|תשיעי|עשירי"]
];

const DIGIT_HEADINGS = `(?:${foldInner(NUMBERED_LABELS.join("|"))})\\s+${NUMBER}`;
const WRITTEN_HEADINGS = WRITTEN_NUMBER_LABELS.map(([label, number]) =>
  `(?:(?:${foldInner(label)})\\s+(?:${foldInner(number)})|(?:${foldInner(number)})\\s+(?:${foldInner(label)}))`
).join("|");
const SPACED_HEADINGS = `${DIGIT_HEADINGS}|${WRITTEN_HEADINGS}`;
const CJK_NUMBER = String.raw`[\d〇零一二三四五六七八九十百千万萬两兩壱弐参拾]+`;
const CJK_HEADINGS = `第\\s*${CJK_NUMBER}\\s*[章節节部回卷]`;
const EAST_ASIAN_HEADINGS = `(?:${CJK_HEADINGS}|(?:제\\s*)?${CJK_NUMBER}\\s*[장부])`;
const BARE_HEADING = new RegExp(`^(?:${SPACED_HEADINGS}|${EAST_ASIAN_HEADINGS})\\s*[.:：。．]?$`, "u");
const TITLED_HEADING = new RegExp(`^(?:${DIGIT_HEADINGS}${SUBTITLE}|(?:${WRITTEN_HEADINGS})${WRITTEN_SUBTITLE}|${EAST_ASIAN_HEADINGS}(?:\\s+\\S.*|${SUBTITLE}))$`, "u");
const ATTACHED_CJK_HEADING = new RegExp(`^${CJK_HEADINGS}[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}].*$`, "u");

/** Plain-text boundaries need a chapter number, not just a translated word. */
export function isManuscriptHeadingLine(line: string): boolean {
  if (line.length > 90) return false;
  if (ENGLISH_HEADING.test(line)) return true;
  const folded = foldInner(line);
  if (BARE_HEADING.test(folded)) return true;
  // Chinese and Japanese titles may touch the chapter number: 第二章归乡.
  // Without a separator, keep sentence endings (第二章では旅が続く！) as prose.
  if (ATTACHED_CJK_HEADING.test(folded)) return !/[.?!。．！？،؛,;।॥۔]$/u.test(folded);
  if (!TITLED_HEADING.test(folded)) return false;
  // Numbered, separated subtitles can be questions or exclamations. Keep
  // declarative prose such as "Chapitre 2: elle raconte cette histoire." out.
  return !/[.。．،؛,;।॥۔]$/u.test(folded);
}
