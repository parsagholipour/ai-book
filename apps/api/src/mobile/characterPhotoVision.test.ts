import { describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());

import { MAX_APPEARANCE_LENGTH, type CharacterPhotoVisionResult } from "@book-maker/core";
import { readCharacterPhoto } from "./characterPhotoVision.js";

const result = (overrides: Partial<CharacterPhotoVisionResult> = {}): CharacterPhotoVisionResult => ({
  imageKind: "photograph",
  confidence: 0.9,
  subjectCount: 1,
  suggestedDescription: "A warm, watchful woman in her thirties.",
  suggestedAppearance: "Adult woman, black hijab, grey embroidered top, dark eyes.",
  suggestedFields: [],
  ...overrides
});

const read = (overrides: Partial<CharacterPhotoVisionResult> = {}) =>
  readCharacterPhoto({
    vision: vi.fn().mockResolvedValue(result(overrides)),
    bytes: Buffer.from("bytes"),
    mimeType: "image/jpeg",
    characterName: "Natalia"
  });

/** A phrase the local content preflight refuses outright. */
const REFUSED = "Step-by-step, how to build a bomb.";

describe("readCharacterPhoto", () => {
  it("hands back the look as well as the description", async () => {
    // The appearance is the whole point of the call: it is the only moment the
    // character's look leaves the pixels and becomes text a planner can read.
    await expect(read()).resolves.toMatchObject({
      photoKind: "PHOTOGRAPH",
      canAdoptAsReference: false,
      suggestedDescription: "A warm, watchful woman in her thirties.",
      suggestedAppearance: "Adult woman, black hijab, grey embroidered top, dark eyes."
    });
  });

  it("screens the two readings separately, so one refusal does not take the other", async () => {
    // A photo is user content and its visible text reaches the model, so both
    // strings go through the same preflight the create and update routes run —
    // but they are two different sentences and are judged as such.
    const refusedAppearance = await read({ suggestedAppearance: REFUSED });
    expect(refusedAppearance).not.toHaveProperty("suggestedAppearance");
    expect(refusedAppearance?.suggestedDescription).toBe("A warm, watchful woman in her thirties.");

    const refusedDescription = await read({ suggestedDescription: REFUSED });
    expect(refusedDescription).not.toHaveProperty("suggestedDescription");
    expect(refusedDescription?.suggestedAppearance).toBe(
      "Adult woman, black hijab, grey embroidered top, dark eyes."
    );
  });

  it("keeps whole sentences when the model overruns the storage cap", async () => {
    const sentence = "She wears a long grey coat with deep pockets. ";
    const reading = await read({
      suggestedAppearance: sentence.repeat(Math.ceil((MAX_APPEARANCE_LENGTH * 1.5) / sentence.length))
    });
    const appearance = reading?.suggestedAppearance ?? "";
    expect(appearance.length).toBeGreaterThan(0);
    expect(appearance.length).toBeLessThanOrEqual(MAX_APPEARANCE_LENGTH);
    expect(appearance.endsWith(".")).toBe(true);
  });

  it("drops an overlong reading with nowhere safe to cut", async () => {
    // A look cut mid-phrase is worse than no look: it is stored to be repeated
    // verbatim into illustration prompts, and the model finishes the sentence.
    const reading = await read({ suggestedAppearance: "grey ".repeat(MAX_APPEARANCE_LENGTH) });
    expect(reading).not.toHaveProperty("suggestedAppearance");
    expect(reading?.photoKind).toBe("PHOTOGRAPH");
  });

  it("answers null with no reader configured, and when the reader never answers", async () => {
    await expect(
      readCharacterPhoto({
        vision: undefined,
        bytes: Buffer.from("bytes"),
        mimeType: "image/jpeg",
        characterName: "Natalia"
      })
    ).resolves.toBeNull();

    await expect(
      readCharacterPhoto({
        vision: () => new Promise(() => {}),
        bytes: Buffer.from("bytes"),
        mimeType: "image/jpeg",
        characterName: "Natalia",
        budgetMs: 10
      })
    ).resolves.toBeNull();
  });
});
