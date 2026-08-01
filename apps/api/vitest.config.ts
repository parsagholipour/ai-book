import { defineConfig } from "vitest/config";

/**
 * Nearly every test in this workspace boots a Fastify app through
 * `buildMobileApp()`, and the first test in each file pays for that plus the
 * module graph behind it. Vitest's 5s default leaves no headroom: on a loaded
 * machine the suite starts failing the *first* test of arbitrary files with
 * timeouts, which looks like a real bug and is not one.
 *
 * The timeout is a backstop against a hang, not a performance budget — raising
 * it costs nothing when tests pass and still fails fast enough to be useful.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
