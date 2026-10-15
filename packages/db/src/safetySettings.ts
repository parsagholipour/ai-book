import type { Prisma } from "./generated/prisma/client.ts";

/**
 * The operator's safety settings, as every screen reads them.
 *
 * `SafetySettingsRevision` is append-only: the console writes a new version on
 * every save, and the current settings are the highest version. No revision at
 * all means the defaults, which leave copyright restrictions off and the
 * sexual-content filter ON.
 *
 * The API's request screens and the worker's legacy import restore both ask
 * this, so it is one function rather than two queries that could drift. It
 * takes the client as an argument with Prisma imported for types alone, so a
 * suite that mocks `@book-maker/db` wholesale still runs the real read against
 * its own stand-in client (the `./searchGroundingAllowance` pattern,
 * packages/db/CLAUDE.md).
 */

type SafetySettingsReader = Pick<Prisma.TransactionClient, "safetySettingsRevision">;

/** Whether the current safety settings turn copyright restrictions on. A failed read throws. */
export async function readCopyrightRestrictionsEnabled(client: SafetySettingsReader): Promise<boolean> {
  const current = await client.safetySettingsRevision.findFirst({
    orderBy: { version: "desc" },
    select: { copyrightRestrictionsEnabled: true }
  });
  return current?.copyrightRestrictionsEnabled === true;
}

/**
 * Whether the sexual-content filter is on. **Default ON, the opposite of the
 * copyright flag**: no revision at all is on, and a revision is off only when it
 * says `false` — a row that predates the column, or a value that will not read,
 * is on. A failed read throws; {@link createSexualContentFilterFlag} is what
 * turns a failure into "on".
 */
export async function readSexualContentFilterEnabled(client: SafetySettingsReader): Promise<boolean> {
  const current = await client.safetySettingsRevision.findFirst({
    orderBy: { version: "desc" },
    select: { sexualContentFilterEnabled: true }
  });
  return current?.sexualContentFilterEnabled !== false;
}

/** How long a process trusts the switch it last read: a console save reaches every process within this. */
export const SEXUAL_CONTENT_FILTER_CACHE_MS = 60_000;

export type SexualContentFilterFlag = {
  /** The switch, from the cache when it is fresh; never rejects, and a failed read answers `true`. */
  enabled(): Promise<boolean>;
  /** Drops the cached answer, so the next read goes to the database (a console save in this process). */
  forget(): void;
};

/**
 * The cached, single-flight, fail-closed read every text call and every
 * request screen asks. It runs on the hot path of every provider call, so a
 * process reads the table at most once a minute however many calls it makes,
 * and concurrent callers share the one read in flight.
 *
 * **A read that fails answers ON** — the safety rule fails closed — and that
 * answer is cached like any other, so a database outage does not turn every
 * provider call into a failing query. `client` is a getter, and a getter that
 * returns `null` is a suite's stand-in with no safety table at all: that reads
 * as OFF and is never cached, the way the copyright flag has always treated a
 * stand-in, because no production client lacks the delegate.
 */
export function createSexualContentFilterFlag(
  client: () => SafetySettingsReader | null,
  options: {
    ttlMs?: number;
    now?: () => number;
    onReadError?: (error: unknown) => void;
  } = {}
): SexualContentFilterFlag {
  const ttlMs = options.ttlMs ?? SEXUAL_CONTENT_FILTER_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { value: boolean; at: number } | null = null;
  let pending: Promise<boolean> | null = null;
  let generation = 0;
  return {
    async enabled() {
      const reader = client();
      if (!reader) {
        return false;
      }
      if (cached && now() - cached.at < ttlMs) {
        return cached.value;
      }
      if (pending) {
        return pending;
      }
      const startedIn = generation;
      const read = readSexualContentFilterEnabled(reader).catch((error: unknown) => {
        options.onReadError?.(error);
        return true;
      });
      pending = read;
      try {
        const value = await read;
        if (startedIn === generation) {
          cached = { value, at: now() };
        }
        return value;
      } finally {
        if (pending === read) {
          pending = null;
        }
      }
    },
    forget() {
      generation += 1;
      cached = null;
      pending = null;
    }
  };
}
