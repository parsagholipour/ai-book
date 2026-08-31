import { describe, expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import { pageDraftSchema, type CreateProjectInput } from "../schemas/book.js";
import { buildPageDraftSystemContent, buildPageDraftUserPayload } from "./pageDraftMessages.js";
import type { GeneratePageOptions, PriorPageContext } from "./pagesShared.js";

const input: CreateProjectInput = {
  prompt: "A city archivist follows a disputed map through a flooded quarter.",
  category: "STORY",
  targetPages: 30,
  complexity: 6,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: false,
    illustrationCadence: "template-driven",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

const plan = makeFallbackPlan(input);

function page(index: number, overrides: Partial<PriorPageContext> = {}): PriorPageContext {
  return {
    index,
    title: `Turn ${index}`,
    markdown: `PRIOR_MARKDOWN_${index} ${"prose ".repeat(180)}`,
    summary: `The archivist completes turn ${index} and carries its consequence forward.`,
    ...overrides
  };
}

function options(overrides: Partial<GeneratePageOptions> = {}): GeneratePageOptions {
  const previousPages = overrides.previousPages ?? [];
  return {
    input,
    plan,
    chapter: plan.chapters[0],
    pageIndex: 1,
    previousPages,
    previousSummaries: previousPages.map((entry) => entry.summary),
    continuityNotes: [],
    researchNotes: [],
    textModel: new FakeTextModelAdapter(input),
    ...overrides
  };
}

describe("page draft context modes", () => {
  it("defaults existing callers to the five-page excerpted payload", () => {
    const previousPages = Array.from({ length: 6 }, (_, index) =>
      page(index + 1, { markdown: `page-${index + 1} ${"x".repeat(1_200)}` })
    );
    const payload = buildPageDraftUserPayload(
      options({
        pageIndex: 7,
        previousPages,
        previousSummaries: previousPages.map((entry) => entry.summary),
        styleExcerpts: ["STYLE_LOCK_PROSE"]
      })
    ) as Record<string, unknown>;

    expect(payload.pageDraftContextMode).toBe("excerpted");
    expect(payload).not.toHaveProperty("nearestPriorPage");
    expect((payload.recentPages as Array<{ index: number; excerpt: string }>).map((entry) => entry.index)).toEqual([
      2,
      3,
      4,
      5,
      6
    ]);
    expect((payload.recentPages as Array<{ excerpt: string }>).every((entry) => entry.excerpt.length === 1_000)).toBe(
      true
    );
    expect(payload.alreadyCovered).toHaveLength(5);
    expect(payload.styleExcerpts).toEqual(["STYLE_LOCK_PROSE"]);
    expect(payload.pageInstruction).toMatch(/one or two compact sentences/i);
    expect(payload.pageInstruction).toMatch(/outcome or conclusion.*important facts or decisions.*unresolved handoff/i);
  });

  it("serializes compact indexed memory and only one bounded nearest-page excerpt", () => {
    const previousPages = Array.from({ length: 20 }, (_, index) => page(index + 1));
    const multilingualMarkdown = `${"آغاز🙂中".repeat(100)}MIDDLE_ONLY${"پایان🌙文".repeat(100)}`;
    previousPages[19] = page(20, {
      markdown: multilingualMarkdown,
      summary: `DECISION ${"重要🙂".repeat(180)}`
    });

    const payload = buildPageDraftUserPayload(
      options({
        pageDraftContextMode: "compact",
        pageIndex: 21,
        previousPages,
        previousSummaries: previousPages.map((entry) => entry.summary),
        continuityNotes: ["The blue map is water-damaged."],
        semanticMemory: ["Page 2 planted the brass floodgate key."],
        entityState: ["Mara — at the east archive; carries the blue map."],
        styleExcerpts: ["STYLE_LOCK_PROSE"]
      })
    ) as Record<string, any>;

    expect(payload.pageDraftContextMode).toBe("compact");
    expect(payload).not.toHaveProperty("recentPages");
    expect(payload).not.toHaveProperty("alreadyCovered");
    expect(payload).not.toHaveProperty("styleExcerpts");
    expect(payload.context.memory).toContain("Page 3 — Turn 3:");
    expect(payload.context.memory).toContain("Page 20 — Turn 20: DECISION");
    expect(payload.context.memory).not.toContain("Page 2 — Turn 2:");
    expect(payload.context.memory).toContain("The blue map is water-damaged.");
    expect(payload.context.memory).toContain("brass floodgate key");
    expect(payload.context.outline).toContain("Mara — at the east archive");

    const page20Summary = (payload.context.memory as string)
      .split("\n")
      .find((line: string) => line.startsWith("Page 20 — Turn 20: "))!
      .slice("Page 20 — Turn 20: ".length);
    expect(Array.from(page20Summary)).toHaveLength(400);
    expect(page20Summary.endsWith("…")).toBe(true);

    const nearest = payload.nearestPriorPage as {
      index: number;
      isDirectHandoff: boolean;
      beginningExcerpt: string;
      endingExcerpt: string;
    };
    const characters = Array.from(multilingualMarkdown);
    expect(nearest.index).toBe(20);
    expect(nearest.isDirectHandoff).toBe(true);
    expect(nearest.beginningExcerpt).toBe(characters.slice(0, 350).join(""));
    expect(nearest.endingExcerpt).toBe(characters.slice(-350).join(""));
    expect(Array.from(nearest.beginningExcerpt)).toHaveLength(350);
    expect(Array.from(nearest.endingExcerpt)).toHaveLength(350);
    expect(nearest.beginningExcerpt).not.toContain("MIDDLE_ONLY");
    expect(nearest.endingExcerpt).not.toContain("MIDDLE_ONLY");

    const serialized = JSON.stringify(payload);
    expect(serialized.match(/STYLE_LOCK_PROSE/g)).toHaveLength(1);
    expect(serialized).not.toContain("PRIOR_MARKDOWN_19");
  });

  it.each([
    { pageIndex: 2, nearestIndex: 1, styleLockIndexes: [1] },
    { pageIndex: 3, nearestIndex: 2, styleLockIndexes: [1, 2] }
  ])(
    "does not duplicate page $nearestIndex opening prose when compact page $pageIndex also uses it as a style lock",
    ({ pageIndex, nearestIndex, styleLockIndexes }) => {
      const previousPages = [1, 2].slice(0, pageIndex - 1).map((index) =>
        page(index, {
          markdown: `PAGE_${index}_OPENING ${"voice ".repeat(140)}PAGE_${index}_ENDING`
        })
      );
      const styleExcerpts = styleLockIndexes.map(
        (index) => previousPages.find((entry) => entry.index === index)!.markdown.slice(0, 400).trim()
      );
      const nearestPage = previousPages.find((entry) => entry.index === nearestIndex)!;

      const payload = buildPageDraftUserPayload(
        options({
          pageDraftContextMode: "compact",
          pageIndex,
          previousPages,
          styleExcerpts
        })
      ) as Record<string, any>;

      expect(payload.context.system).toContain(styleExcerpts[nearestIndex - 1]);
      expect(payload.nearestPriorPage).toMatchObject({
        index: nearestIndex,
        isDirectHandoff: true,
        beginningStyleLockExcerpt: nearestIndex,
        beginningExcerpt: ""
      });
      expect(Array.from(payload.nearestPriorPage.endingExcerpt)).toHaveLength(350);

      const serialized = JSON.stringify(payload);
      const originalBeginning = Array.from(nearestPage.markdown).slice(0, 350).join("");
      expect(serialized.split(originalBeginning)).toHaveLength(2);
    }
  );

  it("uses a gapped nearest page as context, not a direct handoff, without duplicating short prose", () => {
    const payload = buildPageDraftUserPayload(
      options({
        pageDraftContextMode: "compact",
        pageIndex: 10,
        previousPages: [page(8, { markdown: "قصير🙂" }), page(2), page(5)]
      })
    ) as Record<string, any>;

    expect(payload.nearestPriorPage).toMatchObject({
      index: 8,
      isDirectHandoff: false,
      beginningExcerpt: "قصير🙂",
      endingExcerpt: ""
    });
    expect(buildPageDraftSystemContent(options({ pageDraftContextMode: "compact", pageIndex: 10 }))).toMatch(
      /only when isDirectHandoff is true/
    );
  });

  it("sends no prior-page fields for compact page one", () => {
    const payload = buildPageDraftUserPayload(options({ pageDraftContextMode: "compact", pageIndex: 1 })) as Record<
      string,
      unknown
    >;

    expect(payload.pageDraftContextMode).toBe("compact");
    expect(payload).not.toHaveProperty("nearestPriorPage");
    expect(payload).not.toHaveProperty("recentPages");
    expect(payload).not.toHaveProperty("alreadyCovered");
  });

  it("keeps an overlong provider summary while clipping only later context serialization", () => {
    const providerSummary = "Legacy summary detail. ".repeat(80);

    const draft = pageDraftSchema.parse({
      title: "The Floodgate",
      markdown: "Mara closes the floodgate and marks the disputed route.",
      summary: providerSummary,
      continuityNotes: []
    });

    expect(draft.summary).toBe(providerSummary);
    expect(Array.from(draft.summary).length).toBeGreaterThan(400);
  });
});
