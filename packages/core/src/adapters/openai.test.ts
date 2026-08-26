import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAITextAdapter } from "./openai.js";
import { isRecoverableNetworkError, isTextProviderFallbackError, ProviderHttpError } from "./retry.js";

const lookupTool = {
  name: "lookup",
  description: "Look something up.",
  parameters: z.object({ term: z.string() })
};

describe("OpenAITextAdapter", () => {
  it("uses Responses with explicit GPT-5.6 reasoning, cancellation, and usage metadata", async () => {
    const adapter = new OpenAITextAdapter({
      apiKey: "test-key",
      model: "gpt-5.6-sol",
      thinkingEffort: "xhigh"
    });
    const mock = installMockResponses(adapter, [textResponse("A finished answer.")]);
    const signal = new AbortController().signal;

    const result = await adapter.generateText({
      messages: [{ role: "user", content: "Draft it." }],
      temperature: 0.4,
      maxTokens: 321,
      signal
    });

    expect(result).toEqual({
      text: "A finished answer.",
      model: "gpt-5.6-sol",
      provider: "openai",
      usage: {
        promptTokens: 120,
        outputTokens: 30,
        cacheHitTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: 10
      }
    });
    expect(mock.calls[0]).toEqual({
      request: expect.objectContaining({
        model: "gpt-5.6-sol",
        input: [{ role: "user", content: "Draft it." }],
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "xhigh" },
        max_output_tokens: 321
      }),
      options: { signal }
    });
    expect(mock.calls[0]?.request).not.toHaveProperty("temperature");
  });

  it("sends sampling temperature only when reasoning is off", async () => {
    const adapter = new OpenAITextAdapter({
      apiKey: "test-key",
      model: "gpt-5.6-luna",
      thinkingEffort: "none"
    });
    const mock = installMockResponses(adapter, [textResponse("Direct answer.", "gpt-5.6-luna")]);

    await adapter.generateText({
      messages: [{ role: "user", content: "Answer directly." }],
      temperature: 0.4
    });

    expect(mock.calls[0]?.request).toMatchObject({ reasoning: { effort: "none" }, temperature: 0.4 });
    expect(mock.calls[0]?.request).not.toHaveProperty("include");
  });

  it("requests JSON mode and validates the returned object", async () => {
    const adapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-5.6-terra" });
    const mock = installMockResponses(adapter, [textResponse(`{"value":"ok"}`, "gpt-5.6-terra")]);

    const result = await adapter.generateJson({
      messages: [{ role: "user", content: "Return the value." }],
      schema: z.object({ value: z.string() })
    });

    expect(result.data).toEqual({ value: "ok" });
    expect(mock.calls[0]?.request).toMatchObject({
      model: "gpt-5.6-terra",
      text: { format: { type: "json_object" } },
      input: [
        expect.objectContaining({ role: "system", content: expect.stringContaining("Return only valid JSON") }),
        { role: "user", content: "Return the value." }
      ]
    });
  });

  it("replays encrypted reasoning and function calls across a stateless tool loop", async () => {
    const adapter = new OpenAITextAdapter({
      apiKey: "test-key",
      model: "gpt-5.6-luna",
      thinkingEffort: "medium"
    });
    const reasoning = {
      id: "rs_1",
      type: "reasoning",
      encrypted_content: "encrypted-reasoning",
      summary: []
    };
    const functionCall = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
      arguments: `{"term":"moon"}`,
      status: "completed"
    };
    const mock = installMockResponses(adapter, [
      response([reasoning, functionCall], ""),
      textResponse("The answer is 42.", "gpt-5.6-luna")
    ]);

    const first = await adapter.generateWithTools({
      messages: [{ role: "user", content: "Look it up." }],
      tools: [lookupTool]
    });
    const second = await adapter.generateWithTools({
      messages: [
        { role: "user", content: "Look it up." },
        { role: "assistant", content: "", toolCalls: first.toolCalls },
        { role: "tool", content: `{"answer":42}`, toolCallId: "call_1", toolName: "lookup" }
      ],
      tools: [lookupTool]
    });

    expect(first.toolCalls).toEqual([{ id: "call_1", name: "lookup", arguments: { term: "moon" } }]);
    expect(second.text).toBe("The answer is 42.");
    expect(mock.calls[1]?.request).toMatchObject({
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium" },
      input: [
        { role: "user", content: "Look it up." },
        reasoning,
        functionCall,
        { type: "function_call_output", call_id: "call_1", output: `{"answer":42}` }
      ],
      tools: [
        expect.objectContaining({ type: "function", name: "lookup", strict: false })
      ]
    });
  });

  it("streams output through both streaming interfaces", async () => {
    const adapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-5.6-luna" });
    installMockResponses(adapter, [streamResponse(["Hello", " world"]), streamResponse(["One", " two"])]);
    const callbackChunks: string[] = [];

    const callback = await adapter.generateText({
      messages: [{ role: "user", content: "Hello." }],
      onOutputTextChunk: (chunk) => {
        callbackChunks.push(chunk);
      }
    });
    const yielded: string[] = [];
    for await (const chunk of adapter.streamText({ messages: [{ role: "user", content: "Count." }] })) {
      yielded.push(chunk);
    }

    expect(callbackChunks).toEqual(["Hello", " world"]);
    expect(callback).toMatchObject({ text: "Hello world", provider: "openai" });
    expect(yielded).toEqual(["One", " two"]);
  });

  it("rejects failed non-streaming responses and preserves their usage", async () => {
    const adapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-5.6-sol" });
    installMockResponses(adapter, [
      {
        ...textResponse(""),
        status: "failed",
        error: { code: "server_error", message: "The model failed while generating the response." }
      }
    ]);

    await expect(
      adapter.generateText({ messages: [{ role: "user", content: "Try it." }] })
    ).rejects.toMatchObject({
      name: "OpenAIResponseError",
      message: "OpenAI response failed: The model failed while generating the response.",
      code: "server_error",
      status: 500,
      provider: "openai",
      model: "gpt-5.6-sol",
      usage: {
        promptTokens: 120,
        outputTokens: 30,
        cacheHitTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: 10
      }
    });
  });

  it("rejects incomplete and error stream terminals instead of returning partial success", async () => {
    const callbackAdapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-5.6-luna" });
    installMockResponses(callbackAdapter, [
      streamEvents([
        { type: "response.output_text.delta", delta: "Partial" },
        {
          type: "response.incomplete",
          response: {
            ...textResponse("Partial", "gpt-5.6-luna"),
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" }
          }
        }
      ])
    ]);

    await expect(
      callbackAdapter.generateText({
        messages: [{ role: "user", content: "Keep going." }],
        onOutputTextChunk: () => undefined
      })
    ).rejects.toMatchObject({
      name: "OpenAIResponseError",
      message: "OpenAI response was incomplete: max_output_tokens.",
      provider: "openai",
      model: "gpt-5.6-luna"
    });

    const iteratorAdapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-5.6-luna" });
    installMockResponses(iteratorAdapter, [
      streamEvents([{ type: "error", code: "stream_error", message: "The stream broke.", param: null }])
    ]);
    const consume = async () => {
      for await (const _chunk of iteratorAdapter.streamText({ messages: [{ role: "user", content: "Go." }] })) {
        // Consume the stream so its terminal event is observed.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: "OpenAIResponseError",
      message: "OpenAI response failed: The stream broke.",
      code: "stream_error",
      provider: "openai",
      model: "gpt-5.6-luna"
    });
  });

  it("wraps a Responses SDK TPM 429 as ProviderHttpError with retry-after-ms", async () => {
    const jsonSchema = z.object({ value: z.string() });
    const textAdapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-5.6-luna" });
    installMockResponses(textAdapter, [incidentRateLimitError()]);
    await expectWrappedRateLimit(() =>
      textAdapter.generateText({ messages: [{ role: "user", content: "Draft it." }] })
    );

    const jsonAdapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-5.6-luna" });
    installMockResponses(jsonAdapter, [incidentRateLimitError()]);
    await expectWrappedRateLimit(() =>
      jsonAdapter.generateJson({ messages: [{ role: "user", content: "Return the value." }], schema: jsonSchema })
    );

    const streamAdapter = new OpenAITextAdapter({ apiKey: "test-key", model: "gpt-5.6-luna" });
    installMockResponses(streamAdapter, [throwingStream(incidentRateLimitError())]);
    await expectWrappedRateLimit(() =>
      streamAdapter.generateText({
        messages: [{ role: "user", content: "Draft it." }],
        onOutputTextChunk: () => undefined
      })
    );
  });
});

type MockCall = { request: Record<string, unknown>; options: unknown };

function installMockResponses(
  adapter: OpenAITextAdapter,
  responses: Array<Record<string, unknown> | AsyncIterable<Record<string, unknown>> | Error>
): { calls: MockCall[] } {
  const calls: MockCall[] = [];
  const queue = [...responses];
  (adapter as unknown as { client: unknown }).client = {
    responses: {
      create: async (request: Record<string, unknown>, options: unknown) => {
        calls.push({ request, options });
        const next = queue.shift();
        if (!next) throw new Error("No mocked OpenAI response remains.");
        if (next instanceof Error) throw next;
        return next;
      }
    }
  };
  return { calls };
}

async function expectWrappedRateLimit(run: () => Promise<unknown>): Promise<void> {
  const error = await run().then(
    () => {
      throw new Error("expected provider call to reject");
    },
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ProviderHttpError);
  expect(error).toMatchObject({
    status: 429,
    retryAfterMs: 845,
    message: "Rate limit reached for gpt-5.6-luna ... Please try again in 845ms."
  });
  expect(isRecoverableNetworkError(error)).toBe(true);
  expect(isTextProviderFallbackError(error)).toBe(false);
}

function incidentRateLimitError(): Error {
  return Object.assign(new Error("Rate limit reached for gpt-5.6-luna ... Please try again in 845ms."), {
    code: "rate_limit_exceeded",
    type: "tokens",
    headers: {},
    requestID: "req_e72cdd2985fd468c9e052e0490c2d304",
    error: {
      type: "tokens",
      code: "rate_limit_exceeded",
      headers: {
        "retry-after": "1",
        "retry-after-ms": "845",
        "x-ratelimit-limit-tokens": "200000"
      },
      message: "Rate limit reached ...",
      param: null
    }
  });
}

function throwingStream(error: Error): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    }
  };
}

function textResponse(text: string, model = "gpt-5.6-sol"): Record<string, unknown> {
  return response([
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    }
  ], text, model);
}

function response(output: unknown[], outputText: string, model = "gpt-5.6-sol"): Record<string, unknown> {
  return {
    id: "resp_1",
    model,
    output_text: outputText,
    output,
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 10 }
    }
  };
}

function streamEvents(events: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  return (async function* () {
    yield* events;
  })();
}

function streamResponse(parts: string[]): AsyncIterable<Record<string, unknown>> {
  return (async function* () {
    for (const delta of parts) {
      yield { type: "response.output_text.delta", delta };
    }
    yield { type: "response.completed", response: textResponse(parts.join("")) };
  })();
}
