import { expect, it, vi } from "vitest";
import { createProjectSchema, makeFallbackPlan } from "@book-maker/core";
vi.mock("@book-maker/db", () => ({ prisma: {} }));
import { buildManuscriptCoverageContext } from "./manuscriptCoverageReview.js";

const input = createProjectSchema.parse({ prompt: "Rabbit and Turtle carry a lantern. No illustrations, images, or cover artwork.",
  category: "KIDS", targetPages: 30, mediaSettings: { fullIllustrations: false, includeCover: false, coverArtSource: "none" } });
const plan = makeFallbackPlan(input);
const page = { index: 1, markdown: "Rabbit asks Turtle for help.", images: [] };
const reference = { id: "reference", type: "CHARACTER_REFERENCE", path: "reference.png", metadata: {} };

it("proves empty export inventory even when the project retains character references", () => {
  const context = buildManuscriptCoverageContext({ input, plan, pages: [page], images: [reference] });
  expect(context.mediaInventory).toEqual({ storyPagesWithArtwork: [], coverArtworkCount: 0 });
  expect(context.referenceProvenance).toHaveLength(1);
});

it("counts existing interior and cover assets despite disabled generation settings", () => {
  const context = buildManuscriptCoverageContext({ input, plan,
    pages: [{ ...page, images: [{ type: "DIAGRAM" }] }], images: [{ ...reference, type: "COVER" }] });
  expect(context.mediaInventory).toEqual({ storyPagesWithArtwork: [1], coverArtworkCount: 1 });
});

it.each([
  "![Lantern](lantern.png)",
  "![Lantern][art]\n\n[art]: lantern.png",
  '<img src="lantern.png">',
  '<svg><circle r="5" /></svg>',
  '```figure\n{"kind":"bar","title":"Lanterns","categories":["A","B"],"series":[{"name":"Count","values":[1,2]}],"source":"Test data"}\n```'
])("counts embedded artwork without an image asset: %s", (markdown) => {
  const context = buildManuscriptCoverageContext({ input, plan, pages: [{ ...page, markdown }], images: [] });
  expect(context.mediaInventory?.storyPagesWithArtwork).toEqual([1]);
});

it.each([
  "The lantern cast a circle of light.",
  '`![Lantern](lantern.png)`',
  '```html\n<img src="lantern.png">\n```',
  '<!-- <img src="lantern.png"> -->',
  '```figure\nnot a renderable figure\n```'
])("does not mistake prose or code examples for artwork: %s", (markdown) => {
  const context = buildManuscriptCoverageContext({ input, plan, pages: [{ ...page, markdown }], images: [] });
  expect(context.mediaInventory?.storyPagesWithArtwork).toEqual([]);
});

it("keeps a missing page attachment inventory unknown", () => {
  const context = buildManuscriptCoverageContext({ input, plan, pages: [{ index: 1, markdown: page.markdown }], images: [] });
  expect(context.mediaInventory?.storyPagesWithArtwork).toBeUndefined();
  expect(context.mediaInventory?.coverArtworkCount).toBe(0);
});
