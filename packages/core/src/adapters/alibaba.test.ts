import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AlibabaTextAdapter } from "./alibaba.js";

describe("AlibabaTextAdapter", () => {
  it("keeps provider usage on JSON validation errors", async () => {
    const adapter = new AlibabaTextAdapter({ apiKey: "test-key", textModel: "qwen-plus" });
    (adapter as any).client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: `{ "approved": "yes" }` } }],
            usage: { prompt_tokens: 123, completion_tokens: 45 }
          })
        }
      }
    };

    await expect(
      adapter.generateJson({
        purpose: "plan-book",
        messages: [{ role: "user", content: "Return a report." }],
        schema: z.object({ approved: z.boolean() })
      })
    ).rejects.toMatchObject({
      provider: "alibaba",
      model: "qwen-plus",
      usage: { promptTokens: 123, outputTokens: 45 }
    });
  });
});
