import { describe, expect, it } from "vitest";
import { CONVERSATION_LANGUAGES } from "../prompting/conversationLanguage.js";
import { LANGUAGE_NAME_CODES, languageLabel } from "../prompting/language.js";
import { scriptProfileForLanguage } from "../prompting/script.js";
import { DEFAULT_MARKDOWN_LABELS, markdownLabels, type MarkdownLabels } from "./markdownLabels.js";

// Every language a book can be written in: the ones the app offers, and every
// one the chat can name. A language missing from the table prints English
// chrome — "About the Author", "All rights reserved." — inside its own book.
const BOOK_LANGUAGES = [...new Set([...CONVERSATION_LANGUAGES, ...Object.values(LANGUAGE_NAME_CODES)])].filter(
  (code) => code !== "en"
);
const LABEL_KEYS = Object.keys(DEFAULT_MARKDOWN_LABELS) as Array<keyof MarkdownLabels>;

describe("markdownLabels", () => {
  it.each(BOOK_LANGUAGES)("labels a %s book in its own language", (code) => {
    const labels = markdownLabels(code);
    expect(labels).not.toBe(DEFAULT_MARKDOWN_LABELS);
    expect(Object.keys(labels).sort()).toEqual([...LABEL_KEYS].sort());
    for (const key of LABEL_KEYS) {
      expect(labels[key].trim(), key).not.toBe("");
    }
    // No language words these the English way; only the brand stays in Latin script.
    for (const key of ["by", "aboutAuthor", "allRightsReserved", "madeWithTomeza"] as const) {
      expect(labels[key], key).not.toBe(DEFAULT_MARKDOWN_LABELS[key]);
    }
    expect(labels.madeWithTomeza).toContain("Tomeza");
  });

  it.each(BOOK_LANGUAGES)("reads %s by code, name and region tag, as its script profile does", (code) => {
    const name = languageLabel(code);
    for (const spelling of [name, name.toLowerCase(), ` ${name.toUpperCase()} `, `${code}-ZZ`, `${code}_ZZ`]) {
      expect(markdownLabels(spelling), spelling).toBe(markdownLabels(code));
      expect(scriptProfileForLanguage(spelling), spelling).toBe(scriptProfileForLanguage(code));
    }
  });

  it.each([
    ["he-IL", "hebrew"],
    ["iw", "hebrew"],
    ["Hebrew", "hebrew"],
    ["th-TH", "thai"],
    ["nb", "norwegian"],
    ["nb-NO", "norwegian"],
    ["no", "norwegian"],
    ["Norwegian", "norwegian"],
    ["pt-BR", "portuguese"],
    ["zh-TW", "chinese"]
  ])("reads %s as %s", (spelling, name) => {
    expect(markdownLabels(spelling)).toBe(markdownLabels(name));
  });

  it("keeps English, and anything it cannot place, on the one default object", () => {
    for (const language of [undefined, "", "en", "en-GB", "English", "Klingon", "am", "xx-YY"]) {
      expect(markdownLabels(language)).toBe(DEFAULT_MARKDOWN_LABELS);
    }
  });
});
