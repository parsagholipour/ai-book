/**
 * A chat message as it reads on screen, without the light markdown the app's
 * bubbles render (bold, list markers, headings, code, links).
 *
 * Previews and reply quotes clip a message to a line: they want "Wars of
 * Independence, early 1800s", not "1. **Wars of Independence**, early 1800s".
 * List markers are kept as text because a copied or quoted list should still
 * read as one. This is deliberately gentler than `markdownPlainText` in
 * `mobile/support.ts`, which strips page prose and treats every hyphen as
 * markup — "1780-1782" and "Peru-Bolivia" are prose here.
 *
 * Twin of `chatMessagePlainText` in `apps/mobile/lib/features/projects/domain/chat_markdown.dart`; they must agree.
 *
 * Imports nothing: `chatReplyQuote` is reached from `bookEditIntent`, whose
 * suite runs without the database mocks the mobile modules need.
 */

const FENCE = /^(```+|~~~+)/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+•]|[0-9\u0660-\u0669\u06F0-\u06F9]{1,3}[.)])\s+(.*)$/;
const CITATION = /^\[source:([a-zA-Z0-9_-]+):(\d+):(\d+)\]/;
const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;

/** ASCII, Arabic-Indic, or Persian digit → 0–9. */
function digitValue(code: number): number | null {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x0660 && code <= 0x0669) return code - 0x0660;
  if (code >= 0x06f0 && code <= 0x06f9) return code - 0x06f0;
  return null;
}

export function chatMessagePlainText(text: string): string {
  return parsePlainBlocks(text).join("\n").trim();
}

/** Twin of Dart `chatRoleUsesMarkdown` inverted: user text stays as typed. */
export function chatRoleIsUser(role: string): boolean {
  return role.toUpperCase() === "USER";
}

/**
 * Twin of Dart `chatBubbleCopyText`: user content as typed, assistant
 * content through `chatMessagePlainText`.
 */
export function chatMessagePreviewSource(role: string, content: string): string {
  return chatRoleIsUser(role) ? content : chatMessagePlainText(content);
}

function parsePlainBlocks(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  const paragraph: string[] = [];
  const quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(inlineText(paragraph.join("\n")));
    paragraph.length = 0;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push(inlineText(quote.join("\n")));
    quote.length = 0;
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") {
      flushAll();
      i += 1;
      continue;
    }
    if (FENCE.test(trimmed)) {
      flushAll();
      let closer = i + 1;
      while (closer < lines.length && !FENCE.test((lines[closer] ?? "").trim())) {
        closer += 1;
      }
      if (closer < lines.length) {
        blocks.push(lines.slice(i + 1, closer).join("\n"));
        i = closer + 1;
        continue;
      }
      // An opener with no closer is unrecognised markup, not a code block.
      blocks.push(inlineText(trimmed));
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push(inlineText((heading[1] ?? "").trim()));
      i += 1;
      continue;
    }
    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      quote.push((quoted[1] ?? "").trimEnd());
      i += 1;
      continue;
    }
    const item = LIST.exec(line);
    if (item) {
      flushAll();
      const indent = (item[1] ?? "").length;
      const marker = item[2] ?? "";
      const ordered = digitValue(marker.charCodeAt(0)) !== null;
      let body = (item[3] ?? "").trimEnd();
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (next.trim() === "" || LIST.test(next)) break;
        const nextIndent = /^\s*/.exec(next)?.[0].length ?? 0;
        if (nextIndent <= indent) break;
        body += `\n${next.trim()}`;
        i += 1;
      }
      const label = ordered ? marker : "•";
      blocks.push(`${label} ${inlineText(body)}`);
      continue;
    }
    flushQuote();
    paragraph.push(trimmed);
    i += 1;
  }
  flushAll();
  return blocks;
}

function inlineText(text: string): string {
  return parseInlinePlain(text).replace(/ {2,}/g, " ").trim();
}

function parseInlinePlain(text: string): string {
  const out: string[] = [];
  let buffer = "";
  let pos = 0;
  let bold = false;
  let italic = false;
  let boldCloseAt = -1;
  let italicCloseAt = -1;

  const flush = () => {
    if (buffer.length === 0) return;
    out.push(buffer);
    buffer = "";
  };

  while (pos < text.length) {
    if (pos === boldCloseAt) {
      flush();
      bold = false;
      boldCloseAt = -1;
      pos += 2;
      continue;
    }
    if (pos === italicCloseAt) {
      flush();
      italic = false;
      italicCloseAt = -1;
      pos += 1;
      continue;
    }
    const ch = text[pos] ?? "";
    if (ch === "[" && tryBracket()) continue;
    if (!bold && text.startsWith("**", pos) && tryBold()) continue;
    if (!italic && (ch === "*" || ch === "_") && tryItalic(ch)) continue;
    buffer += ch;
    pos += 1;
  }
  flush();
  return out.join("");

  function tryBracket(): boolean {
    const rest = text.slice(pos);
    const citation = CITATION.exec(rest);
    if (citation) {
      flush();
      pos += citation[0].length;
      return true;
    }
    const link = LINK.exec(rest);
    if (!link) return false;
    flush();
    out.push(link[1] ?? "");
    pos += link[0].length;
    return true;
  }

  function tryBold(): boolean {
    const close = closingIndex(text, "**", pos + 2);
    if (close === -1) return false;
    flush();
    bold = true;
    boldCloseAt = close;
    pos += 2;
    return true;
  }

  function tryItalic(marker: string): boolean {
    const next = text[pos + 1];
    if (next === undefined || isSpace(next)) return false;
    if (marker === "*" && pos > 0 && text[pos - 1] === "*") return false;
    if (marker === "_" && pos > 0 && isWordChar(text[pos - 1] ?? "")) return false;
    const close = closingIndex(text, marker, pos + 1, marker === "_");
    if (close === -1) return false;
    flush();
    italic = true;
    italicCloseAt = close;
    pos += 1;
    return true;
  }
}

function closingIndex(text: string, marker: string, from: number, wordBoundary = false): number {
  let search = from;
  while (true) {
    const index = text.indexOf(marker, search);
    if (index === -1) return -1;
    const prev = text[index - 1] ?? "";
    const inside = index > from && !isSpace(prev);
    const after = index + marker.length;
    const next = text[after];
    const boundary = !wordBoundary || next === undefined || !isWordChar(next);
    const partOfPair = marker === "*" && next === "*";
    if (inside && boundary && !partOfPair) return index;
    search = index + 1;
  }
}

function isSpace(ch: string): boolean {
  return ch.trim() === "";
}

function isWordChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    (code > 0x7f && ch.trim() !== "")
  );
}
