// node --import tsx --test scripts/eval/variants/chapterEditHunks.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeOverMoves, diffChapter, knownNamesOf, mergeHunks, mergeIntroducesDuplicate, moveGroups, protectedChange, retainedTwin } from "./chapterEditHunks.ts";

const draft = [
  "Ana reached the quay at dawn. The crane was already moving. She counted three boxes on the deck.",
  "Nobody had told her about the strike. It was not her first winter in Newark.",
  "```figure\n{\"type\":\"bar\"}\n```",
  "The ledger said twelve crates. She did not believe it."
].join("\n\n");
const edit = [
  "Ana reached the quay at dawn. The crane had started already. She counted three boxes on the deck.",
  "Nobody had told her about the strike. It was her first winter in Newark.",
  "```figure\n{\"type\":\"line\"}\n```",
  "The ledger said fourteen crates."
].join("\n\n");

test("hunks are sentence runs between equal units; merge reproduces both ends", () => {
  const diff = diffChapter(draft, edit);
  assert.deepEqual(diff.hunks.map((hunk) => hunk.kind), ["replace", "replace", "replace", "replace"]);
  assert.equal(diff.hunks[0]!.before, "The crane was already moving.");
  assert.equal(diff.hunks[2]!.touchesBlock, true);
  assert.equal(mergeHunks(diff, new Set()), draft);
  // A block-touching hunk is never applied, so "all" stops short of the edit only there.
  const all = mergeHunks(diff, new Set(diff.hunks.map((hunk) => hunk.id)));
  assert.match(all, /"type":"bar"/);
  assert.match(all, /The crane had started already\./);
  const one = mergeHunks(diff, new Set(["h1"]));
  assert.match(one, /The crane had started already\. She counted three boxes/);
  assert.match(one, /It was not her first winter/);
});

test("a mostly rewritten paragraph is one hunk", () => {
  const before = "One. Two is here. Three is there. Four stays.";
  const after = "Uno. Two is here. Tres is there. Cuatro stays.";
  const diff = diffChapter(before, after);
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0]!.before, before);
});

test("protected tokens: numbers, names and negations; the ledger licenses an added value", () => {
  const diff = diffChapter(draft, edit);
  const names = knownNamesOf(draft);
  const verdicts = diff.hunks.map((hunk) => protectedChange(hunk, names, []));
  assert.equal(verdicts[0]!.protected, false);
  assert.match(verdicts[1]!.reasons.join(" "), /negations -1/);
  assert.match(verdicts[3]!.reasons.join(" "), /numbers \+\[14\] -\[12\]/);
  const corrected = diffChapter("Mara had children.", "Mara had two children.");
  assert.equal(protectedChange(corrected.hunks[0]!, new Set(), ["Mara: has two children"]).protected, false);
  assert.equal(protectedChange(corrected.hunks[0]!, new Set(), []).protected, true);
});

test("retainedTwin finds the kept restatement of a deleted sentence", () => {
  const before = "The port grew because rail links reached the terminal quickly. Ships followed. The port grew because the rail links reached its terminal quickly, as before.";
  const after = "The port grew because rail links reached the terminal quickly. Ships followed.";
  const diff = diffChapter(before, after);
  assert.equal(diff.hunks[0]!.kind, "delete");
  assert.equal(retainedTwin(diff, diff.hunks[0]!), "The port grew because rail links reached the terminal quickly.");
});

test("a paragraph join or split is a hunk that shows the join", () => {
  const diff = diffChapter("First one ends here.\n\nSecond one starts here. It goes on.", "First one ends here. Second one starts here. It goes on.");
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0]!.before, "First one ends here.\n\nSecond one starts here.");
  assert.equal(diff.hunks[0]!.after, "First one ends here. Second one starts here.");
  assert.equal(mergeHunks(diff, new Set()), "First one ends here.\n\nSecond one starts here. It goes on.");
});

test("a moved sentence links its two hunks, and a half-applied move is refused", () => {
  const draft = "Ports grew fast after the war ended in Europe and Asia. Ships got bigger.\n\nCranes changed the docks. Unions bargained hard over every new machine at the quay.";
  const edit = "Ships got bigger.\n\nCranes changed the docks. Ports grew fast after the war ended in Europe and Asia. Unions bargained hard over every new machine at the quay.";
  const diff = diffChapter(draft, edit);
  const groups = moveGroups(diff);
  assert.equal(groups.length, 1);
  const half = new Set([groups[0]![1]!]);
  assert.equal(closeOverMoves(diff, half).size, 0);
  assert.equal(mergeIntroducesDuplicate(diff, mergeHunks(diff, half)), true);
});
