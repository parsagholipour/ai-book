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

  it("reads a length written in the user's own script and numerals", () => {
    // The message that went unread: a Persian brief naming its own length.
    expect(explicitTargetPagesFromText("یک کتاب ۳ صفحه ای بساز از بهترین حکایت بوستان سعدی با توضیحات")).toBe(3);
    // Persian joins the suffix with a ZWNJ, so the page word is matched as a prefix.
    expect(explicitTargetPagesFromText("کتاب ۳ صفحه‌ای")).toBe(3);
    expect(explicitTargetPagesFromText("اريد كتاب من ٢٥ صفحة")).toBe(25);
    expect(explicitTargetPagesFromText("做一本12页的书")).toBe(12);
    expect(explicitTargetPagesFromText("3ページの本")).toBe(3);
    expect(explicitTargetPagesFromText("12페이지 책")).toBe(12);
    expect(explicitTargetPagesFromText("หนังสือ 8 หน้า")).toBe(8);
    expect(explicitTargetPagesFromText("20 पेज की किताब")).toBe(20);
    expect(explicitTargetPagesFromText("un libro de 30 páginas")).toBe(30);
    expect(explicitTargetPagesFromText("ein Buch mit 15 Seiten")).toBe(15);
    expect(explicitTargetPagesFromText("ספר של 8 עמודים")).toBe(8);
  });

  it("mixes scripts, because the numerals and the page word need not agree", () => {
    expect(explicitTargetPagesFromText("۲۴ pages please")).toBe(24);
    expect(explicitTargetPagesFromText("24 صفحه")).toBe(24);
  });

  it("says nothing rather than the wrong thing when a length is ruled out or bounded", () => {
    // Asking is the right answer: none of these say what the book SHOULD be,
    // and a guess here sizes and charges for a book the user refused.
    expect(explicitTargetPagesFromText("it shouldn't be 10 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("don't make it 10 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("not a 10 page book")).toBeUndefined();
    expect(explicitTargetPagesFromText("no more than 10 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("more than 10 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("at least 20 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("fewer than 30 pages")).toBeUndefined();
    expect(explicitTargetPagesFromText("نباید ۱۰ صفحه باشد")).toBeUndefined();
    expect(explicitTargetPagesFromText("kein 10 Seiten Buch")).toBeUndefined();
  });

  it("keeps a negation inside its own clause", () => {
    expect(explicitTargetPagesFromText("make it 5 pages, not 10")).toBe(5);
    expect(explicitTargetPagesFromText("I do not want illustrations, 10 pages")).toBe(10);
    expect(explicitTargetPagesFromText("no cover please. 12 pages")).toBe(12);
    expect(explicitTargetPagesFromText("بدون تصویر، ۱۵ صفحه")).toBe(15);
    // An approximator is a real intent, not a refusal.
    expect(explicitTargetPagesFromText("about 12 pages please")).toBe(12);
    expect(explicitTargetPagesFromText("around 20 pages")).toBe(20);
    // "نه" is a substring of ordinary Persian words like "خانه"; suppressing on
    // it would re-break the very message this reader exists to understand.
    expect(explicitTargetPagesFromText("داستانی درباره خانه ۵ صفحه")).toBe(5);
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
