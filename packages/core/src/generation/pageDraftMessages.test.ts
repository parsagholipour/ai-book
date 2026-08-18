import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";
import { buildPageDraftMessages, buildPageDraftUserPayload } from "./pageDraftMessages.js";
import type { GeneratePageOptions } from "./pagesShared.js";

const input: CreateProjectInput = {
  prompt: "Jack The Martyr, a character-led story about sacrifice and consequence.",
  category: "STORY",
  targetPages: 10,
  complexity: 5,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral" as const
  }
};

const plan = makeFallbackPlan(input);

const options = (overrides: Partial<GeneratePageOptions> = {}): GeneratePageOptions => ({
  input,
  plan,
  pageIndex: 4,
  previousSummaries: ["Jack reaches the chapel."],
  previousPages: [
    { index: 3, title: "The Chapel", markdown: "Jack reached the chapel door.", summary: "Jack arrives." }
  ],
  continuityNotes: [],
  researchNotes: [],
  textModel: new FakeTextModelAdapter(input),
  ...overrides
});

/**
 * A book written front to back never needs to look forward, which is why this
 * context has only ever looked back. A page inserted into a *finished* book
 * does: it has to hand off to prose the reader already has.
 */
describe("forward context for an inserted page", () => {
  const following = [
    { index: 5, title: "The Warning", markdown: "Inside, the seal was already cracked.", summary: "Jack finds the seal." }
  ];

  it("adds nothing at all when no page follows", () => {
    const payload = buildPageDraftUserPayload(options()) as Record<string, unknown>;
    const system = String(buildPageDraftMessages(options())[0]?.content);

    expect(payload).not.toHaveProperty("followingPages");
    expect(system).not.toContain("followingPages");
  });

  it("names the prose the page must land into, and says not to repeat it", () => {
    const withNext = options({ nextPages: following });
    const payload = buildPageDraftUserPayload(withNext) as Record<string, unknown>;
    const system = String(buildPageDraftMessages(withNext)[0]?.content);

    expect(payload.followingPages).toEqual([
      expect.objectContaining({ index: 5, excerpt: "Inside, the seal was already cracked." })
    ]);
    expect(system).toContain("followingPages");
    expect(system).toContain("reads on naturally");
  });

  it("keeps the forward window tighter than the backward one", () => {
    // Two pages, not five: the hand-off is settled by the opening of the next
    // page, and a wide forward window invites the draft to write its beats.
    const many = [5, 6, 7, 8].map((index) => ({
      index,
      title: `Page ${index}`,
      markdown: `Body ${index}.`,
      summary: `Summary ${index}.`
    }));
    const payload = buildPageDraftUserPayload(options({ nextPages: many })) as {
      followingPages: { index: number }[];
    };

    expect(payload.followingPages.map((page) => page.index)).toEqual([5, 6]);
  });
});
