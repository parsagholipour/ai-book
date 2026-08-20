/**
 * Prompt-leak detection: the pattern tables that catch our own instructions —
 * or the model's refusal boilerplate — printed into a finished page, plus the
 * orthographic fold that makes them fire on real Persian and Arabic.
 *
 * Two callers share this: `runLocalPageQualityChecks` in pagesLocalQa.ts (page
 * QA, which flags the page for a rewrite) and the manuscript integrity pass in
 * manuscriptQuality.ts (the publish gate, which blocks the export). They kept
 * copy-pasted copies of the same regexes under the same comment, so the
 * non-Latin ones were wrong in two places at once and had to be fixed twice.
 * Their English tables stay separate on purpose — one is about *our* page
 * brief leaking, the other about the conversation leaking — but the model
 * naming itself is one leak in one language-independent shape.
 *
 * The mark tables and the letter folds live in `orthographyFolds.ts`, shared
 * with `foldCharacterName`; the boundary rules below are this file's own.
 */

import {
  foldArabicKafYehOntoPersian,
  stripArabicOptionalMarks,
  stripInvisibleMarks
} from "./orthographyFolds.js";

/**
 * The comparison form of a page, and of every pattern below.
 *
 * Only Arabic-block codepoints and invisible marks are rewritten, so Latin
 * prose passes through byte-identical and the English patterns are unaffected.
 * The letter folds are pairs that render alike and are typed interchangeably:
 * a model trained on Arabic writes «ي»/«ك» into a Persian page and a Persian
 * keyboard writes «ی»/«ک» into an Arabic one, and the hamza carriers أ إ آ ؤ ئ
 * are the same letters wearing a mark — folded here by hand rather than through
 * NFD, which this side deliberately does not run: a page is prose, and
 * decomposing it would put every Latin accent in a mark table's reach.
 * Whitespace is deliberately *not* collapsed: a pattern must not be able to
 * match across a paragraph break.
 */
function foldOrthography(value: string): string {
  return foldArabicKafYehOntoPersian(
    stripArabicOptionalMarks(stripInvisibleMarks(value))
      .replace(/[أإآٱ]/gu, "ا")
      .replace(/ؤ/gu, "و")
      .replace(/ئ/gu, "ی")
  );
}

/**
 * A pattern written in each language's natural orthography, compiled against
 * the folded form. The fold never touches ASCII, so a source's regex syntax
 * survives it untouched — which is what lets these tables stay readable in
 * Arabic script instead of being spelled in whichever variant the fold picked.
 */
function folded(pattern: RegExp): RegExp {
  return new RegExp(foldOrthography(pattern.source), pattern.flags);
}

/**
 * A left word boundary for scripts JS has none for. `\b` is defined over
 * `[A-Za-z0-9_]`, so it fires between *any* two Arabic-script letters and
 * between none of them — which is how «مصاحبه عنوان یک مدل زبانی» matched
 * inside «مصاحبه» ("interview", which simply ends in «به») and reported a
 * prompt leak. `(?<!\p{L})` is the boundary that actually holds, and it is why
 * every RTL entry below carries the `u` flag.
 */
const LETTER_START = "(?<!\\p{L})";
const LETTER_END = "(?!\\p{L})";

/**
 * How far from the phrase the self-reference may sit: to the end of the
 * sentence, and no further.
 *
 * A model's apology names itself and then says what *it* cannot do, in one
 * breath. Letting the window cross a full stop is what would put an ordinary
 * first-person sentence in range of an ordinary AI sentence beside it.
 */
const SELF_REFERENCE_WINDOW = "[^.!?؟\\n]{0,80}?";

/**
 * The first person, in the forms a Persian refusal actually writes.
 *
 * Enumerated rather than derived. The 1sg ending is a bare «ـم», which is also
 * how a great many ordinary nouns end (سلام, تمام, مریم), and the negated
 * present «نمی…م» sweeps in the 1pl «نمی‌دانیم» — so an ordinary Persian
 * sentence would find a "first person" wherever it looked. What is listed is
 * refusal- and self-description-shaped: cannot, am not, have not, for me, I am
 * sorry, I was made/trained. Bare «من» is deliberately **absent**: every real
 * apology that opens with it also carries one of these verbs, so it would buy
 * no recall and cost «… و من آن را دوست دارم» in a book about AI.
 */
const PERSIAN_FIRST_PERSON = [
  LETTER_START,
  "(?:",
  "نمی\\s*(?:توانم|تونم|کنم|دهم|نویسم|سازم)",
  "|نیستم|هستم|ندارم|برایم|متأسفم",
  "|(?:شده|دیده|کرده|بوده|آموخته)\\s*ام",
  ")",
  LETTER_END
].join("");

/**
 * The same, in Arabic. «لا أستطيع» / «لا يمكنني» are what the boilerplate
 * reaches for; «أنا», «لست» and «لدي» carry the pronoun outright, and
 * «صممت»/«تدريبي»/«برمجتي» are the "I was built/trained" half.
 */
const ARABIC_FIRST_PERSON = [
  LETTER_START,
  "(?:أستطيع|يمكنني|أقدر|أنا|لست|لدي|صممت|تدريبي|برمجتي)",
  LETTER_END
].join("");

/**
 * The same, in English. The tables are case-insensitive, so `\bI\b` also finds
 * the "i" of "i.e."; forbidding a following letter, digit or full stop is what
 * keeps the pronoun and leaves the abbreviation.
 */
const ENGLISH_FIRST_PERSON = "(?:\\bI(?![A-Za-z0-9.])|\\bmy\\b|\\bme\\b|\\bmyself\\b)";

/**
 * The model talking about itself: the refusal boilerplate that arrives mid-page
 * when a draft goes wrong. This is the one leak that reaches a reader in their
 * own language, so it is listed in the scripts the product actually ships books
 * in, and it is shared by both callers.
 *
 * **Naming the phrase is not enough; the sentence has to be about the speaker.**
 * Every entry here is either first-person by construction («بصفتي» is "in my
 * capacity as", «أنا» is "I") or carries an explicit first-person tail, because
 * the phrases themselves are what a book *about* AI is made of:
 * «این فناوری به عنوان هوش مصنوعی شناخته می‌شود» ("this technology is known as
 * artificial intelligence"), «ترنسفورمر به عنوان یک مدل زبانی معرفی می‌شود»,
 * "GPT-2 was released as an AI language model in 2019", "As a large language
 * model grows, its behaviour changes", «يُعرَّف هذا النظام كنموذج لغوي كبير». Each
 * of those was a prompt leak to this table, which flips `promptLeakFree` and
 * burns the page's revision budget on correct prose — and then files
 * `PROMPT_LEAKAGE` at severity error in the publish gate, so a Persian book
 * about AI could not be exported at all. English word order hid it: "as an AI
 * model, I cannot" reads as self-reference because the clause is fronted, and
 * the same three words mid-sentence are an ordinary adjunct.
 *
 * The cost of the tail is a refusal phrased in the third person
 * («به عنوان یک مدل زبانی، این کار ممکن نیست») going unflagged. That is the
 * right way round: a missed leak is one bad paragraph a reader can ask to have
 * rewritten, and a false one is a finished, paid-for book that will not publish.
 *
 * The `\s*` gaps are not looseness — the fold has already deleted the ZWNJ that
 * Persian writes inside «به‌عنوان» and the tatweel an Arabic model sprinkles
 * through «نمـوذج», so the two halves arrive glued.
 */
const MODEL_SELF_REFERENCE_PATTERNS = [
  // `\b` is load-bearing: without it "the camera w[as an AI model] of the
  // older type" was a prompt leak.
  new RegExp(
    `\\bas\\s+an?\\s+(?:ai|artificial\\s+intelligence)(?:\\s+language)?\\s+model\\b${SELF_REFERENCE_WINDOW}${ENGLISH_FIRST_PERSON}`,
    "i"
  ),
  new RegExp(
    `\\bas\\s+a\\s+large\\s+language\\s+model\\b${SELF_REFERENCE_WINDOW}${ENGLISH_FIRST_PERSON}`,
    "i"
  ),
  // Persian: «به عنوان یک مدل زبانی / مدل هوش مصنوعی / هوش مصنوعی», with یک
  // optional because plenty of drafts drop it.
  new RegExp(
    `${LETTER_START}به\\s*عنوان\\s*(?:یک\\s*)?(?:مدل\\s*زبانی|(?:مدل\\s*)?هوش\\s*مصنوعی)${SELF_REFERENCE_WINDOW}${PERSIAN_FIRST_PERSON}`,
    "u"
  ),
  // Already a whole self-referential clause: "I am a language model".
  new RegExp(`${LETTER_START}من\\s*(?:یک\\s*)?مدل\\s*زبانی\\s*هستم`, "u"),
  // Arabic: «بصفتي/بوصفي نموذجًا لغويًا», the same with «ذكاء اصطناعي», and
  // the attached ك- form, which is the phrasing an Arabic model reaches for
  // most. «بصفتي»/«بوصفي» carry the 1sg possessive, so they need no tail;
  // «كنموذج لغوي» is merely "as a language model" and does, for exactly the
  // reason the Persian entry does.
  new RegExp(`${LETTER_START}(?:بصفتي|بوصفي)\\s*نموذجا?\\s*لغوي`, "u"),
  new RegExp(`${LETTER_START}(?:بصفتي|بوصفي)\\s*(?:نموذجا?\\s*)?ذكاء\\s*اصطناعي`, "u"),
  new RegExp(
    `${LETTER_START}كنموذج\\s*(?:لغوي|ذكاء\\s*اصطناعي)${SELF_REFERENCE_WINDOW}${ARABIC_FIRST_PERSON}`,
    "u"
  ),
  new RegExp(`${LETTER_START}أنا\\s*نموذج\\s*لغوي`, "u")
];

/**
 * Page QA's table: our own drafting instructions printed as prose — schema
 * names, image directions, production notes.
 */
export const PAGE_PROMPT_LEAK_PATTERNS: readonly RegExp[] = [
  /global visual style/i,
  /continuity rules:/i,
  /return json/i,
  /json schema/i,
  /pageinstruction/i,
  /image prompt/i,
  /avoid text inside images/i,
  /generation instructions/i,
  /production instructions/i,
  /do not mention ai/i,
  ...MODEL_SELF_REFERENCE_PATTERNS
].map(folded);

/**
 * The publish gate's table: the shapes that mean a page is quoting the
 * conversation rather than being the book.
 */
export const MANUSCRIPT_PROMPT_LEAK_PATTERNS: readonly RegExp[] = [
  /system\s+prompt/i,
  /developer\s+message/i,
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /chain[- ]of[- ]thought/i,
  /private\s+source\s+material\s+from\s+the\s+user/i,
  ...MODEL_SELF_REFERENCE_PATTERNS
].map(folded);

/** Whether any of `patterns` matches `value` once it is folded. */
export function containsPromptLeak(value: string, patterns: readonly RegExp[]): boolean {
  const text = foldOrthography(value);
  return patterns.some((pattern) => pattern.test(text));
}
