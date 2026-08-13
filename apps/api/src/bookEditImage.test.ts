import { describe, expect, it } from "vitest";
import {
  clippedImageSubject,
  imageInsertionIntentFromDecision,
  resolveImageInsertionTarget
} from "./bookEditImage.js";
import { endOfBookPlacementFromMessage, imagePlacementFromMessage } from "./bookEditMessage.js";
import { type BookEditPageContext } from "./bookEditIntent.js";

const pages: BookEditPageContext[] = [
  {
    id: "page-1",
    index: 1,
    title: "Rabbit Starts Fast",
    summary: "Rabbit starts the race quickly.",
    previewText: "Rabbit starts the race quickly."
  },
  {
    id: "page-2",
    index: 2,
    title: "Rabbit Learns",
    summary: "Rabbit learns from Turtle.",
    previewText: "Rabbit learns from Turtle."
  }
];

describe("placement helpers", () => {
  it("reads end-of-book cues", () => {
    expect(endOfBookPlacementFromMessage("at the end of the book")).toBe(true);
    expect(endOfBookPlacementFromMessage("on the last page")).toBe(true);
    expect(endOfBookPlacementFromMessage("as the final page")).toBe(true);
    expect(endOfBookPlacementFromMessage("at the very end")).toBe(true);
    expect(endOfBookPlacementFromMessage("at the back of the book")).toBe(true);
    // A bare "at the end" counts only when the sentence ends there.
    expect(endOfBookPlacementFromMessage("put it at the end")).toBe(true);
    expect(endOfBookPlacementFromMessage("make the ending happier")).toBe(false);
    expect(endOfBookPlacementFromMessage("at the end of chapter 2")).toBe(false);
    expect(endOfBookPlacementFromMessage("the light at the end of the tunnel")).toBe(false);
  });

  it("prefers an explicit page number over an end-of-book cue", () => {
    expect(imagePlacementFromMessage("on page 4, near the end")).toEqual({ placement: "page", pageIndex: 4 });
    expect(imagePlacementFromMessage("on the 3rd page")).toEqual({ placement: "page", pageIndex: 3 });
    expect(imagePlacementFromMessage("the third page")).toEqual({ placement: "page", pageIndex: 3 });
    expect(imagePlacementFromMessage("page three")).toEqual({ placement: "page", pageIndex: 3 });
    expect(imagePlacementFromMessage("the 21st page")).toEqual({ placement: "page", pageIndex: 21 });
    expect(imagePlacementFromMessage("at the very end of the story")).toEqual({ placement: "end_of_book" });
    expect(imagePlacementFromMessage("on the last page")).toEqual({ placement: "end_of_book" });
    expect(imagePlacementFromMessage("wherever it fits")).toBeNull();
  });
});

describe("resolveImageInsertionTarget", () => {
  it("targets the one page whose context mentions the subject", () => {
    expect(resolveImageInsertionTarget({ subject: "the turtle" }, pages)).toEqual({
      targetPageIndex: 2,
      placement: "page"
    });
  });

  it("defaults to the end of the book for zero or several subject matches", () => {
    expect(resolveImageInsertionTarget({ subject: "a dragon" }, pages)).toEqual({
      targetPageIndex: 2,
      placement: "end_of_book"
    });
    expect(resolveImageInsertionTarget({ subject: "the rabbit" }, pages)).toEqual({
      targetPageIndex: 2,
      placement: "end_of_book"
    });
  });

  it("keeps an explicit page that exists and refuses one that vanished", () => {
    expect(resolveImageInsertionTarget({ subject: "x", placement: "page", pageIndex: 1 }, pages)).toEqual({
      targetPageIndex: 1,
      placement: "page"
    });
    expect(resolveImageInsertionTarget({ subject: "x", placement: "page", pageIndex: 9 }, pages)).toBeNull();
  });

  it("resolves end_of_book to the highest page index and null on an empty book", () => {
    expect(resolveImageInsertionTarget({ subject: "x", placement: "end_of_book" }, pages)).toEqual({
      targetPageIndex: 2,
      placement: "end_of_book"
    });
    expect(resolveImageInsertionTarget({ subject: "x" }, [])).toBeNull();
  });
});

describe("imageInsertionIntentFromDecision", () => {
  const base = {
    confidence: 0.9,
    reasoning: "Rout= insert_image.",
    assistantMessage: "I’ll add that picture."
  };

  it("lets the router's pageIndexes win over every other placement channel", () => {
    const intent = imageInsertionIntentFromDecision(
      { ...base, imageSubject: "a dragon", imagePlacement: "end_of_book", pageIndexes: [5] },
      "whatever the message said"
    );
    expect(intent.kind).toBe("add_image");
    expect(intent.imageEdit).toEqual({ subject: "a dragon", placement: "page", pageIndex: 5 });
    expect(intent.affectedPageIndexes).toEqual([5]);
  });

  it("maps the decision the prompt teaches for ordinal placements", () => {
    // "Add the photo of her signature on the 3rd page" → the model reports the
    // bare subject and the ordinal as pageIndexes; the mapping must keep both.
    const intent = imageInsertionIntentFromDecision(
      { ...base, imageSubject: "her signature", pageIndexes: [3] },
      "Add the photo of her signature on the 3rd page"
    );
    expect(intent.kind).toBe("add_image");
    expect(intent.imageEdit).toEqual({ subject: "her signature", placement: "page", pageIndex: 3 });
    expect(intent.affectedPageIndexes).toEqual([3]);
  });

  it("routes a Persian request through pageIndexes, which no English helper can read", () => {
    const viaModel = imageInsertionIntentFromDecision(
      { ...base, imageSubject: "یک عکس از اژدها", pageIndexes: [5] },
      "در صفحه ۵ یک عکس از اژدها اضافه کن"
    );
    expect(viaModel.imageEdit).toEqual({ subject: "یک عکس از اژدها", placement: "page", pageIndex: 5 });

    // Without the router channel the English helpers find nothing in Persian
    // text, so the placement stays unresolved for the subject-anchored default.
    const withoutChannel = imageInsertionIntentFromDecision(
      { ...base, imageSubject: "یک عکس از اژدها", pageIndexes: [] },
      "در صفحه ۵ یک عکس از اژدها اضافه کن"
    );
    expect(withoutChannel.imageEdit).toEqual({ subject: "یک عکس از اژدها" });
  });

  it("falls back to imagePlacement, then the English message helpers", () => {
    expect(
      imageInsertionIntentFromDecision({ ...base, imageSubject: "a dragon", imagePlacement: "end_of_book" }, "x")
        .imageEdit
    ).toEqual({ subject: "a dragon", placement: "end_of_book" });
    expect(
      imageInsertionIntentFromDecision({ ...base, imageSubject: "a dragon" }, "put it at the end of the book")
        .imageEdit
    ).toEqual({ subject: "a dragon", placement: "end_of_book" });
    expect(imageInsertionIntentFromDecision({ ...base, imageSubject: "a dragon" }, "somewhere nice").imageEdit).toEqual({
      subject: "a dragon"
    });
  });

  it("never reads a page number out of the model-provided subject", () => {
    const intent = imageInsertionIntentFromDecision(
      { ...base, imageSubject: "the diagram from page 4", pageIndexes: [] },
      "add an illustration of the diagram from page 4"
    );
    expect(intent.imageEdit).toEqual({ subject: "the diagram from page 4" });
    expect(intent.affectedPageIndexes).toEqual([]);
  });

  it("treats a bare imagePlacement of page as no placement — pageIndexes carries the page", () => {
    expect(
      imageInsertionIntentFromDecision(
        { ...base, imageSubject: "a dragon", imagePlacement: "page", pageIndexes: [5] },
        "x"
      ).imageEdit
    ).toEqual({ subject: "a dragon", placement: "page", pageIndex: 5 });
    expect(
      imageInsertionIntentFromDecision(
        { ...base, imageSubject: "a dragon", imagePlacement: "page", pageIndexes: [] },
        "somewhere nice"
      ).imageEdit
    ).toEqual({ subject: "a dragon" });
  });

  it("asks the one subject question when nothing names a subject", () => {
    const intent = imageInsertionIntentFromDecision({ ...base, pageIndexes: [] }, "add a picture somewhere");
    expect(intent.kind).toBe("clarify");
    // "scope" is the tautology that stores the resumable pendingEdit.
    expect(intent.clarification).toBe("scope");
    // Any question must state the default it will apply.
    expect(intent.assistantMessage).toMatch(/go ahead/i);
  });

  it("raises a replacement request the proposal path must resolve — never a target of its own", () => {
    const intent = imageInsertionIntentFromDecision(
      { ...base, imageSubject: "a castle", imageReplace: true },
      "No, I actually want a photo of a castle"
    );
    expect(intent.kind).toBe("add_image");
    // The router cannot know which insertions exist; the empty operationId is
    // the request marker the server resolves against the live book.
    expect(intent.imageEdit).toEqual({ subject: "a castle", replace: { operationId: "" } });
  });

  it("still asks the subject question for a replacement with no new subject", () => {
    const intent = imageInsertionIntentFromDecision(
      { ...base, imageReplace: true, pageIndexes: [] },
      "replace the picture"
    );
    expect(intent.kind).toBe("clarify");
  });

  it("uses the deterministic generic subject once the budget is spent — never the raw message", () => {
    const intent = imageInsertionIntentFromDecision(
      { ...base, pageIndexes: [] },
      "add a picture somewhere\n\nFollow-up from the user: just add",
      { clarifyExhausted: true }
    );
    expect(intent.kind).toBe("add_image");
    expect(intent.imageEdit?.subject).toBe("a scene from this book");
  });
});

describe("clippedImageSubject", () => {
  it("caps long subjects with an ellipsis and collapses whitespace", () => {
    expect(clippedImageSubject("a dragon")).toBe("a dragon");
    expect(clippedImageSubject("a   dragon\nover the sea")).toBe("a dragon over the sea");
    const long = "x".repeat(80);
    expect(clippedImageSubject(long)).toHaveLength(60);
    expect(clippedImageSubject(long).endsWith("…")).toBe(true);
  });
});
