import { describe, expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { verifyPageClaims } from "./claimVerifier.js";

const INITIAL_SYSTEM_PROMPT = [
  "You check whether factual claims on one page are supported by the supplied research notes.",
  "Return groundedOk and unsupportedClaims.",
  "Treat qualified uncertainty as acceptable. Invented studies, journals, statistics, or citations are unsupported."
].join(" ");

function captureSystemPrompt() {
  const textModel = new FakeTextModelAdapter();
  const generate = vi.spyOn(textModel, "generateJson").mockResolvedValue({
    data: { groundedOk: true, unsupportedClaims: [] },
    text: "",
    provider: "fake",
    model: "fake"
  });
  return { textModel, generate };
}

describe("verifyPageClaims system prompt", () => {
  it("sends only the three HEAD sentences when original is absent", async () => {
    const { textModel, generate } = captureSystemPrompt();
    await verifyPageClaims({
      textModel,
      pageIndex: 1,
      markdown: "A 2019 study proved that 94% of cases resolved overnight.",
      researchNotes: ["No such 2019 study is in the notes."]
    });
    expect(generate.mock.calls[0]![0].messages[0]!.content).toBe(INITIAL_SYSTEM_PROMPT);
  });

  it("appends the diagnostic sentences when original is supplied", async () => {
    const { textModel, generate } = captureSystemPrompt();
    await verifyPageClaims({
      textModel,
      pageIndex: 1,
      markdown: "The treatment helped 94% of participants recover.",
      researchNotes: ["The trial did not measure recovery rates."],
      original: {
        title: "Trial findings",
        markdown: "The trial did not measure recovery rates."
      }
    });
    const system = generate.mock.calls[0]![0].messages[0]!.content;
    expect(system).toContain(INITIAL_SYSTEM_PROMPT);
    expect(system).toContain("When original text is supplied");
    expect(system).toContain("concrete correction");
  });
});
