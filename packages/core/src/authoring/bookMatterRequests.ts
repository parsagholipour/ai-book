import type { BookMatterChatField } from "./bookMatterChatEdit.js";
import { isLocalizedBookEditRequest, localizedBookEditBreaks, localizedBookMatterBreaks, protectLocalizedOrdinalPeriods } from "./bookMatterLocalizedRequests.js";
import {
  arabicScriptFold,
  bookMatterFieldsNamedIn,
  contentWordsIn,
  instructsTheChange,
  kinWordsIn,
  looselyQuotedFrom,
  looseQuotable,
  quotable,
  quotedFrom,
  wordsIn
} from "./bookMatterWords.js";

/**
 * What a matter message asks, clause by clause — the model-free half of the
 * matter composer's checks (`bookMatterChatEdit.ts`): whether a value the
 * composer printed runs on into a request spoken to the editor
 * ({@link runsOnIntoRequest}, a refusal), and whether the message asked for
 * something besides the matter that the reply has to name back
 * ({@link separateRequestIn}).
 *
 * The refusal is held to the owner's rule — ~99% accurate on legitimate input
 * — so a request counts as the editor's only where it plainly is: it names
 * another part of the book as the object of an edit ("redo the cover"), or it
 * opens on "also / plus / lastly / finally" where a request opens — never
 * where a dedication's or a biography's own sentence goes on ("Good stories
 * also make good people", "Keep the pictures in this book close to your
 * heart"). `bookMatterChatEdit.measured.test.ts` measures it.
 */

/** Imperative edit verbs that start a request of their own. */
const EDIT_VERBS =
  "make|rewrite|write|change|add|delete|remove|fix|turn|keep|move|update|redraw|redo|regenerate|replace|shorten|lengthen|expand|cut|trim|translate|rename|retitle|draw|illustrate|swap|insert|edit|put|set|use|give|create|generate|improve|polish|simplify|continue|extend|dedicate|print|drop";

/**
 * The edit verbs that only ever change a book: said to the editor, never to
 * the person a dedication speaks to. "Draw", "make", "turn" or "put" with the
 * book's pictures as object is as often a line to a child ("Make the pictures
 * in this book your own"), and "keep" or "use" ("Keep the pictures in this
 * book close to your heart") edits nothing.
 */
const EDITOR_ONLY_VERBS: ReadonlySet<string> = new Set(
  "rewrite change delete remove fix move update redraw redo regenerate replace shorten lengthen expand trim translate rename retitle swap insert edit improve polish simplify drop".split(" ")
);
const NEVER_AIMED_AT_THE_BOOK: ReadonlySet<string> = new Set(["keep", "use"]);

/** "can you" / "could you" between a lead and its verb ("… also could you shorten chapter 4"). */
const ASKED = String.raw`(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;

/**
 * Where one request ends and another may begin: a sentence end, a colon, a
 * comma or semicolon before an edit verb, "and" before one, just before "then
 * / also / plus" and one — those stay on the clause they open, where its lead
 * is read, and open one only where {@link leadOpensClause} says a clause
 * starts — and Persian's "و", or just before its "همچنین / سپس / بعدش".
 */
const CLAUSE_BREAK = new RegExp(
  [
    String.raw`[.!?؟。！？।॥۔\n]+`,
    String.raw`[:：]`,
    String.raw`[,;،]\s*(?=(?:and\s+)?(?:please\s+)?${ASKED}(?:${EDIT_VERBS})\b)`,
    // At most three leads before the verb: an unbounded run re-read every "also" after each one.
    String.raw`\band\s+(?=(?:also\s+|then\s+|please\s+){0,3}${ASKED}(?:${EDIT_VERBS})\b)`,
    String.raw`(?<lead>)(?=\b(?:then|also|plus)\s+(?:also\s+|then\s+|please\s+){0,3}${ASKED}(?:${EDIT_VERBS})\b)`,
    arabicScriptFold(String.raw`\sو\s|(?<=\s)(?=(?:همچنین|سپس|بعدش)\s)`)
  ].join("|"),
  "giu"
);

/**
 * The words a clause opens on before a lead that still leave the lead at the
 * clause's start: nothing, or "and / but / so / please" ("and also redo the
 * cover", ", but also make page 2 shorter").
 */
const AT_CLAUSE_START = /^(?:(?:and|but|so|or|oh|ok|okay|now|please|well)\b[\s,]*)*$/iu;
/**
 * A subject pronoun or "who" just before the lead, whose own sentence it is
 * ("I also write poetry", "and I also give workshops", "who also draw").
 */
const SUBJECT_JUST_BEFORE = /(?:^|[^\p{L}\p{N}'’])(?:i|we|she|he|they|who|which)(?:['’](?:ll|d|ve|m|re))?\s*$/iu;
/** "You can also redo the cover": the reader asking the editor, when what follows is aimed at the book. */
const YOU_ASKED = /(?:^|\s)you\s+(?:can|could|should|might|may|will|would)(?:\s+(?:please|maybe|perhaps|just))?$/iu;
/**
 * A word that starts a clause of its own inside a request — a complement, a
 * relative, a subordinate clause or a new subject — after which a lead is that
 * clause's own verb ("add that my kids also draw", "dedicate it to my grandma,
 * who taught me that books also make friends", "write my bio I'm a nurse and
 * my kids also draw").
 */
const SUBORDINATE =
  /(?<![\p{L}\p{N}'’])(?:that|who|whom|whose|which|because|since|so|how|where|when|while|if|whether|though|although|why|what|i|we|she|he|they)(?![\p{L}\p{N}])/iu;

/**
 * How much of a clause the lead test reads back: a tail is a few words, and a
 * lead may come every few words of a long clause.
 */
const TAIL_SPAN = 160;
const TAIL_MARKS = [",", ";", "،", "—", "–", "("];

/** Where a sentence sits: in the field's own words, and whether it is a one-line field's value ("Author: Sam Lee"). */
type SentencePlace = { given: boolean; oneLine: boolean };

/**
 * Whether "also / then / plus" and a verb at `at` open a clause of their own.
 * Only where a clause starts: at the sentence's start, after a comma, a
 * semicolon, a dash, "and" or "but" — never after a subject inside a clause,
 * whatever words it is made of ("She and her husband also make cheese", "Good
 * stories also make good people", "Nurses like you also make miracles
 * happen"), and never after a subject pronoun or "who". Inside a clause, a
 * lead opens one only where what comes before it cannot be its subject: the
 * object of a request the clause opens on ("dedicate it to my mom then fix
 * the typos"), a one-line field's name or publisher, which takes no verb
 * ("Author: Sam Lee also redo the cover"), or — wherever it stands — when the
 * lead's verb plainly edits the book ("… also redo the cover", "You could
 * also make the cover blue"). In the field's own words "then" and "plus" also
 * open one: a clause they open there is never the editor's unless it names
 * the book (see {@link Address}), so splitting off "then make sauce" costs a
 * refusal nothing.
 */
function leadOpensClause(sentence: string, start: number, at: number, end: number, place: SentencePlace): boolean {
  const from = Math.max(start, at - TAIL_SPAN);
  const { tail, whole } = tailBefore(sentence.slice(from, at), from === start);
  if (whole && AT_CLAUSE_START.test(tail)) return true;
  // The pronoun just before is the tail's last few words; the window cuts no word that could be one.
  if (SUBJECT_JUST_BEFORE.test(tail.slice(-24))) return false;
  if (place.oneLine) return true;
  const opened = ENGLISH_REQUEST.exec(sentence.slice(at, Math.min(end, at + TAIL_SPAN)));
  const verb = opened?.groups?.verb?.toLowerCase() ?? "";
  const object = opened?.groups?.rest ?? "";
  if (EDITOR_ONLY_VERBS.has(verb) && aimedAtTheBook(verb, object)) return true;
  if (YOU_ASKED.test(tail)) return aimedAtTheBook(verb, object);
  if (place.given) return /^(?:then|plus)\b/iu.test(sentence.slice(at, at + 5));
  // Read only when the window holds the clause's start: a cut tail opens no request.
  const request = whole ? ENGLISH_REQUEST.exec(tail) : null;
  if (request === null || SUBORDINATE.test(request.groups?.rest ?? "")) return false;
  // "… and my kids also draw" goes on from a new subject; "… and dad then fix the typos" is a request run on.
  return !(/^also\b/iu.test(sentence.slice(at, at + 5)) && NEW_SUBJECT.test(request.groups?.rest ?? ""));
}

/** "and" or "but" inside a request, after which "also" goes on from a subject of its own. */
const NEW_SUBJECT = /(?<![\p{L}\p{N}])(?:and|but)(?![\p{L}\p{N}])/iu;

/**
 * What a comma closing an aside leaves out ("Good bugs, like good plots, also
 * keep me up at night", "who, like all good teachers, also make me think"), an
 * appositive among them ("my kids, Ava and Leo, also draw", "my parents, both
 * teachers, also …"): the lead goes on from where the aside opened.
 */
const ASIDE =
  /^(?:a|an|the|my|our|your|his|her|their|two|three|four|all|like|unlike|such\s+as|as|including|especially|more\s+than|less\s+than|along\s+with|together\s+with|not\s+(?:just|only)|both|now|still|too|however|though|of\s+course|in\s+(?:turn|fact)|for\s+(?:example|instance)|after\s+all|by\s+the\s+way|i\s+(?:think|hope|guess)|it\s+(?:seems|turns\s+out)|(?:he|she|they|we|you)\s+(?:say|says|said|know))(?![\p{L}\p{N}])/iu;

/** Names alone between two commas, an appositive: "Ava and Leo", "Rosa". */
const NAMES_ONLY = /^\p{Lu}[\p{Ll}\p{M}'’-]*(?:\s+(?:(?:and|&)\s+)?\p{Lu}[\p{Ll}\p{M}'’-]*){0,3}$/u;

/**
 * The words a lead follows since the last mark that can end a clause, read
 * back from the lead over at most two asides; `whole` when they run back to a
 * mark or to the clause's start, so they can be read as a clause's opening.
 */
function tailBefore(window: string, clauseStart: boolean): { tail: string; whole: boolean } {
  let cut = window;
  for (let asides = 0; ; asides += 1) {
    const mark = Math.max(...TAIL_MARKS.map((one) => cut.lastIndexOf(one)));
    const tail = cut.slice(mark + 1).trim();
    if (tail === "" && mark >= 0 && cut[mark] === "," && asides < 2) {
      const open = cut.lastIndexOf(",", mark - 1);
      const aside = cut.slice(open + 1, mark).trim();
      if (open >= 0 && (ASIDE.test(aside) || NAMES_ONLY.test(aside))) {
        cut = cut.slice(0, open);
        continue;
      }
    }
    return { tail, whole: mark >= 0 || clauseStart };
  }
}

/** A clause of a sentence, and whether it starts inside the sentence rather than at its start. */
type Clause = { text: string; joined: boolean };

/** A sentence's clauses, split at {@link CLAUSE_BREAK} except before a lead that opens none. */
function clausesOf(sentence: string, place: SentencePlace): Clause[] {
  const breaks = [
    ...[...sentence.matchAll(CLAUSE_BREAK)].map((match) => ({
      index: match.index, end: match.index + match[0].length, lead: match.groups?.lead !== undefined
    })),
    ...(place.given ? localizedBookEditBreaks(sentence, true) : localizedBookMatterBreaks(sentence))
      .map((boundary) => ({ ...boundary, lead: false }))
  ].sort((a, b) => a.index - b.index || b.end - a.end);
  // A clause is joined when a word of the sentence comes before it: found once, not once per clause.
  const firstWord = sentence.search(/[\p{L}\p{N}]/u);
  const joined = (start: number) => firstWord >= 0 && firstWord < start;
  const clauses: Clause[] = [];
  let start = 0;
  breaks.forEach((match, at) => {
    if (match.index < start) return;
    const end = breaks[at + 1]?.index ?? sentence.length;
    if (match.lead && !leadOpensClause(sentence, start, match.index, end, place)) return;
    clauses.push({ text: sentence.slice(start, match.index), joined: joined(start) });
    start = match.end;
  });
  clauses.push({ text: sentence.slice(start), joined: joined(start) });
  return clauses;
}

const ENGLISH_REQUEST = new RegExp(
  String.raw`^(?<lead>(?:(?:and|then|also|plus|but|oh|ok|okay|now|please|lastly|finally)\b[\s,]*)*)` +
    String.raw`(?<asking>(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:also\s+)?|i\s+(?:also\s+)?(?:want|need|would\s+(?:also\s+)?like)\s+(?:you\s+)?to\s+|i['’]?d\s+(?:also\s+)?like\s+(?:you\s+)?to\s+)?` +
    String.raw`(?<verb>${EDIT_VERBS})\b(?<rest>.*)$`,
  "isu"
);

/** An object that points back at what was just asked ("make it rhyme", "keep the rest"). */
const POINTS_BACK = /^\s*(?:it|its|that|this|them|those|these|everything\s+else|the\s+rest|as\s+is|the\s+same)\b/i;

/**
 * How plainly a request is spoken to the editor rather than written for the
 * page. `editor`: it edits another part of the book ({@link aimedAtTheBook}),
 * or leads with "also / plus / lastly / finally" at the start of a sentence of
 * the field's own words, or with any lead — "then", "please" and "can you"
 * too — outside them. `unclear`: a lead a dedication's or a biography's own
 * line has as often — "then", "please" or "can you" among the field's own
 * words ("Read everything, then write your own", "Please keep drawing.",
 * "Will you keep dreaming for me?"), a lead inside one of their sentences
 * ("My kids draw and also make comics"), any lead before words spoken to
 * "you", or one that goes on from the reader's own "I …" ("I teach yoga and
 * also write songs"): the printed value decides. `none`: no lead. A bare
 * content noun never makes a request the editor's: "Keep drawing" and "Draw
 * pictures every day" are a dedication's own lines; "Also redo the cover"
 * never is. "I want to…" is the reader's own wish and no lead; "I want you
 * to…" is one.
 */
type Address = "editor" | "unclear" | "none";
const LEAD_WORD = /\b(?:also|plus|then|lastly|finally|please|you)\b/i;
const PLAIN_LEAD_IN_GIVEN = /\b(?:also|plus|lastly|finally)\b/i;
const TO_READER = /\b(?:you|your|yours|yourself|yourselves)\b/i;

function addressOf(lead: string, asking: string, rest: string, place: Place): Address {
  const words = /^i\b/i.test(asking) && !/\byou\b/i.test(asking) ? lead : `${lead} ${asking}`;
  if (!LEAD_WORD.test(words)) return "none";
  const plain = !place.given || (!place.joined && PLAIN_LEAD_IN_GIVEN.test(words));
  return plain && !place.continuesI && !TO_READER.test(rest) ? "editor" : "unclear";
}

const BOOK_REFERENCE = new RegExp(
  [
    String.raw`\b(?:the|its|this|front|back)\s+cover\b`,
    String.raw`\bbook['’]?s?\s+cover\b`,
    String.raw`\bcover\s+(?:art|image|picture|page|design|illustration)\b`,
    String.raw`\b(?:pages?|chapters?)\s+[\d٠-٩۰-۹]`,
    String.raw`\b(?:the|its|book['’]?s?)\s+(?:sub)?title\b`,
    String.raw`\b(?:the|this|my)\s+book['’]s\s+\p{L}`,
    String.raw`\b(?:the|its)\s+(?:illustrations?|font|typeface|layout)\b`,
    String.raw`\b(?:pictures?|images?|illustrations?|drawings?|artwork|art|photos?)\s+(?:in|of|on|for|throughout)\s+(?:the|this|my|every|each)\s+(?:book|story|pages?|chapters?)\b`
  ].join("|"),
  "iu"
);
/** The book in the dedicatee's hands: "this book", "this cover", "every page". */
const HELD_BOOK = /\b(?:this|every|each)\s+(?:book|story|cover|pages?|chapters?)\b/iu;

/**
 * Whether a request edits another part of the book: its object names one
 * definitely (the cover, the title, a numbered page or chapter, the pictures
 * in the book) and its verb is aimed at the book — one that only edits
 * ("redo the cover", "change the pictures in this book"), or another edit verb
 * whose sentence is spoken neither to "you" nor about the book in the
 * dedicatee's hands ("Make the title bigger", "Draw the pictures in the book
 * again"). "Keep the pictures in this book close to your heart", "Make the
 * pictures in this book come alive" and "Write your names on the cover" are a
 * dedication's own lines.
 */
function aimedAtTheBook(verb: string, object: string): boolean {
  const said = verb.toLowerCase();
  if (NEVER_AIMED_AT_THE_BOOK.has(said) || !BOOK_REFERENCE.test(object)) return false;
  return EDITOR_ONLY_VERBS.has(said) || !(TO_READER.test(object) || HELD_BOOK.test(object));
}

/** A Persian imperative ("… را عوض کن"), which ends its clause. */
const PERSIAN_REQUEST = new RegExp(
  arabicScriptFold(
    String.raw`(?:^|\s)(?:کن|کنید|بکن|بکنید|بده|بدهید|بدید|بنویس|بنویسید|بکش|بکشید|بردار|بردارید|بذار|بذارید|بگذار|بگذارید|بساز|بسازید)(?=$|[\s.!?؟،])`
  ),
  "u"
);

/** The Persian of the same test: "also / then" opening the clause, "… را هم", the cover, a numbered page or chapter. */
const PERSIAN_ADDRESSED = new RegExp(
  arabicScriptFold(String.raw`^(?:همچنین|ضمنا|سپس|بعدش)\s|(?:را|رو)\s*هم(?:\s|$)|جلد|(?:صفحه|فصل)\s*(?:ی\s*)?[\d٠-٩۰-۹]`),
  "u"
);

/**
 * Words given to be printed — quoted — which are content, not requests. No
 * span contains its own opening mark, so an unclosed one ends at the next and
 * the scan stays linear.
 */
const QUOTED_SPANS = /"[^"\n]*"|“[^“”\n]*”|«[^«»\n]*»|„[^„“”\n]*[“”]|「[^「」]*」|『[^『』]*』/g;

/** The most of a message the left-over check reads: two of the chat's 5,000-character messages, merged. */
const REQUEST_SCAN_LIMIT = 10_000;

/**
 * The full stop after an initial or a title inside a name ("S. J. Lee", "Dr.
 * Ruiz"), which ends no sentence: the left-over check reads it as a one-dot
 * leader, so "use S. J. Lee there" is one request and not "use S" and two
 * fragments. Never "I.", which ends a sentence as often as it starts one, and
 * never before a request's own first word ("… my son J. Make page 2 shorter").
 */
const OPENS_REQUEST = [...EDIT_VERBS.split("|"), "also", "then", "plus", "please", "can", "could", "would", "will", "and", "but"]
  .map((word) => `[${word[0]!.toUpperCase()}${word[0]}]${word.slice(1)}`)
  .join("|");
const INITIAL_PERIOD = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(\p{Lu}|Dr|Mrs?|Ms|Mx|Prof|St|Jr|Sr)\.(?=[^\S\n]+(?!(?:${OPENS_REQUEST})(?![\p{L}\p{N}]))\p{Lu})`,
  "gu"
);

/** Where a clause, and so a colon's clause, starts. */
const CLAUSE_END = /[.!?؟。！？।॥۔\n]/u;

/** A verb that introduces the words a field should print: "update my bio to say …", "the dedication should read …". */
const SAY_MARKER = /\b(?:to\s+)?(?:say|says|saying|read|reads|reading)\b/iu;

/**
 * A field's name and the "to" its new words follow, unquoted and with no
 * colon: "change the dedication to For my students. …", "Change my bio to I'm
 * a nurse …", "set the publisher to Lantern". Not "dedicate it to my mom",
 * whose "to" names who the book is for — a field is named here by its noun.
 */
const FIELD_TO = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:dedication|bio|biography|about\s+(?:the\s+)?author(?:\s+(?:page|section|text|bio|blurb|part))?|about\s+me|` +
    String.raw`author(?:['’]s)?\s+(?:name|bio|biography|page|blurb|info|note|profile)|pen\s+name|by-?line|(?:co-?)?author|writer|` +
    String.raw`website|web\s*site|web\s*page|web\s+address|site|url|homepage|publisher|imprint|` +
    String.raw`copyright(?:\s+(?:holder|owner|line|notice|name))?|rights\s+holder|owner|isbn)\s+to(?![\p{L}\p{N}])`,
  "iu"
);

/** The fields printed on one line, whose value is a name or a number that takes no verb. */
const ONE_LINE_FIELDS: ReadonlySet<BookMatterChatField> = new Set(["authorName", "authorWebsite", "copyrightHolder", "imprint", "isbn"]);

/** Whether some words name a field. Every cue but "©" is spelled in letters or digits. */
function namesSomeField(words: string): boolean {
  return /[\p{L}\p{N}©]/u.test(words) && bookMatterFieldsNamedIn(words).size > 0;
}

/**
 * The field's own words, and what introduced them: a field-naming colon, a
 * "say / read" after a field's name, or a field's name and "to". After "to"
 * a clause no lead addresses is still named back when the change did not
 * print it ("change the dedication to my mom and fix the typos"); after the
 * other two it is the field's own line. `oneLine`: every field named is
 * printed on one line, so the words' first sentence is a value that takes no
 * verb.
 */
type GivenWords = { text: string; by: "colon" | "say" | "to"; oneLine: boolean };

function givenWords(text: string, by: GivenWords["by"], naming: string): GivenWords {
  const fields = [...bookMatterFieldsNamedIn(naming)];
  return { text, by, oneLine: fields.length > 0 && fields.every((field) => ONE_LINE_FIELDS.has(field)) };
}

/**
 * The message as the left-over check reads it, quoted spans taken out, in two
 * parts: what the reader asked, and — after the first colon whose clause names
 * a field ("add a dedication: For my mom", "Bio:\nI'm a nurse"), the first
 * "say / read" after a field's name ("update my bio to say I …"), or the
 * first field's name followed by "to" ("Change the dedication to For my
 * students. …") — the field's own words as they wrote them, every sentence
 * and line of them, where only a request plainly spoken to the editor is one
 * ("… For my mom. Also redo the cover."). One pass that reads each clause
 * once: a message may be thousands of colons long.
 */
function requestParts(message: string): { asked: string; given: GivenWords | null } {
  const text = protectLocalizedOrdinalPeriods(arabicScriptFold(message.slice(0, REQUEST_SCAN_LIMIT).normalize("NFKC"))
    .replace(QUOTED_SPANS, " ")
    .replace(INITIAL_PERIOD, (whole, word: string) => (word === "I" ? whole : `${word}\u2024`)));
  let clauseStart = 0;
  for (let at = 0; at <= text.length; at += 1) {
    const char = text[at];
    if (char !== undefined && char !== ":" && !CLAUSE_END.test(char)) continue;
    const clause = text.slice(clauseStart, at);
    const said = SAY_MARKER.exec(clause);
    const saidAt = said && namesSomeField(clause.slice(0, said.index)) ? said.index : Number.POSITIVE_INFINITY;
    const to = FIELD_TO.exec(clause);
    const toEnd = to ? to.index + to[0].length : 0;
    // "to" followed only by the colon is the colon's ("Change the dedication to: For Mom"), and "to say" the say's.
    const toAt = to && toEnd <= saidAt && /[\p{L}\p{N}]/u.test(clause.slice(toEnd)) && namesSomeField(clause.slice(0, toEnd)) ? to.index : Number.POSITIVE_INFINITY;
    if (saidAt < toAt) {
      const naming = clause.slice(0, saidAt);
      return { asked: text.slice(0, clauseStart + saidAt), given: givenWords(text.slice(clauseStart + saidAt), "say", naming) };
    }
    if (toAt < Number.POSITIVE_INFINITY) {
      return { asked: text.slice(0, clauseStart + toEnd), given: givenWords(text.slice(clauseStart + toEnd), "to", clause.slice(0, toEnd)) };
    }
    // Read with its colon, which is all "Author:" and "نویسنده:" name a field by.
    if (char === ":" && namesSomeField(`${clause}:`)) return { asked: text.slice(0, at), given: givenWords(text.slice(at + 1), "colon", `${clause}:`) };
    clauseStart = at + 1;
  }
  return { asked: text, given: null };
}

/** The matter page a clause can name without naming a field: the title page. */
const TITLE_PAGE = new RegExp(String.raw`\btitle\s+page\b|${arabicScriptFold(String.raw`صفحه\s*(?:ی\s*)?عنوان`)}`, "iu");

/**
 * What a message asks for, clause by clause: whether any clause asks for the
 * matter, and the clauses that ask for an edit of another kind. Model-free and
 * conservative: such a clause starts with an edit verb (or, in Persian,
 * carries an imperative), names no matter field and does not point back at
 * the request before it. Among the field's own words after a colon or "say",
 * and where it goes on from the reader's own "I …" in the same sentence ("I
 * teach yoga, write my own songs and keep bees"), one with no lead
 * ({@link Address}) is content and not kept.
 */
type OtherRequest = { clause: string; verb: string; object: string; address: Address; booked: boolean };
export type MessageRequests = { matter: boolean; others: readonly OtherRequest[]; words: ReadonlyMap<string, number> };
type Place = { given: boolean; continuesI: boolean; joined: boolean };

const SENTENCE_BREAK = /[.!?؟。！？।॥۔\n:：]+/u;
const FIRST_PERSON = /^(?:i|we)(?:['’](?:m|ve|d|ll|re))?\b/iu;

export function readRequests(message: string): MessageRequests {
  const parts = requestParts(message);
  // A field named before its colon, "say" or "to" asks for the matter, though the clause split off it may not name one.
  let matter = parts.given !== null;
  const others: OtherRequest[] = [];
  const sections: ReadonlyArray<readonly [string, GivenWords | null]> = [[parts.asked, null], [parts.given?.text ?? "", parts.given]];
  for (const [text, given] of sections) {
    let value = given?.oneLine === true;
    for (const sentence of text.split(SENTENCE_BREAK)) {
      if (!/[\p{L}\p{N}]/u.test(sentence)) continue;
      // A one-line field's value is the given words' first sentence; past it they are read as the reader's own.
      const inGiven = given !== null && !value;
      value = false;
      let continuesI = false;
      for (const { text: raw, joined } of clausesOf(sentence, { given: inGiven, oneLine: given !== null && !inGiven })) {
        // Split, the initials read as full stops again (NFKC left no one-dot leader of the reader's own).
        const clause = raw.trim().replace(/\u2024/g, ".");
        if (!/[\p{L}\p{N}]/u.test(clause)) continue;
        if (bookMatterFieldsNamedIn(clause).size > 0 || TITLE_PAGE.test(clause)) {
          matter = true;
          continuesI = endsInI(clause);
          continue;
        }
        const request = otherRequest(clause, { given: inGiven, continuesI, joined });
        if (!request) {
          continuesI = !ENGLISH_REQUEST.test(clause) && (FIRST_PERSON.test(clause) || endsInI(clause));
        } else if (request.address !== "none" || !(inGiven || continuesI) || (given?.by === "to" && !continuesI)) {
          others.push(request);
        }
      }
    }
  }
  const words = new Map<string, number>();
  for (const word of kinWordsIn(message.slice(0, REQUEST_SCAN_LIMIT))) words.set(word, (words.get(word) ?? 0) + 1);
  return { matter, others, words };
}

/** Whether a clause's last comma-separated part is the reader's own "I …" ("write my bio, I teach yoga in Austin"). */
function endsInI(clause: string): boolean {
  const last = clause.slice(Math.max(clause.lastIndexOf(","), clause.lastIndexOf(";"), clause.lastIndexOf("،")) + 1).trim();
  return FIRST_PERSON.test(last) && !ENGLISH_REQUEST.test(last);
}

function otherRequest(clause: string, place: Place): OtherRequest | null {
  // "Change aussi la couverture" shares its verb with English, but its
  // translated object is what proves the request is aimed at the book.
  if (isLocalizedBookEditRequest(clause, place.given)) {
    return { clause, verb: "", object: clause, booked: true, address: "editor" };
  }
  const english = ENGLISH_REQUEST.exec(clause);
  if (english) {
    const { lead = "", asking = "", verb = "", rest = "" } = english.groups ?? {};
    if (POINTS_BACK.test(rest)) return null;
    const booked = aimedAtTheBook(verb, rest);
    return { clause, verb, object: rest, booked, address: booked ? "editor" : addressOf(lead, asking, rest, place) };
  }
  if (!PERSIAN_REQUEST.test(clause)) return null;
  // Persian keeps its one test: "also / then" opening it, "… را هم", the cover, a numbered page or chapter.
  const booked = PERSIAN_ADDRESSED.test(clause);
  return { clause, verb: "", object: clause, booked, address: booked ? "editor" : "none" };
}

/**
 * Whether a message carries an edit request of another kind beside its matter
 * request — the model-free half of the left-over check, for a reply made
 * without the composer ("remove the title page and redo the cover").
 */
export function bookMatterMessageHasSeparateRequest(message: string): boolean {
  return separateRequestIn(readRequests(message), []);
}

/**
 * Whether the message is compound — a matter request beside an edit request
 * of another kind ("dedicate it to my mom and redo the cover", "… . Also, make
 * page 2 shorter"). One that edits another part of the book always is. One
 * that only refines the change is not: an instruction about how the field is
 * written (`instructsTheChange`: "use third person", "keep my age out of
 * it", "use her name, Rosa"), or one whose object the change printed ("Also
 * add my dad" beside "For my mom and dad"). Past those, a request plainly
 * spoken to the editor is one; any other is content the reader gave when the
 * change printed it — as a biography retells it: "I garden and make quilts"
 * is printed as "She gardens and makes quilts", so the comparison reads
 * inflections and pronouns loosely.
 */
export function separateRequestIn(requests: MessageRequests, printed: readonly string[]): boolean {
  if (!requests.matter) return false;
  const texts = printed.map(looseQuotable);
  const printedWords = new Set(printed.flatMap(kinWordsIn));
  return requests.others.some((request) => {
    if (request.booked) return true;
    const asks = `${request.verb}${request.object}`;
    if (instructsTheChange(asks) || printedObject(request, printedWords, requests.words)) return false;
    if (request.address === "editor") return true;
    const quotes = [request.clause, asks].flatMap((quote) => {
      const lead = quote.split(SEGMENT_END, 1)[0]!;
      return wordsIn(lead).length >= 2 ? [quote, lead] : [quote];
    });
    return !texts.some((text) => quotes.some((quote) => looselyQuotedFrom(quote, text)));
  });
}

/**
 * Where a request's own verb phrase ends inside its clause: "fix old boats,
 * and I have two cats" asked to fix old boats, and the rest is more of the
 * reader's facts.
 */
const SEGMENT_END = /[,;،]|\s(?:and|but|or|so|while|because|who|which|where)\s/iu;

/**
 * Whether the change printed what a request asks for — "Also add my dad"
 * beside "For my mom and dad": every word of its object is in the printed
 * text, and one of them is in this request alone, so the change took it from
 * here ("Bio: I love dogs. Also add a dog." took "dog" from the bio, and may
 * still owe a picture). Never a refusal's test; a value that pastes the whole
 * request is {@link runsOnIntoRequest}'s.
 */
function printedObject(request: OtherRequest, printed: ReadonlySet<string>, inMessage: ReadonlyMap<string, number>): boolean {
  const words = contentWordsIn(request.object);
  if (words.length === 0 || !words.every((word) => printed.has(word))) return false;
  const inClause = new Map<string, number>();
  for (const word of kinWordsIn(request.clause)) inClause.set(word, (inClause.get(word) ?? 0) + 1);
  return words.some((word) => (inMessage.get(word) ?? 0) <= (inClause.get(word) ?? 0));
}

/**
 * Whether a printed value runs on into a request spoken to the editor —
 * "Add a dedication: For my mom. Also redo the cover." printed whole. Every
 * word of it is the reader's, but not as words to print. Only a request whose
 * {@link Address} is `editor` counts: "Please keep drawing." after a
 * dedication's colon is the dedication's own line.
 */
export function runsOnIntoRequest(value: string, requests: MessageRequests): boolean {
  const text = quotable(value);
  return requests.others.some(({ clause, address }) => address === "editor" && quotedFrom(clause, text));
}
