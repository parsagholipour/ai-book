import type { ToolCallProgress } from "./types.js";

/** Reads only a top-level JSON string, including a safely decoded partial value. */
export function partialJsonString(input: string, field: string): string | undefined {
  let index = 0;
  const whitespace = () => { while (/\s/.test(input[index] ?? "") && index < input.length) index++; };
  const string = (): { value: string; complete: boolean } | undefined => {
    if (input[index++] !== '"') return undefined;
    const start = index - 1;
    let end = index;
    while (index < input.length) {
      const char = input[index++];
      if (char === '"') {
        try { return { value: JSON.parse(input.slice(start, index)), complete: true }; } catch { return undefined; }
      }
      if (char === "\\") {
        if (index >= input.length) break;
        if (input[index++] === "u") {
          if (input.length - index < 4) break;
          index += 4;
        }
      }
      end = index;
    }
    try {
      // A high surrogate may be completed by the next provider chunk.
      const value = (JSON.parse(input.slice(start, end) + '"') as string).replace(/[\uD800-\uDBFF]$/, "");
      return { value, complete: false };
    } catch { return undefined; }
  };
  whitespace();
  if (input[index++] !== "{") return undefined;
  while (index < input.length) {
    whitespace();
    const key = string();
    if (!key?.complete) return undefined;
    whitespace();
    if (input[index++] !== ":") return undefined;
    whitespace();
    if (key.value === field) return input[index] === '"' ? string()?.value : undefined;
    // Skip a different value without mistaking a nested key for the reply.
    let depth = 0;
    while (index < input.length) {
      const char = input[index];
      if (char === '"') { if (!string()?.complete) return undefined; continue; }
      if (char === "{" || char === "[") depth++;
      if (char === "}" || char === "]") { if (depth === 0) return undefined; depth--; }
      index++;
      if (char === "," && depth === 0) break;
    }
  }
  return undefined;
}

export type TurnPreview = {
  /** A new model call or attempt begins: its text is held until it differs from what is shown. */
  restart(): void;
  text(text: string): void | Promise<void>;
};

/**
 * One preview for a whole chat turn, however many model calls or retries it
 * takes. The first text opens it, an empty one included: that is what starts
 * the chat's event stream and its heartbeat. After that the preview is only
 * ever replaced. A later call is held back while it re-types the text already
 * shown, and takes over once it says something else or says more. It is never
 * blanked: a reset to "" between calls put the thinking dots back over a reply
 * the reader was halfway through, and then typed the reply out again.
 */
export function turnPreview(onText: (text: string) => void | Promise<void>): TurnPreview {
  let shown: string | undefined;
  let replacing = false;
  return {
    restart() {
      replacing = false;
    },
    text(text) {
      if (text === shown || (shown !== undefined && !replacing && shown.startsWith(text))) return;
      replacing = true;
      shown = text;
      return onText(text);
    }
  };
}

/** Snapshots replace the preview, so retries never append to an abandoned answer. */
export function streamedToolReply(toolName: string, onText: (text: string) => void | Promise<void>, field = "assistantMessage") {
  let previous = "";
  return async (event: ToolCallProgress): Promise<void> => {
    const text = event.type === "start" ? "" : event.name === toolName
      ? partialJsonString(event.argumentsText, field) : undefined;
    if (text !== undefined && text !== previous) {
      previous = text;
      await onText(text);
    }
  };
}
