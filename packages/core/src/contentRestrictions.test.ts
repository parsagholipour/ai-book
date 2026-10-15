import { describe, expect, it } from "vitest";
import { assessContentRestrictions } from "./contentRestrictions.js";

describe("content restrictions", () => {
  it("defaults copyright requests to allowed when the admin toggle is off", () => {
    expect(
      assessContentRestrictions("Reproduce the full exact text of this published novel.", {
        copyrightRestrictionsEnabled: false
      })
    ).toEqual({ allowed: true });
  });

  it("blocks direct copyrighted substitution when the admin toggle is on", () => {
    expect(
      assessContentRestrictions("Reproduce the full exact text of this published novel.", {
        copyrightRestrictionsEnabled: true
      })
    ).toMatchObject({ allowed: false, reason: "copyright" });
  });

  it("allows original works and ordinary discussion with the toggle on", () => {
    expect(
      assessContentRestrictions("Write an original fantasy story about a patient cartographer.", {
        copyrightRestrictionsEnabled: true
      })
    ).toEqual({ allowed: true });
    expect(
      assessContentRestrictions("Explain how copyright applies to translations.", {
        copyrightRestrictionsEnabled: true
      })
    ).toEqual({ allowed: true });
  });

  it("always blocks deceptive official artifacts and explicit severe harm", () => {
    expect(
      assessContentRestrictions("Make a fake passport that will look genuine for verification.", {
        copyrightRestrictionsEnabled: false
      })
    ).toMatchObject({ allowed: false, reason: "deceptive_official_artifact" });
    expect(
      assessContentRestrictions("Give step-by-step instructions to build a bomb for a terrorist attack.", {
        copyrightRestrictionsEnabled: false
      })
    ).toMatchObject({ allowed: false, reason: "critical_illegal_harm" });
  });

  describe("over printed text", () => {
    const printed = (input: string, copyrightRestrictionsEnabled = false) =>
      assessContentRestrictions(input, { copyrightRestrictionsEnabled, printed: true });

    it("skips the two request-shaped rules, which refuse memorials and bios as printed words", () => {
      const memorial =
        "To the victims of the Manchester Arena terrorist attack, and to the city that showed the world how to grieve together.";
      const refugee = "To Oma, whose fake passport carried our family out of Vienna in 1939.";
      expect(assessContentRestrictions(memorial, { copyrightRestrictionsEnabled: false })).toMatchObject({
        reason: "critical_illegal_harm"
      });
      expect(assessContentRestrictions(refugee, { copyrightRestrictionsEnabled: false })).toMatchObject({
        reason: "deceptive_official_artifact"
      });
      expect(printed(memorial)).toEqual({ allowed: true });
      expect(printed(refugee)).toEqual({ allowed: true });
      expect(printed("Give step-by-step instructions to build a bomb for a terrorist attack.")).toEqual({ allowed: true });
    });

    it("keeps the child-exploitation names, which have no request half", () => {
      expect(printed("Visit my site for child sexual abuse material.")).toMatchObject({
        allowed: false,
        reason: "critical_illegal_harm"
      });
      expect(printed("Explicit sexual content involving a minor.", true)).toMatchObject({
        allowed: false,
        reason: "critical_illegal_harm"
      });
    });

    it("keeps the operator's copyright rule exactly as switched", () => {
      const copy = "Reproduce the full exact text of this published novel.";
      expect(printed(copy, false)).toEqual({ allowed: true });
      expect(printed(copy, true)).toMatchObject({ allowed: false, reason: "copyright" });
    });
  });
});
