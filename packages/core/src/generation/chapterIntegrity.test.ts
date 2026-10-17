import { describe, expect, it } from "vitest";
import { addsScriptLeaks, chapterDegeneracy, guardComposedDraft } from "./chapterIntegrity.js";

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
    // A quoted word from another script is a historian's ordinary act, not degeneracy.
    const stray = chapterDegeneracy(`${prose} The tribute system imposes these limits, capping the索取 and 绞合 them.`, { maxWords: 5000, language: "en" });
    expect(stray.degenerate).toBe(false);
    expect(stray.foreignCharacters).toBe(4);
    const drift = chapterDegeneracy(`${prose} ${"朝貢制度は限界を課す。".repeat(6)}`, { maxWords: 5000, language: "en" });
    expect(drift.degenerate).toBe(true);
    expect(drift.reasons.some((reason) => reason.includes("script"))).toBe(true);
  });
});

// Each sentence opens on its own number, as the English fixture does, so none is a template.
const persian = Array.from({ length: 60 }, (_, index) => [
  `نانوا ${index} بار نان را از تنور بیرون آورد.`,
  `کوچه ${index} صبح بوی سنگک می‌داد.`,
  `پیرمرد ${index} سال پشت همین در ایستاده بود.`
][index % 3]).join(" ");
const leaked = `${persian} نوه‌اش یک քայլ جلو آمد، بی‌آنکه چیزی بگوید.`;
const fused = `${persian} دستش покрыیده از گرد بود.`;

describe("chapterDegeneracy and leaked script", () => {
  it("reports a leaked word without calling the chapter degenerate", () => {
    const verdict = chapterDegeneracy(leaked, { maxWords: 5000, language: "fa" });
    expect(verdict.degenerate).toBe(false);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.scriptLeaks.map((leak) => leak.word)).toEqual(["քայլ"]);
    expect(chapterDegeneracy(leaked, { maxWords: 5000, language: "fa", brief: "داستانی با واژه‌های ارمنی" }).scriptLeaks).toEqual([]);
    expect(chapterDegeneracy(persian, { maxWords: 5000, language: "fa" }).scriptLeaks).toEqual([]);
  });

  it("refuses an edit only for a leak the edit brought in", () => {
    expect(addsScriptLeaks(persian, leaked, { language: "fa" })).toBe(true);
    expect(addsScriptLeaks(leaked, leaked, { language: "fa" })).toBe(false);
    expect(addsScriptLeaks(leaked, persian, { language: "fa" })).toBe(false);
    expect(addsScriptLeaks(leaked, `${leaked} ${fused}`, { language: "fa" })).toBe(true);
  });
});

describe("guardComposedDraft", () => {
  const guard = (markdown: string) => chapterDegeneracy(markdown, { maxWords: 5000, language: "fa" });
  const loop = Array.from({ length: 300 }, (_, index) => `The codex plate polished these tables, number ${index}.`).join(" ");
  const run = async (first: string, second: string) => {
    let recomposed = 0;
    const result = await guardComposedDraft({
      draft: { markdown: first },
      guard,
      chapterIndex: 4,
      recompose: async () => { recomposed += 1; return { markdown: second }; }
    });
    return { kept: result.draft.markdown, leaks: result.verdict.scriptLeaks.length, recomposed };
  };

  it("keeps a clean draft without recomposing", async () => {
    expect(await run(persian, leaked)).toEqual({ kept: persian, leaks: 0, recomposed: 0 });
  });

  it("recomposes a leaked draft once and keeps the cleaner one, never failing the job over a leak", async () => {
    expect(await run(leaked, persian)).toEqual({ kept: persian, leaks: 0, recomposed: 1 });
    expect(await run(`${leaked} ${fused}`, fused)).toEqual({ kept: fused, leaks: 1, recomposed: 1 });
    expect(await run(leaked, `${leaked} ${fused}`)).toEqual({ kept: leaked, leaks: 1, recomposed: 1 });
    expect(await run(leaked, loop)).toEqual({ kept: leaked, leaks: 1, recomposed: 1 });
    expect(await run(loop, leaked)).toEqual({ kept: leaked, leaks: 1, recomposed: 1 });
  });

  it("fails the job when the draft is not prose twice", async () => {
    await expect(run(loop, loop)).rejects.toThrow(/Chapter 4 came back degenerate twice/);
  });
});
