import { configDefaults, defineConfig } from "vitest/config";

/**
 * Nearly every test in this workspace boots a Fastify app through
 * `buildMobileApp()`, and the first test in each file pays for that plus the
 * module graph behind it. Vitest's 5s default leaves no headroom: on a loaded
 * machine the suite starts failing the *first* test of arbitrary files with
 * timeouts, which looks like a real bug and is not one.
 *
 * The timeout is a backstop against a hang, not a performance budget — raising
 * it costs nothing when tests pass and still fails fast enough to be useful.
 *
 * The opt-in integration suites (`*.integration.test.ts`) are kept out of
 * *collection* unless `CHAT_HISTORY_INTEGRATION=1`, rather than merely skipped
 * inside. `describe.skipIf(!enabled)` skips the test bodies, but the file's
 * own imports still run, and that suite imports `prisma` from `@book-maker/db`
 * — which builds a client over the default `localhost:55432` URL the moment
 * the module is evaluated. A file vitest never loads cannot do that.
 *
 * Without the variable, naming one of those files on the command line reports
 * "No test files found" — that is this exclusion, not a mistyped path.
 */
export default defineConfig({
  test: {
    setupFiles: ["./src/testing/setupObjectStorage.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.CHAT_HISTORY_INTEGRATION === "1" ? [] : ["**/*.integration.test.ts"])
    ]
  }
});
