import { beforeEach, describe, expect, it, vi } from "vitest";

const resolvePlanTier = vi.fn();
vi.mock("./planPeriods.ts", () => ({ resolvePlanTier }));

const { bookMatterForExport } = await import("./bookMatter.ts");

describe("bookMatterForExport", () => {
  beforeEach(() => resolvePlanTier.mockReset());

  it("prints the free tier's credit, and the year the book was made", async () => {
    resolvePlanTier.mockResolvedValue("free");
    const matter = await bookMatterForExport({
      userId: "user-1",
      bookMatter: { dedication: " For Sara ", isbn: 42 },
      createdAt: new Date("2025-12-31T23:30:00Z")
    });
    expect(matter).toEqual({ dedication: "For Sara", year: 2025, madeWithCredit: true });
    expect(resolvePlanTier).toHaveBeenCalledWith("user-1");
  });

  it("prints an imported book's own © year, as its © page wrote it", async () => {
    resolvePlanTier.mockResolvedValue("creator");
    const matter = await bookMatterForExport({
      userId: "u",
      bookMatter: { copyrightHolder: "Jane Doe", copyrightYear: "2015–2019" },
      createdAt: new Date("2026-03-01Z")
    });
    expect(matter).toEqual({ copyrightHolder: "Jane Doe", year: "2015–2019", madeWithCredit: false });
  });

  it("drops the credit for any paid plan", async () => {
    resolvePlanTier.mockResolvedValue("creator");
    const matter = await bookMatterForExport({ userId: "u", bookMatter: null, createdAt: new Date("2026-03-01Z") });
    expect(matter).toEqual({ year: 2026, madeWithCredit: false });
  });
});
