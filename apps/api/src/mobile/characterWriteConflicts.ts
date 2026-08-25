import { Prisma, prisma } from "@book-maker/db";
import type { FastifyReply } from "fastify";
import { ContentRestrictedError, sendContentRestricted } from "../contentRestrictions.js";
// `LibraryMentionError` is thrown by the two mention write lanes
// (`libraryMentionLinks.ts`, `libraryMentionRewrites.ts`) and defined beside
// `sendMobileError`, which is what this file's ladder answers with. Importing
// it from there rather than from its thrower is what keeps this module out of a
// cycle with one that needs `claimCharacterRows` below — see the class.
import { LibraryMentionError, sendMobileError } from "./httpErrors.js";

/**
 * What the character write paths do about a row that moved under them.
 *
 * `PATCH /:id` and `DELETE /:id` both read the character before their
 * transaction opens and then rewrite *other* characters' descriptions. That
 * makes them the two routes in this group with a concurrency story, and it is
 * one story: claim the row first, drive the token work from what the claim
 * found — including each mentioning character, whose description may have
 * moved under the same window — and answer the residual collision as
 * something the app can retry. This module is that story; the routes and the
 * mention helpers are the callers.
 */

/** Thrown inside a write transaction when the row is no longer the one the request was built from. */
export class CharacterRowMovedError extends Error {
  constructor() {
    super("This character changed while the request was in flight.");
    this.name = "CharacterRowMovedError";
  }
}

/** Thrown inside the delete transaction when its compare-and-set found nothing to claim. */
export class CharacterDeleteClaimLostError extends Error {
  constructor() {
    super("The character delete claim was lost.");
    this.name = "CharacterDeleteClaimLostError";
  }
}

/** The one answer a direct library-character lookup gives when it misses. */
export function sendCharacterNotFound(reply: FastifyReply): FastifyReply {
  return sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "That character is not in your library.");
}

/**
 * The one answer both write paths give when the row moved under them.
 *
 * Deliberately not `CHARACTER_NAME_TAKEN`: nothing the reader typed is wrong and
 * the edit is worth re-sending exactly as it stands, so the sentence says
 * *retry* rather than *fix your input*. The editor sheet snackbars the message
 * of every code but that one, which is the right shape for this.
 */
export function sendCharacterEditConflict(reply: FastifyReply): FastifyReply {
  return sendMobileError(
    reply,
    409,
    "CHARACTER_EDIT_CONFLICT",
    "This character was changed somewhere else a moment ago. Open it again and retry."
  );
}

/**
 * The one answer every character route gives while a portrait job owns the row.
 *
 * Five sites reach this wall — the promote and the per-image delete when
 * `writeCharacterPointers` refuses, `POST /:id/portrait` on both its status
 * guard and its own `PortraitInProgressError`, and `DELETE /:id` when the claim
 * it lost turns out to be a live one — and they used to spell three different
 * sentences between them. The app snackbars `error.message` for this code
 * verbatim, so a reader who met one wall from three gestures was told three
 * different things about one state. A constant private to the picture routes
 * could not fix that: the record route sends it too.
 *
 * The noun is the app's. `character_reference_copy.dart` says *illustration*
 * wherever it addresses the reader ("Drawing the illustration", "Redraw
 * illustration"), and `referenceWanted` calls "generate portrait" the secondary
 * framing in as many words. `portrait` stays in the wire code, the columns and
 * the internal error class — a shipped client recognises the code, and renaming
 * one buys nothing.
 *
 * And it says what to do next rather than only reporting the state: the block
 * lifts on its own once the job settles, so "try again when it finishes" is the
 * whole recovery. A bare "is already being drawn" is a snackbar the reader
 * cannot act on.
 */
export function sendPortraitInProgress(reply: FastifyReply): FastifyReply {
  return sendMobileError(
    reply,
    409,
    "PORTRAIT_IN_PROGRESS",
    "This character's illustration is still being drawn. Try again when it finishes."
  );
}

/**
 * The one answer the two picture-pointer writes give when the row moved.
 *
 * `sendCharacterEditConflict`'s counterpart for the strip: the promote and the
 * per-image delete each decide *which* pointer to write from a row read a
 * moment earlier, so a pointer that moved in between is a refusal rather than a
 * write — and the recovery is to look at the pictures again, not to re-send the
 * same tap. Both sites spelled it out inline and identically, which is one
 * drift away from the split this file's other senders exist to prevent.
 */
export function sendCharacterImageChanged(reply: FastifyReply): FastifyReply {
  return sendMobileError(
    reply,
    409,
    "CHARACTER_IMAGE_CHANGED",
    "This character's pictures just changed. Have another look and try again."
  );
}

/**
 * Claims the character row inside the transaction, on the values the request was
 * built from. Two jobs, and both are load-bearing.
 *
 * The **re-read**: every strip and rewrite these transactions perform is an
 * exact-token match on `@name`, and the name read before the transaction opened
 * is a claim about a row another device may have renamed since. A delete driven
 * by the stale name strips nothing, and the cascade then takes the mention rows
 * that were the only way back to the `@NewName` markers left behind in other
 * characters' prose — dangling permanently, in text nothing will scan again.
 *
 * The **lock**: Prisma's model API has no `SELECT … FOR UPDATE`, so it comes
 * from writing the row's own name back onto it, a no-op to the reader and not
 * to Postgres — which takes `FOR NO KEY UPDATE` on it, because a value the row
 * already holds modifies no key column and nothing escalates. Taking it before
 * any sibling description is written gives PATCH and DELETE a shared first
 * statement; the mention helpers then make the same assertion, in the same lock
 * mode and one statement, over every source they rewrite at once
 * (`claimCharacterRows`) and re-read those sources under
 * it, so a concurrent PATCH of a mentioning character is merged rather than
 * overwritten.
 * `updateMany` rather than `update` for the reason `REFERENCE_CLAIMABLE` is
 * one: the predicate is re-evaluated once the row lock is granted, so a rename
 * that commits while this statement waits is *seen* rather than overwritten.
 *
 * A `true` from this therefore settles the row's existence for the rest of the
 * transaction, and that is worth knowing at the re-read below it: nothing can
 * delete or rename a row this holds, so a later read under a *subset* of the
 * predicate it matched cannot come back empty. The `if (!row)` beside such a
 * read is the compiler being answered, not a race being guarded — written as a
 * conflict it tells the next reader this claim does not lock.
 *
 * A write is not free, and what it costs is `updatedAt` — the whole of the
 * paragraph `claimCharacterRows` spends on it applies here too. It is not
 * *paid* here only because of who calls this: PATCH claims the row and then
 * writes it, with a stamp built after the wait rather than before it, and
 * DELETE claims it in order to remove it. A caller that claimed a row it did
 * not go on to write would pay it in full.
 */
export async function claimCharacterRow(
  tx: Prisma.TransactionClient,
  options: { id: string; userId: string; name: string; where?: Prisma.LibraryCharacterWhereInput }
): Promise<boolean> {
  const claimed = await tx.libraryCharacter.updateMany({
    where: { ...options.where, id: options.id, userId: options.userId, name: options.name },
    data: { name: options.name }
  });
  return claimed.count === 1;
}

/**
 * The pre-transaction read a claim is built from: the id, the name, and
 * deliberately nothing else.
 *
 * `PATCH /:id` took the whole row here and then drove every write off the copy
 * re-read under the claim instead, which left a full stale snapshot in scope
 * for the length of the handler. Reaching back into it is not hypothetical —
 * it is the bug that moved the read inside: the claim asserts the *name*, so a
 * description saved on another device between the two reads passes it
 * untouched and gets written straight back over. A `select` this narrow is the
 * compiler saying that, where a comment would only ask. `DELETE /:id` still
 * reads the whole row, because it also needs the picture pointers and the
 * portrait claim the row carries.
 */
export async function characterClaimSubject(
  id: string,
  userId: string
): Promise<{ id: string; name: string } | null> {
  return prisma.libraryCharacter.findFirst({ where: { id, userId }, select: { id: true, name: true } });
}

/**
 * The same claim over a whole set of rows, in one statement.
 *
 * The mention helpers hold up to `LIBRARY_CHARACTER_LIMIT_PER_USER - 1` rows at
 * once — every character whose description names the one being renamed or
 * deleted — and a claim each is where those transactions spent most of their
 * window. The assertion does not weaken: each row is still named by id, owner
 * **and** the name the read found, as its own `OR` branch, so a row somebody
 * renamed in between matches no branch. `count` is then the whole verdict —
 * short by one is a row that moved, and the caller answers it the way the
 * per-row `false` was answered, without needing to know which one.
 *
 * **A lock is not a write, so this one is a `SELECT`.** The claim wants exactly
 * two things from Postgres — a row lock, and a predicate re-evaluated once that
 * lock is granted — and `SELECT … FOR NO KEY UPDATE` gives both while touching
 * nothing. It used to be an `UPDATE` writing each row's own `userId` back,
 * because Prisma's model API has no locking read, and that no-op write was not
 * free: **`@updatedAt` is stamped when Prisma *builds* the statement, not when
 * Postgres runs it.** Carrying no timestamp of ours in `data` changed nothing —
 * Prisma compiled the claim to `UPDATE … SET "userId" = $1, "updatedAt" = $2`
 * and bound `$2` from the client's clock before the statement was sent.
 * Measured against a real Postgres: a claim issued at `T` and blocked 4.0 s on
 * a row lock wrote `T + 20 ms`, the same instant an explicit `new Date()` would
 * have written — which is why taking that `new Date()` out fixed nothing.
 *
 * That mattered because a claim is the one statement here that routinely
 * *waits*. A rename claiming 99 siblings stamped `t0`, queued behind a PATCH of
 * sibling B that stamped and committed `t1 > t0`, and then landed `t0` on top
 * of `t1`. That column is not bookkeeping: `serializeLibraryCharacter` ships it
 * and `character_avatar.dart` spends it as the portrait URL's `v=` cache-buster,
 * so a stamp that went backwards handed the device a URL it already had bytes
 * for, and a portrait replaced in that window stayed stale on that phone until
 * something else edited B. The same statement also moved the stamp on every one
 * of those 99 rows whose prose never moved at all.
 *
 * **`FOR NO KEY UPDATE` and not `FOR UPDATE`**, and the difference is not
 * cosmetic. It is the lock the `UPDATE` already took — writing a row its own
 * `userId` modifies no key column, so nothing escalated — while `FOR UPDATE`
 * additionally blocks `FOR KEY SHARE`, which is what an FK check on a
 * `LibraryMention` insert takes. The stronger lock here would start serializing
 * mention writes against claims that do not conflict with them. Where that
 * stronger lock *is* the point it is taken deliberately, on one row, by
 * `lockMentionTarget` in `libraryMentionRewrites.ts`.
 *
 * The re-evaluation survives the change intact: a row-locking `SELECT` re-checks
 * its predicate against the row version it waited for, exactly as the `UPDATE`
 * did, so a sibling renamed in the window still matches no branch and a short
 * count still means what it means.
 *
 * **The comparison is row-wise, which is the whole point of the `unnest`.** The
 * three columns are matched as a row constructor against three parallel arrays,
 * not column by column: matched column by column, a character renamed into a
 * name another row of the same claim was read under would satisfy every term of
 * the predicate and be reported as a row this claim locked under a name it does
 * not hold. `[userId, name]` is unique, so arranging that takes two renames
 * rather than one — and two renames is well inside a window this holds for ten
 * seconds. Measured, on the statement as written: the borrowed-name set matches
 * zero rows, where the column-wise spelling matches both.
 *
 * Three array parameters also means the statement's shape does not depend on
 * how many rows it claims, and it drops the per-owner grouping the old `data`
 * needed — a `SELECT` has no `data`, and every tuple carries its own owner — so
 * this is one statement for the whole set rather than one per library.
 *
 * `ORDER BY "id"` is the order the rows are locked in, and it is there so that
 * two claims over an overlapping set take them in the same sequence and queue
 * behind each other rather than deadlock.
 *
 * Duplicate ids would read as a short count, so the caller passes a
 * deduplicated set.
 */
export async function claimCharacterRows(
  tx: Prisma.TransactionClient,
  rows: readonly { id: string; userId: string; name: string }[]
): Promise<boolean> {
  if (rows.length === 0) {
    return true;
  }
  const claimed = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "LibraryCharacter"
    WHERE ("id", "userId", "name") IN (
      SELECT * FROM unnest(
        ${rows.map((row) => row.id)}::text[],
        ${rows.map((row) => row.userId)}::text[],
        ${rows.map((row) => row.name)}::text[]
      )
    )
    ORDER BY "id"
    FOR NO KEY UPDATE
  `;
  return claimed.length === rows.length;
}

/**
 * A deadlock or serialization failure, in whichever shape the driver reported it.
 *
 * Both write paths update rows other than the one they claimed — the two mention
 * helpers write every description that mentions this character — so two renames
 * of mutually mentioning characters can still meet head-on however the route
 * orders its own statements. Postgres picks a victim and aborts it with `40P01`,
 * which is neither a `LibraryMentionError` nor a `P2002`: it fell through the
 * catch as a raw 500, for an edit that is valid and worth re-sending.
 *
 * Read off `code` and `message` rather than through `instanceof`, the way
 * `isPlanVersionNumberConflict` reads a `P2002` in the worker's
 * `pageRestructure.ts`: Prisma raises `P2034` for the write conflicts it models,
 * but one raised by a statement it does not arrives as a
 * `PrismaClientUnknownRequestError` carrying the SQLSTATE in its message and
 * nothing else. This sits on the failure path of a transaction that can hand
 * back anything at all, so it has to answer "no" for all of those without
 * depending on the class it was given.
 */
export function isRetryableTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const known = error as { code?: unknown; message?: unknown };
  if (known.code === "P2034" || known.code === "40P01" || known.code === "40001") {
    return true;
  }
  const message = typeof known.message === "string" ? known.message : "";
  return /40P01|deadlock detected|could not serialize access/i.test(message);
}

/**
 * The ceiling both mention-rewriting transactions run under.
 *
 * `rewriteIncomingLibraryMentions` and `unlinkIncomingLibraryMentions` hold every
 * character whose description mentions the one being edited, and
 * `LIBRARY_CHARACTER_LIMIT_PER_USER` is 100 — so a well-connected rename claims
 * up to 99 rows and keeps them locked until it commits. What that costs is
 * **five statements, whatever the library holds**: the target's own
 * `FOR UPDATE`, the read of who mentions it, the claim over that set, the
 * re-read under the claim, and one set update carrying a description per row
 * whose text actually moved. Pinned in `libraryMentionRewrites.test.ts`, which
 * is where that count went when the mention suites split. A claim, a re-read
 * and a write *each* was ~300, which is what needed thirty seconds — and what
 * Prisma's 5 s default aborted midway, answering `P2028` to an edit that is
 * perfectly valid. Claiming the set in one statement took it to ~102, and the
 * write was the last of the three that still grew with the library: it was
 * awaited once per changed row, in series, while every one of those rows was
 * locked.
 *
 * So the number is 10 s, and it is a **lock window** before it is a budget: it
 * is how long one rename can make every other character edit on that account
 * wait, and how long a stalled attempt holds its pool connection. It also has to
 * leave room for the answer. The app's default receive timeout is 20 s
 * (`api_client.dart`, and these routes do not raise it), so a `maxWait + timeout`
 * above that is a `CHARACTER_EDIT_BUSY` no reader can ever see — the request is
 * a network error on the device before the 503 is written. That is a statement
 * about **one** transaction, and it was quietly read as one about a request:
 * `DELETE /:id` can open two, and `PATCH /:id` pays for two reads before it
 * opens one — which is what `characterRetryTransactionOptions` below is for.
 * Named here rather than at each call site so PATCH and DELETE cannot drift, the way
 * `PAGE_RESTRUCTURE_TRANSACTION_OPTIONS` does for the page shifts — the same
 * shape, and deliberately no longer the same numbers: that one is still
 * `{ 30_000, 10_000 }` because a restructure's work grows with the book, while
 * this one's stopped growing with the library once the claim and the rewrite
 * became one statement each. Two ceilings over two different amounts of work;
 * only the reason for naming them once is shared.
 */
export const CHARACTER_MENTION_TRANSACTION_OPTIONS = {
  timeout: 10_000,
  maxWait: 5_000
} satisfies CharacterTransactionOptions;

/** What a route hands `$transaction`, named so the two ceilings here are one shape. */
export type CharacterTransactionOptions = { timeout: number; maxWait: number };

/**
 * The wall clock every character write has to finish answering inside.
 *
 * The paragraph above sizes one transaction against it. This names it, because
 * `DELETE /:id` is not one transaction: past this the request is already a
 * network error on the device, and `CHARACTER_EDIT_BUSY` — the one answer that
 * tells the reader what to do — is written to nobody.
 */
export const CHARACTER_WRITE_CLIENT_BUDGET_MS = 20_000;

/** The reply, plus the `portraitClaimIsLive` question between the delete's two attempts. */
const CHARACTER_WRITE_RESERVE_MS = 2_000;

/**
 * No claim and unlink commits under this, so a window that cannot hold it is
 * not opened at all. It is a floor on the transaction's **`timeout`**: the
 * claim, the unlink and the delete are statements that run *inside* the window,
 * while `maxWait` is only the queue in front of it — a lane held to this
 * against the pair opens the transaction the floor was written for with two
 * thirds of it.
 */
export const CHARACTER_RETRY_FLOOR_MS = 3_000;

/**
 * What is left of that budget for the transaction about to open.
 *
 * `DELETE /:id` is a two-attempt lane: it claims with the portrait guard, asks
 * whether the job behind a lost claim is still alive, and claims again without
 * it. Only the per-transaction worst case was ever reasoned about, and the lane
 * doubles it — 5 + 10 twice, with a pool acquisition for the question wedged
 * between, is 30 s of worst case behind a 20 s receive timeout. It fails
 * exactly where it matters: the second window is only ever *spent* under pool
 * pressure or on a row another write is holding, which is when the 503 the
 * ceiling above left room for is the answer, and by then the device has stopped
 * listening.
 *
 * Both attempts read the elapsed clock rather than a halved constant, which
 * would take the window away from the attempt that actually unlinks up to 99
 * descriptions. The first attempt is ordinarily the one that does that work, so
 * it must not be capped at half — and it is not: with the lane's two
 * pre-attempt reads cheap (the session lookup and `ownedCharacter`) an elapsed
 * of ~0 returns the whole 15 s ceiling. That is one fewer than PATCH pays for
 * below, and not because the delete stopped reading: the retained file names
 * are read through `tx` under the claim, so they are charged to the window this
 * hands out rather than to the clock in front of it — a statement the `timeout`
 * has to be wide enough to hold, not one that shrinks it. The two still in
 * front are pool acquisitions under the very pressure this budget is sized for,
 * so they come out of the budget exactly as PATCH's do: a first attempt that
 * queued 6 s behind them opens ~12 s rather than a full 15 s, and its
 * `CHARACTER_EDIT_BUSY` lands at ~18 s instead of ~21 s — inside the 20 s the
 * device is still listening for. Feeding the first attempt the raw ceiling was
 * the delete's copy of the same bug the PATCH paragraph below names: a
 * per-transaction ceiling read as a per-request one. The retry then
 * reads the clock again — the second runs only when the first *lost its claim*,
 * one or two statements in: a first attempt back in milliseconds leaves it the
 * full 15 s (0 + 15 + 2 reserve = 17 s), and one that sat 12 s on a row lock
 * leaves it 6 s (12 + 6 + 2 = 20 s) — narrower than it wants and wide enough to
 * answer, which is the whole point of bounding it.
 *
 * `PATCH /:id` opens one transaction and asks the same question for the same
 * reason: what it spends *before* that is two pool acquisitions of its own —
 * `characterClaimSubject`, then the `copyrightRestrictionsEnabled` flag, which
 * is read out there precisely so it is not read while up to 99 row locks are
 * held — and both come out of this one budget. Sized against the ceiling alone,
 * a request that queued 13 s for those still opened the full 15 s behind them,
 * so its `CHARACTER_EDIT_BUSY` was written at 28 s to a device that stopped
 * listening at 20. Elapsed time is the input either way; which attempt spent it
 * is the caller's business, and the name is the delete's because that lane
 * needed it first.
 *
 * **A budget too small for the floor is `null` — the answer, not a wider
 * window.** The floor used to be a clamp, and a clamp is the one arithmetic
 * that can put the sum back over the budget the rest of this function exists to
 * hold: a first attempt that spent its whole 15 s leaves `left` at 3 s, and
 * flooring that to 4.5 s lands the lane at ~19.5 s *plus* the liveness read —
 * past the 18 s the reserve was sized to leave, and at or over the app's 20 s
 * receive timeout. So the trade the floor names was being paid twice over: the
 * window was too small to commit in *and* its `CHARACTER_EDIT_BUSY` was written
 * to a device that had already given up with a bare network error. Refusing to
 * open it is what the floor was always saying — a transaction that cannot
 * commit is not worth a reader's last two seconds — and it makes the bound
 * inductive rather than approximate: every window this hands out is `left` or
 * less, so `elapsed + window` never passes the budget, whichever attempt of
 * whichever lane is asking. The caller answers `sendCharacterWriteBusy`, which
 * is the same 503 the window it did not open would have produced, arriving
 * while the reader is still there to read it.
 */
export function characterRetryTransactionOptions(elapsedMs: number): CharacterTransactionOptions | null {
  const base = CHARACTER_MENTION_TRANSACTION_OPTIONS;
  const left = CHARACTER_WRITE_CLIENT_BUDGET_MS - CHARACTER_WRITE_RESERVE_MS - Math.max(elapsedMs, 0);
  if (left >= base.maxWait + base.timeout) {
    return { ...base };
  }
  // The ceiling's own 1:2 split, kept whatever the window shrinks to: `maxWait`
  // is a queue for a pool connection and `timeout` is the work, and a retry
  // that spent two thirds of a short window queueing has answered nothing.
  // Which is why the floor is applied through the split rather than in front of
  // it: it is the *work* that has to clear 3 s, so the smallest window worth
  // opening is the floor plus the queue this split puts before it. Held against
  // the pair instead, an exhausted budget opened 1 s of queue and 2 s of
  // transaction under a constant promising the write would commit — the P2028
  // the floor exists to refuse, answered as a 503 the reader can do nothing
  // with.
  const floorWindow = CHARACTER_RETRY_FLOOR_MS + Math.round(CHARACTER_RETRY_FLOOR_MS / 2);
  if (left < floorWindow) {
    return null;
  }
  const maxWait = Math.round(left / 3);
  return { timeout: left - maxWait, maxWait };
}

/**
 * A transaction that ran out of time, which is deliberately *not* one of the
 * conflicts above.
 *
 * `isRetryableTransactionConflict` means "this exact write lost a race and is
 * worth re-sending now". `P2028` means the opposite: nothing raced it, it did
 * not fit in the window, and re-sending it immediately buys another full window
 * of the same — while the same code also covers a transaction whose client was closed
 * under it, which is not a collision at all. So it gets its own answer, and the
 * sentence that goes with it says *in a moment* rather than *someone else
 * changed this*, which is a thing no reader of a timeout could act on.
 *
 * **Those two sentences are told apart by one exact test and one piece of
 * prose, so the prose may only speak where the exact tests are silent.**
 * `code === "P2028"` is Prisma naming the failure itself and settles it
 * outright. The string match under it is the net beneath everything that
 * reports the same failure without that code — a driver error, a pool wrapper,
 * a `PrismaClientUnknownRequestError` — and a net woven that loosely catches
 * the wrong fish: an error reporting a serialization failure whose text also
 * quotes "transaction already closed" is a collision, and answering it
 * `CHARACTER_EDIT_BUSY` tells a reader who lost a race to wait out a window
 * that has already closed, instead of opening the character again and
 * re-sending it. That is precisely the swap the paragraph above forbids, made
 * by the one rung on this ladder that guesses.
 *
 * So two things narrow it, and neither is a tighter phrase — the shapes this
 * fallback exists for are the ones nobody can enumerate, and anchoring the
 * prose harder only moves the guess. **The conflict predicate is asked first
 * and allowed to win**: every test it makes is exact (`P2034`, `40001`,
 * `40P01`, and the two sentences Postgres itself writes), so an error carrying
 * both signals is a conflict that mentions a timeout rather than a timeout that
 * mentions a conflict. **Then the shape has to corroborate**: an error carrying
 * a `code` of its own has already said what it is, and the only code that means
 * *this* is the one tested at the top — so a coded error is never read for
 * prose, and the fallback answers only for the codeless shapes it was written
 * for. Ordering it this way costs nothing a real `P2028` needs: that one never
 * reaches either guard.
 */
export function isTransactionTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const known = error as { code?: unknown; message?: unknown };
  if (known.code === "P2028") {
    return true;
  }
  if (isRetryableTransactionConflict(error)) {
    return false;
  }
  if (known.code !== undefined && known.code !== null && known.code !== "") {
    return false;
  }
  const message = typeof known.message === "string" ? known.message : "";
  return /transaction already closed|expired transaction/i.test(message);
}

/** The one answer both write paths give when their transaction ran out of time. */
export function sendCharacterWriteBusy(reply: FastifyReply): FastifyReply {
  return sendMobileError(
    reply,
    503,
    "CHARACTER_EDIT_BUSY",
    "That change is taking longer than expected. Try again in a moment."
  );
}

/**
 * The one ladder the three library-character writes answer a failed write with.
 *
 * `POST /characters`, `PATCH /:id` and `DELETE /:id` open a transaction that
 * can hand back more failures than any one of their catches ever listed, and
 * each of them used to spell the ladder out in its own catch. Three copies of
 * one list is three lists, and
 * they had already drifted apart in every direction the copies allow: create
 * grew the timeout branch and never the conflict one, delete carried neither
 * the refusal nor the mention one, and only patch asked whether its `P2002`
 * was really a name clash. None of those gaps is a decision anybody took —
 * each is a rung somebody added to the catch in front of them.
 *
 * That matters most for the rung that is still growing. `LibraryMention` holds
 * LOCATION and OTHER beside the cast (`REPLACED_MENTION_KINDS`), and the
 * helpers that will refuse a bad one throw `LibraryMentionError` from inside
 * all three transactions — so a refusal taught to one catch would keep
 * answering 500 from the other two, for a request the route in front of it
 * already knows how to explain.
 *
 * The order is the ladder and every rung of it is load-bearing:
 *
 * - **The refusal first**, because it is the one thing here the reader typed:
 *   it arrives as a throw so the writes above it roll back, and
 *   `sendContentRestricted` is what carries the `reason` its 422 schema names.
 * - **The mention errors** next, each on the status its own code earns —
 *   `CHARACTER_NOT_FOUND` is a target that left the library (404), a name too
 *   long for somebody else's description is a collision the reader resolves by
 *   choosing again (409), and everything else is bad input (400). Create maps
 *   the 409 too although it can never raise it: only `rewriteIncomingLibraryMentions`
 *   throws that code and only a rename reaches it, so the arm is unreachable
 *   rather than wrong, and unifying it is what stops the *next* code being
 *   mapped on one route only.
 * - **The timeout above the conflicts**, because `P2028` is nobody's collision:
 *   nothing raced this write, its window closed. See `isTransactionTimeout`.
 * - **The conflicts**, which say "you lost a race, send it again as it stands".
 * - **The mention table's CHECKs**, which are the same kind of statement about
 *   a row as the uniques below and arrive in an entirely different shape —
 *   `PrismaClientUnknownRequestError`, no `P` code at all
 *   (`namesMentionCheckConstraint`).
 * - **The mention table's foreign keys**, which are the one thing down here
 *   that is nobody's bug and nothing the reader typed: `mentionedTargets`
 *   reads every target with no lock and finds it, the reader deletes that
 *   character on another device — a `DELETE` that takes the row's own
 *   `FOR UPDATE` and commits — and the `createMany` under it lands on a row
 *   that is gone. Postgres refuses with `23503`
 *   (`LibraryMention_targetCharacterId_fkey`), which matched no rung at all,
 *   so an ordinary concurrent delete cost a whole character save and answered
 *   a stack trace. It gets the same 404 and the *same sentence* as the typed
 *   rung above, because the two are one race caught at two moments — a read
 *   that saw the row and a write that did not — and it stays below that rung
 *   for the reason every fallback does: `LibraryMentionError` knows which id
 *   went and reads no constraint name to find out, so where both could speak
 *   the checked one must (`namesMentionCharacterForeignKey`).
 * - **`P2002` last**, and only a `P2002` this account can actually fix is
 *   `CHARACTER_NAME_TAKEN`; one naming the mention primary key is two PATCHes
 *   of one character colliding on the link set, which is a conflict wearing a
 *   unique violation's clothes (`namesMentionPrimaryKey`).
 *
 * The bottom three are disjoint by SQLSTATE — `23514`, `23503`, `23505` — so
 * their order *among themselves* is grouping rather than precedence, and the
 * grouping is what they are for: the database refusing a row, in the one place
 * a reader can be told about it in a sentence. Everything above them is a
 * precedence, and every one of those is argued where it is made.
 *
 * Returns whether it answered, so each catch rethrows what this does not
 * recognise instead of swallowing it — a 500 written here would be a 500 with
 * no stack trace behind it.
 */
export function sendCharacterWriteError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof ContentRestrictedError) {
    sendContentRestricted(reply, error.refusal);
    return true;
  }
  if (error instanceof LibraryMentionError) {
    const status = error.code === "CHARACTER_NOT_FOUND" ? 404 : error.code === "CHARACTER_MENTION_TOO_LONG" ? 409 : 400;
    sendMobileError(reply, status, error.code, error.message);
    return true;
  }
  if (isTransactionTimeout(error)) {
    sendCharacterWriteBusy(reply);
    return true;
  }
  if (error instanceof CharacterRowMovedError || isRetryableTransactionConflict(error)) {
    sendCharacterEditConflict(reply);
    return true;
  }
  if (namesMentionCheckConstraint(error)) {
    sendMobileError(
      reply,
      400,
      "INVALID_CHARACTER_MENTION",
      "That mention could not be saved. Remove it from the description and try again."
    );
    return true;
  }
  if (namesMentionCharacterForeignKey(error)) {
    // `mentionedTargets`' own sentence, deliberately word for word: this is
    // that check losing the race it cannot win from a read.
    sendMobileError(reply, 404, "CHARACTER_NOT_FOUND", "A mentioned character is no longer in your library.");
    return true;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    if (namesMentionPrimaryKey(error)) {
      sendCharacterEditConflict(reply);
      return true;
    }
    sendMobileError(reply, 409, "CHARACTER_NAME_TAKEN", "You already have a character with that name.");
    return true;
  }
  return false;
}

/**
 * Whether a `P2002` names `LibraryMention`'s primary key rather than
 * the library's own `[userId, name]`.
 *
 * `replaceLibraryMentions` writes the link set as a `deleteMany` followed by a
 * `createMany`, and two PATCHes of one character that are not serialized by the
 * claim above can collide on `[sourceCharacterId, targetKind, targetId]`: under
 * READ COMMITTED the loser's `deleteMany` removes nothing and its `createMany`
 * lands on rows that are already there. Mapped as every other `P2002` was, that
 * answered "You already have a character with that name" to an edit that changed
 * no name at all. Discriminated by `meta`, and defaulting to the name unique —
 * the only other one these transactions can violate, and the one an older engine
 * reports by constraint name rather than by column list.
 */
export function namesMentionPrimaryKey(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const known = error as { code?: unknown; meta?: { modelName?: unknown; target?: unknown } | undefined };
  if (known.code !== "P2002") {
    return false;
  }
  if (known.meta?.modelName === "LibraryMention") {
    return true;
  }
  const target = known.meta?.target;
  const named = Array.isArray(target) ? target.join(",") : typeof target === "string" ? target : "";
  return /sourceCharacterId|targetKind|targetId|targetCharacterId|LibraryMention/.test(named);
}

/**
 * Every field a constraint failure can be carrying its SQLSTATE, its constraint
 * name or its table in, flattened into one string for the predicates below to
 * match against.
 *
 * **One violation, many shapes**, which is why nothing that reads this asks
 * `instanceof` anything. Prisma models some constraint failures and not others:
 * a foreign key comes back as `P2003` with the constraint name in the message
 * and — under `@prisma/adapter-pg` on Prisma 7.8 — again inside
 * `meta.driverAdapterError.cause`, beside the raw `23503` the connector
 * reported; a CHECK is modelled not at all and arrives as a
 * `PrismaClientUnknownRequestError` carrying the SQLSTATE and the constraint
 * name in prose with no `P` code; a statement Prisma does not model hands back
 * whatever the driver said and nothing else. Reading all of those places and
 * then asking one regex is what lets a rung answer for its own violation
 * however it was reported.
 *
 * **Where a driver puts a SQLSTATE is the one fact here, and it used to be
 * written down three times** — twice in this file and once as
 * `namesOrphanedCharacterImage` in `characterPhotoWrites.ts` — with only the final
 * regex differing between the copies. That is one adapter release away from
 * being fixed in one place and left wrong in two, which for these predicates is
 * not a cosmetic drift: each of them exists to turn an ordinary concurrent
 * delete into a 404 or a 409, so a traversal that stops finding the code hands
 * the reader a 500 for a gesture they made deliberately.
 *
 * It is the **union** of what those three copies read, and the widening is
 * deliberate. `namesMentionCheckConstraint` looked at `message`, `meta.code`,
 * `meta.constraint` and `meta.column_name` only, so a CHECK the adapter
 * reported the way it reports a foreign key was invisible to it — a gap that
 * existed only because the foreign-key rung was written later, not because a
 * CHECK cannot arrive that way. A wider blob can never take a match away: the
 * added fields are interleaved with the old ones rather than replacing them,
 * and every regex over this is a single token rather than one spanning two
 * fields, so no predicate can stop answering where it answers today. It can
 * only start answering for its own constraint in a shape it did not know about.
 */
export function constraintErrorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const known = error as {
    code?: unknown;
    message?: unknown;
    meta?:
      | {
          code?: unknown;
          modelName?: unknown;
          constraint?: unknown;
          field_name?: unknown;
          column_name?: unknown;
          driverAdapterError?:
            | { cause?: { originalCode?: unknown; originalMessage?: unknown; constraint?: { index?: unknown } } }
            | undefined;
        }
      | undefined;
  };
  const cause = known.meta?.driverAdapterError?.cause;
  return [
    known.code,
    known.meta?.code,
    known.meta?.modelName,
    known.meta?.constraint,
    known.meta?.field_name,
    known.meta?.column_name,
    cause?.originalCode,
    cause?.originalMessage,
    cause?.constraint?.index,
    known.message
  ]
    .map((value) => (typeof value === "string" ? value : ""))
    .join(" ");
}

/**
 * Whether a failure is one of `LibraryMention`'s CHECK constraints refusing the
 * row a write was building.
 *
 * `LibraryMention_target_arc` and `LibraryMention_not_self`
 * (`prisma/migrations/000058_library_mentions`) are the database's copy of
 * rules this API states in TypeScript: a CHARACTER row's `targetCharacterId` is
 * its `targetId` and carries no `otherType`, LOCATION and OTHER carry no
 * character at all, an OTHER row's subtype is trimmed and 1..80 characters, and
 * nobody mentions themselves. Every one of those is checked before the write —
 * `replaceLibraryMentions` refuses a self-mention by name, the batch stamps one
 * kind — so reaching Postgres with a row that fails them is a bug on this side
 * rather than something the reader typed. That does not make a 500 the right
 * answer: it is a whole character save lost to a stack trace, on a route whose
 * every other refusal comes back as a sentence the editor sheet can show.
 *
 * **The constraint's own name is enough wherever anything reports one**;
 * `23514` alone is not, because it is every CHECK in the schema, so the bare
 * code only answers for a failure that also names this table. Which field
 * either of them arrived in is `constraintErrorText`'s business — a CHECK is
 * the one violation on this ladder Prisma models not at all, so it usually
 * comes back as a `PrismaClientUnknownRequestError` with both in prose, the way
 * `isRetryableTransactionConflict` meets a `40P01`.
 */
export function namesMentionCheckConstraint(error: unknown): boolean {
  const text = constraintErrorText(error);
  if (/LibraryMention_(target_arc|not_self)/.test(text)) {
    return true;
  }
  if (/\b23514\b/.test(text) && /LibraryMention/.test(text)) {
    return true;
  }
  // The subtype's length rule is stated twice — `@db.VarChar(80)` on the column
  // and `BETWEEN 1 AND 80` inside `LibraryMention_target_arc` — and Postgres
  // reaches the narrower one first: an over-long value raises 22001 (Prisma
  // `P2000`) before the CHECK is ever evaluated, so the same rule arrives under
  // two different codes depending only on which half it broke. Zod bounds this
  // at the door now, so this is the net under a writer that skips it, not a
  // path a request can reach.
  return /\bP2000\b|\b22001\b/.test(text) && /otherType|LibraryMention/.test(text);
}

/**
 * Whether a failure is one of `LibraryMention`'s foreign keys refusing a link
 * to a character that is no longer there.
 *
 * The race is ordinary and nothing on this side prevents it.
 * `replaceLibraryMentions` calls `mentionedTargets`, which SELECTs every target
 * with **no lock** and finds them all; the reader deletes one of those
 * characters on their other device, and that `DELETE` takes the row's own
 * `FOR UPDATE` and commits; the `createMany` under it then violates
 * `LibraryMention_targetCharacterId_fkey`. Nothing here is wrong — the read was
 * true when it was taken — which is what made the 500 so expensive: a whole
 * character save, prose and link set together, lost to a stack trace over a
 * delete the same reader had just performed, when the answer the race deserves
 * was already written one rung up.
 *
 * **Both of this table's foreign keys point at `LibraryCharacter`**, which is
 * what lets one rung answer for either without asking which:
 * `sourceCharacterId` and `targetCharacterId` are the only two it has, so a
 * `23503` naming this table is a character that went away while a link to it
 * was being written, and there is no third thing it can be. Only the target end
 * is actually reachable — `PATCH /:id` holds the source under
 * `claimCharacterRow`, so a delete of it queues behind that lock rather than
 * landing under this write, and `POST /characters` inserts the source in the
 * same transaction — so the sentence this answers with is `mentionedTargets`'
 * own, word for word. The one case it could be wrong about is a source
 * cascaded away with the whole account, which has a 401 waiting for it on the
 * reader's next request regardless.
 *
 * The constraint name alone is enough wherever something reports one, and
 * `constraintErrorText` owns the question of where that is. `23503` alone is
 * not enough, because it is every foreign key in the schema —
 * `LibraryCharacter_userId_fkey` is one, and an account cascaded out from under
 * a write is not "a character you mentioned is gone" — so the bare code only
 * answers for a failure that also names this table.
 */
export function namesMentionCharacterForeignKey(error: unknown): boolean {
  const text = constraintErrorText(error);
  if (/LibraryMention_[A-Za-z]+_fkey/.test(text)) {
    return true;
  }
  return /\bP2003\b|\b23503\b/.test(text) && /LibraryMention/.test(text);
}
