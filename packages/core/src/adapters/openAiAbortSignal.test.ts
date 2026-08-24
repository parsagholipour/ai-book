import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AlibabaTextAdapter } from "./alibaba.js";
import { DeepInfraAdapter } from "./deepinfra.js";
import { OpenAICompatibleTextAdapter } from "./openaiCompatible.js";

const adapterCases = [
  {
    name: "DeepInfraAdapter",
    create: () => new DeepInfraAdapter({ apiKey: "test-key", model: "test-model" })
  },
  {
    name: "OpenAICompatibleTextAdapter",
    create: () =>
      new OpenAICompatibleTextAdapter({
        apiKey: "test-key",
        baseURL: "http://localhost:1234/v1",
        model: "test-model"
      })
  },
  {
    name: "AlibabaTextAdapter",
    create: () => new AlibabaTextAdapter({ apiKey: "test-key", textModel: "test-model" })
  }
] as const;

describe.each(adapterCases)("$name abort signalling", ({ create }) => {
  it("forwards the caller's signal through every OpenAI SDK request path", async () => {
    const requestOptions: unknown[] = [];
    const adapter = create();
    (adapter as any).client = mockOpenAiClient(requestOptions);
    const signal = new AbortController().signal;
    const messages = [{ role: "user" as const, content: "Draft a paragraph." }];

    await adapter.generateText({ messages, signal });
    await adapter.generateText({ messages, signal, onOutputTextChunk: () => undefined });
    await adapter.generateJson({ messages, signal, schema: z.object({}) });
    await adapter.generateJson({ messages, signal, schema: z.object({}), onOutputTextChunk: () => undefined });
    await consume(adapter.streamText({ messages, signal }));
    await adapter.generateWithTools({
      messages,
      signal,
      tools: [{ name: "lookup", description: "Look something up.", parameters: z.object({}) }]
    });

    expect(requestOptions).toHaveLength(6);
    expect(requestOptions).toEqual(Array.from({ length: 6 }, () => ({ signal })));
  });
});

async function consume(stream: AsyncGenerator<string>): Promise<void> {
  for await (const _chunk of stream) {
    // Exhaust the stream so the provider request is made.
  }
}

function mockOpenAiClient(requestOptions: unknown[]) {
  return {
    chat: {
      completions: {
        create: async (request: { stream?: boolean }, options: unknown) => {
          requestOptions.push(options);
          if (request.stream) {
            return (async function* () {
              yield {
                choices: [{ delta: { content: "{}" } }],
                usage: { prompt_tokens: 3, completion_tokens: 1 }
              };
            })();
          }
          return {
            choices: [{ message: { content: "{}" } }],
            usage: { prompt_tokens: 3, completion_tokens: 1 }
          };
        }
      }
    }
  };
}
