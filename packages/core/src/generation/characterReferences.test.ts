import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import {
  buildCharacterReferencePrompt,
  selectCharacterReferenceAssets,
  shouldGenerateCharacterReferences,
  shouldUseCharacterReferenceImages
} from "./characterReferences.js";

const input: CreateProjectInput = {
  prompt: "A picture book about Nora and Milo finding the moon bell.",
  category: "KIDS",
  targetPages: 12,
  complexity: 3,
  temperature: 0.8,
  language: "en",
  mediaSettings: {
    fullIllustrations: true,
    illustrationCadence: "every-page",
    includeCover: true,
    coverTemplate: "auto",
    finalReview: true,
    toneProfile: "neutral"
  }
};

const plan: BookPlan = {
  ...makeFallbackPlan(input),
  characters: [
    {
      name: "Nora",
      role: "Child protagonist",
      description: "A small child who studies every clue before speaking.",
      traits: ["observant"],
      visualRules: ["Round red glasses.", "Yellow raincoat.", "Two short braids."]
    },
    {
      name: "Milo",
      role: "Friend",
      description: "A gentle neighbor who carries a blue tin lunchbox.",
      traits: ["patient"],
      visualRules: ["Blue cap.", "Green sweater.", "Freckled cheeks."]
    }
  ]
};

describe("character reference helpers", () => {
  it("builds a text-free single-character reference prompt from visual rules", () => {
    const prompt = buildCharacterReferencePrompt({ input, plan, character: plan.characters[0]! });

    expect(prompt).toContain("Text-free single-character reference image");
    expect(prompt).toContain("Nora");
    expect(prompt).toContain("Round red glasses");
    expect(prompt).toContain("Show exactly one full-body character");
    expect(prompt).toContain("Do not show alternate angles");
    expect(prompt).toContain("Do not include readable text");
  });

  it("requires references for illustrated character projects", () => {
    expect(shouldGenerateCharacterReferences(input, plan)).toBe(true);
    expect(shouldGenerateCharacterReferences({ ...input, mediaSettings: { ...input.mediaSettings, fullIllustrations: false, includeCover: false } }, plan)).toBe(false);
  });

  it("skips reference images when the selected image model cannot consume them", () => {
    expect(
      shouldUseCharacterReferenceImages(input, plan, {
        supportsReferenceImages: true,
        maxReferenceImages: 3
      })
    ).toBe(true);
    expect(
      shouldUseCharacterReferenceImages(input, plan, {
        supportsReferenceImages: false,
        maxReferenceImages: 0
      })
    ).toBe(false);
  });

  it("selects all reference sheets for a small kids cast", () => {
    const selected = selectCharacterReferenceAssets({
      input,
      plan,
      assets: [
        { path: "/tmp/nora.png", metadata: { characterName: "Nora" } },
        { path: "/tmp/milo.png", metadata: { characterName: "Milo" } }
      ],
      context: "Nora looks at the bell.",
      maxReferences: 3
    });

    expect(selected.map((asset) => asset.path)).toEqual(["/tmp/nora.png", "/tmp/milo.png"]);
  });

  it("selects matched characters for larger casts", () => {
    const largePlan: BookPlan = {
      ...plan,
      characters: [
        ...plan.characters,
        { name: "Asha", role: "Guide", description: "A guide.", traits: [], visualRules: ["Silver scarf."] },
        { name: "Toma", role: "Baker", description: "A baker.", traits: [], visualRules: ["Floury apron."] }
      ]
    };
    const selected = selectCharacterReferenceAssets({
      input,
      plan: largePlan,
      assets: largePlan.characters.map((character) => ({
        path: `/tmp/${character.name.toLowerCase()}.png`,
        metadata: { characterName: character.name }
      })),
      context: "Asha and Milo stand beside the moon bell.",
      maxReferences: 2
    });

    expect(selected.map((asset) => asset.path)).toEqual(["/tmp/milo.png", "/tmp/asha.png"]);
  });

  // The commit's stale-set delete is scoped to the ids one plan version read,
  // so a replanned book keeps every superseded cast. Three drawings of one
  // character score identically, and before the collapse they took the whole
  // budget: the rest of the cast was attached to nothing.
  it("gives each character one sheet when superseded casts are still on the project", () => {
    const largePlan: BookPlan = {
      ...plan,
      characters: [
        ...plan.characters,
        { name: "Asha", role: "Guide", description: "A guide.", traits: [], visualRules: ["Silver scarf."] }
      ]
    };
    const sheets = ["plan-1", "plan-2", "plan-3"].flatMap((planId) =>
      largePlan.characters.map((character) => ({
        path: `/tmp/${planId}-${character.name.toLowerCase()}.png`,
        metadata: { characterName: character.name, planId }
      }))
    );

    const selected = selectCharacterReferenceAssets({
      input,
      plan: largePlan,
      assets: sheets,
      context: "Nora, Milo and Asha stand beside the moon bell.",
      maxReferences: 3
    });

    // Newest sheet per character: the callers read rows createdAt-ascending.
    expect(selected.map((asset) => asset.path)).toEqual([
      "/tmp/plan-3-nora.png",
      "/tmp/plan-3-milo.png",
      "/tmp/plan-3-asha.png"
    ]);
  });

  // Same crowding, reached through the "only one character in the book" door:
  // three copies counted as three characters, so the fallback never fired and
  // an add_image whose subject does not name them attached nothing at all.
  it("still attaches a lone character whose superseded sheets outnumber the budget", () => {
    const soloPlan: BookPlan = { ...plan, characters: [plan.characters[0]!] };

    const selected = selectCharacterReferenceAssets({
      input: { ...input, category: "STORY" },
      plan: soloPlan,
      assets: [
        { path: "/tmp/plan-1-nora.png", metadata: { characterName: "Nora", planId: "plan-1" } },
        { path: "/tmp/plan-2-nora.png", metadata: { characterName: "Nora", planId: "plan-2" } },
        { path: "/tmp/plan-3-nora.png", metadata: { characterName: "Nora", planId: "plan-3" } }
      ],
      context: "A quiet kitchen at dawn.",
      maxReferences: 3
    });

    expect(selected.map((asset) => asset.path)).toEqual(["/tmp/plan-3-nora.png"]);
  });
});
