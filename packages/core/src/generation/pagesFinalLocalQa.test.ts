import { describe, expect, it } from "vitest";
import type { CreateProjectInput } from "../schemas/book.js";
import { runLocalFinalQa, runRequiredFinalQa } from "./pagesFinalLocalQa.js";

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
  it("scopes a repeated title to the page it is on and names the earlier page only after 'from'", () => {
    // Two different pages under one title: only the title rule may fire, so the
    // bodies share nothing the near-verbatim gate could match.
    const pages = [
      {
        index: 1,
        title: "The Treatment Works",
        markdown:
          "The treatment works sits above the town, where the duty engineer records the reservoir temperature each morning and adjusts the intake before the supply begins its journey downhill through the old cast-iron mains. The log shows how the readings drift across the summer weeks and why the taste follows them.",
        summary: "The works and its morning routine."
      },
      {
        index: 2,
        title: "The Treatment Works",
        markdown:
          "Chlorine dosing happens in a brick shed by the outlet, and the smell that reaches kitchens in August comes from the extra contact time the warmer water needs. Householders who run the cold tap for a minute rarely notice it, while a glass drawn first thing in the morning carries the whole night's residue.",
        summary: "Why the August taste comes from dosing rather than the source."
      }
    ];

    const issue = runLocalFinalQa({ ...input, targetPages: 2 }, pages).find((entry) => entry.startsWith("Page 2:"));

    expect(issue).toMatch(/^Page 2: Page title repeats the title of the page before it \(from page 1\)\./);
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
