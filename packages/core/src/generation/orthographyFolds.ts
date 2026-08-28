/**
 * The one place the repo's Persian/Arabic (and Latin, and Hebrew) mark tables
 * live.
 *
 * Three callers fold text before comparing it, for three different reasons:
 * `foldCharacterName` in libraryCharacters.ts, deciding whether two spellings
 * are one person's name; `foldOrthography` in promptLeak.ts, deciding whether a
 * page printed the model's own refusal boilerplate; and `foldRespelling` in
 * copyrightSafeImagePrompt.ts, deciding whether a rewritten image prompt still
 * names the character it reported removing. The first two arrived with a copy
 * of the character lists each, under comments admitting as much ("same list as
 * `foldCharacterName`'s", "mirrors `OPTIONAL_SPELLING_MARKS`") — so a mark
 * discovered missing had to be added twice or the two would silently disagree
 * about the same page.
 *
 * **Each composes its own fold out of these pieces, and the composition is
 * where the judgement lives.** `foldOrthography` runs no NFD, because a page is
 * prose and decomposing it would put every Latin accent in a mark table's
 * reach; `foldRespelling` deletes no mark at all, because it scores a name
 * against a whole document rather than against ten other names. What is offered
 * here is therefore small pieces rather than one fold with options.
 *
 * **What is shared here is the character lists and the folds, not the boundary
 * rules.** Where a name ends, where a leak phrase may start, and whether a
 * combining mark counts as part of a word are per-caller questions that are
 * deliberately answered differently — `isLibraryMentionNameCharacterAt` in the mention
 * scanner treats a mark as part of the word it follows, precisely so that
 * `@मीर` cannot end inside `@मीरा`, while the fold below deletes the marks a
 * *spelling* may carry or not. Neither may be narrowed to agree with the other.
 * Nothing in this file decides a boundary.
 */

/**
 * Latin, Greek and Cyrillic combining marks — what NFD yields for every
 * precomposed letter in those scripts. "José"/"Jose", "Nguyễn"/"Nguyen": the
 * accent is something a keyboard has or has not got.
 */
const LATIN_COMBINING_MARK_RANGES = "\\u0300-\\u036F";

/**
 * Hebrew niqqud, cantillation and the shin/sin dots. Modern Hebrew is written
 * *unpointed* and pointing is added for children's books, poetry and scripture,
 * so "שָׁלוֹם" and "שלום" are one word. The block's punctuation is excluded on
 * purpose: maqaf `U+05BE` joins two words, so deleting it would rewrite a name
 * rather than normalise it.
 */
const HEBREW_POINT_RANGES = "\\u0591-\\u05BD\\u05BF\\u05C1\\u05C2\\u05C4\\u05C5\\u05C7";

/**
 * The Arabic marks a spelling carries or does not: harakat and the tanween, the
 * dagger alef, the honorific and Quranic signs, the hamza and maddah NFD yields
 * for أ إ آ ؤ ئ — and the tatweel, which is not a mark at all (it is `Lm`) but a
 * pure elongation glyph.
 *
 * The tanween is the one that cost a book: «نموذجًا» is normally encoded
 * fathatan-then-alef, so a pattern written as `نموذج(?:اً)?\s+لغوي` —
 * alef-then-fathatan — ran its `\s+` into a diacritic and matched nothing.
 * Dropping the marks makes both encodings and the undiacritized «نموذجا» one
 * string.
 */
const ARABIC_OPTIONAL_MARK_RANGES =
  "\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E4\\u06E7\\u06E8\\u06EA-\\u06ED\\u0640";

/**
 * Invisible formatting: ZWNJ/ZWJ, the bidi marks and embedding controls, the
 * BOM.
 *
 * These are *removed* rather than turned into spaces, because Persian sets ZWNJ
 * **inside** words — «به‌عنوان» is one word written with نیم‌فاصله, not two, and
 * "علی‌رضا" is one name. `\s` does not match U+200C, which is how
 * «به‌عنوان یک مدل زبانی» sailed past a leak pattern written with `\s+` and
 * printed into a Persian book; and ZWNJ is category `Cf`, which is how a
 * boundary class of `[^\p{L}\p{N}]` read "علی‌رضا" as two words and seeded an
 * unrelated saved character.
 */
const INVISIBLE_MARKS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

const ARABIC_OPTIONAL_MARKS = new RegExp(`[${ARABIC_OPTIONAL_MARK_RANGES}]+`, "gu");

/**
 * The marks a fold is allowed to delete: the ones a name or a phrase may or may
 * not carry, where dropping them turns two spellings of one string into one.
 *
 * **An allowlist, and it has to stay one.** This was `\p{M}` — every combining
 * mark — which is right for a diacritic and catastrophic for a script whose
 * *vowels* are combining marks. Devanagari matras are `Mn`/`Mc`, so "मीरा" and
 * "मारा" both folded to the bare consonants "मर": two saved characters were one
 * name to `matchLibraryCharacter`, and a page's continuity note about one of
 * them was written onto the other one's state. Thai sara, Lao, Khmer, Tibetan
 * and Thaana vowel signs are the same story, and NFD makes Japanese one too —
 * it splits ガ into カ + `U+3099`, so a blanket strip devoiced every kana it
 * touched. The two failure directions are not symmetric, and that is what
 * settles the shape: an optional mark this list forgets costs a *missed* match,
 * which is a character drawn from prose, while a letter it deletes merges two
 * people — the stranger-wearing-the-reader's-face outcome
 * `matchLibraryCharacter` refuses an ambiguous containment to avoid. So a
 * script nobody enumerated here keeps its marks.
 *
 * Every codepoint above is `\p{M}` except the tatweel, and the ranges are
 * written out rather than taken as whole blocks so that stays checkable.
 */
const OPTIONAL_SPELLING_MARKS = new RegExp(
  `[${LATIN_COMBINING_MARK_RANGES}${HEBREW_POINT_RANGES}${ARABIC_OPTIONAL_MARK_RANGES}]+`,
  "gu"
);

/** Deletes {@link INVISIBLE_MARKS}: ZWNJ/ZWJ, the bidi controls, the BOM. */
export function stripInvisibleMarks(value: string): string {
  return value.replace(INVISIBLE_MARKS, "");
}

/**
 * Deletes the Arabic half of {@link OPTIONAL_SPELLING_MARKS} — harakat, tanween,
 * the Quranic signs, the dagger alef and the tatweel — and nothing else.
 *
 * The half rather than the whole, because a caller working on already-composed
 * text (no NFD) must not delete the Latin combining marks: without an NFD pass
 * `U+0300–U+036F` appears only where an author typed a decomposed accent, and
 * deleting it there would rewrite Latin prose the caller has no business
 * touching.
 */
export function stripArabicOptionalMarks(value: string): string {
  return value.replace(ARABIC_OPTIONAL_MARKS, "");
}

/**
 * Deletes every mark on the {@link OPTIONAL_SPELLING_MARKS} allowlist. Intended
 * to run on NFD text, which is what puts the Latin accents and the أ/إ/آ/ؤ/ئ
 * hamzas in range at all.
 */
export function stripOptionalSpellingMarks(value: string): string {
  return value.replace(OPTIONAL_SPELLING_MARKS, "");
}

/**
 * Arabic kaf and yeh onto their Persian twins.
 *
 * These are the codepoints for letters that render identically and are typed
 * interchangeably: a name saved from a Persian keyboard and echoed by a model
 * trained on Arabic text is otherwise two different names, and a model trained
 * on Arabic writes «ي»/«ك» into a Persian page. Alef maksura folds with them
 * because it is the same glyph undotted.
 *
 * **That last step is the one a caller may not want**, which is why it is the
 * only thing this adds to {@link foldInterchangeableArabicLetters}. ى is a
 * letter of its own and not merely a dotless ي: «على» is the preposition "on",
 * one of the commonest words in Arabic, and «علی» is the name Ali. Merging them
 * is right when the question is "are these two spellings one person's name" and
 * wrong when it is "does this document still contain this exact name", where
 * the preposition is on every other line.
 */
export function foldArabicKafYehOntoPersian(value: string): string {
  return foldInterchangeableArabicLetters(value).replace(/ى/gu, "ی");
}

/**
 * The half of the fold above that changes no letter: Arabic kaf and yeh onto
 * the Persian codepoints for the same two letters.
 *
 * Neither pair distinguishes a word from another word — they are one letter in
 * two national encodings, which is why they are typed interchangeably in the
 * first place — so this is safe for a caller comparing a name against a whole
 * document, where every merged pair gets a document's worth of chances to
 * collide. `survivingReplacedNames` (`copyrightSafeImagePrompt.ts`) is that
 * caller.
 */
export function foldInterchangeableArabicLetters(value: string): string {
  return value.replace(/ك/gu, "ک").replace(/ي/gu, "ی");
}

/**
 * Arabic-Indic and Persian digits onto ASCII: "R2٠۱" and "R201" are one robot.
 *
 * Shared rather than kept beside `foldCharacterName`, which is where it was
 * written, because the copyright-rewrite leak check needs exactly the same
 * table — and a table this module holds one copy of is the whole point of this
 * module. Nothing here is a judgement about a *name*: a digit written in
 * another script is the same digit, in every caller.
 */
export function foldArabicIndicDigits(value: string): string {
  return value
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}
