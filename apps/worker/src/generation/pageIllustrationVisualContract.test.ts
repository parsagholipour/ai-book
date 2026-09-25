import { expect, it, vi } from "vitest";
import { createProjectSchema, makeFallbackPlan } from "@book-maker/core";
import { pageIllustrationKeeperToken } from "./pageIllustrationOwnership.js";
import { pageIllustrationVisualContract, reusablePageIllustration, rebindPageIllustration } from "./pageIllustrationVisualContract.js";

const input = createProjectSchema.parse({ prompt: "Rabbit learns to ask for help.", category: "KIDS", targetPages: 30 });
const plan = makeFallbackPlan(input);
const contractOptions = { prompt: "Rabbit and Turtle beside a lantern.", input, plan, referenceAssets: [{ id: "reference-v1", path: "/reference-v1.webp" }] };
const contract = pageIllustrationVisualContract(contractOptions);
const keeper = { projectId: "project-1", pageId: "page-1", title: "The lantern", markdown: "Rabbit asked Turtle for help.", summary: "An offer.", imagePrompt: contractOptions.prompt, revision: 1 };
const asset = { id: "image-1", path: "/image-1.webp", metadata: { visualContract: contract, keeperProjectId: keeper.projectId, keeperPageId: keeper.pageId, keeperToken: pageIllustrationKeeperToken(keeper) } };

it("separates visual compatibility from prose ownership and refuses other pages/manual assets", () => {
  const edited = { ...keeper, markdown: "Rabbit quietly asked Turtle for help.", revision: 2 };
  expect(pageIllustrationKeeperToken(edited)).not.toBe(pageIllustrationKeeperToken(keeper));
  expect(reusablePageIllustration([asset], keeper, contract)?.id).toBe(asset.id);
  expect(reusablePageIllustration([asset], edited, contract)).toBeUndefined();
  expect(reusablePageIllustration([asset], { ...keeper, pageId: "page-2" }, contract)).toBeUndefined();
  expect(reusablePageIllustration([{ ...asset, metadata: { visualContract: contract, operationId: "manual" } }], keeper, contract)).toBeUndefined();
});

it("invalidates changed scene, reference version, visual style and image route", () => {
  for (const changed of [
    { ...contractOptions, prompt: "Rabbit alone in a boat" },
    { ...contractOptions, referenceAssets: [{ id: "reference-v2", path: "/reference-v2.webp" }] },
    { ...contractOptions, plan: { ...plan, illustrationPlan: { ...plan.illustrationPlan, globalStyle: "Ink" } } },
    { ...contractOptions, input: { ...input, mediaSettings: { ...input.mediaSettings, imageStyle: "Watercolor" } } }
  ]) expect(reusablePageIllustration([asset], keeper, pageIllustrationVisualContract(changed))).toBeUndefined();
});

it("rebinds only an unchanged asset owner and refuses an intervening replacement", async () => {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const nextKeeper = { ...keeper, markdown: "A prose edit with the same scene.", revision: 2 };
  await rebindPageIllustration({ imageAsset: { updateMany } } as never, { asset, priorKeeper: keeper, nextKeeper });
  expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: asset.id, projectId: keeper.projectId, pageId: keeper.pageId, metadata: { path: ["keeperToken"], equals: pageIllustrationKeeperToken(keeper) } }), data: { metadata: expect.objectContaining({ keeperToken: pageIllustrationKeeperToken(nextKeeper), reusedFromKeeperToken: pageIllustrationKeeperToken(keeper) }) } }));
  updateMany.mockResolvedValue({ count: 0 });
  await expect(rebindPageIllustration({ imageAsset: { updateMany } } as never, { asset, priorKeeper: keeper, nextKeeper })).rejects.toThrow("changed during fenced");
});

it("survives JSONB key ordering without erasing scene values or array order", () => {
  const characterPlan = { ...plan, characters: [{ name: "Rabbit", role: "Hero", description: "A curious rabbit",
    traits: ["curious", "kind"], visualRules: ["brown fur", "blue scarf"] }] };
  const original = { ...contractOptions, plan: characterPlan };
  const normalized = JSON.parse(JSON.stringify(original));
  const reverseObjectKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reverseObjectKeys);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]));
    return value;
  };
  const restored = reverseObjectKeys(normalized) as typeof original;
  const originalFingerprint = pageIllustrationVisualContract(original);
  expect(pageIllustrationVisualContract(restored)).toBe(originalFingerprint);
  expect(pageIllustrationVisualContract({ ...restored, plan: { ...restored.plan,
    characters: restored.plan.characters.map((character) => ({ ...character, description: "An older rabbit" })) } })).not.toBe(originalFingerprint);
  expect(pageIllustrationVisualContract({ ...restored, plan: { ...restored.plan,
    characters: restored.plan.characters.map((character) => ({ ...character, visualRules: [...character.visualRules].reverse() })) } })).not.toBe(originalFingerprint);
});
