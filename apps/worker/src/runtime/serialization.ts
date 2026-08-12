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

/**
 * Makes one path segment safe to write. Every caller passes something that is
 * already ASCII by construction — a cuid, a job name, a conversation id — so
 * the `_` substitution is a guard and the `"unknown"` fallback is a last resort
 * for a value that was empty to begin with.
 *
 * It is emphatically **not** a naming scheme for human text: a Persian, Cyrillic
 * or CJK name survives neither step, and everything that reaches here from one
 * ends up as the same `"unknown"`. `characterSlug` in
 * `generation/characterReferences.ts` learned that the expensive way — a whole
 * book's cast writing to one file — and now hashes such a name before it gets
 * here rather than letting this decide.
 */
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
export { jsonPayloadToRecord } from "@book-maker/core";
