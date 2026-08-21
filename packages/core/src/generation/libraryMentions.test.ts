import { describe, expect, it } from "vitest";
import {
  canonicalizeLibraryMentions,
  isLibraryMentionNameCharacterAt,
  libraryMentionRanges,
  rewriteLibraryMention,
  stripBoundLibraryMentionMarkers,
  stripEveryLibraryMentionMarker,
  stripLibraryMentionMarkers
} from "./libraryMentions.js";

describe("library mention text", () => {
  const luna = { id: "luna", name: "Luna" };
  const vega = { id: "vega", name: "Luna Vega" };

  it("finds repeated whole tokens without matching a longer word", () => {
    expect(libraryMentionRanges("@Luna met @Luna-Bear and @Luna.", [luna])).toEqual([
      { ...luna, start: 0, end: 5 },
      { ...luna, start: 25, end: 30 }
    ]);
  });

  it("lets the longest selected name claim an overlapping span", () => {
    expect(libraryMentionRanges("Ask @Luna Vega.", [luna, vega])).toEqual([
      { ...vega, start: 4, end: 14 }
    ]);
  });

  it("rewrites case-insensitive legacy spelling to the canonical new name", () => {
    expect(rewriteLibraryMention("Friends with @luna.", luna, "Luna Vega")).toBe(
      "Friends with @Luna Vega."
    );
  });

  it("strips only linked markers for generation-facing prose", () => {
    expect(stripLibraryMentionMarkers("Knows @Luna and @Ghost.", [luna])).toBe(
      "Knows Luna and @Ghost."
    );
  });

  it("recognizes punctuation boundaries without splitting astral letters", () => {
    expect(libraryMentionRanges("(@Luna)", [luna])).toHaveLength(1);
    expect(libraryMentionRanges("𐐀@Luna", [luna])).toEqual([]);
    // The unit before `@` is the trailing surrogate of 𐐀; backing up is what
    // stops that half from reading as "not a letter" and opening a mention.
    expect(isLibraryMentionNameCharacterAt("𐐀@Luna", 1)).toBe(true);
  });

  it("keeps a possessive inside the mention, straight quote or curly", () => {
    // The composer prunes a tapped pick whose token it can no longer find, so
    // a possessive that ends the token is a message shipped with no character
    // ids at all — the model then invents the look this feature exists to pin.
    expect(libraryMentionRanges("@Luna's hat", [luna])).toEqual([
      { ...luna, start: 0, end: 5 }
    ]);
    expect(libraryMentionRanges("@Luna’s hat", [luna])).toEqual([
      { ...luna, start: 0, end: 5 }
    ]);
  });

  it("refuses a hyphen that joins the next word and allows one that does not", () => {
    expect(libraryMentionRanges("@Luna-Bear", [luna])).toEqual([]);
    expect(libraryMentionRanges("@Luna-", [luna])).toEqual([{ ...luna, start: 0, end: 5 }]);
    expect(libraryMentionRanges("@Luna - the rabbit", [luna])).toEqual([
      { ...luna, start: 0, end: 5 }
    ]);
    // The whole known name may contain the hyphen; longest-first is what makes
    // that work without letting the shorter name claim its first half.
    const bear = { id: "bear", name: "Luna-Bear" };
    expect(libraryMentionRanges("@Luna-Bear", [luna, bear])).toEqual([
      { ...bear, start: 0, end: 10 }
    ]);
  });

  it("leaves a sibling's token alone when a nested name is renamed or deleted", () => {
    const description = "@Luna and @Luna Vega";
    expect(rewriteLibraryMention(description, luna, "Nova", [vega])).toBe(
      "@Nova and @Luna Vega"
    );
    expect(stripLibraryMentionMarkers(description, [luna], [vega])).toBe(
      "Luna and @Luna Vega"
    );
  });

  it("keeps two names that differ only in case apart", () => {
    const upper = { id: "upper", name: "Bram" };
    const lower = { id: "lower", name: "bram" };
    expect(libraryMentionRanges("@Bram met @bram.", [upper, lower])).toEqual([
      { ...upper, start: 0, end: 5 },
      { ...lower, start: 10, end: 15 }
    ]);
    expect(rewriteLibraryMention("@Bram met @bram.", upper, "Brom", [lower])).toBe(
      "@Brom met @bram."
    );
    // Neither is spelled the way the prose spells it, so nobody claims it: a
    // wrong owner is the unrecoverable half.
    expect(libraryMentionRanges("@BRAM", [upper, lower])).toEqual([]);
  });

  it("treats a ZWNJ as part of the Persian word it joins", () => {
    // «علی‌رضا» is one name written with a zero-width non-joiner, so the saved
    // «علی» inside it is a sub-token and not a mention. ZWNJ is category `Cf`:
    // a boundary class that stops at letters alone reads the joiner as a word
    // break and hands one reader's saved face to another character.
    const ali = { id: "ali", name: "\u0639\u0644\u06cc" };
    const alireza = { id: "alireza", name: "\u0639\u0644\u06cc\u200c\u0631\u0636\u0627" };
    const description = `\u0647\u0645\u0631\u0627\u0647 @${alireza.name} \u0627\u0633\u062a`;

    expect(libraryMentionRanges(description, [ali])).toEqual([]);
    expect(libraryMentionRanges(description, [ali, alireza])).toEqual([
      { ...alireza, start: 6, end: 14 }
    ]);
    expect(rewriteLibraryMention(description, ali, "\u0646\u0648\u0627", [alireza])).toBe(
      description
    );
    expect(stripLibraryMentionMarkers(description, [ali], [alireza])).toBe(description);
  });

  it("canonicalizes every claimed span in one pass, case variants included", () => {
    const upper = { id: "upper", name: "Bram" };
    const lower = { id: "lower", name: "bram" };
    const claims = canonicalizeLibraryMentions("@Bram met @bram.", [upper, lower]);

    expect(claims.description).toBe("@Bram met @bram.");
    expect(claims.ranges.map((range) => [range.id, range.start])).toEqual([
      ["upper", 0],
      ["lower", 10]
    ]);
  });

  it("respells a legacy token without moving the spans around it", () => {
    const claims = canonicalizeLibraryMentions("@luna met @Luna Vega", [luna, vega]);

    expect(claims.description).toBe("@Luna met @Luna Vega");
    expect(claims.ranges.map((range) => range.id)).toEqual(["luna", "vega"]);
  });

  describe("stripBoundLibraryMentionMarkers", () => {
    const upper = { id: "upper", name: "Bram" };
    const lower = { id: "lower", name: "bram" };

    it("takes the marker off a span two of its own names tie over", () => {
      // The hole `generationDescription` fell into. Both rows are perfectly
      // nameable, so it picks the narrow strip — which leaves an `@` nobody
      // claimed exactly where the reader put it, and `@BRAM` is claimed by
      // nobody because `claimAt` refuses a tie it cannot settle. A tie is not
      // prose: the list reached that span and could not name it, and every
      // candidate agrees on the deletion even though none of them may own it.
      const prose = "@Bram met @bram at @BRAM's place.";
      expect(stripLibraryMentionMarkers(prose, [upper, lower])).toBe(
        "Bram met bram at @BRAM's place."
      );
      expect(stripBoundLibraryMentionMarkers(prose, [upper, lower])).toBe(
        "Bram met bram at BRAM's place."
      );
    });

    it("keeps the prose's own spelling of every marker it takes", () => {
      // A claimed span and a contested one are the same one-character edit, so
      // the two sets are one position list and neither re-cases anything.
      expect(stripBoundLibraryMentionMarkers("@luna and @LUNA.", [luna, { id: "l2", name: "luna" }])).toBe(
        "luna and LUNA."
      );
    });

    it("leaves an @ no candidate matched where the reader put it", () => {
      // The half it does not widen: an unmatched `@` is still the reader's own
      // text, which is what separates this from `stripEveryLibraryMentionMarker`
      // and its `@handle` cost.
      expect(
        stripBoundLibraryMentionMarkers("Writes to bram@example.com about @Luna, meet @ 6.", [luna])
      ).toBe("Writes to bram@example.com about Luna, meet @ 6.");
    });

    it("takes the whole run when a marker stands in front of a marker", () => {
      // Reachable, not theoretical: `libraryMentionQueryAt` opens a mention
      // query on an `@` whose left neighbour is an `@`, so typing `@@` and
      // tapping the suggestion chip stores this prose with a live CHARACTER row
      // bound to the span at offset 1. Deleting that one marker answered
      // `@Bram` — the same UI token in the same planner brief, one deletion
      // later.
      expect(stripBoundLibraryMentionMarkers("@@Bram is my friend.", [upper])).toBe(
        "Bram is my friend."
      );
      // However long the run: each `@`'s verdict is already in by the time the
      // one in front of it asks what it opens.
      expect(stripBoundLibraryMentionMarkers("@@@Bram", [upper])).toBe("Bram");
      // The contested half leaks the same way and closes the same way — a tie
      // is settled by deleting the `@`, so a run in front of one is opening a
      // deletion exactly as a run in front of a claim is.
      expect(stripBoundLibraryMentionMarkers("Met @@BRAM.", [upper, lower])).toBe("Met BRAM.");
    });

    it("leaves the reader's own @ standing, run rule or not", () => {
      // The widening is a run of *this strip's own deletions* and nothing else,
      // which is what keeps the `@handle` price on `stripEveryLibraryMentionMarker`
      // alone. An `@` in front of prose nobody claimed stands, an `@` inside a
      // word stands, and a run pointing at neither is prose in both positions.
      expect(stripBoundLibraryMentionMarkers("@Ghost writes to bram@example.com.", [upper])).toBe(
        "@Ghost writes to bram@example.com."
      );
      expect(stripBoundLibraryMentionMarkers("meet @@ 6", [upper])).toBe("meet @@ 6");
      // The `tokenEnds` exemption the broad strip needs is deliberately not
      // here: it is evidence about a marker that strip cannot name, and with the
      // list complete `@Harbor` is simply the reader's text.
      expect(stripBoundLibraryMentionMarkers("@Bram@Harbor", [upper])).toBe("Bram@Harbor");
      // And an `@` inside the reader's own word is no more a marker here than
      // there, so the run rule may not weld `bram@` onto the name behind it.
      expect(stripBoundLibraryMentionMarkers("bram@@Bram", [upper])).toBe("bram@Bram");
    });

    it("answers exactly as the narrow strip does where nothing ties", () => {
      // The overwhelming case, and the one the model-facing read takes every
      // day: no tie, so the two functions are the same function.
      const prose = "Met @Luna and @Luna Vega, not @Harbor.";
      expect(stripBoundLibraryMentionMarkers(prose, [luna, vega])).toBe(
        stripLibraryMentionMarkers(prose, [luna, vega])
      );
    });
  });

  describe("stripEveryLibraryMentionMarker", () => {
    const bram = { id: "bram", name: "Bram" };

    it("takes the marker off a token no name in the list can claim", () => {
      // The case the narrow strip cannot serve: the caller holds a link it
      // cannot name — a mention kind with no table to join to, a row whose join
      // a `select` dropped — so it knows a marker is bound and not which span.
      // Leaving it is an `@` in a model's prompt, which is what this module
      // exists to prevent.
      expect(stripEveryLibraryMentionMarker("Lives at @Harbor with @Luna.", [luna])).toBe(
        "Lives at Harbor with Luna."
      );
      expect(stripLibraryMentionMarkers("Lives at @Harbor with @Luna.", [luna])).toBe(
        "Lives at @Harbor with Luna."
      );
    });

    it("keeps the prose's own spelling of a claimed token", () => {
      // Same promise the narrow strip makes: the marker goes and the spelling
      // stays, because re-casing a reader's prose is not this function's
      // business. Deleting the `@` is the whole edit either way.
      expect(stripEveryLibraryMentionMarker("Friends with @luna.", [luna])).toBe(
        "Friends with luna."
      );
    });

    it("strips every marker in a description with no name list at all", () => {
      expect(stripEveryLibraryMentionMarker("@Harbor, @Sunfang and @Ghost.")).toBe(
        "Harbor, Sunfang and Ghost."
      );
    });

    it("leaves an @ that opens no word where the reader put it", () => {
      // The scanner's own word test, so the broad strip is broader by exactly
      // one thing: it does not need an owner. An `@` inside a word is an email
      // address, and one with nothing after it is prose.
      expect(
        stripEveryLibraryMentionMarker("Writes to bram@example.com, meet @ the docks @ 6.")
      ).toBe("Writes to bram@example.com, meet @ the docks @ 6.");
      // Nothing after it at all is the other half of that rule, and it is a
      // different branch: the boundary test answers off the end of the string
      // rather than off the character class.
      expect(stripEveryLibraryMentionMarker("meet me @")).toBe("meet me @");
      expect(stripEveryLibraryMentionMarker("", [luna])).toBe("");
    });

    it("takes a longest claimed name whole rather than its first token", () => {
      // The claim scan still runs, so a span an item owns is stripped as one
      // span; the marker inside `@Luna Vega` is the same single `@` either way,
      // and the sibling's own name survives as prose.
      expect(stripEveryLibraryMentionMarker("Ask @Luna Vega and @Luna.", [luna, vega])).toBe(
        "Ask Luna Vega and Luna."
      );
    });

    it("takes the marker off a token that opens where a claimed one ended", () => {
      // The word test asks whether an `@` sits inside a word, and the letters
      // right in front of this one are not a word: they are the mention token
      // whose own marker is going. `libraryMentionRanges` opens a claim only at
      // a boundary and refuses one that runs into the next word, so a claimed
      // span is a whole word and the position after it is a boundary too.
      // Reading it as "inside a word" is what left `Bram@Harbor` standing — the
      // unnameable marker this function exists to remove, surviving by sitting
      // against a claimed one.
      expect(libraryMentionRanges("@Bram@Harbor", [bram])).toEqual([
        { ...bram, start: 0, end: 5 }
      ]);
      expect(stripEveryLibraryMentionMarker("@Bram@Harbor", [bram])).toBe("BramHarbor");
    });

    it("leaves the @ after a claimed token when it opens no word", () => {
      // The boundary says where the word test may look, not that everything
      // after a claim goes: an `@` with nothing after it, or with a space, is
      // the reader's prose here exactly as it is in "meet me @".
      expect(stripEveryLibraryMentionMarker("@Bram@", [bram])).toBe("Bram@");
      expect(stripEveryLibraryMentionMarker("@Bram@ 6", [bram])).toBe("Bram@ 6");
    });

    it("strips a run of markers instead of leaving the last one standing", () => {
      // Every `@` in the run goes, so the one in front of them opens the word
      // the run points at. Deciding that left to right answered off the input
      // rather than off the prose being produced, and `@@Harbor` came out as
      // `@Harbor`: the same UI token in the same prompt, one deletion later.
      expect(stripEveryLibraryMentionMarker("@@Harbor")).toBe("Harbor");
      expect(stripEveryLibraryMentionMarker("@@Luna", [luna])).toBe("Luna");
      // A run that opens no word is still prose, in both of its positions.
      expect(stripEveryLibraryMentionMarker("meet @@ 6")).toBe("meet @@ 6");
    });

    it("leaves an @ embedded in the reader's own word, claimed neighbour or not", () => {
      // A claim is the evidence that the letters before a marker are a token.
      // Without one they are prose, and the strip may not infer a second marker
      // from a first it only guessed at — `Bram@Harbor` is the shape an address
      // has, and the name list is what tells the two apart.
      expect(stripEveryLibraryMentionMarker("Bram@Harbor", [bram])).toBe("Bram@Harbor");
      expect(stripEveryLibraryMentionMarker("a@b", [bram])).toBe("a@b");
      expect(stripEveryLibraryMentionMarker("Writes to bram@example.com", [bram])).toBe(
        "Writes to bram@example.com"
      );
    });

    it("leaves a sub-token joined by a ZWNJ alone, marker and all", () => {
      // `@علی‌رضا` is one word: the `@` opens it, so it is stripped once, and
      // the joiner inside it is not a second marker.
      const alireza = "\u0639\u0644\u06cc\u200c\u0631\u0636\u0627";
      expect(stripEveryLibraryMentionMarker(`\u0647\u0645\u0631\u0627\u0647 @${alireza}`)).toBe(
        `\u0647\u0645\u0631\u0627\u0647 ${alireza}`
      );
    });
  });
});
