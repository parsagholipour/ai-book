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
 * It is queued `presentationOnly`, and that is what keeps the book's quality
 * verdict intact. With no final review the recompile's own report is the
 * deterministic checks alone; read as the project's verdict it would delete
 * every chapter-coherence and final-QA finding the book earned — and the
 * `affectedPageIndexes` the quality card's "Fix page N" button is built from —
 * because a reader toggled the Sources list. The prose those findings describe
 * has not changed, so the older verdict is still the true one.
 *
 * Callers keep their own no-op guards and their own copy; only this step is
 * common. See `backMatterEdits.ts` (the Sources list) and
 * `chapterHeadingEdits.ts` (chapter headings).
 */
export async function applyPresentationPreference(
  project: ProjectForChat & { currentPlanId: string },
  patch: Record<string, unknown>
): Promise<void> {
  // The preference, EDITING transition and revision bump are one row write.
  // A detached repair for the previous presentation therefore either commits
  // before this write or loses its publication claim; it cannot publish old
  // formatting into the gap between these operations.
  const updated = await prisma.project.update({
    where: { id: project.id },
    data: {
      mediaSettings: jsonInputValue({ ...jsonRecord(project.mediaSettings), ...patch }),
      status: "EDITING",
      contentRevision: { increment: 1 }
    },
    select: { contentRevision: true }
  });
  await queueUserEditExportRecompile(
    project.id,
    project.currentPlanId,
    project.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETE",
    { presentationOnly: true, contentRevision: updated.contentRevision }
  );
}
