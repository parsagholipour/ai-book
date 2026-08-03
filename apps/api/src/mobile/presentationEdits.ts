import { queueUserEditExportRecompile } from "./manualEdits.js";
import { type ProjectForChat } from "./projectChat.js";
import { jsonInputValue, jsonRecord } from "./support.js";
import { prisma } from "@book-maker/db";

/**
 * The mechanism shared by every *presentation* edit: a change to how the book
 * is compiled rather than to what it says.
 *
 * These are free by construction. Nothing in `Page.markdown` moves, no model
 * runs, and no `BookEditOperation` or ledger entry is created — the change is
 * one field on `Project.mediaSettings` plus a recompile. The recompile goes
 * through `queueUserEditExportRecompile`, which sets `skipFinalReview`, so the
 * QA repair pass cannot rewrite prose the user never asked to touch.
 *
 * Callers keep their own no-op guards and their own copy; only this step is
 * common. See `backMatterEdits.ts` (the Sources list) and
 * `chapterHeadingEdits.ts` (chapter headings).
 */
export async function applyPresentationPreference(
  project: ProjectForChat & { currentPlanId: string },
  patch: Record<string, unknown>
): Promise<void> {
  await prisma.project.update({
    where: { id: project.id },
    data: { mediaSettings: jsonInputValue({ ...jsonRecord(project.mediaSettings), ...patch }) }
  });
  await queueUserEditExportRecompile(
    project.id,
    project.currentPlanId,
    project.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE"
  );
}
