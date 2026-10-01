import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import {
  buildCharacterReferencePrompt,
  characterReferenceCast,
  COVER_CAST_MAX,
  coverCastCharacters,
  coverPortraitCharacters,
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

describe("the cast a book draws reference sheets for", () => {
  // "Tiko and the Quiet Sea" (2026-10-01): AI cover on, interior illustrations
  // off, four characters, a cover concept showing one. Every character got a
  // sheet and three were attached to the cover: five image calls for a cover.
  const coverOnly: CreateProjectInput = {
    ...input,
    category: "STORY",
    mediaSettings: { ...input.mediaSettings, fullIllustrations: false, illustrationCadence: "manual", includeCover: true, coverArtSource: "ai" }
  };
  const character = (name: string) => ({ name, role: "r", description: "d", traits: [], visualRules: [] });
  const tikoPlan = (coverPrompt: string): BookPlan => ({
    ...plan,
    illustrationPlan: { ...plan.illustrationPlan, coverPrompt },
    characters: [character("Tiko"), character("Pip"), character("Nella"), character("Gull")]
  });
  const tiko = tikoPlan("A gentle cover showing Tiko, a small moss-green tortoise, looking at the calm sea at dusk.");
  const names = (characters: Array<{ name: string }>) => characters.map((entry) => entry.name);

  it("draws only who a cover-only book's cover shows", () => {
    expect(names(characterReferenceCast(coverOnly, tiko))).toEqual(["Tiko"]);
    expect(names(coverCastCharacters(coverOnly, tiko))).toEqual(["Tiko"]);
  });

  it("still draws the whole cast when pages are illustrated", () => {
    const illustrated = { ...coverOnly, mediaSettings: { ...coverOnly.mediaSettings, fullIllustrations: true } };
    expect(names(characterReferenceCast(illustrated, tiko))).toEqual(["Tiko", "Pip", "Nella", "Gull"]);
  });

  it("draws nobody for a cover that shows nobody, or for a designed cover", () => {
    expect(characterReferenceCast(coverOnly, tikoPlan("A quiet shoreline at dusk, waves and a blue pebble."))).toEqual([]);
    const designed = { ...coverOnly, mediaSettings: { ...coverOnly.mediaSettings, includeCover: false, coverArtSource: "design" as const } };
    expect(characterReferenceCast(designed, tiko)).toEqual([]);
  });

  it("holds the cover cast to a constant every caller agrees on", () => {
    const crowded = tikoPlan("Tiko, Pip, Nella and Gull together on the sand.");
    expect(names(characterReferenceCast(coverOnly, crowded))).toHaveLength(COVER_CAST_MAX);
    expect(names(characterReferenceCast(coverOnly, crowded))).toEqual(["Tiko", "Pip", "Nella"]);
  });

  it("draws no sheet for a cover-cast character the reader saved with artwork", () => {
    const withPortrait: CreateProjectInput = {
      ...coverOnly,
      mediaSettings: {
        ...coverOnly.mediaSettings,
        mobile: { characters: [{ id: "lib-tiko", name: "Tiko", description: "A tortoise", fields: [], portraitFile: "user-1/tiko.png" }] }
      } as CreateProjectInput["mediaSettings"]
    };
    expect(characterReferenceCast(withPortrait, tiko)).toEqual([]);
    expect(coverPortraitCharacters(withPortrait, tiko).map(({ snapshot }) => snapshot.id)).toEqual(["lib-tiko"]);
    // An illustrated book seeds that character's sheet from the portrait instead.
    const illustrated = { ...withPortrait, mediaSettings: { ...withPortrait.mediaSettings, fullIllustrations: true } };
    expect(coverPortraitCharacters(illustrated, tiko)).toEqual([]);
    expect(names(characterReferenceCast(illustrated, tiko))).toContain("Tiko");
  });
});
