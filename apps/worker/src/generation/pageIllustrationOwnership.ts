import { createHash } from "node:crypto";
import type { Prisma } from "@book-maker/db";
import {
  isLegacyGeneratedPageIllustrationPath,
  legacyGeneratedIllustrationPageId,
  legacyGeneratedPageIllustrationSuffixes,
  LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY,
  mayRetireLegacyGeneratedIllustration
} from "@book-maker/db/pageIllustrationOwnership";

export {
  isLegacyGeneratedPageIllustrationPath,
  legacyGeneratedIllustrationPageId,
  legacyGeneratedPageIllustrationSuffixes,
  LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY,
  mayRetireLegacyGeneratedIllustration
};

export type PageIllustrationKeeper = {
  projectId: string;
  pageId: string;
  title: string;
  markdown: string;
  summary: string;
  imagePrompt?: string | null | undefined;
  revision: number;
};

const KEEPER_TOKEN_VERSION = "v2";

/** Stable identity for the exact page keeper an illustration was queued to depict. */
export function pageIllustrationKeeperToken(page: PageIllustrationKeeper): string {
  const projection = [
    KEEPER_TOKEN_VERSION,
    page.projectId,
    page.pageId,
    page.revision,
    page.title,
    page.markdown,
    page.summary,
    page.imagePrompt ?? null
  ];
  const digest = createHash("sha256").update(JSON.stringify(projection)).digest("hex").slice(0, 24);
  return `${KEEPER_TOKEN_VERSION}-${digest}`;
}

/**
 * Tokens produced before page identity was added. Kept private to the migration
 * seam so no new producer can accidentally enqueue unscoped ownership.
 */
function legacyPageIllustrationKeeperToken(page: PageIllustrationKeeper): string {
  const projection = [page.revision, page.title, page.markdown, page.summary, page.imagePrompt ?? null];
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex").slice(0, 24);
}

/** Current token first, followed by the one token-era migration alias. */
export function pageIllustrationKeeperTokens(page: PageIllustrationKeeper): readonly [string, string] {
  return [pageIllustrationKeeperToken(page), legacyPageIllustrationKeeperToken(page)];
}

export function ownsPageIllustration(page: PageIllustrationKeeper, keeperToken: string): boolean {
  return pageIllustrationKeeperTokens(page).includes(keeperToken);
}

type PageIllustrationRetirementClient = Pick<Prisma.TransactionClient, "imageAsset">;

/**
 * Retire only generated illustrations owned by the keeper being replaced.
 *
 * The current token and its content-only migration alias, stable legacy page
 * stamps, tokenless numeric filenames, and tokenless in-flight job filenames
 * are the complete system-owned namespaces. Operation-suffixed/manual assets
 * match none of them and survive. The caller supplies its transaction client
 * so retirement commits atomically with the replacement keeper.
 */
export async function retireGeneratedPageIllustrations(
  client: PageIllustrationRetirementClient,
  options: {
    pageIndex: number;
    priorKeeper: PageIllustrationKeeper;
  }
): Promise<void> {
  const { priorKeeper } = options;
  const priorTokens = pageIllustrationKeeperTokens(priorKeeper);
  const assets = await client.imageAsset.findMany({
    where: {
      projectId: priorKeeper.projectId,
      pageId: priorKeeper.pageId,
      type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] }
    },
    select: { id: true, path: true, metadata: true }
  });
  const generatedIds = assets.flatMap((asset) => {
    const metadataToken = keeperTokenFromMetadata(asset.metadata);
    const legacyOwnerPageId = legacyGeneratedIllustrationPageId(asset.metadata);
    const generatedForPriorKeeper =
      (metadataToken !== undefined && priorTokens.includes(metadataToken)) ||
      priorTokens.some((token) => asset.path.includes(`-${token}.`)) ||
      asset.path.includes(`/page-${priorKeeper.pageId}-legacy-`) ||
      // Structural reindexing stamps the stable owner before changing page
      // numbers. That stamp remains authoritative even when the reserved
      // numeric filename still names the page's former index.
      legacyOwnerPageId === priorKeeper.pageId ||
      (isLegacyGeneratedPageIllustrationPath(asset.path, priorKeeper.projectId, options.pageIndex) &&
        mayRetireLegacyGeneratedIllustration(asset.metadata, priorKeeper.pageId));
    return generatedForPriorKeeper ? [asset.id] : [];
  });
  if (generatedIds.length === 0) {
    return;
  }
  await client.imageAsset.deleteMany({
    where: {
      id: { in: generatedIds },
      projectId: priorKeeper.projectId,
      pageId: priorKeeper.pageId
    }
  });
}

function keeperTokenFromMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const keeperToken = (metadata as Record<string, unknown>).keeperToken;
  return typeof keeperToken === "string" ? keeperToken : undefined;
}

/** Produce a distinct optimistic row version even inside one millisecond. */
export function nextPageVersion(current: Date): Date {
  return new Date(Math.max(Date.now(), current.getTime() + 1));
}
