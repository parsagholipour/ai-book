import { describe, expect, it } from "vitest";
import { chatMarkdownLiteral, withoutChatMarkdownLiteral } from "./chatMarkdownLiteral.js";
import { chatMessagePlainText } from "./chatMessagePlainText.js";

/**
 * Read through `chatMessagePlainText`, the server twin of the app's bubble
 * parser: text that comes back exactly as typed, once the invisible marks are
 * removed, was drawn as text rather than markup.
 */
const invisible = /[﻿⁠]/g;
const asDrawn = (text: string) => chatMessagePlainText(text).replace(invisible, "");
const inReply = (text: string) => `Done — the dedication now reads “${text}”. This one’s free.`;

describe("reader text quoted in a chat reply", () => {
  it.each([
    ["italic asterisks", "For *Mom*", "For Mom"],
    ["italic underscores", "For _Mom_ and snake_case", "For Mom and snake_case"],
    ["bold", "**For** Mom", "For Mom"],
    ["bold that opens before a space", "** hi** there", "hi there"],
    ["a link", "Visit [my site](https://sam.example)", "Visit my site"],
    ["a citation token", "See [source:abc:1:2] here", "See here"]
  ])("keeps %s literal", (_name, text, unescaped) => {
    // The parser really would have read it as markup…
    expect(asDrawn(text)).toBe(unescaped);
    // …and the escaped text survives as typed, alone and inside a reply.
    expect(asDrawn(chatMarkdownLiteral(text))).toBe(text);
    expect(asDrawn(inReply(chatMarkdownLiteral(text)))).toBe(inReply(text));
  });

  it("keeps lines that would start a list, heading, quote or code block as plain lines", () => {
    const dedication = "For my kids:\n1. Sam\n- Lee\n* Max\n• Al\n۱. Dara\n# One\n> two\n```\ncode\n```\n**Bold** start";
    expect(asDrawn(dedication)).not.toBe(dedication);
    expect(asDrawn(chatMarkdownLiteral(dedication))).toBe(dedication);
    expect(asDrawn(inReply(chatMarkdownLiteral(dedication)))).toBe(inReply(dedication));
  });

  it("is undone exactly before a saved reply is shown to a model again", () => {
    const dedication = "1. For *Mom*\n- and _Dad_\n**Bold** [x](https://a.example)";
    expect(withoutChatMarkdownLiteral(chatMarkdownLiteral(dedication))).toBe(dedication);
    // The mark that opens a quoted line sits mid-line once the line is quoted.
    expect(withoutChatMarkdownLiteral(inReply(chatMarkdownLiteral(dedication)))).toBe(inReply(dedication));
    // The joiners Persian, Indic scripts and emoji are spelled with are not ours.
    for (const text of ["تقدیم به مادرم\u200cها", "क्\u200dष", "👩\u200d👩\u200d👧"]) {
      expect(withoutChatMarkdownLiteral(chatMarkdownLiteral(text))).toBe(text);
    }
  });

  it("leaves text with no markup in it untouched", () => {
    for (const text of ["For Dad and my mom", "ISBN 978-0-306-40615-7", "© 2026 Sam Lee", "تقدیم به مادرم‌ و پدرم", "https://sam.example"]) {
      expect(chatMarkdownLiteral(text)).toBe(text);
    }
  });
});
