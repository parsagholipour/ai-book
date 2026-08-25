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

export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  // A replacer is handed `toJSON()`'s output, never the object that owns it, so
  // a Buffer arrives already expanded into `{ type: "Buffer", data: [ …every
  // byte… ] }` — the megabyte of digits this compaction exists to keep out of a
  // run log. The Buffer itself is still on the holder, which is `this`, so that
  // is what the check has to read; a plain function is what makes `this` bound.
  return JSON.stringify(value, function (this: unknown, key: string, item: unknown) {
    const original =
      this && typeof this === "object" ? (this as Record<string, unknown>)[key] : undefined;
    if (Buffer.isBuffer(original)) {
      return { type: "Buffer", bytes: original.byteLength };
    }
    if (typeof item === "bigint") {
      return item.toString();
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

/** Narrows a Prisma JSON column to a plain object, defaulting to `{}`. */
export { jsonPayloadToRecord } from "@book-maker/core";
