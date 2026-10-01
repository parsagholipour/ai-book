import { describe, expect, it } from "vitest";
import { proseWordCount } from "./figures/figureBlocks.js";
import { editShortensPastFloor, LENGTH_FLOOR_SHARE, printedWordCount, TABLE_ROW_ROOM_WORDS, tableRowCount } from "./printedLength.js";

const prose = (words: number) => Array.from({ length: words }, (_, i) => `word${i}`).join(" ");

// The shape the workbook writer prints (r1-bal-workbook chapter 5, 2026-09-30): a filled copy, then a blank one.
const worksheet = [
  "| Input or check | Amount or terms | Decision |",
  "|---|---:|---|",
  "| Annual business costs | $12,000 per year | Include recurring costs. |",
  "| Delivery date | Four weeks after approval | Confirm the start date. |",
  "",
  "Use the blank copy for another project.",
  "",
  "| Input or check | Amount or terms | Decision |",
  "| --- | :---: | --- |",
  "| Annual business costs | [ ] | [ ] |",
  "| Delivery date | [ ] | [ ] |"
].join("\n");

describe("tableRowCount", () => {
  it("counts every header and body row of a pipe table, never the delimiter", () => {
    expect(tableRowCount(worksheet)).toBe(6);
  });

  it("reads a pipe outside a table, and a table inside a fenced block, as no table", () => {
    expect(tableRowCount("Rent | utilities | food are the three lines.\n\nAnother paragraph.")).toBe(0);
    expect(tableRowCount(["```text", "| a | b |", "|---|---|", "| 1 | 2 |", "```"].join("\n"))).toBe(0);
    expect(tableRowCount(["~~~", "| a |", "|---|", "~~~", "", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n"))).toBe(2);
  });

  it("ends a table at its first blank or pipe-less line", () => {
    expect(tableRowCount(["| a | b |", "|---|---|", "| 1 | 2 |", "After the table."].join("\n"))).toBe(2);
  });
});

describe("printedWordCount", () => {
  it("counts the cells' words as readable words, plus the room each row prints beyond them", () => {
    expect(printedWordCount(prose(100))).toBe(100);
    expect(printedWordCount(worksheet)).toBe(proseWordCount(worksheet) + 6 * TABLE_ROW_ROOM_WORDS);
    // Cell text was always readable words; a blank worksheet row prints a full row whatever its cells hold.
    expect(proseWordCount("| Delivery date | [ ] | [ ] |")).toBe(2);
  });
});

describe("editShortensPastFloor", () => {
  const min = 1720;

  it("lets a cut land on the length floor, never under it", () => {
    expect(editShortensPastFloor(prose(1750), prose(Math.ceil(min * LENGTH_FLOOR_SHARE)), min)).toBe(false);
    // The caveat rule's edit of r1-bal-history chapter 6: 1,750 → 1,522 words, 0.885 of the minimum.
    expect(editShortensPastFloor(prose(1750), prose(1522), min)).toBe(false);
    expect(editShortensPastFloor(prose(1750), prose(1454), min)).toBe(true);
  });

  it("never lets an edit deepen a draft that is already under the floor", () => {
    expect(editShortensPastFloor(prose(1300), prose(1290), min)).toBe(true);
    expect(editShortensPastFloor(prose(1300), prose(1300), min)).toBe(false);
    expect(editShortensPastFloor(prose(1300), prose(1400), min)).toBe(false);
  });

  it("measures both sides as they print, so a cut that keeps the worksheet keeps its room", () => {
    const draft = `${prose(1300)}\n\n${worksheet}`;
    const cut = `${prose(1230)}\n\n${worksheet}`;
    const floor = 1550 * LENGTH_FLOOR_SHARE;
    expect(proseWordCount(cut)).toBeLessThan(floor);
    expect(printedWordCount(cut)).toBeGreaterThanOrEqual(floor);
    expect(editShortensPastFloor(draft, cut, 1550)).toBe(false);
  });
});
