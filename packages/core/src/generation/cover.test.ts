import { describe, expect, it } from "vitest";
import { applyCoverTemplateOverride, buildCoverArtworkPrompt, fitCoverText, resolveCoverTemplate } from "./cover.js";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { CreateProjectInput } from "../schemas/book.js";

describe("applyCoverTemplateOverride", () => {
  it("keeps the resolved template when a design overrides nothing", () => {
    const template = resolveCoverTemplate("fiction", "STORY");
    expect(applyCoverTemplateOverride(template, undefined)).toBe(template);
    expect(applyCoverTemplateOverride(template, { id: "fiction" })).toEqual(template);
  });

  it("takes the design's own accent and scrim, which belong to its artwork", () => {
    const template = resolveCoverTemplate("minimal", "CUSTOM");
    const overridden = applyCoverTemplateOverride(template, {
      id: "minimal",
      accentColor: "#8a7f6b",
      overlayCss: "linear-gradient(180deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.7) 100%)"
    });

    expect(overridden.accentColor).toBe("#8a7f6b");
    expect(overridden.overlayCss).toContain("rgba(0,0,0,0.7)");
    // Typography is the template's, not the override's, business.
    expect(overridden.titleFont).toBe(template.titleFont);
  });
});

describe("cover generation helpers", () => {
  it("builds a text-free artwork prompt with watermark constraints", () => {
    const input = testInput();
    const plan = makeFallbackPlan(input);
    const prompt = buildCoverArtworkPrompt({
      input,
      plan,
      metadata: {
        title: "The Moon Library",
        subtitle: "Small Stories in a Silver Room",
        authorName: "A. Writer",
        coverTagline: "A bedtime adventure"
      }
    });

    expect(prompt).toContain("Full-bleed text-free book cover artwork");
    expect(prompt).toMatch(/Do not include any readable text/i);
    expect(prompt).toMatch(/watermarks/i);
    expect(prompt).toMatch(/author name/i);
    expect(prompt).toContain("portrait 3:4");
    expect(prompt).not.toMatch(/negative space|reserve|title block|blank rectangle|box|banner|panel|placard|placeholder|signboard/i);
  });

  it("includes optional subcategory context in cover artwork prompts", () => {
    const input = { ...testInput(), category: "CUSTOM" as const, subcategory: "Social / Society & culture" };
    const prompt = buildCoverArtworkPrompt({
      input,
      plan: makeFallbackPlan(input),
      metadata: {
        title: "The Shared Square"
      }
    });

    expect(prompt).toContain("Book category: CUSTOM.");
    expect(prompt).toContain("Book subcategory context: Social / Society & culture.");
  });

  it("routes auto cover templates from important subcategories", () => {
    const cases = [
      { input: { ...testInput(), category: "BUSINESS" as const }, expected: "business" },
      { input: { ...testInput(), category: "SELF_HELP" as const }, expected: "self-help" },
      { input: { ...testInput(), category: "EDUCATION" as const }, expected: "science" },
      { input: { ...testInput(), category: "HEALTH" as const }, expected: "science" },
      { input: { ...testInput(), category: "CUSTOM" as const, subcategory: "Business" }, expected: "business" },
      { input: { ...testInput(), category: "CUSTOM" as const, subcategory: "Self-help" }, expected: "self-help" },
      { input: { ...testInput(), category: "CUSTOM" as const, subcategory: "Relationships" }, expected: "self-help" },
      { input: { ...testInput(), category: "STORY" as const, subcategory: "Romance" }, expected: "romance" }
    ];

    for (const { input, expected } of cases) {
      const prompt = buildCoverArtworkPrompt({
        input,
        plan: makeFallbackPlan(input),
        metadata: {
          title: "A Fitted Cover"
        }
      });

      expect(prompt).toContain(`Template mood: ${expected}.`);
    }
  });

  it("fits long cover titles without exceeding the configured line count", () => {
    const fitted = fitCoverText({
      text: "The Very Long and Surprisingly Specific Chronicle of the Moon's Smallest Library",
      baseFontSize: 140,
      minFontSize: 72,
      maxCharsPerLine: 15,
      maxLines: 4
    });

    expect(fitted.lines.length).toBeLessThanOrEqual(4);
    expect(fitted.fontSize).toBeGreaterThanOrEqual(72);
    expect(fitted.lines.join(" ")).toContain("Very");
  });
});

function testInput(): CreateProjectInput {
  return {
    prompt: "A curious child discovers that the moon keeps a tiny library of forgotten bedtime stories.",
    category: "KIDS",
    targetPages: 32,
    complexity: 3,
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
}
