import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@book-maker/db", async () => (await import("./testing/mobileApiMocks.js")).dbModuleMock());
vi.mock("@book-maker/db/billing", async () => (await import("./testing/mobileApiMocks.js")).billingModuleMock());

import { getBookPageLimit } from "@book-maker/db/billing";
import { resolveStructuralPageEdit, type ExistingPage } from "@book-maker/core";
import {
  continuedBookPages,
  pageLimitMessage,
  pageLimitRefusal,
  replannedBookPages,
  restructuredBookPages
} from "./bookPageLimit.js";

const PAGES: ExistingPage[] = [1, 2, 3, 4, 5].map((index) => ({ id: `page-${index}`, index, chapterId: null }));

describe("the free tier's book length", () => {
  beforeEach(() => {
    vi.mocked(getBookPageLimit).mockReset();
  });

  it("refuses only past the limit, and never on a paid plan", async () => {
    vi.mocked(getBookPageLimit).mockResolvedValue(30);
    expect(await pageLimitRefusal("user-a", 30)).toBeNull();
    expect(await pageLimitRefusal("user-a", 31)).toEqual({ limit: 30, requestedPages: 31 });

    vi.mocked(getBookPageLimit).mockResolvedValue(null);
    expect(await pageLimitRefusal("user-a", 600)).toBeNull();
  });

  it("says the limit, the book asked for, and how far a plan goes", () => {
    expect(pageLimitMessage({ limit: 30, requestedPages: 45 })).toBe(
      "Free books go up to 30 pages. Choose a plan to write this 45-page book — plans go up to 600 pages."
    );
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
