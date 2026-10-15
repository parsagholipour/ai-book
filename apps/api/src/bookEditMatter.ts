import {
  bookMatterFieldsNamedIn,
  isAuthorManuscript,
  isLocalizedBookEditRequest,
  localizedBookMatterBreaks,
  localizedBookMatterFieldsNamedIn,
  parseBookMatter
} from "@book-maker/core";
import { bookTitleFromMessage } from "./bookEditBookTitle.js";
import { type BookEditIntent } from "./bookEditIntent.js";
import { spokenPageNumbersFromMessage } from "./bookEditMessage.js";

/**
 * A book's matter pages in the finished-book chat: the printed author name,
 * the dedication, About the Author, the website, the copyright holder, the
 * publisher, the ISBN and the "All rights reserved" line (`Project.authorName`
 * and `Project.bookMatter`). None of them is page text, so a change to any of
 * them is one free `book_matter` intent — never a page rewrite, which could not
 * honour it and would be priced for pages that do not hold it.
 *
 * This file only *recognises* one. What the change is — the new dedication with
 * a sister worked in, a name taken out of it, the ISBN the reader typed — is
 * composed at apply time by a model that is shown the book's current matter
 * (`mobile/bookMatterChatEdits.ts`, prompt and checks in core's
 * `bookMatterChatEdit.ts`). The regex extractor this replaced printed the words
 * after "to" (`"change the dedication to mention my sister too"` → "For mention
 * my sister too") and deleted a whole dedication for "remove my ex's name from
 * the dedication", because it never saw the dedication it was editing.
 *
 * The router picks the `book_matter` target, given {@link bookMatterForRouter}.
 * {@link mentionsBookMatter} is the narrow model-free detector for when the
 * router is down, and the guard that keeps a matter request away from the
 * fast paths that would misread it ("add a dedication: For my sources of
 * strength" is not the Sources list). It decides *whether*, never *what*. A
 * rename whose new title holds a matter word passes that guard
 * ({@link isWholeBookTitleRename}).
 */

/** The intent a matter change routes to. Always free; composed when applied. */
export function bookMatterIntent(decision: Pick<BookEditIntent, "confidence" | "reasoning" | "assistantMessage" | "responseLanguage">): BookEditIntent {
  return {
    kind: "book_matter",
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    affectedPageIndexes: [],
    assistantMessage: decision.assistantMessage,
    ...(decision.responseLanguage ? { responseLanguage: decision.responseLanguage } : {}),
    scope: "none",
    impact: "small_text",
    clarification: "none"
  };
}

/** Where a request is about prose rather than the book's matter. */
const IN_THE_TEXT = /(?<!\p{L})(?:chapters?|scenes?|characters?|quotes?|paragraphs?|dialogue|cap[ií]tulos?|chapitres?|kapitel|capitoli|сцен\p{L}*|глав\p{L}*|فصل|مشهد|صحنه|شخصیت|حوار|段落|场景|場景|シーン|장면)(?!\p{L})/iu;

type MatterCue = {
  cue: RegExp;
  unless?: RegExp;
  /**
   * Set on the cues that name the matter even in a request that names a page
   * by its number. Every other cue is page content there: "rewrite page 4 so
   * the publisher sounds meaner" is about a publisher in the prose, and with
   * the router down it was a matter edit that failed. The request, not the
   * message or even the sentence ({@link matterClauses}): "Change the
   * publisher to Lantern and make page 2 shorter" still changes the publisher.
   * A number that lands on a front-matter sheet never gets here
   * (`furniturePageIntentFromMessage` answers it first), and bare "page" is no
   * sign: "title page" and "copyright page" are the matter's own.
   */
  evenOnAPage?: true;
};

/** Named so {@link isTitlePageRemoval} can ask about every *other* matter page. */
const TITLE_PAGE_CUE: MatterCue = { cue: /\btitle\s+page\b/i, unless: IN_THE_TEXT };

/** Every way a reader names one of the matter pages, each with what rules it out. */
const MATTER_CUES: ReadonlyArray<MatterCue> = [
  // The book's dedication, named as a thing the book has — never "her
  // dedication to her training", a dedication scene, or a temple's. Its
  // content shapes are its own `unless`, and a page number is not one; a
  // sentence may open on "Dedication:" anywhere in the message.
  {
    cue: /\b(?:the|a|my|this|its|book['’]s|no|new|any)\s+dedication\b|\bdedication\s+(?:page|line|sheet|text)\b|(?:^|[.!?;…])\s*(?:new\s+)?dedication\s*[:\-–—]/i,
    unless:
      /\bdedication\s+(?:scenes?|ceremon(?:y|ies)|services?|rites?|speech)\b|\b(?:scenes?|ceremon(?:y|ies)|temples?|shrines?|church(?:es)?|monuments?)\b|\bdedication\s+(?:to|of)\s+(?:his|her|their|its)\b|\bdedication\s+(?:to|in|on|at)\s+(?:the\s+)?(?:chapter|page|scene|section)\b|\b(?:pages?|chapters?|sections?)\s+about\b/i,
    evenOnAPage: true
  },
  // Dedicating the book itself — "dedicate a chapter to…" is content.
  {
    cue: /\bdedicate\s+(?:it|this|(?:the|this|my|our)\s+(?:book|story|novel|guide|manuscript|whole\s+thing))\s+to\b|\b(?:it|book|story|novel|guide|manuscript)\s+(?:to\s+be\s+|be\s+)?dedicated\s+to\b/i,
    evenOnAPage: true
  },
  { cue: /\babout\s+the\s+author\b|\bauthor(?:['’]s)?\s+bio(?:graphy)?\b|\bmy\s+bio(?:graphy)?\b|\bbio\s+page\b/i },
  { cue: /\bisbn\b/i, evenOnAPage: true },
  { cue: /\b(?:all\s+)?rights\s+reserved\b/i, evenOnAPage: true },
  {
    cue: /\bcopyright\s+(?:line|page|notice|holder|name|owner|info(?:rmation)?|details|statement|year)\b|\bthe\s+copyright\s+(?:to|should|says?|reads?)\b/i
  },
  { cue: /\b(?:imprint|publisher|publishing\s+house)\b/i, unless: IN_THE_TEXT },
  {
    cue: /\bpen[\s-]?name\b|\bauthor(?:['’]s)?\s+name\b|\bby-?line\b|\bname\s+on\s+the\s+(?:book|cover|title\s+page)\b/i,
    unless: IN_THE_TEXT
  },
  TITLE_PAGE_CUE,
  { cue: /\b(?:my|author(?:['’]s)?)\s+(?:web\s*site|homepage)\b/i }
];

const OTHER_MATTER_CUES = MATTER_CUES.filter((entry) => entry !== TITLE_PAGE_CUE);

/**
 * Whether a message asks to change one of the book's matter pages — model-free,
 * and narrow on purpose. A question about them is not a request ("who is the
 * book dedicated to?"), bare "dedicated" is not the book's dedication ("make
 * the hero more dedicated to her training"), "dedicate a chapter to my mom"
 * is page content, and so is most of the matter's vocabulary in a sentence that
 * names a page by its number ({@link MatterCue.evenOnAPage}).
 *
 * A message that opens or ends on a question is read again sentence by
 * sentence, because the question may be only one of them: "Is the dedication
 * ok? Add a dedication: For my sources of strength" asks for a change in its
 * second, and with the router down it went to the whole-book rewrite card.
 */
export function mentionsBookMatter(message: string): boolean {
  const text = message.replace(/[^\S\r\n]+/g, " ").trim();
  if (!text) return false;
  if (!asks(text)) return namesMatter(text) || namesLocalizedMatter(text);
  const statements = text
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !asks(sentence));
  if (statements.length === 0) return false;
  const rest = statements.join("\n");
  return namesMatter(rest) || namesLocalizedMatter(rest);
}

/**
 * Reuse the composer's translated field names, keeping the routing exclusions:
 * a biography or publisher named in prose stays prose, and a numbered page
 * stays a page unless the request names a dedication, ISBN or rights line.
 * The translated reader is separate because the composer's broader English
 * cues also name a character's dedication; those still go through MATTER_CUES.
 */
function namesLocalizedMatter(text: string): boolean {
  return matterClauses(text).some(({ text: clause, onAPage }) => {
    const fields = localizedBookMatterFieldsNamedIn(clause);
    if (fields.size === 0 || IN_THE_TEXT.test(clause) || /\bpages?\s+about\b/i.test(clause)) return false;
    return !onAPage || fields.has("dedication") || fields.has("isbn") || fields.has("allRightsReserved");
  });
}

/** Whether one of `cues` names a matter page in `text`, statement or question alike. */
function namesMatter(text: string, cues: ReadonlyArray<MatterCue> = MATTER_CUES): boolean {
  return matterClauses(text).some(({ text: clause, onAPage }) =>
    cues.some(({ cue, unless, evenOnAPage }) => cue.test(clause) && !unless?.test(clause) && (evenOnAPage || !onAPage))
  );
}

/** The verbs a request opens on, core's list (`bookMatterRequests.ts`). */
const EDIT_VERB = String.raw`(?:make|rewrite|write|change|add|delete|remove|fix|turn|keep|move|update|redraw|redo|regenerate|replace|shorten|lengthen|expand|cut|trim|translate|rename|retitle|draw|illustrate|swap|insert|edit|put|set|use|give|create|generate|improve|polish|simplify|continue|extend|dedicate|print|drop)`;
/** What opens a second request: an edit verb, a "can you" or "I want", or a page named by its number. */
const REQUEST_START = String.raw`(?:(?:please|also|then|just|and)\s+)*(?:${EDIT_VERB}\b|(?:can|could|would|will)\s+you\b|i\s+(?:also\s+)?(?:want|need|['’]d\s+like|would\s+like)\b|(?:on\s+|in\s+)?(?:the\s+)?pages?\s+\d)`;
/**
 * Where one request of a message ends and the next begins: a sentence end (a
 * semicolon among them), or a comma or "and / also / then / plus / but" before
 * a new request. Not every "and" or comma: "rewrite page 4 so the hero, not
 * the publisher, wins" and "make the hero and the publisher kinder on page 4"
 * are one request each, about the prose.
 */
const CLAUSE_BREAK = new RegExp(
  String.raw`(?<=[.!?;…])\s+|[\r\n]+|(?<lend>,)\s*(?=${REQUEST_START})|\s(?:and|also|then|plus|but)\s+(?=${REQUEST_START})`,
  "giu"
);
const HAS_EDIT_VERB = new RegExp(String.raw`\b${EDIT_VERB}\b`, "i");

/** Where a sentence ends: a mark before a space, an unspaced script's own mark, or a line break. */
const SENTENCE_BREAK = /(?<=[.!?…؟।۔])\s+|(?<=[。！？])|[\r\n]+/u;
const QUESTION_OPENING = /^(?:who|what|why|how|where|when|which|is|are|does|did|has|have|do)\b/i;
/**
 * "Have" and "do" open imperatives too: "Have the dedication read: For Mom",
 * "Do remove the ISBN", "Do not print my website". Only those shapes — "have",
 * an object of up to six words and a bare verb; "do" before "not" or an edit
 * verb — are let through, so "have you added a dedication" and "do I need an
 * ISBN" still ask. Anchored, so it is tried at the sentence's start alone.
 */
const HAVE_DO_IMPERATIVE = new RegExp(
  String.raw`^(?:do\s+(?:not|${EDIT_VERB})|have\s+(?!(?:i|you|u|we|they|he|she)\b)(?:\S+\s+){1,6}?(?:read|say|mention|include|show|list|be|appear|use|thank|credit|print|name))\b`,
  "i"
);

/** Whether a sentence asks rather than requests. "Can you…?" is a request, its mark included. */
function asks(sentence: string): boolean {
  if (/^(?:please\s+)?(?:can|could|would|will)\s+you\b/i.test(sentence)) return false;
  return /[?؟？]$/.test(sentence) || (QUESTION_OPENING.test(sentence) && !HAVE_DO_IMPERATIVE.test(sentence));
}

/**
 * Read each request with its page context. Both page-number and prose-word
 * exclusions apply to the clause holding the matter cue: "Change the publisher
 * to Lantern and rewrite chapter 3" still changes the publisher. Translated
 * requests use the composer's own boundaries. A request with
 * no verb of its own that names a page ("On page 4, make the imprint's owner
 * kinder") is where the request after its comma happens, and lends it the page.
 */
function matterClauses(text: string): Array<{ text: string; onAPage: boolean }> {
  const clauses: Array<{ text: string; onAPage: boolean }> = [];
  let lent = false;
  let start = 0;
  const take = (clause: string, lends: boolean) => {
    const onAPage = lent || spokenPageNumbersFromMessage(clause).length > 0;
    clauses.push({ text: clause, onAPage });
    lent = onAPage && lends && !HAS_EDIT_VERB.test(clause) && !isLocalizedBookEditRequest(clause);
  };
  const boundaries = [
    ...[...text.matchAll(CLAUSE_BREAK)].map((found) => ({
      index: found.index, end: found.index + found[0].length, lends: found.groups?.lend !== undefined
    })),
    ...localizedBookMatterBreaks(text).map((boundary) => ({
      ...boundary, lends: /^[,،]$/.test(text.slice(boundary.index, boundary.end))
    }))
  ].sort((a, b) => a.index - b.index || b.end - a.end);
  for (const boundary of boundaries) {
    if (boundary.index < start) continue;
    take(text.slice(start, boundary.index), boundary.lends);
    start = boundary.end;
  }
  take(text.slice(start), false);
  return clauses;
}

/** Where an unquoted title could stop and a second request start. */
const TITLE_CLAUSE_BREAK = /[,;:.!?…—–]|\b(?:and|also|plus|then|with|but)\b/i;
const OPENING_QUOTES = ['"', "“", "”", "'", "‘", "’", "«"];

/**
 * Whether a message is, in full, a rename of the book, so that the matter words
 * in it are the new title's: "Rename the book to Letters to My Publisher",
 * "Change the title to The ISBN Mystery". Behind the matter guard those skipped
 * the free title path for the router — which once quoted a rename as a
 * 550-credit rebuild — and with the router down they were matter edits that
 * failed. So a rename passes the guard, as a swap that marks its term as words
 * does.
 *
 * A quoted title is a boundary the reader drew, and `bookTitleFromMessage`
 * already refuses anything after it. Unquoted, the title runs to the end of the
 * message and the parse refuses only a tail that opens on a verb ("… and add a
 * dedication to my mom"), so a matter page named after a break inside it is a
 * second request: "change the title to Moonrise and the dedication to my mom".
 */
export function isWholeBookTitleRename(message: string): boolean {
  const title = bookTitleFromMessage(message);
  if (!title) return false;
  const text = message.replace(/\s+/g, " ");
  if (OPENING_QUOTES.some((quote) => text.includes(`${quote}${title}`))) return true;
  const clauseEnd = TITLE_CLAUSE_BREAK.exec(title);
  return !clauseEnd || !namesMatter(title.slice(clauseEnd.index + clauseEnd[0].length));
}

/**
 * What may stand between a removal verb and the title page, and after it — a
 * closed grammar, the way `bookEditStructure.ts` reads "delete page 3".
 *
 * This used to fire on "title page" anywhere near a removal word, and nearby is
 * where a reader names what the page *holds*: "remove my name from the title
 * page", "take my name off the title page", "remove the subtitle from the title
 * page" and "delete page 2 — the title page is enough" were all answered "Every
 * book keeps its title page", and the byline never came off. Something taken
 * *from* the title page is a matter edit, and only the composer can make it.
 */
/** Whitespace, but never a line break: the object has to be in the same line as its verb. */
const TITLE_PAGE_GAP = String.raw`[^\S\r\n]+`;
const TITLE_PAGE_WORD = String.raw`title(?:-|${TITLE_PAGE_GAP})pages?`;
/** Determiners and possessives only. A noun here ("my name", "the subtitle") is what goes, and it is not the page. */
const TITLE_PAGE_DETERMINER = String.raw`(?:(?:the|this|that|a|an|any|its|my|our|book['’]s|story['’]s|whole|entire)${TITLE_PAGE_GAP})*`;
const TITLE_PAGE_OBJECT = `${TITLE_PAGE_DETERMINER}${TITLE_PAGE_WORD}`;
const TITLE_PAGE_BOOK = String.raw`(?:it|(?:the|this|my|our|its)${TITLE_PAGE_GAP}(?:book|story|novel|guide|manuscript|pdf|e-?book|epub|export|file))`;
const TITLE_PAGE_REMOVAL_VERB = String.raw`(?:remove|delete|drop|cut|hide|skip|lose|ditch|scrap|omit|erase|get${TITLE_PAGE_GAP}rid${TITLE_PAGE_GAP}of|take${TITLE_PAGE_GAP}(?:out|away|off)|leave${TITLE_PAGE_GAP}out|(?:do${TITLE_PAGE_GAP}not|don['’]?t)${TITLE_PAGE_GAP}(?:want|need)|without)`;
/** "Take the title page out", "leave the title page off my book": the particle follows the object. */
const TITLE_PAGE_PARTICLE_REMOVAL = String.raw`(?:take|leave)${TITLE_PAGE_GAP}${TITLE_PAGE_OBJECT}${TITLE_PAGE_GAP}(?:out|off|away)(?:${TITLE_PAGE_GAP}(?:of${TITLE_PAGE_GAP}|from${TITLE_PAGE_GAP})?${TITLE_PAGE_BOOK})?`;
/** "No title page, please" as the request itself — never "there's no title page in the PDF". */
const NO_TITLE_PAGE = String.raw`(?:^(?:please${TITLE_PAGE_GAP})?|\b(?:want|need|like|prefer)${TITLE_PAGE_GAP})no${TITLE_PAGE_GAP}${TITLE_PAGE_WORD}`;
const TITLE_PAGE_DEGREE = String.raw`(?:${TITLE_PAGE_GAP}(?:entirely|altogether|completely|for${TITLE_PAGE_GAP}good))?`;
/** "…entirely", "…from my book": what may follow the object without making the page someone else's. */
const TITLE_PAGE_TAIL = String.raw`${TITLE_PAGE_DEGREE}(?:${TITLE_PAGE_GAP}(?:from|in|of|out${TITLE_PAGE_GAP}of)${TITLE_PAGE_GAP}${TITLE_PAGE_BOOK})?${TITLE_PAGE_DEGREE}`;
/**
 * Where the clause has to stop. Anything else after "title page" makes it a
 * locator ("remove the title page logo", "the title page's subtitle", "I don't
 * want the title page to show my name") or adds a request the composer has to
 * see ("… and the dedication").
 */
const TITLE_PAGE_CLAUSE_END = String.raw`(?=[^\S\r\n]*(?:$|[\r\n.,;:!?…)—–]|-(?:\s|$))|${TITLE_PAGE_GAP}(?:please|pls|thanks|thank${TITLE_PAGE_GAP}you|now|too|for${TITLE_PAGE_GAP}me|if${TITLE_PAGE_GAP}(?:you${TITLE_PAGE_GAP}can|possible)|because|since|so)\b)`;
const TITLE_PAGE_REMOVAL = new RegExp(
  String.raw`(?:\b${TITLE_PAGE_REMOVAL_VERB}${TITLE_PAGE_GAP}${TITLE_PAGE_OBJECT}|\b${TITLE_PAGE_PARTICLE_REMOVAL}|${NO_TITLE_PAGE})${TITLE_PAGE_TAIL}${TITLE_PAGE_CLAUSE_END}`,
  "i"
);
/** A word that is a verb of its own clause: an edit verb, or one of the removal grammar's. */
const CLAUSE_VERB = new RegExp(String.raw`\b(?:${EDIT_VERB}|hide|skip|lose|ditch|scrap|omit|erase|get|take|leave|want|need)\b`, "i");
/** The last negation of the text's last sentence, and what follows it. */
const LAST_NEGATION = /^[\s\S]*\b(?:do\s+not|don['’]?t|never)\b(?<stretch>[^.!?;\r\n]*)$/i;
/**
 * A refusal is not a request: "please don't remove the title page" removes
 * nothing, and neither does "please don't, under any circumstances, remove the
 * title page". A negation is still waiting for its verb across words that are
 * not one, within its sentence; "don't change the dedication, remove the title
 * page" has spent it on "change".
 */
function negationAwaitsVerb(text: string): boolean {
  const stretch = LAST_NEGATION.exec(text)?.groups?.stretch;
  return stretch !== undefined && !CLAUSE_VERB.test(stretch);
}
/** A second edit asked in the same message, which the composer has to see. */
const ANOTHER_REQUEST = /\b(?:and|also|plus|then)\s+(?:make|rewrite|write|change|add|update|set|put|dedicate|replace)\b/i;

/**
 * "Remove the title page": every book keeps one, so this is answered — with
 * what can be changed on it — and never sent to the composer, the router or a
 * page edit. Only when the title page *is* the verb's object, and only when it
 * is the whole request: a message that also changes another matter page ("change
 * the dedication to my mom and remove the title page", "Author: Sam Lee. Remove
 * the title page.") goes to the composer, and its reply adds that the title
 * page stays ({@link asksToRemoveTitlePage}).
 *
 * The rest of the message is read for the matter twice — by this file's cues
 * and by the composer's own (`bookMatterFieldsNamedIn`, core) — because the
 * composer's grew "change the author to Sam", "Author: Sam Lee" and "use Sam
 * Lee as the author" for the byline and these did not: the shortcut answered
 * those as a bare removal, and the reader was asked for the name they had just
 * given. Reading with both cannot drift that way again.
 */
export function isTitlePageRemoval(message: string): boolean {
  const text = message.replace(/[^\S\r\n]+/g, " ").trim();
  const match = TITLE_PAGE_REMOVAL.exec(text);
  if (!match || negationAwaitsVerb(text.slice(0, match.index)) || ANOTHER_REQUEST.test(text)) {
    return false;
  }
  const outside = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`;
  return !namesMatter(outside, OTHER_MATTER_CUES) && bookMatterFieldsNamedIn(outside).size === 0;
}

/** Where one clause of a compound message may end; a sentence end and "but" also end what it carries. */
const REQUEST_CLAUSE_BREAK = /(?<ends>[\r\n.!?;…]+|\sbut\s)|,|\s(?:and|also|plus|then)\s/gi;
/** A removal verb and the object after it, a negation before it included. */
const REMOVAL_HEAD = new RegExp(
  String.raw`(?:\b(?:do${TITLE_PAGE_GAP}not|don['’]?t|never)${TITLE_PAGE_GAP})?\b${TITLE_PAGE_REMOVAL_VERB}${TITLE_PAGE_GAP}(?<object>.*)$`,
  "i"
);
/** An object that says where something is taken from is not a list the next clause continues. */
const LOCATIVE = /\b(?:from|off|of|on|in|out|at|to|for|with|under|inside|onto|into)\b/i;

/**
 * Whether any clause of a compound message asks for the title page to go —
 * "remove the title page and change the author name to Sam" — each through
 * {@link isTitlePageRemoval}'s closed grammar, so "remove my name from the
 * title page" and "delete the title page logo" are not removals.
 *
 * A clause is read with what an earlier one left it. A negation still waiting
 * for its verb rides on: "Please don't, under any circumstances, remove the
 * title page, and …" removes nothing, where the clause "remove the title page"
 * read alone did. And a clause with no verb of its own shares the removal
 * before it: "Remove the dedication and the title page" asks for both — but
 * not "remove my name from the dedication and the title page", whose list is
 * of places.
 */
export function asksToRemoveTitlePage(message: string): boolean {
  let negation = "";
  let removal = "";
  let start = 0;
  for (const found of [...message.matchAll(REQUEST_CLAUSE_BREAK), null]) {
    const clause = message.slice(start, found ? found.index : message.length).trim();
    start = found ? found.index + found[0].length : message.length;
    if (clause) {
      const ownVerb = CLAUSE_VERB.test(clause);
      const text = `${negation}${ownVerb ? "" : removal}${clause}`;
      if (isTitlePageRemoval(text)) return true;
      if (ownVerb) {
        const head = REMOVAL_HEAD.exec(text);
        const object = head?.groups?.object ?? "";
        removal = head && !LOCATIVE.test(object) ? head[0].slice(0, head[0].length - object.length) : "";
        negation = "";
      } else if (negationAwaitsVerb(text)) {
        negation = "don't ";
      }
    }
    if (found?.groups?.ends) {
      negation = "";
      removal = "";
    }
  }
  return false;
}

/** The book's matter as the router is shown it: what prints now, briefly. */
export type BookMatterRouterView = {
  authorName?: string;
  dedication?: string;
  aboutAuthor?: string;
  authorWebsite?: string;
  copyrightHolder?: string;
  imprint?: string;
  isbn?: string;
  allRightsReserved: boolean;
  /** An author's book sets its author name and dedication in the Writing Studio. */
  setInWritingStudio?: string[];
};

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text);

/**
 * Enough of the book's matter for the router to tell a matter request from a
 * page edit ("remove my ex's name" means something when the dedication names
 * one). The composer is shown the whole of it.
 */
export function bookMatterForRouter(project: {
  authorName?: string | null;
  bookMatter?: unknown;
  mediaSettings?: unknown;
}): BookMatterRouterView {
  const matter = parseBookMatter(project.bookMatter);
  const authorName = project.authorName?.trim();
  return {
    ...(authorName ? { authorName } : {}),
    ...(matter.dedication ? { dedication: clip(matter.dedication, 240) } : {}),
    ...(matter.aboutAuthor ? { aboutAuthor: clip(matter.aboutAuthor, 240) } : {}),
    ...(matter.authorWebsite ? { authorWebsite: matter.authorWebsite } : {}),
    ...(matter.copyrightHolder ? { copyrightHolder: matter.copyrightHolder } : {}),
    ...(matter.imprint ? { imprint: matter.imprint } : {}),
    ...(matter.isbn ? { isbn: matter.isbn } : {}),
    allRightsReserved: matter.allRightsReserved === true,
    ...(isAuthorManuscript(project.mediaSettings) ? { setInWritingStudio: ["authorName", "dedication"] } : {})
  };
}
