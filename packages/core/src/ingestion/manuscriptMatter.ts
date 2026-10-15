import { BOOK_MATTER_LIMITS, cleanMatterText, parseBookMatter, type BookMatter } from "../schemas/bookMatter.js";
import {
  firstPublishedImprint,
  foldMatterText,
  isBodyHeading,
  isBoilerplateSentence,
  isIllustrationCredit,
  isImprintLike,
  isNameLike,
  isRightsSentence,
  isTitleLike,
  looksLikeEpigraph,
  matterHeadingKind,
  opensLikeDedication,
  parseByline,
  parseCopyrightStatement,
  parseImprintLine,
  parseIsbnLine,
  type MatterHeadingKind
} from "./manuscriptMatterWords.js";
import { plainText } from "./manuscriptMatterPlainText.js";

/**
 * An imported manuscript's own front and back matter, taken out of its pages
 * so the book prints each piece once.
 *
 * Every book's compile prints a title page, a matter sheet (dedication, ©,
 * publisher, ISBN), a Contents and About the Author (`bookMatterPages.ts`),
 * and a new book takes the account's author profile into its matter. A
 * manuscript that brings its own copies of those pages printed them twice:
 * two title pages, two © statements with two different years, the author's bio
 * and then the profile's. One rule, in every import format:
 *
 * - **The manuscript's words win, and they print once, in the house layout.**
 *   A dedication and an About the Author are lifted into the book's matter and
 *   their pages dropped; the profile fills only what the manuscript does not
 *   say (`bookMatterForImportedManuscript`). One too long for its field stays in
 *   the pages, and for a biography the profile's is then left out.
 * - **A copyright page gives the matter sheet what it prints** — the © holder
 *   and year as written, "All rights reserved", the first valid ISBN, the
 *   publisher — and those lines come off the page. Its legal boilerplate (the
 *   reproduction clause, the fiction disclaimer, cataloguing and printing
 *   lines) goes with the page, and only with the whole page: one line of
 *   anything else — a cover credit, a website — keeps the rest of the page in
 *   the book, so nothing the author wrote is lost but the lines the sheet
 *   reprints.
 * - **A title page or Contents the compiler reprints is dropped**, its byline,
 *   subtitle and publisher lifted. A title page with a line that is none of
 *   those stays.
 *
 * Detection is conservative: only standalone sections — a heading's section,
 * an EPUB file, a page the author ended with a page break — at the front or
 * the back of the book, recognised by a heading in one of the compiler's
 * languages, by the EPUB's own `epub:type`, or (for a title page, a © page and a
 * dedication) by a shape no chapter has. A chapter called "About the Author"
 * in the middle of a novel is content, and so is everything after the first
 * section at either end that is not matter. Acknowledgments, "Also by" and an
 * epigraph are front or back matter the compiler does not print: they stay,
 * and the search goes on past them.
 */

/**
 * Where the author ended a page — a Word page or section break, an RTF `\page`,
 * a text file's form feed. A Unicode noncharacter, so no text can hold one;
 * every one is gone from the pages this module returns.
 */
export const MANUSCRIPT_PAGE_BREAK = "\uFDD0";
const PAGE_BREAKS = /[ \t]*\n?[ \t]*\uFDD0[ \t]*\n?/g;

/** What a section's own markup says it is (an EPUB's `epub:type` or `role`). */
export type ManuscriptMatterHint = "title" | "copyright" | "dedication" | "contents" | "passover";

export type MatterSourceSection = {
  title: string | null;
  text: string;
  hint?: ManuscriptMatterHint | undefined;
  /** The title is the file's metadata (an EPUB `<title>`), not a heading the page shows. */
  headingless?: boolean | undefined;
  /** A separate source document, such as an EPUB spine item, with its own boundary. */
  standalone?: boolean | undefined;
};

/** What the manuscript's own matter pages said, for `bookMatterForImportedManuscript`. */
export type ManuscriptMatter = {
  byline?: string;
  subtitle?: string;
  dedication?: string;
  aboutAuthor?: string;
  /** The manuscript's About the Author is too long for the field, so it stays in the pages. */
  aboutAuthorInPages?: true;
  copyrightHolder?: string;
  copyrightYear?: string;
  allRightsReserved?: true;
  isbn?: string;
  imprint?: string;
};

export type ManuscriptMatterKind = "title_page" | "copyright" | "dedication" | "about_author" | "contents";

export type SeparatedManuscript = {
  sections: Array<{ title: string | null; text: string }>;
  matter: ManuscriptMatter;
  /** The title the manuscript's own title page printed. */
  bookTitle?: string;
  /** What came out of the pages, in book order. */
  removed: ManuscriptMatterKind[];
};

export type SeparateMatterOptions = {
  /** Markdown or plain text: emphasis and escapes come off what is lifted. */
  markdown?: boolean | undefined;
  /** Names a title page's unlabelled line may be: the EPUB's creators, the book's byline. */
  knownAuthors?: readonly string[] | undefined;
};

type Unit = { raw: string; plain: string };

type Block = {
  origin: number;
  page: number;
  title: string | null;
  headingless: boolean;
  standalone: boolean;
  hint?: ManuscriptMatterHint | undefined;
  text: string;
};

type Reading = { heading: string | null; kind: MatterHeadingKind | null; body: string; headingFromLine: boolean };

/** What happened to one block: taken out, or kept as a shorter remainder. */
type Outcome = { removed: true } | { removed: false; title: string | null; text: string };

/**
 * One reading of a block. `stop` is the book itself. `continue` is matter or
 * matter-like text the run goes on past — taken out (`outcome.removed`),
 * shortened (`outcome` with its remainder, read again when `again`), or kept
 * whole. `passover` keeps the front open for a title page.
 */
type Step =
  | { run: "stop" }
  | { run: "continue"; what?: ManuscriptMatterKind; outcome?: Outcome; again?: boolean; passover?: boolean };

type Settled = "stop" | "passover" | "title_page" | "matter";

type Context = {
  options: SeparateMatterOptions;
  blocks: readonly Block[];
  matter: ManuscriptMatter;
  bookTitle?: string;
  statementLifted: boolean;
  /** The last block with any text: whether a block has the book after it, without reading every block after it. */
  lastWithText: number;
  /** Every block's folded titles and short lines, read once for any number of Contents pages. */
  headings?: BookHeadings;
};

export function separateManuscriptMatter(
  sections: readonly MatterSourceSection[],
  options: SeparateMatterOptions = {}
): SeparatedManuscript {
  const blocks = blocksOf(sections);
  let lastWithText = blocks.length - 1;
  while (lastWithText >= 0 && blocks[lastWithText]!.text.length === 0) lastWithText -= 1;
  const context: Context = { options, blocks, matter: {}, statementLifted: false, lastWithText };
  const outcomes = new Map<number, Outcome>();
  const removed: Array<{ at: number; what: ManuscriptMatterKind }> = [];

  // The front: from the first block until the first one that is the book.
  let allowTitle = true;
  let lead = 0;
  for (; lead < blocks.length; lead += 1) {
    const settled = settle(lead, "lead", context, allowTitle, outcomes, removed);
    if (settled === "stop") break;
    if (settled === "matter") allowTitle = false;
  }
  // The back: from the last block down to where the front stopped.
  for (let tail = blocks.length - 1; tail > lead; tail -= 1) {
    if (settle(tail, "tail", context, false, outcomes, removed) === "stop") break;
  }

  const rebuilt = rebuild(sections, blocks, outcomes);
  // A manuscript that is nothing but matter keeps it all: an import has to have a book.
  if (!rebuilt.some((section) => section.text.trim())) {
    return { sections: sections.map(withoutPageBreaks), matter: {}, removed: [] };
  }
  return {
    sections: rebuilt,
    matter: context.matter,
    ...(context.bookTitle ? { bookTitle: context.bookTitle } : {}),
    removed: removed.sort((a, b) => a.at - b.at).map((entry) => entry.what)
  };
}

/** One block per section, except the first and last, which split where the author broke the page. */
function blocksOf(sections: readonly MatterSourceSection[]): Block[] {
  const last = sections.length - 1;
  return sections.flatMap((section, origin) => {
    const pages =
      (origin === 0 || origin === last) && section.text.includes(MANUSCRIPT_PAGE_BREAK)
        ? section.text.split(PAGE_BREAKS)
        : [section.text.replace(PAGE_BREAKS, "\n")];
    return pages.flatMap((text, page): Block[] => {
      const trimmed = text.trim();
      const title = page === 0 ? section.title : null;
      if (!trimmed && !title) return [];
      return [
        {
          origin,
          page,
          title,
          headingless: page === 0 ? section.headingless === true || !title : true,
          // A following chapter heading alone does not make the opening a page.
          standalone: section.standalone === true || page < pages.length - 1,
          ...(page === 0 && section.hint ? { hint: section.hint } : {}),
          text: trimmed
        }
      ];
    });
  });
}

/**
 * Reads one block and every remainder it leaves (the rest of a first section
 * after its title page and © lines), recording what came out.
 */
function settle(
  index: number,
  side: "lead" | "tail",
  context: Context,
  allowTitle: boolean,
  outcomes: Map<number, Outcome>,
  removed: Array<{ at: number; what: ManuscriptMatterKind }>
): Settled {
  const following = index < context.lastWithText;
  let block = context.blocks[index]!;
  let settled: Settled | undefined;
  for (let pass = 0; pass < 4; pass += 1) {
    const step = stepFor(block, index, side, context, pass === 0 && allowTitle, pass > 0, following);
    // A remainder that is the book ends the front even though its block began as matter.
    if (step.run === "stop") return "stop";
    // An EPUB navigation item may precede its title page in the spine.
    settled ??= step.passover || step.what === "contents" ? "passover" : step.what === "title_page" ? "title_page" : "matter";
    if (step.what && step.outcome) removed.push({ at: index, what: step.what });
    if (!step.outcome) return settled;
    outcomes.set(index, step.outcome);
    if (step.outcome.removed || !step.again) return settled;
    block = {
      origin: block.origin,
      page: block.page,
      title: step.outcome.title,
      headingless: true,
      standalone: block.standalone,
      text: step.outcome.text
    };
  }
  return settled ?? "stop";
}

function stepFor(
  block: Block,
  index: number,
  side: "lead" | "tail",
  context: Context,
  allowTitle: boolean,
  remainder: boolean,
  following: boolean
): Step {
  const reading = readBlock(block);
  const kind = block.hint ?? reading.kind;
  const lead = side === "lead";
  const copyrightMode = remainder || block.text.length > 5000 ? "prefix" : "page";

  if (kind === "contents") return contentsPage(block, index, reading, context);
  if (kind === "about") return liftedPage(reading.body, "aboutAuthor", context);
  if (kind === "copyright") return copyrightPage(block, reading, context, copyrightMode);
  if (kind === "passover") return { run: "continue", passover: true };
  if (kind === "dedication" && lead) return liftedPage(reading.body, "dedication", context);
  if (kind === "title" && lead && allowTitle) {
    // A page that says it is the title page stays matter even when a line on it cannot be placed.
    return titlePage(block, reading, context, true, following) ?? { run: "continue", passover: true };
  }
  if (kind) return { run: "stop" };

  // An EPUB's metadata title is not printed, but a chapter label still rules
  // out inferred matter. Explicit page hints and matter headings win above.
  if (block.title && isBodyHeading(block.title)) return { run: "stop" };

  // No heading names it: a title page, a © page or a dedication by its shape.
  const visibleHeading = block.headingless ? null : block.title?.trim() || null;
  if (lead && allowTitle) {
    const title = titlePage(block, reading, context, false, following);
    if (title) return title;
  }
  if (visibleHeading) return { run: "stop" };
  const units = unitsOf(block.text, context.options.markdown === true);
  if (opensLikeCopyright(units)) return copyrightPage(block, reading, context, copyrightMode);
  if (lead) {
    const dedication = dedicationPage(block, units, context);
    if (dedication) return dedication;
  }
  if (lead && looksLikeEpigraph(units.map((unit) => unit.plain))) return { run: "continue", passover: true };
  return { run: "stop" };
}

/** The heading a block shows — its own, or a line it opens with that names matter — and the text under it. */
function readBlock(block: Block): Reading {
  const own = block.headingless ? null : block.title?.trim() || null;
  if (own) return { heading: own, kind: matterHeadingKind(own), body: block.text, headingFromLine: false };
  const end = block.text.indexOf("\n");
  const first = (end < 0 ? block.text : block.text.slice(0, end)).trim();
  const kind = first.length > 0 && first.length <= 80 ? matterHeadingKind(first.replace(/^#{1,6}\s+/, "")) : null;
  if (kind && kind !== "title") {
    return { heading: first, kind, body: end < 0 ? "" : block.text.slice(end + 1).trim(), headingFromLine: true };
  }
  return { heading: null, kind: null, body: block.text, headingFromLine: false };
}

/**
 * Paragraphs when the text has blank lines, lines when it has none (Word, EPUB, RTF).
 * A paragraph's line breaks fold with the whitespace around them, read from
 * the start of each run: `\s*\n\s*` from every space of a long run with no
 * break in it read the whole run each time.
 */
function unitsOf(text: string, markdown: boolean): Unit[] {
  const pieces = /\n[ \t]*\n/.test(text) ? text.split(/\n[ \t]*\n+/) : text.split("\n");
  return pieces
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => ({ raw, plain: plainText(raw.replace(/(?<!\s)\s*\n\s*/g, " "), markdown) }));
}

function separatorOf(text: string): string {
  return /\n[ \t]*\n/.test(text) ? "\n\n" : "\n";
}

/**
 * A title page, or the title page a first section opens with. It may be the
 * whole block only when the book follows it: a section that is nothing but a
 * title and a byline is the whole book, not its title page.
 */
function titlePage(block: Block, reading: Reading, context: Context, hinted: boolean, following: boolean): Step | null {
  const units = unitsOf(reading.body, context.options.markdown === true);
  const own = block.headingless ? null : block.title?.trim() || null;
  const visible = own && !matterHeadingKind(own) ? own : null;
  let title = visible;
  let rest = units;
  let needsExplicitByline = false;
  if (!title) {
    const first = units[0]?.plain;
    if (!first || !isTitleLike(first) || isBodyHeading(first)) return null;
    if (!hinted && !titleCased(first)) {
      if (/\p{Cased}/u.test(first)) return null;
      // Scripts without case cannot signal a title through capitals. Require
      // an explicit byline and a whole title-page block before lifting them.
      needsExplicitByline = true;
    }
    title = first;
    rest = units.slice(1);
  }
  const known = new Set((context.options.knownAuthors ?? []).map(foldMatterText).filter(Boolean));
  let subtitle: string | undefined;
  let byline: string | undefined;
  let explicitByline = false;
  let imprint: string | undefined;
  let consumed = 0;
  for (; consumed < rest.length; consumed += 1) {
    const line = rest[consumed]!.plain;
    if (line.length > 150) break;
    // The title page cannot reprint illustrator credits as authors or subtitles.
    if (isIllustrationCredit(line)) break;
    const named = parseByline(line, context.options.knownAuthors);
    if (named && !byline) {
      byline = named.name;
      explicitByline = true;
      if (named.lead && !subtitle) subtitle = named.lead;
      continue;
    }
    if (!byline && known.has(foldMatterText(line))) {
      byline = line;
      continue;
    }
    if (byline && !imprint && isImprintLike(line)) {
      imprint = line;
      continue;
    }
    if (isNameLike(line)) {
      // An unlabelled name is the author only where a title page puts one: on
      // a page that says it is the title page, or last, under a subtitle.
      if (!byline && (hinted || (consumed === rest.length - 1 && subtitle !== undefined))) {
        byline = line;
        continue;
      }
      break;
    }
    if (!byline && !subtitle && isTitleLike(line)) {
      subtitle = line;
      continue;
    }
    break;
  }
  const whole = consumed === rest.length;
  if (needsExplicitByline && (!explicitByline || !whole)) return null;
  // "The Long Winter" (and its subtitle) over its © lines, with no byline between.
  const overCopyright = !whole && opensLikeCopyright(rest.slice(consumed));
  const valid = hinted ? whole : byline !== undefined || rest.length === 0 || overCopyright;
  if (!valid || (whole && !following)) return null;

  context.bookTitle ??= title;
  if (byline) context.matter.byline ??= byline;
  if (subtitle) context.matter.subtitle ??= subtitle;
  if (imprint) context.matter.imprint ??= imprint;
  if (whole) return { run: "continue", what: "title_page", outcome: { removed: true } };
  return {
    run: "continue",
    what: "title_page",
    outcome: { removed: false, title: null, text: rest.slice(consumed).map((unit) => unit.raw).join(separatorOf(reading.body)) },
    again: true
  };
}

/** "THE LONG WINTER", "The Long Winter": a line on its own is a title only when it is set like one. */
function titleCased(line: string): boolean {
  if (!/\p{Ll}/u.test(line)) return /\p{Lu}/u.test(line);
  const words = line.split(/\s+/).filter((word) => /^\p{L}{4,}/u.test(word));
  return words.length > 0 && words.filter((word) => /^\p{Lu}/u.test(word)).length / words.length >= 0.6;
}

/** A dedication, or About the Author: lifted whole when it fits its field, kept in the pages when it does not. */
function liftedPage(body: string, field: "dedication" | "aboutAuthor", context: Context): Step {
  const what: ManuscriptMatterKind = field === "dedication" ? "dedication" : "about_author";
  const text = liftedText(body, field, context.options.markdown === true);
  if (!text) return { run: "continue", what, outcome: { removed: true } };
  if (text.length > BOOK_MATTER_LIMITS[field] || context.matter[field] !== undefined) {
    if (field === "aboutAuthor" && context.matter.aboutAuthor === undefined) context.matter.aboutAuthorInPages = true;
    return { run: "continue" };
  }
  context.matter[field] = text;
  return { run: "continue", what, outcome: { removed: true } };
}

/**
 * The page's words as the matter field keeps them: markdown off; a Word or
 * EPUB line, which is a paragraph, kept as a paragraph of a biography and a
 * line of a dedication; the field's own cleaning, unclipped.
 */
function liftedText(body: string, field: "dedication" | "aboutAuthor", markdown: boolean): string {
  const lines = body.split("\n").map((line) => plainText(line, markdown));
  const joined = /\n[ \t]*\n/.test(body) ? lines.join("\n") : lines.filter(Boolean).join(field === "aboutAuthor" ? "\n\n" : "\n");
  return cleanMatterText(joined, Number.MAX_SAFE_INTEGER) ?? "";
}

function looksLikeDedicationPage(units: Unit[], standalone: boolean): boolean {
  const total = units.reduce((sum, unit) => sum + unit.plain.length, 0);
  return (
    units.length > 0 &&
    units.length <= 4 &&
    total <= 400 &&
    opensLikeDedication(units[0]!.plain, standalone) &&
    !looksLikeEpigraph(units.map((unit) => unit.plain))
  );
}

/**
 * Word can put a dedication and publication details on the same sheet. Only
 * its dedication-shaped prefix belongs to that field; read the © remainder
 * again so its existing classifier lifts what can print and keeps the rest.
 * Explicit dedication headings and EPUB hints bypass this shape inference.
 */
function dedicationPage(block: Block, units: Unit[], context: Context): Step | null {
  for (let end = 1; end < units.length && end <= 4; end += 1) {
    if (!opensLikeCopyright(units.slice(end, end + 4))) continue;
    if (!looksLikeDedicationPage(units.slice(0, end), block.standalone)) return null;
    const separator = separatorOf(block.text);
    const lifted = liftedPage(units.slice(0, end).map((unit) => unit.raw).join(separator), "dedication", context);
    if (lifted.run !== "continue" || !lifted.outcome?.removed) return lifted;
    return {
      run: "continue",
      what: "dedication",
      outcome: { removed: false, title: null, text: units.slice(end).map((unit) => unit.raw).join(separator) },
      again: true
    };
  }
  return looksLikeDedicationPage(units, block.standalone) ? liftedPage(block.text, "dedication", context) : null;
}

/** A page that opens on a © statement, after at most a few lines of its own boilerplate. */
function opensLikeCopyright(units: Unit[]): boolean {
  for (const unit of units.slice(0, 4)) {
    const sentences = sentencesOf(unit.plain);
    const first = sentences[0] ?? "";
    if (parseCopyrightStatement(first) || isRightsSentence(first)) return true;
    if (!sentences.every((sentence) => isBoilerplateSentence(sentence) || parseIsbnLine(sentence) || parseImprintLine(sentence))) {
      return false;
    }
  }
  return false;
}

type SentenceRole = "lifted" | "boilerplate" | "other";

/**
 * The matter sheet's lines come off a copyright page into the book's matter;
 * its boilerplate goes only with the whole page. `page` reads the page whole;
 * `prefix` — the rest of a first section after its title page, or a page too
 * long to be only a © page — stops at the first line that is not the © page's.
 */
function copyrightPage(block: Block, reading: Reading, context: Context, mode: "page" | "prefix"): Step {
  const units = unitsOf(reading.body, context.options.markdown === true);
  const roles = units.map((unit) => sentencesOf(unit.plain).map((sentence) => ({ sentence, role: "other" as SentenceRole })));
  const end = mode === "page" ? units.length : prefixEnd(roles);
  // A first section that is a title, its © lines and a dedication, with no
  // page break between them, ends its © page where the dedication begins.
  const wholePage = end === units.length || (mode === "prefix" && looksLikeDedicationPage(units.slice(end), block.standalone));
  // A separate rights line belongs to the preceding © statement (or the first
  // one when rights lead the page). Keep it with a statement the sheet cannot
  // reproduce, rather than attaching its rights to another holder or a profile.
  const firstStatement = roles.slice(0, end).flat().map((entry) => parseCopyrightStatement(entry.sentence)).find(Boolean);
  let liftRights = firstStatement
    ? Boolean(firstStatement.holder && !firstStatement.scoped && !context.statementLifted)
    : Boolean(context.matter.copyrightHolder);
  // Lifting records into the matter, so it runs once, over exactly the lines that will come off.
  for (const sentences of roles.slice(0, end)) {
    for (const entry of sentences) {
      entry.role = sentenceRole(entry.sentence, context, liftRights);
      if (parseCopyrightStatement(entry.sentence)) liftRights = entry.role === "lifted";
    }
  }
  const lifted = roles.slice(0, end).some((sentences) => sentences.some((entry) => entry.role === "lifted"));
  if (!lifted) return { run: "continue" };
  const pageIsOnlyMatter = wholePage && roles.slice(0, end).every((sentences) => sentences.every((entry) => entry.role !== "other"));
  if (pageIsOnlyMatter && end === units.length) return { run: "continue", what: "copyright", outcome: { removed: true } };
  // Boilerplate goes only with the whole page; on a page that stays, only the sheet's lines come off.
  const goes = (role: SentenceRole) => role === "lifted" || (pageIsOnlyMatter && role === "boilerplate");
  const kept = units.flatMap((unit, position) => {
    const sentences = roles[position]!;
    if (position >= end || !sentences.some((entry) => goes(entry.role))) return [unit.raw];
    const remaining = sentences.filter((entry) => !goes(entry.role)).map((entry) => entry.sentence);
    return remaining.length > 0 ? [remaining.join(" ")] : [];
  });
  return {
    run: "continue",
    what: "copyright",
    outcome: {
      removed: false,
      title: reading.headingFromLine ? null : block.title,
      text: kept.join(separatorOf(reading.body))
    },
    again: mode === "prefix"
  };
}

/** Where a © prefix ends: the first line holding anything a © page does not. */
function prefixEnd(roles: Array<Array<{ sentence: string }>>): number {
  const end = roles.findIndex((sentences) =>
    sentences.some(
      ({ sentence }) =>
        !parseCopyrightStatement(sentence) &&
        !isRightsSentence(sentence) &&
        !parseIsbnLine(sentence) &&
        !parseImprintLine(sentence) &&
        !firstPublishedImprint(sentence) &&
        !isBoilerplateSentence(sentence)
    )
  );
  return end < 0 ? roles.length : end;
}

/** What one sentence of a © page is to the matter sheet, recording what it lifts. */
function sentenceRole(sentence: string, context: Context, liftRights: boolean): SentenceRole {
  const matter = context.matter;
  const statement = parseCopyrightStatement(sentence);
  if (statement) {
    // The sheet requires a holder. A year alone stays in the source, as do
    // the illustrator's © and any second statement the sheet cannot reprint.
    if (!statement.holder || statement.scoped || context.statementLifted) return "other";
    context.statementLifted = true;
    if (statement.holder) matter.copyrightHolder = statement.holder;
    if (statement.year) matter.copyrightYear = statement.year;
    if (statement.rights) matter.allRightsReserved = true;
    return "lifted";
  }
  if (isRightsSentence(sentence)) {
    if (!liftRights) return "other";
    matter.allRightsReserved = true;
    return "lifted";
  }
  const isbn = parseIsbnLine(sentence);
  if (isbn) {
    if (matter.isbn === undefined) {
      matter.isbn = isbn;
      return "lifted";
    }
    // Another edition's ISBN is a catalogue line, not this book's.
    return "boilerplate";
  }
  const imprint = parseImprintLine(sentence) ?? firstPublishedImprint(sentence);
  if (imprint) {
    if (matter.imprint === undefined) {
      matter.imprint = imprint;
      return "lifted";
    }
    const [had, now] = [foldMatterText(matter.imprint), foldMatterText(imprint)];
    return had.includes(now) || now.includes(had) ? "lifted" : "other";
  }
  return isBoilerplateSentence(sentence) ? "boilerplate" : "other";
}

const ABBREVIATION_END = /(?:^|[\s(])(?:\p{Lu}|Inc|Ltd|Co|Corp|Dr|Mr|Mrs|Ms|St|Jr|Sr|No|Vol|Ed|Eds|pp|etc|e\.g|i\.e|U\.S|U\.K)\.$/u;
/**
 * The longest abbreviation and its stop ("Corp.") with the space before it fit
 * in six characters, so in eight the `^` the pattern also accepts can never be
 * where an abbreviation starts unless the sentence itself starts there.
 */
const ABBREVIATION_END_CHARS = 8;

/**
 * Sentences, never split after an initial ("J. R. Ellis") or a common abbreviation.
 * Only the last few characters before a full stop can make it one, so only
 * they are read: reading the whole sentence so far from every stop made a long
 * run of initials quadratic.
 */
function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?;؛](?=\s+\S)|[。！？]/g)) {
    const end = match.index + match[0].length;
    if (match[0] === "." && ABBREVIATION_END.test(text.slice(Math.max(start, end - ABBREVIATION_END_CHARS), end))) {
      continue;
    }
    sentences.push(text.slice(start, end).trim());
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences.filter(Boolean);
}

/**
 * A Contents page the compiler reprints: every entry names a heading or a
 * line elsewhere in the book (page numbers and leaders off). An EPUB's
 * navigation document is one by its markup and needs no reading.
 */
function contentsPage(block: Block, index: number, reading: Reading, context: Context): Step {
  if (block.hint === "contents") return { run: "continue", what: "contents", outcome: { removed: true } };
  // Every other block's titles and lines. Gathering them for each page read
  // the whole book once per Contents heading; they are gathered once, and an
  // entry that folds to nothing never asks for them.
  const own = context.blocks[index]!;
  const ownTitle = own.title ? foldMatterText(own.title) : undefined;
  const isTitle = (folded: string) => (bookHeadings(context, index).titles.get(folded) ?? 0) > (ownTitle === folded ? 1 : 0);
  const isLine = (folded: string) => {
    const holder = bookHeadings(context, index).lines.get(folded);
    return holder !== undefined && holder !== index;
  };
  let budget = CONTENTS_MATCH_BUDGET;
  const entries = unitsOf(reading.body, context.options.markdown === true).flatMap((unit) => unit.raw.split("\n"));
  const named = entries.every((entry) => {
    // Fold localized numerals before the ASCII page-number pattern reads them.
    const bare = withoutPageNumber(foldMatterText(plainText(entry, context.options.markdown === true))).trim();
    const folded = foldMatterText(bare);
    if (!folded || matterHeadingKind(bare) || isLine(folded) || isTitle(folded)) return true;
    const unnumbered = folded.replace(/^(?:(?:chapter|part|book)\s+)?(?:\d+|[ivxlcdm]+)\s*[.:)\-–—]?\s*/u, "");
    if (unnumbered && (isTitle(unnumbered) || isLine(unnumbered))) return true;
    for (const title of bookHeadings(context, index).titles.keys()) {
      if (!isTitle(title)) continue;
      budget -= title.length + folded.length;
      if (budget < 0) return false;
      if ((folded.length >= 4 && title.includes(folded)) || (title.length >= 4 && folded.includes(title))) return true;
    }
    return false;
  });
  if (!named) return { run: "continue" };
  return { run: "continue", what: "contents", outcome: { removed: true } };
}

/**
 * Characters a Contents page may spend matching entries inside titles. Every
 * entry against every title is quadratic in the book; a real Contents of a
 * few hundred entries over as many chapters spends a few million. A page that
 * runs out is kept in the book, which is where an unverified Contents goes.
 */
const CONTENTS_MATCH_BUDGET = 50_000_000;

/**
 * Every block's folded titles, counted, and its short folded lines, each
 * mapped to the one block holding it or to `SEVERAL`. The first Contents page
 * to ask leaves its own block out, as the book read for one page always did;
 * a second page has it added, so every line is folded at most once.
 */
type BookHeadings = { titles: Map<string, number>; lines: Map<string, number>; without: number | undefined };
const SEVERAL = -1;

function bookHeadings(context: Context, asking: number): BookHeadings {
  const headings = context.headings ?? gatherHeadings(context, asking);
  context.headings = headings;
  if (headings.without !== undefined && headings.without !== asking) {
    addLines(headings.lines, headings.without, context.blocks[headings.without]!.text);
    headings.without = undefined;
  }
  return headings;
}

function gatherHeadings(context: Context, without: number): BookHeadings {
  const titles = new Map<string, number>();
  const lines = new Map<string, number>();
  context.blocks.forEach((block, position) => {
    if (block.title) count(titles, foldMatterText(block.title));
    if (position !== without) addLines(lines, position, block.text);
  });
  return { titles, lines, without };
}

function addLines(lines: Map<string, number>, position: number, text: string): void {
  for (const line of shortLines(text)) {
    const holder = lines.get(line);
    if (holder === undefined) lines.set(line, position);
    else if (holder !== position) lines.set(line, SEVERAL);
  }
}

/** A block's lines short enough to be a heading, folded. */
function shortLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= 160)
    .map(foldMatterText);
}

function count(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const PAGE_NUMBER_LEADER = /[\s.·…_\-–—]/u;

/**
 * `/[\s.·…_\-–—]*\d+$/u` off the end — the page number and its leader —
 * read backwards from the end. Read forwards, a long leader was read to its
 * end from every one of its characters.
 */
function withoutPageNumber(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) >= 48 && text.charCodeAt(end - 1) <= 57) end -= 1;
  if (end === text.length) return text;
  while (end > 0 && PAGE_NUMBER_LEADER.test(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

/** The sections again, each from what its blocks left: kept pages rejoined where the break was. */
function rebuild(
  sections: readonly MatterSourceSection[],
  blocks: readonly Block[],
  outcomes: ReadonlyMap<number, Outcome>
): Array<{ title: string | null; text: string }> {
  // blocksOf preserves section order. Visit each block once, even when a
  // section spans several pages or empty sections produced no blocks.
  let next = 0;
  return sections.flatMap((section, origin) => {
    const own: Array<{ block: Block; outcome: Outcome | undefined }> = [];
    while (blocks[next]?.origin === origin) {
      own.push({ block: blocks[next]!, outcome: outcomes.get(next) });
      next += 1;
    }
    if (own.every(({ outcome }) => outcome === undefined)) return [withoutPageBreaks(section)];
    const kept = own.flatMap(({ block, outcome }) =>
      outcome?.removed ? [] : [outcome ? { title: outcome.title, text: outcome.text } : { title: block.title, text: block.text }]
    );
    if (kept.length === 0) return [];
    const separator = /\n[ \t]*\n/.test(section.text) ? "\n\n" : "\n";
    return [{ title: kept[0]!.title, text: kept.map((piece) => piece.text).filter(Boolean).join(separator).trim() }];
  });
}

function withoutPageBreaks(section: { title: string | null; text: string }): { title: string | null; text: string } {
  return { title: section.title, text: section.text.replace(PAGE_BREAKS, "\n").trim() };
}

/**
 * The new book's byline, subtitle and matter: the manuscript's own words where
 * its pages said them, the author profile's where they did not.
 *
 * - A biography the manuscript kept in its pages leaves the profile's out, so
 *   the book has one About the Author. The profile's website is printed under
 *   a lifted biography unless that biography already gives it.
 * - The © holder, year, publisher and ISBN follow the manuscript's © page
 *   field by field; "All rights reserved" prints when either says it. A
 *   holder that is the byline is left to fall back to it, as on a generated
 *   book, so changing the byline later changes the © line with it.
 */
export function bookMatterForImportedManuscript(
  profile: { authorName?: string | undefined; bookMatter?: BookMatter | undefined },
  manuscript: ManuscriptMatter | undefined
): { authorName?: string; subtitle?: string; bookMatter?: BookMatter } {
  const own = manuscript ?? {};
  const fromProfile = profile.bookMatter ?? {};
  const authorName =
    cleanMatterText(own.byline, BOOK_MATTER_LIMITS.authorName, { singleLine: true }) ??
    cleanMatterText(profile.authorName, BOOK_MATTER_LIMITS.authorName, { singleLine: true });
  const aboutAuthor = own.aboutAuthor ?? (own.aboutAuthorInPages ? undefined : fromProfile.aboutAuthor);
  const website =
    fromProfile.authorWebsite && !(own.aboutAuthor && mentionsWebsite(own.aboutAuthor, fromProfile.authorWebsite))
      ? fromProfile.authorWebsite
      : undefined;
  const holder = own.copyrightHolder ?? fromProfile.copyrightHolder;
  const matter = parseBookMatter({
    ...(own.dedication ? { dedication: own.dedication } : {}),
    ...(aboutAuthor ? { aboutAuthor } : {}),
    ...(website ? { authorWebsite: website } : {}),
    ...(holder && !(authorName && foldMatterText(holder) === foldMatterText(authorName)) ? { copyrightHolder: holder } : {}),
    ...(own.copyrightYear ? { copyrightYear: own.copyrightYear } : {}),
    ...((own.imprint ?? fromProfile.imprint) ? { imprint: own.imprint ?? fromProfile.imprint } : {}),
    ...((own.isbn ?? fromProfile.isbn) ? { isbn: own.isbn ?? fromProfile.isbn } : {}),
    ...(own.allRightsReserved || fromProfile.allRightsReserved ? { allRightsReserved: true } : {})
  });
  const subtitle = cleanMatterText(own.subtitle, 160, { singleLine: true });
  return {
    ...(authorName ? { authorName } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(Object.keys(matter).length > 0 ? { bookMatter: matter } : {})
  };
}

function mentionsWebsite(text: string, website: string): boolean {
  const bare = (value: string) => value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const site = bare(website.trim());
  return site.length > 0 && text.toLowerCase().replace(/https?:\/\/(?:www\.)?/g, "").replace(/(?<![\p{L}\p{N}.])www\./gu, "").includes(site);
}
