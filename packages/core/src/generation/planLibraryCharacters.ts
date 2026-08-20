/**
 * Holding a parsed plan to the reader's saved characters.
 *
 * Everything upstream of here is an instruction: the snapshot rides in the
 * prompt, the guidance below demands the name back verbatim, and the plan
 * schema then strips every key it does not know. Nothing checked that the
 * planner obeyed — and when it did not, the failure was silent and total. A
 * book was shipped whose plan kept the saved name "Natalia" but carried the
 * schema's placeholder description and an invented look ("hair with a small
 * braid"), because the user's own description said who she is and never what
 * she looks like. That invented sentence is copied into the illustration
 * prompts, and prompt text beats the reference image attached beside it, so the
 * reader's adult character was drawn as a bare-headed child.
 *
 * `reconcilePlanLibraryCharacters` is the check. It is pure, synchronous and
 * runs on every parse — initial planning, revision and replan alike — which is
 * what turns a whole class of prompt-level failures (a translated name, a
 * decorated one, a near-duplicate twin, a dropped character, an invented look)
 * from wrong output into a no-op.
 */

import type { BookPlan } from "../schemas/book.js";
import {
  foldCharacterName,
  libraryCharacterAppearanceRule,
  libraryCharacterPromptBlock,
  matchLibraryCharacter,
  type LibraryCharacterSnapshot
} from "./libraryCharacters.js";

type PlanCharacter = BookPlan["characters"][number];

/**
 * The plan schema's own defaults, restated rather than imported: a character
 * the planner dropped has no story role and no biography we are entitled to
 * invent, so an appended one is shaped exactly like a character the schema
 * normalized from a bare name. Anything richer here would be this module doing
 * the inventing it exists to stop.
 */
const DEFAULT_CHARACTER_ROLE = "Supporting character";
const DEFAULT_CHARACTER_DESCRIPTION = "Recurring character in the plan.";

export function reconcilePlanLibraryCharacters(
  plan: BookPlan,
  snapshots: readonly LibraryCharacterSnapshot[]
): BookPlan {
  if (snapshots.length === 0) {
    return plan;
  }

  // Two passes, because the collapse has to compare the plan's *own* entries.
  // Reconciling as we go would rewrite the first entry's description to the
  // snapshot's and then measure the rewrite against the second entry, so the
  // richer of the two would be chosen by how long the saved description is.
  const slots: Array<{ snapshot: LibraryCharacterSnapshot | null; source: PlanCharacter }> = [];
  const slotBySnapshotId = new Map<string, number>();
  for (const character of plan.characters) {
    const match = matchLibraryCharacter(character.name, snapshots);
    if (!match) {
      slots.push({ snapshot: null, source: character });
      continue;
    }
    const claimed = slotBySnapshotId.get(match.id);
    if (claimed === undefined) {
      slotBySnapshotId.set(match.id, slots.length);
      slots.push({ snapshot: match, source: character });
      continue;
    }
    // One saved character, planned twice — the translated twin, or a
    // near-duplicate the planner treated as a second person. Keep the richer
    // draft in the earlier slot rather than printing the same person twice on
    // the cast sheet and drawing them two reference sheets.
    if (characterRichness(character) > characterRichness(slots[claimed]!.source)) {
      slots[claimed] = { snapshot: match, source: character };
    }
  }

  const characters = slots.map((slot) =>
    slot.snapshot ? reconciledCharacter(slot.source, slot.snapshot) : slot.source
  );
  const takenNames = new Set(characters.map((character) => foldCharacterName(character.name)));
  for (const snapshot of snapshots) {
    if (slotBySnapshotId.has(snapshot.id)) {
      continue;
    }
    // A saved character the plan lost entirely: restore them rather than let
    // the reader's @-mention silently do nothing. The name guard is for two
    // library rows saved under one name — appending both would give the book
    // two characters the reference-sheet lookup (a `findIndex` by name) cannot
    // tell apart, so the second would never be drawn.
    const folded = foldCharacterName(snapshot.name);
    if (takenNames.has(folded)) {
      continue;
    }
    takenNames.add(folded);
    characters.push(characterFromSnapshot(snapshot));
  }

  return {
    ...plan,
    characters,
    illustrationPlan: {
      ...plan.illustrationPlan,
      pageRules: withReferenceAuthorityRule(plan.illustrationPlan.pageRules, snapshots)
    }
  };
}

/**
 * The plan's record of a saved character, with the three fields the library
 * owns taken back off the model.
 *
 * `role`, `traits` and everything else stay as planned: the story role is the
 * planner's to decide, and the library says nothing about it. What it does own
 * is who the character *is* (`description`, which is what the app's cast sheet
 * prints) and how they *look* — and the look is either the recorded appearance
 * word for word or nothing at all. Nothing is the honest answer: the real look
 * lives in the portrait attached to the image calls, so an empty `visualRules`
 * leaves the reference images to speak instead of writing over them.
 */
function reconciledCharacter(character: PlanCharacter, snapshot: LibraryCharacterSnapshot): PlanCharacter {
  const appearance = snapshot.appearance?.trim();
  const description = snapshot.description.trim();
  return {
    ...character,
    name: snapshot.name,
    description: description || character.description,
    visualRules: appearance ? [appearance] : []
  };
}

function characterFromSnapshot(snapshot: LibraryCharacterSnapshot): PlanCharacter {
  const appearance = snapshot.appearance?.trim();
  return {
    name: snapshot.name,
    role: DEFAULT_CHARACTER_ROLE,
    description: snapshot.description.trim() || DEFAULT_CHARACTER_DESCRIPTION,
    traits: snapshot.fields.map((field) => `${field.key}: ${field.value}`),
    visualRules: appearance ? [appearance] : []
  };
}

function characterRichness(character: PlanCharacter): number {
  return (
    character.description.trim().length +
    character.role.trim().length +
    character.traits.join(" ").length +
    character.visualRules.join(" ").length
  );
}

/**
 * `illustrationPlan.pageRules` is appended verbatim to every page image prompt
 * ("Continuity rules: …" in the generate-image handler), which is the exact
 * surface the invented look won on. A written description outranking an
 * attached reference is the failure, so this says which of the two decides —
 * deterministically, additively, and without touching a word of the scene
 * prose the plan wrote.
 *
 * It names every saved character rather than only the ones with no recorded
 * appearance: a page render sees the reference sheets either way, and the
 * sheets are what the recorded appearance was drawn into.
 */
function withReferenceAuthorityRule(
  pageRules: readonly string[],
  snapshots: readonly LibraryCharacterSnapshot[]
): string[] {
  const names = snapshots.map((snapshot) => `"${snapshot.name}"`).join(", ");
  const rule =
    `When ${names} appear, the attached character reference images are the only authority on how they look: ` +
    "match their face, hair, skin tone, age, build, headwear and clothing exactly, and never follow a written " +
    "description that contradicts them.";
  // Deduped by equality because a replan reconciles an already-reconciled plan.
  return pageRules.includes(rule) ? [...pageRules] : [...pageRules, rule];
}

/**
 * The planner-facing rules for the user's @-mentioned library characters.
 *
 * Self-contained on purpose. It used to point the model at
 * `mediaSettings.mobile.characters` "in userInput", which is true of initial
 * planning (the whole input is serialized into the user message) and false of
 * a revision, whose payload carries no input at all — so the same sentence
 * pointed a replan at nothing. Repeating the records inline is true in both,
 * and it is what makes `libraryCharacterAppearanceRule`'s "the Appearance line
 * above" resolve to a line that is actually above it.
 */
export function planLibraryCharacterGuidance(snapshots: readonly LibraryCharacterSnapshot[]): string[] {
  if (snapshots.length === 0) {
    return [];
  }
  const names = snapshots.map((snapshot) => `"${snapshot.name}"`).join(", ");
  return [
    `The user defined these characters in their library and selected them directly or through relationships saved in character descriptions: ${names}. Treat every one as requested cast. Their saved records are:`,
    libraryCharacterPromptBlock(snapshots),
    "Each of them MUST appear in the plan's characters array with the name written EXACTLY as given, letter for letter and in its own script: never translate, transliterate, shorten, or re-spell a saved name, whatever the book's target language is.",
    "Derive each one's role and traits from their stored description and details, and never contradict a stated attribute such as age, job, or language.",
    libraryCharacterAppearanceRule(snapshots),
    "Give them real presence in the chapters, not a cameo."
  ];
}
