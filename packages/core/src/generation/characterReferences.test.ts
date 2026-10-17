import { describe, expect, it } from "vitest";
import { makeFallbackPlan } from "../prompting/templates.js";
import type { BookPlan, CreateProjectInput } from "../schemas/book.js";
import { shouldIllustratePage } from "./illustrationSlots.js";
import {
  buildCharacterReferencePrompt,
  characterReferenceCast,
  characterReferenceCastFromDraft,
  CHARACTER_REFERENCE_MIN_PICTURES,
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

  // "The Last Table" (2026-10-17): a cover-only story whose cover named its two
  // leads drew two sheets for its one picture, $0.078 of the book's $0.129.
  it("draws no sheet for a cover-only book, whoever its cover shows", () => {
    expect(characterReferenceCast(coverOnly, tiko)).toEqual([]);
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
    expect(names(coverCastCharacters(coverOnly, crowded))).toHaveLength(COVER_CAST_MAX);
    expect(names(coverCastCharacters(coverOnly, crowded))).toEqual(["Tiko", "Pip", "Nella"]);
    expect(characterReferenceCast(coverOnly, crowded)).toEqual([]);
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

describe("the cast a short book's draft decides its sheets for", () => {
  // The Moss book (2026-10-17): ten pages, four pictures, the otter in all four
  // and a frog, a heron and a beaver in one each — and four sheets drawn for it.
  const picture: CreateProjectInput = {
    ...input,
    targetPages: 10,
    mediaSettings: {
      ...input.mediaSettings,
      illustrationCadence: "every-page",
      coverArtSource: "design",
      includeCover: false,
      mobile: { bookType: "short_story" }
    } as CreateProjectInput["mediaSettings"]
  };
  const character = (name: string) => ({ name, role: "r", description: "d", traits: [], visualRules: [] });
  const castPlan = (names: string[], coverPrompt = "A quiet river at dawn."): BookPlan => ({
    ...plan,
    illustrationPlan: { ...plan.illustrationPlan, coverPrompt },
    characters: names.map(character)
  });
  const river = castPlan(["Moss", "Frog", "Heron", "Beaver"]);
  const names = (characters: Array<{ name: string }> | undefined) => characters?.map((entry) => entry.name);
  // Read off the slot function rather than written down: the cap is the
  // owner's to move, and the rule has to follow wherever it puts the pictures.
  const pageIndexes = Array.from({ length: picture.targetPages }, (_, i) => i + 1);
  const drawn = pageIndexes.filter((index) => shouldIllustratePage(picture, river, index));
  const undrawn = pageIndexes.filter((index) => !shouldIllustratePage(picture, river, index));
  const draft = (prompts: Record<number, string>) => pageIndexes.map((index) => ({ index, imagePrompt: prompts[index] ?? null }));
  const scene = (...who: string[]) => `Soft picture-book art: ${who.join(" and ")} by the river.`;

  it("needs a cap with at least two pictures and a page left without one", () => {
    expect(CHARACTER_REFERENCE_MIN_PICTURES).toBe(2);
    expect(drawn.length).toBeGreaterThanOrEqual(2);
    expect(undrawn.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps only who at least two pictures show, in plan order", () => {
    const [first, second] = drawn as [number, number];
    const prompts: Record<number, string> = Object.fromEntries(drawn.map((index) => [index, scene("Moss")]));
    prompts[first] = scene("Heron", "Moss", "Frog");
    prompts[second] = scene("Moss", "a tall heron");
    expect(names(characterReferenceCastFromDraft(picture, river, draft(prompts)))).toEqual(["Moss", "Heron"]);
  });

  it("counts only the pages the illustration slots draw, and only pages with a prompt", () => {
    const [first] = drawn as [number];
    const [skipped] = undrawn as [number];
    const pages = draft({ [first]: scene("Moss", "Frog"), [skipped]: scene("Moss", "Frog") });
    expect(characterReferenceCastFromDraft(picture, river, pages)).toEqual([]);
    // The same two scenes on two drawn pages are two pictures.
    const [, second] = drawn as [number, number];
    expect(names(characterReferenceCastFromDraft(picture, river, draft({ [first]: scene("Frog"), [second]: scene("Frog") })))).toEqual(["Frog"]);
    // The caller's own slot predicate is the one asked — the strategy's, in the worker.
    expect(characterReferenceCastFromDraft(picture, river, pages, () => true)?.map((entry) => entry.name)).toEqual(["Moss", "Frog"]);
  });

  it("counts the cover concept as a picture only when a model draws the cover", () => {
    const [first] = drawn as [number];
    const pages = draft({ [first]: scene("Beaver") });
    const coverShowsBeaver = castPlan(["Moss", "Frog", "Heron", "Beaver"], "Beaver gnawing a branch at sunset.");
    expect(characterReferenceCastFromDraft(picture, coverShowsBeaver, pages)).toEqual([]);
    const aiCover = { ...picture, mediaSettings: { ...picture.mediaSettings, coverArtSource: "ai" as const, includeCover: true } };
    expect(names(characterReferenceCastFromDraft(aiCover, coverShowsBeaver, pages))).toEqual(["Beaver"]);
  });

  it("reads a cover concept that is only the brief as a picture of the lead", () => {
    const [first, second, third] = drawn as [number, number, number];
    const aiCover = {
      ...picture,
      prompt: "A picture book about Moss the otter, who helps Frog, Heron and Beaver.",
      mediaSettings: { ...picture.mediaSettings, coverArtSource: "ai" as const, includeCover: true }
    };
    // Moss's and Frog's pictures, and the Moss book's own shapes: two friends on one page each.
    const pages = draft({ [first]: scene("Moss"), [second]: scene("Moss", "Frog"), [third]: scene("Moss", "Heron") });
    // `makeFallbackPlan`'s concept names everyone the brief does; counted, every friend kept a sheet.
    const fallback = castPlan(["Moss", "Frog", "Heron", "Beaver"], `Cover illustration for Moss and the Stone: ${aiCover.prompt}`);
    expect(names(characterReferenceCastFromDraft(aiCover, fallback, pages))).toEqual(["Moss"]);
    // No concept at all is the brief too (`coverConceptText` falls back to the prompt).
    expect(names(characterReferenceCastFromDraft(aiCover, castPlan(["Moss", "Frog", "Heron", "Beaver"], ""), pages))).toEqual(["Moss"]);
    // The lead's one page and the cover are two pictures.
    expect(names(characterReferenceCastFromDraft(aiCover, fallback, draft({ [first]: scene("Moss") })))).toEqual(["Moss"]);
    // A concept the planner wrote is read for who it names.
    const planned = castPlan(["Moss", "Frog", "Heron", "Beaver"], "Moss and Frog on a mossy stone at dusk.");
    expect(names(characterReferenceCastFromDraft(aiCover, planned, pages))).toEqual(["Moss", "Frog"]);
  });

  it("always keeps a character the reader saved with artwork, and only with artwork", () => {
    const saved = (portraitFile?: string) => ({
      ...picture,
      mediaSettings: {
        ...picture.mediaSettings,
        mobile: {
          bookType: "short_story",
          characters: [{ id: "lib-beaver", name: "Beaver", description: "A beaver", fields: [], ...(portraitFile ? { portraitFile } : {}) }]
        }
      } as CreateProjectInput["mediaSettings"]
    });
    // Named in no picture at all: the sheet is the only door the reader's face has into a page.
    expect(names(characterReferenceCastFromDraft(saved("user-1/beaver.png"), river, draft({})))).toEqual(["Beaver"]);
    expect(characterReferenceCastFromDraft(saved(), river, draft({}))).toEqual([]);
  });

  it("decides an empty cast rather than no cast, and decides nothing off the illustrated path", () => {
    expect(characterReferenceCastFromDraft(picture, river, draft({}))).toEqual([]);
    const coverOnly = { ...picture, mediaSettings: { ...picture.mediaSettings, fullIllustrations: false, coverArtSource: "ai" as const } };
    expect(characterReferenceCastFromDraft(coverOnly, river, draft({}))).toBeUndefined();
    expect(characterReferenceCastFromDraft(picture, castPlan([]), draft({}))).toBeUndefined();
  });

  it("matches a non-Latin name the way the page selection does", () => {
    const persian = castPlan(["مهتاب", "رستم"]);
    const [first, second] = drawn as [number, number];
    const pages = draft({
      [first]: "نقاشی نرم: مهتاب کنار رودخانه سنگ صافش را می‌جوید.",
      [second]: "مهتاب و رستم زیر نور غروب روی ساحل نشسته‌اند."
    });
    expect(names(characterReferenceCastFromDraft(picture, persian, pages))).toEqual(["مهتاب"]);
  });
});
