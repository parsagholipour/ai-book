import { z, type ZodType } from "zod";
import { AdapterJsonValidationError } from "../adapters/json.js";
import {
  bindTextModelCall,
  type ChatMessage,
  type GenerateJsonOptions,
  type JsonResult,
  type TextModelAdapter
} from "../adapters/types.js";

export type GenerateJsonWithRetryOptions<T> = GenerateJsonOptions<T> & {
  /** Additional model calls after a repairable parse/schema failure. Bounded to two. */
  repairAttempts?: number | undefined;
};

const STRICT_JSON_RETRY_RULES = [
  "Return one complete syntactically valid JSON object only.",
  "Every array element and object property must be separated by a comma.",
  "Do not include Markdown fences or prose outside JSON."
];

const SCHEMA_REPAIR_RULES = [
  "Your previous JSON did not match the required schema.",
  "Return a corrected complete JSON object only; preserve valid content while fixing every listed validation issue.",
  "Do not explain the correction or include Markdown fences."
];

export async function generateJsonWithRetry<T>(
  textModel: TextModelAdapter,
  options: GenerateJsonWithRetryOptions<T>
): Promise<JsonResult<T>> {
  const { repairAttempts: requestedRepairAttempts, ...generateOptions } = options;
  const repairAttempts = Math.max(0, Math.min(2, Math.floor(requestedRepairAttempts ?? 1)));
  let nextOptions: GenerateJsonOptions<T> = generateOptions;
  // A schema-repair attempt belongs to the call that produced the invalid
  // JSON. Resolve a live route once so an operator save between attempts does
  // not silently hand the repair to another model.
  const bound = await bindTextModelCall(textModel, generateOptions.purpose);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await bound.adapter.generateJson(nextOptions);
    } catch (error) {
      if (attempt >= repairAttempts || !isRepairableJsonError(error)) {
        throw error;
      }
      nextOptions = repairOptions(generateOptions, error);
    }
  }
}

function repairOptions<T>(options: GenerateJsonOptions<T>, error: unknown): GenerateJsonOptions<T> {
  if (isSchemaValidationError(error)) {
    return {
      ...options,
      messages: withSchemaRepairRules(options.messages, options.schema, error),
      temperature: Math.min(options.temperature ?? 0.7, 0.2)
    };
  }
  return {
    ...options,
    messages: prependSystemRules(options.messages, STRICT_JSON_RETRY_RULES),
    temperature: Math.min(options.temperature ?? 0.7, 0.35)
  };
}

function withSchemaRepairRules<T>(messages: ChatMessage[], schema: ZodType<T>, error: unknown): ChatMessage[] {
  return prependSystemRules(messages, [
    ...SCHEMA_REPAIR_RULES,
    `Validation issues: ${validationDetails(error)}`,
    `Required JSON schema: ${JSON.stringify(schemaToJson(schema))}`
  ]);
}

function prependSystemRules(messages: ChatMessage[], rules: string[]): ChatMessage[] {
  const next = messages.map((message) => ({ ...message }));
  const systemIndex = next.findIndex((message) => message.role === "system");
  if (systemIndex >= 0) {
    next[systemIndex] = {
      role: "system",
      content: [...rules, next[systemIndex]!.content].join(" ")
    };
  } else {
    next.unshift({ role: "system", content: rules.join(" ") });
  }
  return next;
}

function isRepairableJsonError(error: unknown): boolean {
  return isRecoverableJsonSyntaxError(error) || isSchemaValidationError(error);
}

function isSchemaValidationError(error: unknown): boolean {
  return error instanceof AdapterJsonValidationError || (error instanceof Error && error.name.endsWith('JsonValidationError'));
}

function validationDetails(error: unknown): string {
  if (error instanceof AdapterJsonValidationError) {
    return error.context.validationMessage.slice(0, 4000);
  }
  return error instanceof Error ? error.message.slice(0, 4000) : "Unknown validation error.";
}

function schemaToJson<T>(schema: ZodType<T>): unknown {
  try {
    return z.toJSONSchema(schema as never, { unrepresentable: "any" });
  } catch {
    return { description: "Conform to the requested response schema." };
  }
}

function isRecoverableJsonSyntaxError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    error instanceof SyntaxError ||
    error.name.endsWith('JsonParseError') ||
    /(?:Model did not return a JSON object|invalid JSON|Expected .* in JSON|Unexpected token|Unterminated string)/i.test(
      message
    )
  );
}
