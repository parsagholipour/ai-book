import { describe, expect, it } from "vitest";

import {
  cleanAssistText,
  cleanBrainstormIdeas,
  clipAtSentence,
  clipAtWord,
  clipHeadTail,
  CLIPPED_MIDDLE_MARKER,
  filterProofreadCorrections,
  joinContinuationAtCursor,
  locateQuote,
  orderNotesByQuote,
  stripEchoedLead,
  withSelectionEndPunctuation,
  withSelectionWhitespace
} from "./authorAssistSchemas.js";

describe("cleanAssistText", () => {
  it("strips a preamble line, a label line and a closing sign-off paragraph", () => {
    expect(cleanAssistText("Here is the rewritten passage:\nThe rain stopped.")).toBe("The rain stopped.");
    expect(cleanAssistText("Sure! Here's a clearer version:\n\nThe rain stopped.")).toBe("The rain stopped.");
    expect(cleanAssistText("Rewritten text:\nThe rain stopped.")).toBe("The rain stopped.");
    expect(cleanAssistText("The rain stopped.\n\nLet me know if you'd like another take!")).toBe("The rain stopped.");
  });

  it("strips a fence or quotation marks wrapping the whole reply, unless the source starts that way", () => {
    expect(cleanAssistText("```markdown\nThe rain stopped.\n```")).toBe("The rain stopped.");
    expect(cleanAssistText('"The rain stopped."')).toBe("The rain stopped.");
    expect(cleanAssistText("“The rain stopped.”")).toBe("The rain stopped.");
    expect(cleanAssistText('"Go," she said.', '"Go," she said.')).toBe('"Go," she said.');
    expect(cleanAssistText("```js\nx()\n```", "```js\ny()\n```")).toBe("```js\nx()\n```");
  });

  it("keeps a colon-ended first line when the author's own text starts that way", () => {
    const source = "This is how it ended:\nThe fire went out.";
    expect(cleanAssistText("This is how it all ended:\nThe fire died.", source)).toBe("This is how it all ended:\nThe fire died.");
  });

  it("keeps dialogue that merely starts and ends the passage", () => {
    const dialogue = '"Go," she said. "Now."';
    expect(cleanAssistText(dialogue)).toBe(dialogue);
  });

  it("drops leading headings the author did not use, and keeps them when the source has headings", () => {
    expect(cleanAssistText("## Chapter Two\n\nThe rain stopped.", "Plain prose.")).toBe("The rain stopped.");
    expect(cleanAssistText("## Setup\n\nInstall it.", "## Intro\n\nRead this.")).toBe("## Setup\n\nInstall it.");
  });

  it("never cleans a reply down to nothing", () => {
    expect(cleanAssistText("Here is the text:")).toBe("Here is the text:");
    expect(cleanAssistText("  \n ")).toBe("");
  });
});

describe("stripEchoedLead", () => {
  it("removes a restated tail of before, word-wise", () => {
    const before = "She opened the door and stepped into the cold hallway.";
    expect(stripEchoedLead(before, "stepped into the cold hallway. The lights were off.")).toEqual({
      text: "The lights were off.",
      continuesWord: false
    });
    expect(stripEchoedLead(before, "She opened the door and stepped into the cold hallway. The lights were off.").text).toBe(
      "The lights were off."
    );
  });

  it("leaves an ordinary continuation alone, and never strips to nothing", () => {
    const before = "She opened the door.";
    expect(stripEchoedLead(before, "The lights were off.").text).toBe("The lights were off.");
    expect(stripEchoedLead(before, "She opened the door.").text).toBe("She opened the door.");
    expect(stripEchoedLead("", "Anything.").text).toBe("Anything.");
  });

  it("does not strip a short coincidental overlap", () => {
    expect(stripEchoedLead("He said no.", "He said no. Then he left.").text).toBe("He said no. Then he left.");
  });

  it("falls back to characters for scripts written without spaces", () => {
    const before = "她推开门，走进了寒冷的走廊里面。";
    expect(stripEchoedLead(before, "走进了寒冷的走廊里面。灯都关着。").text).toBe("灯都关着。");
  });

  it("says when the cut falls inside a word the cursor sat in", () => {
    expect(stripEchoedLead("He walked into the gard", "He walked into the garden and sat.")).toEqual({
      text: "en and sat.",
      continuesWord: true
    });
    expect(joinContinuationAtCursor({ before: "into the gard", after: "" }, "en and sat.", { openedParagraph: false, continuesWord: true })).toBe(
      "en and sat."
    );
  });
});

describe("joinContinuationAtCursor", () => {
  const plain = { openedParagraph: false, continuesWord: false };
  const paragraph = { openedParagraph: true, continuesWord: false };
  it("adds a space after a word, nothing after whitespace, and a paragraph break when the model opened one", () => {
    expect(joinContinuationAtCursor({ before: "She sat down.", after: "" }, "The door opened.", plain)).toBe(" The door opened.");
    expect(joinContinuationAtCursor({ before: "She sat down. ", after: "" }, "The door opened.", plain)).toBe("The door opened.");
    expect(joinContinuationAtCursor({ before: "She sat down.\n", after: "" }, "The door opened.", plain)).toBe("The door opened.");
    expect(joinContinuationAtCursor({ before: "She sat down.", after: "" }, "The door opened.", paragraph)).toBe("\n\nThe door opened.");
    expect(joinContinuationAtCursor({ before: "", after: "" }, "The door opened.", plain)).toBe("The door opened.");
  });

  it("adds no space before punctuation, nor in scripts written without spaces", () => {
    expect(joinContinuationAtCursor({ before: "She sat", after: "" }, ", then stood.", plain)).toBe(", then stood.");
    expect(joinContinuationAtCursor({ before: "她坐下了", after: "" }, "门开了。", plain)).toBe("门开了。");
  });

  it("adds a trailing space when after starts a word at the cursor", () => {
    expect(joinContinuationAtCursor({ before: "She sat down. ", after: "Later, rain." }, "The door opened.", plain)).toBe(
      "The door opened. "
    );
    expect(joinContinuationAtCursor({ before: "She sat down. ", after: " Later." }, "The door opened.", plain)).toBe(
      "The door opened."
    );
  });
});

describe("withSelectionWhitespace", () => {
  it("keeps the selection's own paragraph breaks around a replacement", () => {
    expect(withSelectionWhitespace("\nOld text.\n\n", "New text.")).toBe("\nNew text.\n\n");
  });
});

describe("filterProofreadCorrections", () => {
  const selection = "Teh cat sat on teh mat, and I recieve the the letter.";

  it("keeps exact, unique, non-overlapping spans in text order", () => {
    const kept = filterProofreadCorrections(selection, [
      { find: "recieve", replace: "receive", reason: "spelling" },
      { find: "Teh cat", replace: "The cat", reason: "spelling" },
      { find: "on teh mat", replace: "on the mat" }
    ]);
    expect(kept).toEqual([
      { find: "Teh cat", replace: "The cat", reason: "spelling" },
      { find: "on teh mat", replace: "on the mat", reason: "" },
      { find: "recieve", replace: "receive", reason: "spelling" }
    ]);
  });

  it("drops empty, unchanged, absent, ambiguous and overlapping corrections", () => {
    const kept = filterProofreadCorrections(selection, [
      { find: "", replace: "x", reason: "" },
      { find: "cat", replace: "cat", reason: "" },
      { find: "dog", replace: "hound", reason: "" },
      { find: "the", replace: "a", reason: "ambiguous: twice" },
      { find: "the the", replace: "the", reason: "repeated word" },
      { find: "the letter", replace: "that letter", reason: "overlaps the kept one" }
    ]);
    expect(kept).toEqual([{ find: "the the", replace: "the", reason: "repeated word" }]);
  });

  it("caps the list at forty", () => {
    const words = Array.from({ length: 50 }, (_, index) => `w${index}x`);
    const text = words.join(" ");
    const kept = filterProofreadCorrections(
      text,
      words.map((word) => ({ find: word, replace: word.toUpperCase(), reason: "" }))
    );
    expect(kept).toHaveLength(40);
  });
});

describe("cleanBrainstormIdeas", () => {
  it("clips titles to 60 characters, drops empties and duplicates, and keeps three", () => {
    const ideas = cleanBrainstormIdeas([
      { title: "A very long title that goes on and on well past the sixty character limit", text: "One." },
      { title: "", text: "" },
      { title: "**Storm**", text: "The storm breaks." },
      { title: "storm", text: "Duplicate by title." },
      { title: "Letter", text: "A letter arrives." },
      { title: "Fourth", text: "Too many." }
    ]);
    expect(ideas.map((idea) => idea.title)).toEqual([expect.stringMatching(/…$/), "Storm", "Letter"]);
    expect(ideas[0]!.title.length).toBeLessThanOrEqual(60);
  });
});

describe("locateQuote", () => {
  const chapter = "The rain fell all night.\n\n“I won’t go,” she said —  and meant it.\n\nMorning came...";

  it("returns the chapter's own span for an exact or loosely copied quote", () => {
    expect(locateQuote(chapter, "The rain fell all night.")).toBe("The rain fell all night.");
    expect(locateQuote(chapter, '"I won\'t go," she said - and meant it.')).toBe("“I won’t go,” she said —  and meant it.");
    expect(locateQuote(chapter, "“The rain fell all night.”")).toBe("The rain fell all night.");
    expect(locateQuote(chapter, "Morning came…")).toBe("Morning came");
  });

  it("nulls a quote that is not in the text", () => {
    expect(locateQuote(chapter, "The sun shone.")).toBeNull();
    expect(locateQuote(chapter, null)).toBeNull();
    expect(locateQuote(chapter, " ")).toBeNull();
  });

  it("clips a long verbatim quote to 200 characters, still verbatim", () => {
    const long = `${"word ".repeat(80)}end.`;
    const quote = locateQuote(`Intro. ${long} Outro.`, long)!;
    expect(quote.length).toBeLessThanOrEqual(200);
    expect(long.startsWith(quote)).toBe(true);
  });
});

describe("orderNotesByQuote", () => {
  it("orders by quote position, whole-chapter notes last, and drops duplicates", () => {
    const text = "Alpha. Beta. Gamma.";
    const ordered = orderNotesByQuote(text, [
      { quote: null, note: "Whole.", severity: "suggestion" as const },
      { quote: "Gamma.", note: "Third.", severity: "issue" as const },
      { quote: "Alpha.", note: "First.", severity: "suggestion" as const },
      { quote: "Alpha.", note: "first.", severity: "suggestion" as const }
    ]);
    expect(ordered.map((note) => note.note)).toEqual(["First.", "Third.", "Whole."]);
  });
});

describe("clipping", () => {
  it("clips at a sentence end, else at a word with an ellipsis", () => {
    expect(clipAtSentence("One two three. Four five six.", 20)).toBe("One two three.");
    expect(clipAtSentence("One two. Three four five six.", 20)).toBe("One two. Three…");
    expect(clipAtSentence("Short.", 20)).toBe("Short.");
    expect(clipAtWord("alpha beta gamma delta", 14)).toBe("alpha beta…");
  });

  it("keeps the head and tail of a long text around a marker", () => {
    const text = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
    const clipped = clipHeadTail(text, 1000);
    expect(clipped.clipped).toBe(true);
    expect(clipped.text.length).toBeLessThanOrEqual(1000);
    expect(clipped.text).toContain(CLIPPED_MIDDLE_MARKER);
    expect(clipped.text.startsWith("word0 ")).toBe(true);
    expect(clipped.text.endsWith("word399")).toBe(true);
    expect(clipHeadTail("short", 1000)).toEqual({ text: "short", clipped: false });
  });
});

describe("withSelectionEndPunctuation", () => {
  it("gives back the full stop a rewrite dropped", () => {
    expect(withSelectionEndPunctuation("the lamp went out at ten.", "the lamp guttered out at ten")).toBe(
      "the lamp guttered out at ten."
    );
    expect(withSelectionEndPunctuation("“Run!” she said?", "“Run!” she cried")).toBe("“Run!” she cried?");
    expect(withSelectionEndPunctuation("He left.”", "He walked away")).toBe("He walked away.”");
    expect(withSelectionEndPunctuation("چراغ خاموش شد.", "چراغ خاموش شد")).toBe("چراغ خاموش شد.");
  });

  it("leaves a replacement that ends in punctuation of its own, or a selection mid-sentence", () => {
    expect(withSelectionEndPunctuation("at ten.", "at ten!")).toBe("at ten!");
    expect(withSelectionEndPunctuation("at ten.", "at ten…")).toBe("at ten…");
    expect(withSelectionEndPunctuation("the lamp went out", "the lamp died")).toBe("the lamp died");
    expect(withSelectionEndPunctuation("at ten.", "at ten\n")).toBe("at ten.\n");
  });
});
