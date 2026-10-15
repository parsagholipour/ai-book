import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());

import { getBookPageLimit } from "@book-maker/db/billing";
import { DEFAULT_CREDIT_COSTS, resetCreditPricing, resolveStructuralPageEdit, setCreditPricing, type ExistingPage } from "@book-maker/core";
import {
  continuedBookPages,
  pageLimitCode,
  pageLimitMessage,
  pageLimitMetadata,
  pageLimitRefusal,
  replannedBookPages,
  restructuredBookPages
} from "./bookPageLimit.js";

const PAGES: ExistingPage[] = [1, 2, 3, 4, 5].map((index) => ({ id: `page-${index}`, index, chapterId: null }));

describe("the free tier's book length", () => {
  beforeEach(() => {
    vi.mocked(getBookPageLimit).mockReset();
  });

  afterEach(resetCreditPricing);

  it("refuses a free account only past its limit, and a plan only past the ceiling", async () => {
    vi.mocked(getBookPageLimit).mockResolvedValue(30);
    expect(await pageLimitRefusal("user-a", 30)).toBeNull();
    expect(await pageLimitRefusal("user-a", 31)).toEqual({ kind: "free", limit: 30, requestedPages: 31, maxPages: 200 });

    vi.mocked(getBookPageLimit).mockResolvedValue(null);
    expect(await pageLimitRefusal("user-a", 200)).toBeNull();
    expect(await pageLimitRefusal("user-a", 201)).toEqual({ kind: "ceiling", limit: 200, requestedPages: 201, maxPages: 200 });
  });

  it("answers a free account past the ceiling with the ceiling, never an offer of a plan that would refuse it too", async () => {
    vi.mocked(getBookPageLimit).mockResolvedValue(30);
    expect(await pageLimitRefusal("user-a", 300)).toMatchObject({ kind: "ceiling", limit: 200 });
    // Asked first, so the plan read is never paid for.
    expect(getBookPageLimit).not.toHaveBeenCalled();
  });

  it("follows the operator's ceiling, never past the schemas' 600", async () => {
    vi.mocked(getBookPageLimit).mockResolvedValue(null);
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, paidMaxBookPages: 600 });
    expect(await pageLimitRefusal("user-a", 600)).toBeNull();
    setCreditPricing({ ...DEFAULT_CREDIT_COSTS, paidMaxBookPages: 120 });
    expect(await pageLimitRefusal("user-a", 121)).toMatchObject({ kind: "ceiling", limit: 120 });
  });

  it("says the limit, the book asked for, and how far a plan goes — or that nothing goes that far yet", () => {
    const free = { kind: "free", limit: 30, requestedPages: 45, maxPages: 200 } as const;
    const ceiling = { kind: "ceiling", limit: 200, requestedPages: 250, maxPages: 200 } as const;
    expect(pageLimitMessage(free)).toBe(
      "Free books go up to 30 pages. Choose a plan to write this 45-page book — plans go up to 200 pages."
    );
    expect(pageLimitCode(free)).toBe("PAGE_LIMIT_EXCEEDED");
    expect(pageLimitMessage(ceiling)).toBe("Books longer than 200 pages aren't available yet. Choose 200 pages or fewer.");
    expect(pageLimitCode(ceiling)).toBe("BOOK_LENGTH_UNAVAILABLE");
    // The chat's unlock chip reads `pageLimit`; a length no plan writes carries none.
    expect(pageLimitMetadata(free)).toEqual({ pageLimit: { limit: 30, requestedPages: 45, maxPages: 200 } });
    expect(pageLimitMetadata(ceiling)).toEqual({});
  });

  it("measures a continuation and a replan by the book they would leave behind", () => {
    expect(continuedBookPages({ pages: PAGES }, 10)).toBe(15);
    expect(replannedBookPages({ replanSettings: { targetPages: 60 } }, { targetPages: 20 })).toBe(60);
    // A replan that names no length rewrites the book at the length it has.
    expect(replannedBookPages({}, { targetPages: 40 })).toBe(40);
  });

  it("holds a page change to the limit only when it makes the book longer", () => {
    const project = { pages: PAGES };
    const insert = resolveStructuralPageEdit({ action: "insert", anchorPageIndex: 5, pageIndexes: [], pageCount: 3 }, PAGES);
    const remove = resolveStructuralPageEdit({ action: "delete", anchorPageIndex: null, pageIndexes: [2], pageCount: 0 }, PAGES);
    expect(insert.ok && remove.ok).toBe(true);
    if (!insert.ok || !remove.ok) return;
    expect(restructuredBookPages(project, insert.plan.totalPages)).toBe(8);
    // Shortening a long book is never generating one.
    expect(restructuredBookPages(project, remove.plan.totalPages)).toBeNull();
  });
});
