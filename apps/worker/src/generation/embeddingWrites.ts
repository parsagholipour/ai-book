import { randomUUID } from "node:crypto";
import { type EmbeddingAdapter } from "@book-maker/core";
import { degradeRetrievalArm, prisma } from "@book-maker/db";
import { config } from "../runtime/config.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";

/**
 * What goes into the `Embedding` table, and under what conditions it may
 * replace what is already there.
 *
 * Every raw statement this feature issues is written here — the vector upsert,
 * the one vectorless upsert both failure writes share, and the conflict policy
 * that decides which row each may land on. The readers are `semanticRecall.ts`
 * and `researchMemory.ts`; `embeddingRepair.ts` is the caller that has to know
 * which of the three answers below it got.
 *
 * Whether a book writes any of it is `strategyUsesSemanticMemory`, immediately
 * below — the gate every writer asks before it spends the call.
 */

/**
 * Only the sequential-pages strategy ever *reads* this memory — page jobs are
 * the one consumer of `retrieveSemanticPageMemory`, `loadEntityStateLines`,
 * and the semantic research branch. Every other mode (which covers every book
 * inside the mobile page ceiling) used to pay an embedding call per page plus
 * per-entity writes for rows nothing would ever query. Writers gate on this.
 *
 * It lives beside the writes rather than beside the recall it is named for
 * because *writers* are the whole of its audience: every call site — the two
 * book passes, the page review, `generateBook`, `importBook`, `applyBookEdit`,
 * `planning` and the final-QA repair in `compileExport` — is about to spend an
 * embedding call and is asking whether anything will ever read it. Sitting in
 * `semanticRecall.ts` it made all seven import the read module for a
 * predicate that never reaches a retrieval.
 */
export function strategyUsesSemanticMemory(strategy: { executionMode: string }): boolean {
  return strategy.executionMode === "sequential-pages";
}

/**
 * An embedded vector held in memory, or the failure that stands in for one.
 * Produced by `prepareEmbedding` and consumed by `writePreparedEmbedding`.
 */
export type PreparedEmbedding = { vectorLiteral: string | null; error: string | null };

/**
 * The provider half of `storeEmbedding`, split out so a caller publishing under
 * an ownership fence can spend the embedding call *before* the fence and leave
 * only the insert behind it. Writes nothing, and fails the way the combined
 * call did: an embedding a provider could not produce becomes the degraded row
 * rather than an error, because a missing vector must not fail a written page.
 *
 * **A user stop is not a provider failure, and it is the one error that still
 * travels.** `LoggingEmbeddingAdapter.embed` raises `StopRequestedError` as soon
 * as the reader stops the run, and folding that into `{ vectorLiteral: null,
 * error }` made every caller read a cancellation as text the provider would not
 * embed. In `repairPageEmbeddings` that is written down as a refusal — a
 * vectorless placeholder stamped with `repairAttempts` and a *doubling*
 * `repairRetryFromIndex` — so a page whose summary embeds perfectly well was
 * exponentially deferred for a reason that has nothing to do with the provider,
 * while the loop spent the rest of its batch on a run already settling. The
 * swallow was also the odd one out: `writePreparedEmbedding` already lets a stop
 * out of the insert, and `keeperStoryExtractForSave` — the model call directly
 * above this one in `pageReview.ts` — swallows every failure but this one.
 */
export async function prepareEmbedding(text: string, embedding: EmbeddingAdapter): Promise<PreparedEmbedding> {
  try {
    const vector = await embedding.embed(text);
    return { vectorLiteral: `[${vector.map((value) => Number(value).toFixed(7)).join(",")}]`, error: null };
  } catch (error) {
    if (isStopRequestedError(error)) {
      throw error;
    }
    return { vectorLiteral: null, error: embeddingErrorMessage(error) };
  }
}

/**
 * Whether the row now holds a vector, only the degraded placeholder, or nothing
 * at all because the scope had changed hands by the time the write ran. Every
 * caller but `repairPageEmbeddings` writes once and moves on; the repair pass
 * has to know, because a call it cannot turn into a vector is one it must stop
 * paying for — and a scope that is no longer its page's is neither a refusal
 * nor a repair, so it must be charged as neither.
 */
export type EmbeddingWriteOutcome = "stored" | "degraded" | "superseded";

/**
 * What the upsert below may do to a `(projectId, scope)` row that already
 * exists.
 *
 * `"overwrite"` is what a page that has just been *written* owes its own memory
 * row, and it is the default because it is what almost every caller is doing:
 * `storeEmbedding` and `pageReview.ts` publish prose that is new, so the row
 * under that scope has to take the new summary and vector whether it held one
 * before or not.
 *
 * `"same-page"` is for a writer whose knowledge of which page owns the scope is
 * older than the write itself — `repairPageEmbeddings`, which resolves its
 * targets and then spends a provider call before it writes anything. A
 * `page:<index>` scope names a *position*, and `repointPageEmbeddings` hands
 * positions to other pages: a structural edit landing inside that window means
 * the row the repair was dispatched for now belongs to a different page, and
 * an unguarded `DO UPDATE` would replace that page's summary, vector and
 * `sourceId` with the target's. That is the wrong answer nothing detects which
 * `deletePageEmbeddings` exists to prevent — a page whose embedding describes a
 * different page — arrived at from the other end. The predicate is the row's
 * own `sourceId`, the one column a renumber carries rather than rewrites, so
 * the write may only land where it was aimed; a row whose `sourceId` is NULL is
 * claimed by no page at all (nothing re-points or deletes it) and stays
 * repairable, or its attempt count could never advance.
 */
export type EmbeddingConflictPolicy = "overwrite" | "same-page";

/**
 * The row a write is aimed at: where it lands (`projectId`, `scope`), which page
 * or source claims it, the prose it stores, and what it may do to a row already
 * under that scope.
 *
 * Every statement in this file takes exactly this shape — the two entry points
 * as well as the three writes behind them — and it is one named type because
 * the alternative was four same-typed strings in a row. A `scope` and a
 * `sourceId` transposed at a call site typechecks, and lands a row whose scope
 * is a page id describing text keyed by an index: the same wrong answer nothing
 * detects that `deletePageEmbeddings` and the `"same-page"` policy exist to
 * prevent, reached from the argument list. Named fields make it unspellable.
 *
 * `conflict` is absent for every caller that has just *written* the page, since
 * the row under its scope is that caller's to replace outright, and absent is
 * `"overwrite"`; {@link EmbeddingConflictPolicy} is where the difference is
 * argued.
 */
export type EmbeddingWriteTarget = {
  projectId: string;
  scope: string;
  sourceId: string;
  text: string;
  conflict?: EmbeddingConflictPolicy;
};

/**
 * The `"same-page"` predicate itself, written once so the two statements that
 * may take it cannot drift apart. `EXCLUDED."sourceId"` is the call's own, so
 * it reads "land only on the row I was aimed at"; NULL is a row no page claims.
 */
const SAME_PAGE_ROW_PREDICATE = `"Embedding"."sourceId" = EXCLUDED."sourceId" OR "Embedding"."sourceId" IS NULL`;

/**
 * The write half: one upsert, no provider call, nothing long to straddle.
 *
 * **Neither branch may fail its caller.** `storeEmbedding` is the last
 * statement of a page job before `enqueueNextPageIfReady`, and in
 * `pageReview.ts` this write sits after the ownership fence among the
 * publishing writes — so an error leaving here stops the fan-out of a book
 * whose page is already saved and COMPLETED, and does it on every page of
 * every book. Both statements below name `ON CONFLICT ("projectId", "scope")`,
 * which needs the unique index migration `000056_embedding_project_scope_unique`
 * creates: on a database where `000055_trigram_memory_search` could not
 * `CREATE EXTENSION pg_trgm` — no superuser on a managed Postgres —
 * `prisma migrate deploy` halts there and never reaches 000056, and Postgres
 * then answers both with `there is no unique or exclusion constraint matching
 * the ON CONFLICT specification`. That is the same deployment
 * `degradeRetrievalArm` is written for, so this write takes its policy: an
 * embedding that cannot be persisted degrades what later pages recall, it never
 * settles the job around it. `StopRequestedError` is the one thing that still
 * travels — swallowing it would keep a stopped run drafting.
 *
 * The target's `conflict` is absent — and so `"overwrite"` — unless a caller
 * says otherwise, because a caller that has just written the page owns the row
 * under its scope outright. Only `repairPageEmbeddings` names `"same-page"`,
 * and {@link EmbeddingConflictPolicy} is where the difference is argued.
 */
export async function writePreparedEmbedding(
  target: EmbeddingWriteTarget,
  prepared: PreparedEmbedding
): Promise<EmbeddingWriteOutcome> {
  if (prepared.vectorLiteral) {
    // A `DO UPDATE ... WHERE` rather than a separate read because the check and
    // the write have to be one statement: anything between them is another
    // window of the kind this exists to close.
    const sameSourceGuard =
      target.conflict === "same-page"
        ? `
       WHERE ${SAME_PAGE_ROW_PREDICATE}`
        : "";
    try {
      const written = await prisma.$executeRawUnsafe(
        `INSERT INTO "Embedding" ("id", "projectId", "scope", "sourceId", "text", "vector", "metadata")
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
       ON CONFLICT ("projectId", "scope") DO UPDATE SET
         "sourceId" = EXCLUDED."sourceId",
         "text" = EXCLUDED."text",
         "vector" = EXCLUDED."vector",
         "metadata" = EXCLUDED."metadata"${sameSourceGuard}`,
        randomUUID(),
        target.projectId,
        target.scope,
        target.sourceId,
        target.text,
        prepared.vectorLiteral,
        JSON.stringify({ provider: config.MOCK_AI ? "fake" : "gemini" })
      );
      // Only a guarded write can match nothing: an unguarded upsert either
      // inserts or updates, so `written` is 1 and this is unreachable for it.
      return target.conflict === "same-page" && written === 0 ? "superseded" : "stored";
    } catch (error) {
      if (isStopRequestedError(error)) {
        throw error;
      }
      await createDegradedEmbedding(target, embeddingErrorMessage(error));
      return "degraded";
    }
  }
  await createDegradedEmbedding(target, prepared.error ?? "Unknown embedding error");
  return "degraded";
}

export async function storeEmbedding(target: EmbeddingWriteTarget, embedding: EmbeddingAdapter) {
  await writePreparedEmbedding(target, await prepareEmbedding(target.text, embedding));
}

function embeddingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown embedding error";
}

/**
 * The vectorless upsert — the one place its columns, its conflict target, its
 * `SET` list and its guards are written. Both writes that reach it answer a
 * failure, so both want exactly this row, differing only in the metadata they
 * stamp on it and in what they owe their caller when the write itself fails.
 * It is one statement because the two drifted once: the repair's backoff stamp
 * lost the ownership predicate, and so could put its target's summary onto
 * whichever page a re-point had since handed the scope to — "a page whose
 * embedding describes a different page is a wrong answer nothing detects",
 * through the one door the guarded vector upsert had left open.
 *
 * `"vector" IS NULL` is unconditional: both callers are reached only *after*
 * something failed, so a row that holds a vector belongs to a writer that
 * succeeded and is left alone. It cannot stand in for the ownership predicate,
 * which a re-point makes true of degraded rows as readily as healthy ones.
 * Neither may become `DO NOTHING`: the row has to be *refreshed*, or a
 * placeholder left from an earlier draft answers for prose the book no longer
 * holds (`text`), under the id a renumber carries it by and a delete removes it
 * by (`sourceId`), with an `error` and a backoff earned by text that is gone
 * (`metadata`). Both must still land on a row that already *exists*, or a
 * repair's attempt count could never pass one. `vector` is neither inserted nor
 * set, which leaves the row degraded and so still a repair target.
 *
 * `conflict` is the caller's ({@link EmbeddingConflictPolicy}). Answers with
 * the rows matched — 0 when a guard refused — and raises, because the two
 * callers settle a failed write differently.
 */
function upsertVectorlessEmbedding(row: EmbeddingWriteTarget, metadata: Record<string, unknown>): Promise<number> {
  const samePageGuard = row.conflict === "same-page" ? ` AND (${SAME_PAGE_ROW_PREDICATE})` : "";
  return prisma.$executeRawUnsafe(
    `INSERT INTO "Embedding" ("id", "projectId", "scope", "sourceId", "text", "metadata")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT ("projectId", "scope") DO UPDATE SET
       "sourceId" = EXCLUDED."sourceId",
       "text" = EXCLUDED."text",
       "metadata" = EXCLUDED."metadata"
     WHERE "Embedding"."vector" IS NULL${samePageGuard}`,
    randomUUID(),
    row.projectId,
    row.scope,
    row.sourceId,
    row.text,
    JSON.stringify(metadata)
  );
}

/**
 * A repair attempt that produced no vector: the row above, stamped with the
 * attempt count and the index the scope becomes a target from again — what
 * takes it out of the hole set meanwhile. `conflict` is an acknowledgement
 * rather than a switch, the type admitting only the policy this caller may use,
 * because every write the repair pass makes is dispatched against a stale
 * reading of who owns the scope. Failure is the repair loop's to settle — it
 * has a catch of its own, and a stamp swallowed here would leave a refusal
 * recorded nowhere — so this write raises where the fallback below may not.
 */
export function recordFailedEmbeddingRepair(
  options: EmbeddingWriteTarget & {
    attempts: number;
    retryFromIndex: number;
    error: string;
    conflict: Extract<EmbeddingConflictPolicy, "same-page">;
  }
): Promise<number> {
  const { attempts, retryFromIndex, error, ...row } = options;
  const stamp = { vectorStored: false, error, repairAttempts: attempts, repairRetryFromIndex: retryFromIndex };
  return upsertVectorlessEmbedding(row, stamp);
}

/**
 * The same row without the backoff — what every failed embedding falls back to,
 * and the last statement between a memory write and the job, so it swallows its
 * own failure rather than raising into a caller that reached it *because*
 * something already failed ({@link writePreparedEmbedding} argues why nothing
 * may escape here). `degradeRetrievalArm` carries the reporting policy: the
 * fault is an environment fact true of every page of every book, so it is
 * logged on the first occurrence and every power of ten after rather than once
 * per page job, and `rethrowIf: isStopRequestedError` is the one thing that
 * still travels out. `conflict` is the caller's: every caller but the repair
 * pass has just written the page and claims the scope outright, and guarding
 * *those* would refuse the row a structurally inserted page inherited and leave
 * the stale summary standing.
 */
async function createDegradedEmbedding(row: EmbeddingWriteTarget, error: string): Promise<void> {
  try {
    await upsertVectorlessEmbedding(row, { vectorStored: false, error });
  } catch (writeError) {
    degradeRetrievalArm<undefined>({
      arm: "Degraded embedding write",
      projectId: row.projectId,
      error: writeError,
      fallback: undefined,
      rethrowIf: isStopRequestedError
    });
  }
}
