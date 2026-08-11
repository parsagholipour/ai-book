import { describe, expect, it } from "vitest";
import { fallbackCoverDesign } from "@book-maker/core";
import { MOBILE_AUTO_BOOK_TYPE_SETTINGS, MOBILE_BOOK_TYPE_SETTINGS } from "./mobile/schemas.js";
import { creationCoverPreview, withCreationCoverPreview } from "./mobileCreationCoverPreview.js";
import { deterministicCreationTurn } from "./mobileCreation.js";
import { type MobileBookRecipe, type MobileCreationLane } from "./mobileCreationSchemas.js";

function recipe(lane: MobileCreationLane, overrides: Partial<MobileBookRecipe> = {}): MobileBookRecipe {
  return {
    lane,
    title: "",
    artifact: "",
    audience: "",
    promise: "",
    tone: "",
    mainCharacter: "",
    conflict: "",
    ending: "",
    theme: "",
    nextStep: "",
    exercises: "",
    mustInclude: "",
    ...overrides
  };
}

describe("creationCoverPreview", () => {
  it("is deterministic for the same brief", () => {
    const brief = recipe("children_story", { title: "Moon Garden", audience: "5 year olds" });
    const first = creationCoverPreview({ lane: "children_story", brief });
    const second = creationCoverPreview({ lane: "children_story", brief });

    expect(first).toEqual(second);
    expect(first.designId.length).toBeGreaterThan(0);
    expect(first.template.length).toBeGreaterThan(0);
    expect(first.palette).toHaveLength(3);
  });

  it("uses the same category bridge as the build for every lane", () => {
    // The category map inside creationCoverPreview is a copy of
    // MOBILE_BOOK_TYPE_SETTINGS (importing it would close an import cycle);
    // this pins the two together end-to-end through the selector.
    const lanesByBookType = {
      lead_magnet: "lead_magnet",
      workbook: "workbook",
      short_story: "adult_story"
    } as const;
    for (const [bookType, settings] of Object.entries(MOBILE_BOOK_TYPE_SETTINGS)) {
      const lane = lanesByBookType[bookType as keyof typeof lanesByBookType];
      const preview = creationCoverPreview({ lane, brief: recipe(lane) });
      const expected = fallbackCoverDesign({
        category: settings.category,
        subcategory: null,
        hints: null,
        seed: `${lane}|`
      });
      expect(preview.designId).toBe(expected.id);
    }
    const autoPreview = creationCoverPreview({ lane: "auto", brief: recipe("auto") });
    const autoExpected = fallbackCoverDesign({
      category: MOBILE_AUTO_BOOK_TYPE_SETTINGS.category,
      subcategory: null,
      hints: null,
      seed: "auto|"
    });
    expect(autoPreview.designId).toBe(autoExpected.id);
  });

  it("an empty brief still earns a design", () => {
    const preview = creationCoverPreview({ lane: "auto", brief: recipe("auto") });

    expect(preview.designId.length).toBeGreaterThan(0);
    expect(preview.palette.every((color) => color.length > 0)).toBe(true);
  });

  it("moves with the lane", () => {
    const business = creationCoverPreview({ lane: "lead_magnet", brief: recipe("lead_magnet") });
    const story = creationCoverPreview({
      lane: "children_story",
      brief: recipe("children_story", { artifact: "Children's story" })
    });

    expect(business.designId).not.toBe(story.designId);
  });

  it("withCreationCoverPreview re-derives from the turn's own brief and lane", () => {
    const turn = deterministicCreationTurn({
      messages: [{ role: "user", content: "Bedtime story for 5 year olds" }]
    });
    const stamped = withCreationCoverPreview(turn);

    expect(stamped.coverPreview).toEqual(creationCoverPreview({ lane: turn.detectedLane, brief: turn.brief }));
  });
});
