/**
 * Markdown emphasis, links and escapes off — they are page syntax, and the
 * matter prints text.
 *
 * Every line of a manuscript's first and last pages comes through here on the
 * API's one event loop, and a plain-text import can be one 20 MB line. The four
 * inline rewrites below were regexes that read to the end of the line from
 * every `![`, `[`, `*` or `_` whose partner never came (`"**a "` repeated over
 * 30,000 characters took 2.2 s), so each is now one pass that returns exactly
 * what its regex returned. The regex each replaces is quoted above it.
 */
export function plainText(text: string, markdown: boolean): string {
  // A link or picture needs a `[`, and emphasis a `*` or `_`; most lines have neither.
  const linked = markdown && text.includes("[") ? withoutLinks(withoutImages(text)) : text;
  const emphasized = markdown && (linked.includes("*") || linked.includes("_")) ? withoutEmphasis(withoutStrongEmphasis(linked)) : linked;
  const plain = markdown
    ? emphasized
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^\s*>\s?/, "")
        .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    : text;
  return plain.replace(/[ \t]+/g, " ").trim();
}

/**
 * `/!\[([^\]]*)\]\([^)]*\)/g` → `$1`. Every `![` before a `]` stops at that
 * `]`, so one that fails there fails for all of them.
 */
function withoutImages(text: string): string {
  let result = "";
  let copied = 0;
  for (let at = text.indexOf("!["); at >= 0; ) {
    const close = text.indexOf("]", at + 2);
    if (close < 0) break;
    if (text[close + 1] !== "(") {
      at = text.indexOf("![", close + 1);
      continue;
    }
    const end = text.indexOf(")", close + 2);
    if (end < 0) break;
    result += text.slice(copied, at) + text.slice(at + 2, close);
    copied = end + 1;
    at = text.indexOf("![", copied);
  }
  return result + text.slice(copied);
}

/** The run of `[^)\s]` a link's address is, read where it starts. */
const LINK_ADDRESS = /[^)\s]+/y;

/**
 * `/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g` → the label, and the address after it
 * in parentheses when it is not the label itself.
 */
function withoutLinks(text: string): string {
  let result = "";
  let copied = 0;
  for (let at = text.indexOf("["); at >= 0; ) {
    const close = text.indexOf("]", at + 1);
    if (close < 0) break;
    LINK_ADDRESS.lastIndex = close + 2;
    const address = close > at + 1 && text[close + 1] === "(" ? LINK_ADDRESS.exec(text) : null;
    if (!address) {
      at = text.indexOf("[", close + 1);
      continue;
    }
    const end = text.indexOf(")", LINK_ADDRESS.lastIndex);
    if (end < 0) break;
    const label = text.slice(at + 1, close);
    result += text.slice(copied, at) + (label === address[0] ? label : `${label} (${address[0]})`);
    copied = end + 1;
    at = text.indexOf("[", copied);
  }
  return result + text.slice(copied);
}

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;
const WHITESPACE = /\s/;
const STRONG_OPENING = /\*\*(?=\S)|__(?=\S)/g;
const EMPHASIS_OPENING = /(?<![\p{L}\p{N}*_\\])[*_](?=\S)/gu;
const EMPHASIS_CLOSING = /(?<=\S)[*_](?![\p{L}\p{N}*_])/uy;

/**
 * A span opens on a delimiter and closes on the first one of the same kind
 * that may close it, on the same line: `.` stops at a line break. Where each
 * kind may close is found once, ascending, and both the next close and the
 * next line break are read with cursors that only move forward, because
 * openings are read left to right.
 */
function withoutSpans(
  text: string,
  opening: RegExp,
  closes: { "*": number[]; _: number[] },
  width: number
): string {
  const cursor = { "*": 0, _: 0 };
  let lineBreak = -1;
  let result = "";
  let copied = 0;
  opening.lastIndex = 0;
  for (let open = opening.exec(text); open; open = opening.exec(text)) {
    const mark = open[0][0] as "*" | "_";
    const list = closes[mark];
    // The body is at least one character, so the close is past it.
    while (cursor[mark] < list.length && list[cursor[mark]]! < open.index + width + 1) cursor[mark] += 1;
    const close = list[cursor[mark]];
    if (lineBreak < open.index + width) {
      LINE_TERMINATOR.lastIndex = open.index + width;
      lineBreak = LINE_TERMINATOR.exec(text)?.index ?? text.length;
    }
    if (close === undefined || lineBreak < close) {
      opening.lastIndex = open.index + 1;
      continue;
    }
    result += text.slice(copied, open.index) + text.slice(open.index + width, close);
    copied = close + width;
    opening.lastIndex = copied;
  }
  return result + text.slice(copied);
}

/**
 * `/(\*\*|__)(?=\S)(.*?\S)\1/g` → `$2`: a span opens on a pair before a
 * non-space and closes on the first same pair after a non-space, on its line.
 */
function withoutStrongEmphasis(text: string): string {
  if (!text.includes("**") && !text.includes("__")) return text;
  const closes = { "*": [] as number[], _: [] as number[] };
  for (let at = 1; at + 1 < text.length; at += 1) {
    const mark = text[at];
    if ((mark === "*" || mark === "_") && text[at + 1] === mark && !WHITESPACE.test(text[at - 1]!)) closes[mark].push(at);
  }
  return withoutSpans(text, STRONG_OPENING, closes, 2);
}

/**
 * `/(?<![\p{L}\p{N}*_\\])([*_])(?=\S)(.*?\S)\1(?![\p{L}\p{N}*_])/gu` → `$2`,
 * read the same way with its single marks. A span needs two of them.
 */
function withoutEmphasis(text: string): string {
  const first = text.search(/[*_]/);
  if (first < 0 || text.slice(first + 1).search(/[*_]/) < 0) return text;
  const closes = { "*": [] as number[], _: [] as number[] };
  for (let at = first + 1; at < text.length; at += 1) {
    const mark = text[at];
    if (mark !== "*" && mark !== "_") continue;
    EMPHASIS_CLOSING.lastIndex = at;
    if (EMPHASIS_CLOSING.test(text)) closes[mark].push(at);
  }
  return withoutSpans(text, EMPHASIS_OPENING, closes, 1);
}
