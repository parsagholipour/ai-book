import type {
  BookMatterChatCurrent, BookMatterChatField, BookMatterChatPatch, BookMatterChatProblem, BookMatterNoneReason
} from "@book-maker/core";
import { chatMarkdownLiteral } from "../chatMarkdownLiteral.js";
import { localizedMatterChatCopy, type MatterChatText } from "./bookMatterChatCopy.js";
import type { MatterChatLanguage } from "./bookMatterChatLanguage.js";
import type { BookMatterCover, BookMatterReprint } from "./bookMatterEdits.js";

/**
 * “…” around one value, as it will print — kept literal, because the bubble is
 * light markdown and the page prints "For *Mom*" with its asterisks.
 */
const quoted = (value: string) => `“${chatMarkdownLiteral(value)}”`;

/** About the Author, including its website, is omitted until it has a biography. */
export function websiteNeedsBiography(after: BookMatterChatPatch, current: BookMatterChatCurrent): boolean {
  if (after.authorWebsite === undefined && after.aboutAuthor === undefined) return false;
  const website = after.authorWebsite !== undefined ? after.authorWebsite : current.authorWebsite;
  const biography = after.aboutAuthor !== undefined ? after.aboutAuthor : current.aboutAuthor;
  return Boolean(website?.trim()) && !biography?.trim();
}

/**
 * Every reply a `book_matter` edit gives, in one conversation language — the
 * words from `MATTER_CHAT_COPY`, English included. Copy only: the decision,
 * the patch and the committed result remain the source of every claim.
 */
export function localizedMatterChatReplies(language: MatterChatLanguage) {
  const copy = localizedMatterChatCopy(language);
  const { text, field } = copy;
  const titleAnswer = `${text("titleKept")} ${text("titleChange")}`;
  return {
    ...copy,
    titleAnswer,
    /** Once the one question is spent: never another question, but what to send instead, or the sheet. */
    secondQuestion: `${text("unclear")} ${text("sendOne")}`,
    none(reason: BookMatterNoneReason, current: BookMatterChatCurrent): string {
      switch (reason) {
        case "title_page": return titleAnswer;
        case "copyright_line": return text(current.allRightsReserved ? "copyrightRemoveRights" : "copyrightAddRights");
        case "not_matter": return text("notMatter");
      }
    },
    /**
     * What was wrong with the change, then how the reader goes on: on the turn
     * that may still ask, the request's one question (the caller stores
     * `pendingEdit`); once that is spent, a statement saying what to send in
     * one message, or the sheet.
     */
    problem(problem: BookMatterChatProblem, spent: boolean): string {
      switch (problem.kind) {
        case "too_long": {
          const said = text("tooLong", {
            field: field(problem.field), length: problem.length.toLocaleString(language), limit: problem.limit.toLocaleString(language)
          });
          return `${said} ${text(spent ? "shorterOrSheet" : "shorter")}`;
        }
        case "invalid_isbn":
          return `${text("invalidIsbn")} ${text(spent ? "isbnOrSheet" : "askIsbn")}`;
        case "not_given": {
          const prose = problem.field === "dedication" || problem.field === "aboutAuthor";
          const said = text(prose ? "notGiven" : "notGivenValue", { field: field(problem.field) });
          return `${said} ${text(spent ? "sendOne" : prose ? "askText" : "askValue")}`;
        }
        case "runs_on": {
          const said = text("runsOn", { field: field(problem.field) });
          return `${said} ${text(spent ? "sendOne" : "askField", { field: field(problem.field) })}`;
        }
      }
    },
    /** A compound message's left-over: the reader's own words quoted, or named without quoting anything. */
    leftOver(unhandled?: string): string {
      return unhandled === undefined ? text("separate") : text("separateQuoted", { request: quoted(unhandled) });
    },
    /** The screen refused these fields. Its reason is core's English sentence, which only the English copy quotes. */
    restricted(fields: readonly string[], reason: string): string {
      const named = fields.map((name) => field(name as BookMatterChatField) ?? name).join(copy.fieldSeparator);
      return text("restricted", { field: named, reason });
    },
    /**
     * The matter write refused the patch. Its message is the PATCH route's
     * English sentence, which only the English copy quotes; the others say it
     * in their own words.
     */
    saveRefused(refusal: { code: "PROJECT_BUSY" | "SET_IN_STUDIO" | "INVALID_ISBN"; message: string }): string {
      if (refusal.code === "SET_IN_STUDIO") return text("studio");
      return text(refusal.code === "INVALID_ISBN" ? "isbnRefused" : "busy", { reason: refusal.message });
    },
    /**
     * What the chat says once a matter change is in: what each changed field
     * now prints, quoted exactly, then whether the exports are being refreshed
     * or the book will be put together with it — and that it was free. Never a price.
     */
    change(
      after: BookMatterChatPatch,
      current: BookMatterChatCurrent,
      year: string,
      outcome: { reprint: BookMatterReprint; cover: BookMatterCover }
    ): string {
      const unchanged = outcome.reprint === "none";
      const needsBiography = websiteNeedsBiography(after, current);
      const change = { after, current, year, unchanged, needsBiography };
      const items = copy.changeGrammar === "english" ? englishChangeItems(copy, change) : listedChangeItems(copy, change);
      const website = needsBiography ? ` ${text("websiteNeedsBio")}` : "";
      const said = `${text(unchanged ? "unchanged" : "done")} — ${items}.${website}`;
      if (unchanged) return said;
      const cover = after.authorName === undefined ? "" : outcome.cover === "retypeset" ? ` ${text("coverNew")}`
        : outcome.cover === "keeps_old_name" ? ` ${text("coverOld")}` : "";
      const when = outcome.reprint === "queued" ? ` ${text("queued")}` : needsBiography ? "" : ` ${text("next")}`;
      return `${said}${cover}${when} ${text("free")}`;
    }
  };
}

type ChangeItems = {
  after: BookMatterChatPatch;
  current: BookMatterChatCurrent;
  year: string;
  unchanged: boolean;
  needsBiography: boolean;
};

function printedNames({ after, current }: ChangeItems) {
  const authorName = after.authorName !== undefined ? after.authorName : current.authorName;
  // Clearing the explicit holder falls back to the author, exactly as the compiler does.
  const holder = (after.copyrightHolder !== undefined ? after.copyrightHolder : current.copyrightHolder) ?? authorName;
  return { authorName, holder };
}

/** Each changed field as `field: “what it prints”`, one after another. */
function listedChangeItems({ text, field }: MatterChatText, change: ChangeItems): string {
  const { after, year, unchanged } = change;
  const { holder } = printedNames(change);
  return (Object.keys(after) as BookMatterChatField[]).map((key) => {
    const value = after[key];
    const name = field(key);
    if (key === "allRightsReserved") {
      return text(value !== true ? "notPrinted" : holder ? "prints" : "needsHolder", { field: name });
    }
    const printed = key === "copyrightHolder" ? (holder ? `© ${year} ${holder}` : null)
      : key === "isbn" && typeof value === "string" ? `ISBN ${value}` : value;
    if (typeof printed !== "string") return text(unchanged ? "absent" : "removed", { field: name });
    return unchanged ? text("already", { field: name, value: quoted(printed) }) : `${name}: ${quoted(printed)}`;
  }).join("; ");
}

/**
 * English phrases each changed field in its own words — "the dedication now
 * reads …", "the copyright line is back to …" — where the other languages list
 * them; the sentences around the list are the same table's for every language.
 */
function englishChangeItems({ text, field }: MatterChatText, change: ChangeItems): string {
  const { after, year, unchanged, needsBiography } = change;
  const { authorName, holder } = printedNames(change);
  const fields = Object.keys(after) as BookMatterChatField[];
  const pendingWebsite = (key: BookMatterChatField) => key === "authorWebsite" && needsBiography;
  if (unchanged) {
    return fields.map((key) => {
      if (pendingWebsite(key)) return `the website is already saved as ${quoted(after.authorWebsite!)}`;
      const value = after[key];
      if (key === "allRightsReserved") {
        return value === true && holder ? "“All rights reserved.” already prints" : "“All rights reserved.” isn’t printed";
      }
      return typeof value === "string"
        ? text("already", { field: field(key), value: quoted(key === "isbn" ? `ISBN ${value}` : value) })
        : text("absent", { field: field(key) });
    }).join(", and ");
  }
  const changed = fields.map((key) => {
    if (pendingWebsite(key)) return `the website is saved as ${quoted(after.authorWebsite!)}`;
    const value = after[key];
    const set = typeof value === "string" ? value : null;
    switch (key) {
      case "authorName":
        return set !== null ? `the author name is now ${quoted(set)}` : "the book no longer prints an author name";
      case "aboutAuthor":
        return set !== null ? `About the Author now reads ${quoted(set)}` : "the About the Author page is gone";
      case "authorWebsite":
        return set !== null ? `the website on About the Author is now ${quoted(set)}` : text("removed", { field: field(key) });
      case "copyrightHolder":
        return set !== null ? `the copyright line now reads ${quoted(`© ${year} ${set}`)}`
          : authorName ? `the copyright line is back to ${quoted(`© ${year} ${authorName}`)}` : "the copyright line is gone";
      case "imprint":
        return set !== null ? `the publisher line now reads ${quoted(set)}` : "the publisher line is gone";
      case "isbn":
        return set !== null ? `the ISBN line now reads ${quoted(`ISBN ${set}`)}` : text("removed", { field: field(key) });
      case "dedication":
        return set !== null ? `the dedication now reads ${quoted(set)}` : text("removed", { field: field(key) });
      case "allRightsReserved":
        return text(value !== true ? "notPrinted" : holder ? "prints" : "needsHolder", { field: field(key) });
    }
  });
  return changed.length > 1 ? `${changed.slice(0, -1).join("; ")}; and ${changed.at(-1)}` : changed[0]!;
}
