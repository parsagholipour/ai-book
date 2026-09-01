import { MANDATORY_INTEGRITY_CHECKS } from "@book-maker/core/qualityGates";
import { describe, expect, it } from "vitest";
import { GenerationQualityIntegrityPanel } from "./GenerationQualityIntegrityPanel.js";

describe("GenerationQualityIntegrityPanel", () => {
  it("describes mandatory integrity from the qualityGates leaf, not a checkbox list", () => {
    expect(MANDATORY_INTEGRITY_CHECKS.length).toBeGreaterThan(0);
    expect(typeof GenerationQualityIntegrityPanel).toBe("function");
    expect(MANDATORY_INTEGRITY_CHECKS.some((check) => check.id === "deterministic-manuscript-audit")).toBe(true);
    expect(MANDATORY_INTEGRITY_CHECKS.every((check) => !("tiers" in check))).toBe(true);
  });
});
