/**
 * The `@book-maker/db` embedding-scope vocabulary, restated for module mocks.
 *
 * Every suite in this workspace replaces `@book-maker/db` with a hand-written
 * factory naming the handful of exports its module under test uses, and a
 * factory that omits one fails the test with "No export is defined on the mock"
 * rather than quietly. Since `pageScope` and friends
 * (`packages/db/src/embeddingScopes.ts`) are now imported by most of the
 * generation passes and half the handlers, that would be a dozen copies of the
 * same five entries.
 *
 * The factory cannot reach the real module instead: importing `@book-maker/db`
 * builds a `PrismaClient` and a pg pool for a run that is supposed to need no
 * database, and a factory that imports anything which transitively imports a
 * mocked module deadlocks vitest's registry. So this module imports **nothing**
 * — not even `vitest` — and states the strings itself.
 *
 * Keep it equal to `embeddingScopes.ts`. What a scope *spells* is the whole of
 * what these suites assert about it, so a stand-in that drifts would let a
 * changed prefix pass every test above it while production wrote the other one.
 */
export function dbScopeMocks() {
  return {
    PAGE_SCOPE_PREFIX: "page:",
    RESEARCH_SCOPE_PREFIX: "research:",
    pageScope: (pageIndex: number) => `page:${pageIndex}`,
    researchScope: (sourceId: string) => `research:${sourceId}`,
    pageScopeIndexText: (scope: string) => (scope.startsWith("page:") ? scope.slice("page:".length) : scope)
  };
}
