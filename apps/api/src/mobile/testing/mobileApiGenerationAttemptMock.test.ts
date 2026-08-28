import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./mobileApiMocks.js")).billingModuleMock());
vi.mock("../../queue.js", async () => (await import("./mobileApiMocks.js")).queueModuleMock());
vi.mock("../../projectStatus.js", async () => (await import("./mobileApiMocks.js")).projectStatusModuleMock());

import { GenerationAttemptJobClaimError, startGenerationAttempt } from "@book-maker/db/billing";

import { enqueueGenerationJob } from "../../queue.js";
import { resetMobileHarness, state, teardownMobileHarness } from "./mobileApiHarness.js";

/**
 * The fake every mobile route suite bills through, held to the one precondition
 * the real `startGenerationAttempt` cannot take its caller's word for.
 *
 * Measured before this guard existed: deleting the `attemptId` argument from
 * `editOperations.ts`'s `enqueueGenerationJob` call left all 79 mobile suites
 * and the workspace typecheck green, because `attemptId` is optional at the
 * enqueue and the fake returned a synthetic attempt whatever `create` came back
 * with. The real function would have thrown `GenerationAttemptJobClaimError`
 * for every one of them, and `packages/db/src/generationAttempts.test.ts` was
 * the only suite in the repo that could see it.
 */
describe("the shared generation-attempt fake", () => {
  beforeEach(resetMobileHarness);
  afterEach(teardownMobileHarness);

  /** What every caller does: enqueue this attempt's own job, stamped or not. */
  function startWith(options: {
    commandKey: string;
    dedupeKey: string;
    stamp: boolean;
  }): Promise<unknown> {
    return startGenerationAttempt({
      userId: "user-a",
      commandKey: options.commandKey,
      requestFingerprint: "fingerprint-1",
      operation: "BOOK_TEXT_EDIT",
      quotedCredits: 0,
      projectId: "project-1",
      description: "Mobile text edit",
      create: async (_tx, { attemptId }) => {
        const job = await enqueueGenerationJob({
          projectId: "project-1",
          type: "APPLY_BOOK_EDIT",
          dedupeKey: options.dedupeKey,
          dispatch: false,
          ...(options.stamp ? { attemptId } : {}),
          payload: {}
        });
        return { projectId: "project-1", primaryJobId: job.id };
      }
    });
  }

  async function refusalFrom(started: Promise<unknown>): Promise<Error & { code?: string }> {
    const failure = await started.then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(GenerationAttemptJobClaimError);
    expect((failure as { code?: string }).code).toBe("GENERATION_JOB_NOT_CLAIMED");
    return failure as Error & { code?: string };
  }

  it("refuses a job the callback enqueued without this attempt's stamp", async () => {
    const failure = await refusalFrom(
      startWith({ commandKey: "mobile:edit-command:project-1:unstamped", dedupeKey: "apply-book-edit:1", stamp: false })
    );

    expect(failure.message).toMatch(/not stamped with any attempt/);
    // Refused where the real one refuses it: before the charge is parented onto
    // anything, so no attempt row stands behind the fault.
    expect(state.generationAttempts).toHaveLength(0);
  });

  it("refuses a job another attempt already enqueued under the same dedupe key", async () => {
    const spentKey = "generate-book:project-1:plan-1";
    await startWith({ commandKey: "mobile:edit-command:project-1:first", dedupeKey: spentKey, stamp: true });

    // `enqueueGenerationJob` answers a spent key with the row already standing
    // under it, which carries the first attempt's stamp and not this one's.
    const failure = await refusalFrom(
      startWith({ commandKey: "mobile:edit-command:project-1:second", dedupeKey: spentKey, stamp: true })
    );

    expect(failure.message).toMatch(/already attempt attempt-mobile-edit-command-project-1-first's work/);
    expect(state.generationAttempts).toHaveLength(1);
  });

  it("refuses a primary job no enqueue ever answered with", async () => {
    const failure = await refusalFrom(
      startGenerationAttempt({
        userId: "user-a",
        commandKey: "mobile:edit-command:project-1:invented",
        requestFingerprint: "fingerprint-1",
        operation: "BOOK_TEXT_EDIT",
        quotedCredits: 0,
        projectId: "project-1",
        description: "Mobile text edit",
        create: async () => ({ projectId: "project-1", primaryJobId: "job-nobody-enqueued" })
      })
    );

    expect(failure.message).toMatch(/no enqueue answered with/);
    expect(state.generationAttempts).toHaveLength(0);
  });

  /**
   * The other precondition, and the one that decides whether the guard above is
   * even reachable from the confirmed retry lane.
   *
   * `GenerationAttempt.retryOfAttemptId` is `@unique`, so two differently keyed
   * confirmations of one failed attempt collide on an *index*: the loser's
   * `INSERT` blocks and raises 23505 at `tx.generationAttempt.create`, before
   * the `create` callback, and `findWinningAttempt` answers it with the winner's
   * attempt. A fake that only consulted committed rows had no such barrier — two
   * overlapping taps of Retry both reserved, and the loser's enqueue under a
   * `dedupeKey` the winner had just spent raised the refusal above: a 500 and a
   * double charge the database cannot produce.
   */
  it("blocks a second retry start on the unique slot the first already holds", async () => {
    const create = vi.fn(async (_tx: unknown, { attemptId }: { attemptId: string }) => {
      const job = await enqueueGenerationJob({
        projectId: "project-1",
        type: "GENERATE_PAGE",
        // Deterministic: it names the source attempt and the failed job, not
        // the request, so both confirmations derive the same key.
        dedupeKey: "generation-retry:attempt-source:job-failed-page",
        dispatch: false,
        attemptId,
        payload: {}
      });
      return { projectId: "project-1", primaryJobId: job.id };
    });
    const confirm = (requestId: string) =>
      startGenerationAttempt({
        userId: "user-a",
        commandKey: `mobile:generation-retry:attempt-source:${requestId}`,
        requestFingerprint: "retry-fingerprint",
        operation: "FULL_BOOK_GENERATION",
        quotedCredits: 776,
        projectId: "project-1",
        retryOfAttemptId: "attempt-source",
        description: "Confirmed mobile generation retry",
        create
      });

    const [first, second] = await Promise.all([confirm("request-1"), confirm("request-2")]);

    expect(second.attempt.id).toBe(first.attempt.id);
    expect(second.replayed).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(state.generationAttempts).toHaveLength(1);
  });

  it("lets two ordinary starts through, though the queue fake names both jobs job-1", async () => {
    // Distinct keys are distinct rows however the fake names them, so the guard
    // may not read one start's job as the other's — which is what every mobile
    // suite that queues more than one paid job depends on.
    await startWith({ commandKey: "mobile:edit-command:project-1:a", dedupeKey: "apply-book-edit:a", stamp: true });
    await startWith({ commandKey: "mobile:edit-command:project-1:b", dedupeKey: "apply-book-edit:b", stamp: true });

    expect(state.generationAttempts.map((attempt) => attempt.primaryJobId)).toEqual(["job-1", "job-1"]);
  });
});
