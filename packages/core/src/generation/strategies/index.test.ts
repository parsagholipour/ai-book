import { describe, expect, it } from "vitest";
import { mediaSettingsSchema } from "../../schemas/book.js";
import { assertBookLikeMarkdown } from "../markdown.js";
import { makeFallbackPlan } from "../../prompting/templates.js";
import {
  autoStrategyIdForInput,
  batchWindowStrategy,
  bookGenerationStrategies,
  chapterWholePassStrategy,
  chapteredBookGenerationStrategy,
  composedChaptersResearchStrategy,
  composedChaptersStrategy,
  draftThenPolishStrategy,
  getBookGenerationStrategy,
  strategyComposesChapters,
  pageMapSequentialStrategy,
  researchGroundedStrategy,
  researchMapDraftPolishStrategy,
  wholeBookSinglePassStrategy
} from "./index.js";

describe("book generation strategies", () => {
  it("exports concrete book generation strategies", () => {
    expect(bookGenerationStrategies).toEqual([
      chapteredBookGenerationStrategy,
      wholeBookSinglePassStrategy,
      pageMapSequentialStrategy,
      chapterWholePassStrategy,
      batchWindowStrategy,
      draftThenPolishStrategy,
      researchGroundedStrategy,
      researchMapDraftPolishStrategy,
      composedChaptersStrategy,
      composedChaptersResearchStrategy
    ]);
    expect(getBookGenerationStrategy()).toBe(chapteredBookGenerationStrategy);
    expect(getBookGenerationStrategy("composed-chapters")).toBe(composedChaptersStrategy);
    expect(getBookGenerationStrategy("composed-chapters-research")).toBe(composedChaptersResearchStrategy);
    expect(getBookGenerationStrategy("chaptered-sequential")).toBe(chapteredBookGenerationStrategy);
    expect(getBookGenerationStrategy("whole-book-single-pass")).toBe(wholeBookSinglePassStrategy);
    expect(getBookGenerationStrategy("page-map-sequential")).toBe(pageMapSequentialStrategy);
    expect(getBookGenerationStrategy("chapter-whole-pass")).toBe(chapterWholePassStrategy);
    expect(getBookGenerationStrategy("batch-window")).toBe(batchWindowStrategy);
    expect(getBookGenerationStrategy("draft-then-polish")).toBe(draftThenPolishStrategy);
    expect(getBookGenerationStrategy("research-grounded")).toBe(researchGroundedStrategy);
    expect(getBookGenerationStrategy("research-map-draft-polish")).toBe(researchMapDraftPolishStrategy);
  });

  it("rejects unknown strategy ids", () => {
    expect(() => getBookGenerationStrategy("missing")).toThrow("Unknown book generation strategy: missing");
  });

  it("assigns strength scores from 1 to 10", () => {
    for (const strategy of bookGenerationStrategies) {
      expect(strategy.strengthScore).toBeGreaterThanOrEqual(1);
      expect(strategy.strengthScore).toBeLessThanOrEqual(10);
      expect(Number.isInteger(strategy.strengthScore)).toBe(true);
    }
  });

  it("assigns recommended page ranges", () => {
    for (const strategy of bookGenerationStrategies) {
      expect(strategy.recommendedPageRange.min).toBeGreaterThanOrEqual(1);
      expect(strategy.recommendedPageRange.max).toBeGreaterThanOrEqual(strategy.recommendedPageRange.min);
      expect(Number.isInteger(strategy.recommendedPageRange.min)).toBe(true);
      expect(Number.isInteger(strategy.recommendedPageRange.max)).toBe(true);
    }
  });

  it("accepts all strategy ids in media settings", () => {
    for (const strategy of bookGenerationStrategies) {
      expect(
        mediaSettingsSchema.parse({
          fullIllustrations: true,
          illustrationCadence: "template-driven",
          includeCover: true,
          coverTemplate: "auto",
          finalReview: true,
          toneProfile: "neutral" as const,
          generationStrategy: strategy.id
        }).generationStrategy
      ).toBe(strategy.id);
    }
  });

  it("exposes the research map draft-polish composition", () => {
    expect(researchMapDraftPolishStrategy.strengthScore).toBe(10);
    expect(researchMapDraftPolishStrategy.executionMode).toBe("draft-then-polish");
    expect(researchMapDraftPolishStrategy.researchDepth).toBe(12);
    expect(researchMapDraftPolishStrategy.createChapterBriefs).toBeDefined();
    expect(researchMapDraftPolishStrategy.generateWholeBookDraft).toBeDefined();
    expect(researchMapDraftPolishStrategy.polishPageDraft).toBeDefined();
  });

  it("composes every long book but a picture book chapter by chapter", () => {
    const base = {
      prompt: "A book.",
      complexity: 5,
      temperature: 0.8,
      language: "en",
      mediaSettings: {
        fullIllustrations: false,
        illustrationCadence: "template-driven" as const,
        includeCover: true,
        coverTemplate: "auto" as const,
        finalReview: true,
        toneProfile: "neutral" as const
      }
    };
    expect(autoStrategyIdForInput({ ...base, category: "HISTORY", targetPages: 120 })).toBe("composed-chapters-research");
    expect(autoStrategyIdForInput({ ...base, category: "STORY", targetPages: 40 })).toBe("composed-chapters");
    expect(autoStrategyIdForInput({ ...base, category: "BUSINESS", targetPages: 200 })).toBe("composed-chapters");
    expect(autoStrategyIdForInput({ ...base, category: "KIDS", targetPages: 24 })).toBe("draft-then-polish");
    expect(autoStrategyIdForInput({ ...base, category: "HISTORY", targetPages: 8 })).toBe("draft-then-polish");
    expect(strategyComposesChapters(composedChaptersStrategy)).toBe(true);
    expect(strategyComposesChapters(composedChaptersResearchStrategy)).toBe(true);
    expect(strategyComposesChapters(pageMapSequentialStrategy)).toBe(false);
    expect(composedChaptersResearchStrategy.researchDepth).toBe(12);
    expect(Object.hasOwn(composedChaptersStrategy, "researchDepth")).toBe(false);
  });

  it("gives draft-then-polish an authoritative page map before whole-book drafting", () => {
    expect(draftThenPolishStrategy.executionMode).toBe("draft-then-polish");
    expect(draftThenPolishStrategy.createChapterBriefs).toBe(pageMapSequentialStrategy.createChapterBriefs);
    expect(draftThenPolishStrategy.generateWholeBookDraft).toBeDefined();
    expect(draftThenPolishStrategy.polishPageDraft).toBeDefined();
  });

  it("all strategies compile reader-facing Markdown without export artifacts", () => {
    const input = {
      prompt: "A story about a careful clockmaker.",
      category: "STORY" as const,
      targetPages: 2,
      complexity: 5,
      temperature: 0.8,
      language: "en",
      mediaSettings: {
        fullIllustrations: true,
        illustrationCadence: "template-driven" as const,
        includeCover: true,
        coverTemplate: "auto" as const,
        finalReview: true,
        toneProfile: "neutral" as const
      }
    };
    const plan = makeFallbackPlan(input);
    const pages = [
      { index: 1, title: "Page 1: Internal", markdown: "The first page opens in finished prose." },
      { index: 2, title: "Page 2: Internal", markdown: "The second page continues in finished prose." }
    ];

    for (const strategy of bookGenerationStrategies) {
      const markdown = strategy.compileMarkdown({
        plan,
        cover: { imagePath: "/assets/images/project/cover.png", imageAlt: "Book cover" },
        pages
      });
      expect(() => assertBookLikeMarkdown(markdown), strategy.id).not.toThrow();
    }
  });
});
