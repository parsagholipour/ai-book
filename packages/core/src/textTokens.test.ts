import { describe, expect, it } from "vitest";
import { estimateTokensByScript, type ScriptTokenWeights } from "./textTokens.js";

/** What `estimateTokenCountFromText` prices a fallback call with. */
const COST: ScriptTokenWeights = { latinCharsPerToken: 4, denseCharsPerToken: 1 };
/** What `rewriteOutputTokenBudget` fuses an echo with. */
const ECHO: ScriptTokenWeights = { latinCharsPerToken: 2, denseCharsPerToken: 1 };

const flat = (text: string) => Math.ceil([...text].length / 4);

describe("estimateTokensByScript", () => {
  it("counts ASCII and Latin at the weight it was given", () => {
    expect(estimateTokensByScript("abcdefgh", COST)).toBe(2);
    expect(estimateTokensByScript("abcdefgh", ECHO)).toBe(4);
    expect(estimateTokensByScript("naïve café, 1999.", COST)).toBe(Math.ceil(17 / 4));
    expect(estimateTokensByScript("", COST)).toBe(0);
  });

  it("does not price a non-Latin script as four characters per token", () => {
    const samples = {
      persian: "نگهبان فانوس دریایی سه روز بود که نخوابیده بود",
      arabic: "لم ينم حارس المنارة منذ ثلاثة أيام",
      hebrew: "שומר המגדלור לא ישן שלושה ימים",
      hindi: "प्रकाशस्तंभ का रखवाला तीन दिनों से सोया नहीं था",
      thai: "ผู้ดูแลประภาคารไม่ได้นอนมาสามวันแล้ว",
      chinese: "灯塔看守人已经三天没有合眼了",
      japanese: "灯台守は三日も眠っていなかった",
      korean: "등대지기는 사흘째 잠을 자지 못했다"
    };

    for (const [script, text] of Object.entries(samples)) {
      const estimate = estimateTokensByScript(text, COST);
      // Every one of these is under-counted at least threefold by `chars / 4`.
      expect(estimate / flat(text), script).toBeGreaterThan(3);
      expect(estimate, script).toBeLessThanOrEqual([...text].length);
    }
  });

  it("rounds each class on its own rather than rounding the total once", () => {
    expect(estimateTokensByScript("abc", COST)).toBe(1);
    expect(estimateTokensByScript("你好吗", COST)).toBe(3);
    // One ceil over all six characters would say two; the classes say one and three.
    expect(Math.ceil(6 / 4)).toBe(2);
    expect(estimateTokensByScript("abc你好吗", COST)).toBe(4);
  });

  it("counts the spaces of a non-Latin sentence as Latin, because ASCII is ASCII", () => {
    // Deliberate: an ASCII space is a cheap token wherever it appears, which is
    // why a spaced script such as Korean or Persian lands under a spaceless one
    // such as Thai or Chinese rather than beside it.
    expect(estimateTokensByScript("你好 吗", COST)).toBe(3 + Math.ceil(1 / 4));
  });

  it("counts the punctuation an English page is printed with as Latin, not as a dense script", () => {
    // Each of these is `Script=Common`: owned by no script, so evidence of
    // none. Read as dense they cost four times their Latin rate, which is what
    // `[\p{ASCII}\p{Script=Latin}]` did to every curly quote the generator emits.
    // Spelled as escapes on purpose: a curly quote and a straight one are the
    // same glyph at a glance, and it is the difference under test.
    const shared = [
      "\u2014", // em dash
      "\u2013", // en dash
      "\u201C", // left double quotation mark
      "\u201D", // right double quotation mark
      "\u2019", // right single quotation mark, the apostrophe of printed prose
      "\u2026", // horizontal ellipsis
      "\u2022", // bullet
      "\u00A0", // no-break space
      "\u20AC", // euro sign
      "\u2192", // rightwards arrow
      "\u00AB", // left-pointing double angle quotation mark
      "\u00BB" // right-pointing double angle quotation mark
    ];
    for (const character of shared) {
      expect(estimateTokensByScript(character.repeat(100), COST), character).toBe(25);
      expect(estimateTokensByScript(character.repeat(100), ECHO), character).toBe(50);
    }
    // The Latin baseline they now match, and used to cost four times.
    expect(estimateTokensByScript("a".repeat(100), COST)).toBe(25);
    expect(estimateTokensByScript("\u00E9".repeat(100), COST)).toBe(25);
  });

  it("reports an English page at exactly `chars / 4`, typographic punctuation included", () => {
    // The invariant `estimateTokenCountFromText` states in its own words
    // (`apps/worker/src/providers/usageAccounting.ts`): four Latin characters
    // per token leaves every English number where the flat rule had it.
    const page =
      "The lighthouse keeper hadn\u2019t slept in three days \u2014 not since the light began to stutter. " +
      "\u201CIt\u2019s the lens,\u201D he told the gulls, who didn\u2019t answer. Each night the beam swept the " +
      "water, paused\u2026 and faltered, as though it had forgotten what it was for.";
    expect(estimateTokensByScript(page, COST)).toBe(flat(page));

    const dialogue = "\u201CI don\u2019t think so,\u201D she said \u2014 and the door closed\u2026";
    expect(estimateTokensByScript(dialogue, COST)).toBe(flat(dialogue));
    // What the same line cost while shared punctuation was read as dense.
    expect(flat(dialogue)).toBe(13);
  });

  it("keeps punctuation a script has claimed in that script's class", () => {
    // `Script=Common` says Common; `Script_Extensions` says Han, Arabic, or a
    // list without Common in it. The narrowing is the whole discrimination.
    const claimed = {
      ideographicStop: "\u3002",
      ideographicComma: "\u3001",
      cornerBracket: "\u300C",
      arabicQuestionMark: "\u061F",
      arabicComma: "\u060C",
      // The joiner Persian compounds are written with: Script=Inherited, and
      // its extensions are the scripts that use it, none of them Common.
      zeroWidthNonJoiner: "\u200C",
      arabicFathatan: "\u064B"
    };
    for (const [name, character] of Object.entries(claimed)) {
      expect(estimateTokensByScript(character.repeat(100), COST), name).toBe(100);
    }
    // A combining mark Unicode does narrow to Latin goes with the letter it sits on.
    expect(estimateTokensByScript("\u0301".repeat(100), COST)).toBe(25);
  });

  it("keeps pictographs dense, because an emoji is several tokens and not punctuation", () => {
    for (const pictograph of ["\u{1F642}", "\u00A9", "\u00AE", "\u2122", "\u2764"]) {
      expect(estimateTokensByScript(pictograph.repeat(100), COST), pictograph).toBe(100);
    }
    // No ASCII character is a pictograph, so the English rule above is safe.
    const ascii = Array.from({ length: 128 }, (_, code) => String.fromCodePoint(code)).join("");
    expect(estimateTokensByScript(ascii, COST)).toBe(Math.ceil(128 / 4));
  });

  it("still reads a mixed-script page as the dense script it is", () => {
    // A Persian page quoted with guillemets and dated with ASCII digits. The
    // shared characters went cheap; nothing about "this page is Persian" went
    // with them. `\u200C` is the joiner the compound is really written with,
    // `\u2014` an em dash, `\u00AB\u00BB` the guillemets Persian quotes with.
    const page =
      "\u00ABچراغ\u200Cدریایی\u00BB سه شب بود که چشم روی هم نگذاشته بود \u2014 و ساعت 12 شب بود.";
    const estimate = estimateTokensByScript(page, COST);
    expect(estimate / flat(page)).toBeGreaterThanOrEqual(3);
    expect(estimate).toBeLessThanOrEqual([...page].length);
    // The justification, stated as an equality: rewrite the same sentence with
    // ASCII punctuation of the same length and it counts identically. Three
    // shared characters changed class and the answer did not move, because a
    // quotation mark was never the evidence the page is Persian — the ZWNJ
    // inside the compound is, and that one is `scx` Persian and stayed dense.
    const straight = page.replace(/[\u00AB\u00BB]/gu, '"').replace(/\u2014/gu, "-");
    expect([...straight].length).toBe([...page].length);
    expect(estimateTokensByScript(straight, COST)).toBe(estimate);
  });

  it("counts code points, so a supplementary-plane character is one dense character", () => {
    // U+2070E, a Han ideograph outside the BMP: two UTF-16 units, one character.
    expect("\u{2070E}".length).toBe(2);
    expect(estimateTokensByScript("\u{2070E}", COST)).toBe(1);
  });
});

/**
 * The classifier exactly as it was written before {@link estimateTokensByScript}
 * became a code-unit walk with a memo: one allocated string per code point, one
 * anchored `/u` test each. The speed fix is allowed to change how the question
 * is asked and never the answer, so this is the answer every case below is
 * measured against.
 */
const REFERENCE_LATIN_PATTERN =
  /^(?!\p{Extended_Pictographic})[\p{ASCII}\p{Script_Extensions=Latin}\p{Script_Extensions=Common}]$/u;

function referenceEstimate(text: string, weights: ScriptTokenWeights): number {
  let latinChars = 0;
  let denseChars = 0;
  for (const character of text) {
    if (REFERENCE_LATIN_PATTERN.test(character)) {
      latinChars += 1;
    } else {
      denseChars += 1;
    }
  }
  return Math.ceil(latinChars / weights.latinCharsPerToken) + Math.ceil(denseChars / weights.denseCharsPerToken);
}

/** Every sample that disagrees, so one failure names all of them rather than the first. */
function disagreements(samples: Iterable<[string, string]>): string[] {
  const found: string[] = [];
  for (const [label, text] of samples) {
    for (const weights of [COST, ECHO]) {
      const expected = referenceEstimate(text, weights);
      if (estimateTokensByScript(text, weights) !== expected) {
        found.push(label);
        break;
      }
    }
  }
  return found;
}

describe("estimateTokensByScript answers exactly what the per-code-point classifier answered", () => {
  it("agrees on every code point in the BMP, one at a time", () => {
    // The memo is the new thing and the BMP is all of it, so this is exhaustive
    // rather than sampled — combining marks, ZWNJ, unassigned code points and
    // the lone surrogates U+D800–U+DFFF included.
    const samples: [string, string][] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      samples.push([`U+${code.toString(16).toUpperCase().padStart(4, "0")}`, String.fromCharCode(code)]);
    }
    expect(disagreements(samples)).toEqual([]);
  });

  it("agrees on the whole BMP concatenated, where adjacent units pair by accident", () => {
    // U+DBFF followed by U+DC00 is a well-formed pair in the middle of a run of
    // lone surrogates. Both implementations must read that pair the same way.
    const units: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      units.push(String.fromCharCode(code));
    }
    const sweep = units.join("");
    expect(estimateTokensByScript(sweep, COST)).toBe(referenceEstimate(sweep, COST));
    expect(estimateTokensByScript(sweep, ECHO)).toBe(referenceEstimate(sweep, ECHO));
  });

  it("agrees on supplementary-plane characters, pictographic and not", () => {
    const samples: [string, string][] = [];
    const push = (code: number) =>
      samples.push([`U+${code.toString(16).toUpperCase()}`, String.fromCodePoint(code)]);
    // Emoji, and the maths alphanumerics — `scx=Common`, so Latin — in full.
    for (let code = 0x1f000; code <= 0x1faff; code += 1) push(code);
    for (let code = 0x1d400; code <= 0x1d7ff; code += 1) push(code);
    // Everything else above the BMP, strided: the path there is the same
    // anchored test the reference makes, so breadth matters more than density.
    for (let code = 0x10000; code <= 0x10ffff; code += 13) push(code);
    expect(disagreements(samples)).toEqual([]);
  });

  it("agrees on strings that put surrogates in every awkward position", () => {
    const lead = "\uD83D";
    const trail = "\uDE42";
    const samples: [string, string][] = [
      ["well-formed pair", `${lead}${trail}`],
      ["pair at the end of prose", `hello ${lead}${trail}`],
      ["lone lead at the very end", `hello ${lead}`],
      ["lone lead mid-string", `${lead}hello`],
      ["lone trail mid-string", `${trail}hello`],
      ["trail before lead, which must not pair", `${trail}${lead}`],
      ["lead, ASCII, trail — split by a character", `${lead}a${trail}`],
      ["two leads then a trail", `${lead}${lead}${trail}`],
      ["a lead then two trails", `${lead}${trail}${trail}`],
      ["pairs back to back", `${lead}${trail}${lead}${trail}`],
      ["lone lead then a dense BMP character", `${lead}ب`],
      ["a supplementary Han ideograph", "\u{2070E}"],
      ["a skin-tone sequence", "\u{1F44B}\u{1F3FD}"],
      ["a ZWJ family sequence", "\u{1F468}‍\u{1F469}‍\u{1F467}"],
      ["a regional-indicator flag", "\u{1F1EE}\u{1F1F7}"],
      ["combining marks on Latin and on Arabic", "é بً"],
      ["a Persian compound joined with ZWNJ", "چراغ‌دریایی"],
      ["empty", ""],
      ["one ASCII space", " "]
    ];
    expect(disagreements(samples)).toEqual([]);
  });

  it("agrees on realistic prose, and on a 200,000-character mixed page", () => {
    const paragraphs: [string, string][] = [
      ["english", "The lighthouse keeper hadn’t slept in three days — not since the light began to stutter…"],
      ["persian", "«چراغ‌دریایی» سه شب بود که چشم روی هم نگذاشته بود — و ساعت 12 شب بود."],
      ["arabic", "لم ينم حارس المنارة منذ ثلاثة أيام؟ والبحر ساكن، والريح باردة."],
      ["hebrew", "שומר המגדלור לא ישן שלושה ימים."],
      ["hindi", "प्रकाशस्तंभ का रखवाला तीन दिनों से सोया नहीं था।"],
      ["thai", "ผู้ดูแลประภาคารไม่ได้นอนมาสามวันแล้ว"],
      ["chinese", "灯塔看守人已经三天没有合眼了。「是透镜的问题。」他对海鸥说、海鸥没有回答。"],
      ["japanese", "灯台守は三日も眠っていなかった。"],
      ["korean", "등대지기는 사흘째 잠을 자지 못했다."],
      ["emoji and marks", "Ship it \u{1F642} © 2026 — café naïve ™"]
    ];
    expect(disagreements(paragraphs)).toEqual([]);

    // The size the finish-book chapter review actually reaches, so the walk is
    // exercised over a long string rather than only over samples.
    let page = "";
    while (page.length < 200_000) {
      page += paragraphs.map(([, text]) => text).join("\n\n") + "\n\n";
    }
    expect(estimateTokensByScript(page, COST)).toBe(referenceEstimate(page, COST));
    expect(estimateTokensByScript(page, ECHO)).toBe(referenceEstimate(page, ECHO));
  });

  it("answers the same with a warm memo as with a cold one", () => {
    // The classification table is module-global and survives every call, so a
    // character seen inside one string must be read the same way in the next.
    const first = estimateTokensByScript("چراغ‌دریایی — 灯塔 \u{1F642}", COST);
    const second = estimateTokensByScript("چراغ‌دریایی — 灯塔 \u{1F642}", COST);
    expect(second).toBe(first);
    expect(first).toBe(referenceEstimate("چراغ‌دریایی — 灯塔 \u{1F642}", COST));
  });
});
