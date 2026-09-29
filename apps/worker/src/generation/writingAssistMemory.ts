import {
  analyzeManuscriptStyle,
  figureFreeProse,
  isImportedManuscript,
  jsonRecord,
  manuscriptWordCount,
  type CreateProjectInput,
  type EmbeddingAdapter,
  type TextModelAdapter
} from "@book-maker/core";
import { pageScope, prisma } from "@book-maker/db";
import { runBestEffortPageMemoryWrite } from "./bestEffortSavepoint.js";
import { strategyForInput } from "./bookHelpers.js";
import { prepareEmbedding, strategyUsesSemanticMemory, writePreparedEmbedding } from "./embeddingWrites.js";
import type { AssistChapter } from "./writingAssistContext.js";

/**
 * The two free passes a Studio publish queues behind itself: learning the
 * author's voice, and refreshing the memory rows of the pages it rewrote.
 * Neither suggests anything to the author, so both settle their own row as
 * APPLIED — there is nothing left for anyone to apply — and a result that only
 * records what happened.
 */

export type WritingAssistMemoryResult =
  | { type: "style"; words: number; stored: boolean; skipped?: "imported" | "empty" | "not_studio" }
  | { type: "memory"; embedded: number; skipped: number; unused?: true };

/**
 * STYLE_PROFILE: distil the working copy's voice (`analyzeManuscriptStyle`,
 * the import's own analyser — it never throws, falling back to a deterministic
 * profile) and store it at `mediaSettings.mobile.studio.styleProfile`, with
 * the word count it was learned from beside it (`styleProfileWords`, which is
 * what publish's "words doubled since" test reads).
 *
 * An imported book already has the import's profile, learned from the whole
 * manuscript it arrived as; that one is left alone and this pass does nothing.
 *
 * The write is one `jsonb` merge into the `studio` object on the row itself,
 * never a read-modify-write of `mediaSettings`: the settings route and publish
 * write that document too, and a copy read a minute ago would put back
 * whatever they changed since. It also lands on the current plan version's
 * `inputSnapshot`, because that is where every page prompt reads its input
 * (`inputForPlanVersion`) — without it `sampleExcerptsFromInput` would not see
 * the profile until the next publish rewrote the snapshot.
 */
export async function learnStudioStyle(options: {
  project: { id: string; language: string; mediaSettings: unknown; currentPlanId: string | null };
  chapters: readonly AssistChapter[];
  textModel: TextModelAdapter;
}): Promise<WritingAssistMemoryResult> {
  const { project } = options;
  if (isImportedManuscript(project.mediaSettings)) {
    return { type: "style", words: 0, stored: false, skipped: "imported" };
  }
  // A voice is read from prose: a taken-over composed book's figures are data, not the author's sentences.
  const text = options.chapters
    .map((chapter) => figureFreeProse(chapter.markdown).trim())
    .filter(Boolean)
    .join("\n\n");
  const words = manuscriptWordCount(text);
  if (words === 0) {
    return { type: "style", words, stored: false, skipped: "empty" };
  }
  const style = await analyzeManuscriptStyle({ text, language: project.language }, { model: options.textModel });
  const patch = JSON.stringify({ styleProfile: style, styleProfileWords: words });
  const stored = await prisma.$transaction(async (tx) => {
    const projectRows = await tx.$executeRawUnsafe(
      `UPDATE "Project"
          SET "mediaSettings" = jsonb_set("mediaSettings", '{mobile,studio}', ("mediaSettings"->'mobile'->'studio') || $2::jsonb)
        WHERE "id" = $1 AND jsonb_typeof("mediaSettings"->'mobile'->'studio') = 'object'`,
      project.id,
      patch
    );
    if (projectRows === 1 && project.currentPlanId) {
      await tx.$executeRawUnsafe(
        `UPDATE "PlanVersion"
            SET "inputSnapshot" = jsonb_set("inputSnapshot", '{mediaSettings,mobile,studio}', ("inputSnapshot"->'mediaSettings'->'mobile'->'studio') || $3::jsonb)
          WHERE "id" = $1 AND "projectId" = $2
            AND jsonb_typeof("inputSnapshot"->'mediaSettings'->'mobile'->'studio') = 'object'`,
        project.currentPlanId,
        project.id,
        patch
      );
    }
    return projectRows === 1;
  });
  return stored ? { type: "style", words, stored } : { type: "style", words, stored, skipped: "not_studio" };
}

export type ReembedPage = { pageId: string; index: number; revision: number };

/** The pages a publish rewrote: the payload's copy first, the row's `input.pages` second. */
export function reembedPages(payloadPages: readonly ReembedPage[] | undefined, input: unknown): ReembedPage[] {
  if (payloadPages) {
    return [...payloadPages];
  }
  const raw = jsonRecord(input).pages;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const record = jsonRecord(entry);
    return typeof record.pageId === "string" &&
      record.pageId &&
      Number.isInteger(record.index) &&
      Number.isInteger(record.revision)
      ? [{ pageId: record.pageId, index: record.index as number, revision: record.revision as number }]
      : [];
  });
}

/**
 * REEMBED: the memory row of each page a publish rewrote (publish deletes the
 * old rows, since they describe prose that is gone).
 *
 * Gated like every other embedding writer on `strategyUsesSemanticMemory`:
 * only the sequential-pages mode ever reads these rows, and every book inside
 * the mobile page ceiling routes elsewhere, so for most Studio books this is
 * rightly a no-op rather than a paid call per page nothing will query.
 *
 * **A page is written only while it is still the page the publish saw.** The
 * embedding call is spent first, outside any transaction; then one short
 * transaction locks the row by `id + index + revision` and writes the memory
 * row under that lock. A later publish that reused the slot has bumped the
 * revision (or moved the index), so the lock matches nothing and the write is
 * skipped — the page's new text is that publish's own re-embed to write. The
 * write sits inside `runBestEffortPageMemoryWrite`, because a caught SQL error
 * still aborts a Postgres transaction, and a memory row may degrade but never
 * fail anything.
 */
export async function reembedStudioPages(options: {
  projectId: string;
  input: CreateProjectInput;
  pages: readonly ReembedPage[];
  embedding: EmbeddingAdapter;
}): Promise<WritingAssistMemoryResult> {
  if (!strategyUsesSemanticMemory(strategyForInput(options.input))) {
    return { type: "memory", embedded: 0, skipped: options.pages.length, unused: true };
  }
  let embedded = 0;
  let skipped = 0;
  for (const target of options.pages) {
    const page = await prisma.page.findFirst({
      where: { id: target.pageId, projectId: options.projectId, index: target.index, revision: target.revision },
      select: { summary: true, markdown: true }
    });
    const text = page ? page.summary.trim() || page.markdown.trim().slice(0, 240) : "";
    if (!page || !text) {
      skipped += 1;
      continue;
    }
    const prepared = await prepareEmbedding(text, options.embedding);
    const written = await prisma.$transaction(async (tx) => {
      // A read lock rather than a no-op update: `Page.updatedAt` is a
      // compare-and-swap key elsewhere (`generateImage`), and this pass
      // changes nothing about the page.
      const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "Page"
          WHERE "id" = $1 AND "projectId" = $2 AND "index" = $3 AND "revision" = $4
          FOR UPDATE`,
        target.pageId,
        options.projectId,
        target.index,
        target.revision
      );
      if (locked.length !== 1) {
        return false;
      }
      await runBestEffortPageMemoryWrite(tx, () =>
        writePreparedEmbedding(
          { projectId: options.projectId, scope: pageScope(target.index), sourceId: target.pageId, text },
          prepared,
          tx
        )
      );
      return true;
    });
    if (written) {
      embedded += 1;
    } else {
      skipped += 1;
    }
  }
  return { type: "memory", embedded, skipped };
}
