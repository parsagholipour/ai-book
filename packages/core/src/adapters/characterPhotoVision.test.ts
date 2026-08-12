import { describe, expect, it } from "vitest";
import {
  canAdoptCharacterPhoto,
  createCharacterPhotoVisionAdapter,
  FakeCharacterPhotoVisionAdapter,
  type CharacterPhotoVisionResult
} from "./characterPhotoVision.js";
import type { AppConfig } from "../config.js";

const reading = (overrides: Partial<CharacterPhotoVisionResult> = {}): CharacterPhotoVisionResult => ({
  imageKind: "illustration",
  confidence: 0.95,
  subjectCount: 1,
  suggestedDescription: "A round-faced girl with short black hair and a yellow raincoat.",
  suggestedFields: [],
  ...overrides
});

const config = (overrides: Partial<AppConfig>): AppConfig => overrides as AppConfig;

describe("createCharacterPhotoVisionAdapter", () => {
  it("returns the fake reader under MOCK_AI", () => {
    expect(createCharacterPhotoVisionAdapter(config({ MOCK_AI: true }))).toBeInstanceOf(
      FakeCharacterPhotoVisionAdapter
    );
  });

  it("returns undefined with no vision provider configured", () => {
    // Undefined is a supported state: the upload still stores the photo, it
    // just carries no suggestion and no verdict.
    expect(createCharacterPhotoVisionAdapter(config({ MOCK_AI: false }))).toBeUndefined();
  });
});

describe("FakeCharacterPhotoVisionAdapter", () => {
  it("answers photograph, so a local run never adopts an image nothing looked at", async () => {
    const result = await new FakeCharacterPhotoVisionAdapter().describeCharacterPhoto({
      data: Buffer.from("not-really-an-image"),
      mimeType: "image/jpeg",
      characterName: "Luna"
    });
    expect(result.imageKind).toBe("photograph");
    expect(canAdoptCharacterPhoto(result)).toBe(false);
    expect(result.suggestedDescription).toContain("Luna");
  });
});

describe("canAdoptCharacterPhoto", () => {
  it("adopts a confident single-subject illustration", () => {
    expect(canAdoptCharacterPhoto(reading())).toBe(true);
  });

  it("refuses a photograph", () => {
    expect(canAdoptCharacterPhoto(reading({ imageKind: "photograph" }))).toBe(false);
  });

  it("refuses an unsure verdict", () => {
    // "unknown" is treated as a photograph: adopting a real face by mistake is
    // the only outcome here that cannot be undone.
    expect(canAdoptCharacterPhoto(reading({ imageKind: "unknown", confidence: 1 }))).toBe(false);
  });

  it("refuses a low-confidence illustration", () => {
    expect(canAdoptCharacterPhoto(reading({ confidence: 0.5 }))).toBe(false);
  });

  it("refuses artwork with no subject, or with a cast in it", () => {
    // An adopted reference is attached to every page render as the
    // authoritative design source, so a group shot may not become one.
    expect(canAdoptCharacterPhoto(reading({ subjectCount: 0 }))).toBe(false);
    expect(canAdoptCharacterPhoto(reading({ subjectCount: 3 }))).toBe(false);
  });
});
