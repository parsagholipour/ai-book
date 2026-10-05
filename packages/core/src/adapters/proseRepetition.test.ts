import { expect, it } from "vitest";
import { ProseRepetitionGuard } from "./proseRepetition.js";
import captured from "../generation/testing/bolsonaroProseRunaway.json" with { type: "json" };

const passage = "Maya looks at the four rows and has to choose: give the one-word answer the question invites, or state which criteria the evidence supports and where the judgment remains open. The scorecard is still between them. The answer is hers to give.";
function read(text: string, size = 1) {
  const guard = new ProseRepetitionGuard();
  for (let i = 0; i < text.length; i += size) guard.append(text.slice(i, i + size));
  guard.finish();
}

it.each([1, 7, 512, 10000])("recognizes the recorded alternating paragraph cycle with chunks of %s", size => {
  expect(() => read(captured.partialOutput.tail, size)).toThrow("repeated the same prose passage");
});

it("recognizes a long repeated paragraph, including a final paragraph without a newline", () => {
  expect(() => read(Array(4).fill(passage).join("\r\n \r\n"))).toThrow("repeated the same prose passage");
});

it.each([
  Array.from({ length: 30 }, (_, i) => `${passage}\n\nThis time the example concerns policy number ${i}.`).join("\n\n"),
  Array(20).fill("Never again.").join("\n\n"),
  Array(20).fill(`| ${passage} | [ ] |`).join("\n\n"),
  Array(20).fill(`- ${passage}`).join("\n\n"),
  "```text\n" + Array(20).fill(passage).join("\n\n") + "\n```",
  "~~~text\n" + Array(20).fill(passage).join("\n\n") + "\n~~~",
  "A".repeat(30000) + "\n\nA short closing paragraph."
])("allows refrains, changing examples and literal or structured content (%#)", text => {
  expect(() => read(text)).not.toThrow();
});

it("resumes checking prose after a fenced block", () => {
  expect(() => read("```text\n\nExample code\n\n```\n\n" + Array(4).fill(passage).join("\n\n"))).toThrow("repeated the same prose passage");
});

it.each([1, 512, 20000])("retains Markdown context through oversized literal paragraphs (%s)", size => {
  const code = "```text\n" + "x".repeat(9000) + "\n\n" + Array(10).fill(passage).join("\n\n") + "\n```\n\n";
  expect(() => read(code, size)).not.toThrow();
  expect(() => read(code + Array(4).fill(passage).join("\n\n"), size)).toThrow("repeated the same prose passage");
});
