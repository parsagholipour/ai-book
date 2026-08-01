import { describe, expect, it } from "vitest";
import { backMatterEditFromMessage, backMatterIntentFromMessage } from "./bookEditBackMatter.js";

describe("back matter edit detection", () => {
  it("recognises requests to drop the sources list", () => {
    for (const message of [
      "Remove the sources at the end",
      "Please delete the references section",
      "get rid of the bibliography",
      "I don't want the citations at the end of the book",
      "take out the works cited list",
      "the book should be without sources"
    ]) {
      expect(backMatterEditFromMessage(message), message).toEqual({ includeSources: false });
    }
  });

  it("recognises requests to bring the sources list back", () => {
    for (const message of [
      "Add the sources back at the end",
      "Please include the references again",
      "put the bibliography back"
    ]) {
      expect(backMatterEditFromMessage(message), message).toEqual({ includeSources: true });
    }
  });

  it("leaves page-scoped and ambiguous mentions to the normal routing path", () => {
    for (const message of [
      // Names a page: this is prose, not the compiled back matter.
      "Remove the sources paragraph on page 4",
      "Delete the citation in chapter 2",
      // Questions are answers, not edits.
      "Why are there sources at the end?",
      "What sources did you use?",
      // Different subject entirely.
      "Remove the source material I pasted",
      "Drop the open-source chapter",
      // No sources mention at all.
      "Remove the last paragraph"
    ]) {
      expect(backMatterEditFromMessage(message), message).toBeNull();
    }
  });

  it("builds a free back_matter intent with no affected pages", () => {
    const intent = backMatterIntentFromMessage("Remove the sources at the end");

    expect(intent).toMatchObject({
      kind: "back_matter",
      backMatter: { includeSources: false },
      affectedPageIndexes: [],
      scope: "none",
      clarification: "none"
    });
    expect(backMatterIntentFromMessage("Make chapter two funnier")).toBeNull();
  });
});
