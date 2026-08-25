import type OpenAI from "openai";
import { z } from "zod";
import type {
  ChatMessage,
  ToolCall,
  ToolDefinition
} from "./types.js";

/**
 * Shared OpenAI-style chat-completions tool calling used by every adapter that
 * speaks the OpenAI wire format (DeepSeek, DeepInfra, Alibaba Qwen, local
 * OpenAI-compatible servers). Providers differ only in extra request params
 * (thinking config) and usage extraction.
 */

type OpenAiChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAiChatMessages(messages: ChatMessage[]): OpenAiChatMessage[] {
  return messages.map((message): OpenAiChatMessage => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? ""
      };
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      if (toolCalls.length === 0) {
        return { role: "assistant", content: message.content };
      }
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: serializeToolArguments(call.arguments)
          }
        }))
      };
    }
    return { role: message.role, content: message.content };
  });
}

export function toOpenAiTools(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolParametersJsonSchema(tool)
    }
  }));
}

export function toolParametersJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  return z.toJSONSchema(tool.parameters as never, { unrepresentable: "any" }) as Record<string, unknown>;
}

export function toolCallsFromOpenAiMessage(message: unknown): ToolCall[] {
  const record = message as { tool_calls?: unknown } | null | undefined;
  const rawCalls = Array.isArray(record?.tool_calls) ? record.tool_calls : [];
  const calls: ToolCall[] = [];
  for (const [index, rawCall] of rawCalls.entries()) {
    const call = rawCall as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    if (call.type !== undefined && call.type !== "function") {
      continue;
    }
    const name = typeof call.function?.name === "string" ? call.function.name : "";
    if (!name) {
      continue;
    }
    calls.push({
      id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
      name,
      arguments: parseToolArguments(call.function?.arguments)
    });
  }
  return calls;
}

/**
 * Providers send tool arguments as a JSON string. Invalid JSON is preserved
 * under a marker key so the tool loop can surface a validation error the
 * model can react to, instead of crashing the turn.
 */
function parseToolArguments(raw: unknown): unknown {
  if (raw !== undefined && typeof raw !== "string") {
    return raw;
  }
  if (!raw || !raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __unparsedArguments: raw };
  }
}

function serializeToolArguments(args: unknown): string {
  if (args && typeof args === "object" && "__unparsedArguments" in (args as Record<string, unknown>)) {
    return String((args as Record<string, unknown>).__unparsedArguments);
  }
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

/**
 * OpenAI-SDK per-request options carrying the caller's abort signal, so a
 * user stop can tear down the in-flight HTTP request instead of waiting out
 * the full generation. Undefined when no signal was given.
 */
export function openAiRequestOptions(options: { signal?: AbortSignal }): { signal: AbortSignal } | undefined {
  return options.signal ? { signal: options.signal } : undefined;
}
