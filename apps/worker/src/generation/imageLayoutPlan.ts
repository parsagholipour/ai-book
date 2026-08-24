import {
  extractMarkdownImageLine,
  imageAltFromSubject,
  markdownWithAppendedImage,
  markdownWithMovedImage,
  markdownWithPrependedImage,
  markdownWithRemovedImage
} from "./imageMarkdown.js";
import {
  LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY,
  isLegacyGeneratedPageIllustrationPath
} from "./pageIllustrationOwnership.js";
import { assetsImagePathFrom, jsonRecord, markdownLabels } from "@book-maker/core";
import { Prisma } from "@book-maker/db";

/**
 * Applying a batch of picture moves and removals to a book, in one pass.
 *
 * The shape here exists for one reason: **each page is read once, mutated in
 * memory, written once, and snapshotted once.** Undo replays `PageEditSnapshot`
 * rows, there is no unique index on `(operationId, pageId)`, and
 * `undoLastBookEdit` loads them with no ordering — so two snapshots for one
 * page inside one operation means the second carries the already-mutated
 * markdown as its `markdownBefore` and undo restores a page that is missing the
 * first picture. Removing two illustrations from one page is the ordinary case
 * for "remove all the pictures", so this is not an edge.
 *
 * A target whose picture has already gone is skipped and counted, never fatal:
 * one stale entry in a batch of twelve must not lose the other eleven.
 */

export type LayoutSourceRef = {
  pageIndex: number;
  replaceMarker?: string;
  replaceAssetId?: string;
};

export type LayoutDestRef = {
  placement: "end_of_book" | "page";
  pageIndex: number;
  position?: "top" | "bottom";
};

export type PageRow = {
  id: string;
  index: number;
  title: string;
  markdown: string;
  summary: string;
  revision: number;
  imagePrompt: string | null;
  storyDelta?: unknown;
};

export type ResolvedLayoutSource =
  | { kind: "asset"; assetId: string; page: PageRow }
  | { kind: "markdown"; marker: string; page: PageRow };

export type PreviousAssetRecord = {
  id: string;
  pageId: string;
  path: string;
  prompt: string;
  imagePrompt?: string | null;
  destPageId?: string;
  destImagePrompt?: string | null;
};

export type DemotedAssetRecord = {
  id: string;
  pageId: string;
  path: string;
  prompt: string;
  imagePrompt?: string | null;
};

export type LayoutBatchResult = {
  /** Pages actually written, in reading order. Drives `affectedPageIndexes`. */
  writtenPageIndexes: number[];
  previousAssets: PreviousAssetRecord[];
  demotedAssets: DemotedAssetRecord[];
  /** Targets whose picture had already gone, or was already in position. */
  skipped: number;
  /** True when nothing at all was written — the caller marks the edit skipped. */
  empty: boolean;
  /** Set when every target was skipped because it was already in position. */
  allAlreadyPositioned: boolean;
};

/** One page held across the whole batch: read once, mutated, written once. */
type PageEdit = {
  before: PageRow;
  markdown: string;
  imagePrompt: string | null;
  touched: boolean;
};

export class LayoutUnwritableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutUnwritableError";
  }
}

/**
 * Applies every source, then flushes. `tx` is the operation's own transaction,
 * so a throw here rolls the whole batch back — which is what keeps a partially
 * applied "remove all the pictures" from existing.
 */
export async function applyLayoutBatchInTx(
  tx: Prisma.TransactionClient,
  options: {
    projectId: string;
    operationId: string;
    action: "move" | "remove";
    sources: ResolvedLayoutSource[];
    dest: PageRow | null;
    destPosition?: "top" | "bottom" | undefined;
    language?: string | null;
  }
): Promise<LayoutBatchResult> {
  const edits = new Map<string, PageEdit>();
  const previousAssets: PreviousAssetRecord[] = [];
  const demotedAssets: DemotedAssetRecord[] = [];
  const assetOps: Array<{ id: string; pageId: string | null; metadata?: Prisma.InputJsonValue }> = [];
  let skipped = 0;
  let alreadyPositioned = 0;

  // Every page this batch could touch, read once. Re-read inside the
  // transaction rather than trusted from the resolve pass, which ran before the
  // operation was claimed.
  const pageIds = new Set<string>(options.sources.map((source) => source.page.id));
  if (options.dest) {
    pageIds.add(options.dest.id);
  }
  const rows = (await tx.page.findMany({ where: { id: { in: [...pageIds] } } })) as PageRow[];
  for (const row of rows) {
    edits.set(row.id, { before: row, markdown: row.markdown, imagePrompt: row.imagePrompt, touched: false });
  }
  const destEdit = options.dest ? edits.get(options.dest.id) : undefined;
  if (options.dest && !destEdit) {
    throw new LayoutUnwritableError(
      `Page ${options.dest.index} disappeared while the illustration was being moved`
    );
  }

  for (const source of options.sources) {
    const sourceEdit = edits.get(source.page.id);
    if (!sourceEdit) {
      skipped += 1;
      continue;
    }
    const outcome =
      source.kind === "markdown"
        ? applyMarkdownSource(source, sourceEdit, destEdit, options)
        : await applyAssetSource(tx, source, sourceEdit, destEdit, options);
    if (outcome === "skipped") {
      skipped += 1;
      continue;
    }
    if (outcome === "already_positioned") {
      skipped += 1;
      alreadyPositioned += 1;
      continue;
    }
    previousAssets.push(...outcome.previousAssets);
    demotedAssets.push(...outcome.demotedAssets);
    assetOps.push(...outcome.assetOps);
  }

  const written = [...edits.values()].filter((edit) => edit.touched);
  if (written.length === 0) {
    return {
      writtenPageIndexes: [],
      previousAssets: [],
      demotedAssets: [],
      skipped,
      empty: true,
      allAlreadyPositioned: alreadyPositioned > 0 && alreadyPositioned === skipped
    };
  }

  // One update and one snapshot per page, with the `before` captured at the top
  // of this function — never the intermediate state a sibling target produced.
  for (const edit of written.sort((a, b) => a.before.index - b.before.index)) {
    const saved = (await tx.page.update({
      where: { id: edit.before.id },
      data: {
        // Only what actually changed: a page whose hero simply moved away keeps
        // its markdown untouched, and one whose picture was a markdown line
        // keeps its `imagePrompt`.
        ...(edit.markdown !== edit.before.markdown ? { markdown: edit.markdown } : {}),
        ...(edit.imagePrompt !== edit.before.imagePrompt ? { imagePrompt: edit.imagePrompt } : {}),
        revision: { increment: 1 }
      }
    })) as PageRow;
    await tx.pageEditSnapshot.create({
      data: {
        projectId: options.projectId,
        pageId: edit.before.id,
        operationId: options.operationId,
        pageIndex: edit.before.index,
        titleBefore: edit.before.title,
        markdownBefore: edit.before.markdown,
        summaryBefore: edit.before.summary,
        revisionBefore: edit.before.revision,
        ...(edit.before.storyDelta != null
          ? { storyDeltaBefore: edit.before.storyDelta as Prisma.InputJsonValue }
          : {}),
        titleAfter: saved.title,
        markdownAfter: saved.markdown,
        summaryAfter: saved.summary,
        revisionAfter: saved.revision
      }
    });
  }
  for (const op of assetOps) {
    await tx.imageAsset.update({
      where: { id: op.id },
      data: { pageId: op.pageId, ...(op.metadata ? { metadata: op.metadata } : {}) }
    });
  }

  return {
    writtenPageIndexes: written.map((edit) => edit.before.index).sort((a, b) => a - b),
    previousAssets,
    demotedAssets,
    skipped,
    empty: false,
    allAlreadyPositioned: false
  };
}

type SourceOutcome =
  | "skipped"
  | "already_positioned"
  | {
      previousAssets: PreviousAssetRecord[];
      demotedAssets: DemotedAssetRecord[];
      assetOps: Array<{ id: string; pageId: string | null; metadata?: Prisma.InputJsonValue }>;
    };

const NOTHING: SourceOutcome = { previousAssets: [], demotedAssets: [], assetOps: [] };

/**
 * A chat-added picture: a markdown line and nothing else. Undo restores it from
 * the page snapshot, so nothing is recorded on the classifier here.
 */
function applyMarkdownSource(
  source: Extract<ResolvedLayoutSource, { kind: "markdown" }>,
  sourceEdit: PageEdit,
  destEdit: PageEdit | undefined,
  options: { action: "move" | "remove"; destPosition?: "top" | "bottom" | undefined }
): SourceOutcome {
  // A move within the picture's own page is a reorder, not a cut and paste —
  // and with no position named there is nothing to reorder it to, which is the
  // same answer the proposal path gives ("already on page N").
  if (options.action === "move" && destEdit && destEdit.before.id === sourceEdit.before.id) {
    const position = options.destPosition;
    if (!position) {
      return "already_positioned";
    }
    const moved = markdownWithMovedImage(sourceEdit.markdown, source.marker, position);
    if (moved === null) {
      return "skipped";
    }
    if (moved === sourceEdit.markdown) {
      return "already_positioned";
    }
    sourceEdit.markdown = moved;
    sourceEdit.touched = true;
    return NOTHING;
  }

  const line = extractMarkdownImageLine(sourceEdit.markdown, source.marker);
  const without = markdownWithRemovedImage(sourceEdit.markdown, source.marker);
  if (!line || without === null) {
    return "skipped";
  }
  if (options.action === "move" && destEdit) {
    if (!destEdit.markdown.includes(source.marker)) {
      destEdit.markdown =
        options.destPosition === "top"
          ? markdownWithPrependedImage(destEdit.markdown, line)
          : markdownWithAppendedImage(destEdit.markdown, line);
      destEdit.touched = true;
    }
  }
  sourceEdit.markdown = without;
  sourceEdit.touched = true;
  return NOTHING;
}

/**
 * A generation illustration: an `ImageAsset` whose `pageId` makes it the page's
 * hero, printed above the prose by the compiler. Moving it is reassigning that
 * link; the classifier records enough to put it back.
 */
async function applyAssetSource(
  tx: Prisma.TransactionClient,
  source: Extract<ResolvedLayoutSource, { kind: "asset" }>,
  sourceEdit: PageEdit,
  destEdit: PageEdit | undefined,
  options: {
    projectId: string;
    action: "move" | "remove";
    destPosition?: "top" | "bottom" | undefined;
    language?: string | null;
  }
): Promise<SourceOutcome> {
  const live = await tx.imageAsset.findUnique({ where: { id: source.assetId } });
  if (!live) {
    return "skipped";
  }
  const samePage = destEdit !== undefined && destEdit.before.id === sourceEdit.before.id;

  // Within its own page, a hero can only move down: the compiler always prints
  // it above the prose, so "top" is already true, and "bottom" means giving up
  // hero status for an inline line after the text.
  if (options.action === "move" && samePage) {
    if (options.destPosition !== "bottom") {
      return "already_positioned";
    }
    const line = assetImageLine(live, options.language);
    if (!line) {
      throw new LayoutUnwritableError("The illustration's stored path names no asset file");
    }
    sourceEdit.markdown = markdownWithAppendedImage(sourceEdit.markdown, line);
    sourceEdit.imagePrompt = null;
    sourceEdit.touched = true;
    return {
      previousAssets: [previousAssetRecord(live, sourceEdit)],
      demotedAssets: [],
      assetOps: [{ id: live.id, pageId: null }]
    };
  }

  const previousAssets: PreviousAssetRecord[] = [];
  const demotedAssets: DemotedAssetRecord[] = [];
  const assetOps: Array<{ id: string; pageId: string | null; metadata?: Prisma.InputJsonValue }> = [];

  if (destEdit) {
    // The destination's own hero, if it has one, is demoted to an inline line
    // rather than lost. A hero leaves `pageId` only in the same step that gives
    // it that line — writing the page without it and unlinking anyway took the
    // picture out of the book with nothing in the manuscript to show for it.
    const destHero = await tx.imageAsset.findFirst({
      where: {
        projectId: options.projectId,
        pageId: destEdit.before.id,
        type: { in: ["SCENE_ILLUSTRATION", "DIAGRAM"] },
        NOT: { id: live.id }
      }
    });
    if (destHero) {
      const line = assetImageLine(destHero, options.language);
      if (!line) {
        throw new LayoutUnwritableError("The destination illustration's stored path names no asset file");
      }
      demotedAssets.push({
        id: destHero.id,
        pageId: destEdit.before.id,
        path: destHero.path,
        prompt: destHero.prompt,
        imagePrompt: destEdit.before.imagePrompt
      });
      destEdit.markdown = markdownWithAppendedImage(destEdit.markdown, line);
      assetOps.push({ id: destHero.id, pageId: null });
    }
    destEdit.imagePrompt = live.prompt;
    destEdit.touched = true;
  }

  previousAssets.push(previousAssetRecord(live, sourceEdit, destEdit));
  assetOps.push({
    id: live.id,
    pageId: destEdit ? destEdit.before.id : null,
    ...(destEdit ? legacyOwnershipStampForMove(live, sourceEdit, options.projectId) : {})
  });
  sourceEdit.imagePrompt = null;
  sourceEdit.touched = true;
  return { previousAssets, demotedAssets, assetOps };
}

/**
 * A numeric legacy hero must carry its stable source Page before its `pageId`
 * is reassigned. Otherwise a later reindex can make the preserved filename
 * look native to the destination and let its next keeper sweep delete it.
 */
function legacyOwnershipStampForMove(
  asset: { path: string; metadata: unknown },
  sourceEdit: PageEdit,
  projectId: string
): { metadata?: Prisma.InputJsonValue } {
  if (!isLegacyGeneratedPageIllustrationPath(asset.path, projectId, sourceEdit.before.index)) {
    return {};
  }
  const metadata = jsonRecord(asset.metadata);
  const recordedPageId = metadata[LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY];
  if (typeof recordedPageId === "string" && recordedPageId.length > 0) {
    return {};
  }
  return {
    metadata: {
      ...metadata,
      [LEGACY_GENERATED_ILLUSTRATION_PAGE_ID_KEY]: sourceEdit.before.id
    } as Prisma.InputJsonValue
  };
}

function previousAssetRecord(
  live: { id: string; path: string; prompt: string },
  sourceEdit: PageEdit,
  destEdit?: PageEdit | undefined
): PreviousAssetRecord {
  return {
    id: live.id,
    pageId: sourceEdit.before.id,
    path: live.path,
    prompt: live.prompt,
    imagePrompt: sourceEdit.before.imagePrompt,
    ...(destEdit ? { destPageId: destEdit.before.id, destImagePrompt: destEdit.before.imagePrompt } : {})
  };
}

/** The inline markdown line that stands in for a demoted hero. */
function assetImageLine(
  asset: { path: string; prompt: string },
  language: string | null | undefined
): string | null {
  const src = assetsImagePathFrom(asset.path);
  if (!src) {
    return null;
  }
  return `![${imageAltFromSubject(asset.prompt, markdownLabels(language ?? "en").illustration)}](${src})`;
}
