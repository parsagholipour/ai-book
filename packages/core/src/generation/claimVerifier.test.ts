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
  it("sends the base review instructions and JSON contract when original is absent", async () => {
    const { textModel, generate } = captureSystemPrompt();
    await verifyPageClaims({
      textModel,
      pageIndex: 1,
      markdown: "A 2019 study proved that 94% of cases resolved overnight.",
      researchNotes: ["No such 2019 study is in the notes."]
    });
    const system = generate.mock.calls[0]![0].messages[0]!.content;
    expect(system).toContain(INITIAL_SYSTEM_PROMPT);
    expect(system).toContain('Required JSON schema:');
    expect(system).not.toContain('Only candidate.title and candidate.markdown');
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

  it("identifies the changed page as the sole candidate, separate from before-edit context", async () => {
    const { textModel, generate } = captureSystemPrompt();
    const original = { title: "The universal day", markdown: "The conference preserved local time." };
    const candidate = {
      title: original.title,
      markdown: `${original.markdown}\n\nThe Greenwich meridian was chosen unanimously, by 25 votes in favor and none against or abstaining.`
    };
    await verifyPageClaims({
      textModel, pageIndex: 3, original, ...candidate,
      researchNotes: ["Resolution II: 22 votes in favor, 1 against, 2 abstentions."],
      userRequest: "Make the ending clearer."
    });
    const messages = generate.mock.calls[0]![0].messages;
    const payload = JSON.parse(messages[1]!.content);
    expect(payload.candidate).toEqual(candidate);
    expect(payload.original).toEqual(original);
    expect(payload).not.toHaveProperty("markdown");
    expect(Object.keys(payload).at(-1)).toBe("candidate");
    expect(messages[0]!.content).toContain("Only candidate.title and candidate.markdown");
    expect(messages[0]!.content).toContain("final sentence");
    expect(messages[0]!.content).toContain("Each unsupportedClaims entry must be one string");
  });
});
