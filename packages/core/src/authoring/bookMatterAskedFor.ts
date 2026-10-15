import type { BookMatterChatAnswer, BookMatterChatCurrent, BookMatterChatField } from "./bookMatterChatEdit.js";
import {
  arabicScriptFold,
  askedWordsIn,
  bookMatterFieldsNamedIn,
  contentWordsIn,
  fold,
  looseWordsIn,
  numbersTypedIn,
  printedIn,
  printsPhrase,
  quotable,
  quotedFrom,
  UNSPACED_SCRIPT,
  wordsBesides,
  wordsIn,
  type Printed,
  type Quotable
} from "./bookMatterWords.js";

/**
 * Which of the composer's changes the reader asked for.
 *
 * The gate exists for one failure: a Persian dedication request came back with
 * "All rights reserved" switched on and the biography deleted — fields nobody
 * asked for, riding along with the one somebody did. It used to keep a change
 * only when its quoted words named its field by a cue, and so it also dropped
 * every follow-up that says "it" ("Mention my sister in it too" after a
 * dedication: 0 of 12) and about one byline in three ("Sam Lee wrote this
 * book", "Escrito por …"). A check that drops the reader's words has to be
 * right ~99% of the time, so it now blocks that failure and nothing else:
 *
 * - A change whose own quote names its field (the cues in
 *   `bookMatterWords.ts`) was asked for, and so was a field the request a
 *   question was about names, with the same content-ownership checks. A quote
 *   also names a field by the value the book
 *   prints in it now — "Remove Lantern Press", "take Ruiz Media off", "Remove
 *   'For Mom'", "Replace Ana Ruiz with Sam Lee" — when it names no other field,
 *   or when it spells a rename out, the new name beside the old ("Change Ana
 *   Ruiz to Ana Park, my publisher prefers it"). Not when another change owns
 *   that value: one whose request the quote is part of (or holds) and which
 *   prints the value, or is the dedication or biography those words write
 *   ("Write my bio: I was an editor at Lantern Press" removes no imprint).
 * - A follow-up points back: a field the chat's last matter reply changed or
 *   asked about is asked for by words of the message that name no field —
 *   "make it shorter", "remove it" — never by words that name another one
 *   ("Dedicate it to my dad" does not touch the biography the reply before
 *   rewrote), nor by words another change quotes as its own request.
 * - A change that is the answer's only one is asked for when the message names
 *   no *other* field: the router already sent the message here, and the reply
 *   names the field it changed, so a wrong pick is visible and one message from
 *   undone. Not a removal of a field the message, the question or the last
 *   reply never named, and never "All rights reserved", which is set only when
 *   asked for in words.
 *
 * Words a change prints are its content, whatever field's cue they spell: "add
 * that I'm also a small business owner" after a biography names no © holder,
 * and "add 'who always asked about me'" after a dedication names no About the
 * Author — the same cue words that named a second field dropped 39 of 40 such
 * biography facts and 30 of 30 dedication lines. So "names another field" is
 * read with the change's own printed words taken out, and a quote that is a
 * fragment of another change's request and printed by it ("owner", "my
 * publisher, Lantern Press") is that change's content, not a request of its
 * own — nor is a removal quoting words another change quotes and prints
 * whole ("add that Ana Ruiz also keeps bees" deletes no byline). A removal,
 * which prints nothing, also takes no cue from words another change of the
 * same request newly prints: "add that I'm also a copyright lawyer", quoted
 * whole beside the biography that says so, removes no © holder (and so claims
 * none of the biography's words).
 *
 * Anything else — a second field beside the one asked for, which nothing in the
 * message or the last reply asks for — is dropped.
 */

type Change = BookMatterChatAnswer["changes"][number];

export type BookMatterAskContext = {
  message: string;
  current: BookMatterChatCurrent;
  /** On the turn that answers the request's one question, the request it was asked about. */
  originalRequest?: string | undefined;
  /** The fields the chat's last matter reply changed or asked about. */
  lastTurnFields?: readonly BookMatterChatField[] | undefined;
};

/** A change as the gate reads it: what it prints, and its quote when that is the reader's words. */
type ReadChange = {
  change: Change;
  printed: Printed | undefined;
  quote: Quote | undefined;
};

/** Words the reader wrote, as the gate reads them: as typed, as compared, and the fields their cues name. */
type Quote = { words: string; text: Quotable; names: ReadonlySet<BookMatterChatField> };

/** The changes the reader asked for, the first asked-for change of each field, in the composer's order. */
export function changesAskedFor(changes: readonly Change[], context: BookMatterAskContext): Change[] {
  const inMessage = bookMatterFieldsNamedIn(context.message);
  const inRequest = context.originalRequest ? bookMatterFieldsNamedIn(context.originalRequest) : new Set<BookMatterChatField>();
  const lastTurn = new Set(context.lastTurnFields ?? []);
  const named = (field: BookMatterChatField) => inMessage.has(field) || inRequest.has(field) || lastTurn.has(field);
  // A removal whose quote is not the reader's words still names its field when the message spells its value.
  let whole: Quote | undefined;
  const messageQuote = (): Quote => (whole ??= { words: context.message, text: quotable(context.message), names: inMessage });

  const read = changes.map((change) => readChange(change, context.message));
  const fromRequest = context.originalRequest
    ? changesNamedInRequest(read, { words: context.originalRequest, text: quotable(context.originalRequest), names: inRequest }, context.current)
    : new Set<Change>();
  const content = read.map((one) => contentOfAnother(one, read));
  // A rider that only repeats another change's content is not a second field beside it.
  const fields = new Set(read.filter((_, at) => !content[at]).map(({ change }) => change.field));
  const only = fields.size === 1 ? [...fields][0] : undefined;
  const cueNamed = new Map(read.map((one) => [one, namedByCue(one, read, context.current)] as const));

  const asked: Change[] = [];
  const kept = new Set<BookMatterChatField>();
  read.forEach((one, at) => {
    const { change, printed, quote } = one;
    const { field } = change;
    if (kept.has(field)) return;
    const namesOnlyThis = (names: Iterable<BookMatterChatField>) => [...names].every((other) => other === field);
    const ownQuote = content[at] ? undefined : quote;
    const byWords =
      fromRequest.has(change) ||
      (ownQuote !== undefined && (cueNamed.get(one)!.has(field) || namesByValue(one, ownQuote, read, context.current))) ||
      (ownQuote !== undefined &&
        lastTurn.has(field) &&
        !claimedByAnother(one, read, cueNamed) &&
        namesOnlyThis(namedBeyond(ownQuote.words, ownQuote.names, printed?.words)));
    const alone =
      field === only &&
      !content[at] &&
      field !== "allRightsReserved" &&
      namesOnlyThis([...namedBeyond(context.message, inMessage, printed?.words), ...inRequest]) &&
      (change.action === "set" || named(field) || namesByValue(one, messageQuote(), read, context.current));
    if (byWords || alone) {
      asked.push(change);
      kept.add(field);
    }
  });
  return rightsBeyondSuppliedText(read, asked, context, inRequest);
}

/**
 * A terse clarification answer inherits the original request's field, after
 * reading its cues and values with the same ownership rules as today's quote.
 * Keep field-naming quotes at their original scope: newly supplied follow-up
 * prose must not consume cues from the original request. Terse answers ("Yes",
 * "Lantern") instead point back to the whole request, even when it already
 * supplied that answer's words. Otherwise a
 * biography's "I am a publisher" grants an unrelated imprint removal merely
 * because the composer asked a question before applying it.
 */
function changesNamedInRequest(read: readonly ReadChange[], request: Quote, current: BookMatterChatCurrent): ReadonlySet<Change> {
  const scoped = read.map((one) => ({
    ...one,
    quote: one.quote !== undefined && one.quote.names.size > 0 ? one.quote : request
  }));
  return new Set(scoped.filter((one) => {
    const fromRequest = quotedFrom(one.quote.words, request.text) ? one : { ...one, quote: request };
    return !contentOfAnother(fromRequest, scoped) &&
      (namedByCue(fromRequest, scoped, current).has(one.change.field) || namesByValue(fromRequest, fromRequest.quote, scoped, current));
  }).map(({ change }) => change));
}

/**
 * A supplied name such as "All Rights Press" is no request for the rights
 * line. Recheck that one field after the other changes are known to be asked
 * for: an unasked rider must not consume a real rights request by printing it.
 * Read the whole message so a narrow "add rights reserved" quote does not
 * lose its cue to the same words inside a publisher named elsewhere in it.
 */
function rightsBeyondSuppliedText(
  read: readonly ReadChange[],
  asked: readonly Change[],
  context: BookMatterAskContext,
  inRequest: ReadonlySet<BookMatterChatField>
): Change[] {
  const supplied = asked
    .filter((change) => change.field !== "allRightsReserved" && change.action === "set" && change.text)
    .filter((change) => bookMatterFieldsNamedIn(change.text!).has("allRightsReserved"));
  if (supplied.length === 0) return [...asked];
  const namesRights = (words: string) => bookMatterFieldsNamedIn(withoutSuppliedPhrases(words, supplied)).has("allRightsReserved");
  const fromRequest = inRequest.has("allRightsReserved") && namesRights(context.originalRequest ?? "");
  const fromMessage = namesRights(context.message);
  let keptRights = false;
  return read.filter(({ change, quote }) => {
    if (change.field !== "allRightsReserved") return asked.includes(change);
    if (keptRights) return false;
    const quoteNamesRights = quote?.names.has("allRightsReserved") ?? false;
    // Pronoun follow-ups still point to the last rights change. A quote whose
    // only rights cue was supplied content cannot acquire that permission.
    const followUp = asked.includes(change) && !inRequest.has("allRightsReserved") && !quoteNamesRights;
    keptRights = fromRequest || (quoteNamesRights && fromMessage) || followUp;
    return keptRights;
  }).map(({ change }) => change);
}

/**
 * Take supplied phrases out as units: separate words could erase "rights
 * reserved" from an independent request beside "All Rights Reserved Press".
 * A value supplied to two fields in one clause is still one occurrence; when
 * named in separate clauses, each field-cued occurrence is supplied content.
 */
function withoutSuppliedPhrases(words: string, supplied: readonly Change[]): string {
  let left = quotable(words).spaced;
  const phrases = new Map<string, Set<BookMatterChatField>>();
  for (const { field, text } of supplied) {
    const spaced = quotable(text!).spaced;
    const phrase = UNSPACED_SCRIPT.test(text!) ? spaced.trim() : spaced;
    const fields = phrases.get(phrase) ?? new Set();
    fields.add(field);
    phrases.set(phrase, fields);
  }
  for (const [phrase, fields] of [...phrases].sort(([one], [other]) => other.length - one.length)) {
    const places: number[] = [];
    const named: number[] = [];
    let from = 0;
    for (let at = left.indexOf(phrase); at >= 0; at = left.indexOf(phrase, from)) {
      places.push(at);
      if ([...bookMatterFieldsNamedIn(left.slice(from, at))].some((field) => fields.has(field))) named.push(at);
      from = at + phrase.length;
    }
    // A clarification can supply just the value, without repeating its field.
    for (const at of (named.length > 0 ? named : places.slice(0, 1)).reverse()) {
      left = `${left.slice(0, at)} \u0000 ${left.slice(at + phrase.length)}`;
    }
  }
  return left;
}

function readChange(change: Change, message: string): ReadChange {
  const text = change.action === "set" && change.text ? change.text : undefined;
  const words = change.requestedBy?.trim();
  return {
    change,
    printed: text === undefined ? undefined : printedIn(text),
    quote: words && quotedFrom(words, message) ? { words, text: quotable(words), names: bookMatterFieldsNamedIn(words) } : undefined
  };
}

/**
 * The fields words name once some words — a change's printed words, the value
 * it names — are taken out of them, and never one they did not name before:
 * "add that I'm also a proud dog owner" names no © holder once the biography
 * prints "proud dog owner".
 */
function namedBeyond(words: string, names: ReadonlySet<BookMatterChatField>, taken: ReadonlySet<string> | undefined): ReadonlySet<BookMatterChatField> {
  if (taken === undefined || taken.size === 0 || names.size === 0) return names;
  const left = bookMatterFieldsNamedIn(wordsBesides(words, taken));
  return new Set([...names].filter((field) => left.has(field)));
}

/**
 * Whether a change's quote is another change's content: a fragment of that
 * change's quote that it prints as a phrase ("owner" of "add that I'm a proud
 * dog owner", "my publisher, Lantern Press" of a dedication line), or — for a
 * removal quoting words that name no field — words that change quotes and
 * prints every one of ("add that Ana Ruiz also keeps bees"). Words its own
 * change prints all of are its own.
 */
function contentOfAnother({ change, printed, quote }: ReadChange, read: readonly ReadChange[]): boolean {
  if (quote === undefined) return false;
  const asks = askedWordsIn(quote.words);
  if (asks.length === 0 || (printed !== undefined && asks.every((word) => printed.words.has(word)))) return false;
  return read.some((other) => {
    if (other.change.field === change.field || other.printed === undefined || other.quote === undefined) return false;
    if (!quotedFrom(quote.words, other.quote.text)) return false;
    if (quote.names.size > 0) return !quotedFrom(other.quote.words, quote.text) && printsPhrase(other.printed, asks);
    return change.action === "remove" && asks.every((word) => other.printed!.words.has(word));
  });
}

/**
 * The fields a removal's quote names by cue once the words another change of
 * the same request prints are taken out, as many times as it prints them: "add
 * that I'm also a copyright lawyer", quoted whole beside the biography that
 * prints "copyright lawyer", asks to remove no © holder — and a removal claims
 * no words of the request it rode in on — while "remove my website and add to
 * my bio that I build websites" still names the website, once. A change that
 * sets a value keeps every cue it quotes: a rider that prints the request's
 * own words ("For my publisher Lantern" beside "change the publisher to
 * Lantern") takes no cue from it.
 */
function namedByCue({ change, quote }: ReadChange, read: readonly ReadChange[], current: BookMatterChatCurrent): ReadonlySet<BookMatterChatField> {
  if (quote === undefined) return new Set();
  if (change.action !== "remove" || quote.names.size === 0) return quote.names;
  const printed = new Map<string, number>();
  for (const other of read) {
    if (other.change.field === change.field || other.printed === undefined || !overlaps(quote, other.quote)) continue;
    // Only what it prints anew: a biography reprinted with "website" in it already takes no cue from "remove the website".
    const before = current[other.change.field];
    const times = new Map<string, number>();
    for (const word of looseWordsIn(other.change.text ?? "")) times.set(word, (times.get(word) ?? 0) + 1);
    for (const word of typeof before === "string" ? looseWordsIn(before) : []) times.set(word, (times.get(word) ?? 0) - 1);
    const broaderQuote = other.quote !== undefined && quotedFrom(quote.words, other.quote.text) ? other.quote.text : undefined;
    for (const [word, count] of times) {
      // A narrow removal quote cannot lose a cue already printed from outside
      // it: in 把献辞改为出版社并删除出版社, 删除出版社 still asks for removal
      // when the dedication quotes the whole request and prints only 出版社.
      const outside = broaderQuote && UNSPACED_SCRIPT.test(word)
        ? broaderQuote.joined.split(word).length - quote.text.joined.split(word).length
        : 0;
      const remaining = count - Math.max(0, outside);
      if (remaining > 0) printed.set(word, Math.max(remaining, printed.get(word) ?? 0));
    }
  }
  if (printed.size === 0) return quote.names;
  const left = bookMatterFieldsNamedIn(wordsBesidesCounted(quote.words, printed));
  return new Set([...quote.names].filter((field) => left.has(field)));
}

/**
 * Words with the last `count` places each loose word stands taken out, in the
 * form the cues read. An unspaced printed run is a phrase inside a request's
 * run, not a separate word: the dedication in 把献辞改为献给在出版社工作的母亲
 * owns its 出版社 cue, while a separate 删除出版社 still names the imprint.
 */
function wordsBesidesCounted(words: string, counts: ReadonlyMap<string, number>): string {
  const text = arabicScriptFold(words.normalize("NFKC"));
  const runs = [...text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
  const left = new Map(counts);
  // Prefer a whole supplied phrase over a shorter overlapping one. Never
  // subtract its characters individually: they may also spell a real request.
  const unspaced = [...counts.keys()].filter((word) => UNSPACED_SCRIPT.test(word)).sort((a, b) => b.length - a.length);
  const out = new Map<number, string>();
  for (let at = runs.length - 1; at >= 0; at -= 1) {
    const word = looseWordsIn(runs[at]![0]).join(" ");
    const count = left.get(word) ?? 0;
    if (count > 0) {
      out.set(at, " ");
      left.set(word, count - 1);
    } else if (UNSPACED_SCRIPT.test(word)) {
      let remaining = word;
      for (const phrase of unspaced) {
        let times = left.get(phrase) ?? 0;
        while (times > 0) {
          const start = remaining.lastIndexOf(phrase);
          if (start < 0) break;
          remaining = `${remaining.slice(0, start)} ${remaining.slice(start + phrase.length)}`;
          times -= 1;
        }
        left.set(phrase, times);
      }
      if (remaining !== word) out.set(at, remaining);
    }
  }
  let kept = "";
  let from = 0;
  runs.forEach((run, at) => {
    if (!out.has(at)) return;
    kept += text.slice(from, run.index) + out.get(at)!;
    from = run.index! + run[0].length;
  });
  return kept + text.slice(from);
}

/** Whether another change quotes words of this quote as its own request, naming its own field: then they are its words. */
function claimedByAnother(
  { change, quote }: ReadChange,
  read: readonly ReadChange[],
  cueNamed: ReadonlyMap<ReadChange, ReadonlySet<BookMatterChatField>>
): boolean {
  return (
    quote !== undefined &&
    read.some(
      (other) =>
        other.change.field !== change.field &&
        other.quote !== undefined &&
        cueNamed.get(other)!.has(other.change.field) &&
        quotedFrom(other.quote.words, quote.text)
    )
  );
}

/** The one-line fields a reader renames by spelling the new name beside the old: "Change Lantern Press to Moss Books". */
const NAME_FIELDS: ReadonlySet<BookMatterChatField> = new Set(["authorName", "imprint", "copyrightHolder"]);
/** The fields a request writes in the reader's words: a value those words mention belongs to them. */
const COMPOSED_FIELDS: ReadonlySet<BookMatterChatField> = new Set(["dedication", "aboutAuthor"]);
/**
 * A run of a dedication's or a biography's own words that names it without the
 * rest — "take out 'and keeps bees'", "remove 'who taught me to read'" — and
 * how many of them must say something: "for my mom and" says one thing.
 */
const SPAN_WORDS = 3;
const SPAN_CONTENT_WORDS = 2;

/** A value a quote spells: its loose words ({@link looseWordsIn}), and an ISBN's digits. */
type Spelled = { words: readonly string[]; digits?: string };

/**
 * Whether a quote names its change's field by the value the book prints there
 * now: it spells that value — one line whole ("Lantern Press", an ISBN's
 * digits, a website's host), or a dedication or biography whole or by a run of
 * its words — with nothing else claiming it. Another change whose request the
 * quote is part of, or holds, owns the value when it prints it or is the
 * dedication or biography written from those words: "Write my bio: I was an
 * editor at Lantern Press" asks for no imprint removal, nor does "Dedicate the
 * book to Ana Ruiz's mother, Rosa" for a byline one, whether or not the
 * dedication kept the name. Then the quote must name no other field — or, for
 * a one-line name, spell the rename out: the old name and the new one the
 * change sets, which nothing else owns either.
 */
function namesByValue(one: ReadChange, quote: Quote, read: readonly ReadChange[], current: BookMatterChatCurrent): boolean {
  const { field } = one.change;
  const spelled = spelledValue(field, quote.text, current);
  if (spelled === undefined) return false;
  const others = read.filter((other) => other.change.field !== field && overlaps(quote, other.quote));
  if (others.some((other) => owns(other, spelled, (text) => spelledValue(field, text, current) !== undefined))) return false;
  const taken = new Set([...spelled.words, ...(one.printed?.words ?? [])]);
  if ([...namedBeyond(quote.words, quote.names, taken)].every((other) => other === field)) return true;
  return renamedIn(one.change, quote, others, current);
}

/** "Change Ana Ruiz to Ana Park, my publisher prefers it": a one-line name set to a new name the quote spells too. */
function renamedIn(change: Change, quote: Quote, others: readonly ReadChange[], current: BookMatterChatCurrent): boolean {
  if (!NAME_FIELDS.has(change.field) || change.action !== "set" || !change.text) return false;
  const next = change.text;
  const now = current[change.field];
  if (typeof now !== "string" || sameWords(next, now) || contentWordsIn(next).length === 0 || !quotedFrom(next, quote.text)) return false;
  return !others.some((other) => owns(other, { words: looseWordsIn(next) }, (text) => quotedFrom(next, text)));
}

/** Whether another change owns a value: it prints every word of it, or it writes a dedication or biography from words that spell it. */
function owns({ change, printed, quote }: ReadChange, value: Spelled, spelledIn: (text: Quotable) => boolean): boolean {
  if (value.digits !== undefined) {
    if (numbersTypedIn(change.text ?? "").some((run) => run.includes(value.digits!))) return true;
  } else if (printed !== undefined && value.words.every((word) => printed.words.has(word))) {
    return true;
  }
  return change.action === "set" && COMPOSED_FIELDS.has(change.field) && quote !== undefined && spelledIn(quote.text);
}

/** Whether two quotes are one request's words: one holds the other. A change that quoted nothing could be anywhere. */
function overlaps(quote: Quote, other: Quote | undefined): boolean {
  return other === undefined || quotedFrom(quote.words, other.text) || quotedFrom(other.words, quote.text);
}

/**
 * The field's current value as the words spell it, if they do. Never "All
 * rights reserved", a value with nothing in it to name ("For you", "Me"), or a
 * value read inside a longer one another field prints: "Remove Ana Ruiz Books"
 * names the imprint "Ana Ruiz Books", not the byline "Ana Ruiz".
 */
function spelledValue(field: BookMatterChatField, text: Quotable, current: BookMatterChatCurrent): Spelled | undefined {
  const value = field === "allRightsReserved" ? null : current[field];
  if (!value) return undefined;
  if (field === "isbn") {
    const digits = numbersTypedIn(value).join("");
    return digits.length >= 10 && numbersTypedIn(text.spaced).some((run) => run.includes(digits)) ? { words: looseWordsIn(value), digits } : undefined;
  }
  if (field === "authorWebsite") {
    const host = hostOf(value);
    return host && quotedFrom(host, text) ? { words: looseWordsIn(host) } : undefined;
  }
  if (contentWordsIn(value).length === 0) return undefined;
  const words = wordsIn(fold(value));
  const within = withoutLongerValues(text, field, words, current);
  if (quotedFrom(value, within)) return { words: looseWordsIn(value) };
  if (!COMPOSED_FIELDS.has(field) || words.some((word) => UNSPACED_SCRIPT.test(word))) return undefined;
  // Every run of the quote's words that long, read once, so a long biography is looked up, not searched for.
  const quoted = within.spaced.trim().split(" ");
  const spans = new Set(quoted.slice(0, Math.max(0, quoted.length - SPAN_WORDS + 1)).map((_, at) => quoted.slice(at, at + SPAN_WORDS).join(" ")));
  for (let at = 0; at + SPAN_WORDS <= words.length; at += 1) {
    const span = words.slice(at, at + SPAN_WORDS).join(" ");
    if (spans.has(span) && contentWordsIn(span).length >= SPAN_CONTENT_WORDS) return { words: looseWordsIn(span) };
  }
  return undefined;
}

/** Compared words with every place they spell another field's longer value that holds this one cut out. */
function withoutLongerValues(text: Quotable, field: BookMatterChatField, words: readonly string[], current: BookMatterChatCurrent): Quotable {
  const phrase = ` ${words.join(" ")} `;
  let { spaced, joined } = text;
  for (const [other, value] of Object.entries(current)) {
    if (other === field || typeof value !== "string") continue;
    const longer = wordsIn(fold(value));
    if (longer.length <= words.length || !` ${longer.join(" ")} `.includes(phrase)) continue;
    spaced = spaced.split(` ${longer.join(" ")} `).join(" \u0000 ");
    joined = joined.split(longer.join("")).join("\u0000");
  }
  return { spaced, joined };
}

/** A website's host, as compared: no scheme, no "www.", nothing after it. */
function hostOf(address: string): string {
  let site = fold(address).trim();
  if (site.startsWith("https://")) site = site.slice(8);
  else if (site.startsWith("http://")) site = site.slice(7);
  if (site.startsWith("www.")) site = site.slice(4);
  const end = site.search(/[/?#\s]/);
  return end === -1 ? site : site.slice(0, end);
}

function sameWords(one: string, other: string): boolean {
  return wordsIn(fold(one)).join(" ") === wordsIn(fold(other)).join(" ");
}
