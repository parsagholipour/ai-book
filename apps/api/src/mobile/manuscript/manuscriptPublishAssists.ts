import { dispatchGenerationJob, enqueueGenerationJob } from "../../queue.js";
import { jsonInputValue } from "../support.js";
import { newRowId } from "./manuscriptBook.js";
import { styleProfileFromMediaSettings, studioSettingsRecord, type ManuscriptDb } from "./manuscriptStore.js";

/**
 * The two free passes a publish leaves behind (spec "Long assists", last
 * bullet): learning the author's voice, and refreshing the semantic memory of
 * the pages it rewrote. Both are `WRITING_ASSIST` jobs on `ManuscriptAssist`
 * rows — detached derivatives, so neither ever holds the book, a later edit or
 * a later publish back (`hasOpenProjectWork` excludes the type) — and both
 * finish APPLIED, never READY: nothing waits on the author.
 *
 * They are written inside the publish transaction with `dispatch: false` and
 * dispatched after it, like the compile and the cover, so a crash in between
 * leaves rows the undispatched-job sweep recovers. No attempt: nothing is
 * charged.
 */

/** Below this a profile would be learned from too little of the author to mean anything. */
export const STYLE_PROFILE_MIN_WORDS = 2000;

/**
 * Whether this publish should (re)learn the Studio book's voice: once it has
 * 2,000 words and no profile, and again each time it has doubled since the
 * words the last profile was learned from. The worker records those words
 * beside the profile (`mediaSettings.mobile.studio.styleProfileWords`) and this
 * reads them from there. A pass already queued or running is not queued twice.
 * Imports keep the profile their import learned.
 */
export function styleProfileDue(options: {
  studioBook: boolean;
  words: number;
  mediaSettings: unknown;
  styleProfileOpen: boolean;
}): boolean {
  if (!options.studioBook || options.styleProfileOpen || options.words < STYLE_PROFILE_MIN_WORDS) {
    return false;
  }
  const studio = studioSettingsRecord(options.mediaSettings);
  if (!studio.styleProfile || !styleProfileFromMediaSettings(options.mediaSettings)) {
    return true;
  }
  const learnedFrom = studio.styleProfileWords;
  return typeof learnedFrom === "number" && learnedFrom > 0 && options.words >= 2 * learnedFrom;
}

export type ReembedPage = { pageId: string; index: number; revision: number };

/** Rows and undispatched jobs for this publish's internal passes; returns the job ids to dispatch after commit. */
export async function enqueuePublishAssists(
  tx: ManuscriptDb,
  options: {
    projectId: string;
    publishRequestId: string;
    words: number;
    learnStyle: boolean;
    reembedPages: readonly ReembedPage[];
  }
): Promise<string[]> {
  const jobIds: string[] = [];
  const passes: Array<{ kind: "STYLE_PROFILE" | "REEMBED"; input: Record<string, unknown>; payload: Record<string, unknown> }> = [];
  if (options.learnStyle) {
    passes.push({ kind: "STYLE_PROFILE", input: { words: options.words }, payload: {} });
  }
  if (options.reembedPages.length > 0) {
    const pages = options.reembedPages.map((page) => ({ pageId: page.pageId, index: page.index, revision: page.revision }));
    passes.push({ kind: "REEMBED", input: { pages }, payload: { pages } });
  }
  for (const pass of passes) {
    const assistId = newRowId("as");
    const job = await enqueueGenerationJob({
      projectId: options.projectId,
      type: "WRITING_ASSIST",
      dedupeKey: `writing-assist:${assistId}`,
      payload: { assistId, ...pass.payload },
      transaction: tx,
      dispatch: false
    });
    await tx.manuscriptAssist.create({
      data: {
        id: assistId,
        projectId: options.projectId,
        chapterId: null,
        kind: pass.kind,
        status: "QUEUED",
        input: jsonInputValue(pass.input),
        creditsCharged: 0,
        generationJobId: job.id,
        requestId: `publish:${options.publishRequestId}:${pass.kind.toLowerCase()}`
      }
    });
    jobIds.push(job.id);
  }
  return jobIds;
}

/** Best-effort: a pass that could not be dispatched is late, not lost — the sweep re-publishes its row. */
export async function dispatchPublishAssists(jobIds: readonly string[]): Promise<void> {
  for (const jobId of jobIds) {
    await dispatchGenerationJob(jobId).catch((error: unknown) => {
      console.error(`Deferred dispatch of Writing Studio publish pass ${jobId}`, error);
    });
  }
}
