import { configDefaults, defineConfig } from "vitest/config";

/**
 * The opt-in integration suites (`*.integration.test.ts`) are kept out of
 * *collection* unless `DB_INTEGRATION=true`, rather than merely skipped inside.
 *
 * `describe.skipIf(!enabled)` skips the test bodies, but the file's own imports
 * still run, and every one of these suites imports `prisma` from `src/client.ts`
 * — which builds a `PrismaPg` adapter and a `PrismaClient` over the default
 * `localhost:55432` URL the moment the module is evaluated. So an ordinary
 * `pnpm test`, a run that is supposed to need no database at all, was opening a
 * pg pool per suite and leaving vitest a handle to tear down. A file vitest
 * never loads cannot do that, and cannot quietly start doing it again when the
 * next opt-in suite is written by copying one of these — which is how the
 * second one arrived.
 *
 * Run them against the dev container from `make up` (or any DATABASE_URL):
 *
 *   DB_INTEGRATION=true pnpm -F @book-maker/db exec vitest run
 *
 * Without the variable, naming one of those files on the command line reports
 * "No test files found" — that is this exclusion, not a mistyped path.
 */
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.DB_INTEGRATION === "true" ? [] : ["**/*.integration.test.ts"])
    ]
  }
});
