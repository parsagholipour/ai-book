import { describe, expect, it } from "vitest";
import { AUDIOBOOK_NARRATORS, resolveAudiobookNarratorVoice } from "./voices.js";

describe("audiobook narrator provider mapping", () => {
  it("resolves every persona to a valid Gemini and OpenAI voice", () => {
    expect(AUDIOBOOK_NARRATORS.map((narrator) => [
      narrator.voice,
      resolveAudiobookNarratorVoice(narrator.voice, "gemini_tts"),
      resolveAudiobookNarratorVoice(narrator.voice, "openai_tts")
    ])).toEqual([
      ["Zephyr", "Zephyr", "marin"],
      ["Charon", "Charon", "echo"],
      ["Kore", "Kore", "coral"],
      ["Aoede", "Aoede", "shimmer"],
      ["Enceladus", "Enceladus", "ballad"],
      ["Schedar", "Schedar", "alloy"],
      ["Sulafat", "Sulafat", "cedar"]
    ]);
  });

  it("does not silently choose a voice for an unknown persona", () => {
    expect(() => resolveAudiobookNarratorVoice("unknown", "openai_tts")).toThrow(/unsupported/i);
  });
});
