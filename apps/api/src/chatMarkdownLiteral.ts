/**
 * Reader text quoted inside an assistant chat reply, kept literal.
 *
 * Every assistant bubble is light markdown (projects CLAUDE.md, "Chat bubbles
 * are light markdown"): the app's parser (`chat_markdown.dart`, whose twin is
 * `chatMessagePlainText.ts`) reads `**bold**`, `*italic*` and `_italic_`,
 * `[label](https://…)` links and `[source:…]` citations anywhere, and headings,
 * quotes, list markers and code fences at the start of a line. A reply that
 * quoted the dedication "For *Mom*" showed "Mom" in italics, while the page
 * prints the asterisks.
 *
 * That parser has no escape syntax: a backslash is printed as a backslash. So
 * the text is kept literal with two invisible, default-ignorable characters,
 * placed where the parser's own rules refuse to see markup:
 *
 * - U+FEFF on both sides of every `*` and `_`. An emphasis opener needs a
 *   non-space character after it, and a closer needs one before it. Both
 *   parsers count U+FEFF as space: Dart's `String.trim` strips the BOM, and
 *   ECMAScript's `trim` treats U+FEFF as WhiteSpace. It also means `**` is
 *   never adjacent again, so no bold can open.
 * - U+2060 (word joiner) after every `[` and `]`, so neither `[source:` nor a
 *   link's `](` can match.
 * - U+2060 before a line the parser would start a block with. Neither regex
 *   engine counts it as `\s`, and neither `trim` strips it, so the line-start
 *   patterns fail. The test runs on the line *after* the U+FEFF marks are
 *   added, because they are `\s` to the list pattern: "**bold**" at the start
 *   of a line would otherwise turn into a bullet reading "*bold**".
 *
 * Use it for interpolated reader or matter text only. The reply's own markup
 * stays markup, and metadata keeps the raw text. If the parser ever learns
 * backslash escapes, this is the one place to switch.
 *
 * The marks are for the bubble only: `withoutChatMarkdownLiteral` takes them
 * back out of a saved reply before it is shown to a model again.
 *
 * Imports nothing, like `chatMessagePlainText.ts`.
 */

/** Must agree with `_isSpace` in both parsers: whitespace to `trim`, drawn as nothing. */
const SPACE_LIKE_INVISIBLE = "﻿";
/** Not whitespace to `\s` or `trim`, drawn as nothing. */
const JOINER = "⁠";

const EMPHASIS = /[*_]/g;
const BRACKET = /[[\]]/g;
/**
 * The line starts the parser recognises: a list item, a heading, a quote or a
 * fence (`_listPattern`, `_headingPattern`, `_quotePattern`, `_fencePattern`).
 * This is slightly wider than the parser, which is harmless because the mark it
 * adds is invisible.
 */
const OPENS_BLOCK = /^(?:\s*(?:[-*+•]|[0-9٠-٩۰-۹]{1,3}[.)])\s|\s{0,3}(?:#{1,6}\s|>)|\s*(?:```|~~~))/;
const LEADING_SPACE = /^\s*/;

export function chatMarkdownLiteral(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const lead = LEADING_SPACE.exec(line)?.[0] ?? "";
      const inline = line
        .slice(lead.length)
        .replace(EMPHASIS, `${SPACE_LIKE_INVISIBLE}$&${SPACE_LIKE_INVISIBLE}`)
        .replace(BRACKET, `$&${JOINER}`);
      return `${lead}${OPENS_BLOCK.test(`${lead}${inline}`) ? JOINER : ""}${inline}`;
    })
    .join("\n");
}

const LITERAL_MARKS = new RegExp(`[${SPACE_LIKE_INVISIBLE}${JOINER}]`, "g");

/**
 * A saved assistant reply as a model should read it: `chatMarkdownLiteral`
 * undone. The edit router and the matter composer are shown recent turns, and a
 * model that copies "For *Mom*" out of "the dedication now reads “For *Mom*”"
 * copied the marks with it — into a dedication that then printed them
 * invisibly, and whose words no longer matched the reader's.
 *
 * It drops the two marks wherever they stand rather than only where they were
 * put, because one that opened a quoted line sits mid-line in the reply. Neither
 * is anything a person types; U+200C and U+200D, which Persian, Indic scripts
 * and emoji need, are not touched.
 */
export function withoutChatMarkdownLiteral(text: string): string {
  return text.replace(LITERAL_MARKS, "");
}
