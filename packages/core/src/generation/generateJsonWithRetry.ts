import { z, type ZodType } from "zod";
import { AdapterJsonValidationError } from "../adapters/json.js";
import { JsonOutputRepetitionError } from "../adapters/jsonOutputRepetition.js";
import { widenedOutputBudget } from "../adapters/outputBudget.js";
import { assertTextAttemptAvailable, withTextAttemptBudget } from "../adapters/textAttemptBudget.js";
import {
  bindTextModelCall,
  type ChatMessage,
  type GenerateJsonOptions,
  type JsonResult,
  type ProviderCallMetadata,
  type TextModelAdapter
} from "../adapters/types.js";

export type GenerateJsonWithRetryOptions<T> = GenerateJsonOptions<T> & {
  /** Caller already included the exact schema (and measured it against its input budget). */
  jsonContractInMessages?: boolean;
  /** Additional model calls after a repairable parse/schema failure. Bounded to two. */
  repairAttempts?: number | undefined;
  annotatePhysicalAttempt?: (
    metadata: ProviderCallMetadata | undefined,
    attempt: { index: number; maxAttempts: number; schemaRepair: boolean }
  ) => ProviderCallMetadata | undefined;
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
  const {
    repairAttempts: requestedRepairAttempts,
    annotatePhysicalAttempt,
    jsonContractInMessages,
    ...originalOptions
  } = options;
  const generateOptions = withTextAttemptBudget({
    ...originalOptions,
    messages: jsonContractInMessages ? originalOptions.messages : jsonSchemaMessages(originalOptions.messages, originalOptions.schema)
  });
  const repairAttempts = Math.max(0, Math.min(2, Math.floor(requestedRepairAttempts ?? 1)));
  let nextOptions: GenerateJsonOptions<T> = generateOptions;
  // A schema-repair attempt belongs to the call that produced the invalid
  // JSON. Resolve a live route once so an operator save between attempts does
  // not silently hand the repair to another model.
  const bound = await bindTextModelCall(textModel, generateOptions.purpose);

  let schemaRepair = false;
  // A reply cut off by its output budget is the same reply, not a wrong one:
  // it is asked for once more at a wider budget, outside the repair count. A
  // develop-book-plan schema repair ran out of 16k tokens and failed a paid
  // book (development-fixes-3a-retry, 2026-09-05).
  const budget = generateOptions.textAttemptBudget!;
  for (let attempt = 0; ; attempt += 1) {
    assertTextAttemptAvailable(nextOptions);
    try {
      return await bound.adapter.generateJson(withPhysicalAttemptMetadata(
        nextOptions,
        annotatePhysicalAttempt,
        attempt + 1,
        repairAttempts + 1,
        schemaRepair
      ));
    } catch (error) {
      if (!budget.outputWidened && nextOptions.maxTokens !== undefined && isOutputBudgetExhausted(error)) {
        const maxTokens = widenedOutputBudget(error, nextOptions.maxTokens);
        if (maxTokens === undefined) throw error;
        budget.outputWidened = true;
        attempt -= 1;
        nextOptions = { ...nextOptions, maxTokens };
        continue;
      }
      if (attempt >= repairAttempts || !isRepairableJsonError(error)) {
        throw error;
      }
      schemaRepair = isSchemaValidationError(error);
      // Rebuild repair instructions without stacking them, but keep any budget
      // increase earned by an earlier truncated attempt.
      nextOptions = repairOptions({
        ...generateOptions,
        ...(nextOptions.maxTokens === undefined ? {} : { maxTokens: nextOptions.maxTokens })
      }, error);
    }
  }
}

/** Prompt packers call this before measuring bytes; generation must not grow their packed request afterward. */
export function jsonSchemaMessages<T>(messages: ChatMessage[], schema: ZodType<T>): ChatMessage[] {
  return prependSystemRules(messages, [...STRICT_JSON_RETRY_RULES,
    `Required JSON schema: ${JSON.stringify(schemaToJson(schema))}`]);
}

/** The provider said the reply stopped at `max_output_tokens` (the Responses API counts reasoning against it), rather than returning a broken one. */
export function isOutputBudgetExhausted(error: unknown): boolean {
  return error instanceof Error && /max_output_tokens|output budget/i.test(error.message) && !isSchemaValidationError(error);
}

function withPhysicalAttemptMetadata<T>(
  options: GenerateJsonOptions<T>,
  annotatePhysicalAttempt: GenerateJsonWithRetryOptions<T>["annotatePhysicalAttempt"],
  attempt: number,
  maxAttempts: number,
  schemaRepair: boolean
): GenerateJsonOptions<T> {
  if (!annotatePhysicalAttempt) {
    return options;
  }
  const nextMeta = annotatePhysicalAttempt(options.providerCallMetadata, {
    index: attempt,
    maxAttempts,
    schemaRepair
  });
  return {
    ...options,
    ...(nextMeta ? { providerCallMetadata: nextMeta } : {})
  };
}

function repairOptions<T>(options: GenerateJsonOptions<T>, error: unknown): GenerateJsonOptions<T> {
  if (error instanceof JsonOutputRepetitionError) return {
    ...options,
    messages: prependSystemRules(options.messages, [...STRICT_JSON_RETRY_RULES,
      "The previous output repeated property names without values and was stopped. Start a fresh compact JSON object matching the supplied schema. Emit each property once per object with its colon and value; omit fields absent from the contract. Do not continue the broken output."]),
    temperature: Math.min(options.temperature ?? 0.7, 0.2)
  };
  if (isSchemaValidationError(error)) {
    return {
      ...options,
      messages: withSchemaRepairRules(options.messages, error),
      temperature: Math.min(options.temperature ?? 0.7, 0.2)
    };
  }
  return {
    ...options,
    messages: prependSystemRules(options.messages, STRICT_JSON_RETRY_RULES),
    temperature: Math.min(options.temperature ?? 0.7, 0.35)
  };
}

function withSchemaRepairRules(messages: ChatMessage[], error: unknown): ChatMessage[] {
  return prependSystemRules(messages, [
    ...SCHEMA_REPAIR_RULES,
    `Validation issues: ${validationDetails(error)}`
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
  return (
    error instanceof AdapterJsonValidationError
    || (error instanceof Error && error.name.endsWith("JsonValidationError"))
  );
}

function validationDetails(error: unknown): string {
  if (error instanceof AdapterJsonValidationError) {
    return error.context.validationMessage.slice(0, 4000);
  }
  if (error instanceof z.ZodError) {
    return error.message.slice(0, 4000);
  }
  return error instanceof Error ? error.message.slice(0, 4000) : "Unknown validation error.";
}

function schemaToJson<T>(schema: ZodType<T>): unknown {
  try {
    const { $schema: _dialect, ...contract } = z.toJSONSchema(schema as never, { unrepresentable: "any" });
    return contract;
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
