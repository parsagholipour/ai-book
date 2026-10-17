/** The few `expect` matchers these tests use, on node:assert (scripts/eval has no vitest). */
import assert from "node:assert/strict";

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((entry, index) => matches(actual[index], entry));
  if (expected && typeof expected === "object") {
    return Boolean(actual) && typeof actual === "object" && Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, expected);
}

export function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toContain: (expected: string) => assert.ok(String(actual).includes(expected), `expected to contain ${expected}`),
    toMatch: (expected: RegExp) => assert.match(String(actual), expected),
    toHaveLength: (expected: number) => assert.equal((actual as { length: number }).length, expected),
    toMatchObject: (expected: unknown) => assert.ok(matches(actual, expected), `expected ${JSON.stringify(actual)} to match ${JSON.stringify(expected)}`),
    toBeUndefined: () => assert.equal(actual, undefined),
    not: { toContain: (expected: string) => assert.ok(!String(actual).includes(expected), `expected not to contain ${expected}`) },
    rejects: { toBe: (expected: unknown) => assert.rejects(actual as Promise<unknown>, (error: unknown) => error === expected) }
  };
}
