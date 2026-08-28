import { describe, expect, it } from "vitest";
import {
  characterReferencePromptInstruction,
  type CharacterReferenceSelection
} from "./characterReferencePrompt.js";

/**
 * A premium page's attachment: three per-book sheets, then the reader's own
 * saved artwork for two of those characters appended into the spare budget.
 */
const selection: CharacterReferenceSelection = {
  paths: ["/sheets/ada.png", "/sheets/bea.png", "/sheets/cid.png", "/faces/ada.png", "/faces/bea.png"],
  libraryFaceNames: ["Ada", "Bea"]
};

describe("characterReferencePromptInstruction", () => {
  it("counts every picture when the whole selection is attached", () => {
    const instruction = characterReferencePromptInstruction(selection);

    expect(instruction).toContain("Use the 5 attached character reference images");
    expect(instruction).toContain("The last 2 reference images are the reader's own saved artwork for Ada and Bea.");
  });

  it("counts what is attached, not what was selected", () => {
    // What a `qwen-image-2.0-pro` fallback can take of a `gemini-3-pro-image`
    // attachment. Left at five, the model is told two pictures are there that
    // are not.
    const instruction = characterReferencePromptInstruction(selection, selection.paths.slice(0, 3));

    expect(instruction).toContain("Use the 3 attached character reference images");
    expect(instruction).not.toContain("Use the 5 attached");
  });

  it("drops a saved-face attribution whose own picture was left behind", () => {
    const instruction = characterReferencePromptInstruction(selection, selection.paths.slice(0, 3));

    // The bug this exists for: with the sentence left standing, "the last 2
    // reference images" names Bea's and Cid's *sheets* as Ada's and Bea's
    // saved faces, to be matched exactly — a wrong face, drawn silently.
    expect(instruction).not.toContain("saved artwork");
    expect(instruction).not.toContain("Ada");
    expect(instruction).not.toContain("Bea");
  });

  it("keeps the attribution of a face that is still attached, and only that one", () => {
    const instruction = characterReferencePromptInstruction(selection, selection.paths.slice(0, 4));

    expect(instruction).toContain("Use the 4 attached character reference images");
    expect(instruction).toContain("The last reference image is the reader's own saved artwork for Ada.");
    expect(instruction).not.toContain("Bea");
  });

  it("pairs names to files rather than to the count, whatever subset is sent", () => {
    const instruction = characterReferencePromptInstruction(selection, [
      "/sheets/ada.png",
      "/sheets/bea.png",
      "/sheets/cid.png",
      "/faces/bea.png"
    ]);

    expect(instruction).toContain("Use the 4 attached character reference images");
    expect(instruction).toContain("The last reference image is the reader's own saved artwork for Bea.");
    expect(instruction).not.toContain("Ada");
  });

  it("says nothing when nothing is attached", () => {
    expect(characterReferencePromptInstruction(selection, [])).toBe("");
    expect(characterReferencePromptInstruction({ paths: [], libraryFaceNames: [] })).toBe("");
  });
});
