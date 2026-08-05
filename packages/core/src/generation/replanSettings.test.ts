import { describe, expect, it } from "vitest";
import { createProjectSchema, mediaSettingsSchema } from "../schemas/book.js";
import {
  explicitTargetPagesFromText,
  inputWithReplanSettings,
  mediaSettingsWithReplanSettings,
  negativeMediaPreferenceFromMessage,
  replanSettingsFromMessage
} from "./replanSettings.js";

const illustratedMediaSettings = () =>
  mediaSettingsSchema.parse({
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "business",
    finalReview: true,
    toneProfile: "confident",
    mobile: { imagesEnabled: true, targetPages: 8, lengthPreset: "short", pageCountMode: "custom" }
  });

const illustratedInput = () =>
  createProjectSchema.parse({
    prompt: "A practical guide to budget shops.",
    category: "BUSINESS",
    targetPages: 8,
    mediaSettings: illustratedMediaSettings()
  });

describe("explicitTargetPagesFromText", () => {
  it("reads a book length out of the phrasings the chats actually use", () => {
    expect(explicitTargetPagesFromText("make it 3 pages without illustrations")).toBe(3);
    expect(explicitTargetPagesFromText("I want a 24 page workbook")).toBe(24);
    expect(explicitTargetPagesFromText("page count: 12")).toBe(12);
  });

  it("takes the last number, so a message that revises itself means what it ended on", () => {
    expect(explicitTargetPagesFromText("8 pages, actually make it 3 pages")).toBe(3);
  });

  it("returns undefined when no length is named or the number is out of range", () => {
    expect(explicitTargetPagesFromText("make the tone warmer")).toBeUndefined();
    expect(explicitTargetPagesFromText("a 900 page book")).toBeUndefined();
  });
});

describe("negativeMediaPreferenceFromMessage", () => {
  it("separates dropping illustrations from dropping the cover", () => {
    expect(negativeMediaPreferenceFromMessage("make it 3 pages without illustrations")).toEqual({
      disableIllustrations: true,
      disableCover: false
    });
    // A broad word covers both; nobody saying "no images" means "except the cover".
    expect(negativeMediaPreferenceFromMessage("no images please")).toEqual({
      disableIllustrations: true,
      disableCover: true
    });
    expect(negativeMediaPreferenceFromMessage("make it longer")).toBeNull();
  });

  it("has no positive form", () => {
    expect(negativeMediaPreferenceFromMessage("add illustrations to every chapter")).toBeNull();
    expect(replanSettingsFromMessage("add illustrations to every chapter")).toEqual({});
  });
});

describe("mediaSettingsWithReplanSettings", () => {
  it("drops illustrations without dropping the cover, and keeps the app's flag on", () => {
    const result = mediaSettingsWithReplanSettings(illustratedMediaSettings(), { fullIllustrations: false });
    expect(result.fullIllustrations).toBe(false);
    expect(result.illustrationCadence).toBe("manual");
    expect(result.includeCover).toBe(true);
    // imagesEnabled is the app's single "this book has pictures" flag, and a
    // cover is still a picture.
    expect((result.mobile as Record<string, unknown>).imagesEnabled).toBe(true);
  });

  it("turns the app's flag off only when nothing visual survives", () => {
    const result = mediaSettingsWithReplanSettings(illustratedMediaSettings(), {
      fullIllustrations: false,
      includeCover: false
    });
    expect((result.mobile as Record<string, unknown>).imagesEnabled).toBe(false);
  });

  it("records a chat-chosen page count as a custom count, not a leftover", () => {
    const mobile = mediaSettingsWithReplanSettings(illustratedMediaSettings(), { targetPages: 3 }).mobile as Record<
      string,
      unknown
    >;
    expect(mobile).toMatchObject({
      targetPages: 3,
      lengthPreset: "custom",
      pageCountMode: "custom",
      pageCountSource: "chat"
    });
  });

  it("leaves everything alone when the request named nothing", () => {
    const settings = illustratedMediaSettings();
    expect(mediaSettingsWithReplanSettings(settings, {})).toBe(settings);
    expect(mediaSettingsWithReplanSettings(settings, null)).toBe(settings);
  });
});

describe("inputWithReplanSettings", () => {
  it("resizes the book and de-illustrates it together", () => {
    const result = inputWithReplanSettings(illustratedInput(), { targetPages: 3, fullIllustrations: false });
    expect(result.targetPages).toBe(3);
    expect(result.mediaSettings.fullIllustrations).toBe(false);
    expect((result.mediaSettings.mobile as Record<string, unknown>).targetPages).toBe(3);
  });

  it("is a no-op for a replan that named no settings", () => {
    const input = illustratedInput();
    expect(inputWithReplanSettings(input, undefined)).toBe(input);
    expect(inputWithReplanSettings(input, {})).toBe(input);
  });
});
