import { describe, expect, it } from "vitest";
import {
  isModelRefusal,
  jailbreakImagePromptPrefix,
  jailbreakSystemPrefix,
  jailbreakUserSuffix
} from "./jailbreak.js";

describe("jailbreak", () => {
  it("detects common refusals", () => {
    expect(isModelRefusal("I'm sorry, I cannot write that scene.")).toBe(true);
    expect(isModelRefusal('{"markdown":"I am unable to comply with this request."}')).toBe(true);
    expect(isModelRefusal('{"title":"Night","markdown":"She crossed the room and spoke."}')).toBe(false);
  });

  it("returns prefixes by level", () => {
    expect(jailbreakSystemPrefix(0, "writer")).toEqual([]);
    expect(jailbreakSystemPrefix(1, "writer").length).toBeGreaterThan(0);
    expect(jailbreakSystemPrefix(2, "writer").join(" ")).toMatch(/ghostwriter/i);
    expect(jailbreakUserSuffix(2)).toMatch(/previous attempt/i);
    expect(jailbreakImagePromptPrefix(1)).toMatch(/illustration/i);
    expect(jailbreakSystemPrefix(1, "writer").join(" ")).not.toMatch(/adult/i);
  });
});
