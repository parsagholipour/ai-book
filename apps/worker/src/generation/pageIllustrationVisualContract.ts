import { createHash } from "node:crypto";
import { libraryCharactersFromMediaSettings, type BookPlan, type CreateProjectInput } from "@book-maker/core";
import type { Prisma } from "@book-maker/db";
import { ownsPageIllustration, pageIllustrationKeeperToken, type PageIllustrationKeeper } from "./pageIllustrationOwnership.js";

export type IllustrationReferenceVersion = { id: string; path: string };
export type IllustrationAssetForReuse = { id: string; path: string; metadata: unknown };

/** Visual identity is independent of prose revisions; publication ownership is not. */
export function pageIllustrationVisualContract(options: {
  prompt: string;
  input: CreateProjectInput;
  plan: BookPlan;
  referenceAssets: readonly IllustrationReferenceVersion[];
}): string {
  const projection = {
    version: 1,
    prompt: options.prompt.trim(),
    category: options.input.category,
    settings: { imageStyle: options.input.mediaSettings.imageStyle, imageModel: options.input.mediaSettings.imageModel, modelTier: options.input.mediaSettings.modelTier },
    characters: options.plan.characters,
    savedCharacters: libraryCharactersFromMediaSettings(options.input.mediaSettings),
    style: options.plan.illustrationPlan,
    referenceAssets: [...options.referenceAssets].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, path }) => ({ id, path }))
  };
  // JSONB may reorder every nested object's keys. Normalize optional values as
  // JSON first, then sort object keys; arrays remain ordered visual instructions.
  const normalized: unknown = JSON.parse(JSON.stringify(projection));
  return createHash("sha256").update(JSON.stringify(canonicalVisualJson(normalized))).digest("hex");
}

function canonicalVisualJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalVisualJson);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalVisualJson(item)])
  );
  return value;
}

/** Require both visual compatibility and the exact old owner's proof. Never adopt manual/moved images. */
export function reusablePageIllustration(assets: readonly { id?: string; path: string; metadata?: unknown }[], keeper: PageIllustrationKeeper, visualContract: string): IllustrationAssetForReuse | undefined {
  const asset = assets.find((asset) => {
    const metadata = metadataRecord(asset.metadata);
    return typeof asset.id === "string" && metadata.visualContract === visualContract && metadata.keeperProjectId === keeper.projectId &&
      metadata.keeperPageId === keeper.pageId && typeof metadata.keeperToken === "string" && ownsPageIllustration(keeper, metadata.keeperToken);
  });
  return asset?.id ? { id: asset.id, path: asset.path, metadata: asset.metadata } : undefined;
}

/** The caller must hold the project/page publication fence in the same transaction. */
export async function rebindPageIllustration(client: Pick<Prisma.TransactionClient, "imageAsset">, options: {
  asset: IllustrationAssetForReuse; priorKeeper: PageIllustrationKeeper; nextKeeper: PageIllustrationKeeper;
}): Promise<void> {
  const metadata = metadataRecord(options.asset.metadata);
  const updated = await client.imageAsset.updateMany({
    where: { id: options.asset.id, projectId: options.priorKeeper.projectId, pageId: options.priorKeeper.pageId,
      metadata: { path: ["keeperToken"], equals: String(metadata.keeperToken) } },
    data: { metadata: { ...metadata, keeperToken: pageIllustrationKeeperToken(options.nextKeeper), keeperTokenVersion: 2,
      reusedFromKeeperToken: metadata.keeperToken } as Prisma.InputJsonValue }
  });
  if (updated.count !== 1) throw new Error("Reusable illustration changed during fenced page publication");
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
}
