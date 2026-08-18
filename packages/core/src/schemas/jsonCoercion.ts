import { z } from "zod";

/**
 * Defensive JSON-coercion toolkit shared by the schema clusters in this
 * directory. Model output arrives wrapped, renamed, and half-typed; these
 * helpers read it charitably before the strict schemas judge it.
 *
 * `isRecord` and `jsonRecord` are the exception to "internal to schemas/":
 * every workspace reads Prisma `Json` columns and provider payloads through
 * that one predicate, so the package index re-exports the two of them. Keep
 * the rest of this file unexported — and if the coercion is ever hardened
 * (rejecting class instances, say), this is the only place it has to change.
 */

export function unwrapJsonObject(keys: string[]) {
  return (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        return candidate;
      }
    }
    return value;
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Nested `mediaSettings.mobile` object, or `{}` when absent or non-object. */
export function mediaSettingsMobileRecord(mediaSettings: unknown): Record<string, unknown> {
  return jsonRecord(jsonRecord(mediaSettings).mobile);
}

export function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

export function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

export function arrayField(record: Record<string, unknown>, keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

export function recordField(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

export function stringArrayField(record: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  return undefined;
}

export function coerceStringArray(value: unknown): unknown {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return value;
}

export function booleanField(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);
