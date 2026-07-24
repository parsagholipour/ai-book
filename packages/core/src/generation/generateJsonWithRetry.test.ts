import { describe, expect, it } from "vitest";
import { z } from "zod";
import { unsupportedGenerateWithTools } from "../adapters/fake.js";
import { AdapterJsonParseError, AdapterJsonValidationError } from "../adapters/json.js";
import type { GenerateJsonOptions, GenerateTextOptions, JsonResult, TextModelAdapter, TextResult } from "../adapters/types.js";
import { generateJsonWithRetry } from "./generateJsonWithRetry.js";

const schema = z.object({ title: z.string(), count: z.number().int().positive() });

describe("generateJsonWithRetry", () => {
  it("retries schema validation failures with validation details and the schema", async () => {
    const requests: GenerateJsonOptions<unknown>[] = [];
    let call = 0;
    const adapter = stub(async <T>(options: GenerateJsonOptions<T>) => {
      requests.push(options as GenerateJsonOptions<unknown>);
      call += 1;
      if (call === 1) {
        throw new AdapterJsonValidationError(
          "Test",
          options.purpose,
          ["title", "count"],
          "count: expected number, received string",
          '{"title":"Plan","count":"many"}',
          { title: "Plan", count: "many" }
        );
      }
      return result({ title: "Plan", count: 2 } as T);
    });

    const response = await generateJsonWithRetry(adapter, {
      schema,
      purpose: "plan-book",
      temperature: 0.8,
      messages: [{ role: "user", content: "Make a plan" }]
    });

    expect(response.data).toEqual({ title: "Plan", count: 2 });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.temperature).toBe(0.2);
    expect(requests[1]?.messages[0]?.content).toContain("count: expected number");
    expect(requests[1]?.messages[0]?.content).toContain('"count"');
    expect(requests[0]?.messages).toEqual([{ role: "user", content: "Make a plan" }]);
  });

  it("keeps syntax repair behavior and bounds repair calls", async () => {
    const requests: GenerateJsonOptions<unknown>[] = [];
    const adapter = stub(async (options) => {
      requests.push(options as GenerateJsonOptions<unknown>);
      throw new AdapterJsonParseError("Test", "Unterminated string", 10, "{", "{");
    });

    await expect(
      generateJsonWithRetry(adapter, {
        schema,
        repairAttempts: 2,
        maxTokens: 16_000,
        messages: [{ role: "system", content: "Original instructions" }]
      })
    ).rejects.toThrow("invalid JSON");
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.maxTokens === 16_000)).toBe(true);
  });

  it("does not retry provider or arbitrary application failures", async () => {
    let calls = 0;
    const adapter = stub(async () => {
      calls += 1;
      throw Object.assign(new Error("Service unavailable"), { status: 503 });
    });

    await expect(generateJsonWithRetry(adapter, { schema, messages: [] })).rejects.toThrow("Service unavailable");
    expect(calls).toBe(1);
  });
});

function stub(generateJson: TextModelAdapter["generateJson"]): TextModelAdapter {
  return {
    generateJson,
    async generateText(_options: GenerateTextOptions): Promise<TextResult> {
      throw new Error("unused");
    },
    async *streamText(_options: GenerateTextOptions): AsyncGenerator<string> {
      throw new Error("unused");
    },
    generateWithTools: unsupportedGenerateWithTools
  };
}

function result<T>(data: T): JsonResult<T> {
  return { data, text: JSON.stringify(data), provider: "test", model: "test" };
}
