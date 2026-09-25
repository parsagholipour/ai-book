import { expect, it } from "vitest";
import { shortKidsStoryPageLayout } from "@book-maker/core";
import { shortPictureBookReaderChapters } from "./shortPictureBookExport.js";

const pages = Array.from({ length: 30 }, (_, i) => ({ index: i + 1, title: `Scene ${i + 1}`,
  markdown: "Rabbit and Turtle carry the lantern together.", summary: "A scene.",
  chapter: { id: `c${Math.floor(i / 5)}`, index: Math.floor(i / 5) + 1, title: `Current title ${Math.floor(i / 5) + 1}`, summary: "Current division." } }));
const options = { input: { prompt: "A woodland story.", category: "KIDS", targetPages: 30,
  mediaSettings: { generationStrategy: "auto", finalReview: true, fullIllustrations: true } },
  plan: { title: "Book", chapters: [] }, strategy: { shouldIllustratePage: () => true }, pages } as unknown as Parameters<typeof shortPictureBookReaderChapters>[0];
it("keeps complete short Kids scenes on separate sheets independently of images, review or strategy", () => {
  expect(shortKidsStoryPageLayout(options.input, pages)).toBe("separate");
  expect(shortKidsStoryPageLayout({ ...options.input, mediaSettings: {
    ...options.input.mediaSettings, fullIllustrations: false, finalReview: false, generationStrategy: "draft-then-polish"
  } }, pages)).toBe("separate");
});
it("leaves imported, adult, long and incomplete inventories outside story-page layout", () => {
  expect(shortKidsStoryPageLayout({ ...options.input, category: "STORY" }, pages)).toBeUndefined();
  expect(shortKidsStoryPageLayout({ ...options.input, targetPages: 41 }, pages)).toBeUndefined();
  expect(shortKidsStoryPageLayout({ ...options.input, mediaSettings: {
    ...options.input.mediaSettings, mobile: { import: { source: "manuscript" } }
  } }, pages)).toBeUndefined();
  for (const changed of [pages.slice(1), [...pages].reverse(), pages.map((p, i) => i === 1 ? { ...p, markdown: "" } : p)]) {
    expect(shortKidsStoryPageLayout(options.input, changed)).toBeUndefined();
  }
});
it("uses the existing exact titled page partition without inventing reader chapters", () => {
  expect(shortPictureBookReaderChapters(options)).toEqual(Array.from({ length: 6 }, (_, i) => ({ index: i + 1,
    title: `Current title ${i + 1}`, summary: "Current division.", startPageIndex: i * 5 + 1, endPageIndex: i * 5 + 5 })));
});
it("reuses the same complete chapter partition for text-only stories", () => {
  expect(shortPictureBookReaderChapters({ ...options, input: { ...options.input, mediaSettings: {
    ...options.input.mediaSettings, fullIllustrations: false, coverArtSource: "none"
  } }, strategy: { ...options.strategy, shouldIllustratePage: () => false } })).toEqual(shortPictureBookReaderChapters(options));
});
it("declines incomplete, unordered, duplicate, discontiguous or conflicting chapter membership", () => {
  for (const changed of [pages.slice(1), [...pages].reverse(), pages.map((p, i) => i === 9 ? pages[8]! : p),
    pages.map((p, i) => i === 15 ? { ...p, chapter: pages[0]!.chapter } : p),
    pages.map((p, i) => i === 1 ? { ...p, chapter: { ...p.chapter, title: "Conflicting title" } } : p)]) {
    expect(shortPictureBookReaderChapters({ ...options, pages: changed as never })).toBeUndefined();
  }
  expect(shortPictureBookReaderChapters({ ...options, input: { ...options.input, mediaSettings: { ...options.input.mediaSettings, generationStrategy: "draft-then-polish" } } })).toBeUndefined();
  expect(shortPictureBookReaderChapters({ ...options, strategy: { ...options.strategy, researchDepth: 1 } })).toBeUndefined();
  expect(shortPictureBookReaderChapters({ ...options, input: { ...options.input, mediaSettings: {
    ...options.input.mediaSettings, mobile: { import: { source: "manuscript" } }
  } } })).toBeUndefined();
});
