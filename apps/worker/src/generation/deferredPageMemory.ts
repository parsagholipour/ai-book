import { randomUUID } from "node:crypto";
import {
  applyStoryDelta,
  foldCharacterName,
  parseStoryState,
  seedStoryStateFromPromises,
  type BookGenerationStrategy,
  type BookPlan,
  type CreateProjectInput,
  type PageDraft,
  type ProviderSet,
  type StoryDelta,
  type StoryState
} from "@book-maker/core";
import { degradeRetrievalArm, pageScope, Prisma } from "@book-maker/db";
import { config } from "../runtime/config.js";
import { isStopRequestedError } from "../runtime/jobTypes.js";
import { runBestEffortPageMemoryWrite } from "./bestEffortSavepoint.js";
import { prepareEmbedding, strategyUsesSemanticMemory } from "./embeddingWrites.js";
import { foldedMentions } from "./entityMentions.js";
import { updateEntityStateFromPage } from "./entityState.js";
import {
  keeperStoryExtractForSave,
  type QualityGateContext
} from "./qualityEnrichment.js";

export type DeferredPageMemoryCandidate = {
  pageIndex: number;
  draft: PageDraft;
};

export type PreparedDeferredPageMemory = DeferredPageMemoryCandidate & {
  preparedEmbedding: Awaited<ReturnType<typeof prepareEmbedding>> | null;
  storyExtract: Awaited<ReturnType<typeof keeperStoryExtractForSave>>;
};

/** A prepared page beside the row id the publication created for it. */
type PublishedPageMemory = PreparedDeferredPageMemory & { pageId: string };

type MemoryBatchOptions = {
  tx: Prisma.TransactionClient;
  projectId: string;
  plan: BookPlan;
};

export async function prepareDeferredPageStoryContext(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  quality: QualityGateContext;
  currentStoryState: StoryState;
  candidate: DeferredPageMemoryCandidate;
}): Promise<{
  storyExtract: Awaited<ReturnType<typeof keeperStoryExtractForSave>>;
  nextStoryState: StoryState;
}> {
  const storyExtract = await keeperStoryExtractForSave({
    projectId: options.projectId,
    pageIndex: options.candidate.pageIndex,
    draft: options.candidate.draft,
    textModel: options.providers.text,
    plan: options.plan,
    input: options.input,
    previousExtract: null,
    keeperWasRevised: true,
    currentState: options.currentStoryState,
    quality: options.quality
  });
  return {
    storyExtract,
    nextStoryState: storyExtract
      ? applyStoryDelta(options.currentStoryState, storyExtract.storyDelta, options.candidate.pageIndex)
      : options.currentStoryState
  };
}

/**
 * Spends every provider call required by deferred page memory before the final
 * manuscript transaction. Story extracts are prepared in page order so each
 * later extract sees the facts accepted from the earlier in-memory keeper.
 */
export async function prepareDeferredPageMemory(options: {
  projectId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  providers: ProviderSet;
  strategy: BookGenerationStrategy;
  quality: QualityGateContext;
  initialStoryState: StoryState;
  candidates: readonly DeferredPageMemoryCandidate[];
  assertOwnership?: (() => Promise<void>) | undefined;
}): Promise<PreparedDeferredPageMemory[]> {
  let currentState = options.initialStoryState;
  const prepared: PreparedDeferredPageMemory[] = [];
  for (const candidate of [...options.candidates].sort((left, right) => left.pageIndex - right.pageIndex)) {
    await options.assertOwnership?.();
    const storyContext = await prepareDeferredPageStoryContext({
      projectId: options.projectId,
      input: options.input,
      plan: options.plan,
      providers: options.providers,
      quality: options.quality,
      currentStoryState: currentState,
      candidate
    });
    currentState = storyContext.nextStoryState;
    const preparedEmbedding = strategyUsesSemanticMemory(options.strategy)
      ? await prepareEmbedding(candidate.draft.summary, options.providers.embedding)
      : null;
    await options.assertOwnership?.();
    prepared.push({ ...candidate, preparedEmbedding, storyExtract: storyContext.storyExtract });
  }
  return prepared;
}

/**
 * Publishes memory for prose already created in the caller's authoritative
 * transaction. Continuity notes are durable manuscript context. The remaining
 * semantic arms are best-effort and each gets its own savepoint, so even a
 * swallowed PostgreSQL statement error cannot poison the prose transaction.
 *
 * **Every arm is written once for the batch, because the budget belongs to the
 * caller's transaction rather than to a page.** Both callers run this inside
 * `MANUSCRIPT_PUBLICATION_TRANSACTION_OPTIONS` — 30 s — while they hold the
 * Project row Stop takes first, and a whole-book replan hands it every page of
 * the book (`targetPages` reaches 600). A per-page loop was 12–25 statements a
 * page: three SAVEPOINT/RELEASE pairs, a `createMany`, a page-delta write, a
 * read-modify-write of the whole `Project.storyState` document, two full-cast
 * reads plus a compare-and-swap for every entity named, and an embedding
 * upsert. That is 1,500–2,500 round trips for a hundred pages inside a budget
 * whose expiry rolls back the entire published manuscript — every retry
 * reproducing it, after all the drafting, review and adherence work has been
 * paid for. The same rows are written now, in statements bounded by the
 * project's cast instead of by its length: one note insert, one page-delta
 * update, one fold of the story state the batch read, one entity pass, and one
 * embedding upsert.
 */
export async function persistPreparedDeferredPageMemory(options: {
  tx: Prisma.TransactionClient;
  projectId: string;
  plan: BookPlan;
  strategyId: string;
  pageIds: ReadonlyMap<number, string>;
  prepared: readonly PreparedDeferredPageMemory[];
  tags?: readonly string[] | undefined;
}): Promise<void> {
  // Sorted here rather than assumed of the caller: the story fold and the
  // entity pass are both order-sensitive, and page order is the order the
  // extracts were prepared in. Both callers already sort, so this changes
  // nothing they publish; it is what makes the batch's own claim true.
  const pages: PublishedPageMemory[] = [...options.prepared]
    .sort((left, right) => left.pageIndex - right.pageIndex)
    .map((candidate) => {
      const pageId = options.pageIds.get(candidate.pageIndex);
      if (!pageId) {
        throw new Error(`Deferred page memory could not resolve page ${candidate.pageIndex}`);
      }
      return { ...candidate, pageId };
    });
  if (pages.length === 0) {
    return;
  }
  await writeContinuityNotes(options, pages);
  await writeStoryMemory(options, pages);
  await writeEntityState(options, pages);
  await writePageEmbeddings(options, pages);
}

/**
 * Rows per `createMany`. PostgreSQL binds at most 65,535 parameters to one
 * statement and Prisma sends `createMany` as a single multi-row INSERT, so a
 * six-hundred-page book with a talkative continuity pass could overrun one
 * insert — and this is the arm whose failure fails the manuscript, so it may
 * not be the arm that learns that in production. Every book this product makes
 * today still publishes its notes in one statement.
 */
const CONTINUITY_NOTE_INSERT_CHUNK = 1_000;

/**
 * Durable manuscript context, so this arm alone is not best-effort: notes that
 * cannot be written fail the publication with everything else in it.
 */
async function writeContinuityNotes(
  options: {
    tx: Prisma.TransactionClient;
    projectId: string;
    strategyId: string;
    tags?: readonly string[] | undefined;
  },
  pages: readonly PublishedPageMemory[]
): Promise<void> {
  const data = pages.flatMap((page) =>
    page.draft.continuityNotes.map((body) => ({
      projectId: options.projectId,
      pageId: page.pageId,
      scope: pageScope(page.pageIndex),
      body,
      tags: ["page", String(page.pageIndex), options.strategyId, ...(options.tags ?? [])]
    }))
  );
  for (let from = 0; from < data.length; from += CONTINUITY_NOTE_INSERT_CHUNK) {
    await options.tx.continuityNote.createMany({
      data: data.slice(from, from + CONTINUITY_NOTE_INSERT_CHUNK)
    });
  }
}

/**
 * The batch's story memory: each page's own delta, and one fold of them onto
 * `Project.storyState`.
 *
 * Two best-effort blocks rather than one, because the columns are not worth the
 * same. `Page.storyDelta` is what `rebuildStoryStateFromPages` reads the live
 * fold back out of, so it must survive a fold that cannot land; the project
 * column is the O(1) cache in front of that rebuild.
 */
async function writeStoryMemory(
  options: MemoryBatchOptions,
  pages: readonly PublishedPageMemory[]
): Promise<void> {
  const extracted = pages.flatMap((page) =>
    page.storyExtract
      ? [{ pageIndex: page.pageIndex, pageId: page.pageId, delta: page.storyExtract.storyDelta }]
      : []
  );
  if (extracted.length === 0) {
    return;
  }
  await runBestEffortPageMemoryWrite(options.tx, () =>
    reportBatchMemoryFailure(options.projectId, "page story deltas", () =>
      writePageStoryDeltas(options.tx, options.projectId, extracted)
    )
  );
  await runBestEffortPageMemoryWrite(options.tx, () =>
    reportBatchMemoryFailure(options.projectId, "story state fold", () =>
      foldProjectStoryState(options, extracted)
    )
  );
}

/**
 * A savepoint swallows what it rolls back, so an arm that fails inside one
 * leaves no line at all — and the per-page writers this batch replaced each
 * named their own failure (`persistPageStoryDelta` logged the delta it lost,
 * `updateEntityStateFromPage` still reports through `degradeRetrievalArm`).
 * Logged here and rethrown, so the rollback that keeps the manuscript
 * transaction committable still happens. Once per publication rather than once
 * per page, which is why this is a plain warn and not the census ladder.
 */
async function reportBatchMemoryFailure<T>(
  projectId: string,
  arm: string,
  write: () => Promise<T>
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isStopRequestedError(error)) {
      console.warn(`Deferred page memory (${arm}) failed for project ${projectId}`, error);
    }
    throw error;
  }
}

type PageStoryDelta = { pageIndex: number; pageId: string; delta: StoryDelta };

/** One statement for the column a per-page `updateMany` wrote one row at a time. */
function writePageStoryDeltas(
  tx: Prisma.TransactionClient,
  projectId: string,
  extracted: readonly PageStoryDelta[]
): Promise<number> {
  return tx.$executeRawUnsafe(
    `UPDATE "Page" page
        SET "storyDelta" = item.story_delta,
            "updatedAt" = CURRENT_TIMESTAMP
       FROM jsonb_to_recordset($2::jsonb) AS item(page_id text, story_delta jsonb)
      WHERE page."id" = item.page_id
        AND page."projectId" = $1`,
    projectId,
    JSON.stringify(extracted.map((entry) => ({ page_id: entry.pageId, story_delta: entry.delta })))
  );
}

/**
 * The whole batch folded onto the story state in one read-modify-write.
 *
 * `applyStoryDelta` is a pure fold, so folding the batch in page order in
 * memory reaches exactly the document a delta-at-a-time loop reached — and it
 * cannot lose a race it never runs: both callers open their transaction by
 * updating this Project row, so nothing else may write the column until they
 * commit. The claim is still staked on the document that was read, because a
 * miss under a lock we believed we held is a fact worth saying out loud rather
 * than a state to overwrite. `Project.storyState` is rebuildable
 * (`rebuildProjectStoryState`, from the page deltas above), which is why a miss
 * degrades instead of failing the manuscript.
 */
async function foldProjectStoryState(
  options: MemoryBatchOptions,
  extracted: readonly PageStoryDelta[]
): Promise<StoryState | null> {
  const project = await options.tx.project.findUnique({
    where: { id: options.projectId },
    select: { storyState: true }
  });
  if (!project) {
    return null;
  }
  const stored = project.storyState;
  let next =
    stored == null ? seedStoryStateFromPromises(options.plan.promises ?? []) : parseStoryState(stored);
  for (const entry of extracted) {
    next = applyStoryDelta(next, entry.delta, entry.pageIndex);
  }
  const claimed = await options.tx.project.updateMany({
    where: {
      id: options.projectId,
      storyState: stored == null ? { equals: Prisma.DbNull } : { equals: stored as Prisma.InputJsonValue }
    },
    data: { storyState: next as Prisma.InputJsonValue }
  });
  if (claimed.count === 1) {
    return next;
  }
  console.warn(
    `Story state fold for ${options.projectId} did not claim the row it read; leaving the rebuild to reconcile it`
  );
  return null;
}

/**
 * Per-entity continuity state for the whole batch.
 *
 * `updateEntityStateFromPage` owns the note limit, the compare-and-swap and the
 * degradation policy, and it stays the only implementation of them — so the
 * batch calls it once per **page index at which some entity is named for the
 * last time**, handing it every note since the previous such index. That is
 * observationally identical to calling it once per page: an entity accumulates
 * the same notes in the same order (repeatedly keeping a list's last *n* is the
 * same as keeping the last *n* once), and it is stamped with the boundary of
 * the last group it matched — which is its own last mention, because a note
 * after that cannot name it and every entity's last mention is a boundary.
 * What changes is the count: bounded by the cast rather than by the page count,
 * where the loop paid two full-cast reads for every page of the book.
 */
async function writeEntityState(
  options: { tx: Prisma.TransactionClient; projectId: string },
  pages: readonly PublishedPageMemory[]
): Promise<void> {
  const noted = pages.filter((page) => page.draft.continuityNotes.length > 0);
  if (noted.length === 0) {
    return;
  }
  await runBestEffortPageMemoryWrite(options.tx, () =>
    reportBatchMemoryFailure(options.projectId, "entity state", async () => {
      const [characters, locations] = await Promise.all([
        options.tx.character.findMany({ where: { projectId: options.projectId }, select: { name: true } }),
        options.tx.location.findMany({ where: { projectId: options.projectId }, select: { name: true } })
      ]);
      const names = [...characters, ...locations].map((entity) => entity.name);
      let from = 0;
      for (const boundary of lastNamedPages(noted, names)) {
        const group: string[] = [];
        while (from < noted.length && noted[from]!.pageIndex <= boundary) {
          group.push(...noted[from]!.draft.continuityNotes);
          from += 1;
        }
        await updateEntityStateFromPage(options.projectId, boundary, group, options.tx);
      }
      return null;
    })
  );
}

/**
 * The ascending page indexes at which some character or location is named for
 * the last time in this batch — the group boundaries above.
 *
 * The matcher is `entityState.ts`'s own, imported rather than restated, and
 * asked the way `foldedMentions` documents: each note and each name folded
 * once, not once per pair. Pages past the final boundary name nobody, so the
 * notes they contribute to no group are exactly the notes the per-page loop
 * spent two reads on to match nothing.
 */
function lastNamedPages(noted: readonly PublishedPageMemory[], names: readonly string[]): number[] {
  const folded = noted.map((page) => ({
    pageIndex: page.pageIndex,
    notes: page.draft.continuityNotes.map((note) => foldCharacterName(note))
  }));
  const boundaries = new Set<number>();
  for (const name of names) {
    const foldedName = foldCharacterName(name);
    let last: number | undefined;
    for (const page of folded) {
      if (page.notes.some((note) => foldedMentions(note, foldedName))) {
        last = page.pageIndex;
      }
    }
    if (last !== undefined) {
      boundaries.add(last);
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}

type PageEmbeddingRow = {
  id: string;
  page_id: string;
  scope: string;
  summary: string;
  vector_literal: string | null;
  error: string | null;
};

/**
 * The batch's page embeddings, in the two set-based statements
 * `publishTextEditManuscript`'s memory tail already uses — the vector upsert
 * and, for a page whose vector never arrived or a batch whose insert was
 * refused, the vectorless row that keeps the summary lexically recallable.
 * Both name the columns, conflict target and `SET` list `embeddingWrites.ts`
 * declares, including its `"vector" IS NULL` guard, and neither carries the
 * repair pass's same-page predicate: every row here belongs to a page this
 * transaction has just written, which claims its scope outright.
 */
async function writePageEmbeddings(
  options: { tx: Prisma.TransactionClient; projectId: string },
  pages: readonly PublishedPageMemory[]
): Promise<void> {
  const rows = pages.flatMap<PageEmbeddingRow>((page) =>
    page.preparedEmbedding
      ? [{
          id: randomUUID(),
          page_id: page.pageId,
          scope: pageScope(page.pageIndex),
          summary: page.draft.summary,
          vector_literal: page.preparedEmbedding.vectorLiteral,
          error: page.preparedEmbedding.error
        }]
      : []
  );
  if (rows.length === 0) {
    return;
  }
  const vectorRows = rows.filter((row) => row.vector_literal !== null);
  let vectorStored = true;
  if (vectorRows.length > 0) {
    vectorStored =
      (await runBestEffortPageMemoryWrite(options.tx, async () => {
        const written = await options.tx.$queryRawUnsafe<Array<{ count: number }>>(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($3::jsonb) AS item(
               id text, page_id text, scope text, summary text, vector_literal text
             )
           ), written AS (
             INSERT INTO "Embedding" ("id", "projectId", "scope", "sourceId", "text", "vector", "metadata")
             SELECT id, $1, scope, page_id, summary, vector_literal::vector,
                    jsonb_build_object('provider', $2::text)
               FROM input
             ON CONFLICT ("projectId", "scope") DO UPDATE SET
               "sourceId" = EXCLUDED."sourceId", "text" = EXCLUDED."text",
               "vector" = EXCLUDED."vector", "metadata" = EXCLUDED."metadata"
             RETURNING "id"
           ) SELECT count(*)::integer AS count FROM written`,
          options.projectId,
          config.MOCK_AI ? "fake" : "gemini",
          JSON.stringify(vectorRows)
        );
        if (written[0]?.count !== vectorRows.length) {
          // Rolled back to the savepoint with the rest of the statement, so
          // every row below still meets the degraded write's `IS NULL` guard.
          throw new Error("Deferred page memory did not store every page vector");
        }
        return true;
      })) === true;
  }

  const degradedRows = rows
    .filter((row) => row.vector_literal === null || !vectorStored)
    .map((row) => ({ ...row, error: row.error ?? "Bulk vector persistence unavailable" }));
  if (degradedRows.length === 0) {
    return;
  }
  await runBestEffortPageMemoryWrite(options.tx, async () => {
    try {
      return await options.tx.$executeRawUnsafe(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
             id text, page_id text, scope text, summary text, error text
           )
         )
         INSERT INTO "Embedding" ("id", "projectId", "scope", "sourceId", "text", "metadata")
         SELECT id, $1, scope, page_id, summary,
                jsonb_build_object('vectorStored', false, 'error', error)
           FROM input
         ON CONFLICT ("projectId", "scope") DO UPDATE SET
           "sourceId" = EXCLUDED."sourceId", "text" = EXCLUDED."text",
           "metadata" = EXCLUDED."metadata"
         WHERE "Embedding"."vector" IS NULL`,
        options.projectId,
        JSON.stringify(degradedRows)
      );
    } catch (error) {
      // The last statement between this memory and the transaction, so it is
      // reported on the census `createDegradedEmbedding` already keys — losing
      // a book's page vectors is an environment fact, and the savepoint below
      // would otherwise swallow it without a line.
      degradeRetrievalArm<undefined>({
        arm: "Degraded embedding write",
        projectId: options.projectId,
        error,
        fallback: undefined,
        rethrowIf: isStopRequestedError
      });
      throw error;
    }
  });
}
