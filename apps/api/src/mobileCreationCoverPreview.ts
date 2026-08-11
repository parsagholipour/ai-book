import { fallbackCoverDesign, type BookCategory } from "@book-maker/core";
import { productBookTypeForLane } from "./mobileCreationLanes.js";
import {
  type MobileBookRecipe,
  type MobileCreationLane,
  type MobileCreationPresets
} from "./mobileCreationSchemas.js";
import { type MobileCreationCoverPreview, type MobileCreationTurn } from "./mobileCreationTurn.js";

/**
 * The glimpse the creation chat draws while a book is still forming: the
 * catalog design the brief would earn today, picked by the same model-free
 * selector the worker falls back to (`fallbackCoverDesign`), through the same
 * lane → product book type → category bridge the build uses. The app renders
 * its palette on the little cover at the top of the chat, so the book the
 * user watches materialize agrees with the designed cover it could end up
 * wearing.
 *
 * The pick is fully deterministic. The seed is content-derived — lane plus
 * working title — rather than the draft id, so no id has to be threaded
 * through every turn builder: it is stable across a conversation, and the
 * selector's tag scoring already moves the pick when the brief's own words
 * change lane or subject.
 */

/**
 * Mirrors `MOBILE_BOOK_TYPE_SETTINGS[...].category` and
 * `MOBILE_AUTO_BOOK_TYPE_SETTINGS.category` (apps/api/src/mobile/schemas.ts).
 * Copied rather than imported: that module imports `mobileCreation.js`, so
 * reaching it from here would close an import cycle through every
 * creation-turn module. `mobileCreationCoverPreview.test.ts` asserts parity.
 */
const COVER_CATEGORY_BY_BOOK_TYPE: Record<MobileCreationPresets["bookType"], BookCategory> = {
  lead_magnet: "BUSINESS",
  workbook: "EDUCATION",
  short_story: "STORY"
};

const AUTO_COVER_CATEGORY: BookCategory = "CUSTOM";

export function creationCoverPreview(input: {
  lane: MobileCreationLane;
  brief: MobileBookRecipe;
}): MobileCreationCoverPreview {
  const category =
    input.lane === "auto" ? AUTO_COVER_CATEGORY : COVER_CATEGORY_BY_BOOK_TYPE[productBookTypeForLane(input.lane)];
  // The artifact ("Children's story", "Workbook", ...) plays the subcategory:
  // it is what the subcategory regexes were written against, and it carries
  // finer genre than the category alone — a children's story builds as STORY,
  // but its artifact is what earns it the kids designs.
  const hints = [input.brief.title, input.brief.audience, input.brief.promise, input.brief.theme, input.brief.tone]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");
  const design = fallbackCoverDesign({
    category,
    subcategory: input.brief.artifact.trim() || null,
    hints: hints || null,
    seed: `${input.lane}|${input.brief.title.trim()}`
  });
  return {
    designId: design.id,
    template: design.template,
    palette: [design.palette[0], design.palette[1], design.palette[2]]
  };
}

/**
 * Re-derives the preview from a finished turn. `applyCreationTurnPatch`
 * builds its merged turn without one, deliberately: the preview is derived
 * state, never patched by the model, so every finalization site stamps it
 * from the brief and lane that actually won.
 */
export function withCreationCoverPreview(turn: MobileCreationTurn): MobileCreationTurn {
  return {
    ...turn,
    coverPreview: creationCoverPreview({ lane: turn.detectedLane, brief: turn.brief })
  };
}
