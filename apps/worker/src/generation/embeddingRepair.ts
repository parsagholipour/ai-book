import { type EmbeddingAdapter } from "@book-maker/core";
import { degradeRetrievalArm, findPageEmbeddingRepairTargets, pageScope } from "@book-maker/db";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { prepareEmbedding, recordFailedEmbeddingRepair, writePreparedEmbedding } from "./embeddingWrites.js";

/**
 * The backfill that keeps long-range recall from going permanently blind: a few
 * page summaries per page job whose `Embedding` row is missing or degraded,
 * re-embedded and written back.
 *
 * It is the one caller of `embeddingWrites.ts` whose knowledge of which page
 * owns a `page:<index>` scope is older than its own write, which is why the
 * `"same-page"` conflict policy exists and why this pass is the only thing that
 * asks for it.
 */

/**
 * Arm name for {@link degradeRetrievalArm}, and so the key of its failure
 * census. This pass runs on every page job past the recency window, and what
 * takes it down whole is an environment fact — the same missing extension or
 * missing unique index the writes below meet — so the ladder is what keeps one
 * broken deployment from costing a 300-page book 300 identical lines.
 */
const EMBEDDING_REPAIR_ARM = "Embedding repair";

/** How many page embeddings a single page job will try to backfill. */
export const EMBEDDING_REPAIR_BATCH = 3;

/**
 * Ceiling on the backoff below, in page indexes. Reached after nine consecutive
 * failures, which no book this product generates gets near.
 */
const EMBEDDING_REPAIR_BACKOFF_CAP_PAGES = 512;

/**
 * How far ahead a scope whose repair just failed stops being a target, measured
 * in page indexes because that is the only clock this pass has: `beforeIndex`
 * advances with the manuscript, roughly once per page job.
 *
 * Doubling, rather than a hard attempt cap, because the two failures that look
 * identical here are not the same thing. A page whose summary a provider will
 * never embed (a content filter on its own text) must stop costing a call per
 * page job; a provider *outage* fails every page alike and must be forgiven the
 * moment it ends. Doubling does both: an unembeddable page costs ~log2(N) calls
 * over an N-page book instead of one per page job, while every scope an outage
 * degraded re-opens on its own, a little later each time, with nothing needed to
 * declare the outage over.
 */
function embeddingRepairBackoffPages(attempts: number): number {
  return Math.min(EMBEDDING_REPAIR_BACKOFF_CAP_PAGES, 2 ** Math.max(1, attempts));
}

/**
 * Re-embeds a few page summaries whose embedding row is missing or degraded, so
 * long-range retrieval is not permanently blind to pages an earlier embedding
 * outage left without a vector. Structural Undo also deletes embeddings without
 * restoring them; this backfill only reaches those holes if `generatePage` runs
 * again — a finished book that is undone and never generates another page is
 * not repaired here.
 *
 * Bounded two ways, both cost/race-reduction heuristics rather than uniqueness
 * guarantees. It only touches pages with `index < beforeIndex`, which the
 * caller sets a full recency window behind the page being drafted: a page is
 * marked COMPLETED before its own `storeEmbedding` runs, and waves are top-up
 * based, so a sibling still near the front — or lagged in BullMQ retry backoff
 * well behind the frontier — may simply not have reached that write yet.
 * Repairing it here would race the owner's write; uniqueness plus upsert on
 * `(projectId, scope)` is what settles a second insert, not this window. And it
 * repairs at most `limit` per call, spreading the cost of a big backlog across
 * the pages that follow.
 *
 * **A failed repair is written down, and that is what bounds it.** The holes are
 * taken lowest index first, so a page whose summary a provider refuses used to
 * be first in the queue forever: the failure path recorded nothing, the scope
 * never left the hole set, and every one of the hundreds of page jobs that
 * followed spent an embedding call — billed, logged, on the page critical path —
 * re-failing on it, while permanently holding one of the `limit` slots that real
 * holes further along needed. A failure now writes (or refreshes) the degraded
 * placeholder with an attempt count and the page index it becomes a target again
 * from, so the scope leaves the hole set until its backoff expires and the other
 * two slots go to pages that can actually be repaired. The placeholder is worth
 * writing on its own account: a scope with no row at all is invisible to *both*
 * arms of the retrieval, while a vectorless row still carries the page's real
 * summary as `text` and so can still be recalled lexically. A user stop is not
 * one of those failures and is never written down as one — it leaves through
 * the catch below, so the batch stops where it stands and the page it
 * interrupted stays an ordinary hole for the next run to fill.
 *
 * **The hole set is a query, not a scan.** This used to load every COMPLETED
 * page below `beforeIndex` — summaries included — and every `page:` embedding
 * row of the project, build two maps and throw them away: ~230 pages of summary
 * text on each of a 300-page book's 280 page jobs past the recency window, to
 * conclude nothing was broken. `findPageEmbeddingRepairTargets`
 * (`packages/db/src/embeddingRepairTargets.ts`) derives it in SQL, at most
 * `limit` rows, as a `NOT EXISTS` anti-join and never the `LEFT JOIN … IS NULL`
 * it is equivalent to: only the anti-join stops at the third hole, and the plans
 * are measured there. The predicate order carries over exactly: the backoff is a
 * `WHERE` clause and `LIMIT` is applied after it, which keeps a backed-off scope
 * out of the slots rather than merely skipped once it holds one.
 *
 * Bounded, not exact: a wave of page jobs reads the same rows before any of them
 * writes, so one backoff window admits up to `MAX_PARALLEL_PAGE_JOBS` attempts —
 * the same race the `(projectId, scope)` unique index settles for duplicate
 * inserts. Best effort throughout: any error but a user stop degrades the whole
 * pass to a no-op, through the shared `degradeRetrievalArm` policy, so a fault
 * true of every page job is reported on its ladder rather than once per page.
 */
export async function repairPageEmbeddings(options: {
  projectId: string;
  embedding: EmbeddingAdapter;
  /** Exclusive upper bound on page index. A cost/race-reduction heuristic, not a uniqueness guarantee. */
  beforeIndex: number;
  limit?: number | undefined;
}): Promise<void> {
  if (options.beforeIndex < 2) {
    return;
  }
  const limit = options.limit ?? EMBEDDING_REPAIR_BATCH;
  try {
    // The hole set is derived in SQL — see `findPageEmbeddingRepairTargets` —
    // so the `LIMIT` is applied *after* the backoff predicate and this pass
    // reads at most `limit` summaries instead of the whole manuscript.
    const targets = await findPageEmbeddingRepairTargets({
      projectId: options.projectId,
      beforeIndex: options.beforeIndex,
      limit
    });
    for (const target of targets) {
      const scope = pageScope(target.index);
      const prepared = await prepareEmbedding(target.summary, options.embedding);
      // **Both writes below are `"same-page"`, and the provider call above is
      // what earns it.** The targets were resolved before it, a `page:<index>`
      // scope names a *position*, and a structural edit committing in that
      // window re-points it onto another page — so the row under `scope` may be
      // a live page's by now, and `"vector" IS NULL` is no defence, being true
      // of the very row to refuse. The vector write is otherwise the shared
      // upsert: it overwrites a degraded placeholder whole, so a later success
      // upgrades the row rather than leaving a repaired page looking degraded.
      const outcome = prepared.vectorLiteral
        ? await writePreparedEmbedding(
            { projectId: options.projectId, scope, sourceId: target.pageId, text: target.summary, conflict: "same-page" },
            prepared
          )
        : "degraded";
      if (outcome === "stored" || outcome === "superseded") {
        // `"superseded"`: the scope changed hands mid-call, so nothing was
        // written, and nothing may be stamped either — the backoff belongs to
        // the row, and the row is now another page's.
        continue;
      }
      // A vector the provider would not give *and* one the insert would not
      // take both cost a provider call, so both charge the backoff. A user stop
      // charges neither: `prepareEmbedding` and `writePreparedEmbedding` each
      // raise it, so the batch is abandoned in the catch below rather than
      // stamped here as a refusal the page never earned. The stamp lands by
      // scope like the write above, so it takes the same guard and may match
      // nothing in the same way — which ends this target rather than needing a
      // write around it: a renumber carries each page's rows by `sourceId`, so
      // a moved page is still a hole under its new index, and the query offers
      // it there on a later pass, unpenalised, on a scope no one else holds.
      const attempts = target.attempts + 1;
      await recordFailedEmbeddingRepair({
        projectId: options.projectId,
        scope,
        sourceId: target.pageId,
        text: target.summary,
        attempts,
        retryFromIndex: options.beforeIndex + embeddingRepairBackoffPages(attempts),
        error: prepared.error ?? "Embedding repair stored no vector",
        conflict: "same-page"
      });
    }
  } catch (error) {
    degradeRetrievalArm<undefined>({
      arm: EMBEDDING_REPAIR_ARM,
      projectId: options.projectId,
      error,
      fallback: undefined,
      // The rethrow this replaced, and the one thing the shared policy may not
      // swallow here: the reader stopped the run mid-batch, and abandoning the
      // remaining targets is the whole point — each is another provider call
      // against a job that is already settling, and none of them may leave a
      // backoff stamp behind.
      rethrowIf: isStopRequestedError
    });
  }
}
