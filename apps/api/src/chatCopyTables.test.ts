import { describe, expect, it } from "vitest";
import { CONVERSATION_LANGUAGES, type BookMatterChatCurrent, type ConversationLanguage, type PdfPageZone } from "@book-maker/core";
import { FURNITURE_REPLY_COPY, furnitureReply } from "./bookFurnitureReplyCopy.js";
import type { ChatCopyTable } from "./chatReplyCopy.js";
import { BUSY_EDIT_COPY, busyEditMessage } from "./mobile/bookEditBusyCopy.js";
import { MATTER_CHAT_COPY } from "./mobile/bookMatterChatCopy.js";
import { localizedMatterChatReplies } from "./mobile/bookMatterChatReplies.js";
import { BOOK_TITLE_CHAT_COPY, bookTitleReply, type BookTitleNotice } from "./mobile/bookTitleChatCopy.js";
import { PROJECT_CHAT_REPLY_COPY } from "./mobile/projectChatReplyCopy.js";
import { TOMEZA_CREDIT_CHAT_COPY } from "./mobile/tomezaCreditChatCopy.js";

/**
 * Every table of the chat's fixed replies, held to its English entry: the same
 * languages, the same keys, the same placeholders, the same specifics — so a
 * sentence that changes in English and not beside it fails here rather than
 * drifting in front of a reader. A table added to `chatReplyCopy.ts`'s list
 * belongs in `TABLES`.
 */
const TABLES: Record<string, { table: ChatCopyTable<unknown>; fills: readonly string[]; digits?: true }> = {
  furniture: { table: FURNITURE_REPLY_COPY, fills: ["page", "range"] },
  matter: { table: MATTER_CHAT_COPY, fills: ["field", "value", "limit", "length", "request", "reason"], digits: true },
  tomezaCredit: { table: TOMEZA_CREDIT_CHAT_COPY, fills: [] },
  busyEdit: { table: BUSY_EDIT_COPY, fills: [] },
  projectChat: { table: PROJECT_CHAT_REPLY_COPY, fills: [] },
  bookTitle: { table: BOOK_TITLE_CHAT_COPY, fills: ["title"] }
};

/**
 * Placeholders only the English entry fills: the content screen's refusal and
 * the matter write's own sentence are English prose, so no other language may
 * quote them.
 */
const ENGLISH_ONLY: Record<string, readonly string[]> = {
  "matter.messages.restricted": ["reason"],
  "matter.messages.busy": ["reason"],
  "matter.messages.isbnRefused": ["reason"]
};

/** Field names may be the same word in English and a translation ("ISBN", Dutch "website"); sentences may not. */
const mayMatchEnglish = (path: string) => path.startsWith("matter.fields.");

const placeholders = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!));

/** The word "credit" in the languages the app speaks, for the price check. */
const CREDIT_WORD =
  "credit|crédit|crédito|credito|kredit|kredi|kredyt|кредит|πίστωσ|μονάδ|קרדיט|เครดิต|tín dụng|点数|积分|クレジット|크레딧|क्रेडिट|کریڈٹ|اعتبار|رصيد|Guthaben";
/** A number beside a credit word, either way round: a price, which the badge carries and the reply never does. */
const NAMES_A_PRICE = new RegExp(`\\p{Nd}[\\p{Nd}\\s.,٬’']*\\s*(?:${CREDIT_WORD})|(?:${CREDIT_WORD})\\S*\\s*[:：]?\\s*\\p{Nd}`, "iu");

/** Every string in an entry, by its path inside the entry. */
function leaves(value: unknown, path: string, out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) leaves(child, `${path}.${key}`, out);
  } else {
    out.set(path, value);
  }
  return out;
}

describe("chat copy tables", () => {
  const languages = [...CONVERSATION_LANGUAGES].sort();

  it.each(Object.keys(TABLES))("%s has one entry per conversation language, each shaped like English's", (name) => {
    const { table, fills, digits } = TABLES[name]!;
    expect(Object.keys(table).sort()).toEqual(languages);
    const english = leaves(table.en, name);
    for (const language of CONVERSATION_LANGUAGES) {
      const entry = leaves(table[language], name);
      expect([...entry.keys()].sort(), language).toEqual([...english.keys()].sort());
      for (const [path, value] of entry) {
        const at = `${language} ${path}`;
        const source = english.get(path);
        expect(typeof value, at).toBe(typeof source);
        if (typeof value !== "string" || typeof source !== "string") continue;
        expect(value.trim().length, at).toBeGreaterThan(0);
        const own = placeholders(value);
        const englishOnly = new Set(ENGLISH_ONLY[path] ?? []);
        for (const key of own) expect(fills, `${at} {${key}}`).toContain(key);
        for (const key of placeholders(source)) {
          if (englishOnly.has(key)) {
            if (language !== "en") expect(own.has(key), `${at} quotes English-only {${key}}`).toBe(false);
          } else {
            expect(own.has(key), `${at} lost {${key}}`).toBe(true);
          }
        }
        expect(value, at).not.toMatch(NAMES_A_PRICE);
        if (!digits) expect(value, at).not.toMatch(/\p{Nd}/u);
        if (language !== "en" && !mayMatchEnglish(path) && /\p{L}{3}/u.test(source)) {
          expect(value, `${at} is still English`).not.toBe(source);
        }
      }
    }
  });

  it("keeps the app's English button names in every title proposal and the literal “apply it” in every busy reply", () => {
    for (const language of CONVERSATION_LANGUAGES) {
      expect(BOOK_TITLE_CHAT_COPY[language].proposal, language).toMatch(/Apply[\s\S]*Cancel/);
      for (const execute of [true, false]) expect(busyEditMessage(language, execute), language).toContain("apply it");
    }
  });
});

/**
 * The composed replies, filled with sentinel values: whatever English carries
 * of a value — a quoted name, the reader's left-over request, a printed page —
 * every language carries too, and nothing is left unfilled.
 */
describe("composed chat replies carry English's specifics", () => {
  const SENTINELS = {
    authorName: "ZQXAUTHOR", dedication: "ZQXDEDICATION", aboutAuthor: "ZQXABOUT", authorWebsite: "ZQXSITE",
    copyrightHolder: "ZQXHOLDER", imprint: "ZQXIMPRINT", isbn: "ZQXISBN"
  } as const;
  const empty: BookMatterChatCurrent = {
    authorName: null, dedication: null, aboutAuthor: null, authorWebsite: null,
    copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false
  };
  const year = "ZQXYEAR";

  function composed(language: ConversationLanguage): Record<string, string> {
    const replies = localizedMatterChatReplies(language);
    const filled = { ...empty, ...SENTINELS, allRightsReserved: true };
    const out: Record<string, string> = {
      set: replies.change({ ...SENTINELS, allRightsReserved: true }, empty, year, { reprint: "queued", cover: "retypeset" }),
      pendingWebsite: replies.change({ authorWebsite: "ZQXSITE" }, empty, year, { reprint: "next_compile", cover: "unchanged" }),
      cleared: replies.change(
        { dedication: null, aboutAuthor: null, authorWebsite: null, copyrightHolder: null, imprint: null, isbn: null, allRightsReserved: false },
        filled, year, { reprint: "next_compile", cover: "keeps_old_name" }
      ),
      unchanged: replies.change({ ...SENTINELS, allRightsReserved: true }, filled, year, { reprint: "none", cover: "unchanged" }),
      leftOverQuoted: replies.leftOver("ZQXREQUEST"),
      leftOver: replies.leftOver(),
      restricted: replies.restricted(["dedication", "aboutAuthor"], "ZQXREASON"),
      busy: replies.saveRefused({ code: "PROJECT_BUSY", message: "ZQXREASON" }),
      isbnRefused: replies.saveRefused({ code: "INVALID_ISBN", message: "ZQXREASON" }),
      studio: replies.saveRefused({ code: "SET_IN_STUDIO", message: "ZQXREASON" }),
      titleAnswer: replies.titleAnswer,
      secondQuestion: replies.secondQuestion,
      rightsOn: replies.none("copyright_line", { ...empty, allRightsReserved: true }),
      rightsOff: replies.none("copyright_line", empty),
      notMatter: replies.none("not_matter", empty)
    };
    for (const spent of [true, false]) {
      out[`tooLong${spent}`] = replies.problem({ kind: "too_long", field: "aboutAuthor", length: 1500, limit: 1200 }, spent);
      out[`isbn${spent}`] = replies.problem({ kind: "invalid_isbn" }, spent);
      out[`notGivenProse${spent}`] = replies.problem({ kind: "not_given", field: "dedication" }, spent);
      out[`notGivenValue${spent}`] = replies.problem({ kind: "not_given", field: "imprint" }, spent);
      out[`runsOn${spent}`] = replies.problem({ kind: "runs_on", field: "dedication" }, spent);
    }
    const zones: Array<[string, PdfPageZone, "title_page" | "matter_sheet" | undefined, { sources: boolean; aboutAuthor: boolean } | undefined]> = [
      ["cover", "cover", undefined, undefined], ["contents", "contents", undefined, undefined],
      ["title", "front_matter", "title_page", undefined], ["sheet", "front_matter", "matter_sheet", undefined],
      ["front", "front_matter", undefined, undefined], ["sources", "back_matter", undefined, { sources: true, aboutAuthor: false }],
      ["author", "back_matter", undefined, { sources: false, aboutAuthor: true }],
      ["both", "back_matter", undefined, { sources: true, aboutAuthor: true }], ["back", "back_matter", undefined, undefined],
      ["outside", "outside", undefined, undefined]
    ];
    for (const [key, zone, front, back] of zones) {
      out[`furniture.${key}`] = furnitureReply(language, 9876, zone, front, back, "ZQXRANGE");
    }
    for (const notice of Object.keys(BOOK_TITLE_CHAT_COPY.en) as BookTitleNotice[]) {
      out[`title.${notice}`] = bookTitleReply(language, notice, "ZQXTITLE");
    }
    return out;
  }

  const english = composed("en");
  const sentinels = (text: string) => new Set(text.match(/ZQX[A-Z]+|9876/g) ?? []);

  it.each(CONVERSATION_LANGUAGES.filter((language) => language !== "en"))("%s", (language) => {
    for (const [key, text] of Object.entries(composed(language))) {
      expect(text, `${language} ${key}`).not.toMatch(/\{\w+\}|undefined/);
      const carried = sentinels(text);
      for (const value of sentinels(english[key]!)) {
        if (value === "ZQXREASON") expect(carried.has(value), `${language} ${key} quotes English prose`).toBe(false);
        else expect(carried.has(value), `${language} ${key} lost ${value}`).toBe(true);
      }
    }
  });

  it("English quotes the screen's and the write's own sentences", () => {
    expect(english.restricted).toBe("Sorry, I can’t print that dedication and About the Author text. ZQXREASON");
    expect(english.busy).toBe("ZQXREASON");
    expect(english.isbnRefused).toBe("ZQXREASON");
    expect(Object.values(english).join(" ")).not.toMatch(/\{\w+\}|undefined/);
  });
});
