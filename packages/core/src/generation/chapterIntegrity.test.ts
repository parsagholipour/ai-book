import { describe, expect, it } from "vitest";
import { chapterDegeneracy } from "./chapterIntegrity.js";

const prose = Array.from({ length: 60 }, (_, index) =>
  [
    `Cart ${index} turned into the gate at Housesteads before dawn.`,
    `Cohort ${index} never counted the loads, though the garrison did.`,
    `Tablet ${index} records forty-one measures of grain in a clerk's hand.`,
    `Name ${index} was never the point of the record.`
  ][index % 4]
).join(" ");

describe("chapterDegeneracy", () => {
  it("passes ordinary prose, a deliberate anaphora and a Persian book", () => {
    expect(chapterDegeneracy(prose, { maxWords: 5000, language: "en" }).degenerate).toBe(false);
    // Seventeen of ninety sentences opening "The crowd that" is a device, not a loop (composed-14, chapter 10).
    const anaphora = [
      ...Array.from({ length: 17 }, (_, index) => `The crowd that gathered on the ${index}th day wanted bread and powder.`),
      ...Array.from({ length: 73 }, (_, index) => `On the ${index}th morning the magistrates met again and argued about the price of grain.`)
    ].join(" ");
    expect(chapterDegeneracy(anaphora, { maxWords: 5000, language: "en" }).degenerate).toBe(false);
    expect(chapterDegeneracy("این کتاب درباره تاریخ خشونت است. ".repeat(50), { maxWords: 5000, language: "fa" }).foreignCharacters).toBe(0);
  });

  it("flags the verb-chain loop, a runaway length and stray script", () => {
    const subjects = ["The codex plate", "The calpulli leaders", "The tribute exchange"];
    const loop = Array.from({ length: 300 }, (_, index) => `${subjects[index % 3]} polished these tables, shining them with oils and creams number ${index}.`).join(" ");
    const verdict = chapterDegeneracy(loop, { maxWords: 5000, language: "en" });
    expect(verdict.degenerate).toBe(true);
    expect(verdict.templateShare).toBeGreaterThan(0.9);
    expect(verdict.reasons[0]).toContain("repeated three-word template");
    const runaway = chapterDegeneracy(prose.repeat(20), { maxWords: 1000, language: "en" });
    expect(runaway.reasons.some((reason) => reason.includes("against a maximum"))).toBe(true);
    const stray = chapterDegeneracy(`${prose} The tribute system imposes these limits, capping the索取 and 绞合 them.`, { maxWords: 5000, language: "en" });
    expect(stray.degenerate).toBe(true);
    expect(stray.foreignCharacters).toBe(4);
  });
});
