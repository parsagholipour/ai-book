import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BILLING_PRODUCTS, RETIRED_BILLING_PRODUCT_SKUS } from "@book-maker/core";

const productCatalog = { upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) };

vi.mock("./client.ts", () => ({ prisma: { productCatalog }, Prisma: {} }));

const { ensureDefaultProductCatalog } = await import("./billing.js");

describe("the product catalog", () => {
  it("offers no retired product and switches the retired rows off", async () => {
    const offered = DEFAULT_BILLING_PRODUCTS.map((product) => product.sku as string);
    for (const sku of RETIRED_BILLING_PRODUCT_SKUS) {
      expect(offered).not.toContain(sku);
    }

    await ensureDefaultProductCatalog();

    expect(productCatalog.upsert).toHaveBeenCalledTimes(DEFAULT_BILLING_PRODUCTS.length);
    expect(productCatalog.updateMany).toHaveBeenCalledWith({
      where: { sku: { in: ["tomeza.one_book_export"] }, active: true },
      data: { active: false }
    });
  });
});
