import { describe, expect, it } from "vitest";
import {
  applyExactReplacement,
  countExactMatches,
  exactReplacementFromInstruction,
  exactReplacementInstructionMatches,
  exactReplacementLineDiff,
  hasExactMatch
} from "./exactReplacement.js";

describe("exact replacement fast-path eligibility", () => {
  it.each([
    ['Replace "Rabbit" with "Fox".', { from: "Rabbit", to: "Fox" }],
    ["Replace “Rabbit” with “Fox” throughout the whole book!", { from: "Rabbit", to: "Fox" }],
    ["Please replace every occurrence of ‘Rabbit’ with ‘Fox’, everywhere.", { from: "Rabbit", to: "Fox" }],
    ["Change rabbit to fox globally.", { from: "rabbit", to: "fox" }],
    ["Replace Rabbit with Fox.", { from: "Rabbit", to: "Fox" }],
    ['Replace "the  red rabbit" with "the  silver fox", please.', { from: "the  red rabbit", to: "the  silver fox" }],
    ['Replace "." with "!".', { from: ".", to: "!" }]
  ])("accepts a pure replacement: %s", (instruction, expected) => {
    expect(exactReplacementFromInstruction(instruction)).toEqual(expected);
  });

  it.each([
    'Replace "Rabbit" with "Fox" and make the tone darker.',
    'Replace "Rabbit" with "Fox" while preserving the old ending.',
    'Replace "Rabbit" with "Fox"; also shorten page 2.',
    'Replace "Rabbit" with "Fox" and make the phrase "Rabbit hole" ominous.',
    "Replace rabbit with fox and turtle",
    "Replace rabbit with fox to make the style warmer",
    "Replace rabbit with fox; use gloomy prose.",
    "Rename the hero Rabbit to Fox everywhere",
    "Rename hero Rabbit to Fox everywhere",
    "Replace Spider Man with Night Fox",
    "Replace the Rabbit with Fox"
  ])("rejects residual or ambiguous requirements: %s", (instruction) => {
    expect(exactReplacementFromInstruction(instruction)).toBeNull();
  });

  it.each([
    // Grammar is not find/replace. Swapping a pronoun leaves every "him",
    // "his" and "himself" behind, and the free path approves itself, so these
    // belong on the paid rewrite that can carry the agreement through.
    "Change he to she",
    "change it to blue",
    "Replace a with b",
    "Change the to a",
    "Replace is to was",
    "change I to we",
    "swap on to off",
    // Quoting it is the same request with delimiters, not a stronger claim.
    'Replace "he" with "she"',
    'Change "it" to "blue"',
    // A modal that doubles as a name: accepting this rewrites every "will" in
    // the book, and refusing it costs one paid rename that lands correctly.
    "Rename Will to William",
    "Change May to June"
  ])("rejects a bare grammatical word on either side: %s", (instruction) => {
    expect(exactReplacementFromInstruction(instruction)).toBeNull();
  });

  it("still takes a function word inside a phrase, which is prose rather than grammar", () => {
    expect(exactReplacementFromInstruction('Replace "the red door" with "a blue gate".')).toEqual({
      from: "the red door",
      to: "a blue gate"
    });
  });

  it.each([
    // A narrowing scope is not harmless: the parse carries only from/to, so
    // discarding "in chapter 3" hands the worker a book-wide rename.
    "Change Bob to Rob in chapter 3",
    'Replace "Bob" with "Rob" in chapter 3.',
    "Change Bob to Rob on pages 3, 5",
    'Replace "Bob" with "Rob" on page 2.'
  ])("rejects a scope it cannot carry: %s", (instruction) => {
    expect(exactReplacementFromInstruction(instruction)).toBeNull();
  });

  it.each([
    "Replace Bob with Rob everywhere",
    "Replace Bob with Rob throughout the whole book.",
    "Replace Bob with Rob on all pages",
    "Replace Bob with Rob for every occurrence"
  ])("keeps a scope that only restates the book-wide default: %s", (instruction) => {
    expect(exactReplacementFromInstruction(instruction)).toEqual({ from: "Bob", to: "Rob" });
  });

  it("requires the durable instruction and queue object to name the same terms", () => {
    expect(
      exactReplacementInstructionMatches('Replace "Rabbit" with "Fox".', {
        from: "Rabbit",
        to: "Fox",
        preserveCase: true
      })
    ).toBe(true);
    expect(
      exactReplacementInstructionMatches('Replace "Rabbit" with "Hare".', {
        from: "Rabbit",
        to: "Fox"
      })
    ).toBe(false);
  });
});

describe("applyExactReplacement", () => {
  it("replaces every literal occurrence, case-sensitively", () => {
    expect(applyExactReplacement("Aranha met Aranha", { from: "Aranha", to: "Aranhinha" })).toBe(
      "Aranhinha met Aranhinha"
    );
    // Case matters: the preview shows exactly what lands, so "aranha" is a
    // different string and stays put.
    expect(applyExactReplacement("aranha and Aranha", { from: "Aranha", to: "Bea" })).toBe("aranha and Bea");
  });

  it("treats the needle as text, never as a pattern", () => {
    expect(applyExactReplacement("cost is $5.00 (net)", { from: "$5.00 (net)", to: "$6.00" })).toBe("cost is $6.00");
    expect(applyExactReplacement("a.b", { from: ".", to: "-" })).toBe("a-b");
  });

  it("leaves the text alone when there is nothing to find", () => {
    expect(applyExactReplacement("unchanged", { from: "", to: "x" })).toBe("unchanged");
    expect(countExactMatches("unchanged", { from: "", to: "x" })).toBe(0);
  });

  it("counts occurrences the same way it replaces them", () => {
    expect(countExactMatches("aa aa aa", { from: "aa", to: "b" })).toBe(3);
    expect(countExactMatches("nothing here", { from: "zzz", to: "b" })).toBe(0);
  });
});

describe("word boundaries", () => {
  it.each([
    // Measured against the split/join this replaced. Every one of these landed
    // in the book for free, on a path that marks its own pages approved and
    // whose adherence review re-derives the same substitution and agrees.
    [{ from: "he", to: "she" }, "The little rabbit sat.", "Tshe little rabbit sat."],
    [{ from: "it", to: "blue" }, "The little rabbit sat with its kit.", "The lbluetle rabbblue sat wblueh blues kblue."],
    [{ from: "a", to: "b" }, "rabbit sat was", "rbbbit sbt wbs"],
    [{ from: "Ana", to: "Anabel" }, "Anastasia waved", "Anabelstasia waved"]
  ])("never splices inside a word (was %j)", (replacement, before, corrupted) => {
    expect(applyExactReplacement(before, replacement)).toBe(before);
    expect(applyExactReplacement(before, replacement)).not.toBe(corrupted);
  });

  it("replaces a whole word wherever one really ends", () => {
    // An apostrophe and a hyphen end a word: "Fox's" and "Fox-hole" are both
    // well-formed, and a rename that refused them would leave the old name
    // standing. A plural is a different word and stays put.
    expect(
      applyExactReplacement("Rabbit runs. The Rabbit-hole. Rabbit's ears. Rabbits run. (Rabbit)", {
        from: "Rabbit",
        to: "Fox"
      })
    ).toBe("Fox runs. The Fox-hole. Fox's ears. Rabbits run. (Fox)");
    expect(applyExactReplacement("Ana and Anastasia", { from: "Ana", to: "Anabel" })).toBe("Anabel and Anastasia");
  });

  it("constrains only the sides where the needle itself ends in a word character", () => {
    // Punctuation and bracketed prices have no word edge, so they still match
    // mid-word; a phrase is bounded at its outside only, never at its spaces.
    expect(applyExactReplacement("a.b", { from: ".", to: "-" })).toBe("a-b");
    expect(applyExactReplacement("cost is $5.00 (net)", { from: "$5.00 (net)", to: "$6.00" })).toBe("cost is $6.00");
    expect(
      applyExactReplacement("clothe  red rabbits and the  red rabbit ran", { from: "the  red rabbit", to: "the  silver fox" })
    ).toBe("clothe  red rabbits and the  silver fox ran");
    // A needle ending in a space is unbounded on that side by the same rule.
    expect(applyExactReplacement("Chapter 2 and Subchapter 3", { from: "Chapter ", to: "Part " })).toBe(
      "Part 2 and Subchapter 3"
    );
  });

  it("keeps a combining mark or a joiner attached to the letter it belongs to", () => {
    // The same collisions the mention scanner's boundary class exists for:
    // «علی» inside «علی‌رضا» across a ZWNJ, and "मीर" inside "मीरा".
    expect(applyExactReplacement("علی‌رضا و علی رفتند", { from: "علی", to: "حسن" })).toBe("علی‌رضا و حسن رفتند");
    expect(applyExactReplacement("मीरा और मीर", { from: "मीर", to: "राम" })).toBe("मीरा और राम");
  });

  it("reads an astral letter as one character on either side of a match", () => {
    expect(applyExactReplacement("𐐀Rabbit and Rabbit", { from: "Rabbit", to: "Fox" })).toBe("𐐀Rabbit and Fox");
  });

  it("has no whole-word match in a script written without spaces", () => {
    // 猫 inside 熊猫 is a letter beside a letter, so nothing is provably a
    // whole word and the request falls through to the model rewrite rather
    // than turning "panda" into 熊狗 for free.
    expect(applyExactReplacement("熊猫和猫", { from: "猫", to: "狗" })).toBe("熊猫和猫");
    expect(countExactMatches("熊猫和猫", { from: "猫", to: "狗" })).toBe(0);
  });

  it("counts and previews exactly what it would write", () => {
    const replacement = { from: "Rabbit", to: "Fox" };
    expect(countExactMatches("Rabbit Rabbits Rabbit", replacement)).toBe(2);
    expect(hasExactMatch("Rabbits run", replacement)).toBe(false);
    expect(exactReplacementLineDiff("Rabbits run\nRabbit runs", replacement)).toEqual([
      { before: "Rabbit runs", after: "Fox runs" }
    ]);
  });

  it("bounds a case-preserving match the same way", () => {
    const replacement = { from: "rabbit", to: "fly", preserveCase: true };
    expect(applyExactReplacement("Rabbits race. Rabbit wins.", replacement)).toBe("Rabbits race. Fly wins.");
    expect(countExactMatches("Rabbits race. Rabbit wins.", replacement)).toBe(1);
  });
});

describe("preserveCase", () => {
  const replacement = { from: "rabbit", to: "fly", preserveCase: true };

  it("carries each occurrence's capitalization onto the replacement", () => {
    // The case the fixtures actually hit: the reader types "rabbit", the book
    // says "Rabbit". A literal swap finds nothing and the edit silently becomes
    // a per-page regeneration.
    expect(applyExactReplacement("Rabbit runs. RABBIT wins. rabbit rests.", replacement)).toBe(
      "Fly runs. FLY wins. fly rests."
    );
  });

  it("counts and matches case-insensitively too", () => {
    expect(countExactMatches("Rabbit and rabbit", replacement)).toBe(2);
    expect(hasExactMatch("Rabbit", replacement)).toBe(true);
    // Without the flag the same text is a miss, which is the whole point.
    expect(hasExactMatch("Rabbit", { from: "rabbit", to: "fly" })).toBe(false);
  });

  it("does not disturb surrounding text", () => {
    expect(applyExactReplacement("The Rabbit's burrow", replacement)).toBe("The Fly's burrow");
  });

  it("stays aligned when lowercasing changes the string's length", () => {
    // "İ" (U+0130) lowercases to two UTF-16 units, so an index into the
    // lowercased haystack drifts one unit per İ before the match — which used
    // to splice the page mid-word ("İstanbul hosts a Rflytoday.").
    expect(applyExactReplacement("İstanbul hosts a Rabbit today.", replacement)).toBe(
      "İstanbul hosts a Fly today."
    );
    expect(countExactMatches("İzmir and İstanbul both keep a rabbit and a Rabbit.", replacement)).toBe(2);
    expect(applyExactReplacement("İzmir and İstanbul both keep a rabbit and a Rabbit.", replacement)).toBe(
      "İzmir and İstanbul both keep a fly and a Fly."
    );
  });

  it("never matches the fragment inside one character's lowercase expansion", () => {
    // İ lowercases to "i" + a combining dot; the bare "i" inside that pair is
    // not a slice of the original text and must not count as a hit.
    expect(countExactMatches("İ", { from: "i", to: "x", preserveCase: true })).toBe(0);
    expect(applyExactReplacement("İ", { from: "i", to: "x", preserveCase: true })).toBe("İ");
  });
});

describe("exactReplacementLineDiff", () => {
  it("returns only the lines that change", () => {
    const text = "Aranha woke up.\nThe sun was warm.\nAranha stretched.";
    expect(exactReplacementLineDiff(text, { from: "Aranha", to: "Bea" })).toEqual([
      { before: "Aranha woke up.", after: "Bea woke up." },
      { before: "Aranha stretched.", after: "Bea stretched." }
    ]);
  });

  it("stops at the limit so a whole-book replacement cannot flood the card", () => {
    const text = Array.from({ length: 40 }, (_, index) => `Aranha line ${index}`).join("\n");
    expect(exactReplacementLineDiff(text, { from: "Aranha", to: "Bea" }, 3)).toHaveLength(3);
  });
});
