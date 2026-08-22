import { describe, expect, it } from "vitest";
import {
  countReadableWords,
  hasExcessiveDashUse,
  narrationOutsideQuotedSpeech,
  sentenceLengthStats,
  splitSentences
} from "./proseShape.js";

/**
 * `pagesLocalQa.test.ts` next door exercises these five through the gates that
 * read them, which is where a wrong measurement is *felt* — a page rejected for
 * being "too short" that a reader would call long. What that suite cannot reach
 * is the rule itself: a gate firing tells you the count was wrong, never which
 * script's rule got it wrong. So everything here is a count, a split or a strip
 * asserted directly, and the cases are the ones the module's own docstrings name
 * as the reason it exists.
 */

describe("countReadableWords", () => {
  it("counts one word per run in a space-separated script", () => {
    expect(countReadableWords("The quick brown fox jumps.")).toBe(5);
    expect(countReadableWords("3 dogs and 12 cats")).toBe(5);
    // No Hangul in the CJK class on purpose: Korean puts spaces between its
    // words, so the run count is already the word count and halving it would
    // report a full Korean page as half a page.
    expect(countReadableWords("여우가 달을 봅니다")).toBe(3);
  });

  it("keeps a contraction one word under either apostrophe", () => {
    // Providers write the typographic U+2019 far more often than the ASCII one,
    // and the intra-word joiner class has to name both or `don’t` splits into
    // two words where `don't` stays one — the same page then measures longer in
    // the spelling every model actually emits.
    expect(countReadableWords("don't")).toBe(1);
    expect(countReadableWords("don’t")).toBe(1);
    expect(countReadableWords("It's Mira's fault, isn't it?")).toBe(5);
    expect(countReadableWords("It’s Mira’s fault, isn’t it?")).toBe(5);
  });

  it("keeps a hyphenated compound one word", () => {
    expect(countReadableWords("well-known")).toBe(1);
    expect(countReadableWords("a twenty-four-hour watch")).toBe(3);
  });

  it("counts a CJK character as half a word", () => {
    expect(countReadableWords("今天天气很好。")).toBe(3);
    // Nine Han characters between the punctuation marks: one `\p{L}` run, and
    // counting runs is what reported this whole sentence as one word.
    expect(countReadableWords("小狐狸抬头看着月亮。")).toBe(5);
  });

  it("keeps a shared character in the word it lengthens", () => {
    // ー is Common by Script, and Katakana only by Script_Extensions. Classified
    // by Script it falls through to the spaced branch, and the run then pays
    // ceil(7/2) for its kana *plus* a whole word for the prolonged sound mark:
    // five, for eight characters of Japanese.
    expect(countReadableWords("ラーメンを食べた。")).toBe(4);
  });

  it("rounds each run up on its own", () => {
    // Deliberately unlike `measureWords` in `manuscriptQuality.ts`, which sums
    // the characters over a whole page and rounds once: two one-character runs
    // are two words here and one there. Per-run rounding is what keeps a short
    // run from measuring as no words at all.
    expect(countReadableWords("山 川")).toBe(2);
    expect(countReadableWords("山川")).toBe(1);
  });

  it("counts an unsegmented Southeast Asian character as a quarter of a word", () => {
    // Seventeen base characters, so five words — a Thai clause is one run, and
    // counting runs made a normal page "too short to show meaningful
    // progression" and burned its whole revision budget failing that.
    expect(countReadableWords("เด็กน้อยมองดูดวงจันทร์")).toBe(5);
    expect(countReadableWords("เด็กน้อยมองดูดวงจันทร์ แล้วยิ้ม")).toBe(7);
    // Four base characters of Khmer, so one word. The estimate is rough in both
    // directions by design — what it buys is a gate that means something rather
    // than one that fires on every page of the script.
    expect(countReadableWords("គាត់ដើរ")).toBe(1);
  });

  it("folds a combining mark into the letter it modifies rather than the divisor", () => {
    // The Thai clause above carries five marks. Feeding them to the divisor
    // reads 22 characters where a reader sees 17 and inflates the count to six;
    // splitting the run on them would be worse still.
    expect(countReadableWords("เด็กน้อยมองดูดวงจันทร์")).toBe(5);
    // Devanagari matras are Mn/Mc, so a `\p{L}+` tokenizer breaks every one of
    // these words in half.
    expect(countReadableWords("मीरा")).toBe(1);
    expect(countReadableWords("मीरा चाँद को देखती है")).toBe(5);
    // Vocalized Arabic, for the same reason.
    expect(countReadableWords("الْكِتَابُ")).toBe(1);
  });

  it("counts an Arabic-script page by its runs", () => {
    expect(countReadableWords("کتاب را خواندم")).toBe(3);
    expect(countReadableWords("او کتاب را خواند و سپس خوابید")).toBe(7);
  });

  it("counts a mixed-script page in both scripts at once", () => {
    expect(countReadableWords("The fox 看着月亮 tonight")).toBe(5);
    // One run holding both: two Han characters are one word, and the Latin in
    // the same run is a word of its own rather than being swallowed by it.
    expect(countReadableWords("Wi-Fi连接")).toBe(2);
  });

  it("counts nothing in text with no letters or digits", () => {
    expect(countReadableWords("")).toBe(0);
    expect(countReadableWords("…—!! ()")).toBe(0);
    // A stranded combining mark modifies nothing, so it is not a word either.
    expect(countReadableWords("ा")).toBe(0);
  });
});

describe("splitSentences", () => {
  it("splits on a spaced terminator", () => {
    expect(splitSentences("One fell. Two rose! Three waited?")).toEqual([
      "One fell.",
      "Two rose!",
      "Three waited?"
    ]);
  });

  it("does not split an unspaced ASCII terminator", () => {
    // The other side of the rule above: that branch requires the whitespace,
    // which is what keeps a decimal or a URL from ending a sentence.
    expect(splitSentences("One fell.Two rose.")).toEqual(["One fell.Two rose."]);
  });

  it("lets closing quotes ride along with a spaced terminator", () => {
    expect(splitSentences('"Run," she said. "Now." He ran.')).toEqual([
      '"Run," she said.',
      '"Now."',
      "He ran."
    ]);
    expect(splitSentences("“Run,” she said. “Now.” He ran.")).toEqual([
      "“Run,” she said.",
      "“Now.”",
      "He ran."
    ]);
    expect(splitSentences("She said «برو.» سپس رفت.")).toEqual(["She said «برو.»", "سپس رفت."]);
  });

  it("splits on the Arabic-script and ellipsis terminators", () => {
    expect(splitSentences("چه شد؟ او رفت.")).toEqual(["چه شد؟", "او رفت."]);
    expect(splitSentences("وہ گیا۔ پھر آیا۔")).toEqual(["وہ گیا۔", "پھر آیا۔"]);
    expect(splitSentences("He waited… She left.")).toEqual(["He waited…", "She left."]);
  });

  it("splits a full-width CJK terminator with no space after it", () => {
    // Nothing follows 。 in Chinese or Japanese, so the spaced branch never
    // fires: a zh/ja page came back as one "sentence" whose word count was the
    // whole page, the kids sentence-length gate fired on every page of it, and
    // no rewrite could satisfy a gate measuring the page against itself.
    expect(splitSentences("今天天气很好。我们去公园。孩子笑了！")).toEqual([
      "今天天气很好。",
      "我们去公园。",
      "孩子笑了！"
    ]);
    expect(splitSentences("គាត់ដើរ។ គាត់ឈប់។")).toEqual(["គាត់ដើរ។", "គាត់ឈប់។"]);
  });

  it("lets a corner bracket ride along with the CJK terminator it closes", () => {
    // Without the lookahead the boundary lands between 。 and 」, and the next
    // sentence opens on a stray closing bracket.
    expect(splitSentences("她说「快跑。」他跑了。")).toEqual(["她说「快跑。」", "他跑了。"]);
    expect(splitSentences("她说『快跑。』他跑了。")).toEqual(["她说『快跑。』", "他跑了。"]);
  });

  it("reads the space itself as the sentence mark in an unsegmented script", () => {
    expect(splitSentences("เด็กน้อยมองดูดวงจันทร์ แล้วยิ้ม ราตรีสวัสดิ์")).toEqual([
      "เด็กน้อยมองดูดวงจันทร์",
      "แล้วยิ้ม",
      "ราตรีสวัสดิ์"
    ]);
  });

  it("normalises whitespace before it matches", () => {
    // A model hard-wraps its paragraphs, so the newline is inside the sentence
    // as often as it is between two — the sentence a caller measures or quotes
    // back has to be one line either way.
    expect(splitSentences("One\n  fell.\tTwo rose.")).toEqual(["One fell.", "Two rose."]);
    expect(splitSentences("One   fell.     Two rose.")).toEqual(["One fell.", "Two rose."]);
    expect(splitSentences("One fell.\n\n   Two rose.")).toEqual(["One fell.", "Two rose."]);
  });

  it("trims each sentence and drops the empty ones", () => {
    expect(splitSentences("  One fell.  ")).toEqual(["One fell."]);
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n\t ")).toEqual([]);
  });
});

describe("sentenceLengthStats", () => {
  it("averages the readable words per sentence and reports the longest", () => {
    expect(sentenceLengthStats("One two three four five. Six seven.")).toEqual({
      average: 3.5,
      max: 5
    });
  });

  it("ignores a sentence carrying no readable words", () => {
    // A bare ellipsis is a sentence to the splitter and no words to the counter;
    // averaging the zero in would report every page with one as shorter than it
    // reads, which is the direction that costs a good page its revisions.
    expect(sentenceLengthStats("One two three. ... Four five.")).toEqual({ average: 2.5, max: 3 });
  });

  it("measures a CJK page sentence by sentence, not as one run", () => {
    // Three words each, because both halves of this module know 。 ends a
    // sentence and two Han characters are a word. Either rule alone reports
    // this page as a single six-word sentence.
    expect(sentenceLengthStats("今天天气很好。我们去公园。")).toEqual({ average: 3, max: 3 });
  });

  it("measures Thai and Persian pages the same way", () => {
    expect(sentenceLengthStats("เด็กน้อยมองดูดวงจันทร์ แล้วยิ้ม")).toEqual({ average: 3.5, max: 5 });
    expect(sentenceLengthStats("او کتاب را خواند. سپس خوابید.")).toEqual({ average: 3, max: 4 });
  });

  it("reports zeros for a page with nothing to measure", () => {
    expect(sentenceLengthStats("")).toEqual({ average: 0, max: 0 });
    expect(sentenceLengthStats("... !!! ???")).toEqual({ average: 0, max: 0 });
  });
});

describe("narrationOutsideQuotedSpeech", () => {
  it("collapses a quoted span to a single space", () => {
    expect(narrationOutsideQuotedSpeech('She waited. "Come in," he said.')).toBe(
      "She waited.   he said."
    );
    expect(narrationOutsideQuotedSpeech("She waited. “Come in,” he said.")).toBe(
      "She waited.   he said."
    );
  });

  it("knows every opener in the table and the closers it takes", () => {
    // Keyed by opener rather than by a single convention, because this ships
    // Persian and Arabic books (guillemets), German ones (both directions) and
    // CJK ones (corner brackets) — a table missing one of those reads a whole
    // book's dialogue as the narrator's own voice.
    expect(narrationOutsideQuotedSpeech("Sie wartete. „Komm rein“, sagte er.")).toBe(
      "Sie wartete.  , sagte er."
    );
    expect(narrationOutsideQuotedSpeech("Sie wartete. „Komm rein”, sagte er.")).toBe(
      "Sie wartete.  , sagte er."
    );
    expect(narrationOutsideQuotedSpeech("She waited. ‘Come in,’ he said.")).toBe(
      "She waited.   he said."
    );
    expect(narrationOutsideQuotedSpeech("او منتظر ماند. «بیا تو» او گفت.")).toBe(
      "او منتظر ماند.   او گفت."
    );
    expect(narrationOutsideQuotedSpeech("Sie wartete. »Komm rein« sagte er.")).toBe(
      "Sie wartete.   sagte er."
    );
    expect(narrationOutsideQuotedSpeech("她等着。「快进来。」他说。")).toBe("她等着。 他说。");
    expect(narrationOutsideQuotedSpeech("她等着。『快进来。』他说。")).toBe("她等着。 他说。");
  });

  it("never opens a span on an apostrophe", () => {
    // The straight apostrophe is deliberately absent from the opener table, and
    // the typographic one is a closer only: either as an opener, every page
    // written with a contraction loses the rest of its line to a quote nobody
    // opened.
    const straight = "It's a dog's life, and Mira's boots were wet.";
    const typographic = "It’s a dog’s life, and Mira’s boots were wet.";
    expect(narrationOutsideQuotedSpeech(straight)).toBe(straight);
    expect(narrationOutsideQuotedSpeech(typographic)).toBe(typographic);
  });

  it("removes a blockquote line up to three spaces of indent", () => {
    expect(narrationOutsideQuotedSpeech("> The register, 1904.\nShe walked on.")).toBe(
      "\nShe walked on."
    );
    expect(narrationOutsideQuotedSpeech("   > The register, 1904.\nShe walked on.")).toBe(
      "\nShe walked on."
    );
    // Four spaces is an indented code block in markdown, not a quotation.
    expect(narrationOutsideQuotedSpeech("    > printed as code\nShe walked on.")).toBe(
      "    > printed as code\nShe walked on."
    );
  });

  it("removes a line opened by an em or en dash", () => {
    // The French, Spanish and Russian dialogue convention — the same line shape
    // `hasExcessiveDashUse` forgives its opening dash for.
    expect(narrationOutsideQuotedSpeech("— Come in, said he.\nShe walked in.")).toBe(
      "\nShe walked in."
    );
    expect(narrationOutsideQuotedSpeech("– Come in, said he.\nShe walked in.")).toBe(
      "\nShe walked in."
    );
    expect(narrationOutsideQuotedSpeech("   — Come in, said he.\nShe walked in.")).toBe(
      "\nShe walked in."
    );
    // A hyphen opens a markdown list item, which is the book's own voice.
    expect(narrationOutsideQuotedSpeech("- Come in, said he.\nShe walked in.")).toBe(
      "- Come in, said he.\nShe walked in."
    );
  });

  it("gives an unterminated opener the rest of its line", () => {
    // The stated tradeoff, and it points this way on purpose: English opens
    // every paragraph of a continued speech and closes only the last, so an
    // opener with no closer is usually real dialogue. Reading too much as
    // dialogue misses a scaffold sentence; reading too little fails a page that
    // was right, and that failure costs the page its revisions.
    expect(narrationOutsideQuotedSpeech('She said, "Come in and stay\nnext line here.')).toBe(
      "She said,  \nnext line here."
    );
    // Which is why an inch mark loses its line too — the wrong answer this
    // direction is the cheap one.
    expect(narrationOutsideQuotedSpeech('The board was 6" wide and heavy. She lifted it.')).toBe(
      "The board was 6 "
    );
  });

  it("keeps headings, emphasis and the line structure verbatim", () => {
    // Callers anchor patterns against this text, so a heading marker or a bold
    // run has to still be at the front of the line it was on.
    expect(narrationOutsideQuotedSpeech("## Tap Water\n\nWelcome here.")).toBe(
      "## Tap Water\n\nWelcome here."
    );
    expect(narrationOutsideQuotedSpeech("**Welcome to the world.** Then more.")).toBe(
      "**Welcome to the world.** Then more."
    );
  });
});

/**
 * A page of exactly `words` readable words in exactly `sentences` sentences,
 * with `dashes` style dashes riding inside the last one.
 *
 * The dash gate is the only thing in this module with a numeric threshold, and
 * prose written by hand can only ever clear one by a margin — which is how a
 * test comes to name a boundary it would still pass if the boundary moved. Both
 * counts here are exact by construction: "moon" is one word to
 * `countReadableWords`, a lone em dash is none, and each sentence ends in a
 * spaced full stop. Every case below asserts them before it asserts the gate.
 */
function prose(options: { words: number; sentences: number; dashes: number }): string {
  const perSentence = Math.floor(options.words / options.sentences);
  const remainder = options.words % options.sentences;
  const built: string[] = [];
  for (let index = 0; index < options.sentences; index += 1) {
    const count = perSentence + (index < remainder ? 1 : 0);
    built.push(`${Array.from({ length: count }, () => "moon").join(" ")}.`);
  }
  const text = built.join(" ");
  if (options.dashes === 0) {
    return text;
  }
  const dashRun = Array.from({ length: options.dashes }, () => "—").join(" ");
  return `${text.slice(0, -1)} ${dashRun}.`;
}

describe("hasExcessiveDashUse", () => {
  it("builds its fixtures to the counts the gate divides", () => {
    const page = prose({ words: 222, sentences: 12, dashes: 4 });
    expect(countReadableWords(page)).toBe(222);
    expect(splitSentences(page)).toHaveLength(12);
  });

  it("ignores a page under the four-dash floor whatever its ratio", () => {
    // 3/100 is 0.03, well over the 0.018 word ratio: a page with three dashes
    // is a page with three dashes, and the floor is what stops a short page
    // from being rewritten over ordinary punctuation.
    expect(hasExcessiveDashUse(prose({ words: 100, sentences: 10, dashes: 3 }))).toBe(false);
    expect(hasExcessiveDashUse(prose({ words: 100, sentences: 10, dashes: 4 }))).toBe(true);
  });

  it("fires at the word ratio and stops one word past it", () => {
    // 4/222 = 0.01802 clears 0.018; 4/223 = 0.01794 does not. Twelve sentences
    // in both, so 4/12 = 0.333 keeps the sentence ratio out of the answer and
    // the word ratio is the only thing separating these two pages.
    expect(hasExcessiveDashUse(prose({ words: 222, sentences: 12, dashes: 4 }))).toBe(true);
    expect(hasExcessiveDashUse(prose({ words: 223, sentences: 12, dashes: 4 }))).toBe(false);
  });

  it("fires at the sentence ratio and stops one sentence past it", () => {
    // 4/11 = 0.364 clears 0.35; 4/12 = 0.333 does not. Three hundred words in
    // both, so 4/300 = 0.013 keeps the word ratio out of it: a long page with a
    // dash in every third sentence is the case this second ratio exists for.
    expect(hasExcessiveDashUse(prose({ words: 300, sentences: 11, dashes: 4 }))).toBe(true);
    expect(hasExcessiveDashUse(prose({ words: 300, sentences: 12, dashes: 4 }))).toBe(false);
  });

  it("counts the em and en dash and nothing else shaped like them", () => {
    const page = (dash: string) =>
      `The mill ${dash} the river ${dash} the ice ${dash} the lantern ${dash} all of it waited. She counted them twice.`;
    expect(hasExcessiveDashUse(page("—"))).toBe(true);
    expect(hasExcessiveDashUse(page("–"))).toBe(true);
    // A hyphen is a compound, a minus sign is arithmetic, and neither a figure
    // dash nor a horizontal bar is the tic this gate is looking for.
    expect(hasExcessiveDashUse(page("-"))).toBe(false);
    expect(hasExcessiveDashUse(page("−"))).toBe(false);
    expect(hasExcessiveDashUse(page("‒"))).toBe(false);
    expect(hasExcessiveDashUse(page("―"))).toBe(false);
  });

  it("never counts a hyphen inside a compound word", () => {
    expect(
      hasExcessiveDashUse("A well-known, twenty-four-hour, state-of-the-art, ice-cold rule. She counted twice.")
    ).toBe(false);
  });

  it("lets a dash-opened dialogue line spend its opener and one attribution dash", () => {
    // The line shape `narrationOutsideQuotedSpeech` reads as dialogue: the dash
    // that opens the speech and the dash that hands it back to the narrator are
    // the convention, not a stylistic tic, and charging for them rewrote every
    // page of a Russian or Spanish book that used it.
    const dialogue = [
      "— The river has not frozen — said Grandmother.",
      "— Then we walk to the weir — said Mira.",
      "— The keeper will say what he said — said Grandmother.",
      "— I will not argue twice — said Mira."
    ].join("\n");
    expect(hasExcessiveDashUse(dialogue)).toBe(false);

    // The control: the same eight dashes on lines that do not open with one.
    const narrated = dialogue.split("\n").map((line) => line.replace(/^— /, "She said that ")).join("\n");
    expect(hasExcessiveDashUse(narrated)).toBe(true);
  });

  it("forgives exactly one attribution dash per line, not the whole line", () => {
    // Four dashes a line, two of them the convention and two of them the tic —
    // six counted across three lines, which is the finding this gate exists to
    // make. A "dialogue lines are exempt" rule reports nothing here.
    const heavy = [
      "— The river — the weir — the mill — the ice — said Grandmother.",
      "— Then we walk — we count — we come back — said Mira.",
      "— The keeper — the parish — the register — said Grandmother."
    ].join("\n");
    expect(hasExcessiveDashUse(heavy)).toBe(true);
  });

  it("counts a glued dash on a dialogue line", () => {
    // An attribution dash has a space in front of it and a word after it. These
    // are welded to the words on both sides, so the opener is the only one this
    // line gets for free.
    expect(
      hasExcessiveDashUse(
        "— The river said no—not once, not twice, not ever—and she wrote it down—twice—said Grandmother."
      )
    ).toBe(true);
  });
});
