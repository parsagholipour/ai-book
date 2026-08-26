import { configDefaults, defineConfig } from "vitest/config";

/**
 * Live provider suites are opt-in and kept out of collection unless explicitly
 * enabled. This prevents ordinary core tests from importing provider setup or
 * spending tokens, even when a live file is named directly on the CLI.
 */
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.LIVE_AI === "true" ? [] : ["**/*.live.test.ts"])
    ]
  }
});
