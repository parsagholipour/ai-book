import { describe, expect, it } from "vitest";
import { reviewPageDraftForSmartUnslop } from "./smartUnslop.js";

function review(markdown: string) {
  return reviewPageDraftForSmartUnslop({
    input: { category: "EDUCATION", targetPages: 8, language: "en", mediaSettings: {} },
    plan: { title: "Clear Water", premise: "How city water reaches a tap", chapters: [] },
    pageIndex: 2,
    draft: {
      title: "The treatment line",
      markdown,
      summary: "Water moves through a treatment plant.",
      continuityNotes: []
    },
    previousPages: [],
    continuityNotes: []
  } as never);
}

describe("Smart unslop detector", () => {
  it("requires a significant cluster instead of failing a single scanner match", () => {
    expect(review("At its core, the sand bed catches suspended particles.").approved).toBe(true);
    expect(
      review(
        "Here's the thing: treatment takes several steps. At its core, filtration removes particles. " +
          "The result serves as a testament to careful plant operation."
      )
    ).toMatchObject({ approved: false, score: 70 });
  });

  it("rejects one conspicuous construction repeated throughout a page", () => {
    const report = review(
      "The basin is not a tank. It is a settling chamber. " +
        "Chlorine is not an ordinary additive. It is a timed disinfectant. " +
        "The reservoir is not spare storage. It is a buffer for peak demand."
    );

    expect(report.approved).toBe(false);
    expect(report.issues[0]).toContain("3 possible formulaic AI-writing signals");
    expect(report.issues[0]).toContain("candidates, not confirmed defects");
    expect(report.requiredRevisions[0]).toContain("If no candidate is a clear defect");
    expect(report.requiredRevisions[0]).toContain("return the page exactly unchanged");
  });

  it("requires one more signal on a long page", () => {
    const longBody = Array.from({ length: 600 }, (_, index) => `detail${index}`).join(" ");
    const threeSignals =
      `Here's the thing: the sample changed. At its core, the test is mechanical. ` +
      `The outcome serves as a testament to calibration. ${longBody}`;

    expect(review(threeSignals).approved).toBe(true);
    expect(review(`${threeSignals} In conclusion, the valve needs replacement.`).approved).toBe(false);
  });

  it("protects quoted examples, dialogue, blockquotes, and code", () => {
    const report = review([
      'The editor quoted “Here\'s the thing: at its core, this serves as a testament to effort.”',
      '> At its core, this serves as a testament to progress.',
      '```text\nHere\'s the thing: the future is bright and the possibilities are endless.\n```',
      "The operator then recorded the filter pressure and closed the valve."
    ].join("\n\n"));

    expect(report.approved).toBe(true);
  });

  it("collapses hard wraps before detecting phrases", () => {
    const report = review(
      "Here's the\nthing: the sample is cloudy. At its\ncore, the test measures suspended solids. " +
        "This serves as a\ntestament to the need for another filter."
    );

    expect(report.approved).toBe(false);
  });
});
