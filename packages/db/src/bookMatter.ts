import { bookMatterYear, parseBookMatter, type BookMatterForCompile } from "@book-maker/core";
import { resolvePlanTier } from "./planPeriods.ts";

/**
 * A book's matter as its compile prints it — the one builder both compiles
 * call, the way `researchCitationsForExport` is, because the API renders a book
 * inline when a compiled file is missing and the two must print the same
 * front matter.
 *
 * - The matter itself is the book's own copy (`Project.bookMatter`), read
 *   tolerantly: a malformed row prints a book without that page.
 * - The © year is the year the book was created, so recompiling it in a later
 *   year reproduces the published bytes — or, for an import, the year its own
 *   © page printed (`bookMatterYear`).
 * - The "Made with Tomeza" credit follows the owner's plan **now**: a book on a
 *   free account prints it, and the first compile after the owner subscribes
 *   drops it. A deleted owner's tombstone resolves to free, which is right for
 *   the books an account deletion leaves nobody to change.
 */
export async function bookMatterForExport(project: {
  userId: string;
  bookMatter: unknown;
  createdAt: Date;
}): Promise<BookMatterForCompile> {
  const tier = await resolvePlanTier(project.userId);
  const stored = parseBookMatter(project.bookMatter);
  const { copyrightYear: _year, ...matter } = stored;
  return {
    ...matter,
    year: bookMatterYear(stored, project.createdAt),
    madeWithCredit: tier === "free"
  };
}
