import { getProjectOrThrow } from "../generation/bookHelpers.js";
import { inputFromProject } from "../generation/projectInput.js";
import {
  authorAssistBook,
  loadCastCharacters,
  loadWritingAssistManuscript,
  type WritingAssistManuscript
} from "../generation/writingAssistContext.js";
import { illustrationAssistRequest, runIllustrationAssist } from "../generation/writingAssistIllustration.js";
import { learnStudioStyle, reembedPages, reembedStudioPages } from "../generation/writingAssistMemory.js";
import {
  chapterFeedbackAssist,
  consistencyAssist,
  draftChapterAssist,
  outlineAssist
} from "../generation/writingAssistText.js";
import { createLoggedProviders } from "../providers/loggedAdapters.js";
import { createRunLogger } from "../providers/runLogging.js";
import { config } from "../runtime/config.js";
import { advanceJobStep } from "../runtime/jobLifecycle.js";
import type { WritingAssistJob } from "../runtime/jobPayloads.js";
import {
  OPEN_WRITING_ASSIST_STATUSES,
  WritingAssistFailure,
  isWritingAssistKind,
  type WritingAssistKind
} from "../runtime/writingAssistSettlement.js";
import { createProviders, type CreateProjectInput, type ProviderSet } from "@book-maker/core";
import { Prisma, prisma } from "@book-maker/db";
import { objectStore } from "@book-maker/storage";

/**
 * `writing-assist`: one Writing Studio request, recorded on its own
 * `ManuscriptAssist` row — an illustration, a chapter draft, margin notes, a
 * consistency check, an outline, or one of the two free passes a publish
 * queues (style profile, re-embed).
 *
 * **It never touches the book.** `WRITING_ASSIST` is a derivative job, so a
 * failure fails the row and refunds the row's own charge (the attempt the API
 * reserved and committed through `startGenerationAttempt`), and the project —
 * COMPLETE, EDITING mid-publish, or a DRAFT the author is still writing —
 * keeps whatever status it has. Its result is a suggestion: nothing here
 * writes a chapter or a page; the author applies it with a tap, and it
 * reaches the book only through a later publish.
 *
 * **Settlement.** Success is the row going READY with its result (APPLIED for
 * the internal passes, which have nothing left to apply) and then
 * `markCompleted`, which marks the attempt SUCCEEDED — the charge stands.
 * Failure throws: `markFailed` refunds through the attempt, then
 * `failWritingAssistForJob` fails the row with a sentence the author can read.
 *
 * **Redelivery.** The row's status is the fence. READY, APPLIED or a
 * DISMISSED row that already has its result is delivered work: this delivery
 * returns and `markCompleted` settles the charge exactly once. A FAILED row
 * rethrows its own verdict, which `markFailed` settles idempotently (the
 * attempt is already refunded). A DISMISSED row with no result was cancelled
 * before it ran, and fails so it is refunded. Only QUEUED or RUNNING runs, and
 * the result is published by a conditional write — a delivery that lost the
 * race writes nothing, and never charges twice because the charge is the
 * attempt's, not the delivery's.
 */

const STEP_MESSAGES: Record<WritingAssistKind, string> = {
  ILLUSTRATE: "Drawing the picture",
  DRAFT_CHAPTER: "Drafting the chapter",
  CHAPTER_FEEDBACK: "Reading the chapter closely",
  CONSISTENCY: "Checking the whole book",
  OUTLINE: "Outlining your book",
  STYLE_PROFILE: "Learning your writing style",
  REEMBED: "Refreshing your book’s memory"
};

/** The internal passes settle APPLIED: they suggest nothing, so nothing waits on the author. */
const SELF_APPLYING_KINDS = new Set<WritingAssistKind>(["STYLE_PROFILE", "REEMBED"]);

type ClaimedAssist = {
  id: string;
  projectId: string;
  chapterId: string | null;
  kind: WritingAssistKind;
  input: unknown;
};

type AssistOutcome = {
  result: Record<string, unknown>;
  /** An object this delivery stored, to remove if another delivery's result won. */
  objectKey?: string | undefined;
};

export async function writingAssist(job: WritingAssistJob): Promise<void> {
  const { projectId, assistId, generationJobId } = job.data;
  const runLogger = createRunLogger(job);
  const claim = await claimWritingAssist(projectId, assistId);
  if (claim === "delivered") {
    await runLogger.append("writing_assist.already_delivered", { assistId });
    return;
  }
  await runLogger.append("writing_assist.start", {
    assistId,
    kind: claim.kind,
    chapterId: claim.chapterId
  });

  await advanceJobStep(generationJobId, "prepare", 15, "Reading your manuscript");
  const project = await getProjectOrThrow(projectId);
  const input = inputFromProject(project);
  const manuscript = await loadWritingAssistManuscript(projectId, project.mediaSettings);
  if (!manuscript) {
    throw new WritingAssistFailure("This book has no manuscript to work on yet. Open it in the Writing Studio first.");
  }
  const providers = createLoggedProviders(job, createProviders(config, input), input);

  await advanceJobStep(generationJobId, "assist", 35, STEP_MESSAGES[claim.kind]);
  const outcome = await runAssistKind({ claim, project, input, manuscript, providers, pages: job.data.pages });

  await advanceJobStep(generationJobId, "save", 90, "Saving the suggestion");
  const status = SELF_APPLYING_KINDS.has(claim.kind) ? "APPLIED" : "READY";
  const published = await prisma.manuscriptAssist.updateMany({
    where: { id: assistId, status: { in: [...OPEN_WRITING_ASSIST_STATUSES] } },
    data: { status, result: outcome.result as Prisma.InputJsonValue, error: null }
  });
  if (published.count !== 1) {
    // Another delivery published first, or the author dismissed the request
    // while it ran. Either way this delivery's result is nobody's: its stored
    // picture goes unless it is the very object the winner points at.
    await removeUnpublishedObject(assistId, outcome.objectKey);
    await runLogger.append("writing_assist.superseded", { assistId, kind: claim.kind });
    return;
  }
  await runLogger.append("writing_assist.published", {
    assistId,
    kind: claim.kind,
    status,
    result: resultSummary(outcome.result)
  });
}

/**
 * The row's status is the redelivery fence (see the module comment). Returns
 * the row this delivery may run, or `"delivered"` when the work is done.
 */
async function claimWritingAssist(projectId: string, assistId: string): Promise<ClaimedAssist | "delivered"> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const assist = await prisma.manuscriptAssist.findUnique({
      where: { id: assistId },
      select: { id: true, projectId: true, chapterId: true, kind: true, status: true, input: true, result: true, error: true }
    });
    if (!assist || assist.projectId !== projectId) {
      throw new Error(`Writing assist ${assistId} no longer exists for project ${projectId}.`);
    }
    if (!isWritingAssistKind(assist.kind)) {
      throw new Error(`Writing assist ${assistId} has an unknown kind: ${assist.kind}`);
    }
    if (assist.status === "READY" || assist.status === "APPLIED") {
      return "delivered";
    }
    if (assist.status === "DISMISSED") {
      if (assist.result !== null) {
        return "delivered";
      }
      throw new WritingAssistFailure("This request was dismissed before it ran.");
    }
    if (assist.status === "FAILED") {
      throw new WritingAssistFailure(assist.error ?? "This request couldn’t be finished.");
    }
    const claimed = await prisma.manuscriptAssist.updateMany({
      where: { id: assistId, status: { in: [...OPEN_WRITING_ASSIST_STATUSES] } },
      data: { status: "RUNNING" }
    });
    if (claimed.count === 1) {
      return {
        id: assist.id,
        projectId: assist.projectId,
        chapterId: assist.chapterId,
        kind: assist.kind,
        input: assist.input
      };
    }
    // The status moved between the read and the claim; read it again.
  }
  throw new Error(`Writing assist ${assistId} could not be claimed.`);
}

async function runAssistKind(options: {
  claim: ClaimedAssist;
  project: Awaited<ReturnType<typeof getProjectOrThrow>>;
  input: CreateProjectInput;
  manuscript: WritingAssistManuscript;
  providers: ProviderSet;
  pages: WritingAssistJob["data"]["pages"];
}): Promise<AssistOutcome> {
  const { claim, project, manuscript, providers } = options;
  switch (claim.kind) {
    case "ILLUSTRATE": {
      const request = illustrationAssistRequest(claim.input);
      const cast = await loadCastCharacters(project.userId, manuscript.settings.castCharacterIds);
      const illustrated = await runIllustrationAssist({
        assistId: claim.id,
        project,
        input: options.input,
        image: providers.image,
        settings: manuscript.settings,
        cast,
        request
      });
      return { result: illustrated.result, objectKey: illustrated.objectKey };
    }
    case "DRAFT_CHAPTER":
    case "CHAPTER_FEEDBACK":
    case "CONSISTENCY":
    case "OUTLINE": {
      const cast = await loadCastCharacters(project.userId, manuscript.settings.castCharacterIds);
      const context = {
        book: authorAssistBook({ project, settings: manuscript.settings, cast }),
        chapters: manuscript.chapters,
        chapterId: claim.chapterId,
        input: claim.input,
        textModel: providers.text
      };
      const run = {
        DRAFT_CHAPTER: draftChapterAssist,
        CHAPTER_FEEDBACK: chapterFeedbackAssist,
        CONSISTENCY: consistencyAssist,
        OUTLINE: outlineAssist
      }[claim.kind];
      return { result: await run(context) };
    }
    case "STYLE_PROFILE":
      return {
        result: await learnStudioStyle({ project, chapters: manuscript.chapters, textModel: providers.text })
      };
    case "REEMBED":
      return {
        result: await reembedStudioPages({
          projectId: project.id,
          input: options.input,
          pages: reembedPages(options.pages, claim.input),
          embedding: providers.embedding
        })
      };
  }
}

/** Best-effort: a picture nobody's result names is storage noise, never a failure. */
async function removeUnpublishedObject(assistId: string, objectKey: string | undefined): Promise<void> {
  if (!objectKey) {
    return;
  }
  try {
    const winner = await prisma.manuscriptAssist.findUnique({ where: { id: assistId }, select: { result: true } });
    const winnerUrl = (winner?.result as { url?: unknown } | null)?.url;
    const winnerFile = typeof winnerUrl === "string" ? winnerUrl.split("/").pop() : undefined;
    if (winnerFile && objectKey.endsWith(`/${winnerFile}`)) {
      return;
    }
    await objectStore().delete(objectKey);
  } catch {
    // Including a missing object: the other end of the race working is not an error.
  }
}

/** What the run log keeps about a result: its shape and size, not the author's prose again. */
function resultSummary(result: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = { type: result.type };
  for (const [key, value] of Object.entries(result)) {
    if (key === "type") continue;
    if (Array.isArray(value)) summary[`${key}Count`] = value.length;
    else if (typeof value === "string") summary[key === "url" ? key : `${key}Chars`] = key === "url" ? value : value.length;
    else if (typeof value === "number" || typeof value === "boolean") summary[key] = value;
  }
  return summary;
}
