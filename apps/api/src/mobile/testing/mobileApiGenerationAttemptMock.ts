/**
 * What one `enqueueGenerationJob` call said about the row it was asking for.
 * Only the two fields the claim is decided on; everything else on those options
 * belongs to the job, not to who owns it.
 */
type EnqueueOptions = { dedupeKey?: string | undefined; attemptId?: string | undefined };

/** The `enqueueGenerationJob` spy, read for its call history rather than driven. */
type EnqueueSpy = {
  mock: {
    calls: unknown[][];
    settledResults: Array<{ type: "fulfilled" | "rejected"; value: unknown } | undefined>;
  };
};

/**
 * Which attempt the row behind `primaryJobId` was stamped with, read off the
 * enqueue that wrote it.
 *
 * There is no job table here to read a column out of, and there must not be one
 * the fake alone maintains: two dozen suites pin this spy's answer with their
 * own `mockResolvedValue(jobRecord(...))`, so anything derived from what the
 * *implementation* returned would report "no such row" for most of the mobile
 * surface. The call is recorded whatever a suite makes the spy answer, and the
 * call is where `attemptId` is.
 *
 * A row is created once and thereafter *found*: `enqueueGenerationJob` returns
 * whatever already stands under a `dedupeKey` without writing anything. So the
 * stamp is the one the **first** call under that key carried, which is what
 * makes a spent key read as somebody else's work here for the same reason it
 * does in the database. A call with no `dedupeKey` can only have created its
 * own row, so it answers for itself.
 */
function enqueuedJobStamp(
  enqueue: EnqueueSpy,
  primaryJobId: string
): { enqueued: false } | { enqueued: true; attemptId: string | null } {
  const optionsAt = (index: number): EnqueueOptions => (enqueue.mock.calls[index]?.[0] ?? {}) as EnqueueOptions;
  const produced = enqueue.mock.calls.flatMap((_call, index) => {
    const settled = enqueue.mock.settledResults[index];
    if (!settled || settled.type !== "fulfilled") return [];
    return (settled.value as { id?: unknown } | null)?.id === primaryJobId ? [index] : [];
  });
  // The callback has just returned, so its own enqueue is the last one to have
  // answered with this id.
  const named = produced.at(-1);
  if (named === undefined) return { enqueued: false };
  const dedupeKey = optionsAt(named).dedupeKey;
  const wrote = dedupeKey ? produced.find((index) => optionsAt(index).dedupeKey === dedupeKey) ?? named : named;
  return { enqueued: true, attemptId: optionsAt(wrote).attemptId ?? null };
}

/**
 * Every job this attempt enqueued under a `dedupeKey` some earlier attempt had
 * already spent.
 *
 * `assertPrimaryJobBelongsToAttempt` below can only ever see the *one* job a
 * callback names as `primaryJobId`, which is why the real refusal moved to
 * `enqueueGenerationJob` (`apps/api/src/queue.ts`) as well: the confirmed
 * generation retry enqueues one job per failed job and keeps the first, so
 * every job after it was neither stamped nor verified. That spy is a bare
 * `vi.fn()` here, so the precondition is modelled over its call history the way
 * `enqueuedJobStamp` models the row: the first call under a key wrote the row,
 * every later one found it.
 */
function foreignClaimedEnqueues(
  enqueue: EnqueueSpy,
  attemptId: string
): Array<{ dedupeKey: string; ownerAttemptId: string | null }> {
  const firstUnderKey = new Map<string, string | null>();
  const foreign: Array<{ dedupeKey: string; ownerAttemptId: string | null }> = [];
  for (const call of enqueue.mock.calls) {
    const options = (call[0] ?? {}) as EnqueueOptions;
    const dedupeKey = options.dedupeKey;
    if (!dedupeKey) {
      continue;
    }
    if (!firstUnderKey.has(dedupeKey)) {
      firstUnderKey.set(dedupeKey, options.attemptId ?? null);
      continue;
    }
    const ownerAttemptId = firstUnderKey.get(dedupeKey) ?? null;
    if (options.attemptId === attemptId && ownerAttemptId !== attemptId) {
      foreign.push({ dedupeKey, ownerAttemptId });
    }
  }
  return foreign;
}

/**
 * The one thing this fake is faithful about: a paid attempt may only be
 * parented onto the job its own `create` callback wrote.
 *
 * `startGenerationAttempt` re-reads that row and refuses anything else —
 * `assertPrimaryJobBelongsToAttempt` in `packages/db/src/generationAttempts.ts`
 * — because `enqueueGenerationJob` hands back whatever already stands under a
 * spent `dedupeKey`, and the writes after the callback would otherwise
 * re-parent the attempt and its committed spend onto work nothing will ever
 * settle. `attemptId` is optional at the enqueue, so a caller that stops
 * passing it compiles exactly as before; the stamp is the only evidence there
 * is, which is why a missing one is refused rather than tolerated.
 *
 * Without this the fake returned a synthetic attempt whatever `create` came
 * back with, and `packages/db/src/generationAttempts.test.ts` — against the
 * real function — was the only suite in the repo that could tell the
 * difference. Nine callers reach this, all of them through mobile routes these
 * suites cover.
 */
function assertPrimaryJobBelongsToAttempt(
  enqueue: EnqueueSpy,
  claimError: new (message: string) => Error,
  primaryJobId: string,
  attemptId: string
): void {
  for (const foreign of foreignClaimedEnqueues(enqueue, attemptId)) {
    throw new claimError(
      `Generation attempt ${attemptId} may not claim the generation job standing under dedupe key ` +
        `${foreign.dedupeKey}: it is ${
          foreign.ownerAttemptId ? `already attempt ${foreign.ownerAttemptId}'s work` : "not stamped with any attempt"
        }. A paid start must enqueue its own job, never adopt one it found under a spent key.`
    );
  }
  const stamp = enqueuedJobStamp(enqueue, primaryJobId);
  if (!stamp.enqueued) {
    throw new claimError(
      `Generation attempt ${attemptId} named generation job ${primaryJobId}, which no enqueue answered with. ` +
        "A create() callback must enqueue its own job; a queue mock answering an id no enqueueGenerationJob call " +
        "returned leaves this check nothing to read."
    );
  }
  if (stamp.attemptId !== attemptId) {
    throw new claimError(
      `Generation attempt ${attemptId} may not claim generation job ${primaryJobId}: it is ${
        stamp.attemptId ? `already attempt ${stamp.attemptId}'s work` : "not stamped with any attempt"
      }. A create() callback must enqueue its own job with this attemptId, never return one it found under a ` +
        "spent dedupeKey."
    );
  }
}

/**
 * The unique indexes a paid start collides on: `commandKey`, and — for a retry
 * — `retryOfAttemptId`, which `schema.prisma` declares `@unique` so a failed
 * attempt can only ever have one paid child.
 *
 * `state.generationAttempts` models both of them for rows that have already
 * *committed*, and that is the easy half. The half this exists for is the start
 * still in flight: in Postgres the second `INSERT` under one of these keys
 * blocks on the index until the first transaction ends, and then raises 23505 —
 * `startGenerationAttempt`'s `isUniqueConflict` arm, which answers with
 * `findWinningAttempt` over `commandKey OR retryOfAttemptId` rather than with
 * the loser's own work. So the loser's `create` callback never runs, and there
 * is no second reservation and no second enqueue.
 *
 * A fake that only checks committed rows has no such barrier: two overlapping
 * confirmations of one retry both find nothing, both reserve, and the second
 * enqueue under a `dedupeKey` the first already spent trips
 * `foreignClaimedEnqueues` — a 500 `GENERATION_JOB_NOT_CLAIMED` and a double
 * charge, neither of which the database can produce. That is a false positive a
 * route suite cannot tell from a real one, so the slots are claimed here
 * synchronously, before the first `await`, for exactly as long as the start
 * behind them is running.
 */
function uniqueSlots(start: { commandKey: string; retryOfAttemptId?: string | null }): string[] {
  return [
    `command:${start.commandKey}`,
    ...(start.retryOfAttemptId ? [`retry-of:${start.retryOfAttemptId}`] : [])
  ];
}

/** Installs the attempt-aware billing fake shared by the mobile route suites. */
export function installGenerationAttemptMock(options: {
  mockBilling: any;
  mockPrisma: any;
  mockQueue: { enqueueGenerationJob: any };
  state: { generationAttempts: any[]; bookEditOperations: any[] };
}): void {
  const { mockBilling, mockPrisma, mockQueue, state } = options;
  /** Slot → the start already holding it, one entry per in-flight unique key. */
  const inFlight = new Map<string, Promise<any>>();

  /** The attempt an already-committed row answers this start with, if any. */
  const committedReplay = (start: any): { replayed: true; attempt: any } | null => {
    const existing = state.generationAttempts.find((attempt) => attempt.commandKey === start.commandKey);
    if (existing) {
      if (
        existing.userId !== start.userId ||
        existing.requestFingerprint !== start.requestFingerprint ||
        existing.operation !== start.operation ||
        existing.quotedCredits !== start.quotedCredits
      ) {
        throw new mockBilling.GenerationAttemptConflictError();
      }
      return { replayed: true, attempt: existing };
    }
    if (start.retryOfAttemptId) {
      const retryChild = state.generationAttempts.find(
        (attempt) => attempt.retryOfAttemptId === start.retryOfAttemptId
      );
      if (retryChild) return { replayed: true, attempt: retryChild };
    }
    return null;
  };

  const runStart = async (start: any) => {
    const attemptId = `attempt-${String(start.commandKey).replaceAll(":", "-")}`;
    let quotaClaim = null;
    if (start.imageQuotaLimit !== null && start.imageQuotaLimit !== undefined) {
      quotaClaim = await mockBilling.consumeIllustratedBookUse({
        userId: start.userId,
        limit: start.imageQuotaLimit
      });
      if (!quotaClaim.allowed) throw new mockBilling.GenerationQuotaExceededError(quotaClaim);
    }
    const reservation = await mockBilling.reserveCredits({
      userId: start.userId,
      projectId: start.projectId,
      operation: start.operation,
      amountCredits: start.quotedCredits,
      idempotencyKey: `generation-attempt:${attemptId}`,
      description: start.description,
      metadata: {
        ...start.metadata,
        ...(quotaClaim ? { imageQuota: { periodKey: quotaClaim.periodKey } } : {})
      }
    });
    const ledgerEntry = reservation ? await mockBilling.commitReservedCredits(reservation.id) : null;
    const domain = await start.create(mockPrisma, { attemptId, ledgerEntry });
    // Where the real function takes it: after the callback, before the charge
    // is parented onto anything. There the refusal is free because the whole
    // transaction rolls back with it — nothing here rolls back, so a suite
    // that raises this is looking at a wiring fault to fix rather than at a
    // settlement to assert over. The enqueue-side half is folded in here for
    // the same reason: `enqueueGenerationJob` is a spy in these suites, so
    // there is nowhere earlier for it to raise. Its own refusal is measured
    // against the real function in `apps/api/src/queue.test.ts`.
    assertPrimaryJobBelongsToAttempt(
      mockQueue.enqueueGenerationJob,
      mockBilling.GenerationAttemptJobClaimError,
      domain.primaryJobId,
      attemptId
    );
    if (start.grantExportEntitlement) {
      await mockBilling.grantProjectEntitlement({
        userId: start.userId,
        projectId: domain.projectId,
        type: "EXPORT_UNLOCK",
        source: "full_generation_credits",
        creditsCost: start.quotedCredits,
        relatedLedgerEntryId: ledgerEntry?.id ?? null
      });
    }
    const attempt = {
      id: attemptId,
      userId: start.userId,
      commandKey: start.commandKey,
      requestFingerprint: start.requestFingerprint,
      status: "QUEUED",
      operation: start.operation,
      quotedCredits: start.quotedCredits,
      projectId: domain.projectId,
      editOperationId: domain.editOperationId ?? null,
      ledgerEntryId: ledgerEntry?.id ?? null,
      primaryJobId: domain.primaryJobId,
      retryOfAttemptId: start.retryOfAttemptId ?? null,
      error: null,
      refundPending: false,
      createdAt: new Date()
    };
    state.generationAttempts.push(attempt);
    if (domain.editOperationId) {
      const editOperation = state.bookEditOperations.find((operation) => operation.id === domain.editOperationId);
      if (editOperation) {
        editOperation.generationAttempts = [attempt, ...(editOperation.generationAttempts ?? [])];
      }
    }
    return { replayed: false, attempt };
  };

  /**
   * One start, holding its unique slots for as long as it runs.
   *
   * A start that finds a slot taken waits on its holder and replays the attempt
   * that holder committed — the `findWinningAttempt` answer, reached without
   * reserving anything or calling `create`. A holder that *rejects* rolled back,
   * which frees the index the same way an aborted transaction does, so the
   * waiter takes its own turn instead of inheriting a failure that never
   * happened to it. `release` is registered on the claim before any waiter is,
   * so the slot is already gone by the time that retry runs.
   */
  const begin = (start: any): Promise<{ replayed: boolean; attempt: any }> => {
    const replay = committedReplay(start);
    if (replay) {
      return Promise.resolve(replay);
    }
    const slots = uniqueSlots(start);
    const holder = slots.reduce<Promise<any> | undefined>((found, slot) => found ?? inFlight.get(slot), undefined);
    if (holder) {
      return holder.then(
        (attempt) => ({ replayed: true, attempt }),
        () => begin(start)
      );
    }
    const running = runStart(start);
    const claimed = running.then((result) => result.attempt);
    for (const slot of slots) {
      inFlight.set(slot, claimed);
    }
    const release = () => {
      for (const slot of slots) {
        if (inFlight.get(slot) === claimed) {
          inFlight.delete(slot);
        }
      }
    };
    claimed.then(release, release);
    return running;
  };

  // Not `async`: the slot claim above has to land before the caller's first
  // await, the way the database's does before the transaction reaches anything
  // else.
  mockBilling.startGenerationAttempt.mockImplementation((start: any) => {
    try {
      return begin(start);
    } catch (error) {
      return Promise.reject(error);
    }
  });
}
