import { describe, expect, it } from "vitest";
import {
  firstPublishedImprint,
  foldInner,
  foldMatterText,
  opensLikeDedication,
  parseCopyrightStatement,
  parseImprintLine,
  parseIsbnLine
} from "./manuscriptMatterWords.js";
import { LINEAR_TIME_CEILING_MS } from "./testing/linearTime.js";

function readMs(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let read = 0; read < 2; read += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** The patterns these were: the answers they must keep. */
const regexFoldMatterText = (text: string) => foldInner(text).replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
function regexFirstPublishedImprint(sentence: string): string | null {
  const match = sentence.trim().match(/^first published\b.*?\bby\s+(?<name>\S.*?)(?:\s+in\s+(?:\d{4}|[\p{Lu}][\p{L} ]+))?\.?$/iu);
  const name = match?.groups?.name?.trim();
  return name && name.length <= 120 && /\p{L}/u.test(name) ? name : null;
}

describe("matter words", () => {
  it("folds and reads a first-published line as the patterns did", () => {
    const folds = ["## About the Author ##", "~ Dedication ~", "...", "a...b", "Contents:", "«Посвящение»", "  — 😀 — "];
    for (const text of folds) expect(foldMatterText(text), text).toBe(regexFoldMatterText(text));
    const lines = [
      "First published in 2023 by Lantern Press.",
      "First published in 2023 by Lantern Press, London",
      "First published by Lantern Press in Great Britain",
      "First published by Lantern Press in london",
      "First published by Lantern Press in 2020.",
      "first published by X by\nLantern Press",
      "first published by\nPress",
      "First published by A in B 1",
      "First published in the USA",
      "first publishedby Lantern"
    ];
    for (const line of lines) expect(firstPublishedImprint(line), line).toBe(regexFirstPublishedImprint(line));
    expect(firstPublishedImprint("First published by Lantern Press in london")).toBe("Lantern Press");
  });

  it("reads © statements, ISBNs, imprints and dedications as before", () => {
    expect(parseCopyrightStatement("©, 2020")).toEqual({ year: "2020", scoped: false, rights: false });
    expect(parseCopyrightStatement("© Jane Doe, , , 2020")).toEqual({ holder: "Jane Doe", year: "2020", scoped: false, rights: false });
    expect(parseCopyrightStatement("Copyright © 2019–2021 by Jane Doe. All rights reserved.")).toEqual({
      holder: "Jane Doe",
      year: "2019–2021",
      scoped: false,
      rights: true
    });
    expect(parseCopyrightStatement("© 2020 Jane Doe. . . .")).toEqual({ holder: "Jane Doe", year: "2020", scoped: false, rights: false });
    expect(parseCopyrightStatement("© by Jane Doe 2019, 2020")).toEqual({ holder: "Jane Doe", year: "2019, 2020", scoped: false, rights: false });
    expect(parseCopyrightStatement("© 2020 Jane Doe;;; all rights reserved")).toEqual({ holder: "Jane Doe", year: "2020", scoped: false, rights: true });
    expect(parseIsbnLine("ISBN  978-0-306-40615-7")).toBe("978-0-306-40615-7");
    expect(parseIsbnLine("ISBN:  978-0-306-40615-7 (paperback)")).toBe("978-0-306-40615-7");
    expect(parseImprintLine("Publisher: Lantern Press . . .")).toBe("Lantern Press");
    expect(opensLikeDedication("For my mother!!!", true)).toBe(true);
  });

  it("stays linear on runs a trailing pattern used to read from every character", () => {
    // Each took between one and three seconds at 60,000 characters (150,000 for the last).
    const adversarial: Array<[string, (length: number) => unknown]> = [
      ["fold: a run of stops inside a line", (length) => foldMatterText(`a${".".repeat(length)}b`)],
      ["©: a run of commas before no year", (length) => parseCopyrightStatement(`© a${", ".repeat(length / 2)}x`)],
      ["©: a run of stops after the holder", (length) => parseCopyrightStatement(`© 2020 Jane${". ".repeat(length / 2)}x`)],
      ["©: commas before the rights phrase", (length) => parseCopyrightStatement(`© 2020 Jane${",".repeat(length)}x All rights reserved`)],
      ["ISBN: spaces with no colon", (length) => parseIsbnLine(`ISBN${" ".repeat(length)}x`)],
      ["imprint: stops after the name", (length) => parseImprintLine(`Published by A${". ".repeat(length / 2)}x`)],
      ["dedication: marks after the recipient", (length) => opensLikeDedication(`For ${"!".repeat(length)}x`, true)],
      ["first published: places after the name", (length) => firstPublishedImprint(`first published by A${" in Bcd".repeat(length * 2.5 / 7)} 1`)]
    ];
    for (const [label, read] of adversarial) {
      for (const length of [6_000, 60_000]) {
        const ms = readMs(() => read(length));
        expect(ms, `${label} at ${length} chars: ${ms.toFixed(1)} ms`).toBeLessThan(LINEAR_TIME_CEILING_MS);
      }
    }
  });
});
