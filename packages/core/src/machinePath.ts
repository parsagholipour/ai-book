/**
 * Makes an ASCII machine identifier safe to use as one path segment.
 *
 * This is not a human-facing naming policy: unsafe characters become `_`, the
 * result is capped at 120 characters, and an empty result falls back to
 * `"unknown"`.
 */
export function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}
