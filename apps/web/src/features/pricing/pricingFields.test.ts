import { describe, expect, it } from "vitest";
import { PRICING_FIELD_GROUPS } from "./pricingFields.js";

describe("the pricing editor's fields", () => {
  it("offers no export unlock price, because every finished book downloads free", () => {
    // Retired 2026-10-15. The key stays in the saved price list at 0 for
    // installed apps, and the editor sends it back unchanged, but nobody may
    // price a download again from here.
    const keys = PRICING_FIELD_GROUPS.flatMap((group) => group.fields.map((field) => field.key));
    expect(keys).not.toContain("exportUnlock");
    expect(JSON.stringify(PRICING_FIELD_GROUPS)).not.toMatch(/export unlock/i);
  });
});
