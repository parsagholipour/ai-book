import type { WritingMode } from "./styleContract.js";

/**
 * The section-form palettes, one per writing mode: the shapes a form plan may
 * assign a stretch of a chapter. Rules are what the writer is shown beside the
 * form's name (`compositionWriterLines`).
 */

export type SectionForm = { id: string; rule: string };

const DOCUMENTED_SCENE =
  "a documented episode from a named source or site, narrated in time through people acting; when the source records little, say what it records in a paragraph and move on, and never present an unnamed or composite person as witnessed";

export const ANALYTICAL_FORMS: readonly SectionForm[] = [
  { id: "scene", rule: DOCUMENTED_SCENE },
  { id: "close-reading", rule: "one source, object, document or site examined at length, quoted or described in detail, and what the author makes of it" },
  { id: "portrait", rule: "one named person or one named institution followed through time, from a named source" },
  { id: "argument", rule: "the author's own claim about this chapter's cases, argued through them, naming the historian, school or source it answers when the notes supply one" },
  { id: "counterargument", rule: "a rival explanation stated at its strongest and then answered on the evidence, in the author's own words rather than a formula" },
  { id: "mechanism", rule: "how one thing actually worked, step by step, with the concrete parts named" },
  { id: "catalogue", rule: "a deliberate inventory or list, allowed to read as one" },
  { id: "open-question", rule: "a question the chapter has made sharp, left open in a sentence or two; not an inventory of the records that would settle it" },
  { id: "comparison", rule: "two cases set side by side and a verdict on what differs and why" },
  { id: "aftermath", rule: "consequences traced forward through named people and places" },
  { id: "quiet-transition", rule: "a short connective passage with no thesis" }
];

const INSTRUCTIONAL_FORMS: readonly SectionForm[] = [
  { id: "worked-example", rule: "one example carried from start to finish with every step shown" },
  { id: "principle", rule: "one idea stated and grounded in one case, without a list of applications" },
  { id: "procedure", rule: "steps in order, allowed to read as steps" },
  { id: "failure-case", rule: "something done wrong, what it cost, and what would have caught it" },
  { id: "diagnosis", rule: "how to tell which situation you are in, by observable signs" },
  { id: "story-from-practice", rule: "a real or realistic episode told in time and framed as such, before any lesson is drawn; the lesson, if any, is one sentence" },
  { id: "objection", rule: "the reader's strongest doubt, taken seriously, then answered or conceded in the author's own words" },
  { id: "exercise", rule: "something the reader does now, with the expected result" },
  { id: "open-question", rule: "what the field does not know, left open in a sentence or two" },
  { id: "quiet-transition", rule: "a short connective passage with no thesis" }
];

/**
 * A practical guide's or a workbook's sections are deliverables
 * (`instructionalBook.ts`). The instructional palette above stays for every
 * instructional book off that path. Gone here: `principle` (it owned the source
 * titles), `story-from-practice` ("framed as such" printed "This is an
 * illustrative scene…"), `open-question` (hedging), and the exercise's "expected
 * result", which ended every exercise on "The expected result is…".
 */
export const TOOLKIT_FORMS: readonly SectionForm[] = [
  { id: "situation", rule: "one moment the reader will face, with one example person, told briefly in the present: what happens, what is said, and the choice the reader now faces, stated once; it stops at the choice" },
  { id: "script", rule: "the words to use, as dialogue lines: the reader's line, a realistic reply — pushback, silence or an upset answer included — and the reader's next line, for two or three exchanges, then at most one sentence on why the wording works; the exchange is never retold or summarised afterwards" },
  { id: "tool", rule: "a question bank, template, checklist, agenda or tracker printed in full and ready to copy — a table of five columns at most, so it fits the page — introduced in one sentence and used once on the section's example" },
  { id: "worksheet", rule: "a named worksheet with real columns and rows, five columns at most so it fits the page, printed exactly twice: once filled in for the example (a workbook's running case) with its numbers and no empty rows, then once blank for the reader with the same columns" },
  { id: "decision-rule", rule: "a rule the reader can apply without the book: when this happens, do that, with the number or trigger that decides it and the one exception" },
  { id: "worked-example", rule: "one example carried from start to finish with every step and number shown, once, ending on the answer" },
  { id: "procedure", rule: "steps in order as a numbered list, each step an action" },
  { id: "failure-case", rule: "something done wrong, what it cost, and what would have caught it" },
  { id: "diagnosis", rule: "how to tell which situation you are in, by observable signs" },
  { id: "objection", rule: "the reader's strongest doubt, taken seriously, then answered or conceded in the author's own words" },
  { id: "exercise", rule: "something the reader does now, with their own situation, in a few minutes" },
  { id: "quiet-transition", rule: "a short connective passage with no thesis" }
];

/** Deliverables the variety rotation never reassigns: moved to another form they would stop being the tool the brief asked for. No other palette has these ids. */
export const PINNED_FORMS: ReadonlySet<string> = new Set(["situation", "script", "tool", "worksheet", "decision-rule"]);

/** The forms a toolkit chapter's long section may take (`deliverableCarriesLength`). */
export const LONG_SECTION_FORMS: ReadonlySet<string> = new Set(["tool", "worksheet", "worked-example", "script"]);

const NARRATIVE_FORMS: readonly SectionForm[] = [
  { id: "scene", rule: "continuous action in one place and time, dramatised, with dialogue where people would speak" },
  { id: "sequel", rule: "the reaction after a scene: feeling, dilemma, decision, in that order, kept short" },
  { id: "dialogue", rule: "a conversation carrying the beat, with little narration between lines" },
  { id: "interior", rule: "inside one character's perception, close and specific, without summary" },
  { id: "setpiece", rule: "a long sustained scene with rising pressure and a turn" },
  { id: "montage", rule: "time compressed through a handful of concrete moments" },
  { id: "reveal", rule: "information the reader did not have, delivered through action, not explanation" },
  { id: "confrontation", rule: "two wants collide and one gives way" },
  { id: "document", rule: "a letter, record, message or artefact reproduced within the story" },
  { id: "quiet", rule: "a still passage with no plot movement, observed rather than reflected upon" }
];

const REFERENCE_FORMS: readonly SectionForm[] = [
  { id: "overview", rule: "what the reader needs to place the entries that follow, without previewing their conclusions" },
  { id: "entry-cluster", rule: "several entries in canonical form, allowed to repeat their structure" },
  { id: "worked-example", rule: "one entry applied in a concrete case" },
  { id: "comparison", rule: "entries set side by side to show where they differ" },
  { id: "history", rule: "how a term, practice or object came to be, told in time" },
  { id: "caveat", rule: "where the reference is unreliable or contested, stated plainly" },
  { id: "quiet-transition", rule: "a short connective passage with no thesis and no landing" }
];

const CHILDREN_FORMS: readonly SectionForm[] = [
  { id: "scene", rule: "one thing happening, in one place, that a child can picture" },
  { id: "dialogue", rule: "characters talking, short lines" },
  { id: "refrain", rule: "a repeated phrase or pattern, changed a little each time" },
  { id: "discovery", rule: "the character finds or notices something new" },
  { id: "problem", rule: "something goes wrong or gets harder" },
  { id: "quiet", rule: "a calm moment, seen rather than explained" }
];

export function formPaletteFor(mode: WritingMode): readonly SectionForm[] {
  switch (mode) {
    case "analytical-history":
      return ANALYTICAL_FORMS;
    case "instructional":
      return INSTRUCTIONAL_FORMS;
    case "reference":
      return REFERENCE_FORMS;
    case "children-narrative":
      return CHILDREN_FORMS;
    case "narrative":
      return NARRATIVE_FORMS;
  }
}
