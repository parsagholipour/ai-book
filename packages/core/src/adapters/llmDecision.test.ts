import { expect, it, vi } from "vitest";
import { FakeTextModelAdapter } from "./fake.js";
import { type DecisionRequest } from "./decisions.js";
import { LlmDecisionAdapter } from "./llmDecision.js";

const request: DecisionRequest = { purpose: "test-choice", context: "Full source and candidate context", instructions: "Choose the stronger option", options: [{ id: "a", description: "A" }, { id: "b", description: "B" }] };
const llm = { provider: "deepseek", model: "deepseek-v4-flash" } as const;

it("the LLM choice receives the whole context and rejects invented IDs", async () => {
  const text = new FakeTextModelAdapter();
  const call = vi.spyOn(text, "generateJson").mockImplementation(async (options) => ({ ...llm, data: options.schema.parse({ selectedOption: "invented" }), text: "{}", usage: { promptTokens: 15, outputTokens: 3 } }));
  await expect(new LlmDecisionAdapter(text).choose(request)).rejects.toMatchObject({ result: { usage: { promptTokens: 15 } } });
  expect(call.mock.calls[0]?.[0].messages.map((message) => message.content).join("\n")).toContain(request.context);
});
