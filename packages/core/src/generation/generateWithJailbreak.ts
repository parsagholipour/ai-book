import type { ChatMessage, GenerateJsonOptions, JsonResult, TextModelAdapter } from "../adapters/types.js";
import {
  plannerPolicyLines,
  reviewerPolicyLines,
  writerPolicyLines
} from "../prompting/contentPolicy.js";
import {
  type JailbreakLevel,
  type JailbreakRole,
  isModelRefusal,
  jailbreakSystemPrefix,
  jailbreakUserSuffix
} from "../prompting/jailbreak.js";

export type GenerateJsonWithJailbreakOptions<T> = GenerateJsonOptions<T> & {
  lessCensored: boolean;
  jailbreakRole: JailbreakRole;
};

type AttemptConfig = {
  level: JailbreakLevel;
  tempBoost: number;
  userSuffix: boolean;
  strictJson?: boolean;
};

const ATTEMPTS: AttemptConfig[] = [
  { level: 1, tempBoost: 0, userSuffix: false },
  { level: 1, tempBoost: -0.2, userSuffix: false, strictJson: true },
  { level: 2, tempBoost: 0.1, userSuffix: false, strictJson: true },
  { level: 2, tempBoost: 0.2, userSuffix: true, strictJson: true }
];

function policyLinesForRole(role: JailbreakRole): string[] {
  switch (role) {
    case "planner":
      return plannerPolicyLines(true);
    case "reviewer":
      return reviewerPolicyLines(true);
    default:
      return writerPolicyLines(true);
  }
}

function injectPolicyAndJailbreak(
  messages: ChatMessage[],
  role: JailbreakRole,
  level: JailbreakLevel,
  userSuffix: boolean,
  strictJson = false
): ChatMessage[] {
  const policy = policyLinesForRole(role);
  const jailbreak = jailbreakSystemPrefix(level, role);
  const jsonRules = strictJson
    ? [
        "Return one complete syntactically valid JSON object only.",
        "Every array element and object property must be separated by a comma.",
        "Do not include Markdown fences or prose outside JSON."
      ]
    : [];
  const prefix = [...jailbreak, ...policy, ...jsonRules];

  const next = messages.map((message) => ({ ...message }));
  if (prefix.length > 0) {
    const systemIndex = next.findIndex((message) => message.role === "system");
    if (systemIndex >= 0) {
      next[systemIndex] = {
        role: "system",
        content: [...prefix, next[systemIndex]!.content].join(" ")
      };
    } else {
      next.unshift({ role: "system", content: prefix.join(" ") });
    }
  }

  const suffix = userSuffix ? jailbreakUserSuffix(level) : undefined;
  if (suffix) {
    const userIndex = [...next].reverse().findIndex((message) => message.role === "user");
    if (userIndex >= 0) {
      const actualIndex = next.length - 1 - userIndex;
      next[actualIndex] = {
        role: "user",
        content: `${next[actualIndex]!.content}\n\n${suffix}`
      };
    }
  }

  return next;
}

export async function generateJsonWithJailbreak<T>(
  textModel: TextModelAdapter,
  options: GenerateJsonWithJailbreakOptions<T>
): Promise<JsonResult<T>> {
  if (!options.lessCensored) {
    try {
      return await textModel.generateJson(options);
    } catch (error) {
      if (!isRecoverableJsonSyntaxError(error)) {
        throw error;
      }
      return textModel.generateJson({
        ...options,
        messages: injectPolicyAndJailbreak(options.messages, options.jailbreakRole, 0, false, true),
        temperature: Math.min(options.temperature ?? 0.7, 0.35)
      });
    }
  }

  const baseTemperature = options.temperature ?? 0.7;
  let lastResult: JsonResult<T> | undefined;
  let lastError: unknown;

  for (const attempt of ATTEMPTS) {
    const messages = injectPolicyAndJailbreak(
      options.messages,
      options.jailbreakRole,
      attempt.level,
      attempt.userSuffix,
      attempt.strictJson === true
    );
    const temperature = Math.max(0, Math.min(2, baseTemperature + attempt.tempBoost));
    let result: JsonResult<T>;
    try {
      result = await textModel.generateJson({
        ...options,
        messages,
        temperature
      });
    } catch (error) {
      if (!isRecoverableJsonSyntaxError(error)) {
        throw error;
      }
      lastError = error;
      continue;
    }
    lastResult = result;
    if (!isModelRefusal(result.text)) {
      return result;
    }
  }

  if (lastResult) {
    return lastResult;
  }
  throw lastError instanceof Error ? lastError : new Error("JSON generation failed.");
}

function isRecoverableJsonSyntaxError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message;
  return (
    error instanceof SyntaxError ||
    error.name === "DeepSeekJsonParseError" ||
    /(?:Model did not return a JSON object|invalid JSON|Expected .* in JSON|Unexpected token|Unterminated string)/i.test(
      message
    )
  );
}
