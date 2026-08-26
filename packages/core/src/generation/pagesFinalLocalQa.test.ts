import { describe, expect, it } from "vitest";
import type { CreateProjectInput } from "../schemas/book.js";
import { runRequiredFinalQa } from "./pagesFinalLocalQa.js";

const input: CreateProjectInput = {
  prompt: "Explain why summer tap water tastes different.",
  category: "EDUCATION",
  targetPages: 1,
  complexity: 5,
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

const weakOpeningPage = {
  index: 1,
  title: "August Water",
  markdown: "Have you ever wondered why your tap water tastes different in August? The treatment works sits above the town, where the duty engineer records the reservoir temperature and adjusts the intake before the morning supply begins its journey downhill.",
  summary: "The narrator investigates the town's changing summer water."
};

describe("runRequiredFinalQa", () => {
  it("keeps the generated page-1 opening invariant when configurable local QA is skipped", () => {
    expect(runRequiredFinalQa(input, [weakOpeningPage])).toEqual([
      "Page 1: First page opens with a generic or meta hook instead of a concrete one."
    ]);
  });

  it("keeps the provenance exemption for an imported author's opening", () => {
    const importedInput: CreateProjectInput = {
      ...input,
      mediaSettings: {
        ...input.mediaSettings,
        mobile: { bookType: "custom", import: { importId: "imp-1", fileName: "book.docx", format: "docx" } }
      }
    };

    expect(runRequiredFinalQa(importedInput, [weakOpeningPage])).toEqual([]);
  });
});
