import { pageIllustrationKeeperToken } from "./pageIllustrationOwnership.js";
import { enqueueWorkerJob } from "../runtime/dispatch.js";
import { type BookGenerationStrategy, type BookPlan, type CreateProjectInput } from "@book-maker/core";
import { prisma } from "@book-maker/db";

/**
 * Queues one interior illustration per published page of exactly one replan
 * revision — the page half of what `replanCoverDispatch.ts` does for the cover.
 *
 * A replan is priced as a whole book, interior images included, and its
 * publication transaction deletes every `ImageAsset` the old manuscript owned.
 * The per-page enqueue every other drafting path arrives at lives in
 * `publishStagedGeneratedPage`, and a deferred review returns before it by
 * construction, so without this the replacement pages keep the prompts and
 * never get the pictures.
 *
 * Fenced exactly like `maybeEnqueueRevisionOwnedReplanCover`, and that parity
 * has to be *paid for* rather than asserted: the read below is only the
 * dispatch instant, and the render is minutes away behind a queue. So each job
 * carries the revision on its durable row and the EDITING expectation on its
 * payload, which are precisely the two facts
 * `staleGenerationTargetReason`'s `GENERATE_IMAGE` arms are keyed on — both of
 * them inert for a payload that names no `exportPublicationProjectStatus`. A
 * text edit bumps the revision without touching the plan, so the plan-bound
 * check above them answers nothing about it, and a replan's interior jobs used
 * to draw for a manuscript that had already been rewritten and settled — the
 * cover beside them standing down correctly.
 *
 * The gate on each page is `publishStagedGeneratedPage`'s — a prompt on the row
 * and the strategy's own illustration cadence — and the dedupe key is the same
 * keeper-tokened one, so a replayed publication tail re-enqueues nothing and no
 * page is ever drawn twice.
 *
 * `assertLease` is the caller's delivery fence. This loop is one queue round
 * trip per illustrated page, so a two-hundred-page replan can outlive the tail
 * lease it runs under; asking per page is what makes it hand over rather than
 * enqueue under a token somebody else now holds.
 */
export async function enqueueRevisionOwnedReplanIllustrations(options: {
  projectId: string;
  planVersionId: string;
  publicationRevision: number;
  input: CreateProjectInput;
  plan: BookPlan;
  strategy: BookGenerationStrategy;
  assertLease?: (() => Promise<void>) | undefined;
}): Promise<number> {
  const project = await prisma.project.findUnique({
    where: { id: options.projectId },
    select: { currentPlanId: true, contentRevision: true, status: true }
  });
  if (
    !project ||
    project.currentPlanId !== options.planVersionId ||
    project.contentRevision !== options.publicationRevision ||
    project.status !== "EDITING"
  ) {
    return 0;
  }
  const pages = await prisma.page.findMany({
    where: { projectId: options.projectId },
    orderBy: { index: "asc" },
    select: { id: true, index: true, title: true, markdown: true, summary: true, imagePrompt: true, revision: true }
  });
  let queued = 0;
  for (const page of pages) {
    const prompt = page.imagePrompt;
    if (!prompt || !options.strategy.shouldIllustratePage(options.input, options.plan, page.index)) {
      continue;
    }
    await options.assertLease?.();
    const keeperToken = pageIllustrationKeeperToken({
      projectId: options.projectId,
      pageId: page.id,
      title: page.title,
      markdown: page.markdown,
      summary: page.summary,
      imagePrompt: prompt,
      revision: page.revision
    });
    const imageJob = await enqueueWorkerJob({
      projectId: options.projectId,
      type: "GENERATE_IMAGE",
      payload: {
        pageId: page.id,
        planId: options.planVersionId,
        prompt,
        keeperToken,
        contentRevision: options.publicationRevision,
        exportPublicationProjectStatus: "EDITING"
      },
      dedupeKey: `generate-image:${page.id}:${options.planVersionId}:${page.revision}:${keeperToken}`,
      contentRevision: options.publicationRevision
    });
    // `enqueueWorkerJob` declines for a project that is gone or FAILED, which is
    // a fact about the project rather than about this page: the pages behind it
    // would each buy the same read to be told the same thing, and reporting
    // them as queued would have the caller claim illustrations nothing will
    // draw. A dedupe hit is a job that exists and still counts.
    if (!imageJob) break;
    queued += 1;
  }
  return queued;
}
