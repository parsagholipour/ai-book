import { describe, expect, it } from "vitest";
import { plainText } from "./manuscriptMatterPlainText.js";
import { LINEAR_TIME_CEILING_MS } from "./testing/linearTime.js";

function readMs(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let read = 0; read < 2; read += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** The regex chain `plainText` was: the answers it must keep. */
function regexPlainText(text: string, markdown: boolean): string {
  const plain = markdown
    ? text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label: string, url: string) => (label === url ? label : `${label} (${url})`))
        .replace(/(\*\*|__)(?=\S)(.*?\S)\1/g, "$2")
        .replace(/(?<![\p{L}\p{N}*_\\])([*_])(?=\S)(.*?\S)\1(?![\p{L}\p{N}*_])/gu, "$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^\s*>\s?/, "")
        .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    : text;
  return plain.replace(/[ \t]+/g, " ").trim();
}

const LINES = [
  "**The Long Winter**",
  "*A Novel* by __Jane Doe__",
  "_Dedicated_ to my *mother*",
  "Visit [my site](https://example.com \"title\") or [https://x.io](https://x.io)",
  "![cover](cover.png) and [] and [a]() and [a] (b)",
  "> A quoted line with `code` and \\*escaped\\* marks",
  "snake_case_names and 2*3*4 and **unclosed",
  "**a\nb** *c\u2028d* __e__f__",
  "*😀* _é_ **x** ***y*** *a**b*",
  "[![img](a.png)](b) [x](y z) [x](y)"
];

describe("matter plain text", () => {
  it("reads markdown exactly as the regexes did", () => {
    for (const line of LINES) {
      for (const markdown of [true, false]) expect(plainText(line, markdown), line).toBe(regexPlainText(line, markdown));
    }
    expect(plainText("**The Long Winter**", true)).toBe("The Long Winter");
    expect(plainText("Visit [my site](https://example.com)", true)).toBe("Visit my site (https://example.com)");
  });

  it("agrees with the regexes on random markdown", () => {
    const alphabet = ["*", "**", "_", "__", "[", "]", "(", ")", "![", "](", "`", "\\", ">", " ", "\n", "a", "B", "1", "é", "😀"];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let index = 0; index < 20_000; index += 1) {
      const line = Array.from({ length: Math.floor(next() * 16) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      expect(plainText(line, true), JSON.stringify(line)).toBe(regexPlainText(line, true));
    }
  });

  it("stays linear on marks whose partner never comes", () => {
    // Each took over a second at 60,000 characters as a regex.
    const adversarial: Array<[string, string]> = [
      ["strong", "**a "],
      ["emphasis", "*a "],
      ["underscores", "__a "],
      ["pictures", "!["],
      ["links", "["],
      ["link without address", "[a]("]
    ];
    for (const [label, unit] of adversarial) {
      for (const length of [6_000, 60_000]) {
        const line = unit.repeat(length / unit.length);
        const ms = readMs(() => plainText(line, true));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
      }
    }
  });
});
