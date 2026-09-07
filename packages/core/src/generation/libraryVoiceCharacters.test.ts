import { describe, expect, it } from "vitest";
import {
  buildLibraryCharacterInstructions,
  inferLibraryCharacterVoiceProfile
} from "./libraryVoiceCharacters.js";

const mina = {
  name: "Mina Park",
  description: "A brave, curious nine-year-old who is always muddy and asks too many questions.",
  appearance: "Short black hair, a yellow raincoat and red boots.",
  fields: [
    { key: "Age", value: "9" },
    { key: "Likes", value: "thunderstorms" }
  ]
};

describe("buildLibraryCharacterInstructions", () => {
  it("speaks in the first person from the reader's own notes", () => {
    const instructions = buildLibraryCharacterInstructions(mina);

    expect(instructions).toContain("You are Mina Park, a character the caller created themselves");
    expect(instructions).toContain("Who you are, in the caller's own words: A brave, curious nine-year-old");
    expect(instructions).toContain("What you look like: Short black hair, a yellow raincoat and red boots.");
    expect(instructions).toContain("Details the caller wrote down: Age: 9. Likes: thunderstorms.");
    expect(instructions).toContain("remain in first person as Mina Park");
    // The book persona's rule, kept word for word: a saved character is not a
    // licence to play a real person.
    expect(instructions).toContain("Do not impersonate a real living person");
  });

  it("says there is no book and tells the character to improvise inside the notes", () => {
    const instructions = buildLibraryCharacterInstructions(mina);

    expect(instructions).toContain("no plot to protect and nothing to spoil");
    expect(instructions).toContain("improvise in keeping with them");
    expect(instructions).toContain("never contradict what they wrote");
    // The book prompt's spoiler machinery has no place here.
    expect(instructions).not.toContain("Spoiler boundaries");
  });

  it("leaves out every line the notes do not fill", () => {
    const instructions = buildLibraryCharacterInstructions({
      name: "Bram",
      description: "",
      appearance: null,
      fields: [{ key: "", value: "ignored" }]
    });

    expect(instructions).not.toContain("Who you are");
    expect(instructions).not.toContain("What you look like");
    expect(instructions).not.toContain("Details the caller wrote down");
    expect(instructions).toContain("You are Bram");
  });

  it("grounds the character in the reader's other saved characters, never in itself", () => {
    const instructions = buildLibraryCharacterInstructions(mina, [
      { name: "Bram", description: "Mina's older cousin, a worrier." },
      { name: "bram", description: "A duplicate spelling." },
      { name: "Mina Park", description: "The character herself, mentioned back." },
      { name: "  ", description: "Nobody." }
    ]);

    expect(instructions).toContain("People you know — the caller's other saved characters:");
    expect(instructions).toContain("- Bram: Mina's older cousin, a worrier.");
    expect(instructions).not.toContain("A duplicate spelling");
    expect(instructions).not.toContain("The character herself");
    expect(instructions).toContain("recognize every listed character");
  });

  it("adds no cast block when there is nobody to list", () => {
    expect(buildLibraryCharacterInstructions(mina)).not.toContain("People you know");
  });
});

describe("inferLibraryCharacterVoiceProfile", () => {
  it("reads age, energy and warmth off the notes the way a plan character's voice is read", () => {
    const profile = inferLibraryCharacterVoiceProfile(mina);

    expect(profile.ageBand).toBe("child");
    expect(profile.energy).toBe("high");
  });

  it("falls back to a neutral adult voice for notes that say nothing", () => {
    const profile = inferLibraryCharacterVoiceProfile({ name: "Bram", description: "", fields: [] });

    expect(profile).toMatchObject({ ageBand: "adult", genderPresentation: "unknown", energy: "medium" });
  });
});
