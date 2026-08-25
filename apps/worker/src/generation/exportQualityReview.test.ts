import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import type { FinalBookQa } from "@book-maker/core";
import {
  clipQualityText,
  clipQualityTextPrefix,
  clipQualityTextSuffix,
  qualityIssuesFromFinalQa
} from "./exportQualityReview.js";
import { extractRepairPageIndexes } from "./finalQaPageTargets.js";

// No module mocks: both modules under test are pure text. `exportQualityReview`
// reached the per-message extractor through `bookHelpers`, which opens the
// worker config and the Prisma client at import time, so this suite had to mock
// three modules it never touched to import the formatter at all.

describe("the export quality formatter's dependencies", () => {
  it("reaches nothing of the worker runtime", async () => {
    // The only thing that can regress here is an import line. This module
    // formats text; when it took the per-message page extractor from
    // `bookHelpers.js` it pulled `runtime/config.js`, `runtime/jobLifecycle.js`
    // and the Prisma client in behind it — three seconds of module loading, and
    // three `vi.mock` calls in a suite that touches none of the three.
    const sources = await Promise.all(
      ["exportQualityReview.ts", "finalQaPageTargets.ts"].map((name) =>
        readFile(new URL(name, import.meta.url), "utf8")
      )
    );
    const runtimeImports = sources.flatMap((source) =>
      [...source.matchAll(/^import\s+(?!type\b)[\s\S]*?from\s+"([^"]+)";$/gm)].map((match) => match[1])
    );
    // The collection helper's narrow core subpath has an empty runtime closure;
    // the core barrel remains a type-only import and is erased.
    expect(runtimeImports).toEqual(["./finalQaPageTargets.js", "@book-maker/core/collections"]);
  });

  it("leaves the repair's page targets one exported name", async () => {
    // `bookHelpers.ts` re-exported `extractRepairPageIndexes` so
    // `compileExportRepair.ts` could import it from there and the compile suites
    // could stub it there — a second name for one function, and a module
    // boundary kept alive by a `vi.mock` target. The consumer takes it from the
    // module that defines it, and the suites mock that module instead.
    const [bookHelpers, repair] = await Promise.all([
      readFile(new URL("bookHelpers.ts", import.meta.url), "utf8"),
      readFile(new URL("../handlers/compileExportRepair.ts", import.meta.url), "utf8")
    ]);
    expect(bookHelpers).not.toMatch(/export\s*\{[^}]*extractRepairPageIndexes/);
    expect(repair).toMatch(
      /import\s*\{[^}]*\bextractRepairPageIndexes\b[^}]*\}\s*from\s*"\.\.\/generation\/finalQaPageTargets\.js"/
    );
  });
});

describe("clipQualityText", () => {
  it("returns short text unchanged", () => {
    expect(clipQualityText("Finished sentence.", 2200)).toBe("Finished sentence.");
  });

  it("preserves the real page ending when truncating", () => {
    const head = "START " + "a".repeat(3000);
    const tail = " the final complete sentence ends here.";
    const full = `${head}${tail}`;
    const clipped = clipQualityText(full, 2200);
    expect(clipped.length).toBeLessThanOrEqual(2200);
    expect(clipped).toContain("\n…\n");
    expect(clipped.startsWith("START ")).toBe(true);
    expect(clipped.endsWith(tail.trimStart())).toBe(true);
    expect(clipped).not.toMatch(/a{10}…$/);
  });

  it("does not look like a mid-sentence-only ending for long pages", () => {
    const full = `${"Word ".repeat(800)}Color: green. Domain: forests and abundance.`;
    const clipped = clipQualityText(full, 2200);
    expect(clipped.endsWith("Color: green. Domain: forests and abundance.")).toBe(true);
    expect(clipped).not.toMatch(/Color: gr…$/);
  });
});

describe("clipQualityTextPrefix and clipQualityTextSuffix", () => {
  it("keeps openings from the start and endings from the end", () => {
    const text = "OPENING paragraph one. " + "x".repeat(2000) + " CLOSING paragraph end.";
    expect(clipQualityTextPrefix(text, 1000).startsWith("OPENING paragraph one.")).toBe(true);
    expect(clipQualityTextSuffix(text, 1000).endsWith("CLOSING paragraph end.")).toBe(true);
    expect(clipQualityTextSuffix(text, 1000).startsWith("…")).toBe(true);
  });
});

describe("qualityIssuesFromFinalQa", () => {
  it("ignores advisory issues when final QA approved the book", () => {
    const issues = qualityIssuesFromFinalQa(
      {
        approved: true,
        issues: ["Page 7 summary ends with 'They...' which is acceptable as a pageMap truncation."],
        requiredFixes: []
      },
      20
    );
    expect(issues).toEqual([]);
  });

  it("still surfaces requiredFixes when approved", () => {
    const issues = qualityIssuesFromFinalQa(
      {
        approved: true,
        issues: ["Soft advisory note."],
        requiredFixes: ["Fix the placeholder on page 3."]
      },
      20
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "WHOLE_BOOK_REVIEW",
      message: "Fix the placeholder on page 3.",
      affectedPageIndexes: [3]
    });
  });

  it("maps issues and requiredFixes when not approved", () => {
    const issues = qualityIssuesFromFinalQa(
      {
        approved: false,
        issues: ["Broken continuity on page 2."],
        requiredFixes: ["Rewrite the ending."]
      },
      20
    );
    expect(issues.map((issue) => issue.message)).toEqual([
      "Broken continuity on page 2.",
      "Rewrite the ending."
    ]);
  });

  it("gives each complaint the pages it names rather than the verdict's union", () => {
    // The card renders one message with one page list under it. Stamped with
    // the union, the chapter-4 complaint sent the reader to page 1 and the
    // opening complaint to page 9 — each pointing at the other's evidence.
    const issues = qualityIssuesFromFinalQa(
      {
        approved: false,
        issues: [
          "The opening on page 1 is generic scene-setting.",
          "Chapter 4 restates the same argument twice on page 9."
        ],
        requiredFixes: []
      },
      20
    );
    expect(issues.map((issue) => [issue.message, issue.affectedPageIndexes])).toEqual([
      ["The opening on page 1 is generic scene-setting.", [1]],
      ["Chapter 4 restates the same argument twice on page 9.", [9]]
    ]);
  });

  it("leaves a book-scoped complaint with no page link at all", () => {
    // "Throughout" is the answer: no page is more affected than any other, and
    // borrowing page 4 from the neighbouring complaint would be the union bug
    // one message at a time.
    const issues = qualityIssuesFromFinalQa(
      {
        approved: false,
        issues: ["The pacing sags throughout.", "Page 4 contradicts the premise."],
        requiredFixes: []
      },
      20
    );
    expect(issues.map((issue) => issue.affectedPageIndexes)).toEqual([[], [4]]);
  });

  it("keeps a page the book does not have off the card", () => {
    const issues = qualityIssuesFromFinalQa(
      { approved: false, issues: ["Page 40 repeats page 3."], requiredFixes: [] },
      20
    );
    // 3 survives, 40 does not: the card's tap opens Edit Mode at that index.
    expect(issues[0]?.affectedPageIndexes).toEqual([3]);
  });

  it.each([
    ["The book ends abruptly and resolves nothing.", 20],
    ["The opening reads as a definition of the topic.", 1]
  ])("shows no page for %j while the repair pass still redrafts page %i", (message, repairTarget) => {
    // The two questions the shared extractor makes look like one. The reader is
    // shown nothing, because the edge heuristics are a guess about a complaint
    // that named no page; the repair pass still redrafts on that guess, because
    // it must rewrite *something* and the message says which end.
    const finalQa: FinalBookQa = {
      approved: false,
      score: 55,
      issues: [message],
      requiredFixes: [],
      notes: ""
    };

    expect(qualityIssuesFromFinalQa(finalQa, 20)[0]?.affectedPageIndexes).toEqual([]);
    expect(extractRepairPageIndexes(finalQa, 20)).toEqual([repairTarget]);
  });
});
