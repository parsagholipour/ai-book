import { enqueueWorkerJob } from "../runtime/dispatch.js";
import { pageIllustrationJobDedupeKey, pageIllustrationKeeperToken } from "./pageIllustrationOwnership.js";
import { errorMessage, type BookGenerationStrategy, type BookPlan, type CreateProjectInput } from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * Queue a page's picture from its checkpointed draft, while the text pass is
 * still reviewing it, rather than after it passes.
 *
 * A page's picture used to wait for that page's review and save, and on the
 * tiers that ran it for the compile's whole final review: a 10-page Quick Draft
 * picture book finished its draft at 0:53 and started its last picture at 5:18.
 * But the scene is fixed by then — the whole-book draft wrote each page's
 * `imagePrompt` onto its PENDING row, and the caller runs this only once the
 * reference sheets are committed and only on a pass that publishes the draft as
 * written (the short-book pass, where no model reads or rewrites a page since
 * 2026-10-16, E4). So every illustrated PENDING row with a prompt is queued here,
 * on every tier.
 *
 * **The job is the one publication would have queued, so nothing new decides
 * what a picture may show.** Its keeper token is the PENDING row's, and an
 * unchanged page stages the same title, prose, summary, prompt and revision 1,
 * so `publishStagedGeneratedPage` and `enqueueFinalizationIllustrations` reach
 * this row through `pageIllustrationJobDedupeKey` instead of minting another: an
 * unchanged picture is paid for once. A page whose keeper changes before it is
 * published has a different token, so this job stands down at
 * `generateImage`'s three ownership checks, or the staging transaction retires
 * the picture it already stored (`retireGeneratedPageIllustrations`; reuse
 * still demands unchanged prose and prompt), and the new keeper gets its own
 * job — at publication, or at the compile's finalization after its repair. A picture that
 * contradicts the published page cannot ship; the price of a changed page is
 * one more picture. Nothing at page time changes a page now, so the only later
 * change is a repair by the compile's defect screen (Quick Draft only for a short
 * book), and that page is drawn again under its new keeper. The grouped review
 * that used to hold a refused page back, and the rule that under `finalReview`
 * only a page a model review had approved was drawn early, went with the review
 * (E4: the grouped review and its repairs did not clearly beat the draft, 7 / 19 / 2).
 *
 * Best effort: a failed enqueue leaves the page to those same two paths, so it
 * costs time and never a picture. A stop needs nothing of its own: these are
 * ordinary open jobs of the book, which the API's stop cancels, and they carry
 * the book's attempt, so a settled failure cancels them as siblings and a row
 * written after either is refused at the stale check before it draws.
 */
export async function enqueueDraftPageIllustrations(options: {
  projectId: string;
  planId: string;
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: BookGenerationStrategy;
  pages: readonly { index: number; markdown: string; imagePrompt?: string | null | undefined }[];
}): Promise<number> {
  const wanted = options.pages.filter((page) => page.imagePrompt?.trim() &&
    options.strategy.shouldIllustratePage(options.input, options.plan, page.index)).map((page) => page.index);
  if (wanted.length === 0) return 0;
  // The row, not the in-memory draft: the token has to be the one staging
  // compares against, revision and all.
  const rows = await prisma.page.findMany({
    where: { projectId: options.projectId, status: "PENDING", index: { in: wanted } },
    orderBy: { index: "asc" },
    select: { id: true, index: true, title: true, markdown: true, summary: true, imagePrompt: true, revision: true }
  });
  let queued = 0;
  for (const row of rows) {
    const prompt = row.imagePrompt;
    if (!prompt?.trim()) continue;
    const keeperToken = pageIllustrationKeeperToken({ projectId: options.projectId, pageId: row.id, title: row.title,
      markdown: row.markdown, summary: row.summary, imagePrompt: prompt, revision: row.revision });
    try {
      const job = await enqueueWorkerJob({
        projectId: options.projectId,
        type: "GENERATE_IMAGE",
        payload: { pageId: row.id, planId: options.planId, prompt, keeperToken },
        dedupeKey: pageIllustrationJobDedupeKey({ pageId: row.id, planId: options.planId, revision: row.revision, keeperToken })
      });
      // Declined for a project that is gone or FAILED: true of every page behind it.
      if (!job) break;
      queued += 1;
    } catch (error) {
      console.warn("Draft-time illustration enqueue failed; the page's publication will queue it", {
        event: "generation.consistency_warning",
        warning: "draft_illustration_enqueue_failed",
        projectId: options.projectId,
        pageIndex: row.index,
        error: errorMessage(error)
      });
    }
  }
  return queued;
}
