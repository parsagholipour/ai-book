import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeTextModelAdapter, unsupportedGenerateWithTools } from "../adapters/fake.js";
import { AdapterJsonParseError, AdapterJsonValidationError } from "../adapters/json.js";
import {
  stampChapterBriefPhysicalAttempt,
  type GenerateJsonOptions,
  type GenerateTextOptions,
  type JsonResult,
  type TextModelAdapter,
  type TextResult
} from "../adapters/types.js";
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

  it("does not retry a direct schema.parse ZodError from a non-chapter-brief caller", async () => {
    const requests: GenerateJsonOptions<unknown>[] = [];
    let call = 0;
    const adapter = stub(async <T>(options: GenerateJsonOptions<T>) => {
      requests.push(options as GenerateJsonOptions<unknown>);
      call += 1;
      const data = options.schema.parse({ title: "Plan", count: "many" });
      return result(data);
    });

    await expect(
      generateJsonWithRetry(adapter, {
        schema,
        purpose: "plan-book",
        temperature: 0.8,
        messages: [{ role: "user", content: "Make a plan" }]
      })
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(call).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([{ role: "user", content: "Make a plan" }]);
    expect(requests[0]?.messages[0]?.content).not.toContain("Your previous JSON did not match the required schema.");
  });

  it("stamps chapter-brief attempt metadata on each physical schema-repair attempt", async () => {
    const requests: GenerateJsonOptions<unknown>[] = [];
    let call = 0;
    const adapter = stub(async <T>(options: GenerateJsonOptions<T>) => {
      requests.push(options as GenerateJsonOptions<unknown>);
      call += 1;
      if (call === 1) {
        throw new AdapterJsonValidationError(
          "Test",
          options.purpose,
          ["title"],
          "count: expected number, received string",
          '{"title":"Plan","count":"many"}',
          { title: "Plan", count: "many" }
        );
      }
      return result({ title: "Plan", count: 2 } as T);
    });

    const response = await generateJsonWithRetry(adapter, {
      schema,
      messages: [{ role: "user", content: "Make a plan" }],
      annotatePhysicalAttempt: stampChapterBriefPhysicalAttempt,
      providerCallMetadata: {
        chapterBriefLogicalCallId: "logical-call-0001",
        chapterBriefTier: "balanced",
        chapterBriefChapterIndex: 1,
        chapterBriefPageStart: 1,
        chapterBriefPageEnd: 3,
        chapterBriefAttempt: 1,
        chapterBriefMaxAttempts: 2
      }
    });

    expect(response.data).toEqual({ title: "Plan", count: 2 });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.providerCallMetadata)).toEqual([
      expect.objectContaining({
        chapterBriefLogicalCallId: "logical-call-0001",
        chapterBriefAttempt: 1,
        chapterBriefMaxAttempts: 2
      }),
      expect.objectContaining({
        chapterBriefLogicalCallId: "logical-call-0001",
        chapterBriefAttempt: 2,
        chapterBriefMaxAttempts: 2,
        chapterBriefSchemaRepair: true
      })
    ]);
    expect(requests[0]?.providerCallMetadata).not.toHaveProperty("chapterBriefSchemaRepair");
  });

  it("does not stamp schema-repair metadata after JSON syntax repair", async () => {
    const requests: GenerateJsonOptions<unknown>[] = [];
    let call = 0;
    const adapter = stub(async <T>(options: GenerateJsonOptions<T>) => {
      requests.push(options as GenerateJsonOptions<unknown>);
      call += 1;
      if (call === 1) {
        throw new AdapterJsonParseError("Test", "Unterminated string", 10, "{", "{");
      }
      return result({ title: "Plan", count: 2 } as T);
    });

    const response = await generateJsonWithRetry(adapter, {
      schema,
      temperature: 0.8,
      messages: [{ role: "user", content: "Make a plan" }],
      annotatePhysicalAttempt: stampChapterBriefPhysicalAttempt,
      providerCallMetadata: {
        chapterBriefLogicalCallId: "logical-call-0001",
        chapterBriefTier: "balanced",
        chapterBriefChapterIndex: 1,
        chapterBriefPageStart: 1,
        chapterBriefPageEnd: 3,
        chapterBriefAttempt: 1,
        chapterBriefMaxAttempts: 2
      }
    });

    expect(response.data).toEqual({ title: "Plan", count: 2 });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.temperature).toBe(0.35);
    expect(requests[1]?.messages[0]?.content).toContain("Return one complete syntactically valid JSON object only.");
    expect(requests[0]?.providerCallMetadata).not.toHaveProperty("chapterBriefSchemaRepair");
    expect(requests[1]?.providerCallMetadata).not.toHaveProperty("chapterBriefSchemaRepair");
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

  it("retries FakeTextModelAdapter schema failures as AdapterJsonValidationError", async () => {
    const fake = new FakeTextModelAdapter();
    let calls = 0;
    const adapter = stub(async (options) => {
      calls += 1;
      return fake.generateJson(options);
    });

    await expect(
      generateJsonWithRetry(adapter, {
        schema: z.object({ mustExist: z.string() }),
        messages: [{ role: "user", content: "Make a plan" }]
      })
    ).rejects.toBeInstanceOf(AdapterJsonValidationError);
    expect(calls).toBe(2);
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
