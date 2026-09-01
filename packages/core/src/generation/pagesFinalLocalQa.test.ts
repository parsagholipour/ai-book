import { describe, expect, it } from "vitest";
import type { CreateProjectInput } from "../schemas/book.js";
import { runLocalFinalQa, runRequiredFinalQa } from "./pagesFinalLocalQa.js";
import { fourParaphrasedIndusWeightPages } from "./testing/manuscriptStructuralAuditFixtures.js";

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

describe("runLocalFinalQa", () => {
  it("scopes a treatment repeat to the page it is on and names the earlier page only after 'from'", () => {
    const [first, second] = fourParaphrasedIndusWeightPages();
    const pages = [
      { index: 1, title: first!.title, markdown: first!.markdown, summary: "Chert weights show administrative control." },
      { index: 2, title: second!.title, markdown: second!.markdown, summary: "Clerks shared one market language." }
    ];

    const issue = runLocalFinalQa({ ...input, targetPages: 2 }, pages).find((entry) => entry.startsWith("Page 2:"));

    expect(issue).toMatch(/^Page 2: Page re-treats .*\(from page 1\); advance, challenge, or apply/);
    // Past the `Page 2:` scope prefix, the only page reference is the one
    // behind "from", which the repair's harvest skips.
    expect([...issue!.slice("Page 2:".length).matchAll(/\bpages?\s+\d+/gi)]).toHaveLength(1);
  });
});

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
