import { foldCharacterName } from "@book-maker/core";
import { describe, expect, it } from "vitest";

/**
 * The fold on its own: no database, no mocks, because the question this module
 * answers is a pure one. It is asserted the way the callers ask it — fold both
 * sides, then `foldedMentions` — since the fold is the half that decides the
 * answer. What it is *for* is asserted twice over — `entityState.test.ts` on the
 * state a note updates, `semanticRecall.test.ts` on the needle a query selects —
 * and both of those bugs were this one.
 */

import { foldedMentions } from "./entityMentions.js";

const mentions = (note: string, name: string): boolean =>
  foldedMentions(foldCharacterName(note), foldCharacterName(name));

describe("foldedMentions", () => {
  it("folds away an optional diacritic but never a vowel sign", () => {
    // Persian and Arabic spellings of one name are one name: the harakat and
    // the keyboard's kaf/yeh are things the spelling carries or does not.
    expect(mentions("علي‌ نامه را باز کرد.", "علی")).toBe(true);
    // A Devanagari matra is a letter, not a diacritic. Stripping it left both
    // names as "मर", which matched every note about either of them.
    expect(mentions("मारा ने चाबी छिपा दी।", "मारा")).toBe(true);
    expect(mentions("मारा ने चाबी छिपा दी।", "मीरा")).toBe(false);
    // Thai sara, same rule.
    expect(mentions("ผาเดินเข้าไปในถ้ำ", "ผี")).toBe(false);
  });
});
