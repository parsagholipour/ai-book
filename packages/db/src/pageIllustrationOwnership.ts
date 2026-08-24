import type { Prisma } from "./client.ts";

const LEGACY_GENERATED_ILLUSTRATION_EXTENSIONS = ["jpg", "png", "webp", "svg"] as const;
export const LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY = "legacyGeneratedPageId";
const MISSING_LEGACY_ILLUSTRATION_SOURCE_PREFIX = "migrated-legacy-source-missing:";

type ReindexableLegacyIllustration = {
  id: string;
  type: string;
  path: string;
  metadata: unknown;
};

export type PageWithLegacyIllustrations = {
  id: string;
  index: number;
  images?: readonly ReindexableLegacyIllustration[] | undefined;
};

/** Keep this mock-surviving subpath independent of the core package barrel. */
function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The reserved numeric filename used by generation before keeper tokens. */
export function isLegacyGeneratedPageIllustrationPath(
  path: string,
  projectId: string,
  pageIndex: number
): boolean {
  return legacyGeneratedPageIllustrationSuffixes(projectId, pageIndex).some((suffix) => path.endsWith(suffix));
}

export function legacyGeneratedPageIllustrationSuffixes(projectId: string, pageIndex: number): string[] {
  const stem = `/assets/images/${projectId}/page-${pageIndex}.`;
  return LEGACY_GENERATED_ILLUSTRATION_EXTENSIONS.map((extension) => `${stem}${extension}`);
}

/** A non-empty string is a durable owner; malformed/absent legacy data is not. */
export function legacyGeneratedIllustrationPageId(metadata: unknown): string | null {
  const pageId = jsonRecord(metadata)[LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY];
  return typeof pageId === "string" && pageId.length > 0 ? pageId : null;
}

/** A numeric legacy filename is disposable only when no stable owner conflicts. */
export function mayRetireLegacyGeneratedIllustration(metadata: unknown, pageId: string): boolean {
  const recordedPageId = legacyGeneratedIllustrationPageId(metadata);
  return recordedPageId === null || recordedPageId === pageId;
}

function legacyGeneratedIllustrationSourceIndex(path: string, projectId: string): number | null {
  const stem = `/assets/images/${projectId}/page-`;
  const stemStart = path.lastIndexOf(stem);
  if (stemStart < 0) {
    return null;
  }
  const filename = path.slice(stemStart + stem.length);
  const separator = filename.indexOf(".");
  if (separator <= 0) {
    return null;
  }
  const pageIndex = Number(filename.slice(0, separator));
  if (
    !Number.isSafeInteger(pageIndex) ||
    pageIndex <= 0 ||
    !isLegacyGeneratedPageIllustrationPath(path, projectId, pageIndex)
  ) {
    return null;
  }
  return pageIndex;
}

/**
 * Resolve every unowned numeric filename against the complete page ordering
 * that is about to change. The durable stable-id stamp lets later keeper
 * cleanup distinguish a native generated render from a hero that was moved to
 * another page before ownership metadata existed. A filename whose source is
 * already absent receives a sentinel so a later index reuse cannot adopt it.
 */
export async function stampLegacyGeneratedIllustrationOwnership(
  client: Pick<Prisma.TransactionClient, "imageAsset">,
  projectId: string,
  pages: readonly PageWithLegacyIllustrations[]
): Promise<void> {
  const pageIdByIndex = new Map(pages.map((page) => [page.index, page.id]));
  for (const page of pages) {
    for (const asset of page.images ?? []) {
      const sourceIndex = legacyGeneratedIllustrationSourceIndex(asset.path, projectId);
      if ((asset.type !== "SCENE_ILLUSTRATION" && asset.type !== "DIAGRAM") || sourceIndex === null) {
        continue;
      }
      const metadata = jsonRecord(asset.metadata);
      if (legacyGeneratedIllustrationPageId(metadata) !== null) {
        continue;
      }
      await client.imageAsset.update({
        where: { id: asset.id },
        data: {
          metadata: {
            ...metadata,
            [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]:
              pageIdByIndex.get(sourceIndex) ?? `${MISSING_LEGACY_ILLUSTRATION_SOURCE_PREFIX}${sourceIndex}`
          } as Prisma.InputJsonValue
        }
      });
    }
  }
}
