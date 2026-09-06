import { describe, expect, it } from "vitest";
import { isDisclaimerSentence } from "./disclaimerCap.js";

// The eight sentences three Opus readers of `legacy-cuts-7b` were reading when
// they wrote "almost every paragraph closes on an epistemic-limit disclaimer".
const SAMPLES = [
  "Its evidence offers no rate of assault for Babylon.",
  "The body carries recurrence where the cemetery cannot supply narrative.",
  "It leaves open whether every day was violent and whether the community had means of ending a dispute.",
  "Hammurabi supports a claim about ranked legal classification more securely than a claim about everyday compliance.",
  "The material does not name the threat.",
  "That closeness does not prove that a particular injury was domestic, ritual, or martial.",
  "The site shows lethal asymmetry at one location; it does not reveal the political account that the attackers gave for it.",
  "The bones give us the point at which an encounter became materially visible, while the remainder of the encounter stays beyond their record."
];

const FILLER_A = "The masons cut the blocks on site and hauled them up a ramp of packed earth.";
const FILLER_B = "Two seasons of digging turned up a workshop, a kiln and a drain running under the wall.";

describe("isDisclaimerSentence", () => {
  it("finds the eight sampled shapes", () => {
    for (const sample of SAMPLES) {
      expect(isDisclaimerSentence(sample), sample).toBe(true);
    }
  });

  it("leaves an ordinary sentence alone", () => {
    expect(isDisclaimerSentence(FILLER_A)).toBe(false);
    expect(isDisclaimerSentence(FILLER_B)).toBe(false);
  });
});
