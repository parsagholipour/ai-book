import { describe, expect, it } from "vitest";
import { parseManuscript } from "./manuscriptImport.js";
import { parseByline } from "./manuscriptMatterWords.js";

describe("opening prose that starts with a byline cue", () => {
  it.each([
    "By the time Alice woke, the storm had passed.",
    "By Alice's side, the storm felt distant.",
    "By Friday Alice was gone",
    "By midnight Alice had reached Paris",
    "By moonlight the river shone"
  ])("keeps the opening chapter instead of promoting prose to an author: %s", async (opening) => {
    const parsed = await parseManuscript({
      data: Buffer.from(`## The Storm\n\n${opening}\n\n## Aftermath\n\nThe village was silent.`),
      format: "text"
    });

    expect(parsed.matter).toBeUndefined();
    expect(parsed.matterRemoved).toBeUndefined();
    expect(parsed.sections).toEqual([
      { title: "The Storm", text: opening },
      { title: "Aftermath", text: "The village was silent." }
    ]);
  });

  it.each([
    ["by Jane Doe", "Jane Doe"],
    ["Written by J. R. R. Tolkien", "J. R. R. Tolkien"],
    ["by e. e. Cummings", "e. e. Cummings"],
    ["by J.K. Rowling", "J.K. Rowling"],
    ["by Dr. Seuss", "Dr. Seuss"],
    ["by Lemony Snicket", "Lemony Snicket"],
    ["by Jean le Rond d’Alembert", "Jean le Rond d’Alembert"],
    ["by María de los Ángeles García", "María de los Ángeles García"],
    ["door van ’t Hooft", "van ’t Hooft"],
    ["by E\u0301. O’Neill-Smith", "E\u0301. O’Neill-Smith"],
    ["por João da Silva", "João da Silva"],
    ["par Alexandre Dumas, fils", "Alexandre Dumas, fils"],
    ["by Martin Luther King, Jr.", "Martin Luther King, Jr"],
    ["by Jane Doe and Sam Lee", "Jane Doe and Sam Lee"],
    ["by 山田太郎", "山田太郎"],
    ["by जेन डो", "जेन डो"],
    ["نوشتهٔ جین دو", "جین دو"],
    ["著者：山田太郎", "山田太郎"],
    ["山田太郎 著", "山田太郎"],
    ["Author: bell hooks", "bell hooks"]
  ])("retains supported author names: %s", (line, name) => {
    expect(parseByline(line)).toEqual({ name });
  });

  it("retains a byline with its genre lead", () => {
    expect(parseByline("A Novel by Jane Doe")).toEqual({ name: "Jane Doe", lead: "A Novel" });
  });

  it.each([
    ["by bell hooks", "bell hooks"],
    ["por maría garcía", "maría garcía"]
  ])("accepts a lowercase byline only when its full name is corroborated: %s", (line, name) => {
    expect(parseByline(line!, [name!])).toEqual({ name });
    expect(parseByline(line!)).toBeNull();
    expect(parseByline(line!, ["A Different Author"])).toBeNull();
    expect(parseByline(`${line} the river shone`, [name!])).toBeNull();
  });

  it("retains the genre lead when creator metadata corroborates a lowercase author", () => {
    expect(parseByline("A Novel by bell hooks", ["bell hooks"])).toEqual({ name: "bell hooks", lead: "A Novel" });
  });

  it.each([
    ["作者", "王小明"],
    ["लेखक", "आशा शर्मा"],
    ["著者", "山田太郎"],
    ["저자", "김민수"],
    ["автор", "Анна Иванова"],
    ["yazan", "Ayşe Yılmaz"]
  ])("requires the known creator for the publisher's colonless %s label", (label, name) => {
    expect(parseByline(`${label} ${name}`, [name!])).toEqual({ name });
    expect(parseByline(`${label} ${name}`)).toBeNull();
    expect(parseByline(`${label} ${name}`, ["A Different Author"])).toBeNull();
    expect(parseByline(`${label} ${name} wrote this story`, [name!])).toBeNull();
  });
});
