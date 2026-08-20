/**
 * The `Embedding.scope` vocabulary: the strings that say what a memory row is
 * *about*.
 *
 * A scope is not a label. A `page:<index>` scope names a **position** in the
 * manuscript, not the page that currently sits there — which is why a renumber
 * re-points the scope rather than leaving it (`repointPageEmbeddings`), why a
 * deleted page's rows have to be deleted rather than left for the next page to
 * inherit (`deletePageEmbeddings`), and why the park namespace
 * {@link EMBEDDING_REPOINT_PARK_PREFIX} is deliberately *not* `page:-<index>`.
 * That reasoning is in `packages/db/CLAUDE.md` and
 * `apps/worker/src/generation/CLAUDE.md`, and it is only true as long as every
 * writer spells the position the same way, so the spelling lives here rather
 * than in the dozen handlers and passes that write one.
 *
 * Two shapes are deliberately absent.
 *
 * The SQL half cannot call a function: `embeddingRepairTargets.ts` correlates
 * on `'page:' || p."index"::text`, the retrieval arms read the index back out
 * with {@link pageScopeIndexSql}, and `pageOrdering.ts` re-points with
 * `regexp_replace`. Those literals are the same vocabulary written in the only
 * language that query can use, and {@link PAGE_SCOPE_PREFIX} is what they have
 * to stay in step with.
 *
 * And an edit writes `page:<index>:edit:<operationId>` — a *different* scope
 * that merely shares the prefix. It is built where it is used
 * (`handlers/applyBookEdit.ts`) and has no builder here on purpose: every
 * numeric reader in the repo resolves it to NULL (see {@link pageScopeIndexSql}
 * and the continuity-note bound, which goes through `pageId` precisely because
 * this shape does not parse), so a helper that made the two look
 * interchangeable would be an invitation to the bug those readers are written
 * against.
 */

/**
 * The namespace a page's own semantic-memory rows live in. Both a construction
 * prefix and the filter every reader narrows with — Prisma's
 * `scope: { startsWith: PAGE_SCOPE_PREFIX }` and the retrieval arms'
 * `scopePrefix` — so a change here has to be made in the SQL literals named
 * above as well.
 */
export const PAGE_SCOPE_PREFIX = "page:";

/** The namespace a research source's summary embedding lives in. */
export const RESEARCH_SCOPE_PREFIX = "research:";

/**
 * The scope of the page at `pageIndex`.
 *
 * `Page.index` — the model's own numbering, counted from 1 — never a printed
 * PDF page number. The two diverge as soon as a book has a cover or front
 * matter, and `Project.pdfPageMap` is what translates between them; a scope
 * written in printed numbers would silently answer another page's memory.
 */
export function pageScope(pageIndex: number): string {
  return `${PAGE_SCOPE_PREFIX}${pageIndex}`;
}

/** The scope of a `ResearchSource`'s summary embedding. */
export function researchScope(sourceId: string): string {
  return `${RESEARCH_SCOPE_PREFIX}${sourceId}`;
}

/**
 * The index a page scope names, as the text it is written with — the inverse of
 * {@link pageScope}, for the one caller that prints a recalled row as
 * `Page <n>: <summary>`.
 *
 * Text rather than a number because that is all the caller needs and because
 * the shapes that do not parse must not turn into a hole in a prompt: an edit
 * scope yields `<index>:edit:<operationId>` and a scope in some other namespace
 * yields itself, exactly as the hand-written `replace(…)` this replaces did.
 * A caller that needs the index as a *number* is asking a different question —
 * bound the query with {@link pageScopeIndexSql} instead, which resolves every
 * other shape to NULL before any row is returned.
 */
export function pageScopeIndexText(scope: string): string {
  return scope.startsWith(PAGE_SCOPE_PREFIX) ? scope.slice(PAGE_SCOPE_PREFIX.length) : scope;
}
