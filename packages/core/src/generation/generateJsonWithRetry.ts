import type { ChatMessage, GenerateJsonOptions, JsonResult, TextModelAdapter } from "../adapters/types.js";

export type GenerateJsonWithRetryOptions<T> = GenerateJsonOptions<T>;

const STRICT_JSON_RETRY_RULES = [
  "Return one complete syntactically valid JSON object only.",
  "Every array element and object property must be separated by a comma.",
  "Do not include Markdown fences or prose outside JSON."
];

export async function generateJsonWithRetry<T>(
  textModel: TextModelAdapter,
  options: GenerateJsonWithRetryOptions<T>
): Promise<JsonResult<T>> {
  try {
    return await textModel.generateJson(options);
  } catch (error) {
    if (!isRecoverableJsonSyntaxError(error)) {
      throw error;
    }
    return textModel.generateJson({
      ...options,
      messages: withStrictJsonRetryRules(options.messages),
      temperature: Math.min(options.temperature ?? 0.7, 0.35)
    });
  }
}

function withStrictJsonRetryRules(messages: ChatMessage[]): ChatMessage[] {
  const next = messages.map((message) => ({ ...message }));
  const systemIndex = next.findIndex((message) => message.role === "system");
  if (systemIndex >= 0) {
    next[systemIndex] = {
      role: "system",
      content: [...STRICT_JSON_RETRY_RULES, next[systemIndex]!.content].join(" ")
    };
  } else {
    next.unshift({ role: "system", content: STRICT_JSON_RETRY_RULES.join(" ") });
  }
  return next;
}

function isRecoverableJsonSyntaxError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    error instanceof SyntaxError ||
    /JsonParseError$/.test(error.name) ||
    /(?:Model did not return a JSON object|invalid JSON|Expected .* in JSON|Unexpected token|Unterminated string)/i.test(
      message
    )
  );
}
