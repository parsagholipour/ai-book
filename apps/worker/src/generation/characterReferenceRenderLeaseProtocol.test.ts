import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The claim/render/commit protocol itself, over stub passes.
 *
 * A different subject from `characterReferenceRenderLease.test.ts`, which drives
 * two real overlapping passes through `ensureCharacterReferenceAssets` to ask
 * which of their *answers* the plan keeps. What is asked here is which of the
 * pass's four hooks the lease calls, and when: whether it supersedes, whether it
 * commits, whether it discards what the render left on disk, and whether it lets
 * the lease go on every one of those ways out.
 */

const mocks = vi.hoisted(() => ({
  imageAsset: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  planVersion: { findUnique: vi.fn(), updateMany: vi.fn() },
  executeRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  executeRawUnsafe: vi.fn(),
  transaction: vi.fn(),
  assertJobNotStopped: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn()
}));

const tx = {
  imageAsset: mocks.imageAsset,
  planVersion: mocks.planVersion,
  $executeRaw: mocks.executeRaw,
  $queryRawUnsafe: mocks.queryRawUnsafe,
  $executeRawUnsafe: mocks.executeRawUnsafe
};

vi.mock("@book-maker/db", () => ({
  prisma: {
    imageAsset: mocks.imageAsset,
    planVersion: mocks.planVersion,
    $transaction: mocks.transaction,
    $executeRaw: mocks.executeRaw,
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $executeRawUnsafe: mocks.executeRawUnsafe
  },
  Prisma: { DbNull: "DbNull" }
}));
vi.mock("../runtime/config.js", () => ({
  config: { IMAGE_STORAGE_DIR: "/tmp/images", BOOK_STORAGE_DIR: "/tmp/books", PUBLIC_API_URL: "http://api.test" }
}));
vi.mock("../runtime/jobLifecycle.js", () => ({
  updateJobProgress: vi.fn(),
  assertJobNotStopped: mocks.assertJobNotStopped
}));
vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  appendFile: mocks.appendFile,
  rm: mocks.rm,
  stat: mocks.stat
}));

import { CHARACTER_REFERENCE_LEASE_MS, runCharacterReferenceRenderPass } from "./characterReferenceRenderLease.js";

describe("runCharacterReferenceRenderPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertJobNotStopped.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
    // The commit re-asks the claim's question — is the plan version still there
    // — so every pass that is meant to reach `commit` needs a row to find.
    mocks.planVersion.findUnique.mockResolvedValue({ id: "plan-1" });
    mocks.executeRaw.mockResolvedValue(1);
    mocks.queryRawUnsafe.mockResolvedValue([{ characterReferenceLeaseExpiresAt: new Date(Date.now() + 60_000) }]);
    mocks.executeRawUnsafe.mockResolvedValue(1);
  });

  const passOver = (reads: Array<{ answer: string; settled: boolean }>, supersedes: boolean) => ({
    projectId: "project-1",
    planId: "plan-1",
    read: vi.fn(async () => reads.shift() ?? { answer: "settled-answer", settled: true }),
    render: vi.fn(async () => "mine"),
    supersedes: vi.fn(() => supersedes),
    commit: vi.fn(async () => "committed"),
    discard: vi.fn(async () => undefined),
    // "do the rows name what I wrote" — false unless a test says the commit
    // landed, since only a throw ever asks.
    published: vi.fn(() => false)
  });

  it("asks nothing about superseding when the set it re-reads is still unsettled", async () => {
    const pass = passOver(
      [
        { answer: "nothing", settled: false },
        { answer: "nothing", settled: false }
      ],
      false
    );

    await expect(runCharacterReferenceRenderPass(pass)).resolves.toEqual({ answer: "committed", outcome: "rendered" });
    expect(pass.supersedes).not.toHaveBeenCalled();
  });

  it("hands the pass its own render and the answer it found, and stands down on a no", async () => {
    const pass = passOver([{ answer: "nothing", settled: false }], false);

    await expect(runCharacterReferenceRenderPass(pass)).resolves.toEqual({
      answer: "settled-answer",
      // Still this pass's own run: it rendered, re-read and stood down on the
      // domain rule, which is nothing like giving up on somebody else's render.
      outcome: "rendered"
    });
    expect(pass.supersedes).toHaveBeenCalledWith("mine", "settled-answer");
    expect(pass.commit).not.toHaveBeenCalled();
  });

  it("commits over the settled answer on a yes", async () => {
    const pass = passOver([{ answer: "nothing", settled: false }], true);

    await expect(runCharacterReferenceRenderPass(pass)).resolves.toEqual({ answer: "committed", outcome: "rendered" });
    expect(pass.commit).toHaveBeenCalled();
  });

  describe("what the render left on disk", () => {
    /**
     * `characterReferenceFileStems` stamps every stem with the pass's own render
     * id — it must, or two passes over one cast truncate each other's files
     * under a page render reading them — so a pass whose answer does not land
     * leaves a whole cast of files nothing names and nothing will ever unlink.
     * This module cannot name them, being generic over `Rendered`, which is why
     * the sweep is a hook it calls at exactly the three ways out that keep
     * somebody else's answer.
     */
    it("leaves a pass that committed its own answer alone", async () => {
      const pass = passOver([{ answer: "nothing", settled: false }], true);

      await expect(runCharacterReferenceRenderPass(pass)).resolves.toEqual({
        answer: "committed",
        outcome: "rendered"
      });
      expect(pass.discard).not.toHaveBeenCalled();
    });

    it("sweeps a pass that stood down against an answer it does not supersede", async () => {
      const pass = passOver([{ answer: "nothing", settled: false }], false);

      await runCharacterReferenceRenderPass(pass);

      expect(pass.commit).not.toHaveBeenCalled();
      expect(pass.discard).toHaveBeenCalledWith("mine");
    });

    it("sweeps a pass whose commit rolled back", async () => {
      const aborted = new Error("could not serialize access");
      const pass = passOver([{ answer: "nothing", settled: false }], true);
      pass.commit.mockRejectedValue(aborted);

      await expect(runCharacterReferenceRenderPass(pass)).rejects.toBe(aborted);
      // After the lease is released, never before: a sweep is file system work
      // and the lock every other image job of this book claims through is not
      // something to keep waiting on one.
      expect(mocks.executeRawUnsafe).toHaveBeenCalled();
      expect(pass.discard).toHaveBeenCalledWith("mine");
    });

    /**
     * **A throw is not a rollback**, and the sweep used to read it as one.
     *
     * `settlement` stays `undefined` for every way out of `prisma.$transaction`
     * that is not a return — a callback that raised, which did roll back, but
     * equally a `P1017`, a socket dropped between the server's COMMIT and the
     * client seeing the ack, and a `$transaction` timeout raised after the
     * callback had already returned. The last three committed. Sweeping on the
     * exception unlinked every sheet of a cast whose rows are on the table, and
     * a settled set is never re-rendered: the book then resolves reference paths
     * that ENOENT for the life of the plan version.
     */
    describe("a commit that threw", () => {
      const lostAck = Object.assign(new Error("Server has closed the connection."), { code: "P1017" });

      /** The callback returns and the COMMIT lands; only the ack is lost. */
      const throwAfterCommitting = (): void => {
        let transactions = 0;
        mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
          transactions += 1;
          const answer = await callback(tx);
          if (transactions === 1) {
            return answer;
          }
          throw lostAck;
        });
      };

      it("keeps the sheets of a commit whose rows landed under the throw", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pass = passOver([{ answer: "nothing", settled: false }], true);
        pass.published.mockReturnValue(true);
        throwAfterCommitting();

        await expect(runCharacterReferenceRenderPass(pass)).rejects.toBe(lostAck);

        expect(pass.commit).toHaveBeenCalled();
        // Staked on a re-read of the rows, not on the exception.
        expect(pass.published).toHaveBeenCalledWith("mine", "settled-answer");
        expect(pass.discard).not.toHaveBeenCalled();
        // And it is written down, because a leaked cast nobody sweeps is the
        // price of being safe here and an operator should be able to find it.
        const line = String(mocks.appendFile.mock.calls.at(-1)?.[1]);
        expect(JSON.parse(line)).toMatchObject({
          event: "character.reference.sweep_declined",
          reason: "commit_landed"
        });
        warn.mockRestore();
      });

      it("sweeps a commit that threw once the rows say nothing of it landed", async () => {
        // The genuine rollback, and the reason the guard cannot simply be
        // dropped: these files really are unreachable and nothing else will
        // ever unlink one.
        const pass = passOver([{ answer: "nothing", settled: false }], true);
        pass.published.mockReturnValue(false);
        throwAfterCommitting();

        await expect(runCharacterReferenceRenderPass(pass)).rejects.toBe(lostAck);

        expect(pass.published).toHaveBeenCalled();
        expect(pass.discard).toHaveBeenCalledWith("mine");
      });

      it("keeps the sheets when it cannot read whether the commit landed", async () => {
        // The outcome is genuinely unknown, so it leaks: an unlink cannot be
        // taken back and a leaked cast is bounded storage noise.
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pass = passOver([{ answer: "nothing", settled: false }], true);
        throwAfterCommitting();
        pass.read.mockImplementation(async () => {
          if (pass.commit.mock.calls.length > 0) {
            throw new Error("Timed out fetching a new connection from the connection pool");
          }
          return { answer: "nothing", settled: false };
        });

        await expect(runCharacterReferenceRenderPass(pass)).rejects.toBe(lostAck);

        expect(pass.published).not.toHaveBeenCalled();
        expect(pass.discard).not.toHaveBeenCalled();
        const line = String(mocks.appendFile.mock.calls.at(-1)?.[1]);
        expect(JSON.parse(line)).toMatchObject({ reason: "outcome_unreadable" });
        warn.mockRestore();
      });

      it("asks the rows nothing when the transaction returned", async () => {
        // A settlement that came back names its own outcome, so the stand-downs
        // and the committed case cost no extra read.
        const pass = passOver([{ answer: "nothing", settled: false }], false);

        await runCharacterReferenceRenderPass(pass);

        expect(pass.discard).toHaveBeenCalledWith("mine");
        expect(pass.published).not.toHaveBeenCalled();
      });
    });

    it("sweeps a pass whose plan version went away mid-render", async () => {
      // The claim's own check passes and the row goes away under the render, so
      // this is the expensive one: a whole cast drawn and paid for, with nothing
      // to commit it to.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pass = passOver([{ answer: "what-exists", settled: false }], true);
      mocks.planVersion.findUnique.mockImplementation(async () =>
        pass.render.mock.calls.length > 0 ? null : { id: "plan-1" }
      );

      await expect(runCharacterReferenceRenderPass(pass)).resolves.toMatchObject({
        outcome: "plan-version-gone"
      });
      expect(pass.render).toHaveBeenCalled();
      expect(pass.commit).not.toHaveBeenCalled();
      expect(pass.discard).toHaveBeenCalledWith("mine");
      warn.mockRestore();
    });
  });

  it("renders nothing for a plan version that is gone, and never calls it a claim", async () => {
    // A CAS that matched no row is two different facts, and only one of them is
    // an owner. With the row gone there is nothing to render for and nothing to
    // coordinate with, so this is a stand-down carrying the read's own answer —
    // never a win with a null token, which every caller would be handed at once.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.queryRawUnsafe.mockResolvedValue([]);
    mocks.planVersion.findUnique.mockResolvedValue(null);
    const pass = passOver([{ answer: "what-exists", settled: false }], true);

    // And the caller is told which of the two empty-handed answers it got: a
    // vanished plan version is not "this cast has no sheets".
    await expect(runCharacterReferenceRenderPass(pass)).resolves.toEqual({
      answer: "what-exists",
      outcome: "plan-version-gone"
    });
    const line = mocks.appendFile.mock.calls.at(-1)?.[1];
    expect(line).toBeTypeOf("string");
    expect(JSON.parse(String(line))).toMatchObject({
      event: "character.reference.stand_down",
      reason: "plan_version_gone",
      planId: "plan-1"
    });
    expect(pass.render).not.toHaveBeenCalled();
    expect(pass.commit).not.toHaveBeenCalled();
    expect(pass.read).toHaveBeenCalledTimes(1);
    // And no lease release either: there is no token, and no row to release it on.
    expect(mocks.executeRawUnsafe).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * The commit is the only transaction this pass has left, and the release may
   * not be inside it.
   *
   * It was: a commit that aborted — a serialization failure, a dropped
   * connection, `CHARACTER_REFERENCE_COMMIT_TIMEOUT_MS` on a large cast — rolled
   * the release back with everything else and left a live lease with nobody
   * rendering, which is precisely the asymmetry the render-failure path beside
   * it exists to avoid. Nothing bounds that but the expiry: the lease is never
   * renewed, so the row heals `CHARACTER_REFERENCE_LEASE_MS` after the *claim*
   * and every other image job of the book polls a render that already gave up
   * until it does.
   *
   * So these drive the lease row itself, through a `$transaction` mock that
   * rolls its writes back the way Postgres would.
   */
  describe("the lease is released whichever way the commit ends", () => {
    /** The one column the release writes, and the order of what touched it. */
    const lease: { token: string | null } = { token: null };
    const events: string[] = [];

    beforeEach(() => {
      lease.token = null;
      events.length = 0;
      mocks.queryRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('UPDATE "PlanVersion"')) {
          lease.token = String(params[1]);
          return [{ characterReferenceLeaseExpiresAt: new Date(Date.now() + CHARACTER_REFERENCE_LEASE_MS) }];
        }
        return [{ live: lease.token !== null, token: lease.token }];
      });
      mocks.executeRawUnsafe.mockImplementation(async (_sql: string, ...params: unknown[]) => {
        events.push("release");
        if (lease.token === String(params[1])) {
          lease.token = null;
        }
        return 1;
      });
      // A rollback takes back every write the callback made, the release among
      // them — which is the whole of what this is here to model.
      mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
        const before = lease.token;
        try {
          const answer = await callback(tx);
          events.push("tx:commit");
          return answer;
        } catch (error) {
          lease.token = before;
          events.push("tx:rollback");
          throw error;
        }
      });
    });

    /** Two unsettled reads, so the commit is reached rather than stood down for. */
    const unsettledTwice = () =>
      passOver(
        [
          { answer: "nothing", settled: false },
          { answer: "nothing", settled: false }
        ],
        false
      );

    it("releases the lease when the commit transaction aborts", async () => {
      const aborted = Object.assign(new Error("could not serialize access due to concurrent update"), {
        code: "P2034"
      });
      const pass = unsettledTwice();
      pass.commit.mockRejectedValue(aborted);

      // The commit's own failure is what the caller gets — a release may not
      // stand in for it, and the job's retry ladder is the answer to it.
      await expect(runCharacterReferenceRenderPass(pass)).rejects.toBe(aborted);

      // And the next pass may claim immediately rather than waiting out the
      // rest of a budget nobody is rendering against.
      expect(lease.token).toBeNull();
      // The first entry is the claim's own transaction; the two after it are
      // what this is about.
      expect(events).toEqual(["tx:commit", "tx:rollback", "release"]);
    });

    it("holds the lease until the commit is durable, and only then lets it go", async () => {
      // The other half of the ordering, and the reason the release is not
      // merely hoisted above the transaction: a lease freed while this pass is
      // still writing lets a second one reach its own commit over the same
      // cast, each deleting the rows the other read.
      const pass = unsettledTwice();

      await expect(runCharacterReferenceRenderPass(pass)).resolves.toEqual({ answer: "committed", outcome: "rendered" });

      expect(events).toEqual(["tx:commit", "tx:commit", "release"]);
      expect(lease.token).toBeNull();
    });

    it("keeps a commit that landed when the release behind it fails", async () => {
      // A release is best effort in both directions: the sheets are on disk and
      // in the database, and losing the row that says so over the lease column
      // beside it would be the more expensive of the two mistakes.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mocks.executeRawUnsafe.mockRejectedValue(new Error("connection terminated unexpectedly"));
      const pass = unsettledTwice();

      await expect(runCharacterReferenceRenderPass(pass)).resolves.toEqual({ answer: "committed", outcome: "rendered" });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("still releases a lease whose render never reached the commit", async () => {
      // Unchanged, and pinned beside the others because it is now the same call:
      // an outage is retried by the job's own ladder, and that retry may not
      // wait out the budget of a renderer that is already gone.
      const outage = new Error("image provider unavailable");
      const pass = unsettledTwice();
      pass.render.mockRejectedValue(outage);

      await expect(runCharacterReferenceRenderPass(pass)).rejects.toBe(outage);
      expect(pass.commit).not.toHaveBeenCalled();
      expect(lease.token).toBeNull();
      expect(events).toEqual(["tx:commit", "release"]);
    });
  });
});
