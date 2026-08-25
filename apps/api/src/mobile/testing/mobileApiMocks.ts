import { vi } from "vitest";

/**
 * Module mocks for the mobile API suites.
 *
 * This file must import nothing but `vitest`. Vitest calls the factories below
 * from inside `vi.mock(...)`, and reaching any module that transitively imports
 * a mocked module from there deadlocks the mock registry.
 *
 * **A default a suite has to ask for is not a default, and it is the shape of
 * the declaration that decides which one it is.** `vi.resetAllMocks()` restores
 * the implementation a mock was *constructed* with and drops everything
 * configured onto it afterwards, so `vi.fn().mockResolvedValue([])` beside a
 * declaration is a baseline that lives until the first `beforeEach` and no
 * longer. Every default here is therefore passed *into* `vi.fn(...)`, which is
 * what makes a suite that never heard of `resetCharacterMocks` get an
 * uncontended database with nothing in it, rather than a `TypeError` raised
 * from inside production code — `claimed.length`, `for (const row of rows)`,
 * `image.id`. The statements Prisma's client shape forces through a single mock
 * each — `$transaction`, `$queryRaw`, `$executeRaw` — are where that matters
 * most: nothing about a suite says it is going to open a transaction, take a
 * row lock or rewrite a sibling's description, so the suite that never mentions
 * them is exactly the one that runs into them.
 */

/** A read that finds nothing — an empty fixture, which is a state the database has too. */
async function noRows(..._args: any[]): Promise<any[]> {
  return [];
}

/** The same, for a read of a single row. */
async function noRow(..._args: any[]): Promise<any> {
  return null;
}

/** A write settling on a row count, at the number each fixture below used to answer. */
function rowsAffected(count: number) {
  return async (..._args: any[]): Promise<any> => ({ count });
}

/**
 * A raw write, answering the row count the statement it was handed would have
 * moved.
 *
 * `$executeRaw` hands back a *number* rather than rows, and the one statement
 * in this surface that goes through it — the mention set update in
 * `libraryMentionRewrites.ts` — reads that number back and refuses a short one.
 * So `0` is not a neutral default here, for the same reason `[]` is not one for
 * the batch claim below: it is the answer "none of the rows I am holding still
 * exist", which would settle every rename and every delete of a mentioned
 * character as a conflict, in every suite that has never heard of this file.
 *
 * The count is read off the statement's first bound array — the ids — which is
 * the same knowledge of one statement's shape `rawRowLockingStatement` takes,
 * and it is worth the same trade: a suite that is *about* a short count says so
 * outright, and a suite that merely renames a character says nothing at all.
 */
async function rawWriteStatement(_strings: readonly string[], ...values: unknown[]): Promise<number> {
  const bound = values.find((value): value is unknown[] => Array.isArray(value));
  return bound?.length ?? 0;
}

/**
 * Interactive and batch transactions, against this same mock client.
 *
 * Plumbing rather than fixture — it is how the client behaves, not what any row
 * holds — so it lives with the client instead of in the harness that builds the
 * rows. It used to be installed by `resetMobileHarness`, which meant every
 * route in this surface was reachable only through that one file: a suite
 * driving a service function directly got `undefined` back from the transaction
 * and a dereference of it somewhere inside the handler.
 *
 * **It cannot roll anything back, so it accounts instead.** The callback writes
 * through to these same mocks, so a `create` issued a statement before a throw
 * is still in the call list afterwards — which is how every suite here would
 * pass a route that committed the row and only then screened the prose it
 * stores. The three refusals the character writes raise from *inside* their
 * transactions — a content screen, a `LibraryMentionError`, a
 * `CharacterRowMovedError` — are each safe only because the writes above them
 * unwind, and nothing here could see the difference. So each interactive
 * transaction gets a record of what it was handed, what it wrote and whether it
 * threw, and `survivingWrites()` reads those records back as the statements a
 * database would still be holding. That is the assertion a regression fails.
 */
async function runMockTransaction(...args: any[]): Promise<unknown> {
  const [operationOrOperations, options] = args;
  if (Array.isArray(operationOrOperations)) {
    // A batch's operations were issued against the client before the array
    // reached `$transaction`, so nothing here can attribute them to it. The
    // boundary below is the interactive form's, which is the form every
    // character write takes.
    return Promise.all(operationOrOperations);
  }
  const record = openTransactionRecord(options);
  try {
    return await (operationOrOperations as (tx: typeof mockPrisma) => Promise<unknown>)(
      transactionClient(record)
    );
  } catch (error) {
    record.rolledBack = true;
    record.error = error;
    throw error;
  }
}

/** The model methods that leave a row behind — everything a rollback takes away again. */
const WRITE_OPERATIONS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);

/**
 * The client methods that leave a row behind without going near a model
 * delegate.
 *
 * `WRITE_OPERATIONS` is a set of *model* methods, and the proxy that reads it
 * only ever sees model delegates — so the one write in the character lanes
 * Prisma's model API cannot express, the mention set update, was invisible to
 * this whole accounting: a client method, returned unwrapped by the proxy, on a
 * mock `survivingWrites()` never looked at. A rewrite moved out of its
 * transaction — issued against the imported `prisma` rather than the `tx` it
 * was handed — failed no rollback assertion in this directory, which is the one
 * escape a mock with no store can still catch.
 *
 * Only the *writing* raw statement belongs here. `$queryRaw` carries this
 * lane's two row-locking reads (`lockMentionTarget`, `claimCharacterRows`), and
 * a lock is not a write: counting those would report every rename as leaving
 * two statements behind it. A new raw write is added here and given a mock
 * below; a new raw read is not.
 */
const RAW_WRITE_STATEMENTS = new Set(["$executeRaw"]);

/** Every raw statement mock, for the readers that want them as one call list. */
const RAW_STATEMENT_METHODS = ["$queryRaw", "$executeRaw"] as const;

/** What a raw statement is attributed to, having no model delegate of its own. */
const RAW_WRITE_CLIENT = "prisma";

/** One write, as the statement it was and where it sits in that mock's own call list. */
type RecordedWrite = { model: string; operation: string; index: number };

/** What one interactive `$transaction` was handed, what it wrote, and how it settled. */
export type MockTransactionRecord = {
  /**
   * The caller's second argument — `{ timeout, maxWait }`, or nothing.
   * `$transaction.mock.calls` carries it too, which is where the retry-window
   * suites read it; it is here because a boundary that reported its writes and
   * dropped the window it ran them under would be half a record.
   */
  options: Record<string, unknown> | undefined;
  /** Every write issued through the `tx` client this transaction handed out. */
  writes: RecordedWrite[];
  /** The callback threw, so a database would have kept none of `writes`. */
  rolledBack: boolean;
  /** What it threw, so a suite can say which refusal unwound the transaction. */
  error: unknown;
};

/**
 * Every interactive transaction this client has opened since the last reset.
 *
 * **It is cleared outright, because nothing about a reset can be inferred from
 * here.** Every entry points into a mock's `mock.calls` by index, and
 * `vi.resetAllMocks()` empties those lists knowing nothing about this one — so
 * a record left behind subtracts the *next* test's writes, at the same indexes,
 * from what that test is told survived. This used to detect that by comparing
 * its own length against `$transaction.mock.calls.length`, which counts
 * something else: `runMockTransaction` returns early for the batch form, after
 * vitest has already counted the call, so a call is counted whether or not a
 * record is pushed. One rolled-back transaction, a reset, then two
 * `$transaction([...])` batches and one interactive transaction was enough —
 * three calls against one stale record, so the guard read "not reset yet", and
 * the new test's *committed* `libraryCharacter.create#0` was reported as rolled
 * back. That passes an `expect(survivingWrites()).toEqual([])` over a write
 * that survived, which is the one assertion this log exists to make.
 *
 * So it is `resetCharacterMocks` that clears it, and `resetMobileHarness` calls
 * that from every `beforeEach` in this directory. It is the one piece of state
 * here a suite has to ask for rather than a default it gets for free — the
 * distinction the top of this file draws — and it can be, because the only
 * thing a stale log can do to a suite that never reads it is take up room.
 */
const transactionLog: MockTransactionRecord[] = [];

/** A record for the transaction now opening. */
function openTransactionRecord(options: unknown): MockTransactionRecord {
  const record: MockTransactionRecord = {
    options: options && typeof options === "object" ? (options as Record<string, unknown>) : undefined,
    writes: [],
    rolledBack: false,
    error: undefined
  };
  transactionLog.push(record);
  return record;
}

/**
 * The client the callback is handed: these same mocks, with every write issued
 * through it attributed to `record`.
 *
 * Attribution is by *client* rather than by wall clock, which is what keeps the
 * accounting honest in the one direction that matters. A callback reaching for
 * the imported `prisma` instead of the `tx` it was given has written outside
 * the transaction, so nothing lands on this record — and `survivingWrites()`
 * reports that write as surviving, because in a database it does. That escape
 * is the one this file cannot simulate and can still catch.
 *
 * **Two kinds of write reach it, and they arrive at different depths.** A model
 * write is a method on a delegate, so it is wrapped one proxy down; a raw write
 * is a method on the client itself, so it is wrapped here. Both land on the
 * same `record.writes` under the same `model.operation#index` name, which is
 * what lets one rollback assertion speak about both.
 */
function transactionClient(record: MockTransactionRecord): typeof mockPrisma {
  const delegates = new Map<string, unknown>();
  // Read before the call, because that is the index it is about to take.
  const attribute = (model: string, operation: string, method: { mock?: { calls: unknown[] } }) => {
    record.writes.push({ model, operation, index: method.mock?.calls.length ?? 0 });
  };
  return new Proxy(mockPrisma, {
    get(client, property) {
      const value = Reflect.get(client, property);
      if (typeof property !== "string") {
        return value;
      }
      const cached = delegates.get(property);
      if (cached) {
        return cached;
      }
      if (typeof value === "function" && RAW_WRITE_STATEMENTS.has(property)) {
        const statement = (...args: unknown[]) => {
          attribute(RAW_WRITE_CLIENT, property, value as { mock?: { calls: unknown[] } });
          return (value as (...args: unknown[]) => unknown)(...args);
        };
        delegates.set(property, statement);
        return statement;
      }
      if (typeof value !== "object" || value === null) {
        return value;
      }
      const delegate = new Proxy(value as Record<string, any>, {
        get(model, key) {
          const method = Reflect.get(model, key);
          if (typeof key !== "string" || typeof method !== "function" || !WRITE_OPERATIONS.has(key)) {
            return method;
          }
          return (...args: unknown[]) => {
            attribute(property, key, method);
            return method(...args);
          };
        }
      });
      delegates.set(property, delegate);
      return delegate;
    }
  });
}

/** Every interactive transaction this client has opened, oldest first. */
export function mockTransactions(): MockTransactionRecord[] {
  return [...transactionLog];
}

/**
 * The writes a database would still be holding: everything issued, minus
 * everything issued by a transaction that threw.
 *
 * Named `model.operation` and in invocation order across models, because what a
 * rollback claim is about is *which statements* outlived the throw. A suite
 * that wants the arguments reads them off the mock itself, where they always
 * were.
 *
 * The raw write is `prisma.$executeRaw` here — the client rather than a model,
 * which is what it is. It is counted in the same list and sorted into the same
 * order, because "the mention rewrite outlived the transaction that claimed the
 * rows it rewrote" is the same claim as "the create outlived the screen", and
 * no suite should have to know which mock carried which.
 */
export function survivingWrites(): string[] {
  const rolledBack = new Set<string>();
  for (const record of transactionLog) {
    if (!record.rolledBack) {
      continue;
    }
    for (const write of record.writes) {
      rolledBack.add(`${write.model}.${write.operation}#${write.index}`);
    }
  }
  const survivors: Array<{ name: string; order: number }> = [];
  for (const [model, delegate] of Object.entries(mockPrisma)) {
    if (typeof delegate !== "object" || delegate === null) {
      continue;
    }
    for (const [operation, method] of Object.entries(delegate as Record<string, any>)) {
      if (!WRITE_OPERATIONS.has(operation) || typeof method?.mock !== "object") {
        continue;
      }
      method.mock.calls.forEach((_call: unknown, index: number) => {
        if (rolledBack.has(`${model}.${operation}#${index}`)) {
          return;
        }
        survivors.push({
          name: `${model}.${operation}`,
          order: method.mock.invocationCallOrder?.[index] ?? index
        });
      });
    }
  }
  for (const statement of RAW_WRITE_STATEMENTS) {
    const method = (mockPrisma as Record<string, any>)[statement];
    if (typeof method?.mock !== "object") {
      continue;
    }
    method.mock.calls.forEach((_call: unknown, index: number) => {
      if (rolledBack.has(`${RAW_WRITE_CLIENT}.${statement}#${index}`)) {
        return;
      }
      survivors.push({
        name: `${RAW_WRITE_CLIENT}.${statement}`,
        order: method.mock.invocationCallOrder?.[index] ?? index
      });
    });
  }
  return survivors.sort((left, right) => left.order - right.order).map((survivor) => survivor.name);
}

/**
 * The two raw row-locking statements the character writes take, neither of
 * which Prisma's model API can express — so both come through `$queryRaw`, both
 * land on this one mock, and the SQL is the only thing that tells them apart.
 * They want opposite answers:
 *
 * - the **target lock** is a single-row `FOR UPDATE` whose result nothing reads
 *   — the lock *is* the statement — so `[]` is a complete answer;
 * - the **batch claim** reads the returned row count as its whole verdict, and
 *   a short count is `CharacterRowMovedError`. `[]` there is not the absence of
 *   an answer, it is the answer "every row moved": it would settle every
 *   character write in every suite as a 409, which is a wrong result wearing an
 *   assertion failure's clothes rather than a missing fixture. So the default
 *   is "nothing moved": one row back per tuple the predicate named.
 *
 * Reading the count off the claim's first bound array is the double knowing the
 * statement's shape, which is a coupling worth naming — but the alternative is
 * every suite that so much as renames a character restating a claim it does not
 * care about. A suite that *is* about the claim overrides this outright, and
 * the short-count tests do (`characterClaimReturns`).
 */
async function rawRowLockingStatement(strings: readonly string[], ...values: unknown[]): Promise<any[]> {
  if (!(strings ?? []).join("?").includes("FOR NO KEY UPDATE")) {
    return [];
  }
  const ids = values[0];
  return Array.from({ length: Array.isArray(ids) ? ids.length : 0 }, (_, index) => ({ id: `claimed-${index}` }));
}

/**
 * One retained character picture, as the row the write just made.
 *
 * Every character write records one, so the useful default is "the row was
 * written and there is no history yet" rather than `undefined` — which 500s
 * every upload in every suite that so much as touches a character, from a
 * dereference of the row inside `recordCharacterImage`.
 */
async function retainedCharacterImage({ data }: { data: Record<string, unknown> }): Promise<any> {
  return {
    id: "character-image-1",
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    byteSize: null,
    width: null,
    height: null,
    photoKind: null,
    referenceEligible: false,
    ...data
  };
}

/** The row a `delete` of one retained picture hands back; nothing reads it. */
async function deletedCharacterImage(..._args: any[]): Promise<any> {
  return { id: "character-image-1" };
}

export const mockPrisma = ({
  $transaction: vi.fn(runMockTransaction),
  $queryRaw: vi.fn(rawRowLockingStatement),
  $executeRaw: vi.fn(rawWriteStatement),
  user: { upsert: vi.fn() },
  mobileSession: { findUnique: vi.fn() },
  mobileCreationDraft: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  mobileCreationOutput: { create: vi.fn(), findFirst: vi.fn() },
  template: { findFirst: vi.fn(), findMany: vi.fn() },
  productCatalog: { findUnique: vi.fn() },
  project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  page: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
  pageEditSnapshot: { create: vi.fn() },
  planVersion: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  projectChatMessage: { create: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  bookEditOperation: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn()
  },
  generationJob: { count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  generationAttempt: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  },
  creditLedgerEntry: { findMany: vi.fn(), update: vi.fn() },
  subscriptionState: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  providerCallLog: { aggregate: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  imageAsset: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  voiceCharacter: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  voiceCall: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  voiceCallEvent: { create: vi.fn() },
  voiceConversation: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  audiobook: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn()
  },
  audiobookChapter: { findMany: vi.fn(), upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  libraryCharacter: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn()
  },
  libraryMention: {
    findMany: vi.fn(noRows),
    createMany: vi.fn(rowsAffected(0)),
    deleteMany: vi.fn(rowsAffected(0))
  },
  libraryCharacterImage: {
    findFirst: vi.fn(noRow),
    findMany: vi.fn(noRows),
    create: vi.fn(retainedCharacterImage),
    delete: vi.fn(deletedCharacterImage),
    deleteMany: vi.fn(rowsAffected(1))
  }
});

/**
 * The two raw defaults, put back mid-file.
 *
 * The implementations are `rawRowLockingStatement` and `rawWriteStatement`,
 * installed at their declarations and restored by every `vi.resetAllMocks()`;
 * this is for a test that overrode one of them — `characterClaimReturns`, or a
 * `$executeRaw` taught to fail or to come back short — and wants the default
 * back without resetting everything else it has built.
 */
function resetRawStatementMocks(): void {
  mockPrisma.$queryRaw.mockImplementation(rawRowLockingStatement);
  mockPrisma.$executeRaw.mockImplementation(rawWriteStatement);
}

/**
 * The raw statements taken so far whose SQL carries `clause`, oldest first.
 *
 * `lockMentionTarget` takes `FOR UPDATE` on one target row and
 * `claimCharacterRows` takes `FOR NO KEY UPDATE` over the sources, so the
 * locking clause is what tells them apart in a shared call list — and
 * `FOR NO KEY UPDATE` does not contain `FOR UPDATE`, which is what makes a
 * substring test enough to separate them.
 *
 * **Both raw call lists, merged in invocation order.** The set update moved to
 * `$executeRaw` — it is a write, and `$queryRaw` is specified for statements
 * that return rows — while the lock and the claim stay reads on `$queryRaw`, so
 * "the raw statements" is now spread over two mocks. The SQL is still what
 * tells one from another, which is the property every caller here was already
 * relying on; which client method carried it is a separate question, and the
 * suite that asks it (`libraryMentionRewrites.test.ts`) names the mock outright
 * rather than coming through here.
 */
export function rawStatementsMatching(clause: string): unknown[][] {
  const issued: Array<{ call: unknown[]; order: number }> = [];
  for (const name of RAW_STATEMENT_METHODS) {
    const method = mockPrisma[name];
    (method.mock.calls as unknown[][]).forEach((call, index) => {
      if (!(call[0] as readonly string[]).join("?").includes(clause)) {
        return;
      }
      issued.push({ call, order: method.mock.invocationCallOrder?.[index] ?? index });
    });
  }
  return issued.sort((left, right) => left.order - right.order).map((entry) => entry.call);
}

/** The `(id, userId, name)` tuples the first claim named, read back off its three bound arrays. */
export function claimedCharacterRows(): Array<{ id: string; userId: string; name: string }> {
  const [, ...values] = (rawStatementsMatching("FOR NO KEY UPDATE")[0] ?? []) as [readonly string[], ...string[][]];
  const [ids = [], userIds = [], names = []] = values;
  return ids.map((id, index) => ({ id, userId: userIds[index] ?? "", name: names[index] ?? "" }));
}

/** A claim that comes back holding `rows` of the sources it named — short is a row that moved. */
export function characterClaimReturns(rows: number): void {
  mockPrisma.$queryRaw.mockImplementation(async (strings: readonly string[]) =>
    strings.join("?").includes("FOR NO KEY UPDATE")
      ? Array.from({ length: rows }, (_, index) => ({ id: `claimed-${index}` }))
      : []
  );
}

/**
 * The retained-picture and mention-link defaults, put back mid-file.
 *
 * Same job as `resetRawStatementMocks`, and the same implementations the
 * declarations above carry — stated once there and referenced here, because two
 * spellings of one default is how the fixture and the reset come to disagree
 * about what an untouched character looks like.
 */
function resetCharacterImageMocks(): void {
  mockPrisma.libraryCharacterImage.create.mockImplementation(retainedCharacterImage);
  mockPrisma.libraryCharacterImage.findMany.mockImplementation(noRows);
  mockPrisma.libraryCharacterImage.findFirst.mockImplementation(noRow);
  mockPrisma.libraryCharacterImage.deleteMany.mockImplementation(rowsAffected(1));
  mockPrisma.libraryCharacterImage.delete.mockImplementation(deletedCharacterImage);
  mockPrisma.libraryMention.findMany.mockImplementation(noRows);
  mockPrisma.libraryMention.createMany.mockImplementation(rowsAffected(0));
  mockPrisma.libraryMention.deleteMany.mockImplementation(rowsAffected(0));
}

export const mockBilling = (() => {
  class MockInsufficientCreditsError extends Error {
    readonly code = "INSUFFICIENT_CREDITS";
    readonly requiredCredits: number;
    readonly availableCredits: number;
    readonly reservedCredits: number;

    constructor(options: { requiredCredits: number; availableCredits: number; reservedCredits: number }) {
      super("Insufficient credits");
      this.requiredCredits = options.requiredCredits;
      this.availableCredits = options.availableCredits;
      this.reservedCredits = options.reservedCredits;
    }
  }

  class MockGenerationAttemptConflictError extends Error {
    readonly code = "GENERATION_COMMAND_CONFLICT";
  }

  class MockGenerationQuotaExceededError extends Error {
    readonly code = "IMAGE_LIMIT_REACHED";
    readonly claim: unknown;

    constructor(claim: unknown) {
      super("Image limit reached");
      this.claim = claim;
    }
  }

  return {
    InsufficientCreditsError: MockInsufficientCreditsError,
    GenerationAttemptConflictError: MockGenerationAttemptConflictError,
    GenerationQuotaExceededError: MockGenerationQuotaExceededError,
    ensureDefaultProductCatalog: vi.fn(),
    getCreditBalance: vi.fn(),
    listActiveUserEntitlements: vi.fn(),
    reserveCredits: vi.fn(),
    commitReservedCredits: vi.fn(),
    spendCredits: vi.fn(),
    refundCreditLedgerEntry: vi.fn(),
    releaseReservationsByKeyPrefix: vi.fn(async () => 0),
    grantProjectEntitlement: vi.fn(),
    hasActiveProjectEntitlement: vi.fn(),
    ensureProjectExportEntitlementOrSpend: vi.fn(),
    recordVerifiedGooglePlayPurchase: vi.fn(),
    endSubscriptionNow: vi.fn(async () => ({ ended: true, endedSubscriptionIds: ["sub-1"] })),
    hasActiveSubscriptionEntitlement: vi.fn(async () => false),
    ensureCurrentPlanPeriod: vi.fn(),
    resolvePlanTier: vi.fn(async () => "free"),
    getPlanSummary: vi.fn(async () => ({
      tier: "free",
      source: "free",
      status: null,
      renewsAt: null,
      cancelAtPeriodEnd: false,
      endsAt: null,
      productSku: null
    })),
    // Null is "no limit on this plan". Suites that want the free tier's limit
    // override this with a quota object.
    getImageQuota: vi.fn(async () => null),
    consumeIllustratedBookUse: vi.fn(async (_options?: unknown) => ({
      allowed: true,
      used: 1,
      limit: 3,
      periodKey: "2026-06",
      resetsAt: new Date("2026-07-01T00:00:00.000Z")
    })),
    releaseIllustratedBookUse: vi.fn(),
    startGenerationAttempt: vi.fn(),
    getGenerationAttempt: vi.fn(),
    markGenerationAttemptActive: vi.fn(),
    markGenerationAttemptSucceeded: vi.fn(),
    failGenerationAttempt: vi.fn(),
    reconcileGenerationAttemptRefunds: vi.fn()
  };
})();

export class MockPrismaKnownRequestError extends Error {
  readonly code: string;
  /**
   * Prisma puts the specifics here rather than in the message — the column for
   * `P2000`, the constraint for `P2002` — and the character write ladder reads
   * it, so a test that only sets `code` cannot tell a rung apart from the one
   * below it.
   */
  readonly meta: Record<string, unknown> | undefined;

  constructor(message: string, options: { code: string; meta?: Record<string, unknown> }) {
    super(message);
    this.code = options.code;
    this.meta = options.meta;
  }
}

export function dbModuleMock() {
  return {
    ensureSeedTemplates: vi.fn(),
    PLAN_REVISION_AUTOMATIC_RETRY_LIMIT: 2,
    canClaimPlanRevisionRetry: vi.fn(() => ({ eligible: true, staleActive: false, reason: null })),
    planRevisionRetryDelayMs: vi.fn(() => 30_000),
    retryRequestKey: vi.fn((id: string, attempt: number) => `plan-revision-retry:${id}:${attempt}`),
    // `DbNull` is a sentinel the quality-verdict query passes through to
    // Prisma; the mocks only ever compare the `where` it lands in, so any
    // stable, distinguishable value stands in for it.
    Prisma: {
      JsonNull: null,
      DbNull: "DbNull",
      PrismaClientKnownRequestError: MockPrismaKnownRequestError
    },
    prisma: mockPrisma,
    // The real values, because undo passes them straight through to
    // `$transaction` and a suite asserting the ceiling would otherwise be
    // asserting the mock's own numbers.
    PAGE_RESTRUCTURE_TRANSACTION_OPTIONS: { timeout: 30_000, maxWait: 10_000 },
    revertStructuralPageChange: vi.fn(),
    casRebuildProjectStoryState: vi.fn(),
    rebuildStoryStateFromPages: vi.fn()
  };
}

export function billingModuleMock() {
  return mockBilling;
}

export const mockQueue = {
  dispatchGenerationJob: vi.fn(),
  enqueueGenerationJob: vi.fn(),
  enqueueOrRequeueGenerationJob: vi.fn(),
  isBullJobActive: vi.fn(),
  requeueGenerationJob: vi.fn(),
  stopProjectGenerationJobs: vi.fn(),
  closeQueue: vi.fn()
};

export function queueModuleMock() {
  return mockQueue;
}

export const mockProjectStatus = {
  buildProjectStatus: vi.fn(),
    normalizeProjectQuality: vi.fn(() => ({
      state: "pending",
      score: null,
      issues: [],
      affectedPageIndexes: []
    })),
    normalizeTokenUsage: vi.fn(() => ({
      promptTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      provisionalPromptTokens: 0,
      provisionalOutputTokens: 0,
      inFlightCalls: 0
  }))
};

export function projectStatusModuleMock() {
  return mockProjectStatus;
}

/** Resets every mock and rebuilds the default fixture. Call from `beforeEach`. */

/**
 * Every default the character surface has, put back in one call — the retained
 * pictures, the mention links, the two raw row-locking reads and the raw write
 * — plus the one thing here that is not a default at all.
 *
 * **Nothing has to call this to get the defaults.** They are installed at their
 * declarations, so `vi.resetAllMocks()` restores them and a suite that has
 * never heard of this function still renames a character correctly; that is
 * deliberate, because the alternative made forgetting it fail from inside
 * `characterWriteConflicts.ts` with a `TypeError` naming no fixture at all, and
 * through a route it failed as a bare 500 that no assertion could tell from a
 * real one. What is left for that half is a test that overrode a default and
 * wants it back without resetting everything else it has built.
 *
 * The transaction log is the exception, and it has to be: it is accumulated
 * state rather than an implementation, so there is nothing for
 * `vi.resetAllMocks()` to reinstall and no way for the log to notice it ran.
 * The suite that reads the log reaches this through `resetMobileHarness`.
 */
export function resetCharacterMocks(): void {
  resetRawStatementMocks();
  resetCharacterImageMocks();
  // Not a default and not a character fixture: the transaction log is the one
  // piece of state here that a reset has to *clear* rather than reinstall, and
  // this is the seam every `beforeEach` in this directory already reaches.
  transactionLog.length = 0;
}
