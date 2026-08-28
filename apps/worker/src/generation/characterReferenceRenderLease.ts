import { prisma, type Prisma } from "@book-maker/db";
import { randomUUID } from "node:crypto";
import { assertJobNotStopped } from "../runtime/jobLifecycle.js";
import { appendCharacterReferenceRunLog, logCharacterReferenceStandDown } from "./characterReferenceRunLog.js";

/**
 * Who may render a plan's character reference sheets, and where the slow half
 * of that pass is allowed to run.
 *
 * The pass used to be one `prisma.$transaction` with a five-minute timeout:
 * `pg_advisory_xact_lock` was taken at the top and every image call, every file
 * write and every row write happened under it. That was already minutes of
 * model latency spent holding a pooled connection idle-in-transaction and a
 * cross-process lock every other image job blocks on — and a refused character
 * used to end it in milliseconds. It no longer does. A refusal is tolerated so
 * the rest of the cast keeps rendering, and a *copyright* refusal additionally
 * buys a text call to rewrite the prompt (two, if the reply needs repairing)
 * plus a second full primary→fallback render — see
 * `providers/copyrightSafeImageRetry.ts`. A cast with two or three of those
 * outruns 300s, and the abort was the worst possible answer: every sheet
 * already rendered and paid for was rolled back, the files stayed on disk with
 * no rows, and every waiting image job had been blocked on the lock for the
 * whole window.
 *
 * So the transaction is split in two and the renders sit between them:
 *
 *   claim   advisory lock, re-read the settled answer, take the lease — three
 *           statements, milliseconds.
 *   render  model calls and file writes, with no lock, no transaction and no
 *           connection held. As long as it takes.
 *   commit  advisory lock, re-read, write the sheets and the settlement
 *           together — milliseconds, and atomic exactly as before.
 *
 * The lease is what the lock was doing across the renders, made durable: a
 * column rather than a session, compared in database time, and the whole of the
 * cost control — without it every illustrated page's image job and the cover
 * job would render the cast again. Its budget is deliberately the old
 * transaction timeout, because that is the render budget this pass always had.
 * What changes is what missing the budget costs: overrunning it now risks a
 * duplicated render instead of destroying the work.
 */

/**
 * How long a claim is honoured — the old transaction timeout, for the reason
 * above. Not renewed: a heartbeat would only move the moment a wedged renderer
 * is replaced, and the thing being protected is a bill, not a correctness
 * property. The commit is serialized by the advisory lock either way.
 */
export const CHARACTER_REFERENCE_LEASE_MS = 5 * 60_000;
/**
 * How long a caller that lost the claim waits for **one** owner. Longer than the
 * lease, so the wait ends by seeing that owner's sheets or by seeing its lease
 * expire — never by timing out while its answer is still coming. Renewed when
 * the row says the work changed hands; `waitForCharacterReferenceRender` has the
 * reasoning.
 */
const CHARACTER_REFERENCE_LEASE_WAIT_MS = CHARACTER_REFERENCE_LEASE_MS + 60_000;
/**
 * And the ceiling on the whole wait, however many owners it spans, taken once
 * per **job** — `runCharacterReferenceRenderPass` holds it and hands it down, so
 * the two waits one pass can make share it rather than each starting a fresh
 * one. A renewal with no bound is a worker slot held for as long as passes keep
 * claiming and expiring — the failure `structuralPageLease.ts` names, reached
 * from the other side. Stated in the lease's own units because every relay costs
 * a full expiry of real time to reach, so three leases is about three owners;
 * generous for the same reason that wait is, since giving up on a live render is
 * the expensive mistake.
 */
export const CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS = 3 * CHARACTER_REFERENCE_LEASE_MS;
/**
 * Half the rate `structuralPageLease.ts` polls at, because these ticks are not
 * doing that tick's job. Waiting there **is** claiming — every tick re-runs the
 * CAS, so it wants to be first at the instant an expiry frees the row, and one
 * rival delivery is running it. A tick here reads and claims nothing:
 * re-claiming belongs to `runCharacterReferenceRenderPass`, after `expired`.
 * Three reads rather than two, since the stop check is one of them — a wait this
 * long is the one place in the pass where nothing else would observe a reader
 * who gave up, and one primary-key select every two seconds is the cheapest
 * thing in the tick.
 * And there are more of them — `MAX_PARALLEL_IMAGE_JOBS` page renders plus the
 * cover job can all be waiting on one cast.
 */
const CHARACTER_REFERENCE_LEASE_POLL_MS = 2_000;
/** Both are read-and-write-a-handful-of-rows, so neither may sit anywhere near the old budget. */
const CHARACTER_REFERENCE_COMMIT_TIMEOUT_MS = 60_000;
/**
 * And the claim's budget is a commit's plus its own, because the two take the
 * same lock. `pg_advisory_xact_lock` blocks a claim until the transaction
 * holding it ends, and the commit is the only long holder there is — so a claim
 * allowed *less* time than a commit is a claim that can die waiting on one that
 * has done nothing wrong. It dies loudly, too: a Prisma transaction timeout is
 * thrown, `runCharacterReferenceRenderPass` has no catch, and neither does any
 * of its seven call sites, so a fan-out that queued behind a slow commit fails
 * `generate-book` — the book FAILED over a lock wait, which is the outcome
 * every other tolerance in this pass exists to avoid.
 */
const CHARACTER_REFERENCE_CLAIM_TIMEOUT_MS = CHARACTER_REFERENCE_COMMIT_TIMEOUT_MS + 30_000;

/**
 * How long either transaction may wait for a pooled connection.
 *
 * Prisma's default is 2s, and it is the wrong number for both of these because
 * the claim is what starves the pool in the first place: it holds a pooled
 * connection while it blocks on `pg_advisory_xact_lock`, and
 * `MAX_PARALLEL_IMAGE_JOBS + 1` of them can queue behind one commit. A `P2024`
 * raised there fails `generate-book` over a lock wait — what
 * `CHARACTER_REFERENCE_CLAIM_TIMEOUT_MS` above is already sized against, by the
 * other door — and a `P2024` on the **commit** additionally throws away a cast
 * that has already been rendered and paid for: the files are on disk, not one
 * row is written, and neither `runCharacterReferenceRenderPass` nor any of its
 * seven call sites catches it, so the whole cast is drawn again on the job's
 * retry. Splitting the pass is what made that reachable — the old single
 * transaction was entered *before* the renders, so failing to get a connection
 * cost nothing at all. 10s is this repo's number for a load-bearing transaction
 * (`PAGE_RESTRUCTURE_TRANSACTION_OPTIONS`, `exportPublication.ts`) and Prisma's
 * own default pool timeout, so a busy worker queues here for exactly as long as
 * a bare query on the same client would.
 */
const CHARACTER_REFERENCE_POOL_WAIT_MS = 10_000;

/** Every read this pass makes runs equally against the client or a transaction. */
export type CharacterReferenceReadClient = Pick<typeof prisma, "imageAsset" | "planVersion">;

export type CharacterReferenceReadState<Result> = {
  /** The sheets this plan has right now, settled or not. */
  answer: Result;
  /** Whether every plan character has an answer — a drawn sheet or a recorded refusal. */
  settled: boolean;
};

export type CharacterReferenceRenderPass<Rendered, Result> = {
  projectId: string;
  planId: string;
  /**
   * The `GenerationJob` this pass is running under, so the wait can see a reader
   * who stopped the run. Optional because a caller without one is a caller no
   * reader can stop, and the check then costs nothing.
   */
  generationJobId?: string | undefined;
  read: (client: CharacterReferenceReadClient) => Promise<CharacterReferenceReadState<Result>>;
  /** Everything slow. Called with nothing held. */
  render: () => Promise<Rendered>;
  /**
   * Undo whatever the render left outside the database, called exactly when
   * this pass's own answer is not the one that landed — a commit that threw, a
   * plan version that went away mid-render, or a stand-down against an answer
   * this pass does not supersede.
   *
   * It is required rather than optional because it is not an optimization. This
   * module is generic over `Rendered` and cannot name the files a pass wrote,
   * so if the pass does not sweep them nothing ever will
   * (`characterReferenceSheetFiles.ts`); a pass that genuinely put nothing
   * outside the database answers with a no-op and says so by writing one.
   * Best effort by contract: it runs after the lease is released, on paths no
   * row points at, so nothing it does may fail the delivery.
   */
  discard: (rendered: Rendered) => Promise<void>;
  /**
   * Whether the rows this plan now holds name what *this pass* wrote.
   *
   * Asked at one moment only: the commit transaction threw, so whether it
   * landed is unknown. That question may not be answered by the exception. A
   * `P1017`, a socket dropped between the server's COMMIT and the client seeing
   * the ack, and a `$transaction` timeout raised after the callback had already
   * returned all reach this module as "the commit threw" over rows that are on
   * the table — and `discard` is irreversible over a whole cast of files. See
   * `renderIsUnpublished` for what staking the sweep on the throw cost.
   *
   * Answer it from what the pass itself wrote, never from what the plan holds:
   * every stem carries this pass's own render id, so a stored row naming one
   * could only have come from this commit, and a rival's cast can neither
   * answer for it nor be mistaken for it. Lean to `true` wherever that is in
   * doubt — a leaked file is bounded storage noise, an unlinked published one
   * is a book whose pictures ENOENT.
   */
  published: (rendered: Rendered, current: Result) => boolean;
  /**
   * Whether what this pass rendered may replace an answer that reached the
   * commit first. Asked only when the re-read under the lock says the set is
   * already settled — see `renderAndCommit` for why arrival order is not
   * allowed to decide that on its own, and `characterReferences.ts` for the
   * rule this pass answers with.
   */
  supersedes: (rendered: Rendered, settled: Result) => boolean;
  /** The one short transaction that makes the pass durable. */
  commit: (tx: Prisma.TransactionClient, rendered: Rendered, current: Result) => Promise<Result>;
};

/**
 * What the pass answered *and how it got there*.
 *
 * The answer alone is `Result`, and for three of these four it is the whole
 * story. For the stand-downs it is not: `abandoned` and `plan-version-gone` hand
 * back "the sheets that exist", which mid-pass is an empty set — byte for byte
 * the same answer as a cast that has no sheets because nobody has drawn any yet,
 * and as a book whose plan has no characters at all. Returned bare, a caller
 * attaching those sheets to a page could not tell "this book's cast has none"
 * from "we gave up on a render that was still going", and neither could anyone
 * reading the page afterwards. So the reason rides along.
 *
 * `abandoned` covers both of the ways a caller gives up on somebody else's
 * render — the wait it made and gave up on, and the wait it had no budget left
 * to make — because to the page attaching these sheets they are one fact. The
 * run log is where they are told apart, since only one of them means a render
 * was still going when we walked away.
 *
 * It is deliberately *not* a settled fact about the plan: a refusal is permanent
 * and this is not one, so nothing here is written to
 * `PlanVersion.characterReferenceRefusals` and the next caller re-reads,
 * re-claims and may draw the whole cast.
 */
export type CharacterReferenceRenderOutcome<Result> = {
  answer: Result;
  outcome: "settled" | "rendered" | "abandoned" | "plan-version-gone";
};

/**
 * Run one render pass for `(projectId, planId)`, or return the answer whoever
 * won the claim produced.
 *
 * Two claim attempts, never a loop: the second exists only for the caller that
 * waited out a lease nobody finished, and a third would be a caller queueing
 * behind an unbounded chain of them.
 */
export async function runCharacterReferenceRenderPass<Rendered, Result>(
  pass: CharacterReferenceRenderPass<Rendered, Result>
): Promise<CharacterReferenceRenderOutcome<Result>> {
  // **One ceiling, and it belongs to the job rather than to the call.** The wait
  // took it on entry, and this loop enters the wait twice: a first wait that
  // relayed through owners for the whole budget answers `expired` when the last
  // of them dies, the re-claim behind it comes back `busy` because somebody was
  // quicker, and the second wait then started a *fresh*
  // `CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS` — half an hour of a held worker slot
  // out of a bound whose own comment says "the whole wait, however many owners
  // it spans". Taken here it is that. A second wait entered past it answers
  // `no-budget` — its own fact, and `standDownAtWaitCeiling`'s to settle —
  // instead of starting the ladder again or running a zero-length loop and
  // calling that a wait.
  const ceiling = Date.now() + CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claim = await claimCharacterReferenceRender(pass);
    if (claim.kind === "settled") {
      return { answer: claim.answer, outcome: "settled" };
    }
    if (claim.kind === "gone") {
      return await standDownForMissingPlanVersion(pass, claim.answer, {
        message: "The plan version a character reference render belongs to is gone; using the sheets that exist",
        reason: "plan_version_gone"
      });
    }
    if (claim.kind === "claimed") {
      return await renderAndCommit(pass, claim.token);
    }
    const waited = await waitForCharacterReferenceRender(pass, ceiling);
    if (waited.kind === "no-budget") {
      return await standDownAtWaitCeiling(pass, ceiling);
    }
    if (waited.kind !== "expired") {
      return { answer: waited.answer, outcome: waited.kind === "settled" ? "settled" : "abandoned" };
    }
  }
  // The lease we waited out was taken again before we could claim it. Whatever
  // is on the row is what this caller renders with; the new owner will settle
  // the rest for whoever comes next.
  //
  // Which is a stand-down as much as `abandoned` is — the same empty sheet set,
  // for the same reason, on the way out of the same wait — and it used to be the
  // quieter of the two, returning it with nothing said in any log at all.
  const answer = (await pass.read(prisma)).answer;
  console.warn("A character reference render was re-claimed before this caller could; using the sheets that exist", {
    event: "generation.consistency_warning",
    warning: "character_reference_lease_relayed",
    projectId: pass.projectId,
    planId: pass.planId
  });
  await logCharacterReferenceStandDown(pass, { reason: "lease_relayed" });
  return { answer, outcome: "abandoned" };
}

/**
 * `gone` carries an answer for the same reason `settled` does — it is the read
 * taken under the lock, and for a plan version that no longer exists it is the
 * last read anybody will make. The token is a plain `string`, so "I own this
 * render" cannot be spelled without one.
 */
type CharacterReferenceClaim<Result> =
  | { kind: "settled"; answer: Result }
  | { kind: "claimed"; token: string }
  | { kind: "busy" }
  | { kind: "gone"; answer: Result };

/**
 * The advisory lock is still taken, and still around the check-then-claim — it
 * is only what happens under it that shrank. Scoped to (projectId, planId)
 * exactly as before, so a caller mid-claim still excludes every other caller's
 * claim.
 */
async function claimCharacterReferenceRender<Rendered, Result>(
  pass: CharacterReferenceRenderPass<Rendered, Result>
): Promise<CharacterReferenceClaim<Result>> {
  return prisma.$transaction(
    async (tx) => {
      await lockCharacterReferences(tx, pass.projectId, pass.planId);
      const state = await pass.read(tx);
      if (state.settled) {
        return { kind: "settled", answer: state.answer } as const;
      }
      const lease = await takeRenderLease(tx, pass.planId);
      // The read above is this caller's last one under the lock, and against a
      // plan version that is gone it is the last one anybody will make — no
      // pass is coming to settle that set — so the stand-down carries it out
      // rather than paying for a re-read that cannot say anything new.
      return lease.kind === "gone" ? ({ kind: "gone", answer: state.answer } as const) : lease;
    },
    { timeout: CHARACTER_REFERENCE_CLAIM_TIMEOUT_MS, maxWait: CHARACTER_REFERENCE_POOL_WAIT_MS }
  );
}

/**
 * What the commit transaction decided, which is not always "here is the answer".
 *
 * The stand-down it can reach has to be settled *outside* the transaction — a
 * `console.warn` and a run-log append are not things to do with the advisory
 * lock held — so the transaction hands the reason out rather than acting on it.
 */
type CharacterReferenceCommit<Result> =
  | { kind: "committed"; answer: Result }
  | { kind: "stood-down"; answer: Result }
  | { kind: "plan-version-gone"; answer: Result };

async function renderAndCommit<Rendered, Result>(
  pass: CharacterReferenceRenderPass<Rendered, Result>,
  token: string
): Promise<CharacterReferenceRenderOutcome<Result>> {
  let rendered: Rendered;
  try {
    rendered = await pass.render();
  } catch (error) {
    // An outage is retried by the job's own ladder, and a lease left standing
    // would make that retry wait out the full budget for a renderer that is
    // already gone. What the render wrote before it threw is the render's own
    // to sweep — it is the only side of this that still holds the value.
    await releaseRenderLeaseBestEffort(pass.planId, token);
    throw error;
  }
  // The commit's release is the same call, for the same reason, and it is out
  // here for that reason too. It used to run *inside* the transaction below, so
  // a commit that aborted — a serialization failure, a dropped connection,
  // `CHARACTER_REFERENCE_COMMIT_TIMEOUT_MS` on a large cast — rolled the release
  // back with everything else and left a live lease with nobody rendering. The
  // asymmetry cost the whole of what is left of the lease: it is never renewed,
  // so the row heals at `CHARACTER_REFERENCE_LEASE_MS` from the *claim* and not
  // a moment sooner, and until then nothing is settled in front of it and every
  // claim behind it comes back `busy`. So the book's other image jobs and its
  // cover job poll a render that already gave up — four serial queries each (the
  // stop check, the two `pass.read` makes, and the lease itself), every
  // `CHARACTER_REFERENCE_LEASE_POLL_MS` — until the expiry lets one of them
  // re-claim and draw the cast that failed to commit.
  //
  // **After the transaction settles, whichever way it settles — never before.**
  // A release that ran ahead of the commit would let a second pass claim the
  // lease and reach its own commit while this one is still writing: two
  // transactions over one cast, each deleting the rows the other read, and a
  // `writeFile` truncating a sheet the winner has already published a row for.
  // That is a wrong book, and the thing this file gave up the lock to avoid
  // needing. Holding the lease for the length of a commit whose render is
  // already finished is milliseconds of extra waiting — a bill, and the smaller
  // mistake by a wide margin. The window it leaves behind is empty anyway: a
  // commit that landed is `settled`, and both a waiter's tick and the next
  // claim read that before either looks at the lease.
  let settlement: CharacterReferenceCommit<Result> | undefined;
  try {
    settlement = await prisma.$transaction(
      async (tx) => {
        await lockCharacterReferences(tx, pass.projectId, pass.planId);
        const state = await pass.read(tx);
        // **The commit is the last moment anything here is known to be true.**
        // The claim stands down for a plan version that is gone, and nothing
        // stopped the row going away *during* the render instead: an undo of a
        // structural edit deletes the plan version it approved
        // (`packages/db/src/pageRestructureRevert.ts`), and this book's image
        // jobs are still fanned out when it does. Committing anyway wrote the
        // whole cast under a `metadata.planId` no current read resolves, while
        // the settlement beside it — an `updateMany` over a row that is gone —
        // matched nothing: the one pairing this transaction exists to make
        // atomic, half-kept, for a plan version nobody is going to read either
        // half of. So the claim's question is re-asked here and the two answer
        // alike, which is what `apps/worker/src/generation/CLAUDE.md` means by
        // both leases standing down on a fence row that is gone.
        // What the render already put on disk is swept by `pass.discard` below,
        // outside this transaction: every stem carries that pass's own render
        // id, so those paths are unreachable rather than merely stale, and this
        // module is generic over `Rendered` and could not name them itself.
        if (!(await planVersionExists(tx, pass.planId))) {
          return { kind: "plan-version-gone", answer: state.answer } as const;
        }
        // A lease that expired under a slow render lets a second pass run, and
        // the one that got there first has already answered for the whole cast.
        // Ours is then ordinarily a duplicate, not a correction — but *which* of
        // the two answers the plan keeps may not be settled by arrival order
        // alone, because one of the things a pass can answer with is a refusal,
        // and a refusal is permanent: the settled set is never re-rendered, so
        // the sheet a losing pass drew is not merely late, it is gone for the
        // life of the plan version. Whoever committed first would otherwise
        // decide a character's likeness by winning a race rather than by having
        // drawn one. So the pass that lost is asked whether what it holds is
        // better than what it found, and only a pass that adds nothing stands
        // down.
        if (state.settled && !pass.supersedes(rendered, state.answer)) {
          return { kind: "stood-down", answer: state.answer } as const;
        }
        return { kind: "committed", answer: await pass.commit(tx, rendered, state.answer) } as const;
      },
      { timeout: CHARACTER_REFERENCE_COMMIT_TIMEOUT_MS, maxWait: CHARACTER_REFERENCE_POOL_WAIT_MS }
    );
  } finally {
    await releaseRenderLeaseBestEffort(pass.planId, token);
    // **A pass that did not publish its cast still wrote it.** Three of the four
    // ways out of that transaction keep somebody else's answer — a rollback, a
    // plan version deleted mid-render, and a stand-down against an answer this
    // pass does not supersede — and every one of them leaves a full cast of
    // sheet files on disk with no row naming them. `characterReferenceFileStems`
    // stamps every stem with this pass's own render id (it has to: two passes
    // over one cast would otherwise truncate each other's files under a page
    // render reading them), so those paths are not merely stale, they are
    // unreachable — nothing else in the tree will ever write, read or unlink one
    // short of the project being deleted. It runs after the release for the
    // reason the release itself is out here — a file system is not something to
    // keep a cross-process lock waiting on — and its failures are the pass's to
    // swallow, never this delivery's to fail on.
    if (await renderIsUnpublished(pass, rendered, settlement)) {
      await pass.discard(rendered);
    }
  }
  if (settlement.kind === "plan-version-gone") {
    return await standDownForMissingPlanVersion(pass, settlement.answer, {
      message: "The plan version a character reference render belongs to went away mid-render; nothing was committed",
      // A different fact from the claim's, and the one that cost something: this
      // caller paid for a whole cast before the row went away, so an operator
      // reading the run log can tell an unbilled stand-down from a render whose
      // files are on disk with no rows.
      reason: "plan_version_gone_at_commit"
    });
  }
  return { answer: settlement.answer, outcome: "rendered" };
}

/**
 * Whether the files this pass wrote are its own to unlink.
 *
 * **It is staked on what the rows say, never on whether an exception was
 * thrown.** A settlement that came back names its own outcome and is believed:
 * a commit that landed keeps its files, and the two stand-downs that reach the
 * end of the transaction — a plan version deleted mid-render, an answer this
 * pass does not supersede — wrote nothing and sweep. Those are decided without
 * asking anybody, because the transaction *returned* and said which.
 *
 * The fourth way out is a throw, and a throw is not a rollback. `settlement`
 * stays `undefined` for a callback that raised — which did roll back — and
 * equally for a `P1017`, a connection dropped between the server's COMMIT and
 * the client seeing the ack, and a `$transaction` timeout raised after the
 * callback had already returned. Those three committed. Read as "nothing
 * landed", they unlinked every sheet of a cast whose rows are on the table:
 * `currentCharacterReferences` then reports the cast settled,
 * `characterReferenceSetIsSettled` never re-renders it, and every page render
 * and the cover resolve a reference path that ENOENTs — a published row naming
 * a picture that is no longer there, which is the outcome this module gave up
 * the advisory lock to avoid.
 *
 * So an unknown outcome is re-read and put to `pass.published`, and **both ways
 * that can fail lean the same way**: a database that cannot be read and a
 * predicate that throws both keep the files. An unlink cannot be taken back and
 * a leaked cast is the bounded storage noise this pass already accepts
 * elsewhere (`characterReferenceSheetFiles.ts`), so the two are not close enough
 * in cost to be raced.
 *
 * The re-read runs after the release, so a rival may have claimed the lease and
 * superseded us in between. That is not a hole in either direction: its commit
 * deletes the rows it read, so sheets it replaced really are orphaned and really
 * are ours to sweep — and it cannot answer for us either, since the render id on
 * every stem is this pass's alone.
 */
async function renderIsUnpublished<Rendered, Result>(
  pass: CharacterReferenceRenderPass<Rendered, Result>,
  rendered: Rendered,
  settlement: CharacterReferenceCommit<Result> | undefined
): Promise<boolean> {
  if (settlement) {
    return settlement.kind !== "committed";
  }
  const kept = await reasonToKeepRenderedSheets(pass, rendered);
  if (!kept) {
    return true;
  }
  console.warn("Keeping the sheets a character reference commit wrote; it may have landed", {
    event: "generation.consistency_warning",
    warning: "character_reference_commit_outcome_unswept",
    projectId: pass.projectId,
    planId: pass.planId,
    reason: kept
  });
  await appendCharacterReferenceRunLog(pass, "character.reference.sweep_declined", { reason: kept });
  return false;
}

/**
 * Why this pass's sheets survive a commit that threw, or `null` when the rows
 * say nothing of it landed and the sweep may run.
 *
 * The read is the plain client's, deliberately: the advisory lock is about
 * serializing commits, and this one settles nothing but whether some files are
 * reachable. A read that fails answers `"outcome_unreadable"` rather than
 * raising, because this runs in a `finally` — a throw here would replace the
 * commit's own error with the error of the question about it.
 */
async function reasonToKeepRenderedSheets<Rendered, Result>(
  pass: CharacterReferenceRenderPass<Rendered, Result>,
  rendered: Rendered
): Promise<string | null> {
  try {
    return pass.published(rendered, (await pass.read(prisma)).answer) ? "commit_landed" : null;
  } catch (error) {
    console.warn(`Failed to re-read whether a character reference commit landed for plan ${pass.planId}`, error);
    return "outcome_unreadable";
  }
}

/**
 * Nobody to coordinate with, and nothing to coordinate *for*.
 *
 * Said out loud the way `abandoned` is, rather than returned as something that
 * reads like a finished pass: this book's pages render with whatever sheets
 * exist, which is a weaker likeness for a character and never a failed book. It
 * is deliberately not written to `PlanVersion.characterReferenceRefusals` —
 * there is no row to write it to, and a vanished plan version is not a refusal
 * in any case.
 */
async function standDownForMissingPlanVersion<Rendered, Result>(
  pass: CharacterReferenceRenderPass<Rendered, Result>,
  answer: Result,
  detail: { message: string; reason: string }
): Promise<CharacterReferenceRenderOutcome<Result>> {
  console.warn(detail.message, {
    event: "generation.consistency_warning",
    warning: "character_reference_plan_version_gone",
    projectId: pass.projectId,
    planId: pass.planId
  });
  await logCharacterReferenceStandDown(pass, { reason: detail.reason });
  return { answer, outcome: "plan-version-gone" };
}

/**
 * The wait this caller had no budget left to enter.
 *
 * A stand-down like `abandoned`, and a different fact from it: nobody gave up on
 * *this* owner — the job spent `CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS` across
 * every owner it saw, which is the bound working rather than a render being
 * abandoned under one. So it says that in its own words instead of borrowing the
 * give-up line's, which is what it used to do with `waitedMs: 0` and
 * `relays: 0` — indistinguishable in the run log from a caller that genuinely
 * waited fifteen minutes.
 *
 * And it still owes the two things one poll tick would have done, because the
 * loop that owed them never ran: a reader who pressed Stop must settle through
 * `markStopped` rather than as a book that quietly finished with no sheets, and
 * a set that landed while this caller was re-claiming is the answer the whole
 * wait was *for* — not something to stand down over. What is left after both is
 * genuinely "the sheets that exist", and the line records whether somebody was
 * still rendering when we walked away, since that is the difference between a
 * cast nobody is finishing and one that lands a minute later.
 */
async function standDownAtWaitCeiling<Rendered, Result>(
  pass: CharacterReferenceRenderPass<Rendered, Result>,
  ceiling: number
): Promise<CharacterReferenceRenderOutcome<Result>> {
  await assertJobNotStopped(pass.generationJobId);
  const state = await pass.read(prisma);
  if (state.settled) {
    return { answer: state.answer, outcome: "settled" };
  }
  // Best effort, and for the reason the append below is: this caller already
  // holds the answer it is about to return, and a select taken to fill in one
  // field of a log line may not be what loses it.
  const ownerRendering = await renderLeaseLiveBestEffort(pass.planId);
  const waitedMs = Date.now() - (ceiling - CHARACTER_REFERENCE_LEASE_MAX_WAIT_MS);
  console.warn("A character reference wait reached this job's ceiling; using the sheets that exist", {
    event: "generation.consistency_warning",
    warning: "character_reference_wait_ceiling_reached",
    projectId: pass.projectId,
    planId: pass.planId,
    waitedMs,
    ownerRendering
  });
  await logCharacterReferenceStandDown(pass, { reason: "wait_ceiling_reached", waitedMs, ownerRendering });
  return { answer: state.answer, outcome: "abandoned" };
}

type CharacterReferenceWait<Result> =
  | { kind: "settled"; answer: Result }
  | { kind: "abandoned"; answer: Result }
  | { kind: "expired" }
  /** Entered with the job's whole wait already spent — see `standDownAtWaitCeiling`. */
  | { kind: "no-budget" };

/**
 * Waiting used to be free: `pg_advisory_xact_lock` blocked until the winner's
 * transaction ended, and the winner's transaction was the render. It no longer
 * is, so a loser polls — and the wait ends, because a lease whose owner died
 * mid-render is a state nothing will ever write the end of.
 *
 * **The budget is one owner's, and it is renewed when the work changes hands.**
 * The lease has no heartbeat, so the token on the row moves for exactly one
 * reason: a second pass found the lease expired, claimed it, and is rendering
 * the cast right now. A fixed deadline could not see that, and the arithmetic
 * says it could see nothing else: this caller enters holding a `busy` claim, so
 * the lease it lost to expires within `CHARACTER_REFERENCE_LEASE_MS` of entry
 * and the poll returns `expired` a couple of seconds later. Reaching the entry
 * deadline *at all* therefore proved that ownership had relayed — the one state
 * it was not written for, read as though nobody were coming. A waiter that
 * entered thirty seconds into a five-minute lease gave up ninety seconds into
 * the next owner's, and its page then drew with the sheets that existed, which
 * mid-pass is usually none: a pass commits its whole cast at the end, so
 * abandoning under a live render costs the reference sheets for every character
 * on that page, minutes before they landed.
 *
 * So a relay buys the new owner the same budget the old one had, up to the
 * `ceiling` its caller took once for the whole job — that bound is what keeps a
 * chain of passes that keep expiring from holding this job forever, and
 * `abandoned` now means what it says: nobody is finishing this cast. A wait
 * entered with that ceiling already spent has no budget to say anything about,
 * and says *that* rather than borrowing this one's words — see the guard at the
 * top.
 *
 * **And a reader who pressed Stop ends it.** Nothing else in this loop can see
 * one: `pass.read` and `readRenderLease` are plain selects, no abort signal
 * reaches the driver, and `processJob`'s own stop check runs only once the
 * handler has returned or thrown — so a stopped run sat here for the whole
 * ceiling before anything settled it.
 */
async function waitForCharacterReferenceRender<Rendered, Result>(
  pass: CharacterReferenceRenderPass<Rendered, Result>,
  ceiling: number
): Promise<CharacterReferenceWait<Result>> {
  const startedAt = Date.now();
  let deadline = Math.min(ceiling, startedAt + CHARACTER_REFERENCE_LEASE_WAIT_MS);
  // **A wait with no time left is not a wait that gave up, and the loop below
  // cannot tell them apart.** The ceiling belongs to the job, so the second wait
  // one pass makes can be entered at or past it: the first relayed through
  // owners for the whole budget, answered `expired` at a poll a couple of
  // seconds short of it, and the re-claim behind it came back `busy` because
  // somebody was quicker. `deadline` is then `startedAt`, `while (Date.now() <
  // deadline)` runs zero times — no `assertJobNotStopped`, no `pass.read`, no
  // `readRenderLease` — and the give-up path underneath writes
  // `character_reference_lease_abandoned` with `waitedMs: 0` and `relays: 0`
  // under the same warning a caller that waited the full fifteen minutes writes,
  // while handing its page an empty sheet set with a live owner seconds into the
  // cast. The bound is doing its job here; what is missing is a caller that says
  // so, which is the whole of the answer above.
  if (startedAt >= deadline) {
    return { kind: "no-budget" };
  }
  let owner: string | null = null;
  let relays = 0;
  while (Date.now() < deadline) {
    await delay(CHARACTER_REFERENCE_LEASE_POLL_MS);
    // First in the tick, and raised rather than returned: `StopRequestedError`
    // is how every other pass in the worker says this, so `processJob` settles
    // it through `markStopped` instead of failing and refunding a book the
    // reader ended on purpose.
    await assertJobNotStopped(pass.generationJobId);
    const state = await pass.read(prisma);
    if (state.settled) {
      return { kind: "settled", answer: state.answer };
    }
    const lease = await readRenderLease(pass.planId);
    if (!lease.live) {
      return { kind: "expired" };
    }
    if (lease.token && lease.token !== owner) {
      // The first token seen is the owner this caller lost the claim to, which
      // the entry budget is already sized for. Every later one is a relay.
      if (owner) {
        relays += 1;
        deadline = Math.min(ceiling, Date.now() + CHARACTER_REFERENCE_LEASE_WAIT_MS);
      }
      owner = lease.token;
    }
  }
  // Say so rather than returning something that reads like the winner
  // finished: this book's pages render with whatever sheets exist, which is a
  // weaker likeness for one character and never a failed book.
  const waitedMs = Date.now() - startedAt;
  console.warn("Gave up waiting for a character reference render; using the sheets that exist", {
    event: "generation.consistency_warning",
    warning: "character_reference_lease_abandoned",
    projectId: pass.projectId,
    planId: pass.planId,
    waitedMs,
    relays
  });
  await logCharacterReferenceStandDown(pass, { reason: "lease_abandoned", waitedMs, relays });
  return { kind: "abandoned", answer: (await pass.read(prisma)).answer };
}

async function lockCharacterReferences(
  tx: Prisma.TransactionClient,
  projectId: string,
  planId: string
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`character-references:${projectId}:${planId}`}))`;
}

/**
 * Free, or held by someone whose lease has run out — either way it is ours.
 *
 * One compare-and-set, in database time on both sides, exactly as
 * `structuralPageLease.ts` takes its own: two workers disagreeing about the
 * clock is how a live owner gets displaced, and the `RETURNING` is what tells
 * "I took it" from "somebody else has it" without a second read in the common
 * case.
 *
 * **Database time is `clock_timestamp()` here, and it may not be
 * `CURRENT_TIMESTAMP`.** In Postgres that spelling is `transaction_timestamp()`
 * — the moment the transaction *began* — and this transaction's first statement
 * is a blocking `pg_advisory_xact_lock`, so it begins before the lock wait and
 * every millisecond of that wait is spent from a budget nobody has started
 * using yet. Measured against the stack's own Postgres 16: a claim queued
 * behind a four-second lock holder stamped an expiry `295.983s` away instead of
 * `300s`, and a commit may hold that lock for
 * `CHARACTER_REFERENCE_COMMIT_TIMEOUT_MS` — up to
 * `CHARACTER_REFERENCE_CLAIM_TIMEOUT_MS` of waiting, so up to 90s of a 300s
 * lease, silently. It is a **mixed pair** that makes it a bug rather than a
 * conservative budget: `readRenderLease` is its own statement, so its
 * `CURRENT_TIMESTAMP` is real time, and the two clocks then disagree about the
 * same row in both directions. A waiter reads an expiry that has passed and
 * answers `expired`; the re-claim behind it evaluates `<= CURRENT_TIMESTAMP`
 * from before *its* lock wait, still sees the dead lease as live and answers
 * `busy` — the same probe, `UPDATE 0` against `expires_at <= clock_timestamp()`
 * being true. So the waiter pays for a second full cast render while the first
 * renderer is still working, or is pushed into a second wait it has no budget
 * for. Every stamp and every comparison in this file therefore means "now, as
 * this statement runs", which is also the clock `Date.now()` reads on the
 * waiter's side. `structuralPageLease.ts` survives the same spelling only
 * because it heartbeats at a third of its budget, so a shortened lease is
 * renewed before anybody can act on it.
 */
type RenderLeaseClaim = { kind: "claimed"; token: string } | { kind: "busy" } | { kind: "gone" };

async function takeRenderLease(tx: Prisma.TransactionClient, planId: string): Promise<RenderLeaseClaim> {
  const token = randomUUID();
  const rows = await tx.$queryRawUnsafe<Array<{ characterReferenceLeaseExpiresAt: Date | null }>>(
    `UPDATE "PlanVersion"
        SET "characterReferenceLeaseToken" = $2,
            "characterReferenceLeaseExpiresAt" =
              clock_timestamp() + ($3::double precision * INTERVAL '1 millisecond')
      WHERE "id" = $1
        AND (
          "characterReferenceLeaseToken" IS NULL
          OR "characterReferenceLeaseExpiresAt" IS NULL
          OR "characterReferenceLeaseExpiresAt" <= clock_timestamp()
        )
      RETURNING "characterReferenceLeaseExpiresAt"`,
    planId,
    token,
    CHARACTER_REFERENCE_LEASE_MS
  );
  if (rows[0]?.characterReferenceLeaseExpiresAt) {
    return { kind: "claimed", token };
  }
  // A CAS that matched nothing is two different facts and only one of them is
  // an owner. The other is a plan version deleted out from under this book —
  // an undo of a structural edit removes the one it approved
  // (`packages/db/src/pageRestructureRevert.ts`), and this book's image jobs
  // are still fanned out when it does.
  //
  // That used to answer `claimed` with a null token and render **unclaimed**,
  // on the grounds that the page still wants its sheets. But the predicate is
  // `WHERE "id" = $1`, so a row that is not there matches nothing *for
  // everybody*: the advisory lock serializes the claims and nothing serializes
  // the renders, so every waiting `generate-image` job of the book plus the
  // cover job — `MAX_PARALLEL_IMAGE_JOBS + 1` of them — is told it won, at
  // once, and each pays for the whole cast. The one thing this lease is for,
  // inverted into N of it, exactly when the render is worth least.
  //
  // Worth least because there is nothing left to render *for*: the sheets are
  // keyed on `metadata.planId`, so they would land under a plan id no current
  // read resolves; the settlement beside them is an `updateMany` over a row
  // that is gone, which no-ops; and each commit deletes the last one's rows and
  // orphans its files. So it is a third answer, and the caller stands down on
  // it with the sheets that exist — the same bargain `abandoned` makes, for a
  // set nobody is going to finish.
  return (await planVersionExists(tx, planId)) ? { kind: "busy" } : { kind: "gone" };
}

/**
 * The one question both ends of the pass ask, spelled once so they cannot drift
 * apart: the claim asks it of a compare-and-set that matched nothing, and the
 * commit asks it of a render that may have outlived the row it was drawn for.
 * Under the advisory lock in both cases, so the answer holds for the rest of the
 * transaction that read it.
 */
async function planVersionExists(tx: Prisma.TransactionClient, planId: string): Promise<boolean> {
  const held = await tx.planVersion.findUnique({ where: { id: planId }, select: { id: true } });
  return Boolean(held);
}

/**
 * Whether anybody is still rendering, for the stand-down line that says so — and
 * `false` rather than a throw when the row cannot be read, since an unknown
 * owner and no owner cost this caller exactly the same thing: nothing.
 */
async function renderLeaseLiveBestEffort(planId: string): Promise<boolean> {
  try {
    return (await readRenderLease(planId)).live;
  } catch (error) {
    console.warn(`Failed to read the character reference lease for plan ${planId}`, error);
    return false;
  }
}

/**
 * Best effort, and never in place of what the caller is already saying. The
 * worst a failed release costs is one lease's remaining budget of waiting, while
 * letting it throw would swallow the render's own 503 into "this book has no
 * reference sheets" on one path and destroy a commit that already landed on the
 * other — the second being the more expensive, since the sheets are on disk and
 * in the database and only the row saying so would be lost.
 */
async function releaseRenderLeaseBestEffort(planId: string, token: string): Promise<void> {
  try {
    await releaseRenderLease(planId, token);
  } catch (error) {
    console.warn(`Failed to release the character reference lease for plan ${planId}`, error);
  }
}

/**
 * Only ever our own lease. A token that no longer matches has already lost it.
 *
 * On the client rather than on a transaction client, deliberately and by type:
 * this statement's whole job is to survive a commit that did not, so a caller
 * that could hand it a `tx` could roll it back with one.
 */
async function releaseRenderLease(planId: string, token: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "PlanVersion"
        SET "characterReferenceLeaseToken" = NULL,
            "characterReferenceLeaseExpiresAt" = NULL
      WHERE "id" = $1
        AND "characterReferenceLeaseToken" = $2`,
    planId,
    token
  );
}

/**
 * Liveness in SQL, so the waiter and the claim it is waiting on read one clock
 * — `clock_timestamp()`, the same statement-time function the claim stamps with,
 * and the token beside it, because a lease that is never renewed can only change
 * hands — so the token is the whole of a waiter's evidence that someone else
 * took over. A row that is gone answers `{ live: false }`, which sends the
 * waiter to the re-claim, where the deleted plan version is a stand-down.
 */
type RenderLeaseReading = { live: boolean; token: string | null };

async function readRenderLease(planId: string): Promise<RenderLeaseReading> {
  const rows = await prisma.$queryRawUnsafe<Array<{ live: boolean | null; token: string | null }>>(
    `SELECT ("characterReferenceLeaseExpiresAt" > clock_timestamp()) AS live,
            "characterReferenceLeaseToken" AS token
       FROM "PlanVersion"
      WHERE "id" = $1`,
    planId
  );
  const row = rows[0];
  return { live: row?.live === true, token: row?.token ?? null };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
