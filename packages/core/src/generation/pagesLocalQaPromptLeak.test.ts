import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import { reviewPageDraftLocally } from "./pagesLocalQa.js";

function nonfictionInput(language: string) {
  return {
    prompt: "A practical history of city water systems and home filtration.",
    category: "SCIENCE" as const,
    targetPages: 12,
    complexity: 6,
    temperature: 0.4,
    language,
    mediaSettings: {
      fullIllustrations: false,
      illustrationCadence: "template-driven" as const,
      includeCover: true,
      coverTemplate: "auto" as const,
      finalReview: true,
      toneProfile: "scholarly" as const
    }
  };
}

function review(language: string, title: string, markdown: string, summary: string) {
  const input = nonfictionInput(language);
  return reviewPageDraftLocally({
    input,
    plan: makeFallbackPlan(input),
    pageIndex: 2,
    draft: { title, markdown, summary, continuityNotes: [] },
    previousPages: [],
    continuityNotes: []
  });
}

describe("prompt leak in the book's own language", () => {
  it("flags the Persian model apology written with the ZWNJ Persian uses", () => {
    // «به‌عنوان» is one word joined by U+200C, which `\s` does not match, so
    // the standard spelling of the phrase this check exists for used to reach
    // the reader while the spaced spelling was caught.
    const report = review(
      "fa",
      "روباه و باغ",
      "به‌عنوان یک مدل زبانی، نمی‌توانم داستان کامل را بنویسم، اما روباه هر روز صبح کنار باغ می‌نشست.",
      "روباه کنار باغ می‌نشیند."
    );

    expect(report.checks.promptLeakFree).toBe(false);
  });

  it("flags the Arabic model apology whichever way its tanween is encoded", () => {
    const report = review(
      "ar",
      "الثعلب والحديقة",
      "بصفتي نموذجًا لغويًا، لا أستطيع كتابة القصة كاملة، لكن الثعلب كان يجلس كل صباح بجانب الحديقة.",
      "الثعلب يجلس بجانب الحديقة."
    );

    expect(report.checks.promptLeakFree).toBe(false);
  });

  it("leaves ordinary Persian prose that says «به عنوان» alone", () => {
    // The two commonest words in any Persian book: the tail is what makes the
    // phrase a leak, never the preposition.
    const report = review(
      "fa",
      "نویسنده و باغ",
      "او به‌عنوان یک نویسنده شناخته می‌شد و به عنوان مثال هر روز صبح کنار باغ می‌نشست و می‌نوشت. مدل‌های زبانی بزرگ در فصل بعد معرفی می‌شوند.",
      "نویسنده هر روز کنار باغ می‌نویسد."
    );

    expect(report.checks.promptLeakFree).toBe(true);
  });
});
