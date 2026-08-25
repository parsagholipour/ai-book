/**
 * Trims strings, drops empty values, and preserves the first occurrence of
 * each case-sensitive value.
 */
export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Inclusive integer range, e.g. `range(2, 5)` is `[2, 3, 4, 5]`. */
export function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
