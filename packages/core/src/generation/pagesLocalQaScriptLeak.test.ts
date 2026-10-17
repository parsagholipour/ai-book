import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { composedPageQualityReport, reviewPageDraftLocally, reviewQuickDraftPageLocally } from "./pagesLocalQa.js";
import type { TextModelAdapter } from "../adapters/types.js";

function storyInput(language: string, extra: { prompt?: string; imported?: boolean } = {}) {
  return {
    prompt: extra.prompt ?? "A quiet story about an old baker and the boy who knocks at his door every morning.",
    category: "STORY" as const,
    targetPages: 12,
    complexity: 5,
    temperature: 0.8,
    language,
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "neutral" as const,
      ...(extra.imported ? { mobile: { import: { source: "docx" } } } : {})
    }
  };
}

function options(language: string, markdown: string, extra: Parameters<typeof storyInput>[1] = {}) {
  const input = storyInput(language, extra) as Parameters<typeof reviewPageDraftLocally>[0]["input"];
  return {
    input,
    plan: makeFallbackPlan(input),
    pageIndex: 4,
    draft: { title: "نانِ پشتِ در", markdown, summary: "نوه جلو می‌آید.", continuityNotes: [] },
    previousPages: [],
    continuityNotes: []
  };
}

// The E1c luna chapter's sentence, padded past the page's word minimum with clean prose.
const clean = Array.from({ length: 12 }, (_, index) =>
  `نانوا ${index} بار سنگک را از دهانهٔ تنور بیرون کشید و روی پیشخوان گذاشت تا بخارش بنشیند.`).join(" ");
const leaked = `${clean} پیرمرد گفت. نوه‌اش یک քայլ جلو آمد، բայց پیرمرد دست բարձր نکرد.`;

describe("a page in a script the book is not written in", () => {
  it("fails the integrity flag every repair path reads, and names the words", () => {
    const report = reviewPageDraftLocally(options("fa", leaked));
    expect(report.approved).toBe(false);
    expect(report.checks.promptLeakFree).toBe(false);
    expect(report.issues).toContain(
      "Page contains words in a script the book is not written in: \"քայլ\" (Armenian), \"բայց\" (Armenian), \"բարձր\" (Armenian)."
    );
    // A composed page and a Quick Draft page are repaired for it too.
    expect(composedPageQualityReport(report).approved).toBe(false);
    const quick = reviewQuickDraftPageLocally({ ...options("fa", leaked), textModel: undefined as unknown as TextModelAdapter });
    expect(quick.checks.promptLeakFree).toBe(false);
  });

  it("passes the same page without the leak, with the script the brief asked for, or as the author's own", () => {
    expect(reviewPageDraftLocally(options("fa", clean)).checks.promptLeakFree).toBe(true);
    expect(reviewPageDraftLocally(options("fa", leaked, { prompt: "داستانی دربارهٔ نانوایی ارمنی و واژه‌های ارمنی‌اش" })).checks.promptLeakFree).toBe(true);
    expect(reviewPageDraftLocally(options("fa", leaked, { imported: true })).checks.promptLeakFree).toBe(true);
  });
});
