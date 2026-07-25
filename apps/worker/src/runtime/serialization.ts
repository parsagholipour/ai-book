import { Prisma } from "@book-maker/db";

/**
 * Pure formatting and normalization helpers shared across worker modules.
 * Nothing here touches the database, the queue, or provider adapters, so it is
 * safe to import from any layer without creating a cycle.
 */

export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: error };
  }
  const extra = Object.fromEntries(Object.entries(error as Error & Record<string, unknown>));
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...extra
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") {
      return item.toString();
    }
    if (Buffer.isBuffer(item)) {
      return { type: "Buffer", bytes: item.byteLength };
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) {
        return "[Circular]";
      }
      seen.add(item);
    }
    return item;
  });
}

export function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

export function jsonInputValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(safeJsonStringify(value)) as Prisma.InputJsonValue;
}

export function cleanTargetLanguage(language: string | null | undefined): string | null {
  const trimmed = language?.trim();
  return trimmed ? trimmed.slice(0, 40) : null;
}

export function cleanOptionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Inclusive integer range, e.g. `range(2, 5)` is `[2, 3, 4, 5]`. */
export function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

/** Narrows a Prisma JSON column to a plain object, defaulting to `{}`. */
export function jsonPayloadToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}
