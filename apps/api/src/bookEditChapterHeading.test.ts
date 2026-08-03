import { describe, expect, it } from "vitest";
import { chapterHeadingEditFromDecision, chapterHeadingEditFromMessage } from "./bookEditChapterHeading.js";

describe("chapterHeadingEditFromMessage", () => {
  it("recognises the request that used to be priced as a whole-book rewrite", () => {
    // Verbatim from the "Aranha and the Big Match" transcript, which the router
    // answered with "Rewrite the whole book" for 960 credits — a rewrite that
    // could not have worked, because the word is added back at compile time.
    expect(
      chapterHeadingEditFromMessage('I don\'t like that we have "Chapter x"\nWe should simply mention the Title')
    ).toEqual({ style: "title_only" });
  });

  it("reads the styles a user can ask for", () => {
    expect(chapterHeadingEditFromMessage('remove the word "Chapter" from the headings')).toEqual({
      style: "number_title"
    });
    expect(chapterHeadingEditFromMessage("drop the chapter label, just show the titles")).toEqual({
      style: "title_only"
    });
    expect(chapterHeadingEditFromMessage("stop saying Chapter in the headings but keep the numbers")).toEqual({
      style: "number_title"
    });
    expect(chapterHeadingEditFromMessage("put the Chapter headings back")).toEqual({
      style: "label_number_title"
    });
  });

  it("takes a custom label and singularizes it for use in a heading", () => {
    expect(chapterHeadingEditFromMessage("call them Parts instead of Chapters in the headings")).toEqual({
      style: "label_number_title",
      label: "Part"
    });
    expect(chapterHeadingEditFromMessage("use Episode instead of Chapter for the titles")).toEqual({
      style: "label_number_title",
      label: "Episode"
    });
  });

  it("leaves content edits and questions to normal routing", () => {
    // Each of these is a real page edit, a real chapter edit, or a question.
    for (const message of [
      "rewrite chapter 3",
      "add a chapter about the rematch",
      "remove chapter 4",
      "change the title of chapter 3",
      "I don't like the chapter titles, make them shorter",
      "shorten the chapter titles to just the key name",
      "why do the chapters have numbers?",
      "what are the chapter titles"
    ]) {
      expect(chapterHeadingEditFromMessage(message), message).toBeNull();
    }
  });
});

describe("chapterHeadingEditFromDecision", () => {
  it("defaults to titles only and drops a label that contradicts the style", () => {
    expect(chapterHeadingEditFromDecision(null, null)).toEqual({ style: "title_only" });
    expect(chapterHeadingEditFromDecision("nonsense", null)).toEqual({ style: "title_only" });
    expect(chapterHeadingEditFromDecision("label_number_title", "Part")).toEqual({
      style: "label_number_title",
      label: "Part"
    });
    // A label means nothing without the label style.
    expect(chapterHeadingEditFromDecision("number_title", "Part")).toEqual({ style: "number_title" });
    // "Page" would make every export of this book throw in assertBookLikeMarkdown.
    expect(chapterHeadingEditFromDecision("label_number_title", "Page")).toEqual({
      style: "label_number_title"
    });
  });
});
