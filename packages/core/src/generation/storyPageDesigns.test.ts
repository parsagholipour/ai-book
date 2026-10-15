import { describe, expect, it } from "vitest";
import {
  allStoryPageDesigns,
  chooseStoryPageDesign,
  requestedStoryPageDesign,
  STORY_PAGE_DESIGN_IDS,
  storyPageDesignField,
  storyPageDesignFor,
  storyPageDesignPreference
} from "./storyPageDesigns.js";
import { STORY_PAGE_PDF_CSS } from "./pdfStoryPages.js";

describe("requestedStoryPageDesign", () => {
  it("reads a design named next to a word about how the pages look", () => {
    expect(requestedStoryPageDesign("make the pages look like the night sky")).toBe("night");
    expect(requestedStoryPageDesign("I want the ocean design")).toBe("ocean");
    expect(requestedStoryPageDesign("use a plain layout please")).toBe("classic");
    expect(requestedStoryPageDesign("a brighter colour scheme")).toBe("rainbow");
    expect(requestedStoryPageDesign("fairy tale style")).toBe("fairytale");
    expect(requestedStoryPageDesign("a space theme!")).toBe("space");
    expect(requestedStoryPageDesign("a garden look")).toBe("meadow");
    expect(requestedStoryPageDesign("back to the pastel design")).toBe("storybook");
  });

  it("takes the design named last", () => {
    expect(requestedStoryPageDesign("not the night one, the ocean design")).toBe("ocean");
  });

  it("does not read a subject, or a design word far from any look-word, as a choice", () => {
    expect(requestedStoryPageDesign("a story about the sea")).toBeUndefined();
    expect(requestedStoryPageDesign("a simple 12 page story about a bunny")).toBeUndefined();
    expect(requestedStoryPageDesign("make it darker")).toBeUndefined();
    expect(requestedStoryPageDesign("rewrite page 3 to be about the sea")).toBeUndefined();
    // A colour is the story's text before it is a look.
    expect(requestedStoryPageDesign("change the colour of Mira's dress to blue")).toBeUndefined();
  });
});

describe("requestedStoryPageDesign keeps every answer across the linear rewrite", () => {
  // Captured from the recogniser as it stood before its pattern was made
  // linear. The rewrite was meant to change the backtracking and nothing else,
  // so every entry here — the odd ones included, like "theme_sea" reading as no
  // design — must not move.
  const DESIGN_CORPUS: ReadonlyArray<readonly [string, string | undefined]> = [
    ["make the pages look like the night sky", "night"],
    ["I want the ocean design", "ocean"],
    ["use a plain layout please", "classic"],
    ["a brighter colour scheme", "rainbow"],
    ["fairy tale style", "fairytale"],
    ["a space theme!", "space"],
    ["a garden look", "meadow"],
    ["back to the pastel design", "storybook"],
    ["not the night one, the ocean design", "ocean"],
    ["a story about the sea", undefined],
    ["a simple 12 page story about a bunny", undefined],
    ["make it darker", undefined],
    ["change the colour of Mira's dress to blue", undefined],
    ["the night-sky theme", "night"],
    ["theme: sea-green waves", "ocean"],
    ["a rock'n'roll design with stars and the moon", "night"],
    ["the design's look is ocean-y", "ocean"],
    ["an under-the-sea look", "ocean"],
    ["a look-alike of the sea", "ocean"],
    ["the 'sea' theme", "ocean"],
    ["a ‘night’ design", "night"],
    ["the look—sea", "ocean"],
    ["design - - - sea", "ocean"],
    ["theme ' ' ' sea", "ocean"],
    ["sea-theme-design", "ocean"],
    ["theme-sea-theme-night", "night"],
    ["dark-ocean-design", "ocean"],
    ["the ocean's look", "ocean"],
    ["look k ' ' ' e", undefined],
    ["ocean, then a design", "ocean"],
    ["design one two three four five sea", undefined],
    ["design one two three four sea", "ocean"],
    ["sea one two design", "ocean"],
    ["sea one two three design", undefined],
    ["OCEAN DESIGN", "ocean"],
    ["Night Sky Layout", "night"],
    ["a darK theme", "night"],
    ["an outer ſpace theme", "space"],
    ["themeé sea", undefined],
    ["seaé design", undefined],
    ["theme_sea", undefined],
    ["sea_theme", undefined],
    ["design 1-2-3 ocean", "ocean"],
    ["طرح شب برای کتاب", undefined],
    ["un diseño de océano", undefined],
    ["Thema: Weltraum", undefined],
    ["夜空 design", undefined],
    ["design 夜空 sea", "ocean"],
    ["the night sky design, no wait, the plain layout", "classic"],
    ["the plain layout, no wait, the night sky design", "night"],
    ["rainbow colours please, a cheerful look", "rainbow"],
    ["a royal fairy-tale style with golden pages", "fairytale"],
    ["a minimalist black and white look", "classic"],
    ["the look of a meadow in spring", "meadow"],
    ["under the sea theme", "ocean"],
    ["night sky? no — space theme", "space"],
    ["design: ocean; theme: night", "night"]
  ];

  it("reads the same design, or none, from every phrasing it read before", () => {
    const moved = DESIGN_CORPUS.flatMap(([text, before]) => {
      const after = requestedStoryPageDesign(text);
      return after === before ? [] : [{ text, before, after }];
    });
    expect(moved).toEqual([]);
  });

  /** The pattern before the rewrite, kept as the reference the rewrite is held to. */
  const OLD_LOOK_CUE =
    "designs?|layouts?|looks?|looking|style[sd]?|themes?|themed|backgrounds?|colou?r ?schemes?|decorations?|decorated";
  const oldNamedNearLook = (names: string): RegExp =>
    new RegExp(
      `\\b(?:${OLD_LOOK_CUE})\\b(?:[^\\p{L}\\p{N}]+[\\p{L}\\p{N}'’-]+){0,4}?[^\\p{L}\\p{N}]+(?:${names})` +
        `|(?:${names})(?:[^\\p{L}\\p{N}]+[\\p{L}\\p{N}'’-]+){0,2}?[^\\p{L}\\p{N}]+(?:${OLD_LOOK_CUE})\\b`,
      "giu"
    );
  const oldRequested = (text: string): string | undefined => {
    let best: { id: string; at: number } | undefined;
    for (const design of allStoryPageDesigns()) {
      const last = [...text.matchAll(oldNamedNearLook(design.names.source))].at(-1);
      if (last && (!best || last.index > best.at)) {
        best = { id: design.id, at: last.index };
      }
    }
    return best?.id;
  };

  it("agrees with the old pattern on every short string built from its own pieces", () => {
    // Look-words, design names, the joiners both old classes accepted, other
    // gaps, and letters the word boundary treats differently (é is a letter but
    // not \w; _ is \w but not a letter). Every sequence of three, plus a
    // deterministic sample of longer chains — where the skip over repeated cues
    // in one hyphenated run does its work.
    const pieces = ["theme", "sea", "night sky", "plain", "look", "x", "'", "-", "’", " ", "_", ",", "é", "1"];
    const texts: string[] = [];
    for (const a of pieces) for (const b of pieces) for (const c of pieces) texts.push(a + b + c);
    const words = ["theme", "sea", "dark", "design", "x", "ab", "night", "look"];
    const joins = ["-", "'", "-", "’", " ", "--", "_", ", "];
    let seed = 7;
    const next = (bound: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % bound;
    };
    for (let sample = 0; sample < 400; sample += 1) {
      let text = "";
      for (let word = 0, count = 3 + next(14); word < count; word += 1) {
        text += (words[next(words.length)] ?? "") + (joins[next(joins.length)] ?? "");
      }
      texts.push(text);
    }
    const moved = texts.flatMap((text) => {
      const before = oldRequested(text);
      const after = requestedStoryPageDesign(text);
      return after === before ? [] : [{ text, before, after }];
    });
    expect(moved).toEqual([]);
  });
});

describe("requestedStoryPageDesign on adversarial input", () => {
  // Every finished-book chat message that names no matter is read by this
  // recogniser on the API's only thread. Its gap and word classes both took
  // apostrophes and hyphens, so "look k '" and 200 " '" took 3 s and "theme"
  // with 200 "-e" 6 s; a hyphenated chain of design words was quadratic even
  // after that. Each input is timed at 1k before 10k, so a super-linear
  // regression fails in a fraction of a second instead of hanging the suite.
  const fill =
    (head: string, filler: string) =>
    (length: number): string => {
      const room = length - head.length;
      return head + filler.repeat(Math.ceil(room / filler.length)).slice(0, room);
    };
  const ADVERSARIAL: ReadonlyArray<readonly [string, (length: number) => string]> = [
    ["look k ' + spaced apostrophes", fill("look k '", " '")],
    ["theme + hyphenated letters", fill("theme", "-e")],
    ["a design word in a hyphen chain", fill("", "sea-")],
    ["a look-word in a hyphen chain", fill("", "theme-")],
    ["look-words and names in one chain", fill("", "theme-sea-")],
    ["look-words with other words between", fill("", "theme-x-")],
    ["look-words in a chain of Persian digits", fill("plain layout ", "۴-design-")],
    ["a design word in an apostrophe chain", fill("", "sea'")],
    ["a look-word then a long chain", fill("theme ", "a-")],
    ["a design word then a long chain", fill("sea", "-x")],
    ["a look-word then curly apostrophes", fill("design", " ’")],
    ["a look-word then spaces", fill("theme", " ")],
    ["design words and spaces", fill("", "sea ")]
  ];
  const readMs = (run: () => unknown): number => {
    // Best of two, so one slow read under load is not a failure.
    let best = Number.POSITIVE_INFINITY;
    for (let read = 0; read < 2; read += 1) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it("stays linear on long runs of what its gaps and words accept", () => {
    requestedStoryPageDesign("warm the patterns up: the night sky design");
    for (const [length, budgetMs] of [
      [1_000, 200],
      [10_000, 1_000]
    ] as const) {
      for (const [label, build] of ADVERSARIAL) {
        const text = build(length);
        expect(text).toHaveLength(length);
        const ms = readMs(() => chooseStoryPageDesign(text));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(budgetMs);
      }
    }
  });
});

describe("chooseStoryPageDesign", () => {
  it("matches a children's book to the world its words are in", () => {
    expect(chooseStoryPageDesign("Mira and the Nighttime Creak. A bedtime story about a creak in the hall and the moonlight.")).toBe("night");
    expect(chooseStoryPageDesign("Tiko and the Quiet Sea. Tiko longs to see the sea and meets a whale.")).toBe("ocean");
    expect(chooseStoryPageDesign("Benny the Bunny plants a garden in the forest.")).toBe("meadow");
    expect(chooseStoryPageDesign("Luna flies her rocket to Mars.")).toBe("space");
    expect(chooseStoryPageDesign("Princess Ada and the dragon in the castle.")).toBe("fairytale");
    expect(chooseStoryPageDesign("A birthday party with rainbow balloons.")).toBe("rainbow");
  });

  it("reads Persian subjects too", () => {
    expect(chooseStoryPageDesign("داستانی درباره خرگوشی که در جنگل باغ می‌سازد")).toBe("meadow");
    expect(chooseStoryPageDesign("قصه‌ای برای خواب شب")).toBe("night");
  });

  it("falls back to the pastel storybook, and lets a named design outrank the subject", () => {
    expect(chooseStoryPageDesign("Sam learns to tie his shoes.")).toBe("storybook");
    expect(chooseStoryPageDesign("A bedtime story about a whale, with a plain layout.")).toBe("classic");
  });
});

describe("storyPageDesignFor", () => {
  const plan = { title: "Mira and the Nighttime Creak", premise: "A bedtime story about the moon." };

  it("keeps the reader's choice above any match", () => {
    expect(storyPageDesignFor({ mediaSettings: { storyPageDesign: "ocean" }, category: "KIDS", plan })).toBe("ocean");
    expect(storyPageDesignFor({ mediaSettings: { storyPageDesign: "space" }, category: "STORY", plan })).toBe("space");
  });

  it("matches a children's book and leaves every other book plain", () => {
    expect(storyPageDesignFor({ mediaSettings: {}, category: "KIDS", plan })).toBe("night");
    expect(storyPageDesignFor({ mediaSettings: {}, category: "STORY", plan })).toBeUndefined();
  });

  it("ignores a stored value that is not a design", () => {
    expect(storyPageDesignPreference({ storyPageDesign: "neon" })).toBeUndefined();
    expect(storyPageDesignFor({ mediaSettings: { storyPageDesign: "neon" }, category: "KIDS", plan })).toBe("night");
  });

  it("gives a compile that resolved nothing a children's book's pastel default", () => {
    expect(storyPageDesignField({ category: "KIDS" })).toEqual({ storyPageDesign: "storybook" });
    expect(storyPageDesignField({ category: "STORY" })).toEqual({});
    expect(storyPageDesignField({ category: "KIDS", storyPageDesign: "classic" })).toEqual({ storyPageDesign: "classic" });
  });
});

describe("the design catalog", () => {
  it("styles every design in the stylesheet, one rule per sheet colour", () => {
    for (const design of allStoryPageDesigns()) {
      expect(STORY_PAGE_PDF_CSS).toContain(`.pdf-story-scene--design-${design.id} {`);
      for (const [index] of design.sheets.entries()) {
        expect(STORY_PAGE_PDF_CSS).toContain(`.pdf-story-scene--design-${design.id}.pdf-story-scene--sheet-${index}`);
      }
    }
    expect(allStoryPageDesigns().map((design) => design.id)).toEqual([...STORY_PAGE_DESIGN_IDS]);
  });
});
