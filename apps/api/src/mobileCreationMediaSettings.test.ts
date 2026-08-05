import { describe, expect, it } from "vitest";
import {
  chatSettingChangesFromMessage,
  deterministicCreationTurn,
  mergeMobileCreationPresets,
  mobileCreationDraftPayloadSchema,
  mobileCreationPresetsSchema
} from "./mobileCreation.js";

describe("mobile creation image settings", () => {
  const basePresets = {
    bookType: "lead_magnet" as const,
    bookTypeChoice: "auto" as const,
    lengthPreset: "short" as const,
    qualityPreset: "balanced" as const,
    imagesEnabled: true,
    coverEnabled: true,
    illustrationsEnabled: true
  };

  it("applies a broad no-images request to cover and illustrations", () => {
    const turn = deterministicCreationTurn({
      messages: [
        { role: "user", content: "A guide to sourdough baking for beginners" },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "No images please" }
      ],
      presets: basePresets
    });

    expect(turn.presets).toMatchObject({
      imagesEnabled: false,
      coverEnabled: false,
      illustrationsEnabled: false
    });
    expect(turn.assistantMessage).toMatch(/text-first|no images/i);
  });

  it("keeps cover and in-book illustration chat choices independent", () => {
    const coverOnly = deterministicCreationTurn({
      messages: [{ role: "user", content: "A guide to bread, with a cover but no illustrations" }],
      presets: basePresets
    });
    const illustrationsOnly = deterministicCreationTurn({
      messages: [{ role: "user", content: "A guide to bread. No cover, but keep the illustrations" }],
      presets: basePresets
    });

    expect(coverOnly.presets).toMatchObject({
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: false
    });
    expect(coverOnly.assistantMessage).toMatch(/cover.+no in-book illustrations/i);
    expect(illustrationsOnly.presets).toMatchObject({
      imagesEnabled: true,
      coverEnabled: false,
      illustrationsEnabled: true
    });
    expect(illustrationsOnly.assistantMessage).toMatch(/illustrations.+no cover/i);
    expect(chatSettingChangesFromMessage("No illustrations")).toEqual({ illustrationsEnabled: false });
    expect(chatSettingChangesFromMessage("No cover")).toEqual({ coverEnabled: false });
    expect(chatSettingChangesFromMessage("No images")).toMatchObject({
      imagesEnabled: false,
      coverEnabled: false,
      illustrationsEnabled: false
    });
  });

  it("normalizes legacy presets and preserves split settings across old-client echoes", () => {
    const legacy = {
      bookType: "lead_magnet" as const,
      lengthPreset: "short" as const,
      qualityPreset: "balanced" as const,
      imagesEnabled: false
    };
    expect(mobileCreationPresetsSchema.parse(legacy)).toMatchObject({
      imagesEnabled: false,
      coverEnabled: false,
      illustrationsEnabled: false
    });
    expect(
      mobileCreationDraftPayloadSchema.parse({ payloadVersion: 2, selectedPresets: legacy }).selectedPresets
    ).toMatchObject({ imagesEnabled: false, coverEnabled: false, illustrationsEnabled: false });

    const stored = mobileCreationPresetsSchema.parse({
      ...legacy,
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: false
    });
    expect(mergeMobileCreationPresets(stored, { ...legacy, imagesEnabled: true })).toMatchObject({
      imagesEnabled: true,
      coverEnabled: true,
      illustrationsEnabled: false
    });
    expect(mergeMobileCreationPresets(stored, { ...legacy, imagesEnabled: false })).toMatchObject({
      imagesEnabled: false,
      coverEnabled: false,
      illustrationsEnabled: false
    });
    expect(
      mergeMobileCreationPresets(stored, {
        bookType: "lead_magnet",
        lengthPreset: "short",
        qualityPreset: "balanced",
        illustrationsEnabled: true
      })
    ).toMatchObject({ imagesEnabled: true, coverEnabled: true, illustrationsEnabled: true });
  });
});
