import type { GenerateJsonOptions, Usage } from "./types.js";

export type ProviderUsageError = Error & {
  provider?: string;
  model?: string;
  usage?: Usage;
};

export function throwWithProviderUsage(
  error: unknown,
  details: { provider: string; model: string; usage?: Usage | undefined }
): never {
  if (error instanceof Error) {
    const enriched = error as ProviderUsageError;
    enriched.provider = details.provider;
    enriched.model = details.model;
    if (details.usage) {
      enriched.usage = details.usage;
    }
    throw enriched;
  }
  throw error;
}

export class AdapterJsonValidationError extends Error {
  constructor(
    providerLabel: string,
    purpose: string | undefined,
    rootKeys: string[],
    validationMessage: string,
    rawText: string,
    parsedObject: unknown,
    validationIssues?: unknown[]
  ) {
    super(
      `${providerLabel} JSON validation failed${purpose ? ` for ${purpose}` : ""}. Root keys: ${rootKeys.join(", ") || "(none)"}. ${validationMessage}`
    );
    this.name = `${providerLabel}JsonValidationError`;
    this.context = {
      rootKeys,
      validationMessage,
      rawText,
      parsedObject,
      ...(purpose ? { purpose } : {}),
      ...(validationIssues ? { validationIssues } : {})
    };
  }

  readonly context: {
    purpose?: string;
    rootKeys: string[];
    validationMessage: string;
    rawText: string;
    parsedObject: unknown;
    validationIssues?: unknown[];
  };
}

export class AdapterJsonParseError extends Error {
  constructor(
    providerLabel: string,
    parseMessage: string,
    rawTextLength: number,
    rawTextPreview: string,
    candidatePreview: string
  ) {
    super(`Model returned invalid JSON. ${parseMessage}`);
    this.name = `${providerLabel}JsonParseError`;
    this.context = {
      parseMessage,
      rawTextLength,
      rawTextPreview,
      candidatePreview
    };
  }

  readonly context: {
    parseMessage: string;
    rawTextLength: number;
    rawTextPreview: string;
    candidatePreview: string;
  };
}

export function parseJsonObject(text: string, providerLabel = "Model"): unknown {
  const candidates = jsonObjectCandidates(text);
  let lastError: unknown;
  let lastCandidate = "";

  for (const candidate of candidates) {
    for (const attempt of uniqueAttempts(candidate, repairCommonJson(candidate))) {
      try {
        return JSON.parse(attempt);
      } catch (error) {
        lastError = error;
        lastCandidate = attempt;
      }
    }
  }

  if (candidates.length === 0) {
    throw new AdapterJsonParseError(providerLabel, "Model did not return a JSON object.", text.length, text.slice(0, 2000), "");
  }

  const parseMessage = lastError instanceof Error ? lastError.message : "Unknown JSON parse error.";
  throw new AdapterJsonParseError(providerLabel, parseMessage, text.length, text.slice(0, 2000), lastCandidate.slice(0, 2000));
}

export function parseSchemaWithContext<T>(
  providerLabel: string,
  schema: GenerateJsonOptions<T>["schema"],
  value: unknown,
  purpose: string | undefined,
  rawText: string
): T {
  try {
    return schema.parse(value);
  } catch (error) {
    const rootKeys =
      value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : [];
    const message = error instanceof Error ? error.message : "Unknown schema validation error.";
    throw new AdapterJsonValidationError(
      providerLabel,
      purpose,
      rootKeys,
      message,
      rawText,
      value,
      validationIssuesFrom(error)
    );
  }
}

export function validationIssuesFrom(error: unknown): unknown[] | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const issues: unknown[] = [];
  const direct = (error as { issues?: unknown }).issues;
  if (Array.isArray(direct)) {
    issues.push(...direct);
  }
  const nested = (error as { context?: { validationIssues?: unknown } }).context?.validationIssues;
  if (Array.isArray(nested)) {
    issues.push(...nested);
  }
  return issues.length > 0 ? issues : undefined;
}

function jsonObjectCandidates(text: string): string[] {
  const trimmed = stripJsonFence(text.trim());
  const balanced = extractBalancedJsonObject(trimmed);
  const match = trimmed.match(/\{[\s\S]*\}/);
  return uniqueAttempts(trimmed, balanced, match?.[0]).filter((candidate) => candidate.trim().startsWith("{"));
}

function stripJsonFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence?.[1] ?? text;
}

function extractBalancedJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) {
        return undefined;
      }
      stack.pop();
      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function repairCommonJson(text: string): string {
  return insertMissingArrayCommas(quoteUnquotedPropertyNames(removeTrailingCommas(text)));
}

function removeTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      output += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      output += char;
      inString = !inString;
      continue;
    }
    if (!inString && char === ",") {
      const next = nextNonWhitespace(text, index + 1);
      if (next === "}" || next === "]") {
        continue;
      }
    }
    output += char;
  }
  return output;
}

function insertMissingArrayCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  const stack: Array<"object" | "array"> = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    output += char;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      stack.push("object");
      continue;
    }
    if (char === "[") {
      stack.push("array");
      continue;
    }
    if (char !== "}" && char !== "]") {
      continue;
    }

    const expected = char === "}" ? "object" : "array";
    if (stack.at(-1) === expected) {
      stack.pop();
    }
    if (stack.at(-1) !== "array") {
      continue;
    }

    const next = nextNonWhitespace(text, index + 1);
    if (next === "{" || next === "[") {
      output += ",";
    }
  }

  return output;
}

function quoteUnquotedPropertyNames(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  const stack: Array<"object" | "array"> = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      output += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      output += char;
      inString = !inString;
      continue;
    }
    if (inString) {
      output += char;
      continue;
    }

    if (
      stack.at(-1) === "object" &&
      isIdentifierStart(char) &&
      isObjectPropertyNameStart(text, index)
    ) {
      const end = readIdentifierEnd(text, index + 1);
      if (nextNonWhitespace(text, end) === ":") {
        output += `"${text.slice(index, end)}"`;
        index = end - 1;
        continue;
      }
    }

    output += char;
    if (char === "{") {
      stack.push("object");
      continue;
    }
    if (char === "[") {
      stack.push("array");
      continue;
    }
    if (char === "}" && stack.at(-1) === "object") {
      stack.pop();
      continue;
    }
    if (char === "]" && stack.at(-1) === "array") {
      stack.pop();
    }
  }

  return output;
}

function isObjectPropertyNameStart(text: string, start: number): boolean {
  for (let index = start - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      continue;
    }
    return char === "{" || char === ",";
  }
  return false;
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function readIdentifierEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[A-Za-z0-9_$-]/.test(text[index]!)) {
    index += 1;
  }
  return index;
}

function nextNonWhitespace(text: string, start: number): string | undefined {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return undefined;
}

function uniqueAttempts(...attempts: Array<string | undefined>): string[] {
  return [...new Set(attempts.filter((attempt): attempt is string => Boolean(attempt)))];
}
