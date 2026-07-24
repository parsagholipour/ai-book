import { parseJsonObject } from "./json.js";
import type {
  ChatMessage,
  TextModelAdapter,
  ToolCall,
  ToolCallsResult,
  ToolChoice,
  ToolDefinition,
  Usage
} from "./types.js";

/**
 * Generic agentic tool loop: the model decides which tools to call, the loop
 * executes them and feeds results back, until the model produces its final
 * answer. Structured outputs use a "finish tool" (works uniformly across
 * providers, unlike mixing tools with JSON response mode).
 *
 * Reliability properties:
 * - Invalid tool arguments become error tool-results the model can repair.
 * - Tool handler failures become error tool-results, never thrown turns.
 * - A plain-text reply where a finish tool was required is recovered by
 *   parsing the text as the finish payload, then by one explicit nudge.
 * - The loop is bounded by maxModelCalls; callers keep their deterministic
 *   fallbacks for the exhausted case.
 */

export type ToolLoopTool<TArgs = unknown> = ToolDefinition<TArgs> & {
  /** Returns the tool result; non-string results are JSON-serialized. Throwing produces an error result. */
  execute: (args: TArgs) => Promise<unknown> | unknown;
};

export type ToolLoopToolEvent = {
  call: ToolCall;
  resultContent: string;
  isError: boolean;
};

export type ToolLoopModelCallContext = {
  modelCall: number;
  maxModelCalls: number;
};

export type ToolLoopOptions<TFinish = string> = {
  textModel: TextModelAdapter;
  messages: ChatMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Array<ToolLoopTool<any>>;
  /**
   * Terminal tool carrying the structured result. When omitted, the loop
   * finishes on the first plain-text assistant reply.
   */
  finishTool?: ToolDefinition<TFinish> | undefined;
  purpose?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  toolChoice?: ToolChoice | undefined;
  /** Model call budget for the whole loop (default 4). */
  maxModelCalls?: number | undefined;
  /** Middleware around each model call; wrap with timeouts/retries here. */
  onModelCall?:
    | ((invoke: () => Promise<ToolCallsResult>, context: ToolLoopModelCallContext) => Promise<ToolCallsResult>)
    | undefined;
  /** Observability hook fired after each tool execution. */
  onToolResult?: ((event: ToolLoopToolEvent) => void | Promise<void>) | undefined;
  /** Cap on serialized tool result content fed back to the model. */
  maxToolResultChars?: number | undefined;
};

export type ToolLoopResult<TFinish = string> = {
  status: "finished" | "exhausted";
  /** Parsed finish-tool payload; set when status is "finished" and a finish tool was configured. */
  finish?: TFinish | undefined;
  /** Last assistant text (final answer for loops without a finish tool). */
  finalText: string;
  /** Full transcript including tool calls and results. */
  messages: ChatMessage[];
  toolEvents: ToolLoopToolEvent[];
  modelCalls: number;
  usage: Usage;
  model: string;
  provider: string;
};

const DEFAULT_MAX_MODEL_CALLS = 4;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 16_000;

export async function runToolLoop<TFinish = string>(options: ToolLoopOptions<TFinish>): Promise<ToolLoopResult<TFinish>> {
  const maxModelCalls = Math.max(1, options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS);
  const maxToolResultChars = Math.max(200, options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS);
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const toolDefinitions: ToolDefinition[] = [
    ...options.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    ...(options.finishTool ? [options.finishTool as ToolDefinition] : [])
  ];

  const messages: ChatMessage[] = [...options.messages];
  const toolEvents: ToolLoopToolEvent[] = [];
  const usage: Usage = {};
  let model = "";
  let provider = "";
  let finalText = "";
  let nudged = false;

  const state = () => ({ messages, toolEvents, usage, model, provider });

  for (let modelCall = 1; modelCall <= maxModelCalls; modelCall += 1) {
    const invoke = () =>
      options.textModel.generateWithTools({
        messages,
        tools: toolDefinitions,
        ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
        ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {})
      });
    const result = options.onModelCall
      ? await options.onModelCall(invoke, { modelCall, maxModelCalls })
      : await invoke();

    model = result.model;
    provider = result.provider;
    accumulateUsage(usage, result.usage);
    if (result.text.trim()) {
      finalText = result.text.trim();
    }

    const finishCalls = options.finishTool
      ? result.toolCalls.filter((call) => call.name === options.finishTool!.name)
      : [];
    const workCalls = result.toolCalls.filter((call) => !finishCalls.includes(call));

    // Execute regular tool calls first; a finish alongside pending work is
    // premature (its answer cannot reflect the tool results), so it is
    // deferred to the next turn.
    if (workCalls.length > 0) {
      messages.push({ role: "assistant", content: result.text, toolCalls: workCalls });
      for (const call of workCalls) {
        const event = await executeToolCall(call, toolsByName.get(call.name), maxToolResultChars);
        toolEvents.push(event);
        await options.onToolResult?.(event);
        messages.push({ role: "tool", content: event.resultContent, toolCallId: call.id, toolName: call.name });
      }
      continue;
    }

    if (finishCalls.length > 0) {
      const finishCall = finishCalls[0]!;
      const parsed = options.finishTool!.parameters.safeParse(finishCall.arguments);
      if (parsed.success) {
        return {
          status: "finished",
          finish: parsed.data,
          finalText,
          modelCalls: modelCall,
          ...state()
        };
      }
      messages.push({ role: "assistant", content: result.text, toolCalls: [finishCall] });
      messages.push({
        role: "tool",
        content: `Invalid ${options.finishTool!.name} arguments: ${zodIssueSummary(parsed.error)}. Call ${options.finishTool!.name} again with corrected arguments.`,
        toolCallId: finishCall.id,
        toolName: finishCall.name
      });
      continue;
    }

    // Plain text turn.
    if (!options.finishTool) {
      return { status: "finished", finalText, modelCalls: modelCall, ...state() };
    }
    const recovered = recoverFinishFromText<TFinish>(result.text, options.finishTool);
    if (recovered !== undefined) {
      return { status: "finished", finish: recovered, finalText, modelCalls: modelCall, ...state() };
    }
    if (nudged) {
      break;
    }
    nudged = true;
    messages.push({ role: "assistant", content: result.text });
    messages.push({
      role: "user",
      content: `Do not answer in plain text. Call the ${options.finishTool.name} tool now with the completed result.`
    });
  }

  return { status: "exhausted", finalText, modelCalls: maxModelCalls, ...state() };
}

async function executeToolCall(
  call: ToolCall,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: ToolLoopTool<any> | undefined,
  maxToolResultChars: number
): Promise<ToolLoopToolEvent> {
  if (!tool) {
    return {
      call,
      resultContent: JSON.stringify({ error: `Unknown tool "${call.name}". Use only the tools provided.` }),
      isError: true
    };
  }
  const parsed = tool.parameters.safeParse(call.arguments);
  if (!parsed.success) {
    return {
      call,
      resultContent: JSON.stringify({
        error: `Invalid arguments for ${call.name}: ${zodIssueSummary(parsed.error)}. Call it again with corrected arguments.`
      }),
      isError: true
    };
  }
  try {
    const result = await tool.execute(parsed.data);
    const content = typeof result === "string" ? result : JSON.stringify(result ?? {});
    return { call, resultContent: truncateToolResult(content, maxToolResultChars), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      call,
      resultContent: JSON.stringify({ error: `The ${call.name} tool failed: ${truncateToolResult(message, 600)}` }),
      isError: true
    };
  }
}

/** Models sometimes emit the finish payload as raw JSON text; accept it. */
function recoverFinishFromText<TFinish>(text: string, finishTool: ToolDefinition<TFinish>): TFinish | undefined {
  if (!text.includes("{")) {
    return undefined;
  }
  let candidate: unknown;
  try {
    candidate = parseJsonObject(text, "ToolLoop");
  } catch {
    return undefined;
  }
  const parsed = finishTool.parameters.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function zodIssueSummary(error: { issues?: Array<{ path?: PropertyKey[]; message?: string }> } | undefined): string {
  const issues = error?.issues ?? [];
  if (issues.length === 0) {
    return "arguments did not match the tool schema";
  }
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = (issue.path ?? []).map(String).join(".");
      return path ? `${path}: ${issue.message ?? "invalid"}` : issue.message ?? "invalid";
    })
    .join("; ");
}

function truncateToolResult(content: string, maxChars: number): string {
  return content.length <= maxChars ? content : `${content.slice(0, maxChars)}\n... [truncated]`;
}

function accumulateUsage(total: Usage, next: Usage | undefined): void {
  if (!next) {
    return;
  }
  total.promptTokens = addTokens(total.promptTokens, next.promptTokens);
  total.outputTokens = addTokens(total.outputTokens, next.outputTokens);
  total.cacheHitTokens = addTokens(total.cacheHitTokens, next.cacheHitTokens);
}

function addTokens(current: number | undefined, extra: number | undefined): number | undefined {
  if (extra === undefined) {
    return current;
  }
  return (current ?? 0) + extra;
}
