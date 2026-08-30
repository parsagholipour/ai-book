import type { StructuralPageEdit } from "./pageRestructure.js";
import { BOOK_PAGE_WORD_PATTERN, normalizeNumerals } from "./replanSettings.js";

/**
 * The generation boundary for a structural instruction.
 *
 * Insertions already draft and review new prose in the structural handler.
 * Deletes and moves do not, so any prose requirement attached to either must
 * use the whole-manuscript replan path instead of the direct row-ordering path.
 */
export type StructuralInstructionClassification = {
  hasContentRequirements: boolean;
  /** The explicit requirement when canonical, otherwise the conservative raw instruction. */
  contentRequirements: string | null;
};

/**
 * The coordinates a classification reads. Only the *shape* of the edit matters
 * here — never the book — so this is a `Pick` rather than the whole row: the
 * second door below compares how many pages the request *names* against how
 * many the edit already carries, which needs the selection and the anchor.
 */
export type StructuralInstructionEdit = Pick<
  StructuralPageEdit,
  "action" | "anchorPageIndex" | "pageIndexes"
>;

/**
 * Existing-page references mirror the API parser's spoken-number boundary.
 * Quantities are deliberately narrower: the model-free insert recogniser only
 * accepts word counts through ten, so teaching this classifier that "add
 * eleven pages" is a bare supported insert would make the two sides disagree.
 */
const QUANTITY_CARDINAL_WORD = "one|two|three|four|five|six|seven|eight|nine|ten";
const QUANTITY_ORDINAL_WORD =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final";
const CARDINAL_PAGE_WORD =
  `${QUANTITY_CARDINAL_WORD}|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty`;
const ORDINAL_PAGE_WORD =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|last|final";
/**
 * *Which* page a request names, and *how many* pages it asks for. One
 * alternation used to answer both, and the article is why that could not hold.
 *
 * An indefinite article counts pages — "add a page" — and never names one;
 * "page a" is not a page reference in any spelling. With `a` legal after
 * "page" and no boundary behind it, the delete prefix matched *into the next
 * word*: "Delete the page about the storm" was consumed as "Delete the page a",
 * and "bout the storm" became the content requirement. That requirement is the
 * contract printed on the proposal card, the string stored on
 * `BookEditOperation.editInstruction`, and the brief `replanBook.ts` hands to
 * `strategy.revisePlan` — so a paid book was replanned from "Bout the storm".
 * The boundary is the general guard; keeping the article out of the *naming*
 * vocabulary is what also closes "page an", which a boundary alone admits.
 */
const PAGE_NUMBER_WORD = `(?:${CARDINAL_PAGE_WORD}|${ORDINAL_PAGE_WORD})`;
const PAGE_QUANTITY_WORD = `(?:${QUANTITY_CARDINAL_WORD}|${QUANTITY_ORDINAL_WORD})`;
const PAGE_NUMBER = `(?:\\d+(?:st|nd|rd|th)?|${PAGE_NUMBER_WORD})\\b`;
const PAGE_QUANTITY = `(?:\\d+|a|an|${PAGE_QUANTITY_WORD})\\b`;
// Before the noun, cardinals count pages while ordinals identify one. Only the
// latter is an existing-page reference whose word range extends through twenty.
const PRENOMINAL_PAGE_REFERENCE = `(?:${PAGE_QUANTITY}|${ORDINAL_PAGE_WORD}\\b)`;
const PAGE_JOINER = "(?:-|–|—|to|through|,(?:\\s*(?:and|&))?|and|&)";
const PAGE_SEQUENCE = `${PAGE_NUMBER}(?:\\s*${PAGE_JOINER}\\s*(?:pages?\\s+)?${PAGE_NUMBER})*`;
/**
 * The guard belongs on the *last* thing a branch can end on, and this one ends
 * on the page noun rather than on a number. Without it the exported delete and
 * move prefixes matched into the next word exactly as the article did:
 * "remove a pageant scene" was consumed as "remove a page" and "ant scene" went
 * on as the content requirement — "Bout the storm" one branch over. Every
 * pattern exported below therefore ends at a word boundary, so no consumer has
 * to remember to add one.
 */
const PAGE_SELECTION = `(?:the\\s+)?(?:pages?\\s+${PAGE_SEQUENCE}|${PRENOMINAL_PAGE_REFERENCE}\\s+pages?\\b)`;

/**
 * How a request names *which* pages, in the one place both readers of it take
 * it from.
 *
 * This classifier and the API's canonical-instruction extractor
 * (`apps/api/src/mobile/structuralPageEdits.ts`) ask opposite questions of the
 * same grammar — "is the whole instruction structural" and "what is left once
 * the structural part is gone" — and used to spell it out twice, byte for byte.
 * Two copies of one grammar are two chances to be narrow: "the final page"
 * parsed as a selection in neither, so a delete of it was classified as prose
 * work *and* had "of the story" extracted as the prose. A widening has to reach
 * both answers or the extractor produces a requirement the classifier then
 * prices a whole book for.
 */
export const STRUCTURAL_PAGE_SELECTION_PATTERN = PAGE_SELECTION;

/**
 * The verbs each action is written with, and a **superset** of the three lists
 * `structuralPageEditFromMessage` (`apps/api/src/bookEditStructure.ts`) resolves
 * a request into an edit with.
 *
 * Superset rather than copy, because the two costs are not symmetric. Missing a
 * verb that recogniser accepts is the failure the block below describes:
 * `shift` and `put` were both free row reorders quoted as whole-book replans,
 * and the same missing `put` briefed an insert with "Put a new page after
 * page 3". Carrying one it does not know costs nothing — `erase` and `create`
 * are here and not there, and a model-routed "erase page 4" is bare either way.
 * `structuralPageEditInstructions.test.ts` drives that recogniser's own verbs
 * through this classifier, so widening one side alone fails.
 */
const ACTION_VERB: Record<StructuralPageEdit["action"], string> = {
  insert: "(?:add|insert|create|write|append|put)",
  delete: "(?:delete|remove|drop|cut|erase|take\\s+out|get\\s+rid\\s+of)",
  move: "(?:move|reorder|relocate|shift|put)"
};

/**
 * The clause an instruction opens with, up to and including the pages it names.
 *
 * Shared for the same reason the selection is: this module asks whether the
 * *whole* instruction is that clause, and the extractor takes the clause off the
 * front to see what a compound request asked for on top. A verb known to one and
 * not the other is a request whose action is recognised but not removed — the
 * remainder is then the request restated, and a restatement priced as prose is a
 * whole-book replan.
 */
export const STRUCTURAL_ACTION_PREFIX_PATTERN: Record<StructuralPageEdit["action"], string> = {
  insert: `(?:please\\s+)?${ACTION_VERB.insert}\\s+(?:${PAGE_QUANTITY}\\s+)?(?:(?:new|opening|closing|final)\\s+)*pages?\\b`,
  delete: `(?:please\\s+)?${ACTION_VERB.delete}\\s+${PAGE_SELECTION}`,
  move: `(?:please\\s+)?${ACTION_VERB.move}\\s+${PAGE_SELECTION}`
};

/** Naming the book the pages are leaving is not naming something to write. */
export const STRUCTURAL_WHOLE_BOOK_TAIL_PATTERN =
  "(?:\\s+(?:from|of|in)\\s+(?:the\\s+)?(?:book|story|manuscript)\\b)?";

// Legacy payloads sometimes kept coordinates only in `structuralEdit` and a
// generic action in request/editInstruction. That is still structural syntax;
// any word beyond this closed phrase fails into generation.
//
// The demonstratives are not decoration. A reader with the page open in front
// of them says "remove *this* page", so the phrasing the in-app reader produces
// most was the one determiner missing here, and a delete the resolver had
// already pinned to a single row was priced as a whole second book.
const GENERIC_PAGE_OBJECT = "(?:(?:the|this|that|these|those)\\s+)?pages?";
const EDGE_PLACEMENT =
  "(?:(?:at|to)\\s+(?:the\\s+)?(?:very\\s+)?(?:front|beginning|start|end|back)(?:\\s+of\\s+(?:the\\s+)?book)?|as\\s+(?:the\\s+)?(?:first|last|opening|closing)\\s+pages?)";
const NUMBERED_PLACEMENT = `(?:(?:to\\s+)?(?:after|before|following|preceding)|at|to)\\s+${PAGE_SELECTION}`;
/** A closing courtesy is not a content requirement, and the opening one already was not. */
const COURTESY_TAIL = "(?:\\s*,?\\s*(?:please|thanks|thank\\s+you))?";

const PURE_INSERT = new RegExp(
  `^${STRUCTURAL_ACTION_PREFIX_PATTERN.insert}(?:\\s+(?:${NUMBERED_PLACEMENT}|${EDGE_PLACEMENT}))?${COURTESY_TAIL}$`,
  "i"
);
const PURE_DELETE = new RegExp(
  `^(?:please\\s+)?${ACTION_VERB.delete}\\s+(?:${PAGE_SELECTION}|${GENERIC_PAGE_OBJECT})${STRUCTURAL_WHOLE_BOOK_TAIL_PATTERN}${COURTESY_TAIL}$`,
  "i"
);
const PURE_MOVE = new RegExp(
  `^(?:please\\s+)?${ACTION_VERB.move}\\s+(?:${PAGE_SELECTION}|${GENERIC_PAGE_OBJECT})(?:(?:\\s+from\\s+(?:(?:after|before|following|preceding)\\s+)?${PAGE_SELECTION})?\\s+(?:${NUMBERED_PLACEMENT}|${EDGE_PLACEMENT}))?${COURTESY_TAIL}$`,
  "i"
);

/**
 * Scripts that write a whole word where a Latin one writes a syllable, and so
 * write a sentence with no spaces in it. An inflectional ending is never one of
 * these, which is the only thing that keeps "ページを削除して面白くして" from
 * reading as the page noun plus a case ending.
 */
const DENSE_SCRIPT = "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\p{sc=Thai}";
/** The ending a stem carries in a script that separates its words. */
const INFLECTION = `(?:(?![${DENSE_SCRIPT}])[\\p{L}\\p{M}])*`;

/**
 * Every way the languages we ship fonts for write "page", English included,
 * with room for the case ending the noun itself carries: `BOOK_PAGE_WORD_PATTERN`
 * spells the Russian one `страниц\w*`, and JavaScript's `\w` is ASCII, so
 * "страницу" would otherwise leave a "у" behind that nothing can account for.
 */
const PAGE_NOUN = `(?:ال)?(?:${BOOK_PAGE_WORD_PATTERN})${INFLECTION}`;

/**
 * The words a bare structural request is made of, beyond the page it names.
 *
 * **A budget on what is left over cannot answer this**, and the corpus says so
 * rather than taste: the heaviest bare request measured
 * ("4ページを削除してください") and the lightest compound one
 * ("删除第4页并让它更有趣") both weigh exactly eighteen. There is no constant
 * between them, so every value of one either prices a free row deletion as a
 * whole second book or — the expensive direction — lets a request that asked
 * for two things be delivered as one, silently, with the reader charged for the
 * half they got and told nothing.
 *
 * So the second door **recognises** rather than measures, exactly as the closed
 * English grammar above does: every word of the request must be a page
 * reference or one of these, and a single unlisted word is a content
 * requirement. That inverts the failure: a language, a verb or a phrasing
 * nobody listed falls back to the whole-book quote the reader sees on the card
 * and can cancel, and no gap in this table can drop prose work. A partial
 * vocabulary is therefore an honest one — add a language by adding its verbs
 * and its furniture, and nothing else has to move.
 *
 * Nothing English is listed. That is what keeps English on a single authority:
 * a request made only of page nouns and this table is bare, and a request that
 * used no entry from it never reaches here at all, so "scrap page 2 and make it
 * funny" stays with the grammar written to judge it.
 */
const STRUCTURAL_VERB_STEMS = [
  // Persian, Dari and Urdu
  "حذف", "پاک", "بردار", "ببر", "منتقل", "جابجا", "مٹا", "ہٹا",
  // Arabic
  "احذف", "امسح", "مسح", "أزل", "ازل", "انقل", "نقل", "حرك",
  // Spanish, Portuguese and Italian
  "elimin", "suprim", "borr", "apag", "exclu", "cancell", "rimuov", "traslad", "spost", "desplaz",
  // French
  "supprim", "effac", "retir", "enlev", "enlèv", "déplac", "deplac",
  // German and Dutch
  "lösch", "entfern", "streich", "verschieb", "versetz", "verwijder", "verplaats",
  // Russian
  "удал", "убер", "убра", "перемест", "перенес", "передвин",
  // Polish
  "usuń", "usun", "skasuj", "przenieś", "przenies",
  // Turkish, Norwegian, Danish and Swedish
  "taşı", "tasi", "slett", "fjern", "flytt", "rader",
  // Hindi
  "हटा", "मिटा", "निकाल", "स्थानांतरित",
  // Hebrew
  "מחק", "למחוק", "תמחק", "הסר", "להסיר", "העבר", "להעביר"
];

/**
 * Closed-class furniture: the articles, particles, placements and the book
 * itself. These are matched whole — a stem's ending is an inflection, a
 * particle's neighbour is another word — so nothing here may carry a tail.
 */
const STRUCTURAL_FUNCTION_WORDS = [
  // Persian, Dari and Urdu
  "را", "کن", "کنید", "کنین", "بکن", "کریں", "کرو", "کر", "دیں", "دو",
  "از", "به", "بعد", "قبل", "اول", "آخر", "انتها", "ابتدا", "پایان",
  "کتاب", "داستان", "لطفا", "لطفن", "ممنون",
  // Arabic
  "من", "في", "إلى", "الى", "الكتاب", "كتاب", "القصة", "قصة", "رجاء", "فضلك", "شكرا",
  // Spanish, Portuguese and Italian
  "la", "el", "lo", "las", "los", "le", "il", "un", "una", "de", "del", "della", "dello",
  "dal", "dalla", "da", "do", "dos", "das", "al", "en", "nel",
  "después", "despues", "antes", "dopo", "prima", "final", "finale",
  "principio", "inicio", "início", "fine", "inizio",
  "mueve", "mueva", "mover", "mova", "quita", "quitar", "quite",
  "libro", "livro", "historia", "história", "storia", "por", "favor", "gracias", "grazie",
  // French
  "les", "du", "des", "au", "aux", "à", "après", "apres", "avant",
  "fin", "début", "debut", "livre", "histoire", "merci", "svp",
  // German and Dutch
  "die", "der", "das", "dem", "den", "aus", "im", "vom", "zum", "zur",
  "nach", "vor", "hinter", "ende", "anfang", "buch", "geschichte", "bitte", "danke",
  "het", "uit", "boek", "verhaal", "na", "alstublieft",
  // Russian
  "из", "в", "на", "после", "перед", "книги", "книге", "книгу", "книга",
  "истории", "конец", "начало", "пожалуйста",
  // Polish
  "strona", "stronę", "strony", "z", "ksiazki", "książki", "proszę", "po", "przed",
  // Turkish
  "sayfa", "sayfayı", "sayfayi", "sil", "silin", "siliniz",
  "kitap", "kitaptan", "kitabından", "lütfen", "sonra", "sonuna", "önce", "başına",
  // Norwegian, Danish and Swedish
  "side", "siden", "sider", "sida", "fra", "boka", "boken", "boken",
  "etter", "før", "til", "slutten", "begynnelsen", "takk", "vennligst",
  // Hindi
  "दें", "दो", "करें", "कर", "से", "के", "बाद", "पहले", "किताब", "कृपया",
  // Thai
  "ลบ", "ย้าย", "ออก", "ทิ้ง", "จาก", "หนังสือ", "กรุณา", "หลัง", "ก่อน",
  // Chinese
  "删除", "删掉", "删", "去掉", "移除", "移到", "移动", "移動", "移", "挪",
  "第", "把", "将", "从", "的", "书", "故事", "请",
  "后面", "前面", "之后", "之前", "末尾", "开头", "到", "至",
  // Japanese
  "削除", "消", "移動", "を", "の", "に", "へ", "から", "本",
  "して", "下さい", "ください", "お願い", "します", "後", "前", "最後", "最初",
  // Korean
  "삭제", "지워", "없애", "이동", "옮겨", "를", "을", "은", "는", "에서", "책",
  "해줘", "해주세요", "주세요", "하세요", "뒤", "앞", "마지막", "처음",
  // Hebrew
  "את", "מהספר", "הספר", "ספר", "אחרי", "לפני", "בבקשה"
];

/**
 * An alternation answers with the first branch that matches, never the longest,
 * so a listed word that opens another one shadows it: "de" swallowed the first
 * two letters of "después" and left "spués" unaccounted for, which read a bare
 * Spanish move as prose work. Ordering the branches is what makes "the longest
 * listed spelling wins" true of each scanner as well as across them.
 */
function longestFirst(words: readonly string[]): string {
  return [...words].sort((left, right) => right.length - left.length).join("|");
}

/**
 * The scanners, in the order a match is *reported* rather than tried: every one
 * is asked at the same offset and the longest answer wins, so a listed prefix
 * of a longer listed spelling ("移" under "移到") can never shadow it.
 *
 * `foreign` is the English-authority flag. A word built only out of page nouns
 * is not evidence of anything — "page 4" is English — so the door needs at
 * least one word this table claims.
 */
const STRUCTURAL_ATOM_SCANNERS: readonly (readonly [RegExp, boolean])[] = [
  [new RegExp(PAGE_NOUN, "iuy"), false],
  [new RegExp(`(?:${longestFirst(STRUCTURAL_VERB_STEMS)})${INFLECTION}`, "iuy"), true],
  [new RegExp(`(?:${longestFirst(STRUCTURAL_FUNCTION_WORDS)})\\p{M}*`, "iuy"), true]
];

/**
 * The conservative answer: this clause could not be shown to be structural, so
 * every word of it is a prose requirement.
 *
 * One function because the two branches below reach it with different clauses —
 * the whole instruction when there is no marker, the part *before* the marker
 * when there is — and spelling it twice is how the second one came to hand back
 * `instruction` whole: an empty `Content requirements:` body made the literal
 * marker words the brief a paid book was replanned from. `null` rather than an
 * empty string when nothing survives normalization, because a requirement is
 * either text or absent.
 */
function conservativeRequirement(clause: string): StructuralInstructionClassification {
  return {
    hasContentRequirements: true,
    contentRequirements: normalizedClause(clause) || clause.trim() || null
  };
}

function normalizedClause(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:—–-]+|[\s,.;:!?—–-]+$/g, "")
    .trim();
}

/**
 * The request's words, with everything a page reference is made of taken away:
 * numerals in any script, the case ending a numeral carries in its own right
 * (Turkish writes "4'ü", not "4 ü"), then punctuation and symbols.
 *
 * Format characters are deleted rather than replaced, because a ZWNJ joins one
 * word rather than separating two: "صفحه‌ی" is a page reference and splitting it
 * would leave an orphan nothing can account for.
 */
function structuralWords(instruction: string): string[] {
  return normalizeNumerals(instruction)
    .replace(/\p{Cf}+/gu, "")
    .replace(/\d+(?:['’][\p{L}\p{M}]{1,4})?/gu, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/**
 * Whether one word is structural, and whether recognising it took a non-English
 * entry — or `null` when some part of it is unaccounted for.
 *
 * The scan is greedy and never backtracks: at each offset the longest listed
 * spelling wins and the offset advances. That is what keeps a vocabulary this
 * large linear over user text — an alternation under a `+` is the classic
 * exponential blow-up, and a request is up to 1200 characters of it. A split
 * that only a shorter alternative could have reached is therefore missed, and
 * missing one is an overcharge rather than dropped prose work.
 */
function structuralWordKind(word: string): "page" | "foreign" | null {
  let at = 0;
  let foreign = false;
  while (at < word.length) {
    let matched = 0;
    for (const [scanner, isForeign] of STRUCTURAL_ATOM_SCANNERS) {
      scanner.lastIndex = at;
      if (scanner.test(word) && scanner.lastIndex - at > matched) {
        matched = scanner.lastIndex - at;
        foreign = foreign || isForeign;
      }
    }
    if (matched === 0) {
      return null;
    }
    at += matched;
  }
  return foreign ? "foreign" : "page";
}

/** How many distinct pages the request names, in whatever numerals it used. */
function namedPageNumberCount(instruction: string): number {
  const digits = normalizeNumerals(instruction).match(/\d+/gu);
  return digits ? new Set(digits.map((value) => Number(value))).size : 0;
}

/** How many pages the edit itself has a coordinate for. */
function structuralCoordinateCount(edit: StructuralInstructionEdit): number {
  const selected = new Set(edit.pageIndexes).size;
  return edit.action === "move" && edit.anchorPageIndex !== null ? selected + 1 : selected;
}

/**
 * True when a request in another language says nothing the edit does not
 * already carry.
 *
 * The first door is subtractive — strip a closed English action clause and call
 * whatever is left the prose requirement — so an instruction it cannot read at
 * all comes back as *entirely* prose. That is the safe answer for an unknown
 * phrase and the wrong one for a whole language: "صفحه ۴ را حذف کن" is a bare
 * delete, and reading it as a content requirement repriced a free row deletion
 * as a whole-book replan for every reader who does not type in English.
 *
 * So the second door is additive, and asks for positive evidence that the
 * request is bare. Three bounds, and none of them is a length: it may not
 * **name a page the edit has no coordinate for** — counted, never compared,
 * because the request speaks printed numbers and the edit holds model indexes —
 * every word of it must be a page reference or listed structural vocabulary,
 * and at least one of those words must be one this project had to learn.
 * A second clause fails the middle bound, because a predicate is a content word
 * and no content word is listed.
 */
function restatesStructuralEditOnly(edit: StructuralInstructionEdit, instruction: string): boolean {
  const words = structuralWords(instruction);
  if (words.length === 0 || namedPageNumberCount(instruction) > structuralCoordinateCount(edit)) {
    return false;
  }
  let foreign = false;
  for (const word of words) {
    const kind = structuralWordKind(word);
    if (kind === null) {
      return false;
    }
    foreign = foreign || kind === "foreign";
  }
  return foreign;
}

/**
 * True when the instruction asks for the structural edit and nothing else.
 *
 * Two doors, and the second is open to deletes and moves only. An insert's
 * remainder is its drafting brief rather than a repricing trigger, so calling a
 * bare-looking insert "bare" would throw the subject away ("صفحه‌ای درباره مینا
 * اضافه کن") instead of saving anyone a charge.
 */
export function isBareStructuralInstruction(
  edit: StructuralInstructionEdit,
  instruction: string
): boolean {
  const normalized = normalizedClause(instruction);
  if (!normalized) return false;
  switch (edit.action) {
    case "insert":
      return PURE_INSERT.test(normalized);
    case "delete":
      return PURE_DELETE.test(normalized) || restatesStructuralEditOnly(edit, normalized);
    case "move":
      return PURE_MOVE.test(normalized) || restatesStructuralEditOnly(edit, normalized);
  }
}

/**
 * Classifies both the canonical API spelling and conservative legacy rows.
 *
 * Canonical instructions carry an explicit `Content requirements:` boundary,
 * so page references inside the requirement are never mistaken for placement.
 * A requirement the extractor put there is taken at its word — only the raw
 * spelling is measured, because the marker means the API already decided this
 * text is prose. Legacy instructions are structural-only when
 * {@link isBareStructuralInstruction} can show they are. Ambiguity takes the
 * generation path (or, in the legacy worker defense, fails safely).
 */
export function classifyStructuralEditInstruction(
  edit: StructuralInstructionEdit,
  instruction: string
): StructuralInstructionClassification {
  const marker = /\bContent requirements:\s*/i.exec(instruction);
  if (marker?.index !== undefined) {
    const action = instruction.slice(0, marker.index);
    const content = normalizedClause(instruction.slice(marker.index + marker[0].length));
    if (content) {
      return { hasContentRequirements: true, contentRequirements: content };
    }
    if (isBareStructuralInstruction(edit, action)) {
      return { hasContentRequirements: false, contentRequirements: null };
    }
    // An empty body says the extractor found no prose, which is not the same as
    // there being none: the action clause is what it could not read, so that is
    // what stays a requirement. Answering with `instruction` instead put the
    // words "Content requirements" themselves into the brief.
    return conservativeRequirement(action);
  }

  if (isBareStructuralInstruction(edit, instruction)) {
    return { hasContentRequirements: false, contentRequirements: null };
  }
  return conservativeRequirement(instruction);
}

/** True only when the direct structural path would otherwise drop requested prose work. */
export function structuralEditRequiresWholeBookGeneration(
  edit: StructuralInstructionEdit,
  instruction: string
): boolean {
  return edit.action !== "insert" && classifyStructuralEditInstruction(edit, instruction).hasContentRequirements;
}
