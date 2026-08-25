import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runToolLoop, type ToolLoopTool } from "./toolLoop.js";
import type { GenerateWithToolsOptions, TextModelAdapter, ToolCallsResult } from "./types.js";

type ScriptedTurn =
  | { toolCalls: Array<{ name: string; arguments: unknown }>; text?: string }
  | { text: string }
  | { error: Error };

function scriptedModel(turns: ScriptedTurn[]): TextModelAdapter & { calls: GenerateWithToolsOptions[] } {
  const calls: GenerateWithToolsOptions[] = [];
  let index = 0;
  return {
    calls,
    async generateWithTools(options): Promise<ToolCallsResult> {
      calls.push(options);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (!turn) {
        return { text: "", model: "scripted", provider: "test", toolCalls: [] };
      }
      if ("error" in turn) {
        throw turn.error;
      }
      return {
        text: turn.text ?? "",
        model: "scripted",
        provider: "test",
        toolCalls: ("toolCalls" in turn ? turn.toolCalls : []).map((call, callIndex) => ({
          id: `call_${index}_${callIndex}`,
          name: call.name,
          arguments: call.arguments
        })),
        usage: { promptTokens: 10, outputTokens: 5, cacheHitTokens: 2, cacheWriteTokens: 3 }
      };
    },
    generateText: () => Promise.reject(new Error("not used")),
    generateJson: () => Promise.reject(new Error("not used")),
    // eslint-disable-next-line require-yield
    streamText: async function* () {
      throw new Error("not used");
    }
  };
}

const echoTool: ToolLoopTool<{ value: string }> = {
  name: "echo",
  description: "Echoes the value back.",
  parameters: z.object({ value: z.string() }),
  execute: ({ value }) => ({ echoed: value })
};

const finishTool = {
  name: "finish",
  description: "Finish with a structured result.",
  parameters: z.object({ answer: z.string().max(20) })
};

describe("runToolLoop", () => {
  it("executes tool calls, feeds results back, and returns the finish payload", async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: "echo", arguments: { value: "hello" } }] },
      { toolCalls: [{ name: "finish", arguments: { answer: "done" } }] }
    ]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [echoTool],
      finishTool
    });

    expect(result.status).toBe("finished");
    expect(result.finish).toEqual({ answer: "done" });
    expect(result.modelCalls).toBe(2);
    // Second call must include the assistant tool-call turn and the tool result.
    const roles = model.calls[1]!.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
    expect(model.calls[1]!.messages[2]!.content).toContain("echoed");
    expect(result.usage).toEqual({
      promptTokens: 20,
      outputTokens: 10,
      cacheHitTokens: 4,
      cacheWriteTokens: 6
    });
  });

  it("finishes on plain text when no finish tool is configured", async () => {
    const model = scriptedModel([{ text: "final answer" }]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [echoTool]
    });

    expect(result.status).toBe("finished");
    expect(result.finalText).toBe("final answer");
    expect(result.finish).toBeUndefined();
  });

  it("turns unknown tools and handler failures into error results the model can react to", async () => {
    const failingTool: ToolLoopTool<{ value: string }> = {
      ...echoTool,
      name: "explode",
      execute: () => {
        throw new Error("boom");
      }
    };
    const model = scriptedModel([
      {
        toolCalls: [
          { name: "missing_tool", arguments: {} },
          { name: "explode", arguments: { value: "x" } }
        ]
      },
      { toolCalls: [{ name: "finish", arguments: { answer: "recovered" } }] }
    ]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [failingTool],
      finishTool
    });

    expect(result.status).toBe("finished");
    expect(result.finish).toEqual({ answer: "recovered" });
    expect(result.toolEvents).toHaveLength(2);
    expect(result.toolEvents[0]!.isError).toBe(true);
    expect(result.toolEvents[0]!.resultContent).toContain("Unknown tool");
    expect(result.toolEvents[1]!.isError).toBe(true);
    expect(result.toolEvents[1]!.resultContent).toContain("boom");
  });

  it.each<[string, Error]>([
    ["a stop", Object.assign(new Error("Stopped by user"), { name: "StopRequestedError" })],
    ["an abort", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })]
  ])("lets %s raised inside a tool escape instead of answering the model with it", async (_label, cancellation) => {
    // The worker's StopRequestedError by shape: packages/core is the leaf of
    // `apps/* -> packages/db -> packages/core` and cannot import the class.
    const cancelledTool: ToolLoopTool<{ value: string }> = {
      ...echoTool,
      execute: () => {
        throw cancellation;
      }
    };
    const model = scriptedModel([
      { toolCalls: [{ name: "echo", arguments: { value: "the vault" } }] },
      { toolCalls: [{ name: "finish", arguments: { answer: "kept writing" } }] }
    ]);

    await expect(
      runToolLoop({
        textModel: model,
        messages: [{ role: "user", content: "go" }],
        tools: [cancelledTool],
        finishTool
      })
    ).rejects.toBe(cancellation);
    // The loop stopped where the cancellation was raised rather than letting
    // the model work past it to a finished answer.
    expect(model.calls).toHaveLength(1);
  });

  it("keeps a tool failure that merely says 'aborted' recoverable", async () => {
    // The counterpart of the test above, and the reason the escape hatch reads
    // the error's identity rather than its message: this loop is shared with the
    // API's chat loops, which have no cancellation to honour, and an ordinary
    // provider failure escaping there would end the turn instead of giving the
    // model something to work around.
    const flakyTool: ToolLoopTool<{ value: string }> = {
      ...echoTool,
      execute: () => {
        throw new Error("The grounded web search failed: upstream request aborted by the gateway.");
      }
    };
    const model = scriptedModel([
      { toolCalls: [{ name: "echo", arguments: { value: "the vault" } }] },
      { toolCalls: [{ name: "finish", arguments: { answer: "recovered" } }] }
    ]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [flakyTool],
      finishTool
    });

    expect(result.status).toBe("finished");
    expect(result.finish).toEqual({ answer: "recovered" });
    expect(result.toolEvents[0]!.isError).toBe(true);
    expect(result.toolEvents[0]!.resultContent).toContain("request aborted");
  });

  it("lets a loop opt out of the escape hatch entirely with rethrowIf: null", async () => {
    const cancellation = Object.assign(new Error("Stopped by user"), { name: "StopRequestedError" });
    const cancelledTool: ToolLoopTool<{ value: string }> = {
      ...echoTool,
      execute: () => {
        throw cancellation;
      }
    };
    const model = scriptedModel([
      { toolCalls: [{ name: "echo", arguments: { value: "the vault" } }] },
      { toolCalls: [{ name: "finish", arguments: { answer: "carried on" } }] }
    ]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [cancelledTool],
      finishTool,
      rethrowIf: null
    });

    expect(result.status).toBe("finished");
    expect(result.toolEvents[0]!.isError).toBe(true);
  });

  it("rejects invalid tool arguments without executing the handler", async () => {
    let executed = 0;
    const strictTool: ToolLoopTool<{ value: string }> = {
      ...echoTool,
      execute: ({ value }) => {
        executed += 1;
        return { echoed: value };
      }
    };
    const model = scriptedModel([
      { toolCalls: [{ name: "echo", arguments: { value: 42 } }] },
      { toolCalls: [{ name: "finish", arguments: { answer: "ok" } }] }
    ]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [strictTool],
      finishTool
    });

    expect(executed).toBe(0);
    expect(result.toolEvents[0]!.isError).toBe(true);
    expect(result.toolEvents[0]!.resultContent).toContain("Invalid arguments");
    expect(result.finish).toEqual({ answer: "ok" });
  });

  it("sends invalid finish arguments back as a tool error for repair", async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: "finish", arguments: { answer: "this answer is far too long" } }] },
      { toolCalls: [{ name: "finish", arguments: { answer: "short" } }] }
    ]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [],
      finishTool
    });

    expect(result.status).toBe("finished");
    expect(result.finish).toEqual({ answer: "short" });
    const repair = model.calls[1]!.messages.at(-1);
    expect(repair?.role).toBe("tool");
    expect(repair?.content).toContain("Invalid finish arguments");
  });

  it("recovers a finish payload emitted as plain JSON text", async () => {
    const model = scriptedModel([{ text: '{"answer": "from text"}' }]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [],
      finishTool
    });

    expect(result.status).toBe("finished");
    expect(result.finish).toEqual({ answer: "from text" });
  });

  it("nudges once for plain text, then reports exhausted when the model never finishes", async () => {
    const model = scriptedModel([{ text: "chatting" }, { text: "still chatting" }]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [],
      finishTool
    });

    expect(result.status).toBe("exhausted");
    expect(result.finish).toBeUndefined();
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.messages.at(-1)?.content).toContain("finish");
  });

  it("defers a premature finish that arrives alongside pending tool calls", async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          { name: "echo", arguments: { value: "first" } },
          { name: "finish", arguments: { answer: "too early" } }
        ]
      },
      { toolCalls: [{ name: "finish", arguments: { answer: "after tools" } }] }
    ]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [echoTool],
      finishTool
    });

    expect(result.finish).toEqual({ answer: "after tools" });
    expect(result.toolEvents).toHaveLength(1);
    expect(result.toolEvents[0]!.call.name).toBe("echo");
  });

  it("stops at the model call budget", async () => {
    const model = scriptedModel([{ toolCalls: [{ name: "echo", arguments: { value: "loop" } }] }]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [echoTool],
      finishTool,
      maxModelCalls: 2
    });

    expect(result.status).toBe("exhausted");
    expect(model.calls).toHaveLength(2);
  });

  it("routes every model call through the onModelCall middleware", async () => {
    const seen: number[] = [];
    const model = scriptedModel([
      { toolCalls: [{ name: "echo", arguments: { value: "one" } }] },
      { toolCalls: [{ name: "finish", arguments: { answer: "done" } }] }
    ]);

    await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [echoTool],
      finishTool,
      onModelCall: (invoke, context) => {
        seen.push(context.modelCall);
        return invoke();
      }
    });

    expect(seen).toEqual([1, 2]);
  });

  it("truncates oversized tool results", async () => {
    const bigTool: ToolLoopTool<{ value: string }> = {
      ...echoTool,
      execute: () => "x".repeat(5000)
    };
    const model = scriptedModel([
      { toolCalls: [{ name: "echo", arguments: { value: "big" } }] },
      { toolCalls: [{ name: "finish", arguments: { answer: "done" } }] }
    ]);

    const result = await runToolLoop({
      textModel: model,
      messages: [{ role: "user", content: "go" }],
      tools: [bigTool],
      finishTool,
      maxToolResultChars: 500
    });

    expect(result.toolEvents[0]!.resultContent.length).toBeLessThan(600);
    expect(result.toolEvents[0]!.resultContent).toContain("[truncated]");
  });
});
