import { expect, it } from "vitest";
import { dialogueWitnessConcern, requestsDialogue } from "./dialogueWitness.js";

it.each([
  ['“Follow me,” Rabbit said. The leaves dripped.', 'Follow me,'],
  ['Wise Turtle nodded. “Follow the creek. Call when you find anything.”', 'Call when you find anything.'],
  ['Rabbit: Come along!\nTurtle: I am coming.', 'Come along!'],
  ['— Viens avec moi !\n— Je viens.', 'Viens avec moi !'],
  ['گفت: «بیا با هم برویم.»', 'بیا با هم برویم.'],
  ['兔子说：「一起走吧。」', '一起走吧。'],
  ['Rabbit said, Come along. Turtle followed.', 'Come along.'],
  ["'Come along,' Rabbit said.", 'Come along,'],
  ['Rabbit thought for a moment. “Let us go,” Rabbit said.', 'Let us go,'],
  ['The sign read “STOP.” Rabbit said, “We should wait.”', 'We should wait.']
])("keeps plausible speech as a candidate: %s", (markdown, evidence) => {
  expect(dialogueWitnessConcern(markdown, evidence)).toBeUndefined();
});

it.each([
  ['Rabbit hurried along the woodland path.', 'Rabbit hurried'],
  ['“Come along!” Rabbit hurried along the woodland path.', 'Rabbit hurried'],
  ['Rabbit thought, “I must hurry.”', 'I must hurry.'],
  ['“I must hurry,” Rabbit thought.', 'I must hurry,'],
  ['The sign read “Come along!”', 'Come along!'],
  ['A lantern named “Moon” glowed beside the path.', 'Moon'],
  ['NOTICE: Come along!', 'Come along!'],
  ['Rabbit said nothing. Turtle watched the path.', 'Rabbit said nothing.'],
  ['“Go!” Rabbit said.', 'Rabbit said.'],
  ['Rabbit said, “Go!” Then they followed the path.', 'Then they followed the path.'],
  ['Rabbit said, Come along. Turtle followed the path.', 'Turtle followed the path.'],
  ['“Go!” Rabbit said.', '“'],
  ["Rabbit’s light shone on Turtle’s shell.", 'light shone']
])("challenges non-spoken or unrelated witnesses: %s", (markdown, evidence) => {
  expect(dialogueWitnessConcern(markdown, evidence)).toContain("spoken");
});

it("uses the quoted requirement, including negation, rather than neighboring checklist scope", () => {
  expect(requestsDialogue("natural dialogue")).toBe(true);
  expect(requestsDialogue("Make each page a scene with natural dialogue and sensory details.")).toBe(true);
  expect(requestsDialogue("concrete sensory details")).toBe(false);
  expect(requestsDialogue("without dialogue")).toBe(false);
  expect(requestsDialogue("Avoid dialogue")).toBe(false);
  expect(requestsDialogue("Avoid stilted dialogue")).toBe(false);
  expect(requestsDialogue("Write a dialogue-free story")).toBe(false);
});
